// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Optional NPI loader. No proprietary headers or libraries are redistributed.
#include "npi.h"
#include "npi_hdl.h"
#include <algorithm>
#include <dlfcn.h>
#include <cstdio>
#include <cstdlib>
#include <limits>
#include <string>
#include <vector>
#include <cstring>
#include <unistd.h>
#include <unordered_map>
#include <set>
static void* lib = nullptr;
static bool initialized = false;
static std::string error_text;
static decltype(&npi_init) init_api;
static decltype(&npi_end) end_api;
static decltype(&npi_load_design) load_api;
static decltype(&npi_handle_by_name) by_name;
static decltype(&npi_get_str) get_str;
static decltype(&npi_get) get_int;
static decltype(&npi_get_value) get_value;
static decltype(&npi_handle) handle_api;
static decltype(&npi_iterate) iterate_api;
static decltype(&npi_scan) scan_api;
static decltype(&npi_release_handle) release_api;
// These are Itanium C++ ABI symbols exported by the installed NPI SDK (Linux).
// decltype uses SDK declarations to check the function pointer signatures.
template<class T> static bool bind(T& function, const char* symbol) {
    function = reinterpret_cast<T>(dlsym(lib,symbol));
    if (!function) { error_text = std::string("NPI symbol unavailable: ") + symbol; return false; }
    return true;
}
struct AliasSource {
    const char* file;
    int line;
    int width;
    int two_state;
};
using LocationCB = void (*)(void*, const char*, const char*, const char*, int, const char*, const char*, int, const char*, const int*, const AliasSource*);
using PortLinkCB = void (*)(void*, const char*, const char*, const int*, const char*, const char*, const int*, const char*, int, int, int);
using PortDeclarationCB = void (*)(void*, const char*, const char*, const char*);
using PortGapCB = void (*)(void*, const char*, const char*, bool);
struct PortOperand { const char* instance; const char* signal; };
using PortExpressionCB = void (*)(void*, const char*, const char*, const char*, int,
                                  int, int, const PortOperand*, size_t, bool, const char*, bool);
static std::string property(int prop, npiHandle h) { const char* s=get_str(prop,h); return s?s:""; }
static bool design_type(int type) { return type==npiModule || type==npiModuleArray || type==npiProgram || type==npiProgramArray; }
static bool generated_type(int type) { return type==npiGenScope; }
static bool definition_owner(npiHandle handle) {
    int type = get_int(npiType, handle);
    return type == npiModule || type == npiInterface;
}
// Hierarchy browsing must not fetch source locations: NPI may lazily load an
// entire compilation unit for npiFile/npiDefFile. Resolve those only on demand.
static void emit_summary(npiHandle h, LocationCB cb, void* user) {
    auto fullname=property(npiFullName,h),kind=property(npiType,h);
    int type=get_int(npiType,h);
    auto module=(design_type(type)||type==npiInterface||type==npiInterfaceArray)?property(npiDefName,h):"";
    cb(user,fullname.c_str(),kind.c_str(),"",0,module.c_str(),"",0,fullname.c_str(),nullptr,nullptr);
}
static bool contains_design(npiHandle scope,int depth=0) {
    if(depth>128)return false;
    auto iterator=iterate_api(npiInternalScope,scope);if(!iterator)return false;
    while(auto h=scan_api(iterator)) {
        int type=get_int(npiType,h);
        bool found=design_type(type)||(generated_type(type)&&contains_design(h,depth+1));
        release_api(h);if(found){release_api(iterator);return true;}
    }
    return false;
}
static void emit(npiHandle h, LocationCB cb, void* user, const int* range = nullptr,
                 const AliasSource* alias = nullptr) {
    std::string fullname=property(npiFullName,h),kind=property(npiType,h),file=property(npiFile,h);
    int line=get_int(npiLineNo,h);
    npiHandle scope=definition_owner(h)?h:handle_api(npiScope,h);
    for(int depth=0;scope && !definition_owner(scope) && depth<64;++depth){
        auto parent=handle_api(npiScope,scope);release_api(scope);scope=parent;
    }
    std::string module=scope?property(npiDefName,scope):"";
    std::string definition=scope?property(npiDefFile,scope):"";
    int defline=scope?get_int(npiDefLineNo,scope):0;
    std::string instance=scope?property(npiFullName,scope):"";
    cb(user,fullname.c_str(),kind.c_str(),file.c_str(),line,module.c_str(),definition.c_str(),defline,instance.c_str(),range,alias);
    if(scope && scope!=h)release_api(scope);
}
static bool fixed_index(npiHandle expression, int relation, int& index) {
    auto bound = handle_api(relation, expression);
    if (!bound) return false;
    npiValue value = {};
    value.format = npiIntVal;
    const bool known = get_value && get_int(npiType, bound) == npiConstant &&
        get_int(npiConstType, bound) == npiIntConst && get_int(npiSize, bound) == 32 &&
        get_value(bound, value, false) == 1;
    if (known) index = value.value.integer;
    release_api(bound);
    return known;
}

static bool named_bit_index(const std::string& name, const std::string& prefix, int& index) {
    if (name.compare(0, prefix.size(), prefix) != 0 || name.size() <= prefix.size() + 1)
        return false;
    const char* digits = name.c_str() + prefix.size();
    char* end = nullptr;
    const long value = std::strtol(digits, &end, 10);
    if (end == digits || end != name.c_str() + name.size() - 1 || *end != ']' ||
        value < std::numeric_limits<int>::min() || value > std::numeric_limits<int>::max())
        return false;
    index = static_cast<int>(value);
    return true;
}

static npiHandle fixed_selection(npiHandle expression, int (&range)[2]) {
    const int kind = get_int(npiType, expression);
    if (kind != npiPartSelect && kind != npiNetBit && kind != npiRegBit &&
        kind != npiBitSelect) return nullptr;
    auto parent = handle_api(npiParent, expression);
    if (!parent) return nullptr;
    bool known = false;
    if (kind == npiPartSelect) {
        known = fixed_index(expression, npiLeftRange, range[0]) &&
            fixed_index(expression, npiRightRange, range[1]);
    } else {
        const auto prefix = property(npiFullName, parent) + "[";
        known = kind == npiBitSelect
            ? fixed_index(expression, npiIndex, range[0])
            : named_bit_index(property(npiFullName, expression), prefix, range[0]);
#ifdef npiElabFullName
        // NPI keeps the original expression in FullName and resolves constant
        // indices in ElabFullName using the current instance's parameters.
        if (!known)
            known = named_bit_index(property(npiElabFullName, expression), prefix, range[0]);
#endif
        range[1] = range[0];
    }
    if (known) return parent;
    release_api(parent);
    return nullptr;
}

static bool interface_storage(npiHandle member) {
    auto scope = handle_api(npiScope, member);
    const auto name = property(npiName, member);
    const bool valid = scope && get_int(npiType, scope) == npiInterface && !name.empty() &&
        property(npiFullName, member) == property(npiFullName, scope) + "." + name;
    if (scope) release_api(scope);
    return valid;
}

static bool is_concat(npiHandle expression) {
    return get_int(npiType, expression) == npiOperation &&
        get_int(npiOpType, expression) == npiConcatOp;
}

struct ModportPart {
    npiHandle member;
    bool selected;
    int range[2];
    int width;
};

static void release_parts(std::vector<ModportPart>& parts) {
    for (const auto& part : parts) release_api(part.member);
    parts.clear();
}

static bool append_modport_parts(npiHandle expression, unsigned depth,
                                 std::vector<ModportPart>& parts) {
    if (depth >= 32 || parts.size() >= 64) return false;
    auto iterator = iterate_api(npiOperand, expression);
    if (!iterator) return false;
    int total = 0;
    const int width = get_int(npiSize, expression);
    while (auto operand = scan_api(iterator)) {
        const int operand_width = get_int(npiSize, operand);
        if (parts.size() == 64 || operand_width < 1 || operand_width > width - total) {
            release_api(operand);
            release_api(iterator);
            return false;
        }
        total += operand_width;
        if (is_concat(operand)) {
            const bool valid = append_modport_parts(operand, depth + 1, parts);
            release_api(operand);
            if (!valid) {
                release_api(iterator);
                return false;
            }
            continue;
        }
        ModportPart part = {};
        part.member = fixed_selection(operand, part.range);
        part.selected = part.member != nullptr;
        part.width = operand_width;
        if (part.selected) release_api(operand);
        else part.member = operand;
        const int kind = get_int(npiType, part.member);
        if ((kind != npiNet && kind != npiReg && kind != npiBitVar &&
             kind != npiIntegerVar && kind != npiIntVar) ||
            !interface_storage(part.member)) {
            release_api(part.member);
            release_api(iterator);
            return false;
        }
        parts.push_back(part);
    }
    return total == width && total > 0;
}

static std::vector<ModportPart> modport_concat(npiHandle expression) {
    std::vector<ModportPart> parts;
    const int width = get_int(npiSize, expression);
    if (width < 1 || width > 4096) return parts;
    if (!append_modport_parts(expression, 0, parts) || parts.size() < 2)
        release_parts(parts);
    return parts;
}

static npiHandle modport_port_by_name(const char* fullname) {
    const auto separator = std::strrchr(fullname, '.');
    if (!separator || !separator[1]) return nullptr;
    const std::string scope_name(fullname, separator);
    auto scope = by_name(scope_name.c_str(), nullptr);
    if (!scope) return nullptr;
    const int kind = get_int(npiType, scope);
    auto modport = kind == npiRefObj ? handle_api(npiActual, scope) : scope;
    npiHandle match = nullptr;
    if (modport && get_int(npiType, modport) == npiModport) {
        if (auto ports = iterate_api(npiMpPort, modport)) {
            while (auto port = scan_api(ports)) {
                if (property(npiName, port) != separator + 1) {
                    release_api(port);
                    continue;
                }
                if (match) {
                    release_api(port);
                    release_api(match);
                    release_api(ports);
                    match = nullptr;
                    break;
                }
                match = port;
            }
        }
    }
    if (modport && modport != scope) release_api(modport);
    release_api(scope);
    return match;
}
struct InstanceSummary { std::string fullname,kind,module; };
static std::unordered_map<std::string,std::vector<InstanceSummary>> instances;
static bool instances_indexed=false;
static void index_instances(npiHandle scope,int depth=0) {
    if(depth>256)return;
    auto it=iterate_api(scope?npiInternalScope:npiInstance,scope);if(!it)return;
    while(auto h=scan_api(it)) {
        int type=get_int(npiType,h);
        bool instance=design_type(type)||type==npiInterface||type==npiInterfaceArray;
        if(instance){auto module=property(npiDefName,h);instances[module].push_back({property(npiFullName,h),property(npiType,h),module});}
        if(instance||generated_type(type))index_instances(h,depth+1);
        release_api(h);
    }
}

struct PortEndpoint {
    std::string instance, signal;
    int range[2];
    bool selected, unresolved;
};

static PortEndpoint port_storage(npiHandle object) {
    auto signal = property(npiName, object);
    auto fullname = property(npiFullName, object);
    auto scope = handle_api(npiScope, object);
    std::string instance;
    if (scope) {
        if (get_int(npiType, scope) == npiModule) instance = property(npiFullName, scope);
        release_api(scope);
    }
    if (signal.empty() || instance.empty() || fullname != instance + "." + signal) return {};
    return {instance, signal, {0, 0}, false, false};
}

static PortEndpoint port_endpoint(npiHandle object) {
    const int kind = get_int(npiType, object);
    if (kind != npiNetBit && kind != npiRegBit && kind != npiBitSelect &&
        kind != npiPartSelect && kind != npiIndexedPartSelect)
        return port_storage(object);

    int range[2] = {};
    auto storage = fixed_selection(object, range);
    const bool known = storage &&
        std::abs(static_cast<long long>(range[0]) - range[1]) + 1 == get_int(npiSize, object);
    if (!storage) storage = handle_api(npiParent, object);
    if (!storage) return {};
    auto endpoint = port_storage(storage);
    release_api(storage);
    endpoint.selected = known;
    endpoint.unresolved = !known;
    endpoint.range[0] = range[0];
    endpoint.range[1] = range[1];
    return endpoint;
}

static bool port_expression_operands(npiHandle expression,
                                     std::set<std::pair<std::string, std::string>>& operands,
                                     unsigned depth, unsigned& remaining, bool& complete) {
    if (depth == 16 || remaining == 0) return false;
    --remaining;
    const int kind = get_int(npiType, expression);
    if (kind == npiConstant || kind == npiParameter) return true;
    if (kind != npiOperation) {
        auto endpoint = port_endpoint(expression);
        if (endpoint.instance.empty()) return false;
        complete &= !endpoint.unresolved;
        operands.emplace(std::move(endpoint.instance), std::move(endpoint.signal));
        return true;
    }

    const int op = get_int(npiOpType, expression);
    auto iterator = iterate_api(npiOperand, expression);
    if (!iterator) return false;
    // A zero repetition has no signal operands even when its body names one.
    if (op == npiMultiConcatOp && get_int(npiSize, expression) == 0) {
        auto count = scan_api(iterator);
        npiValue value = {};
        value.format = npiIntVal;
        const bool empty = count && get_value && get_int(npiType, count) == npiConstant &&
            get_int(npiSize, count) == 32 && get_value(count, value, false) == 1 &&
            value.value.integer == 0;
        if (count) release_api(count);
        release_api(iterator);
        return empty;
    }
    bool has_operand = false;
    while (auto operand = scan_api(iterator)) {
        has_operand = true;
        const bool valid = port_expression_operands(operand, operands, depth + 1, remaining, complete);
        release_api(operand);
        if (!valid) {
            release_api(iterator);
            return false;
        }
    }
    return has_operand;
}

static void emit_input_expression(npiHandle actual, const PortEndpoint& formal,
                                  const std::string& file, int line, int from_width, int to_width,
                                  PortExpressionCB callback, PortGapCB gap, void* user) {
    if (formal.instance.empty() || formal.selected || formal.unresolved) return;
    if (get_int(npiType, actual) == npiConstant) {
        npiValue value = {};
        value.format = npiBinStrVal;
        const int sign = get_int(npiSigned, actual);
        if (!file.empty() && line > 0 && from_width > 0 && from_width <= 4096 &&
            to_width > 0 && (sign == 0 || sign == 1) && get_value &&
            get_value(actual, value, false) == 1 && value.value.str) {
            const std::string bits = value.value.str;
            if (bits.size() == static_cast<size_t>(from_width) &&
                bits.find_first_not_of("01xzXZ") == std::string::npos) {
                callback(user, formal.instance.c_str(), formal.signal.c_str(), file.c_str(), line,
                         from_width, to_width, nullptr, 0, true, bits.c_str(), sign == 1);
                return;
            }
        }
        gap(user, formal.instance.c_str(), formal.signal.c_str(), true);
        return;
    }
    std::set<std::pair<std::string, std::string>> signals;
    unsigned remaining = 64;
    bool complete = true;
    const bool known = port_expression_operands(actual, signals, 0, remaining, complete);
    if (!known || file.empty() || line <= 0 || from_width <= 0 || to_width <= 0 || signals.empty()) {
        for (const auto& signal : signals)
            gap(user, signal.first.c_str(), signal.second.c_str(), false);
        gap(user, formal.instance.c_str(), formal.signal.c_str(), true);
        return;
    }
    std::vector<PortOperand> operands;
    operands.reserve(signals.size());
    for (const auto& signal : signals)
        operands.push_back({signal.first.c_str(), signal.second.c_str()});
    callback(user, formal.instance.c_str(), formal.signal.c_str(), file.c_str(), line,
             from_width, to_width, operands.data(), operands.size(), complete, nullptr, false);
}

static void emit_port_connection(const PortEndpoint& from, const PortEndpoint& to,
                                 const std::string& file, int line, int common_width,
                                 PortLinkCB link, PortGapCB gap, void* user) {
    const bool bound = !from.instance.empty() && !to.instance.empty() &&
        from.instance != to.instance && !file.empty() && line > 0;
    if (bound && from.unresolved && !to.unresolved && !to.selected && common_width > 0) {
        link(user, from.instance.c_str(), from.signal.c_str(), nullptr,
             to.instance.c_str(), to.signal.c_str(), nullptr, file.c_str(), line, common_width, 0);
        return;
    }
    if (from.unresolved || to.unresolved ||
        ((from.selected || to.selected) && common_width <= 0)) {
        if (!from.instance.empty())
            gap(user, from.instance.c_str(), from.signal.c_str(), false);
        if (!to.instance.empty())
            gap(user, to.instance.c_str(), to.signal.c_str(), true);
    } else if (bound) {
        link(user, from.instance.c_str(), from.signal.c_str(), from.selected ? from.range : nullptr,
             to.instance.c_str(), to.signal.c_str(), to.selected ? to.range : nullptr,
             file.c_str(), line, 0, 0);
    }
}

struct OutputPortPart {
    PortEndpoint endpoint;
    int width;
    int left;
    int right;
    bool range_known;
};

static bool packed_port_range(npiHandle signal, int width, int& left, int& right) {
    if (width == 1) return true;
    auto typespec = handle_api(npiTypespec, signal);
    if (!typespec) return false;
    auto ranges = iterate_api(npiRange, typespec);
    bool known = false;
    if (ranges) {
        if (auto range = scan_api(ranges)) {
            known = fixed_index(range, npiLeftRange, left) &&
                fixed_index(range, npiRightRange, right) &&
                std::abs(static_cast<long long>(left) - right) + 1 == width;
            release_api(range);
            if (auto extra = scan_api(ranges)) {
                release_api(extra);
                release_api(ranges);
                known = false;
            }
        }
    }
    release_api(typespec);
    return known;
}

static bool collect_output_parts(npiHandle actual, std::vector<OutputPortPart>& parts,
                                 unsigned depth, unsigned& remaining) {
    if (depth == 16 || remaining == 0) return false;
    --remaining;
    if (!is_concat(actual)) {
        auto endpoint = port_endpoint(actual);
        const int width = get_int(npiSize, actual);
        auto parent = endpoint.selected ? handle_api(npiParent, actual) : nullptr;
        auto typespec = handle_api(npiTypespec, parent ? parent : actual);
        const bool logic = typespec && get_int(npiType, typespec) == npiLogicTypespec;
        if (typespec) release_api(typespec);
        if (parent) release_api(parent);
        const bool known = !endpoint.instance.empty() && !endpoint.unresolved && width > 0 && logic;
        if (!endpoint.instance.empty()) {
            int left = endpoint.selected ? endpoint.range[0] : 0;
            int right = endpoint.selected ? endpoint.range[1] : 0;
            const bool range_known = known && (endpoint.selected
                ? std::abs(static_cast<long long>(left) - right) + 1 == width
                : packed_port_range(actual, width, left, right));
            parts.push_back({std::move(endpoint), width, left, right, range_known});
        }
        return known;
    }
    auto iterator = iterate_api(npiOperand, actual);
    if (!iterator) return false;
    bool valid = true;
    while (auto operand = scan_api(iterator)) {
        valid &= collect_output_parts(operand, parts, depth + 1, remaining);
        release_api(operand);
        if (remaining == 0) {
            release_api(iterator);
            return false;
        }
    }
    return valid;
}

static PortEndpoint output_part_range(const OutputPortPart& part, int offset, int width) {
    auto endpoint = part.endpoint;
    if (width < part.width) {
        const int direction = part.left <= part.right ? 1 : -1;
        endpoint.selected = true;
        endpoint.range[0] = part.left + direction * offset;
        endpoint.range[1] = part.left + direction * (offset + width - 1);
    }
    return endpoint;
}

static void emit_output_concat(npiHandle actual, npiHandle low, PortEndpoint formal,
                               const std::string& file, int line, int width,
                               PortLinkCB link, PortGapCB gap, void* user) {
    if (formal.instance.empty() || formal.selected || formal.unresolved) return;
    std::vector<OutputPortPart> parts;
    unsigned remaining = 64;
    const bool known = collect_output_parts(actual, parts, 0, remaining);
    int left = 0, right = 0;
    const bool formal_range = packed_port_range(low, width, left, right);
    const int direction = left <= right ? 1 : -1;
    long long target_width = 0;
    bool valid = known && formal_range && !file.empty() && line > 0 && width > 0 && !parts.empty();
    for (const auto& part : parts) {
        valid &= part.width > 0 && part.endpoint.instance != formal.instance;
        target_width += part.width;
    }
    int signedness = 0;
    const long long extra = target_width - width;
    if (valid && extra > 0 && extra <= 4096) {
        auto typespec = handle_api(npiTypespec, low);
        signedness = typespec ? get_int(npiSigned, typespec) : get_int(npiSigned, low);
        if (typespec) release_api(typespec);
        int extension = static_cast<int>(extra);
        for (const auto& part : parts) {
            if (extension < part.width) {
                valid &= extension == 0 || part.range_known;
                break;
            }
            extension -= part.width;
        }
    }
    if (!valid || extra > 4096 || (signedness != 0 && signedness != 1)) {
        gap(user, formal.instance.c_str(), formal.signal.c_str(), false);
        for (const auto& part : parts)
            gap(user, part.endpoint.instance.c_str(), part.endpoint.signal.c_str(), true);
        return;
    }
    // Align the least significant ends, as for a packed assignment.
    formal.selected = width > 1;
    int offset = width > target_width ? width - static_cast<int>(target_width) : 0;
    int extension = extra > 0 ? static_cast<int>(extra) : 0;
    const int sign_range[] = {left, left};
    for (const auto& part : parts) {
        const int prefix = std::min(extension, part.width);
        extension -= prefix;
        if (prefix > 0) {
            const auto target = output_part_range(part, 0, prefix);
            link(user, signedness ? formal.instance.c_str() : nullptr,
                 signedness ? formal.signal.c_str() : nullptr,
                 signedness && formal.selected ? sign_range : nullptr,
                 target.instance.c_str(), target.signal.c_str(), target.selected ? target.range : nullptr,
                 file.c_str(), line, 0, prefix);
        }
        if (prefix < part.width) {
            const int data_width = part.width - prefix;
            formal.range[0] = left + direction * offset;
            offset += data_width;
            formal.range[1] = left + direction * (offset - 1);
            emit_port_connection(formal, output_part_range(part, prefix, data_width),
                                 file, line, data_width, link, gap, user);
        }
    }
}

static void emit_port_links(npiHandle module, PortDeclarationCB declaration,
                            PortLinkCB link, PortGapCB gap,
                            PortExpressionCB expression, void* user, int& remaining) {
    if (remaining <= 0) return;
    auto ports = iterate_api(npiPort, module);
    if (!ports) return;
    const auto instance = property(npiFullName, module);
    while (auto port = scan_api(ports)) {
        int direction = get_int(npiDirection, port);
        if (direction == npiInput || direction == npiOutput || direction == npiInout) {
            auto high = handle_api(npiHighConn, port);
            auto low = handle_api(npiLowConn, port);
            auto signal = property(npiName, port);
            if (signal.empty() && low) signal = port_endpoint(low).signal;
            if (!signal.empty()) {
                const char* direction_name = direction == npiInput ? "input"
                    : direction == npiOutput ? "output" : "inout";
                declaration(user, instance.c_str(), signal.c_str(), direction_name);
            }
            if (high && low) {
                auto external = port_endpoint(high);
                auto internal = port_endpoint(low);
                auto file = property(npiPortInstFile, port);
                int line = get_int(npiPortInstLineNo, port);
                const int high_width = get_int(npiSize, high);
                const int low_width = get_int(npiSize, low);
                int common_width = high_width == low_width ? high_width : 0;
                // NPI can omit the indexed actual's size. The independent
                // reader still has to confirm an unconverted expression of this width.
                if (high_width == 0 && low_width > 0 &&
                    get_int(npiType, high) == npiIndexedPartSelect &&
                    get_int(npiSize, port) == low_width)
                    common_width = low_width;
                const int actual_kind = get_int(npiType, high);
                if (direction == npiInput && (actual_kind == npiOperation || actual_kind == npiConstant))
                    emit_input_expression(high, internal, file, line, high_width, low_width, expression, gap, user);
                else if (direction != npiOutput)
                    emit_port_connection(external, internal, file, line, common_width, link, gap, user);
                if (direction == npiOutput && is_concat(high))
                    emit_output_concat(high, low, internal, file, line, low_width, link, gap, user);
                else if (direction != npiInput)
                    emit_port_connection(internal, external, file, line, common_width, link, gap, user);
            }
            if (high) release_api(high);
            if (low) release_api(low);
        }
        release_api(port);
        if (--remaining == 0) { release_api(ports); break; }
    }
}

static void emit_child_port_links(npiHandle scope, PortDeclarationCB declaration,
                                  PortLinkCB link, PortGapCB gap,
                                  PortExpressionCB expression, void* user,
                                  int& remaining, int depth = 0) {
    if (depth >= 32 || remaining <= 0) return;
    auto children = iterate_api(npiInternalScope, scope);
    if (!children) return;
    while (auto child = scan_api(children)) {
        int kind = get_int(npiType, child);
        if (kind == npiModule) emit_port_links(child, declaration, link, gap, expression, user, remaining);
        else if (kind == npiGenScope || kind == npiModuleArray)
            emit_child_port_links(child, declaration, link, gap, expression, user, remaining, depth + 1);
        release_api(child);
        if (remaining <= 0) { release_api(children); break; }
    }
}
extern "C" {
const char* wave_kdb_error() { return error_text.c_str(); }
int wave_kdb_load(const char* home, const char* dbdir) {
    if(initialized) {error_text="KDB already loaded; attach a fresh backend for another database";return 0;}
    std::string library=std::string(home)+"/share/NPI/lib/linux64/libNPI.so";
    lib=dlopen(library.c_str(),RTLD_NOW|RTLD_GLOBAL);
    if(!lib){error_text=dlerror();return 0;}
    if(!bind(init_api,"_Z8npi_initRiRPPc") || !bind(end_api,"_Z7npi_endv") || !bind(load_api,"_Z15npi_load_designiPPc") ||
       !bind(by_name,"_Z18npi_handle_by_namePKcPv") || !bind(get_str,"_Z11npi_get_striPv") || !bind(get_int,"_Z7npi_getiPv") ||
       !bind(handle_api,"_Z10npi_handleiPv") || !bind(iterate_api,"_Z11npi_iterateiPv") || !bind(scan_api,"_Z8npi_scanPv") || !bind(release_api,"_Z18npi_release_handlePv"))return 0;
    get_value = reinterpret_cast<decltype(get_value)>(dlsym(lib, "_Z13npi_get_valuePvR8npiValueb"));
    char executable[4096]={};
    auto length=readlink("/proc/self/exe",executable,sizeof(executable)-1);
    if(length<0){error_text="Cannot resolve native executable path";return 0;}
    std::vector<std::string> args={executable, "-nologo", "-dbdir", dbdir};
    std::vector<char*> raw;for(auto& arg:args)raw.push_back(&arg[0]);raw.push_back(nullptr);
    int argc=args.size();char** argv=raw.data();
    if(!init_api(argc,argv)) {error_text="npi_init failed; see NPI diagnostics/license configuration";fflush(stdout);return 0;}
    initialized=true;
    if(!load_api(argc,argv)){error_text="npi_load_design failed; select the VCS simv.daidir containing a matching KDB";fflush(stdout);return 0;}
    fflush(stdout);return 1;
}
int wave_kdb_resolve(const char* fullname, LocationCB cb, void* user) {
    if(!initialized){error_text="No KDB attached";return 0;}
    auto h=by_name(fullname,nullptr);
    if(!h){error_text=std::string("KDB object not found: ")+fullname;return 0;}
    emit(h,cb,user);release_api(h);fflush(stdout);return 1;
}
int wave_kdb_interface_member(const char* fullname, LocationCB cb, void* user) {
    if (!initialized) { error_text = "No KDB attached"; return 0; }
    auto reference = by_name(fullname, nullptr);
    // NPI can enumerate port selections with negative indices that its name lookup omits.
    if (!reference) reference = modport_port_by_name(fullname);
    if (!reference) return 1;
    npiHandle actual = nullptr, expression = nullptr;
    int kind = get_int(npiType, reference);
    if (kind == npiRefObj)
        actual = handle_api(npiActual, reference);
    auto port = kind == npiMpPort ? reference : actual;
    auto member = port;
    npiHandle selected = nullptr;
    int range[2] = {};
    if (port && get_int(npiType, port) == npiMpPort) {
        expression = handle_api(npiExpr, port);
        if (expression && is_concat(expression)) {
            const auto file = property(npiFile, port);
            const int line = get_int(npiLineNo, port);
            auto parts = modport_concat(expression);
            for (const auto& part : parts) {
                const AliasSource alias = {
                    file.c_str(), line, part.width, get_int(npiType, part.member) == npiBitVar
                };
                emit(part.member, cb, user, part.selected ? part.range : nullptr, &alias);
            }
            release_parts(parts);
            member = nullptr;
        } else {
            if (expression) selected = fixed_selection(expression, range);
            member = selected ? selected : expression;
        }
    }
    if (member && interface_storage(member))
        emit(member, cb, user, selected ? range : nullptr);
    if (selected) release_api(selected);
    if (expression) release_api(expression);
    if (actual) release_api(actual);
    release_api(reference);
    fflush(stdout);
    return 1;
}
int wave_kdb_interface_users(const char* fullname, LocationCB cb, void* user) {
    if (!initialized) { error_text = "No KDB attached"; return 0; }
    auto member = by_name(fullname, nullptr);
    if (!member) return 1;
    int remaining = 4096;
    auto scope = handle_api(npiScope, member);
    if (scope && get_int(npiType, scope) == npiInterface) {
        auto modports = iterate_api(npiModport, scope);
        if (modports) while (auto modport = scan_api(modports)) {
            auto ports = iterate_api(npiMpPort, modport);
            if (ports) while (auto port = scan_api(ports)) {
                auto expression = handle_api(npiExpr, port);
                if (expression) {
                    int range[2] = {};
                    npiHandle selected = nullptr;
                    bool uses_member = false;
                    if (is_concat(expression)) {
                        auto parts = modport_concat(expression);
                        for (const auto& part : parts)
                            if (property(npiFullName, part.member) == fullname) {
                                uses_member = true;
                                break;
                            }
                        release_parts(parts);
                    } else {
                        selected = fixed_selection(expression, range);
                        uses_member = property(npiFullName, selected ? selected : expression) == fullname;
                    }
                    if (uses_member) {
                        auto refs = iterate_api(npiRefObj, port);
                        if (refs) while (auto ref = scan_api(refs)) {
                            emit(ref, cb, user, selected ? range : nullptr);
                            release_api(ref);
                            if (--remaining == 0) { release_api(refs); break; }
                        }
                    }
                    if (selected) release_api(selected);
                    release_api(expression);
                }
                release_api(port);
                if (remaining == 0) { release_api(ports); break; }
            }
            release_api(modport);
            if (remaining == 0) { release_api(modports); break; }
        }
    }
    if (scope) release_api(scope);
    release_api(member);
    fflush(stdout);
    if (remaining == 0) error_text = "KDB interface scan exceeded its relation budget";
    return remaining > 0;
}
int wave_kdb_children(const char* fullname, int all, LocationCB cb, void* user) {
    if(!initialized){error_text="No KDB attached";return 0;}
    npiHandle scope=std::strlen(fullname)?by_name(fullname,nullptr):nullptr;
    if(std::strlen(fullname)&&!scope){error_text="KDB scope not found";return 0;}
    int count=0;
    for(int type:{scope?npiInternalScope:npiInstance}){
        auto iterator=iterate_api(type,scope);if(!iterator)continue;
        while(auto h=scan_api(iterator)){
            int kind=get_int(npiType,h);
            if(all || design_type(kind) || (generated_type(kind)&&contains_design(h))) {
                emit_summary(h,cb,user);++count;
            }
            release_api(h);if(count>=1500){release_api(iterator);break;}
        }
        if(count>=1500)break;
    }
    if(scope)release_api(scope);fflush(stdout);return count+1;
}
int wave_kdb_instances(const char* module, LocationCB cb, void* user) {
    if(!initialized){error_text="No KDB attached";return 0;}
    if(!instances_indexed){index_instances(nullptr);instances_indexed=true;}
    auto found=instances.find(module);if(found!=instances.end())for(const auto& row:found->second)
    {
        auto h=by_name(row.fullname.c_str(),nullptr);if(!h)continue;
        auto file=property(npiDefFile,h);int line=get_int(npiDefLineNo,h);
        cb(user,row.fullname.c_str(),row.kind.c_str(),"",0,row.module.c_str(),file.c_str(),line,row.fullname.c_str(),nullptr,nullptr);release_api(h);
    }
    fflush(stdout);return 1;
}
int wave_kdb_module_sources(void (*callback)(void*, const char*), void* user) {
    if (!initialized) { error_text = "No KDB attached"; return 0; }
    if (!instances_indexed) {
        index_instances(nullptr);
        instances_indexed = true;
    }
    std::set<std::string> files;
    for (const auto& entry : instances) {
        for (const auto& row : entry.second) {
            auto handle = by_name(row.fullname.c_str(), nullptr);
            if (!handle) continue;
            std::string file;
            if (definition_owner(handle)) file = property(npiDefFile, handle);
            release_api(handle);
            if (file.empty()) continue;
            files.insert(std::move(file));
            break;
        }
    }
    for (const auto& file : files) callback(user, file.c_str());
    fflush(stdout);
    return 1;
}
int wave_kdb_parent(const char* fullname, LocationCB cb, void* user) {
    if(!initialized){error_text="No KDB attached";return 0;}
    auto h=by_name(fullname,nullptr);if(!h){error_text="KDB object not found";return 0;}
    auto parent=handle_api(npiScope,h);if(parent){emit(parent,cb,user);release_api(parent);}
    release_api(h);fflush(stdout);return 1;
}
int wave_kdb_ports(const char* instance, PortDeclarationCB declaration, PortLinkCB link,
                   PortGapCB gap, PortExpressionCB expression, void* user) {
    if (!initialized) { error_text = "No KDB attached"; return 0; }
    auto scope = by_name(instance, nullptr);
    if (!scope) { error_text = "KDB module not found"; return 0; }
    int remaining = 4096;
    if (get_int(npiType, scope) == npiModule) {
        emit_port_links(scope, declaration, link, gap, expression, user, remaining);
        emit_child_port_links(scope, declaration, link, gap, expression, user, remaining);
    }
    release_api(scope);
    fflush(stdout);
    return remaining > 0 ? 1 : 2;
}
void wave_kdb_close(){if(initialized){end_api();initialized=false;}fflush(stdout);}
}

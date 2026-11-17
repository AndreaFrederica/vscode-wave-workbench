// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Small original C ABI adapter. Synopsys headers/libraries stay in VERDI_HOME.
#include "ffrAPI.h"
#include <cstdint>
#include <string>
#include <vector>
#include <cstdlib>
#include <exception>
#include <cmath>
using SigCB = void (*)(void*, uint32_t, const char*, const char*, uint32_t, int);
using EventCB = int (*)(void*, uint64_t, const char*);
struct Reader {
    ffrObject* obj = nullptr;
    SigCB cb; void* user;
    std::vector<std::string> scopes;
    ~Reader() { if (obj) obj->ffrClose(); }
};
static bool_T tree(fsdbTreeCBType type, void* user, void* data) {
    auto* r = static_cast<Reader*>(user);
    if (type == FSDB_TREE_CBT_SCOPE) r->scopes.emplace_back(static_cast<fsdbTreeCBDataScope*>(data)->name);
    else if (type == FSDB_TREE_CBT_UPSCOPE) { if (!r->scopes.empty()) r->scopes.pop_back(); }
    else if (type == FSDB_TREE_CBT_VAR) {
        auto* v = static_cast<fsdbTreeCBDataVar*>(data);
        std::string scope;
        for (auto& s : r->scopes) { if (!scope.empty()) scope += "."; scope += s; }
        uint32_t width = std::abs(v->lbitnum - v->rbitnum) + 1;
        bool supported = v->bytes_per_bit == FSDB_BYTES_PER_BIT_1B && width <= 65536;
        r->cb(r->user, v->u.idcode, scope.c_str(), v->name, width, supported);
    }
    return 1;
}
extern "C" {
void* wave_open(const char* path, SigCB cb, void* user) {
    try {
        auto* r = new Reader(); r->cb = cb; r->user = user;
        r->obj = ffrObject::ffrOpen3(const_cast<char*>(path));
        if (!r->obj) { delete r; return nullptr; }
        r->obj->ffrSetTreeCBFunc(tree, r);
        if (r->obj->ffrReadScopeVarTree() != FSDB_RC_SUCCESS) { delete r; return nullptr; }
        return r;
    } catch (...) { return nullptr; }
}
void wave_close(void* ptr) { delete static_cast<Reader*>(ptr); }
const char* wave_scale(void* ptr) { return static_cast<Reader*>(ptr)->obj->ffrGetScaleUnit(); }
uint64_t wave_bound(void* ptr, int maximum) {
    fsdbTag64 t = {};
    auto* o = static_cast<Reader*>(ptr)->obj;
    if (maximum) o->ffrGetMaxFsdbTag64(&t); else o->ffrGetMinFsdbTag64(&t);
    return (uint64_t(t.H) << 32) | t.L;
}
// Only requested signals are loaded. SDK view-window support varies by FSDB version;
// traversal always seeks to start and stops at end even when SDK loads extra blocks.
int wave_query(void* ptr, uint32_t id, uint64_t start, uint64_t end, EventCB cb, void* user) {
    auto* o = static_cast<Reader*>(ptr)->obj;
    int result = 0;
    try {
        o->ffrUnloadSignals(); o->ffrResetSignalList();
        o->ffrAddToSignalList(id);
        fsdbXTag a = {}, b = {};
        a.hltag.H = start >> 32; a.hltag.L = start;
        b.hltag.H = end >> 32; b.hltag.L = end;
        if (o->ffrIsViewWindowSet()) o->ffrResetViewWindow(&a, &b);
        else o->ffrSetViewWindow(&a, &b);
        if (o->ffrLoadSignals() != FSDB_RC_SUCCESS) return -1;
        auto h = o->ffrCreateVCTraverseHandle(id);
        if (!h) return -1;
        if (h->ffrGetBytesPerBit() != FSDB_BYTES_PER_BIT_1B || h->ffrGetBitSize() > 65536) { h->ffrFree(); return -2; }
        fsdbTag64 t = {}; t.H = start >> 32; t.L = start;
        if (h->ffrHasIncoreVC() && h->ffrGotoXTag(&t) == FSDB_RC_SUCCESS) {
            do {
                byte_T* raw = nullptr;
                if (h->ffrGetXTag(&t) != FSDB_RC_SUCCESS || h->ffrGetVC(&raw) != FSDB_RC_SUCCESS || !raw) { result = -1; break; }
                uint64_t time = (uint64_t(t.H) << 32) | t.L;
                if (time > end) break;
                std::string value(h->ffrGetBitSize(), 'x');
                for (size_t i = 0; i < value.size(); ++i) {
                    switch(raw[i]) { case FSDB_BT_VCD_0: value[i]='0'; break; case FSDB_BT_VCD_1: value[i]='1'; break; case FSDB_BT_VCD_Z: value[i]='z'; break; default: break; }
                }
                if (!cb(user, time, value.c_str())) { result = 1; break; }
            } while (h->ffrGotoNextVC() == FSDB_RC_SUCCESS);
        }
        h->ffrFree(); o->ffrUnloadSignals();
    } catch (...) { result = -1; }
    return result;
}
}

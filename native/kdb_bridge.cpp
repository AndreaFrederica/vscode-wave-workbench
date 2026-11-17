// Optional NPI loader. No proprietary headers or libraries are redistributed.
#include "npi.h"
#include "npi_hdl.h"
#include <dlfcn.h>
#include <cstdio>
#include <string>
#include <vector>
#include <cstring>
#include <unistd.h>
#include <unordered_map>
static void* lib = nullptr;
static bool initialized = false;
static std::string error_text;
static decltype(&npi_init) init_api;
static decltype(&npi_end) end_api;
static decltype(&npi_load_design) load_api;
static decltype(&npi_handle_by_name) by_name;
static decltype(&npi_get_str) get_str;
static decltype(&npi_get) get_int;
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
using LocationCB = void (*)(void*, const char*, const char*, const char*, int, const char*, const char*, int, const char*);
static std::string property(int prop, npiHandle h) { const char* s=get_str(prop,h); return s?s:""; }
static bool design_type(int type) { return type==npiModule || type==npiModuleArray || type==npiProgram || type==npiProgramArray; }
static bool generated_type(int type) { return type==npiGenScope; }
// Hierarchy browsing must not fetch source locations: NPI may lazily load an
// entire compilation unit for npiFile/npiDefFile. Resolve those only on demand.
static void emit_summary(npiHandle h, LocationCB cb, void* user) {
    auto fullname=property(npiFullName,h),kind=property(npiType,h);
    int type=get_int(npiType,h);
    auto module=(design_type(type)||type==npiInterface||type==npiInterfaceArray)?property(npiDefName,h):"";
    cb(user,fullname.c_str(),kind.c_str(),"",0,module.c_str(),"",0,fullname.c_str());
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
static void emit(npiHandle h, LocationCB cb, void* user) {
    std::string fullname=property(npiFullName,h),kind=property(npiType,h),file=property(npiFile,h);
    int line=get_int(npiLineNo,h);
    npiHandle scope=get_int(npiType,h)==npiModule?h:handle_api(npiScope,h);
    for(int depth=0;scope && get_int(npiType,scope)!=npiModule && depth<64;++depth){
        auto parent=handle_api(npiScope,scope);release_api(scope);scope=parent;
    }
    std::string module=scope?property(npiDefName,scope):"";
    std::string definition=scope?property(npiDefFile,scope):"";
    int defline=scope?get_int(npiDefLineNo,scope):0;
    std::string instance=scope?property(npiFullName,scope):"";
    cb(user,fullname.c_str(),kind.c_str(),file.c_str(),line,module.c_str(),definition.c_str(),defline,instance.c_str());
    if(scope && scope!=h)release_api(scope);
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
        cb(user,row.fullname.c_str(),row.kind.c_str(),"",0,row.module.c_str(),file.c_str(),line,row.fullname.c_str());release_api(h);
    }
    fflush(stdout);return 1;
}
int wave_kdb_parent(const char* fullname, LocationCB cb, void* user) {
    if(!initialized){error_text="No KDB attached";return 0;}
    auto h=by_name(fullname,nullptr);if(!h){error_text="KDB object not found";return 0;}
    auto parent=handle_api(npiScope,h);if(parent){emit(parent,cb,user);release_api(parent);}
    release_api(h);fflush(stdout);return 1;
}
void wave_kdb_close(){if(initialized){end_api();initialized=false;}fflush(stdout);}
}

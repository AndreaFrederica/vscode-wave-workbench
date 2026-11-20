// SPDX-License-Identifier: MPL-2.0

#include <stdio.h>
#include <stdlib.h>
#include <vpi_user.h>

static void json_string(FILE *file, const char *value) {
    fputc('"', file);
    if (value) {
        for (const unsigned char *c = (const unsigned char *)value; *c; ++c) {
            if (*c == '"' || *c == '\\') fputc('\\', file);
            if (*c < 32) fprintf(file, "\\u%04x", *c);
            else fputc(*c, file);
        }
    }
    fputc('"', file);
}

static void position(FILE *file, vpiHandle object, int file_property, int line_property) {
    const int line = vpi_get(line_property, object);
    const char *path = vpi_get_str(file_property, object);
    if (line <= 0 || !path || !*path) {
        fputs("null", file);
        return;
    }
    fputs("{\"file\":", file);
    json_string(file, path);
    fprintf(file, ",\"line\":%d}", line);
}

static void entry(FILE *file, vpiHandle object, vpiHandle parent, int is_scope) {
    const char *fullname = vpi_get_str(vpiFullName, object);
    if (!fullname || !*fullname) return;
    fputs("{\"fullname\":", file);
    json_string(file, fullname);
    fputs(",\"parent\":", file);
    json_string(file, parent ? vpi_get_str(vpiFullName, parent) : "");
    fprintf(file, ",\"scope\":%s", is_scope ? "true" : "false");
    if (is_scope && vpi_get(vpiType, object) == vpiGenScope)
        fputs(",\"generate\":true", file);
    if (is_scope && vpi_get(vpiType, object) == vpiModule) {
        fputs(",\"module\":", file);
        json_string(file, vpi_get_str(vpiDefName, object));
        fputs(",\"declaration\":", file);
        position(file, object, vpiDefFile, vpiDefLineNo);
        fputs(",\"instance\":", file);
    } else {
        fputs(",\"declaration\":", file);
    }
    position(file, object, vpiFile, vpiLineNo);
    fputs("}\n", file);
}

static void scope(FILE *file, vpiHandle current, vpiHandle parent) {
    entry(file, current, parent, 1);
    const int relations[] = { vpiNet, vpiReg, vpiVariables, vpiParameter, vpiPort };
    for (size_t i = 0; i < sizeof relations / sizeof *relations; ++i) {
        vpiHandle list = vpi_iterate(relations[i], current);
        vpiHandle object;
        while (list && (object = vpi_scan(list))) entry(file, object, current, 0);
    }
    // vpiInternalScope includes child instances and generated scopes.
    vpiHandle list = vpi_iterate(vpiInternalScope, current);
    vpiHandle child;
    while (list && (child = vpi_scan(list))) {
        const int kind = vpi_get(vpiType, child);
        if (kind == vpiModule || kind == vpiGenScope || kind == vpiNamedBegin ||
            kind == vpiNamedFork || kind == vpiTask || kind == vpiFunction)
            scope(file, child, current);
    }
}

static PLI_INT32 collect(p_cb_data callback) {
    (void)callback;
    const char *filename = getenv("WAVE_WORKBENCH_HDL_OUTPUT");
    if (!filename) return 0;
    FILE *file = fopen(filename, "w");
    if (!file) return 0;
    vpiHandle list = vpi_iterate(vpiModule, NULL);
    vpiHandle root;
    while (list && (root = vpi_scan(list))) scope(file, root, NULL);
    fclose(file);
    return 0;
}

void wave_workbench_hdl_boot(void) {
    s_cb_data callback = {0};
    callback.reason = cbStartOfSimulation;
    callback.cb_rtn = collect;
    vpi_register_cb(&callback);
}

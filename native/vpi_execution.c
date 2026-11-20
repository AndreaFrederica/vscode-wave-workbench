// SPDX-License-Identifier: MPL-2.0

#include "sv_vpi_user.h"

#include <ctype.h>
#include <errno.h>
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef WAVE_WORKBENCH_VCS_PROBES
#include "svdpi.h"
#endif

enum {
    MAX_WATCHES = 64, MAX_PACKED_WIDTH = 4096,
    MAX_STATEMENT_SCOPES = 16, MAX_STATEMENTS = 1024, MAX_STATEMENT_DEPTH = 64,
};

struct Watch {
    const char *path;
    const char *signal;
    int width;
    vpiHandle object;
    s_vpi_time time;
    s_vpi_value value;
};

struct Statement {
    const char *scope;
    char *file;
    int line;
    size_t id;
    const char *signal;
    int blocking;
};

static struct Watch watches[MAX_WATCHES];
static size_t watch_count;
static struct Statement statements[MAX_STATEMENTS];
static size_t statement_count;
static const char *statement_scopes[MAX_STATEMENT_SCOPES];
static size_t statement_scope_count;
static FILE *recording;
static uint64_t ordinal;
static int failed;
static int ready;
static int live;
static int pending_advance;
static int time_precision;
static int dpi_execution;
static int nba_execution;
static s_vpi_time zero_delay = { .type = vpiSimTime };

static void recording_failed(const char *message, const char *detail) {
    if (!failed) {
        vpi_printf("Wave Workbench VPI: %s %s\n", message, detail);
        if (live) {
            fprintf(stdout, "wave-workbench {\"error\":\"VCS VPI: %s\"}\n", message);
            fflush(stdout);
        }
    }
    failed = 1;
}

static uint64_t tick(void) {
    s_vpi_time time = { .type = vpiSimTime };
    vpi_get_time(NULL, &time);
    return ((uint64_t)time.high << 32) | (uint32_t)time.low;
}

#ifdef WAVE_WORKBENCH_VCS_PROBES
struct Probe {
    const char *site;
    const char *instance;
    const char *signal;
    const char *statement;
    const char *process;
    const char *kind;
};

static struct Probe probes[] = {
#include "wave_workbench_probes.h"
};
static const char *const probe_owners[sizeof(probes) / sizeof(*probes)] =
#ifdef WAVE_WORKBENCH_VCS_PROBE_OWNERS
    WAVE_WORKBENCH_VCS_PROBE_OWNERS;
#else
    { NULL };
#endif
struct ProbeTarget {
    const char *tag;
    int selected;
    int left;
    int right;
};
static const struct ProbeTarget probe_targets[sizeof(probes) / sizeof(*probes)] =
#ifdef WAVE_WORKBENCH_VCS_PROBE_TARGETS
    WAVE_WORKBENCH_VCS_PROBE_TARGETS;
#else
    { { 0 } };
#endif
static uint64_t pending_blocking[sizeof(probes) / sizeof(*probes)];
static int probe_layouts[sizeof(probes) / sizeof(*probes)][2];

struct FileRead {
    const struct Probe *probe;
    char site[129];
    int offset;
    int value;
};
static struct FileRead pending_reads[64];
static size_t pending_read_count;

static struct Probe *find_probe(const char *site) {
    if (!ready || failed || !dpi_execution) return NULL;
    const char *instance = svGetNameFromScope(svGetScope());
    if (!instance) {
        recording_failed("DPI scope unavailable for probe", site);
        return NULL;
    }
    for (size_t index = 0; index < sizeof(probes) / sizeof(*probes); ++index) {
        const char *owner = probe_owners[index] ? probe_owners[index] : probes[index].instance;
        if (!strcmp(probes[index].site, site) && !strcmp(owner, instance))
            return &probes[index];
    }
    return NULL;
}

static int write_operand_values(FILE *stream, const char *operands, const char *field) {
    const char *name = operands;
    size_t count = 0;
    if (stream) fprintf(stream, ",\"%s\":{", field);
    while (*name) {
        const size_t name_len = strspn(name,
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_0123456789$");
        if ((!isalpha((unsigned char)*name) && *name != '_') ||
            !name_len || name_len > 64 || name[name_len] != '=' || count == 8)
            return 0;
        const char *value = name + name_len + 1;
        const size_t width = strspn(value, "01xzXZ");
        if (!width || width > MAX_PACKED_WIDTH ||
            (value[width] && (value[width] != ',' || !value[width + 1])))
            return 0;
        if (stream)
            fprintf(stream, "%s\"%.*s\":\"%.*s\"", count ? "," : "",
                    (int)name_len, name, (int)width, value);
        ++count;
        name = value + width + (value[width] ? 1 : 0);
    }
    if (stream) fputc('}', stream);
    return count != 0;
}

static int write_probe(FILE *stream, const struct Probe *probe, const char *kind,
                       const char *value, uint64_t evaluation, const char *timing,
                       const int *range, const char *operands, const char *guards,
                       uint64_t time, int framed) {
    fprintf(stream, "%s{\"tick\":\"%" PRIu64 "\",\"ordinal\":%" PRIu64
            ",\"kind\":\"%s\",\"instance\":\"%s\",\"processId\":\"%s\"",
            framed ? "wave-workbench {\"execution\":" : "",
            time, ordinal, kind, probe->instance, probe->process);
    if (*probe->statement) fprintf(stream, ",\"statementId\":\"%s\"", probe->statement);
    if (*probe->signal)
        fprintf(stream, ",\"signal\":\"%s\",\"writeKind\":\"%s\"",
                probe->signal, probe->kind);
    const struct ProbeTarget *target = &probe_targets[probe - probes];
    if (range)
        fprintf(stream, ",\"targetRange\":[%d,%d]", range[0], range[1]);
    else if (target->selected == 1)
        fprintf(stream, ",\"targetRange\":[%d,%d]", target->left, target->right);
    if (value) fprintf(stream, ",\"value\":\"%s\"", value);
    if (evaluation) fprintf(stream, ",\"evaluationOrdinal\":%" PRIu64, evaluation - 1);
    if (timing) fprintf(stream, ",\"timing\":\"%s\"", timing);
    if (timing && target->selected) {
        const int *layout = probe_layouts[probe - probes];
        fprintf(stream, ",\"targetPackedRange\":[%d,%d]", layout[0], layout[1]);
    }
    if (operands && !write_operand_values(stream, operands, "operandValues")) return 0;
    if (guards && !write_operand_values(stream, guards, "guardEntryValues")) return 0;
    if (!strcmp(kind, "assignment-evaluated") && pending_read_count) {
        const struct FileRead *read = &pending_reads[pending_read_count - 1];
        if (read->probe == probe && *read->site) {
            fprintf(stream, ",\"externalSteps\":[{\"statementId\":\"%s\",\"operation\":\"$fgetc at byte %d%s\"",
                    read->site, read->offset, read->value < 0 ? " (EOF)" : "");
            if (read->value >= 0) {
                fputs(",\"value\":\"", stream);
                for (int bit = 7; bit >= 0; --bit) fputc('0' + ((read->value >> bit) & 1), stream);
                fputc('"', stream);
            }
            fputs("}]", stream);
        }
    }
    fprintf(stream, "}%s\n", framed ? "}" : "");
    return !ferror(stream);
}

static void emit_probe_at(const struct Probe *probe, const char *kind, const char *value,
                          uint64_t evaluation, const char *timing, const int *range,
                          const char *operands, const char *guards) {
    const uint64_t time = tick();
    if ((recording && !write_probe(recording, probe, kind, value, evaluation, timing, range, operands, guards, time, 0)) ||
        (live && !write_probe(stdout, probe, kind, value, evaluation, timing, range, operands, guards, time, 1)))
        recording_failed("cannot write DPI probe for", probe->instance);
    else
        ++ordinal;
}

static void emit_probe(const struct Probe *probe, const char *kind, const char *value,
                       uint64_t evaluation, const char *timing) {
    emit_probe_at(probe, kind, value, evaluation, timing, NULL, NULL, NULL);
}

void wave_workbench_write(const char *site, const char *value, svBit committed) {
    struct Probe *probe = find_probe(site);
    if (!probe) return;
    const int blocking = !strcmp(probe->kind, "blocking");
    uint64_t *pending = &pending_blocking[probe - probes];
    if (!*value || strlen(value) > MAX_PACKED_WIDTH || value[strspn(value, "01xzXZ")] ||
        (committed && (!blocking || !*pending)) ||
        (!committed && blocking && *pending)) {
        recording_failed("invalid assignment probe sequence for", probe->instance);
        return;
    }
    if (committed) {
        // The VCS modport alias can propagate to physical storage after the statement returns.
        if (probe_owners[probe - probes])
            emit_probe(probe, "assignment-unobserved", NULL, *pending, NULL);
        else
            emit_probe(probe, "assignment-committed", value, *pending, NULL);
        *pending = 0;
    } else {
        if (blocking) *pending = ordinal + 1;
        emit_probe(probe, "assignment-evaluated", value, 0, NULL);
        if (pending_read_count && pending_reads[pending_read_count - 1].probe == probe)
            --pending_read_count;
    }
}

void wave_workbench_begin_evaluation(const char *site) {
    const struct Probe *probe = find_probe(site);
    if (!probe) return;
    if (pending_read_count == sizeof(pending_reads) / sizeof(*pending_reads)) {
        recording_failed("file read evaluation stack overflow for", probe->instance);
        return;
    }
    pending_reads[pending_read_count++] = (struct FileRead){ .probe = probe };
}

void wave_workbench_file_read(const char *site, int offset, int value) {
    if (!ready || failed || !dpi_execution || !pending_read_count) return;
    const char *instance = svGetNameFromScope(svGetScope());
    struct FileRead *read = &pending_reads[pending_read_count - 1];
    if (!instance || strcmp(instance, read->probe->instance)) return;
    const size_t len = strlen(site);
    if (!len || len >= sizeof(read->site) ||
        site[strspn(site, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.-")] ||
        *read->site || value < -1 || value > 255) {
        recording_failed("invalid file read for", read->probe->instance);
        return;
    }
    if (offset < 0) return; // The file position is unavailable for a non-seekable input.
    memcpy(read->site, site, len + 1);
    read->offset = offset;
    read->value = value;
}

void wave_workbench_process(const char *site) {
    const struct Probe *probe = find_probe(site);
    if (probe) emit_probe(probe, "process-trigger", NULL, 0, NULL);
}

void wave_workbench_branch(const char *site) {
    const struct Probe *probe = find_probe(site);
    if (probe) emit_probe(probe, "branch-taken", NULL, 0, NULL);
}

#ifdef WAVE_WORKBENCH_VCS_NBA_TAGS
enum { MAX_PENDING_NBA = 4096 };

struct NbaEvaluation {
    const struct Probe *probe;
    struct NbaEvaluation *next;
    uint64_t token;
    int range[2];
    size_t offset;
    size_t width;
    char value[];
};

struct NbaTarget {
    const struct Probe *probe;
    vpiHandle target;
    s_vpi_time time;
    s_vpi_value value;
    struct NbaEvaluation *head;
    struct NbaEvaluation *tail;
    size_t count;
    int layout_known;
    int64_t left;
    int64_t right;
    int width;
};

static struct NbaTarget nba_targets[sizeof(probes) / sizeof(*probes)];
static size_t nba_target_count;
static struct NbaTarget *nba_by_probe[sizeof(probes) / sizeof(*probes)];

static const int *captured_range(const struct NbaEvaluation *evaluation) {
    return probe_targets[evaluation->probe - probes].selected == 2
        ? evaluation->range : NULL;
}

static void discard_nba(struct NbaTarget *target) {
    struct NbaEvaluation *head = target->head;
    target->head = head->next;
    if (!target->head) target->tail = NULL;
    --target->count;
    free(head);
}

static PLI_INT32 on_nba_tag(p_cb_data callback) {
    if (failed || !ready) return 0;
    struct NbaTarget *target = (struct NbaTarget *)callback->user_data;
    s_vpi_value value = { .format = vpiBinStrVal };
    vpi_get_value(callback->obj, &value);
    const char *bits = value.value.str;
    if (!bits || strlen(bits) != 64 || bits[strspn(bits, "01")]) {
        recording_failed("invalid NBA observation tag for", target->probe->signal);
        return 0;
    }
    const uint64_t token = (uint64_t)strtoull(bits, NULL, 2);
    struct NbaEvaluation *observed = target->head;
    while (observed && observed->token != token) observed = observed->next;
    if (!observed) {
        recording_failed("NBA tag has no recorded evaluation for", target->probe->signal);
        return 0;
    }
    vpi_get_value(target->target, &value);
    const char *target_bits = value.value.str;
    const size_t width = observed->width;
    const size_t offset = observed->offset;
    const int matches = target_bits && strlen(target_bits) == (size_t)target->width &&
        offset + width <= (size_t)target->width &&
        !strncmp(target_bits + offset, observed->value, width);
    while (target->head != observed) {
        const struct NbaEvaluation *prior = target->head;
        emit_probe_at(prior->probe, "assignment-unobserved", NULL, prior->token,
                      NULL, captured_range(prior), NULL, NULL);
        discard_nba(target);
    }
    emit_probe_at(observed->probe, matches ? "assignment-committed" : "assignment-unobserved",
                  matches ? observed->value : NULL, observed->token,
                  matches ? "simulator-commit" : NULL,
                  captured_range(observed), NULL, NULL);
    discard_nba(target);
    return 0;
}

static uint64_t evaluate_nba(const char *site, const char *value, const char *index,
                             const char *operands, const char *guards) {
    const struct Probe *probe = find_probe(site);
    if (!probe) return 0;
    struct NbaTarget *target = nba_by_probe[probe - probes];
    const struct ProbeTarget *probe_target = &probe_targets[probe - probes];
    const int dynamic = probe_target->selected == 2;
    const size_t width = strlen(value);
    const size_t expected = !target ? 0 : dynamic
        ? (size_t)llabs((int64_t)probe_target->left) + 1
        : probe_target->selected
          ? (size_t)llabs((int64_t)probe_target->left - probe_target->right) + 1
          : (size_t)target->width;
    if (!target || dynamic != (index != NULL) ||
        (operands && !write_operand_values(NULL, operands, NULL)) ||
        (guards && !write_operand_values(NULL, guards, NULL)) ||
        !width || width > MAX_PACKED_WIDTH || value[strspn(value, "01xzXZ")] ||
        width != expected ||
        target->count == MAX_PENDING_NBA) {
        recording_failed("NBA evaluation or capture limit invalid for", probe->signal);
        return 0;
    }
    const uint64_t token = ordinal + 1;
    int range[2] = { probe_target->left, probe_target->right };
    if (dynamic) {
        char *end;
        errno = 0;
        const long long selected = strtoll(index, &end, 10);
        const int64_t lower = target->left < target->right ? target->left : target->right;
        const int64_t upper = target->left > target->right ? target->left : target->right;
        if (errno || end == index || *end || selected < lower || selected > upper ||
            selected + probe_target->left < lower || selected + probe_target->left > upper) {
            emit_probe(probe, "assignment-evaluated", value, 0, NULL);
            emit_probe(probe, "assignment-unobserved", NULL, token, NULL);
            return 0;
        }
        int other = (int)(selected + probe_target->left);
        int base = (int)selected;
        const int base_is_left = target->left <= target->right ? base <= other : base >= other;
        range[0] = base_is_left ? base : other;
        range[1] = base_is_left ? other : base;
    }
    struct NbaEvaluation *pending = malloc(sizeof(*pending) + width + 1);
    if (!pending) {
        recording_failed("cannot retain NBA evaluation for", probe->signal);
        return 0;
    }
    pending->probe = probe;
    pending->next = NULL;
    pending->token = token;
    memcpy(pending->range, range, sizeof(range));
    pending->offset = probe_target->selected ? (size_t)llabs((int64_t)range[0] - target->left) : 0;
    pending->width = width;
    memcpy(pending->value, value, width + 1);
    if (target->tail) target->tail->next = pending;
    else target->head = pending;
    target->tail = pending;
    ++target->count;
    emit_probe_at(probe, "assignment-evaluated", value, 0, NULL,
                  captured_range(pending), operands, guards);
    return token;
}

unsigned long long wave_workbench_nba_evaluate(const char *site, const char *value) {
    return evaluate_nba(site, value, NULL, NULL, NULL);
}

unsigned long long wave_workbench_nba_evaluate_index(const char *site, const char *value,
                                                     const char *index) {
    return evaluate_nba(site, value, index, NULL, NULL);
}

unsigned long long wave_workbench_nba_evaluate_sampled(const char *site, const char *value,
                                                       const char *operands) {
    return evaluate_nba(site, value, NULL, operands, NULL);
}

unsigned long long wave_workbench_nba_evaluate_guarded(const char *site, const char *value,
                                                       const char *operands, const char *guards) {
    return evaluate_nba(site, value, NULL, operands, guards);
}

static int index_value(vpiHandle object) {
    s_vpi_value value = { .format = vpiIntVal };
    vpi_get_value(object, &value);
    return value.value.integer;
}

static int packed_layout(struct NbaTarget *target) {
    if (target->layout_known) return 1;
    vpiHandle left = vpi_handle(vpiLeftRange, target->target);
    vpiHandle right = vpi_handle(vpiRightRange, target->target);
    if (!left || !right) return 0;
    target->left = index_value(left);
    target->right = index_value(right);
    target->layout_known = llabs(target->left - target->right) + 1 == target->width;
    return target->layout_known;
}

static int register_nba_targets(void) {
    for (size_t index = 0; index < sizeof(probes) / sizeof(*probes); ++index) {
        const struct Probe *probe = &probes[index];
        const struct ProbeTarget *selection = &probe_targets[index];
        if (strcmp(probe->kind, "nonblocking")) continue;
        struct NbaTarget *target = NULL;
        for (size_t i = 0; i < nba_target_count; ++i) {
            const struct ProbeTarget *other = &probe_targets[nba_targets[i].probe - probes];
            if (!strcmp(nba_targets[i].probe->instance, probe->instance) &&
                !strcmp(nba_targets[i].probe->signal, probe->signal) &&
                ((other->tag && selection->tag && !strcmp(other->tag, selection->tag)) ||
                  (!other->tag && !selection->tag))) {
                target = &nba_targets[i];
                break;
            }
        }
        if (!target) {
            target = &nba_targets[nba_target_count++];
            target->probe = probe;
            char name[8192];
            int length = snprintf(name, sizeof(name), "%s.%s", probe->instance, probe->signal);
            if (length > 0 && (size_t)length < sizeof(name))
                target->target = vpi_handle_by_name(name, NULL);
            length = snprintf(name, sizeof(name), "%s.wave_workbench_nba_tag_%s",
                              probe->instance, probe->signal);
            if (selection->tag)
                length = snprintf(name, sizeof(name), "%s.%s", probe->instance, selection->tag);
            vpiHandle tag = length > 0 && (size_t)length < sizeof(name)
                ? vpi_handle_by_name(name, NULL) : NULL;
            if (!target->target || !tag || vpi_get(vpiSize, tag) != 64) {
                recording_failed("NBA probe target or tag unavailable for", probe->instance);
                return 0;
            }
            target->width = vpi_get(vpiSize, target->target);
            target->time.type = vpiSimTime;
            target->value.format = vpiBinStrVal;
            s_cb_data cb = {
                .reason = cbValueChange, .cb_rtn = on_nba_tag, .obj = tag,
                .time = &target->time, .value = &target->value, .user_data = (PLI_BYTE8 *)target,
            };
            if (!vpi_register_cb(&cb)) {
                recording_failed("NBA tag callback unavailable for", probe->instance);
                return 0;
            }
        }
        if (selection->selected && !packed_layout(target)) {
            recording_failed("NBA packed range unavailable for", probe->signal);
            return 0;
        }
        if (selection->selected) {
            probe_layouts[index][0] = (int)target->left;
            probe_layouts[index][1] = (int)target->right;
        }
        if (selection->selected == 1) {
            const int step = target->left <= target->right ? 1 : -1;
            const int64_t first = ((int64_t)selection->left - target->left) * step;
            const int64_t last = ((int64_t)selection->right - target->left) * step;
            if (first < 0 || last < first || last >= target->width) {
                recording_failed("NBA probe range differs from the RTL layout for", probe->signal);
                return 0;
            }
        }
        nba_by_probe[index] = target;
    }
    nba_execution = nba_target_count != 0;
    return 1;
}
#endif
#endif

static const char *packed_value(const struct Watch *watch) {
    s_vpi_value value = { .format = vpiBinStrVal };
    vpi_get_value(watch->object, &value);
    const char *bits = value.value.str;
    if (!bits || strlen(bits) != (size_t)watch->width ||
        bits[strspn(bits, "01xzXZ")] != '\0') {
        recording_failed("unavailable packed value for", watch->path);
        return NULL;
    }
    return bits;
}

static int write_change(FILE *stream, const struct Watch *watch,
                        const char *bits, uint64_t time, int framed) {
    return fprintf(stream,
                "%s{\"tick\":\"%" PRIu64 "\",\"ordinal\":%" PRIu64
                ",\"kind\":\"signal-value-changed\",\"instance\":\"%.*s\","
                "\"signal\":\"%s\",\"value\":\"%s\"}%s\n",
                framed ? "wave-workbench {\"execution\":" : "",
                time, ordinal, (int)(watch->signal - watch->path - 1),
                watch->path, watch->signal, bits, framed ? "}" : "") >= 0;
}

static PLI_INT32 on_change(p_cb_data callback) {
    const struct Watch *watch = (const struct Watch *)callback->user_data;
    if (failed || !ready) return 0;
    const char *bits = packed_value(watch);
    if (!bits) return 0;
    const uint64_t time = tick();
    if ((recording && !write_change(recording, watch, bits, time, 0)) ||
        (live && !write_change(stdout, watch, bits, time, 1)))
        recording_failed("cannot write value for", watch->path);
    else
        ++ordinal;
    return 0;
}

static void write_json_string(FILE *stream, const char *value) {
    fputc('"', stream);
    for (const unsigned char *byte = (const unsigned char *)value; *byte; ++byte) {
        if (*byte == '"' || *byte == '\\')
            fprintf(stream, "\\%c", *byte);
        else if (*byte < 32)
            fprintf(stream, "\\u%04x", (unsigned)*byte);
        else
            fputc(*byte, stream);
    }
    fputc('"', stream);
}

static int write_statement(FILE *stream, const struct Statement *statement,
                           uint64_t time, int framed) {
    fprintf(stream, "%s{\"tick\":\"%" PRIu64 "\",\"ordinal\":%" PRIu64
            ",\"kind\":\"assignment-entered\",\"instance\":\"%s\","
            "\"statementId\":\"vcs-%zu\",\"writeKind\":\"%s\",\"statementSite\":{\"file\":",
            framed ? "wave-workbench {\"execution\":" : "",
            time, ordinal, statement->scope, statement->id,
            statement->blocking ? "blocking" : "nonblocking");
    write_json_string(stream, statement->file);
    fprintf(stream, ",\"line\":%d}", statement->line);
    if (statement->signal) fprintf(stream, ",\"signal\":\"%s\"", statement->signal);
    fprintf(stream, "}%s\n", framed ? "}" : "");
    return !ferror(stream);
}

static PLI_INT32 on_statement(p_cb_data callback) {
    if (failed || !ready) return 0;
    const struct Statement *statement = (const struct Statement *)callback->user_data;
    const uint64_t time = tick();
    if ((recording && !write_statement(recording, statement, time, 0)) ||
        (live && !write_statement(stdout, statement, time, 1)))
        recording_failed("cannot write assignment entry for", statement->scope);
    else
        ++ordinal;
    return 0;
}

static int write_snapshot(int done) {
    static const char *units[] = { "s", "ms", "us", "ns", "ps", "fs" };
    static const int magnitudes[] = { 1, 10, 100 };
    const int unit = (2 - time_precision) / 3;
    // Buffer the frame until all reads pass so a VPI error cannot split it.
    static char values[MAX_WATCHES][MAX_PACKED_WIDTH + 1];
    for (size_t index = 0; index < watch_count; ++index) {
        const char *bits = packed_value(&watches[index]);
        if (!bits) return 0;
        memcpy(values[index], bits, (size_t)watches[index].width + 1);
    }
    fprintf(stdout, "wave-workbench {\"snapshot\":{\"tick\":\"%" PRIu64
            "\",\"scale\":\"%d%s\",\"done\":%s,\"executionEvents\":%s,"
            "\"valueChangeEvents\":true,\"statementEntryEvents\":%s,\"nbaCommitEvents\":%s,\"values\":{",
            tick(), magnitudes[time_precision + 3 * unit], units[unit],
            done ? "true" : "false", dpi_execution ? "true" : "false",
            statement_count ? "true" : "false", nba_execution ? "true" : "false");
    for (size_t index = 0; index < watch_count; ++index)
        fprintf(stdout, "%s\"%s\":\"%s\"", index ? "," : "",
                watches[index].path, values[index]);
    fputs("}}}\n", stdout);
    return fflush(stdout) == 0 && !ferror(stdout);
}

static PLI_INT32 on_read_only(p_cb_data callback);

static PLI_INT32 on_next_slot(p_cb_data callback) {
    (void)callback;
    s_cb_data entry = {
        .reason = cbReadOnlySynch, .cb_rtn = on_read_only, .time = &zero_delay,
    };
    if (!vpi_register_cb(&entry))
        recording_failed("read-only time-slot callback unavailable", "");
    return 0;
}

static PLI_INT32 on_read_only(p_cb_data callback) {
    (void)callback;
    if (failed) return 0;
    if (pending_advance) {
        pending_advance = 0;
        if (!write_snapshot(0)) return 0;
    }
    char command[16];
    while (fgets(command, sizeof(command), stdin)) {
        if (!strcmp(command, "current\n")) {
            if (!write_snapshot(0)) return 0;
        } else if (!strcmp(command, "advance\n")) {
            s_cb_data entry = {
                .reason = cbNextSimTime, .cb_rtn = on_next_slot, .time = &zero_delay,
            };
            if (vpi_register_cb(&entry)) pending_advance = 1;
            else recording_failed("next time-slot callback unavailable", "");
            return 0;
        } else {
            recording_failed("invalid live simulation command", "");
            return 0;
        }
    }
    vpi_control(vpiFinish, 0);
    return 0;
}

static PLI_INT32 on_end(p_cb_data callback) {
    (void)callback;
    if (recording) {
        if (!failed && fprintf(recording, "{\"type\":\"end\",\"tick\":\"%" PRIu64
                               "\",\"eventCount\":%" PRIu64 "}\n", tick(), ordinal) < 0)
            recording_failed("cannot write completion record", "");
        if (fclose(recording) != 0) recording_failed("cannot close recording", "");
        recording = NULL;
    }
    if (live && ready && !failed) write_snapshot(1);
    return 0;
}

static int valid_path(const char *path) {
    for (const unsigned char *current = (const unsigned char *)path; *current; ++current)
        if (!isalnum(*current) && !strchr("_$.[-]", *current)) return 0;
    return strlen(path) <= 4096;
}

static int watch_signal(const char *path) {
    const char *separator = strrchr(path, '.');
    if (!separator || separator == path || !separator[1] || !valid_path(path)) {
        recording_failed("invalid signal path", path);
        return 0;
    }
    for (size_t index = 0; index < watch_count; ++index)
        if (!strcmp(path, watches[index].path)) return 1;
    if (watch_count == MAX_WATCHES) {
        recording_failed("signal selection exceeds the callback budget", path);
        return 0;
    }
    vpiHandle object = vpi_handle_by_name((PLI_BYTE8 *)path, NULL);
    int type = object ? vpi_get(vpiType, object) : 0;
    if (type != vpiNet && type != vpiReg && type != vpiNetBit &&
        type != vpiRegBit && type != vpiBitVar) {
        recording_failed("packed net or variable unavailable", path);
        return 0;
    }
    const int width = vpi_get(vpiSize, object);
    if (width < 1 || width > MAX_PACKED_WIDTH) {
        recording_failed("packed width outside the supported range for", path);
        return 0;
    }
    struct Watch *watch = &watches[watch_count];
    watch->path = path;
    watch->signal = separator + 1;
    watch->width = width;
    watch->object = object;
    watch->time.type = vpiSimTime;
    watch->value.format = vpiBinStrVal;
    s_cb_data callback = {
        .reason = cbValueChange,
        .cb_rtn = on_change,
        .obj = object,
        .time = &watch->time,
        .value = &watch->value,
        .user_data = (PLI_BYTE8 *)watch,
    };
    if (!vpi_register_cb(&callback)) {
        recording_failed("value-change callback unavailable for", path);
        return 0;
    }
    ++watch_count;
    return 1;
}

static void watch_assignment(vpiHandle object, const char *scope) {
    if (statement_count == MAX_STATEMENTS) {
        recording_failed("assignment selection exceeds the callback budget", scope);
        return;
    }
    int line = vpi_get(vpiLineNo, object);
    const char *file = vpi_get_str(vpiFile, object);
    if (line < 1 || !file || !*file || strlen(file) > 4096) return;
    struct Statement *statement = &statements[statement_count];
    statement->file = malloc(strlen(file) + 1);
    if (!statement->file) {
        recording_failed("cannot allocate assignment source path", scope);
        return;
    }
    strcpy(statement->file, file);
    statement->scope = scope;
    statement->line = line;
    statement->id = statement_count;
    statement->blocking = vpi_get(vpiBlocking, object);
    vpiHandle lhs = vpi_handle(vpiLhs, object);
    if (lhs) {
        for (size_t index = 0; index < watch_count; ++index) {
            const struct Watch *watch = &watches[index];
            if (strlen(scope) == (size_t)(watch->signal - watch->path - 1) &&
                !strncmp(watch->path, scope, strlen(scope)) &&
                vpi_compare_objects(lhs, watch->object)) {
                statement->signal = watch->signal;
                break;
            }
        }
    }
    s_cb_data entry = {
        .reason = cbStmt, .cb_rtn = on_statement, .obj = object,
        .time = &zero_delay, .user_data = (PLI_BYTE8 *)statement,
    };
    if (!vpi_register_cb(&entry)) {
        free(statement->file);
        recording_failed("assignment callback unavailable for", scope);
        return;
    }
    ++statement_count;
}

static void visit_statement(vpiHandle statement, const char *scope, unsigned depth) {
    if (!statement || failed) return;
    if (depth == MAX_STATEMENT_DEPTH) {
        recording_failed("statement nesting exceeds the callback budget", scope);
        return;
    }
    switch (vpi_get(vpiType, statement)) {
    case vpiAssignment:
        watch_assignment(statement, scope);
        break;
    case vpiBegin:
    case vpiNamedBegin:
    case vpiFork:
    case vpiNamedFork: {
        vpiHandle iterator = vpi_iterate(vpiStmt, statement);
        if (!iterator) break;
        vpiHandle child;
        while ((child = vpi_scan(iterator)))
            visit_statement(child, scope, depth + 1);
        break;
    }
    case vpiCase: {
        vpiHandle iterator = vpi_iterate(vpiCaseItem, statement);
        if (!iterator) break;
        vpiHandle item;
        while ((item = vpi_scan(iterator)))
            visit_statement(vpi_handle(vpiStmt, item), scope, depth + 1);
        break;
    }
    case vpiIfElse:
        visit_statement(vpi_handle(vpiElseStmt, statement), scope, depth + 1);
        /* fall through */
    case vpiIf:
    case vpiDelayControl:
    case vpiEventControl:
    case vpiFor:
    case vpiWhile:
    case vpiRepeat:
    case vpiForever:
    case vpiWait:
        visit_statement(vpi_handle(vpiStmt, statement), scope, depth + 1);
        break;
    }
}

static void watch_statement_scope(const char *scope) {
    if (!*scope || !valid_path(scope)) {
        recording_failed("invalid assignment scope", scope);
        return;
    }
    for (size_t index = 0; index < statement_scope_count; ++index)
        if (!strcmp(scope, statement_scopes[index])) return;
    if (statement_scope_count == MAX_STATEMENT_SCOPES) {
        recording_failed("assignment scope selection exceeds the callback budget", scope);
        return;
    }
    statement_scopes[statement_scope_count++] = scope;
    vpiHandle object = vpi_handle_by_name((PLI_BYTE8 *)scope, NULL);
    if (!object || vpi_get(vpiType, object) != vpiModule) {
        recording_failed("module instance unavailable for assignment capture", scope);
        return;
    }
    const size_t previous = statement_count;
    vpiHandle iterator = vpi_iterate(vpiProcess, object);
    if (iterator) {
        vpiHandle process;
        while ((process = vpi_scan(iterator)))
            visit_statement(vpi_handle(vpiStmt, process), scope, 0);
    }
    if (statement_count == previous)
        recording_failed("no supported procedural assignments in", scope);
}

static int write_recording_header(void) {
    if (fprintf(recording, "{\"type\":\"vpi-capture\",\"timePrecision\":%d,",
                time_precision) < 0)
        return 0;
#ifdef WAVE_WORKBENCH_VCS_PROBES
    if (dpi_execution && fprintf(recording,
            "\"dpiExecutionEvents\":true,\"probeMapSha256\":\"%s\",",
            WAVE_WORKBENCH_PROBES_SHA256) < 0)
        return 0;
#endif
    if (fprintf(recording, "\"observationCoverage\":{\"start\":\"%" PRIu64
                "\",\"signals\":[", tick()) < 0)
        return 0;
    for (size_t index = 0; index < watch_count; ++index) {
        const struct Watch *watch = &watches[index];
        if (fprintf(recording, "%s{\"instance\":\"%.*s\",\"signal\":\"%s\"}",
                    index ? "," : "", (int)(watch->signal - watch->path - 1),
                    watch->path, watch->signal) < 0)
            return 0;
    }
    return fputs("]}}\n", recording) != EOF;
}

static PLI_INT32 on_start(p_cb_data callback) {
    (void)callback;
    static const char output_arg[] = "+wave_execution_events=";
    static const char watch_arg[] = "+wave_watch=";
    static const char scope_arg[] = "+wave_statement_scope=";
    const char *live_mode = getenv("WAVE_WORKBENCH_VPI_LIVE");
    live = live_mode && !strcmp(live_mode, "1");
    s_vpi_vlog_info info;
    if (!vpi_get_vlog_info(&info)) {
        recording_failed("simulator arguments unavailable", "");
        return 0;
    }
    const char *output = NULL;
    for (int index = 0; index < info.argc; ++index)
        if (!strncmp(info.argv[index], output_arg, sizeof(output_arg) - 1))
            output = info.argv[index] + sizeof(output_arg) - 1;
    if (!output && !live) return 0;
#ifdef WAVE_WORKBENCH_VCS_PROBES
    dpi_execution = 1;
#endif
    time_precision = vpi_get(vpiTimePrecision, NULL);
    if (output) {
        recording = fopen(output, "wx");
        if (!recording) {
            recording_failed("cannot create recording", output);
            return 0;
        }
    }
    s_cb_data finish = { .reason = cbEndOfSimulation, .cb_rtn = on_end };
    if (!vpi_register_cb(&finish)) {
        recording_failed("completion callback unavailable", "");
        return on_end(NULL);
    }
    for (int index = 0; index < info.argc; ++index) {
        if (!strncmp(info.argv[index], watch_arg, sizeof(watch_arg) - 1) &&
            !watch_signal(info.argv[index] + sizeof(watch_arg) - 1))
            return 0;
    }
    if (!watch_count) {
        recording_failed("select at least one +wave_watch signal", "");
        return 0;
    }
    for (int index = 0; index < info.argc && !failed; ++index)
        if (!strncmp(info.argv[index], scope_arg, sizeof(scope_arg) - 1))
            watch_statement_scope(info.argv[index] + sizeof(scope_arg) - 1);
    if (failed) return 0;
#ifdef WAVE_WORKBENCH_VCS_NBA_TAGS
    if (!register_nba_targets()) return 0;
#endif
    if (recording && !write_recording_header()) {
        recording_failed("cannot write recording header", output);
        return 0;
    }
    ready = 1;
    if (live) {
        if (time_precision < -15 || time_precision > 0)
            recording_failed("unsupported simulation time precision", "");
        else
            on_next_slot(NULL);
    }
    return 0;
}

void wave_workbench_register_vpi(void) {
    s_cb_data start = { .reason = cbStartOfSimulation, .cb_rtn = on_start };
    vpi_register_cb(&start);
}

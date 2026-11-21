// SPDX-License-Identifier: MPL-2.0
#pragma once

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

struct WaveWorkbenchPliStep {
    const char *statement;
    const char *operation;
    const char *value;
};

/* Call immediately before and after one synchronous write to the mapped signal. */
uint64_t wave_workbench_pli_evaluate(const char *site, const char *value,
                                     const char *operands,
                                     const struct WaveWorkbenchPliStep *steps,
                                     size_t count);
void wave_workbench_pli_complete(const char *site, uint64_t token, int succeeded);

#ifdef __cplusplus
}
#endif

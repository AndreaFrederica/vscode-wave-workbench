#include "veriuser.h"
#include "vcs_pli_execution.h"

int wb_drive(int data, int reason) {
    (void)data;
    (void)reason;
    const int value = tf_getp(2);
    const char *bits = value ? "1" : "0";
    const struct WaveWorkbenchPliStep steps[] = {
        {"read-input", "tf_getp(2)", bits},
        {"write-target", "tf_putp(1)", bits},
    };
    const uint64_t event = wave_workbench_pli_evaluate(
        "drive", bits, value ? "input_value=1" : "input_value=0", steps, 2);
    const int result = tf_putp(1, value);
    wave_workbench_pli_complete("drive", event, result == 0);
    return result;
}

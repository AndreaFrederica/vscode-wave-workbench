# Decoder benchmark

Linux 4.18.0-553.el8_10.x86_64 · x64 · AMD EPYC 7K62 48-Core Processor

v24.14.0 · V8 13.6.233.17-node.41 · LuaJIT 2.1 via mlua 0.12.2 built with Cargo --release

All three engines produced the same transaction list before timing was reported.
The engine metric measures the script call and its event API. Boundary is the remaining measured batch time, including preparation, validation and Worker messages or Lua IPC. E2E includes reading the VCD through the Rust backend.
The Builtin engine runs in the measuring process and reports its batch time as engine time.
Each row has 3 measured runs after 1 warm-up. E2E opens a fresh scheduler while native waveform caching is shared within each dataset.
The engine workload is a stateful 8-bit word rule. Child-process RSS and additional protocol workloads are pending.

The 10 million event rows use two measured runs after one warm-up. The remaining rows use three measured runs. Each run records its revision, worktree status, toolchain, seed and dataset hash in the [JSON report](results.json).

| Events | Engine | Startup p50 ms | Engine p50 ms | Boundary p50 ms | E2E p50 ms | Cache p50 ms | Events/s |
|---:|---|---:|---:|---:|---:|---:|---:|
| 10000 | builtin | 0.034 | 11.101 | 0 | 57.947 | 0.179 | 900820 |
| 10000 | lua | 4.891 | 0.648 | 50.742 | 100.262 | 0.208 | 194628 |
| 10000 | javascript | 50.88 | 16.261 | 0.717 | 91.761 | 0.187 | 588963 |
| 100000 | builtin | 0.023 | 70.337 | 0 | 587.892 | 0.48 | 1421727 |
| 100000 | lua | 6.269 | 6.201 | 477.183 | 811.073 | 0.835 | 206920 |
| 100000 | javascript | 51.617 | 115.68 | 4.339 | 505.931 | 1.186 | 833194 |
| 1000000 | builtin | 0.018 | 698.363 | 0 | 5833.839 | 4.103 | 1431920 |
| 1000000 | lua | 7.865 | 66.859 | 4712.023 | 8913.843 | 4.122 | 209270 |
| 1000000 | javascript | 48.779 | 1070.078 | 34.791 | 5704.771 | 4.401 | 904059 |
| 10000000 | builtin | 0.071 | 6733.1 | 0 | N/A | N/A | 1485200 |
| 10000000 | lua | 12.219 | 613.003 | 47448.637 | N/A | N/A | 208066 |
| 10000000 | javascript | 43.04 | 10334.598 | 355.056 | N/A | N/A | 935484 |

## Transaction row layout

Chromium 159.0.8154.6 with 15 runs after one warm-up at each size. Measures the UI message handler, transaction DOM replacement and forced layout in the same document.

| Transactions | p50 ms | p95 ms | p99 ms |
|---:|---:|---:|---:|
| 32 | 0.9 | 1.0 | 1.0 |
| 512 | 5.5 | 12.8 | 12.8 |
| 2048 | 26.1 | 40.3 | 40.3 |

## Binary event batches

The before and after runs use the same one-million-event VCD. Each run compares all 3,892 transactions across the three engines. Each median comes from three measured runs after one warm-up. Builtin and V8 read the column buffers directly. Lua receives the columns through the subprocess pipe. The [JSON report](results.json) records the dataset checksum and timings.

| Engine | Batch before, ms | Batch after, ms | E2E before, ms | E2E after, ms |
|---|---:|---:|---:|---:|
| builtin | 671.9 | 665.1 | 5751.9 | 5898.3 |
| lua | 4787.3 | 4516.9 | 8426.6 | 8296.3 |
| javascript | 1096.1 | 1100.6 | 5657.3 | 5762.7 |

With binary input, reading the columns and building Lua event tables inside the native process took 4,426.3 ms. Calling the Lua script took 59.3 ms. The measured batch time fell by 5.6%.

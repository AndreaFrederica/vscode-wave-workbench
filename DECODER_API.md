# Wave Workbench 解码器扩展 API

## 加载扩展

把 [Lua 与 JavaScript/TypeScript 示例](examples/wave-decoders) 放在可信工作区的 `wave-decoders/` 下。每个扩展拥有独立目录，包含 `decoder.json` 和入口脚本。也可以使用 `.vscode/wave-decoders/`。旧 JSON profile 继续从 `.vscode/wave-decoders/*.json` 和 `.vscode/wave-decoders.json` 读取。

用 **解码 → 管理脚本解码器** 新建、复制、编辑清单和入口，或将整个包移入回收站。脚本文件保存后会刷新当前工作区已加载的事务行。手动刷新可用每行的重载按钮。

从波形工具栏选 **解码 → 配置事务解码器**，为每个输入填入波形信号路径。可配置至多四条事务行。鼠标停留时显示事务字段，点击标签把 A 游标移到可见事务起点。PNG 与 JSON 截图可包含已配置的事务行。保存波形工程即可恢复解码器绑定和参数。

## Manifest 和脚本

```json
{
  "apiVersion": 1,
  "id": "example.spi",
  "name": "SPI",
  "version": "1",
  "engine": "javascript",
  "entry": "main.cjs",
  "inputs": [
    { "id": "clock", "width": 1 },
    { "id": "mosi", "width": 1 },
    { "id": "cs", "width": 1 }
  ],
  "options": { "cpol": 0, "cpha": 0 },
  "capabilities": { "checkpoints": true }
}
```

JavaScript 模块通过 CommonJS 导出解码器对象，也接受构建器生成的默认导出。TypeScript 在扩展发布之前用仓库的 esbuild 转换。用户安装已构建的解码器包时可直接使用 JavaScript 入口。

```sh
npx --no-install esbuild main.ts --format=cjs --outfile=main.cjs
```

Lua 入口返回 Lua 表。JS 与 Lua 都可定义同步的 `init(ctx)`、`decode(ctx, state, batch)` 和 `flush(ctx, state)`。批次包括 `start`、`end` 和各输入作用的初始值数组 `initial`。JS 通过 `batch.events()` 访问事件，Lua 通过 `ipairs(batch.events)` 访问。输入编号从 0 开始，按 manifest 排序。每条记录含十进制字符串 `tick`、输入编号 `input`、四态位串 `value`。同一输入在同一 tick 内保留读取器提供的相对顺序。跨输入按声明顺序合并，同 tick 跨输入的调度次序由源波形的证据决定。

`ctx.scale` 为原始时基，`ctx.getOption(name)` 和 `ctx.getInput(name)` 提供配置。通过 `ctx.emit(transaction)` 写入 `start`、`end`、`label` 及可选 `kind`、`fields`、`severity`。时间使用半开区间。解码器可报告诊断。多输入同 tick 的协议可以在一次批次中先汇总该 tick 的输入，再处理边沿，示例 SPI 使用了此方式。

检查点只保存显式状态。JS 实现 `saveState(state)`、`restoreState(data)`，Lua 使用 `save_state(state)`、`restore_state(data)`。保存的数据为最多 64 KiB 的 JSON，可包含尚未结束的事务。脚本应在实际结束后才发出对应事务。

## 虚拟信号

在 manifest 的 `capabilities` 声明 `"virtualSignals": true`。JS 与 Lua 可以调用 `ctx.emitVirtualSample(id, width, tick, value)`，其中 `tick` 是当前批次内的十进制 tick，`value` 是与位宽匹配的四态字符串。同名输出的位宽需保持一致。查询结果通过 `virtualSamples` 字段返回区间内采样。

从解码行点 **生成虚拟信号** 可针对整段波形计算，选择一个输出并加入原有虚拟信号行。工程保存用户主动生成的虚拟信号采样快照。重新生成可取得当前脚本与绑定的结果。未生成的事务和采样通过缓存或复算恢复。

## 查询

MCP 的 `wave_decoder_list` 查询可用扩展，`wave_decoder_query` 接收 `decoderId`、`bindings`、`start`、`end` 及可选 `options` 和 `waveform`。已打开波形可通过 `wave_decoder_attach` 添加事务行。通过 `wave_decoder_status` 查看实例 ID，用 `wave_decoder_reload` 或 `wave_decoder_detach` 操作指定实例或最后配置的事务行。

```tcl
waveDecodeTransactions example.lua.word {{"data":"tb.data"}} 3 5
```

Tcl 的批量查询与 MCP、波形 UI 共用宿主调度器。当前设计会重放到波形末尾以发现跨窗口结束的事务，缓存同一波形、绑定、脚本版本和窗口的完整结果。

## 运行条件和边界

仅在可信工作区发现和运行脚本扩展。JavaScript 在独立 Worker 内执行，LuaJIT 在独立原生子进程内执行。资源限制和终止机制用于故障恢复。两个运行边界都以可信代码为适用范围。初始实现按请求限制并发、15 秒运行时间和一百万条重放事件，结果超过事务预算时会明确标注截断。内置 UART 用旧算法，并继续使用可安全表示的整数 tick。

## 实数输入

在 manifest 的对应输入项设置 `"real": true`，并绑定实数信号。采样事件的 `real` 字段携带数值，缺样在 JS 中为 `null`，在 Lua 中为 `nil`。`batch.initialReal` 提供各输入的初始实数值。数字事件的 `value` 字段继续使用四态字符串。实数批次的值列使用小端序 `float64`，数字输入保留原有编码。

## 二进制事件批次

Builtin、V8 Worker 和 LuaJIT 共用版本 2 的列式事件批次。批次按顺序携带时间列、输入编号列、值偏移列与四态值字节。输入编号和偏移为小端序 `u32`。时间使用小端序 `u64`，超过其范围的批次使用逐条带长度的十进制字节串。

Builtin 在宿主内读取列缓冲，Worker 转移底层 `ArrayBuffer`，LuaJIT 子进程读取 JSON 批次头后的定长二进制列。批次头记录窗口、初值、版本与列长度。Lua 事务、诊断和生命周期消息使用 JSON，脚本仍通过各自的事件 API 读取时间和四态值。

## 性能复现

本机安装了 Cargo 与 Node 依赖后，构建原生二进制，再通过同一条命令运行可重现的三个引擎。结果保存为 JSON 和 Markdown。

```sh
cargo build --locked --release --manifest-path native/Cargo.toml
WAVE_TEST_DECODER_BINARY="$PWD/native/target/release/wave-backend" WAVE_DECODER_BENCH_OUTPUT=/tmp/wave-decoder-bench npm run bench:decoders
WAVE_TEST_DECODER_BINARY="$PWD/native/target/release/wave-backend" WAVE_DECODER_BENCH_SIZES=10000000 WAVE_DECODER_BENCH_REPEATS=2 WAVE_DECODER_BENCH_OUTPUT=/tmp/wave-decoder-bench-10m npm run bench:decoders
WAVE_DECODER_UI_REPORT=/tmp/wave-decoder-ui.json npm run test:ui -- -g 'transaction rows accept'
```

详见 [实施计划](DECODER_PLAN.md)、[检查 TODO](CHECK_TODO.md) 和 [基准报告](benchmarks/decoders/results/results.md)。

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

## AXI4 和 TL-UL 事务调试

在波形窗口的解码器菜单中选择“配置事务解码器”。`amba.axi4` 读取 AXI4 memory-mapped 五通道信号。选择接口 scope 后检查自动生成的 JSON 绑定。每个方向的请求与响应 ID 宽度应一致。时钟和低有效复位分别绑定到 `aclk` 和 `aresetn`。省略可选数据或 sideband 引脚会使相应字段缺席。`opentitan.tlul` 接受 RV32 OpenTitan 的时钟、低有效复位和 packed H2D / D2H。

AXI4 地址握手、数据 beat 和响应记录在同一笔事务的 `points` 中，每个点带有 `tick`、`channel`、`label` 和采样字段。握手使用时钟上升沿前的值。时间区间采用半开边界，最后一次握手的 tick 可直接从对应点取得。绑定 SIZE 和 BURST 后，数据 beat 的 address 根据起始地址和 burst 类型推导。事务中断时可以检查 `status`，未完成的 W 数据可能缺少地址。

在事务列表中输入 `kind=Read id=3`、`r.resp=SLVERR` 或 `d_error=1` 可筛选当前窗口。多个空格分隔条件取交集，逐拍条件分别匹配整笔事务中的任一拍。点击握手或 beat 跳转到原始信号。附加解码器后，左侧协议浏览器按接口、事务类型和 ID 或 source 展开当前窗口的事务。点选树中或时间轴上的事务，右侧常驻详情面板同步显示该接口的字段与握手。左上角可切回波形目录。勾选字段可将它显示在时间轴上。

内置总线解码器按需向前读取并缓存已完成事务和仍在途的状态。跨窗口事务会跟踪到结束、复位或记录末尾。明细超出返回预算时，时间轴显示分桶计数，按事务在视窗内的起点归桶。错误和警告使用不同颜色，点击桶可以放大。过滤在索引上执行，可以找到明细截断位置之后的匹配项。

## 协议树、轨道和信号组

在“视图”菜单可分别将协议浏览器和事务详情设为展开、折叠或隐藏，也可设置事务轨道显示、停靠位置、接口独立滚动和全部轨道置顶。点击面板标题可原地折叠或展开；隐藏后可从“视图”重新打开。每条轨道的“⋯”菜单可指定该树的停靠位置，或将轨道固定在已显示的信号、信号组下方。多条轨道可选同一位置。取消全部置顶后恢复各自的固定位置。组菜单可在当前组下创建子组，父组折叠时同时收起子组和固定轨道。保存波形工程会记录分组关系、轨道位置和协议布局。

为单根信号设置值或 UART 解码规则后，查看器会用该规则和同一套事务运行时生成对应的树和轨道，默认排在信号下方。单值标签在原始波形上也可直接读取。多输入 Lua、JavaScript 和内置协议实例通过同一事务结果接口绘制。

拖动信号名行的下边缘，或在“视图”中输入当前信号行高，可覆盖全局行高。清空数值恢复跟随全局。解码轨道可在“⋯”中设置每条事务子行的高度。上述高度随波形工程保存。平移和缩放时，解码轨道可直接复用已完整覆盖的窗口；查询会同时读取两侧各半个窗口的事务。若宽窗口明细截断，则按当前视窗重新查询。

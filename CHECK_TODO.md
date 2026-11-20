# Wave Workbench 检查 TODO

[当前实现目标](IMPLEMENTATION_GOAL.md) 优先交付模拟波形和原理图。此清单记录验收、复核与需要实际环境的检查。功能实施见 [多引擎解码器计划](DECODER_PLAN.md) 与 [RTL Trace 实施计划](RTL_TRACE_PLAN.md)。

## 多引擎解码器

- [x] 记录开发前基线。Node 75 通过、59 跳过。Rust 9 通过、1 忽略。Playwright 25 通过、5 跳过。
- [x] 运行合并工作区的 Node 测试。82 通过、59 跳过。隔离阶段快照通过 Node 24 项、Rust 10 项、Playwright 26 项，分别跳过或忽略 8、1、5 项。
- [x] 核对旧 JSON 显示、UART、旧工程、虚拟信号恢复。对真实 VCD/FST 样本核对 Lua 和 JS 事务，并对 OpenTitan FSDB 的八路信号核对结果。原有独立 KDB 的层次、定义和 FSDB 关联测试通过。
- [x] 真实 VCD 三引擎结果一致。覆盖跨窗口事务、检查点、宽四态值和大于 u64 的列式时间。Lua 与 JS 同一 SPI fixture 覆盖四种 CPOL/CPHA、同 tick 输入与检查点恢复。
- [x] 在 Linux 桌面 VS Code 验证安装版 Lua/JS 查询、MCP 多实例、Tcl、JSON 和 PNG 及工程恢复。浏览器回归覆盖相同窗口恢复、缩放、取消和拒收旧结果。重命名并恢复清单会触发实际事务行失效和热重载。Native/Node 集成覆盖 Lua/JS 输出虚拟信号及工程快照恢复。
- [x] 测试 JS Worker 和 Lua 子进程的无限循环取消及新实例恢复。脚本管理测试核对重复包和路径边界。
- [x] 保存三引擎、四种事件规模和浏览器事务布局的 [基准报告](benchmarks/decoders/results/results.md)。一百万条以上的生产端到端为 N/A，仍实测引擎及其数据边界。
- [ ] 补做截断及单 tick 极大批次、波形源重新加载、错误检查点和权限回归。
- [ ] 扩展等价语义检验与性能矩阵，覆盖 UART 脚本、I²C、AXI 和 TileLink 的请求响应关联、宽总线与大量实例。补测纯 IPC、热循环、内存和取消分位数。
- [ ] 检查递归、内存与输出激增、畸形缓冲、脚本文件/网络权限以及并发状态。脚本执行范围限可信工作区。
- [ ] 复核 Linux arm64、macOS x64/arm64、Windows x64/arm64 的 Cargo、VSIX 产物及安装运行。补齐相应环境的 RTL、FSDB 和 KDB 回归。

## RTL Trace

- [x] 在 Linux VS Code 和静默后台以单个 Verilator 信号验证自动遍历、预算续查、`frontier` / `queryFailures` 分页及详细报告。用真实 VCD 核对 161 条静态赋值与 323 个时间节点，用 FST 和执行日志核对在线、离线写入归因一致。
- [ ] 复核 Linux VS Code 的 Trace Explorer 与 MCP 结果、报告和分页续查在同一根信号上保持一致。原验证见计划表。
- [x] 验证 VCS 同槽三次重叠 modport 求值。VCD、恢复槽内变化后的 FSDB、在线 MCP 及 VS Code 报告对五次物理值变化返回相同的求值序号。回归覆盖缺失回调时保留兼容组件。
- [ ] 复核不同调度器、复杂左值与合并更新中的实际物理提交。重叠 modport 探针仍记录物理提交为 `assignment-unobserved`。
- [x] 复跑 Linux 的 Tcl、VCD 读取与 MCP 传输冒烟，并用 Wine 6 的 Windows x64 Node 核对新版 MCP 命名管道。
- [x] 使用 Linux x64 的实际 VSIX 安装 Wave Workbench 0.9.23 和修改版 VIDE 1.3.0，验证 VCD 与 FST 的静态追踪、时间图、报告分页及源码跳转。解包目录中的静默 MCP 通过打开 VCD、截取精确事件及 Tcl 查询的冒烟测试。
- [ ] 核对新版 VSIX 在 macOS 和 Windows 的桌面运行。GitHub 的 Linux、macOS x64 和 arm64 基线已通过原生打包，Windows 包装需复验 Tcl 源码档案版本清单修复。
- [ ] 逐项核对 RTL Trace 尚未验收的测试、性能预算、通用调度器和缺口。保留原计划及其未勾选事项。

## 模拟波形与混合信号解码

- [x] 从同一次 VCS 仿真生成实数 VCD 和 FSDB，再转换成 FST。四条读取路径均能列出实数变量并读出数字对照信号，当前实数查询返回不支持。
- [x] 用同源 VCS 实测 VCD、FST 和 Verdi SDK FSDB 的四个实数样点。Node 同时核对数字与实数查询和 LuaJIT/V8 混合采样事务。
- [x] 浏览器验证实数与数字同屏、A 游标、Tcl 统计及原理图布局与交叉操作消息。桌面 VS Code 同一宿主通过 MCP 核对原理图节点、连线、源码与实数裁剪。
- [ ] 对照源文件核对各格式的实数初始值、负数、指数写法、同 tick、缺样、非均匀时间和单位。覆盖同名但不同类型的信号及数字回归。
- [ ] 在真实 VS Code 验证数字与实数同屏、游标、区间测量、尖峰保留、工程恢复及 PNG、CSV、JSON、MCP/Tcl 结果一致。
- [ ] 对照 Builtin、LuaJIT 和 V8 的阈值、滞回、ADC 采样结果。检查缺样、插值、跨批次与随机窗口边界。
- [ ] 使用真实 RNM、AMS 或 SPICE 产物核对原理图联动、连续时间精度和各格式的实际覆盖。实施见 [模拟波形计划](ANALOG_WAVE_PLAN.md)。

- [x] 独立 FSDB 与 VCD 逐点对照两个实数信号和数字信号，使用 testbench 与 Verdi SDK 核对 `shortreal`。回归覆盖窗口初值、截断及超过 32 位的 tick。
- [x] 浏览器核对原理图从选中信号展开上游、返回与刷新 A 游标消息。重复布局时核对节点数量。

## RTL 模块原理图

- [x] 核对 Verilator 展开的实例、generate 层级、真实端口引用、总线切片、常量、未接端口和模块内过程的读写关系。
- [x] 用 OpenTitan 工作区的 CV32E40P 仿真展开树核对顶层和 `dut` 的模块图。在 VS Code 1.124.2 验证进入 `dut`、返回父模块和跳到实例源码。
- [ ] 扩展复杂端口表达式和 SystemVerilog interface/modport，并验证大规模模块的布局和网线定位。
- [x] 用真实 VCS KDB 分别验证独立后端和 Verdi NPI 读取实例数组、端口方向、切片及常量。在 VS Code 1.124.2 从 FSDB 打开 KDB 模块图，确认实例下钻、返回和将总线加入波形。
- [ ] 扩展 KDB 模块内部的行为逻辑、综合网表的模块及器件层视图，以及直接从 RTL 自动生成。

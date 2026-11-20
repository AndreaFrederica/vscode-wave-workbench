# Wave Workbench 检查 TODO

功能实现优先。此清单记录验收、复核与需要实际环境的检查。功能实施见 [多引擎解码器计划](DECODER_PLAN.md) 与 [RTL Trace 实施计划](RTL_TRACE_PLAN.md)。

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

- [ ] 复核 Linux VS Code 的 Trace Explorer 与 MCP 结果、报告和分页续查在同一根信号上保持一致。原验证见计划表。
- [ ] 验证 VCS 同一时间槽内多次 modport 求值与物理写入逐次对应，复核复杂左值和合并更新的调度证据。
- [ ] 核对新版 VSIX 的 macOS/Windows 原生运行、MCP 传输及包装验证。
- [ ] 逐项核对 RTL Trace 尚未验收的测试、性能预算、通用调度器和缺口。保留原计划及其未勾选事项。

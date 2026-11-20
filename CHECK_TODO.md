# Wave Workbench 检查 TODO

功能实现优先。此清单记录验收、复核与需要实际环境的检查。功能实施见 [多引擎解码器计划](DECODER_PLAN.md) 与 [RTL Trace 实施计划](RTL_TRACE_PLAN.md)。

## 多引擎解码器

- [x] 记录开发前 Node 基线，75 通过、59 跳过。
- [x] 记录开发前 Rust 基线，9 通过、1 忽略。
- [ ] 记录前后 Playwright 基线及差异，复核真实 VS Code。
- [ ] 逐项核对 JSON 规则、UART、旧工程、虚拟信号及 FSDB/VCD/FST/KDB、RTL、MCP、Tcl 的兼容性。
- [ ] 在三引擎比对语义结果。覆盖 1 bit、宽总线、X/Z、超过 u64 的时间、同 tick、截断与多批次。
- [ ] 覆盖 UART、SPI 的 CPOL/CPHA、I²C、AXI 并发及 TileLink 关联。核对随机跳转、窗口边界、未闭合事务、检查点恢复、源码修改和缓存失效。
- [ ] 核对 UI、导出、工程恢复与 MCP/Tcl 使用同一结果。检查脚本热重载、多实例、取消和恢复。
- [ ] 检查脚本超时、递归、内存与输出激增、路径边界和信任模式、销毁后回复、Worker/Native 退出及并发状态。
- [ ] 发布 JSON/Markdown 基准，核对数据哈希、引擎版本、提交、冷/热、IPC、UI、资源用量与 N/A，复现全部规模及场景。
- [ ] 复核六种支持平台的 Cargo/VSIX 产物与实际运行。验证工作区信任和不可信脚本限制。

## RTL Trace

- [ ] 复核 Linux VS Code 的 Trace Explorer 与 MCP 结果、报告和分页续查在同一根信号上保持一致。原验证见计划表。
- [ ] 验证 VCS 同一时间槽内多次 modport 求值与物理写入逐次对应，复核复杂左值和合并更新的调度证据。
- [ ] 核对新版 VSIX 的 macOS/Windows 原生运行、MCP 传输及包装验证。
- [ ] 逐项核对 RTL Trace 尚未验收的测试、性能预算、通用调度器和缺口。保留原计划及其未勾选事项。

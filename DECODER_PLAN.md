# Wave Workbench 多引擎解码器实施计划

当前开发优先级是多引擎解码器。RTL Trace 的待检查项见 [检查 TODO](CHECK_TODO.md)。阶段验收证据也记录在该清单。

## 现状审计

- 本地基线为 `main` 的 `3f103622d1a62f16d17521862d3c0dda1f06759f`，索引为空，工作树已有 74 项 RTL Trace 编辑或新增路径。新增解码器使用独立模块，公共入口按需接线。
- `decodeWord` 为规则优先的单值格式化，调用方包括 Canvas / 悬停、图像导出、Tcl 命令和宿主编辑器文档。 `decodeRuleValue` 由单值与 `uartFrameLabel` 共享。UART 使用 `decodeUart` 对带时基的事件计算帧及错误标签，现有标签和优先级构成兼容基线。
- 内置规则由 `decoders/` 和 `src/shared/decoders.ts` 载入。工作区规则从 `.vscode/wave-decoders/*.json` 和旧 `.vscode/wave-decoders.json` 按优先级载入，沿用版本 1。信号样式携带 profile，工程恢复会按规范信号身份重建并重新注册原生虚拟依赖。
- 原生读取器以逐行 JSON 接收最多 64 路波形及每路事件预算，返回十进制时间、初值与截断。VCD/FST 提供同 tick 顺序历史，FSDB 可能合并变化，KDB 提供设计元数据。独立读取器和 Verdi 读取器共享查询缓存；可复用既有读取与信号映射。
- 构建使用 esbuild 和 Cargo。CI 在 Linux 检查类型、原生、Node、Playwright 和 VSIX。发布矩阵覆盖 Linux、macOS、Windows 各 x64/arm64。此次基线环境为 Linux x86_64、Node 24.14.0、Rust 1.100.0。
- 修改前 `npm test` 通过 75 项并跳过 59 项可选环境用例。 `cargo test --locked` 通过 9 项并跳过 1 项 LZO 用例。浏览器基线另记于检查清单。

## 数据与执行契约

引擎 ID 为 `builtin`、`lua`、`javascript`。版本 1 脚本 manifest 独立校验，绑定保存实例 ID、解码器定义、参数及信号身份。以半开窗口 `[start, end)` 查询，十进制字符串保留外部时间和大于 u64 的时间。保留四态值、初始值和位宽。列式缓冲包含时间、输入索引、值偏移和值字节。相同 tick 保留同一输入记录的顺序，跨输入以绑定顺序稳定合并。同 tick 的跨输入顺序只代表交付顺序。

同一实例按时间串行执行。结果包含事务、诊断及完整性。结果存储保留跨边界事务，统一供界面、MCP 和 Tcl 查询。随机窗口可从检查点或波形起点重放。缓存轴包含波形、代码、参数、绑定和版本。

JavaScript 使用宿主 Node V8 的 Worker。TypeScript 由 esbuild 生成可分发 JavaScript。LuaJIT 使用 Rust/mlua 的独立子进程模式。脚本仅在可信工作区启用，生命周期设置取消、超时和容量限制。第三方不可信执行的系统级隔离列入后续验收。

## 实施 TODO

- [x] Phase 0，审计真实代码、版本、查询和发布流程，取得 Node、Rust 基线。
- [ ] Phase 1，完成版本化 manifest、Registry、绑定、事件批次、统一输出和 BuiltinAdapter。保留旧 JSON 快速路径。
- [ ] Phase 2，接入 mlua 和 LuaJIT、状态生命周期、示例和子进程故障恢复。
- [ ] Phase 3，接入 V8 Worker、可转移列缓冲、JS/TS 构建、装载、示例和诊断。
- [ ] Phase 4，完成跨批次与跨界事务、随机重放、检查点、缓存、取消及源更新失效。
- [ ] Phase 5，完成脚本管理和多路绑定、事务行和导出、虚拟信号、项目恢复、MCP 与 Tcl。
- [ ] Phase 6，检验等价结果后运行三引擎基准。区分 Micro、Engine、E2E 与 UI，覆盖定种子 UART、SPI、I²C、AXI/TL-UL、宽总线和并发实例，测量 1 万到 1000 万事件及内存、延迟和取消。
- [ ] Phase 7，跨平台构建和真实 VSIX 运行、可靠性与权限验证、扩展 API、使用示例、性能报告和发布说明。

最终验收关注完整 Lua/JS/TS 生命周期及随机访问等价、旧 JSON 与现有 FSDB/VCD/FST/KDB/RTL/MCP/Tcl/工程恢复兼容性。需用仓库实测证据记录运行限制和优化项。

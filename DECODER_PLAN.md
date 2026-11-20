# Wave Workbench 多引擎解码器实施计划

[当前实现目标](IMPLEMENTATION_GOAL.md) 优先交付模拟波形和原理图。RTL Trace 的待检查项见 [检查 TODO](CHECK_TODO.md)。阶段验收证据也记录在该清单。实数输入、混合信号解码和派生波形见 [模拟波形计划](ANALOG_WAVE_PLAN.md)。

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

- [x] Phase 0，审计真实代码、版本、查询和发布流程，取得 Node、Rust、Playwright 基线。
- [x] Phase 1，完成版本化 manifest、Registry、绑定、事件批次、统一输出和 BuiltinAdapter。旧 JSON 规则保留原调用路径。
- [x] Phase 2，接入 mlua 和 LuaJIT 独立子进程、状态生命周期、示例、取消及故障恢复。
- [x] Phase 3，接入 Node V8 Worker、可转移缓冲、JavaScript、TypeScript 构建示例、批量执行与诊断。
- [x] Phase 4，完成跨批次及跨窗口事务、随机重放、检查点回退、原始事件缓存、结果缓存和按源码哈希失效。超过一百万事件的单次重放会报出明确诊断。
- [x] Phase 5，完成脚本管理、多路绑定、独立事务行、PNG/JSON 导出、四态虚拟信号快照、工程恢复、MCP 与 Tcl。
- [ ] Phase 6，完成全协议及并发性能矩阵。
  - [x] 三引擎八位规则输出逐条比较，测量 1 万、10 万、100 万和 1000 万条事件。
  - [x] 记录 VM 启动加首次调用、脚本执行与宿主边界、端到端、缓存和浏览器事务 DOM 布局的时延。保存 JSON/Markdown 实测结果。
  - [ ] 补齐 UART、SPI、I²C、AXI/TL-UL、宽总线及并发实例负载的可复现性能数据。引擎缺少等价功能的项目标记 N/A。
  - [x] 三引擎共用版本化二进制批次。百万事件对照测量 Lua 的批次处理以及原生读列和建表耗时。
  - [ ] 单独测量编译、紧凑 Lua 事件访问、传输、子进程资源用量、取消响应及峰值 RSS。
- [ ] Phase 7，完成发布矩阵、可靠性与权限验收。
  - [x] Linux x64 独立 VSIX 构建及桌面 VS Code 测试。提供扩展 API 和 Lua/JS/TS 示例。
  - [ ] 完成 Linux arm64、macOS 和 Windows 原生构建与已安装扩展运行。完成剩余安全和兼容验证。

阶段提交见本地 Git 历史。类型定义与实现位于 [decoder-runtime](src/decoder-runtime)，LuaJIT 子进程入口位于 [native/src/decoder.rs](native/src/decoder.rs)，安装和接口由 [扩展 API](DECODER_API.md) 说明。独立检查项与实测证据见 [检查 TODO](CHECK_TODO.md)。

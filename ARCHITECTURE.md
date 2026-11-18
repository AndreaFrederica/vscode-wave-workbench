# Wave Workbench 实现结构

扩展宿主、Tcl 命令适配和 Webview 源码使用 TypeScript。FSDB 和 KDB 由 Rust 独立实现和 Verdi SDK 提供两条读取路径，共用逐行 JSON 协议。

| 路径 | 职责 |
| --- | --- |
| `src/extension.ts` | 扩展激活、VS Code 命令、编辑器布局、RTL 双向定位 |
| `src/wave-editor.ts` | 波形编辑器会话、Webview 消息、后端切换 |
| `src/wave-documents.ts` | 波形工程文档的打开、保存、备份与恢复 |
| `src/backend-selection.ts` | 为 FSDB、KDB 和 VCD 选择并启动对应后端 |
| `src/viewer.ts` | 波形编辑器会话类型 |
| `src/backend.ts` | 子进程生命周期、请求编号、超时与行分隔 JSON 协议 |
| `src/kdb.ts` | 独立 KDB 会话、层次与源位置缓存 |
| `src/commands.ts`、`src/tcl.ts` | nWave 命令适配与 Tcl 子进程 |
| `src/rtl-selection.ts`、`src/source-sync.ts` | RTL 批量信号提取与实例跟随 |
| `src/view-state.ts` | 保存状态验证、虚拟依赖注册及规范信号恢复 |
| `src/shared/protocol.ts` | 信号、位投影、标记、波形块、保存状态及后端请求/结果类型 |
| `src/shared/signals.ts` | 宿主和浏览器共用的信号身份、标签、位投影及样式恢复 |
| `src/webview/wave.ts` | 波形 Canvas、虚拟列表、操作菜单、分组、标记和悬停 |
| `src/webview/sidebar.ts`、`src/webview/dom.ts` | 侧边栏交互及按元素 ID 推导 DOM 类型 |
| `media/` | HTML、CSS、SVG 静态资源 |
| `src/tcl/bridge.tcl` | Tcl 运行时桥，构建时复制到 `dist/tcl/` |
| `native/src/independent/fsdb/` | FSDB 声明、值页、索引、波形事件和连接求值 |
| `native/src/independent/kdb/` | KDB 归档、设计层次、信号声明和 RTL 来源 |
| `native/src/main.rs` | 两套后端的协议入口、波形查询、缓存和虚拟信号 |

原先相互依赖全局变量的波形和工作流脚本合为一个浏览器入口，共享工具通过模块导入。esbuild 为扩展宿主生成 CommonJS 模块，为两个 Webview 分别生成独立浏览器包。Webview 资源根目录包含 `media/` 和 `dist/webview/`；浏览器包不依赖 Node 或运行时 npm 模块。

## 类型检查

`npm run typecheck` 执行三组检查：

- `tsconfig.json` 检查所有 TypeScript 源码及 VS Code API 使用。
- `tsconfig.core.json` 对后端协议、KDB、Tcl 桥、共享模型、RTL 提取、源码比较和状态恢复启用完整 `strict`，包括隐式 any 和空值检查。
- `tsconfig.webview.json` 单独检查浏览器入口，不加载 Node/VS Code 全局类型。

旧界面事件处理器和部分宿主消息派发尚使用兼容配置：允许推导出的 any，未全面启用空值检查。JSON/VS Code 消息边界保留现有运行时验证；TypeScript 类型不能验证外部 JSON。迁移不使用 `@ts-nocheck`。

后端客户端按方法推导参数及返回类型，例如 `request('query', ...)` 要求十进制字符串时间戳，`request('open', ...)` 必须提供路径。`type-tests/backend.ts` 用编译检查防止这些约束意外退化。

## 构建、调试与发布

```bash
npm ci
npm run typecheck
npm run build
npm test
npm run test:ui
npm run format:check
npm run package
```

测试加载 `dist/` 编译产物。`npm test`、`npm run test:ui` 和 VSIX 打包会先执行类型检查和构建。F5 配置先执行构建，使用生成的 source map 调试 TypeScript；修改源码后重新构建再重启调试。

VSIX 包含 `dist/`、`media/`、Tcl 桥与原生二进制，不分发 TypeScript 源码、source map、测试或构建依赖。用户机器运行插件无需 npm install 或 TypeScript 编译器。

## 外部仿真工程

插件运行不依赖原 OpenTitan 目录。可选 MAC/FPU 脚本与完整芯片层次测试通过 `WAVE_TEST_PROJECT_ROOT` 定位外部工程，搭配 `WAVE_TEST_KDB`、`WAVE_TEST_FSDB`、`WAVE_TEST_FPU_RUN` 选择数据。仓库不包含仿真数据或 Verdi SDK。

## MCP

`src/mcp.ts` 提供 MCP 入口，通过扩展宿主的会话访问已打开的波形。切换波形后端后，MCP 工具使用同一个会话。 [接口与配置](COMMANDS.md#波形工程布局与-mcp090)

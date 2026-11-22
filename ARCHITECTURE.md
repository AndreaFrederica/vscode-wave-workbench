# Wave Workbench 实现结构

扩展宿主、Tcl 命令适配和 Webview 源码使用 TypeScript。FSDB 和 KDB 由 Rust 独立实现和 Verdi SDK 提供两条读取路径，共用逐行 JSON 协议。

| 路径 | 职责 |
| --- | --- |
| `src/extension.ts` | 扩展激活、模块组装、打开的波形会话与当前会话 |
| `src/wave-commands.ts`、`src/wave-files.ts` | 通用 VS Code 命令、最近文件、波形工程打开与保存 |
| `src/wave-sidebar.ts`、`src/wave-source-navigation.ts` | 波形侧栏、源码与波形双向定位 |
| `src/wave-rtl-hover.ts` | RTL 悬停取值、端口与实参映射、总线解码 |
| `src/wave-analysis.ts` | 组装追踪模块，向扩展宿主与静默 MCP 提供统一入口 |
| `src/wave-analysis-projects.ts`、`src/wave-analysis-static.ts` | VIDE 工程生命周期、续查上下文校验，以及静态驱动与负载查询 |
| `src/wave-analysis-bindings.ts` | 波形信号绑定、位段投影、记录字段读取和静态续查 |
| `src/wave-analysis-context.ts`、`src/wave-analysis-observations.ts`、`src/wave-analysis-reports.ts` | 离线和在线采样、波形与执行事件关联、追踪报告 |
| `src/wave-analysis-design.ts` | 源码定位、原理图、执行探针映射与日志查询 |
| `src/wave-analysis-tools.ts`、`src/wave-analysis-trace-tool.ts`、`src/wave-analysis-graphs.ts` | MCP 请求派发、追踪参数和结果组装、图表分页及续查游标 |
| `src/wave-trace-view.ts` | Trace Explorer 命令、选中信号、A 游标联动与视图状态 |
| `src/wave-trace-continuation.ts` | 续查请求、检查点校验、恢复批次、合并结果和续查报告 |
| `src/wave-vide-project.ts` | VIDE 仿真工程选择 |
| `src/wave-schematics.ts` | 信号与模块原理图面板、导航与恢复 |
| `src/live-debug-session.ts` | 在线仿真会话、VS Code 调试适配器与实时波形视图 |
| `src/wave-foreground-tools.ts`、`src/wave-tcl.ts` | 扩展宿主 MCP 工具、波形 Tcl 执行与日志 |
| `src/wave-tcl-console.ts`、`src/wave-dock.ts` | VS Code 调试控制台中的 Tcl 会话、波形编辑器的底部停靠 |
| `src/wave-decoders.ts`、`src/wave-clip-export.ts` | 解码器管理、波形裁剪与导出 |
| `src/wave-editor.ts` | VS Code 自定义编辑器注册、会话生命周期与 Webview 消息路由 |
| `src/wave-editor-surfaces.ts` | 波形 Webview 渲染、编辑器与底部面板之间的状态交接 |
| `src/wave-editor-queries.ts` | 波形窗口与概览、信号搜索与分页、虚拟信号及显示配置恢复 |
| `src/wave-editor-decoders.ts` | Webview 解码器请求、取消、规则目录及配置保存 |
| `src/wave-editor-backend.ts` | 读取波形元数据、恢复设计和视图、切换后端及回退 |
| `src/wave-editor-operations.ts` | 波形编辑器的数学、测量、模拟单位与滞回操作 |
| `src/wave-cache.ts` | 波形缓存预算、诊断和清理面板 |
| `src/wave-documents.ts` | 波形工程文档的打开、保存、备份与恢复 |
| `src/wave-design.ts` | 自动发现和手动接入设计数据库、恢复层次视图、为后端切换打开设计会话 |
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

扩展入口管理已打开的波形会话和当前会话。功能模块通过入口传入的回调读取会话，各自注册命令与视图。分析模块和 Trace 视图通过同一个回调读取当前在线仿真会话。前台 MCP 和 Tcl `waveTool` 共用工具派发，入口在注册波形编辑器前装配该派发。

编辑器模块将波形文档处理器和 Webview 解析器注册为同一个自定义编辑器。关闭波形时，编辑器取消解码查询、释放波形后端、KDB 和 Tcl，并通知入口更新当前会话和追踪状态。扩展停用时，入口释放仍打开的会话，VS Code 释放扩展登记的命令和视图。

波形与工作流脚本共用一个浏览器入口，共享工具通过模块导入。esbuild 为扩展宿主生成 CommonJS 模块，为波形编辑器、侧栏、实时波形和原理图各生成一个浏览器包。Webview 从 `media/` 和 `dist/webview/` 加载资源，浏览器包可直接在 Webview 中运行。

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

## 多引擎波形解码

`src/decoder-runtime` 负责脚本目录注册、信号事件批次、检查点、结果缓存和运行调度，复用原生波形查询。JSON 适配器复用现有逐字规则和 UART。JavaScript 使用扩展宿主的 V8 Worker，LuaJIT 通过 `wave-backend --decoder-lua` 在独立 Rust 进程中运行。UI、MCP、Tcl 和图片导出的事务查询共用宿主调度器。 [解码 API](DECODER_API.md)

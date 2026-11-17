# Wave Workbench — Native FSDB / KDB / VCD

VS Code 数字波形调试插件初版，采用类似 Verdi/nWave 的层次树、信号列表和波形布局。配套 Vide (`pascal-lab.vide-code-extension`)，不注册竞争的 HDL 语言服务器、不修改 `vide.toml`。

- **FSDB 原生读取**：Rust 独立后端 + C++ ABI 桥调用本机 Verdi Reader SDK，不启动 Verdi GUI、不转换中间 VCD。
- **KDB 原生接入**：另一个独立 Rust 进程动态加载本机 `libNPI.so`，用 `npi_load_design(-dbdir ...)` 读取 VCS elaboration 数据库，按完整层次解析真实对象、声明、实例位置及模块定义。
- **波形界面**：信号搜索、层次浏览、拖动排序、双游标与时间差、缩放平移、事件跳转和多进制显示。

本项目采用 **MPL-2.0** 开源，完整许可文本见 `LICENSE`，版权与外部依赖说明见 `NOTICE`。

本项目是独立仓库；插件运行不依赖 OpenTitan 工程目录。真实 MAC/FPU 集成测试可通过 `WAVE_TEST_PROJECT_ROOT` 指向外部仿真数据，默认测试使用仓库内示例。

## 安装

当前二进制适用于 Linux x86_64 / VS Code Remote SSH，已在本机 Verdi T-2022.06-SP2、Vide 1.2.5 环境验证后端。SDK 与 NPI 库不随 VSIX 分发，运行时需要本机安装及可用的 NPI/Verdi 许可。

```bash
code --install-extension wave-workbench-0.8.0.vsix
```

安装后打开 FSDB / VCD，或运行 `Wave Workbench: Open FSDB / VCD`。现有文件若以文本方式打开，使用「Reopen Editor With… → Wave Workbench」。

在远端 VS Code 设置中指定安装路径（也支持 `VERDI_HOME` / `NOVAS_HOME` 环境变量）：

```json
{
  "waveWorkbench.verdiHome": "/opt/edatools/Synopsys/verdi/T-2022.06-SP2"
}
```

## 按 Verdi 流程调试（0.8.0）

插件侧边栏现有原生 KDB 实例树（Hierarchy/Module），点击实例打开对应 RTL，并在侧边栏下方显示该实例已 dump 的 Signals。支持从 RTL 右键、顶部 `+` 或 `Ctrl+Alt+Enter` 添加信号，优先匹配当前 KDB 实例。波形区补齐多选、拖入/排序、右键菜单、分组折叠、精确 A/B 输入和框选缩放。

0.7.4 支持鼠标悬停波形显示该时刻的完整信号路径、值和多种进制，支持位行/虚拟信号；复用已读数据，截断区域按需点读，A/B 游标保持不变。

已有「标记」菜单和 M 快捷键：命名时间标签、虚线、拖动、跳转、编辑/删除、显示/隐藏与保存恢复；兼容现有 wvSetMarker 脚本。

现有布局将波形控制压缩为两排（共 62px），次要操作收纳进文件/分组/信号/源码菜单，编辑表单浮动显示；保留全部既有功能。

支持在 RTL 中选中多行代码，一次添加其中所有可匹配信号。顶部 `+`、右键和 `Ctrl+Alt+Enter` 共用批量入口，按实例匹配、过滤注释/关键字、去重并报告未匹配项。

现有 Rust 任意来源拼接及四态按位 AND/OR/XOR/NOT，多选后通过「拼接 / 逻辑」创建，支持派生结果继续参与运算和保存依赖链。

已有数字 Bus 位展开/收回、拆分独立位、同源位还原总线及可恢复的位视图；支持位序、X/Z 和位跳变搜索。

现有波形查找/过滤、显示名称、上下移动、剪切复制粘贴、完整路径复制、高亮、Verilog 数值表示和窗口事件报告。截图菜单的逐项范围见 `FEATURES.md`。

支持手动打开/切换 RTL 时自动展开、滚动并选中对应 KDB 实例，同步直属信号。多实例优先匹配当前上下文，存在歧义时选择一次。

波形上方增加可见分组工具栏，支持空组、多选移入/移出、拖入组、重命名和折叠/展开；层级图标更新为统一细线 SVG。

主树默认展示模块、program 及包含模块的 generate。接口/package 等作用域通过「显示接口 / 其他作用域」切换，节点使用不同类型图标。层级浏览只读名称和类型，点击时才解析源码位置，并缓存展开结果。

默认采用「侧边栏层级与信号、上方 RTL、下方波形」布局，可点击侧边栏「上方代码 / 下方波形」恢复。

普通滚轮现在上下滚动，Ctrl/⌘+滚轮缩放时间，Shift/横向滚轮平移时间；鼠标侧键支持实例前后导航。完整操作与限制见 `WORKFLOW.md`。

## 左侧 Wave Workbench 侧边栏（0.4.0）

左侧活动栏新增波形图标，点击打开「波形与 Tcl 指令」视图；也可在命令面板执行 `Wave Workbench: 打开波形侧边栏`。

侧边栏提供默认/上次波形、选择文件、接入 KDB、运行脚本和缓存统计入口。选择「指令目标」后，可在多行文本框输入 nWave Tcl，用执行按钮或 `Ctrl+Enter`（macOS 也支持 `Cmd+Enter`）执行。常用缩放、边沿和帮助命令有快捷按钮，输出包含命令、`puts`、返回值和错误。历史指令可选回输入框修改。

侧边栏与目标波形共用 Tcl 解释器和变量，不同波形各自独立；波形窗口中的命令输出也会同步到侧边栏。切到 RTL 编辑器后仍可执行，隐藏的目标波形会在旁边显示并保留输入焦点。目标波形和 KDB 状态在侧边栏显示，关闭后移除。未打开波形时可先输入 `waveHelp`。

历史最多保留本次扩展会话的 50 项且总字符不超过 64000；输出最多 150 项且总字符不超过 64000，不作为永久日志。清空输出不会清除 Tcl 变量。原有波形内控制台和命令面板入口继续可用。

## 一键打开与 nWave Tcl

编辑器顶部和资源管理器顶部的波形图标、底部状态栏「波形」、`Ctrl+Alt+W` 均可一键打开默认/上次波形；首次使用会选择文件。可用 `waveWorkbench.defaultWaveform` 配置工作区相对路径。波形界面内也有「打开波形…」「运行 Tcl…」「Tcl 命令」入口。

现在支持常用 nWave Tcl 命令：添加信号/分组、游标、命名标记、缩放、进制、取值、变化事件跳转、信号配置保存/恢复，以及 KDB 的 `srcGetFileName` / `srcSetScope`。使用真实 Tcl 8.6 解释器，不支持的命令和选项明确报错。可直接执行 `examples/nwave-demo.tcl` 验证示例 VCD。完整签名与兼容限制见 `COMMANDS.md`。

## KDB 调试

FSDB 与 KDB 应来自同一次 VCS 编译/运行。打开波形后，自动检查同目录的 `simv.daidir`。也可以点击工具栏「接入 KDB」、执行命令 `Wave Workbench: Attach KDB (simv.daidir)`，或设置 `waveWorkbench.kdbPath`。选择包含 `simv.kdb` / `kdb.elab++` 的 **simv.daidir 文件夹**。后端也接受此文件夹中的 simv.kdb 文件路径。

接入后左侧 KDB 区域显示真实 elaborated 层次，点击子实例进入、点击「上一级」返回。选择波形信号后：

- **信号声明**：完整 FSDB 层次 → KDB 对象 → 声明文件和行号。
- **实例位置**：信号所属模块实例在上层源码中的实例化位置。
- **模块定义**：该实例对应模块的定义位置。

双击已添加信号名称等同于「信号声明」。默认打开 KDB 记录的编译源码快照。源代码打开后仍由 Vide 负责编辑、语义分析、补全和高亮。不使用同名文本搜索替代 KDB；KDB 不匹配、信号未解析或源码缺失时明确报错。

若编译目录移动，可显式设置路径映射；若 FSDB 层次前缀与 KDB 不同，可显式设置层次映射。优先使用最长匹配前缀：

```json
{
  "waveWorkbench.sourcePathMappings": {
    "/old/build/src": "/new/build/src"
  },
  "waveWorkbench.hierarchyMappings": {
    "dump_top.dut": "testbench.dut"
  }
}
```

当前支持 VCS simv.daidir KDB 和 Linux NPI SDK；尚未实现 driver/load 追踪、原理图、逻辑锥、事务分析、完整的宏展开导航或 Verdi 的全部跨探查功能。KDB/FSDB 是否来自同一构建需要使用者保证，当前不会验证构建指纹；只验证对象能否解析。NPI 库的 Linux C++ ABI 导出需兼容，其他 Verdi 版本需另行验证。

## 波形操作

- 层次预览双击信号或 Enter 添加；「全部信号」和搜索结果使用虚拟目录、每页 512 条按需读取，最多保留 8 页元数据，支持浏览完整结果。初始层次预览仍为首批 1500 条；KDB 子层次接口目前仍最多返回 1500 项。
- 点击信号选择，拖动排序，Delete 移除；支持 Hex/Binary/Unsigned/Signed。
- 波形单击设 A，Shift+单击设 B，显示时间差。
- 普通滚轮上下滚动；Ctrl/⌘+滚轮以鼠标为中心缩放，Shift+滚轮或横向滚轮平移，中/右键拖动平移。
- `F` 全局，`+` / `-` 缩放，左右方向键平移，`[` / `]` 跳转**当前已读取窗口内**前后事件，并非完全复刻 nWave 快捷键。
- RTL 中选中信号，右键 `Wave Workbench: Add Selected Signal to Wave`；多个实例时选择目标。右键命令与 Vide 同时存在。
- 保留每个编辑器的信号、窗口、进制、游标及 KDB 关联，不改写原始波形。

## 编译与验证

需要 Rust/Cargo、Node.js 22 或更新版本、C++ 编译器和 Verdi 的 FsdbReader/NPI 头文件。0.8.0 将扩展宿主、Tcl 命令适配和两个 Webview 迁移到 TypeScript；Rust/C++ 继续负责原生读取与缓存。插件目录作为 VS Code 工作区打开后，F5 会先构建再启动开发窗口。

```bash
git clone https://github.com/AndreaFrederica/vscode-wave-workbench.git
cd vscode-wave-workbench
export VERDI_HOME=/opt/edatools/Synopsys/verdi/T-2022.06-SP2
export PATH="$HOME/.cargo/bin:$PATH"
cargo build --release --manifest-path native/Cargo.toml
mkdir -p bin
cp native/target/release/wave-backend bin/
npm ci
npm run typecheck
npm run build
npm run package
```

不设置 VERDI_HOME 可编译仅 VCD 的后端。当前构建记录本机 Reader 库目录为 rpath，非通用可移植二进制。`waveWorkbench.backendPath` 可指定自行编译后端；`FSDB_LIB_DIR` 可在编译/运行时覆盖 Reader 库目录。NPI 库默认从 `$VERDI_HOME/share/NPI/lib/linux64` 动态加载，未加载 KDB 时不初始化 NPI。

```bash
cargo test --manifest-path native/Cargo.toml
# 可选：真实 FSDB/KDB 和 MAC/FPU 脚本回归的数据来自外部仿真项目
export WAVE_TEST_PROJECT_ROOT=/path/to/opentitan-pre-bus
export WAVE_TEST_FSDB="$WAVE_TEST_PROJECT_ROOT/doc/cv32e40p_mac_trace/cv32e40p_mac_trace.fsdb"
export WAVE_TEST_KDB="$WAVE_TEST_PROJECT_ROOT/build/cv32e40p_mac_trace_vcs/latest/simv.daidir"
npm test
npx playwright install chromium
npm run test:ui
# 独立校验：此测试使用转换工具作参考，插件读取链路不调用转换工具
node test/compare-fsdb.js
```

TypeScript 源码与构建入口见 `ARCHITECTURE.md`。`npm test` 与 `npm run test:ui` 都先执行类型检查和构建，测试实际 `dist/` 产物。

Rust 单元测试、实际 FSDB/KDB 协议测试、模拟 VS Code API 的宿主适配测试、真实浏览器交互测试共同验证行为，尚未在真实 Extension Development Host 内自动化驱动 Vide 语言服务器。更多结果见 `VALIDATION.md`。

## 层次与主题（0.4.1）

层次预览使用每级 16px 的实际缩进，虚拟滚动或折叠/展开后保持层级位置。界面背景、前景、按钮、列表选中态、边框、滚动条和波形颜色读取 VS Code 主题变量。Canvas 在主题属性或主题样式更新时重绘，支持浅色、深色和高对比度，保留信号、游标和缩放状态。

## 性能与边界

0.3.0 移除了 64 条已添加信号的限制，会话最多保留 100000 条信号描述，已用 10000 条实际测试。名字列表、波形 Canvas、信号目录和 KDB 列表均按视口虚拟渲染，波形上下预留 4 行；Canvas 尺寸只随视口/DPR 改变，不随信号总数增长。浏览器滚动范围表示整个列表，百万目录的巨大高度采用压缩映射，支持拖动滚动条到末尾。

波形数据也按视口读取，单次传输最多 64 个信号，超过时自动分批；快速滚动只在当前请求结束后读取最新视口，不把过期结果填到新时间窗口。前端仅保留视口及预留行的事件。每信号/窗口默认最多 20000 条事件，可设至 100000，超限显示截断与未读取阴影，需要放大时间范围。

Rust 解码数据 LRU 缓存默认 **64 MiB / 每个波形后端**，通过 `waveWorkbench.cacheSizeMB` 配置为 0–512 MiB，重新打开波形生效。缓存键为信号 ID、起止 tick 和事件上限，精确命中或包含于完整缓存区间的查询可省去重复读取；截断数据只允许精确复用，避免将缺失尾部当作完整波形。最多保留 4096 块，按估算的持有数据字节数淘汰；超出预算的单块不保留，重新打开文件清空缓存。命令 `Wave Workbench: 查看 Rust 波形缓存统计` 可查看容量、命中、实际读取与淘汰计数。前后平移只有部分重叠时仍需读取，固定时间分块拼接、LOD 和磁盘缓存尚未实现。

缓存容量不是总 RSS 上限：VCD 当前仍整文件解析到内存；FSDB 先读取完整层次元数据，Verdi SDK 内部也可能加载额外数据块。SDK 的 view window 对不同文件版本支持有限，不能保证任意 GB 文件的固定内存上限。每个后端请求 120 秒超时，退出后需重新打开波形或重新接入 KDB。仿真更新了原文件后，应重新打开查看以清除旧数据。

Rust 时间戳为 u64，JSON 传输为十进制字符串。当前 Canvas UI 对结束 tick 超过 2^53−1 的文件报错，防止悄悄损失精度。支持数字四态标量/总线，尚不支持模拟/real、强度、复杂记录、展开内存、枚举文本及 delta/glitch 细分。VCD 限制 128 MiB、200000 条信号声明和 200 万次变化。大文件优先使用 FSDB。

该插件不是 Synopsys 产品，SDK/NPI 的许可条款独立适用。

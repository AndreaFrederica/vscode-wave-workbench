# Wave Workbench

在 VS Code 中浏览数字和模拟仿真波形、解码协议、计算派生信号，并从异常波形回到 RTL。可以在同一个工作区查看源码、实例树、波形和原理图，也可以用 Tcl 或 MCP 批量分析和导出结果。

**完整 RTL 调试功能需要同时安装 Wave Workbench 和本项目修改版 Vide。** 修改版提供 RTL 追踪接口和隔离的仿真工程会话，用于驱动与负载追踪、A 游标时序追踪和 VCS KDB 原理图中的模块内部逻辑。只看波形、做解码和数学分析时，安装 Wave Workbench 即可。

[安装](#安装) · [用示例波形上手](#用示例波形上手) · [波形界面](#波形界面) · [格式](#波形格式与打开条件) · [解码](#解码事务行和注释) · [数学](#模拟测量数学和频谱) · [RTL 调试](#rtl-联动追踪和原理图) · [在线仿真](#执行记录与在线仿真) · [自动化](#工程导出与自动化)

## 安装

### 从源码构建

Wave Workbench 支持桌面 VS Code 1.85+。两份扩展一起使用时，VS Code 需为 1.101+。准备 Node.js 22+、Rust/Cargo 和本机 C/C++ 编译工具。Windows 请使用对应架构的 Visual Studio 开发者终端。

```sh
git clone https://github.com/AndreaFrederica/vscode-wave-workbench.git
cd vscode-wave-workbench
npm ci
npm run package:native
```

在 VS Code 扩展视图选择「从 VSIX 安装…」。打包脚本支持 Linux、macOS 和 Windows 的 x64、ARM64 目标，平台包内置 Tcl 8.6。这里介绍的是 `main` 上的功能，请用同一提交构建 VSIX。

### 安装修改版 Vide

使用本项目 fork 的 `wave-workbench-trace` 分支。以下命令固定到配套的 `cfb0a7c0` 提交。构建需要该仓库指定的 Rust 工具链、CMake 和支持 C++20 的编译器。 [Vide 分支](https://github.com/AndreaFrederica/vide/tree/wave-workbench-trace) · [配套提交](https://github.com/AndreaFrederica/vide/commit/cfb0a7c04e77a93e5f3f2396fc68f91bcc1b97ad)

```sh
git clone --recurse-submodules --branch wave-workbench-trace https://github.com/AndreaFrederica/vide.git
cd vide
git checkout --detach cfb0a7c04e77a93e5f3f2396fc68f91bcc1b97ad
git submodule update --init --recursive
cd editors/vscode
npm ci
npm run package:vsix
```

把两份 VSIX 安装到同一个扩展宿主，随后重载窗口。使用 Remote SSH 时，在远端宿主安装对应平台的两份包。修改版沿用 `pascal-lab.vide-code-extension` 扩展 ID，请关闭该扩展的自动更新，以保留手动安装的版本。

## 用示例波形上手

1. 用 VS Code 打开 Wave Workbench 仓库。在左侧活动栏进入 Wave Workbench，点「选择文件…」，打开 `examples/demo.vcd`。在「波形目录」或侧栏层级中展开 `tb` → `dut`，将 `clk`、`data[7:0]` 和 `valid` 加入波形。 [示例 VCD](examples/demo.vcd)
2. 在波形中单击设 A，Shift+单击设 B，也可直接在输入框填写时间。把 A 设为 20 ns，`data[7:0]` 的十六进制值是 `2A`。用 **Ctrl/⌘+滚轮**缩放，按 **`[`**／**`]`** 在已加载窗口内跳到选中信号的前后边沿，按 **M** 添加命名标记。
3. 只选中 `data[7:0]`，打开 **解码 → UART → UART 数据字节**，在波形格和 A 游标值列查看字节标签。用 **显示 → 显示解码值** 切换原始值和标签。
4. 仍选中这条信号，打开 **数学 → 数学算式…**，以无符号数解释总线，计算全波形的 `2*A`。算式里的 `A` 是第一个输入，结果在 20 ns 为 84，并以新的一行显示。
5. 通过 **文件 → 保存波形工程…** 保存 `.waveproj`，或用 **截取 / 导出波形…** 导出选中信号及 A/B 区间。

## 波形界面

| 区域 | 可以做什么 |
| --- | --- |
| VS Code 活动栏与侧栏 | 打开默认、上次或最近的波形和工程，接入设计数据库，浏览实例、接口和作用域，按目录分页或搜索信号，双击或批量添加已记录信号。侧栏还能按标签查找信号、改标签颜色和样式，或选择 Tcl 指令的目标波形。 |
| 信号列表和值列 | 查找真实路径或别名、按名称或 `tag:` 过滤、多选、拖动排序、剪切／复制／粘贴、复制完整路径、设置别名和颜色。支持二／八／十六进制、无符号／有符号十进制和 Verilog 数值表示。可调整行高和列宽，配合 VS Code 浅色、深色和高对比度主题。 |
| 分组、Bus 和虚拟信号 | 创建、改名、排序、折叠分组并移动信号。数字 Bus 可展开、收回、拆成独立位或还原总线。用「信号 → 拼接 / 逻辑」按显示顺序拼接，或做四态按位 AND、OR、XOR、NOT，结果可继续参与运算。 |
| 画布与时间轴 | 全局缩放、框选缩放、A↔B 缩放、平移、切换时间单位、跳边沿、查看悬停处与 A 游标的信号值和时间差。命名标记可设颜色、拖动、编辑、跳转或隐藏。「信号 → 事件报告」列出窗口起点值和变化。 |
| 大波形浏览 | 信号目录分页，列表虚拟滚动，按时间窗和信号批次读取并缓存事件。可设置缓存大小和每信号的事件上限，并从命令面板查看缓存统计。 |

[界面操作和快捷键](WORKFLOW.md#波形操作)

## 波形格式与打开条件

| 格式 | 读取方式与条件 |
| --- | --- |
| **VCD / FST** | 内置读取器，支持数字和实数信号。常用于 Verilator 等仿真器。 |
| **FSDB / VCS KDB** | 独立 WaveBench Reader 可读取四态数字 FSDB，并从配套 `simv.daidir` 查询实例层级与源码位置。独立读取器使用 LZO 2，兼容性因数据库版本而异。也可在 Linux x64 通过本机 Verdi Reader／NPI 读取。 |
| **Xcelium SHM** | 在 Linux x64 打开 `.shm` 内的 `.dsn`，配置 `waveWorkbench.xceliumHome`。可从原始 Xcelium 仿真快照生成 HDL 源码索引。 |
| **Vivado XSim WDB** | 在 Linux x64 打开 `.wdb`，配置 `waveWorkbench.vivadoHome`。用 `xelab -debug all` 保留 HDL 源码位置。 |
| **Questa WLF** | 通过 `waveWorkbench.wlf2vcdPath` 调用本机 `wlf2vcd`，转换后沿用 VCD 的读取限制。真实 WLF 样本待验收。 |
| **Spectre PSF ASCII / ngspice RAW** | 读取 `.tran`、`.psfascii` 实值瞬态数据，以及 ngspice 单 plot 的 ASCII 或小端二进制 `.raw`，可看瞬态电压、电流和 AC 复数分量。 |

Verdi 桥接需使用本机 SDK 和许可，在 Linux x64 执行 `VERDI_HOME=/path/to/verdi npm run package:native -- --target linux-x64 --verdi`。安装后将 `waveWorkbench.verdiHome` 指向 Verdi，并将 `waveWorkbench.fsdbBackend` 设为 `verdi` 或 `auto`。使用 Remote SSH 时，工具和 SDK 路径以远端主机为准。 [FSDB/KDB 兼容范围](native/README.md#experimental-status) · [SHM、WDB、WLF 与 SPICE 验证详情](ANALOG_WAVE_PLAN.md#厂商-sdk-与-spice-实测)

## 解码、事务行和注释

- **单信号解码**。选中一行，在「解码」里套用 RISC-V RV32IMFC 或 RV32IMC + Zfinx 指令、TL-UL A/D opcode、AXI BRESP/RRESP、UART 字节或 I²C 地址与读写位预设。UART 还能从单比特 TX/RX 解码串行帧，可配置波特率、数据位、校验、停止位、位序和反相，并标注帧错误。
- **在界面编写规则**。用 **解码 → 编辑此信号的自定义规则…** 填写掩码、匹配值和显示文本，可用条件分支和位段插值，例如用掩码 `0xf0` 匹配 `0x20`，再用 `读通道 {3:0:dec}` 显示低四位。可编辑内置规则的副本，或将多条规则保存为 `.vscode/wave-decoders/` 下的 JSON 文件，供同一工作区复用。
- **多路事务解码**。从 **解码 → 配置事务解码器…** 绑定时钟、数据、片选等输入，最多显示四条事务行。悬停查看字段，点击事务标签可定位到起点。通过 **管理脚本解码器…** 创建、复制或编辑脚本包。支持 JavaScript、编译成 JavaScript 的 TypeScript 和 LuaJIT，脚本可读取数字或实数采样、发出带字段的事务和诊断，也可生成四态虚拟信号。脚本在可信工作区运行，可随保存刷新或手动重载。
- **标签和注释**。用 **信号 → 标签和注释…** 记录信号用途，按标签筛选，并在悬停时阅读注释。解码规则、事务绑定和信号注释可随波形工程恢复。

[内置规则与自定义规则](COMMANDS.md#波形解码和信号注释) · [脚本解码器 API](DECODER_API.md) · [SPI 与字值区间示例](examples/wave-decoders)

## 模拟测量、数学和频谱

实数与数字波形可以同屏查看。在「信号」中可设置实数单位或用高低阈值生成带滞回的数字波形。

独立的「测量」菜单提供 A/B 读数和差值、实数最值、峰峰值、均值与 RMS、数字边沿计数、脉宽、周期、频率、占空比、两路首个上升沿延时、实数 10–90% 上升／下降时间和 FFT 峰值。区间测量优先用 A/B，未设置两个不同游标时用当前视窗。

选中输入行后打开「数学」，可按 A/B 区间或全波形计算。数字总线可用无符号数或二补码解释，算式可混用数字和实数信号。

| 菜单 | 用途 |
| --- | --- |
| **数学算式…** | 最多四个输入，用 `A`–`D` 引用。支持四则、幂、取模和常用数学函数，例如 `A-B` 或 `sqrt(A*A+B*B)`。 |
| **差分微分… / 积分… / 一阶低通…** | 计算相邻采样的差分、零阶保持积分，或按截止频率和输出周期滤波。 |
| **ADC 量化… / DAC 重建…** | 在实数电平和 1–32 bit 数字码之间转换，可随输入变化、固定周期采样或用第二路信号触发。支持数字边沿或实数阈值触发和输出延迟。 |
| **FFT 频谱…** | 配置点数、窗函数、重采样方式和去直流。以独立 `.raw` 打开频谱，频率轴使用 Hz，可查看幅值、相位、dB 和单边功率谱密度。 |
| **运行外部算子…** | 在可信工作区选择本地 JavaScript 文件或原生可执行文件，用 JSON 传入选项，返回一个实数或数字通道。 |

时域结果加入原时间轴，可作为下一个算子的输入。波形工程可保存派生结果的采样快照。 [数学算子、采样规则和外部 API](WAVE_MATH.md)

## RTL 联动、追踪和原理图

1. **接入同一次仿真的设计数据**。用「源码 → 接入设计数据库」关联 Verilator `--json-only` 生成的 `*.tree.json` 和同目录的 `*.tree.meta.json`，或 VCS 的 `simv.daidir`。Verilator 应沿用仿真的顶层、源文件、include、宏和参数。可用 `waveWorkbench.verilatorTreePath` 或 `waveWorkbench.kdbPath` 指定路径，用 `waveWorkbench.sourcePathMappings` 映射迁移后的源码。
2. **在实例、波形和源码之间跳转**。通过实例树或「源码」菜单打开信号声明、实例位置、模块定义。用「上方代码 / 下方波形」同时查看 RTL 与波形，在源码中悬停查看 A 游标取值，或选中一段 RTL，用 **Add Selected RTL Signals to Wave** 批量添加该实例里已记录的信号。
3. **按实际编译配置追踪**。安装修改版 Vide 后，可用 **Preview VIDE Project from Simulation Filelist** 检查编译配置，再用 **Set Simulation Filelist for Active Waveform Trace** 绑定波形对应的 filelist。可从波形选中的信号或 RTL 光标位置发起静态驱动／负载查询。要查某个时刻，先放置 A 游标，再点「查看 A 游标追踪证据」。Trace Explorer 可跳源码、将节点加入波形、继续展开上游或下游，并生成可分页的 Mermaid 图和 Markdown 报告。
4. **查看局部与整模块原理图**。从「原理图」打开本次追踪、驱动／负载、信号所属模块或顶层。图中可按信号或模块看追踪结果、高亮连接、查看 A 游标数值、下钻子实例、跳源码或将端口和网加入波形。模块图可展示端口方向、总线切片、常量及可解析的赋值逻辑。

离线追踪显示波形观测、候选关系和证据缺口。SHM 和 WDB 支持带 HDL 索引的模块内追踪，跨实例端口连接当前仅部分覆盖。 [从仲裁示例跑通 RTL 追踪](RTL_TRACE_QUICKSTART.md#构建并在-vs-code-追踪) · [Verilator VCD／FST 样例](test/fixtures/verilator/README.md) · [追踪参数与证据](COMMANDS.md#rtl-追踪与波形证据)

## 执行记录与在线仿真

- **离线回放**。用 **Open Execution Recording** 打开与波形匹配的执行 JSONL，或从「追踪」选择 **结合执行记录追踪 A 游标…**／**回放 A 游标处的执行记录…**，检查实际执行的语句、更新顺序和采样值。VCS 可用 `wave_execution_map` 生成采集用探针。
- **在线调试**。启动带 Wave Workbench 接口的 Verilator harness 或加载 VPI 的 VCS `simv`。从 VS Code「运行和调试」启动或附加，可暂停、继续、按时钟或时间槽步进、按信号值设断点，并在采集了对应语句事件时使用源码断点。变量、监视和调试控制台可查询当前采样。实时波形可跟随最新数据、回看历史、取值和追踪，停止后仍可查询本次会话的历史。

[在线仿真与执行记录](RTL_TRACE_QUICKSTART.md#回放与在线追踪) · [VS Code 启动与附加配置](WORKFLOW.md#在-vs-code-中调试在线-rtl)

## 工程、导出与自动化

| 功能 | 入口 |
| --- | --- |
| **保存和恢复工程** | 「文件 → 保存波形工程…」生成 `.waveproj`，恢复波形、设计数据库、实例树状态、信号顺序、分组、显示、标签、解码、派生信号、A/B、标记和时间窗。分享时一起提供工程引用的波形、设计数据和源码，并保留相对路径。 |
| **截取和导出** | 在「文件」或「信号」中选择「截取 / 导出波形…」，指定信号与区间，导出 PNG、CSV、JSON 或可重开的 VCD。PNG 和 JSON 可包含已配置的事务行。 |
| **Tcl** | 从侧栏或波形底部控制台执行命令，或从「文件」运行脚本。平台包内置 Tcl，支持常见 nWave 命令、信号配置保存／重放、变量、循环、过程和 `source`。打开示例 VCD 后可直接运行 `examples/nwave-demo.tcl`，或用 `waveHelp` 查询兼容命令，用 `waveTool list` 查看统一工具接口。 |
| **前台 MCP** | 在工作区设置 `waveWorkbench.mcpEnabled` 后重载窗口。使用 stdio 运行 `node <扩展目录>/dist/mcp.js <工作区绝对路径>`，可访问当前窗口的波形和在线会话，并打开对应的源码、原理图或 VS Code 调试面板。 |
| **后台 MCP** | 使用 stdio 运行 `node <扩展目录>/dist/mcp-headless.js <工作区绝对路径>`，在波形所在机器上独立打开工程、分析和调试。RTL 分析可自动查找已安装的修改版 Vide，也可通过 `WAVE_WORKBENCH_VIDE_PATH` 指定其中的语言服务器。 |

前台和后台 MCP 公开同一份工具接口，覆盖波形查询和导出、解码生命周期、数学、源码和原理图、追踪和分页、执行记录、在线仿真以及 DAP 调试。Tcl 控制台也可用 `waveTool` 调用这些工具。 [MCP 和 Tcl 接口](COMMANDS.md#前台-mcp后台-mcp-和-tcl) · [Tcl 示例](examples/nwave-demo.tcl) · [导出参数](COMMANDS.md#截取--导出波形091)

## 许可

Wave Workbench 源码采用 MPL-2.0。第三方工具、SDK 和运行时适用各自的许可。 [项目许可](LICENSE) · [第三方声明](NOTICE)

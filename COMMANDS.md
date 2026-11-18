# nWave 常用命令兼容（0.5.0）

命令签名参考本机 Verdi T-2022.06-SP2 的 `doc/tcl.pdf`，不是完整 Verdi Tcl API 的替代实现。输入 `waveHelp` 查看当前命令列表。不支持的命令/选项会报错，错误前已经执行的操作按 Tcl 通常规则保留。

## 打开入口

- 编辑器右上角 `pulse` 波形图标、资源管理器标题栏同名图标、底部状态栏「波形」，以及 `Ctrl+Alt+W`（macOS：`Cmd+Alt+W`）：一键打开。
- 优先打开 `waveWorkbench.defaultWaveform`，否则打开本工作区上次波形，首次使用则选择文件。同目录 `simv.daidir` 自动接入，其他 KDB 仍可手动选择。
- `Wave Workbench: 打开波形文件…` 和波形界面的「打开波形…」始终显示文件选择器。
- 资源管理器 FSDB/VCD 右键打开；Tcl/RC 右键运行脚本。
- 命令面板提供放大、缩小、全局、边沿、游标、标记、保存/恢复信号配置，以及「执行 nWave Tcl 命令…」「运行 nWave Tcl 脚本…」。

默认文件可设为工作区相对路径，例如：

```json
{
  "waveWorkbench.defaultWaveform": "build/cv32e40p_mac_trace_vcs/latest/waves.fsdb"
}
```

## 命令与选项

每次 Tcl 会话针对当前波形窗口，窗口 ID 为 `1`（也接受 `_nWave1`）。`wvCreateWindow` 返回当前窗口 ID，当前不创建独立空白 nWave 窗口；`wvOpenFile` 会通过 VS Code 打开目标波形，并将该会话后续命令指向它。多个原生 Verdi window handle 的脚本尚未兼容。

| 命令 | 支持范围 |
| --- | --- |
| `wvCreateWindow`、`wvGetCurrentWindow` | 返回当前逻辑窗口 `1` |
| `wvOpenFile filename` | FSDB/VCD，自动关联同目录 KDB |
| `wvAddSignal [-clear] signal...` | 按完整层次添加，默认 `/` 分隔，支持 `-delim` |
| `wvAddSignal -group {NAME {signal} ...}` | 添加分组信号，分组显示为行内标签；不折叠 |
| `wvDeleteSignal signal...` | 按名称删除，支持 Tcl 信号列表 |
| `wvSelectSignal signal` | 选中已显示的一个或多个信号 |
| `wvSetCursor -begin\|-end\|time` | 设置游标 A |
| `wvSetMarker [-name NAME] [-keepViewRange] time` | 命名标记；最近标记作为 B，支持差值 |
| `wvZoom start end` | 指定时间范围 |
| `wvZoomAll`、`wvZoomIn`、`wvZoomOut` | 全局、放大一倍、缩小一倍 |
| `wvZoomCursorMarker` | 缩放到 A/B 之间 |
| `wvSetRadix [-Unsigned\|-2Com] -format Bin\|Oct\|Hex\|Dec [signal...]` | 对指定信号或选中行设进制，Dec + `-2Com` 为有符号十进制 |
| `wvGetSigValueByTime signal [-format Bin\|Oct\|Hex\|UDec\|2Com] [-time TIME] [-lz]` | 原生后端直接查询该时刻，省略 `-time` 使用 A |
| `wvIsSignalExistInWaveform -signal signal` | 查询 dump 是否包含信号 |
| `wvSetWindowTimeUnit number s\|ms\|us\|ns\|ps\|fs` | 改变时间显示及后续命令时间参数的单位，不能表达为整数 dump tick 时拒绝 |
| `wvGetWindowTimeUnit` | 返回当前时间单位 |
| `wvSearchNext`、`wvSearchPrev` | 当前已加载窗口的变化事件搜索，返回 `{1 TIME}` 或 `0`；不支持额外的搜索模式配置 |
| `wvSaveSignal file.tcl` | 导出可重放 Tcl：信号、分组、进制、游标、标记、窗口与时间单位 |
| `wvRestoreSignal file.tcl` | 清空当前信号配置后执行重放脚本 |
| `srcGetFileName full.name` | KDB 精确查询声明文件 |
| `srcSetScope full.name` | 通过 KDB 切换层次区域 |
| `waveHelp` | 列出支持命令 |

`wv*` 命令除 `wvCreateWindow` 外均可用 `-win 1`。信号/时间参数含空格、`[]`、`$` 等 Tcl 特殊字符时，使用 Tcl 花括号保护或 `list` 构造，避免被当作表达式求值。

```tcl
set wave [wvCreateWindow]
wvAddSignal -win $wave -group [list BUS [list /tb/dut/clk] [list {/tb/dut/data[7:0]}]]
wvSetCursor 20
wvSetMarker -name RESULT 30
wvZoom 10 40
puts [wvGetSigValueByTime {/tb/dut/data[7:0]} -time 20 -format Hex]
```

## Tcl 执行和限制

平台 VSIX 内置 Tcl 8.6 解释器，支持 `set`、`foreach`、`if`、`expr`、`list`、`proc`、`source` 等 Tcl 语法。`waveWorkbench.tclshPath` 可覆盖解释器选择，开发目录没有内置运行时时从 `PATH` 查找。同一波形窗口的 Tcl 变量跨输入保留。`source` 相对于当前脚本目录解析。

执行入口为受限子解释器，未提供 `exec`、任意 `open`、socket 或完整进程环境；`puts` 输出到控制台，`file` 仅提供常用路径和只读检查子命令。脚本若依赖环境变量，需显式设置，例如：

```tcl
set ::env(CV32E40P_MAC_RUN_DIR) /absolute/path/to/build/run
source /absolute/path/to/doc/cv32e40p_mac_trace/verdi_cv32e40p_mac.tcl
```

`wvSaveSignal` 输出的是可由此插件或 Verdi `source` 的 Tcl 命令文本，不是 Synopsys 原生 `.sav` 配置格式。原生 `.rc` 若包含当前未支持的命令/选项会报错，不能保证任意旧 RC 文件可完整恢复。源脚本大小上限 1 MiB、命令执行预算 20 万次/输入、解释器时间限额 60 秒、会话请求总超时 120 秒。

以下仍未实现：driver/load 追踪、原理图、搜索模式配置、逻辑信号运算、模拟/事务命令、完整 alias、group/index 行定位语法、多窗口 handle、每信号延时或颜色选项、全部 `src*` 与 GUI 自动化命令。


## 虚拟滚动与命令行为（0.3.0）

已添加信号可超过 64 条，当前会话描述上限 100000 条。Tcl 快照和 `wvSaveSignal` 包含所有已添加信号，未显示到屏幕的行不创建 DOM 或绘制波形，也不请求波形事件。`wvSelectSignal` 会滚动到目标行；`wvSearchNext` / `wvSearchPrev` 会先确保目标行可见并等待视口数据。

信号目录的「全部信号」和搜索采用 512 条一页的完整结果虚拟滚动；初始层次预览为前 1500 条。缓存设置与统计命令为 `waveWorkbench.cacheSizeMB` / `Wave Workbench: 查看 Rust 波形缓存统计`。完整的 100000 信号 Tcl 导出文件仍可能超过现有脚本大小/命令预算，超大脚本恢复并未解除这些执行限制。


## 侧边栏输入（0.4.0）

点击 VS Code 左侧活动栏 Wave Workbench 图标，选择指令目标，在多行输入框执行现有 nWave Tcl。使用 `Ctrl+Enter` / `Cmd+Enter` 提交。侧边栏提供打开波形/KDB/脚本、缩放、边沿、帮助和缓存入口，显示执行输出与会话内历史。每个波形的变量独立；侧边栏和波形内控制台共用该波形的解释器。切换目标后不会沿用另一波形的 Tcl 变量。


## 0.5.0 图形交互

实例树、RTL 与波形往返操作见 `WORKFLOW.md`。`wvSelectSignal` 可选中多个已显示信号并返回选择数量；折叠分组只影响显示/读取，Tcl 快照与保存仍保留全部信号。


## 位投影与视图重放（0.6.1）

`wvAddSignal /tb/dut/data[0]`、`wvSelectSignal` 和 `wvGetSigValueByTime` 可选择一维 Bus 的位；优先匹配已独立 dump 的信号，再尝试源 Bus 投影。位宽/源路径仍由后端 metadata 校验。

`waveRestoreView json` 是 Wave Workbench 自有的 Tcl 重放扩展。带位行或虚拟信号的 `wvSaveSignal` 使用该扩展保留位下标、Bus 折叠和组/显示设置；原生 Verdi 不认识这个命令。超过现有 1 MiB Tcl 脚本限制时会拒绝保存。

虚拟定义通过界面创建，当前尚无 Verdi 逻辑表达式命令兼容层。waveRestoreView 会先校验并注册虚拟依赖，再恢复信号；脚本需要原始输入 ID/名称/层级与当前波形一致。

## 波形工程、布局与 MCP（0.9.0）

「文件 → 保存波形工程」将波形与设计数据库的路径、信号、分组、标记、游标、时间范围和显示设置保存到 `.waveproj`。工程通过相对路径引用波形和 Verilator elaboration JSON 或 VCS KDB，并保存实例树状态。「文件 → 打开波形工程」可恢复视图，也可以在资源管理器中右键工程文件打开。

拖动分组标题到另一个标题的上半或下半可调整顺序。选中信号会将它所属的分组设为后续添加的目标，显式指定的分组优先。工具栏搜索框左侧的「悬停提示」复选框可开关波形提示，「显示」菜单可调行高。拖动信号栏与波形画布之间的分隔线可调宽度，双击恢复默认。

「显示 → 总线格数值」控制画布和 PNG 导出中的总线标签。默认的「自动缩写」优先显示完整值，空间不足时缩写，省略号表示前方还有数字。「仅完整值」会留空放不下完整值的格子。悬停提示和游标 A 的值栏可查看完整值。

| Tcl 命令 | 用途 |
| --- | --- |
| `waveView` | 返回当前视图 JSON |
| `waveFindSignals query ?offset? ?limit?` | 搜索波形信号，返回分页 JSON |
| `waveGetEvents signal start end ?limit?` | 提取范围内的信号事件，含范围起点的初始值与截断标志，时间使用当前单位，值为二进制字符串 |
| `waveGroup list` | 查看分组顺序、目标组与折叠状态 |
| `waveGroup create/target/remove/collapse/expand name` | 管理分组。目标组使用空名称时，新增信号落入未分组区域 |
| `waveGroup move name target before/after` | 调整分组顺序 |
| `waveGroup rename name newName` | 重命名分组 |
| `waveGroup assign name signal...` | 移动已显示的信号 |
| `waveTooltip ?0/1?` | 查询或设置悬停提示 |
| `waveBusLabels ?auto/full?` | 查询或设置总线格的数值显示策略 |
| `waveLayout ?rowHeight signalColumnPercent?` | 查询或设置行高和信号栏占比 |

打开工作区后，启用 `waveWorkbench.mcpEnabled` 并重新加载 VS Code。MCP 客户端在运行 VS Code 工作区扩展宿主的机器上，通过 stdio 启动 `node <插件路径>/dist/mcp.js <工作区绝对路径>`。该进程连接当前工作区的用户私有 Unix socket。Remote SSH 使用远端扩展宿主与远端 MCP 进程。

MCP 提供 `wave_list`、`wave_open`、`wave_save_project` 和 `wave_tcl`。`wave_tcl` 运行与侧边栏共用的 Tcl 解释器，返回脚本结果与 `puts` 输出。可使用 Tcl 的变量、过程、循环、表达式和 `source`，可执行的波形命令见 `waveHelp`。命令覆盖范围沿用上文所述的 Wave Workbench 兼容范围。

`wave_save_project` 会直接保存并返回工程路径。传入 `path` 可指定文件，省略时保存到已关联的工程，首次保存则写到波形旁的同名 `.waveproj`。传入 `waveform` 可选择另一份已打开的波形。

```tcl
waveGroup create FPU
wvAddSignal /tb/dut/apu_req /tb/dut/apu_rvalid
waveLayout 44 32
wvZoom 400000 700000
waveGetEvents /tb/dut/apu_rvalid 400000 700000
```

## 截取 / 导出波形（0.9.1）

在波形视图中选中信号行，然后通过「文件」或「信号」菜单中的「截取 / 导出波形…」选择信号范围、当前时间窗口或游标 A/B 区间，再保存为 PNG、CSV、JSON 或 VCD。VCD 可以重新打开，时间从截取起点的 0 开始。CSV 和 JSON 保留原始时间刻度。导出图片包含信号名称和时间轴。

MCP 客户端可以直接使用两个工具，无需编排 Tcl。

| 工具 | 输入 | 输出 |
| --- | --- | --- |
| `wave_clip` | `signals` 全路径列表，`range` 可取 `view`、`cursors`、`explicit`，显式范围用 `start`、`end` 指定整数 tick 字符串 | 时基、起止位置、标记、各信号起点值、变化事件以及截断状态 |
| `wave_export` | 同样的截取参数，外加 `format` 和可选 `path` | PNG 可直接作为图像返回。提供路径时，输出 PNG、CSV、JSON 或 VCD 文件 |

省略信号时使用已经选中的信号行，未选中时使用当前显示的信号行。省略范围时使用当前窗口，同时提供 `start`、`end` 时使用显式范围。每次最多截取 64 个信号。MCP 可用 `limit` 设置每个信号的事件上限，工具也会应用总量上限。如果范围太大，JSON、CSV 和 PNG 会标记截断。VCD 要求所选范围在事件上限内。

```json
{
  "signals": ["/cv32_apu_overlap_tb/dut/apu_busy", "/cv32_apu_overlap_tb/dut/apu_rvalid"],
  "start": "440000",
  "end": "675000",
  "format": "png"
}
```

## 波形解码和信号注释

选中信号后，打开顶部「解码」菜单，展开协议或工作区文件并选中其中一条规则。菜单会勾选当前规则，并展开它所在的文件。内置文件包括 RISC-V、TL-UL、AXI、UART 和 IIC。UART 文件包含数据字节和一位 TX/RX 串行帧预设。IIC 预设读取含 R/W 位的地址字节。波形格、游标 A、悬停提示和 PNG 导出可以显示解码结果。「显示 → 显示解码值」可以切换到原始数值，「解码 → 清除解码」可以移除当前信号的规则绑定。

用「解码 → 编辑此信号的自定义规则」可填写规则名称和每行的掩码、匹配值、显示文本。表格按从上到下的顺序匹配，应用时使用所选信号的位宽校验。当前信号的自定义规则随 `.waveproj` 保存。

「新建工作区规则文件」在 `.vscode/wave-decoders/` 中创建 JSON 文件。一个文件可定义多个供不同信号复用的规则。旧版的 `.vscode/wave-decoders.json` 仍可读取。内置规则的「编辑副本」会创建独立的工作区文件，随后将副本应用到所选信号。指令解码器副本可添加匹配规则，未匹配的值仍交给内置指令解码器。

下面的文件包含一个 Zfinx 配置和一组用于 8 位命令字的匹配规则。

```json
{
  "version": 1,
  "label": "CV32 指令与请求",
  "profiles": [
    { "id": "cv32-id", "label": "CV32 ID", "builtin": "rv32-zfinx" },
    {
      "id": "request",
      "label": "请求命令",
      "width": 8,
      "rules": [
        { "mask": "0xf0", "value": "0x20", "label": "Read channel={3:0:dec}" }
      ]
    }
  ]
}
```

规则按顺序匹配 `(word & mask) == value`。一条规则可以展开「条件分支」。分支按顺序尝试，同一分支的所有 `when` 条件都成立才使用它的显示文本。其余情况使用该规则本身的显示文本。

```json
{
  "mask": "0x0", "value": "0x0", "label": "数据 {6:0:dec}",
  "branches": [
    { "when": [{ "mask": "0x40", "value": "0x40" }, { "mask": "0x1", "value": "0x1" }],
      "label": "命令 {6:0:dec}" }
  ]
}
```

对于 UART 串行帧，在一位 TX/RX 行选择预设，点击「编辑副本」调整波特率、数据位、校验、停止位、位序和反相。界面以完整帧标注数据，附带校验或停止位错误。规则和分支匹配的是串行帧的数据字，而掩码的有效位宽来自数据位设置。UART 帧标注从仿真起点追踪起始沿，单次读取最多 100000 条信号事件。波形时间分辨率需要每比特至少两个 tick。

标签里的位段使用 `{高位:低位:格式}`，格式可选 `hex`、`bin`、`dec`、`signed`。修改配置文件后，重新在选择器里应用该配置即可更新绑定。工程会保存每个信号应用的配置，重开工程可恢复该版本。

「信号 → 标签和注释」为选中的信号添加逗号分隔的标签和多行注释。信号行悬停及波形悬停可查看注释。筛选框可输入 `tag:ID` 等标签。标签与注释随 `.waveproj` 保存。

Tcl 和 MCP 的 `wave_tcl` 可使用 `waveDecode list`、`waveDecode set signal decoderId`、`waveDecode clear signal`、`waveDecodeEvents signal start end ?limit?` 和 `waveAnnotate signal ?commaSeparatedTags note?`。`waveDecodeEvents` 的事件项包含时间、原始二进制值和解码结果。UART 串行配置返回 `frames`，其中包含帧的起止时间、数据字、错误和文本。

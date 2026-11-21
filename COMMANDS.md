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

打开工作区后，启用 `waveWorkbench.mcpEnabled` 并重新加载 VS Code。MCP 客户端在运行 VS Code 工作区扩展宿主的机器上，通过 stdio 启动 `node <插件路径>/dist/mcp.js <工作区绝对路径>`。Unix 主机使用用户私有 socket，Windows 使用本地命名管道。Remote SSH 使用远端扩展宿主与远端 MCP 进程。

同一工作区有多个 VS Code 窗口时，用工具的 `waveform` 参数指定已打开的波形绝对路径。发现过程跳过损坏的注册记录和无响应的窗口。

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

## RTL 追踪与波形证据

使用支持 RTL Trace schema 1 的 VIDE 开发版本。选中波形信号后，可从「追踪」菜单打开驱动、负载或 A 游标处的证据报告。光标位于 RTL 信号上时，也可从命令面板追踪驱动或负载。报告包含 Mermaid 图源码、赋值位置和依赖来源。 [RTL 追踪快速入门](RTL_TRACE_QUICKSTART.md)

1. 打开波形并确保它关联同一次仿真的 VCS KDB 或 Verilator 展开 JSON。选中一条信号。VIDE 用对应的 RTL 和编译配置定位赋值、读取及控制关系。
2. 选 **追踪驱动** 查看谁写入这条信号及其输入，选 **追踪负载** 查看谁读取这条信号及其下游。要分析一个具体时刻，把 A 游标放到目标时间，再选 **查看 A 游标追踪证据**。时间追踪将静态关系与实际波形样点对照，遇到预算或缺失证据时会标注缺口。
3. 左侧 **RTL Trace** 顶部显示本次目标的完整信号路径、波形文件、追踪方向或时间 tick。展开结果可定位 RTL。右键 Trace 节点可跳转源码或把对应信号加入波形。右键赋值行会添加赋值的目标信号。同名的 **打开本次追踪原理图** 按钮会显示这份结果。


| MCP 工具 | 用途 |
| --- | --- |
| `wave_trace_drivers` | 从指定波形信号递归查找上游赋值、数据、控制与触发关系 |
| `wave_trace_loads` | 从指定波形信号追踪其下游负载 |
| `wave_trace_context` | 在驱动追踪上附加指定 tick 的波形值、可选历史和未映射项 |

三个工具均接收完整 `signal` 实例路径，可指定 `waveform` 和查询预算 `maxDepth`、`maxSignals`、`maxAssignments`。使用 `format: "mermaid"` 附加依赖图源码，使用 `detail: "full"` 附加详细 Markdown 报告。提供历史窗口时，报告还会附上最近一次可观察值变化、可能的直接赋值、相关边沿、守卫结果和有界时间图。波形证据足够时，报告给出整信号赋值的 RHS 计算值、观测值及参与求值的输入。求值涵盖四态常量、固定位选和切片、拼接、基本逻辑和按位运算、相等比较、三目和基础加减，使用 VIDE 提供的可验证类型位宽规则及有符号属性。Verilator JSON 可解析直接端口连接、固定位选和固定 packed 切片，Verdi NPI KDB 支持直接信号端口。查询遇到尚未建模的 Verilator 端口表达式时，结果会显示对应的追踪前沿。

以下参数查询 `wave_trace_context` 的波形观测。将 `historyStart` 设为 `"auto"` 可从根信号最近一次采样事件附近选取有限历史，并单独返回指定游标处的值。

静态图中的 `feedbackEdges` 列出闭合环路的边。Mermaid 给相关赋值加虚线边框，详细报告列出信号和对应源码。

`staticCoverage` 报告本次查询的范围和停止原因。达到预算时，可以用 `stops` 中带实例路径的波形信号再次调用 Driver 或 Load 查询。

若端口连接已出现在展开数据库中，但其声明无法与 VIDE 核对，追踪会返回已解析的关系和 `partial` 覆盖状态。`staticCoverage.stops[].locations` 可定位已知的连接或缺口，Trace Explorer 的端口提示可直接跳转到连接源码。

大型静态图可通过 `pageSize` 分批读取，每页最多 128 条赋值。下一次使用相同的信号和查询预算，并传入 `page.nextCursor` 作为 `pageCursor`。每页包含相关信号，`page.assignmentOffset` 可用于拼接完整图。图发生变化时需要从首页重新查询。

到达静态遍历预算时，`staticCoverage.stops[].continuationSignals` 给出已与当前波形核对的带位下标路径，可以直接作为下一次 Driver 或 Load 查询的 `signal`。整信号可使用 `canRetrace` 为真的停止项中的 `path`。路径采用波形层级名称，包括已配置的层级映射。前沿信号未 dump 或无法核对时，停止项带有 `waveformUnavailable`，并保留 RTL 位置或路径供检查。每页均保留前沿节点的信号信息。

同一总线只采集部分位时，已采集位仍可自动续查。缺位以 `unavailableBits` 保留在 `staticCoverage.stops` 和合并图 `gaps` 中。即使待查队列耗尽，覆盖仍为 `partial`。位依赖可使用修改版 VIDE 提供的固定字面量声明范围，或用 VCS KDB、Verilator 展开树提供的一维总线实例范围。

在时间因果图中，若 RTL 声明范围已确认，`waveformBitsUnavailable` 表示表达式需要的位未包含在波形采样中。图仍保留已采集位的观测和续查入口。需要缺失位的表达式求值保持未确认。

Trace Explorer 在可续查的静态前沿显示 **Continue from**。在合并静态图中选择待查信号或位时，只续查该分支，并将结果接回原图。重新打开 VS Code 后，已保存且通过输入核验的静态图也支持这项操作。

`wave_trace_drivers` 和 `wave_trace_loads` 可传入 `followContinuations` 自动续查，取值为 0 到 8，表示根查询之后最多执行的不同信号查询数。设为 0 时可在续查前用 `output: "paged"` 查看静态前沿。深度、信号数和赋值数预算分别应用于每次查询。`staticContinuationWalk` 包含各次查询的静态图、前沿链接、未查入口及停止原因。链接的 `segment` 和 `nextSegment` 使用 0 表示根查询，其余编号按续查顺序排列。`format: "mermaid"` 附加总览，`detail: "full"` 附加每段依赖图及源码位置。波形源码菜单的 **自动续查上游驱动** 使用四次续查预算，并在 VS Code 打开报告。

`staticContinuationGraph` 将根查询和续查合成一张静态依赖图。相同实例中的同一声明共用节点，赋值保留读写位、源码位置和 `sources` 中的原始查询编号及赋值索引。未解决的停止项保存在 `gaps`，并在 `staticContinuationGraphMermaid` 中以虚线连接。涉及位投影时，`feedbackScope` 为 `segmentsAndKnownBits`，反馈来自原始查询或可跨段核对的位依赖。详细报告也包含合并图。

Driver 和 Load 查询可用 `output: "graph"` 获取静态依赖图、覆盖状态和各续查段摘要。结合 `pageSize` 可分页读取合并图，每页最多 128 条赋值。赋值、信号和反馈边使用整张图的编号。使用 `page.nextCursor` 翻页时沿用相同信号、编译配置和遍历预算。可同时请求 `format: "mermaid"` 查看本页，或用 `detail: "full"` 获取完整 Markdown 报告。

静态查询返回 `continuationCursor` 时，调用 `wave_trace_resume` 可将下一批 Driver 或 Load 结果接入同一张依赖图。默认输出合并图与续查摘要，也可请求 Mermaid 或 `output: "report"`。Trace Explorer 的 **Combined static dependencies** 提供同样的 **Continue next batch** 操作，保留根信号、方向和源码证据并打开更新后的报告。

在 VS Code 运行 **自动续查上游驱动** 后，可在 Trace Explorer 的 **Combined static dependencies** 沿已查询到的关系展开。点击赋值可跳转源码，信号行的 **+** 可将信号或当前选中的单个位加入波形。仍可继续查询的停止项保留 **Continue from**。

MCP 客户端可取消进行中的 Trace 查询，桥接进程会释放该请求的连接，扩展会取消 VIDE 查询及尚未发出的波形批次。见 [MCP 取消通知规范](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation)。

Trace Explorer 的 **Observed transitions** 列出时间因果图中的变化。选择一行会定位波形 A 游标，展开该行可打开关联赋值的源码。移动 A 游标会刷新侧栏的值和时间证据。

运行离线或在线的自动续查后，Trace Explorer 的 **Combined time graph** 从原查询的变化开始显示因果路径。展开赋值可查看上游采样和已接上的续查，选择采样可定位波形 A 游标，选择赋值可打开其对应的 RTL。**Remaining trace gaps** 提供尚待续查及无法核对的证据。合并图固定在原查询的时间点，选中上游采样后仍可继续展开。

合并 Mermaid 时间图的证据边会标出对应的 RTL 赋值。比如 `S2/A5` 表示第 2 次续查的第 5 条赋值，`S0` 表示根查询。详细 Markdown 的 **RTL assignment source index** 列出实例和源文件行列。MCP 分页的 `assignmentSources` 可按 `segment: 2` 和从 0 开始的 `assignment: 4` 查到同一位置。

**Remaining trace gaps** 在缺口超过 128 条时按范围分组。展开一组即可检查对应缺口，带续查入口的缺口行仍可直接发起查询。

合并时间图的 `gapSummary` 和分页 `graphSnapshot.metadata.gapSummary` 按原因统计已接合、待查、未匹配和未解决的缺口。详细报告显示同一张汇总表。多个缺口可共享同一个待查入口，因此 `pending` 统计缺口，`frontier` 列出不同的续查请求。遇到 `gapBudget` 时，汇总只覆盖已保留的缺口。

当自动历史搜索能沿连续采样回溯到 tick 0，且总线只变动过其他位时，位级续查可以接回该位的初始波形采样。合并时间图的节点带有 `initialSample: true`，Mermaid 和 Trace Explorer 会标注初始采样。搜索未覆盖到起点或首次采样晚于 tick 0 时，沿用可核实的历史和缺口。

`unprovenInitialOrder` 表示输入有 tick 0 的初始采样，求值时是否已经读到该值仍待核实。缺口保留采样值、关联的 RTL 赋值及目标时间节点，详细报告和图表显示同一原因。

传入 `executionLog` 后，初始波形采样可以关联同槽中可核实的提交。`initialSampleMatched` 表示记录确认了初始值的写入。对于整条 packed 总线，`initialPackedSampleMatched` 表示部分或全部位已按回调查到改变该位的提交，图中标出每次提交贡献的位段及仍未核对的位。若探针记录了赋值求值时的操作数，时间图会显示实际读取的值。完整的执行覆盖可把该值进一步连接到本次求值前已确认的同槽阻塞写入。

在线 `wave_live_trace` 在分页响应中返回 `executionReplayMatch`。根信号和上游各自核对在线事件序列。合并图标注操作数的采集求值序号，以及已确认写入的求值和提交。

有绑定核对结果的 `unmapped` 缺口带有 `bindingIssue`。`gapSummary.byBindingIssue` 统计未找到波形、波形类型不支持、重名、设计库查找失败、源码位置缺失和声明不匹配等情况。详细报告的 **Waveform binding issue** 表显示相同的细分。

修改版 VIDE 可返回 `packageParameterValue`，包含 RTL package 参数的位串、符号和声明关联。时间图将已确认的参数用作数据与守卫的操作数。无法求值时返回 `packageParameterValueUnavailable`，并保留声明位置。

VIDE 用 `instanceParameter` 标记可在展开时决定的参数。独立 KDB 或 Verdi NPI 提供参数值时，Wave Workbench 核对实例和声明后返回 `instanceParameterValue`，并用实际展开值核对数据和守卫。Verdi NPI 桥接保留整型及位向量参数的位宽、符号和 X/Z。当前提供方无法确认值时，时间图返回 `instanceParameterValueUnavailable` 和 RTL 声明位置。

修改版 VIDE 可为位宽已确认的枚举提供 `enumValue`。支持同宽整数位串、可核对的 package 参数位宽、有符号值的补码，以及从零或已知值开始的隐式递增。最多 128 位且无 X/Z 的整数初始化表达式支持混合位宽、一元 `+`、`-`、`~`，以及加、减、乘和按位与、或、异或、同或。表达式可引用解析到的包枚举项、以整数字面量初始化的推导类型包参数，以及声明位宽和初始化表达式都可核对的包参数。嵌套有符号运算若可能因仿真器的扩展方式而改变值，会在追踪中保留为缺口。时间图将已确认的 RTL 常量用于赋值和守卫核对，并保留枚举项声明位置。

字面量枚举范围支持 `NAME[N]` 和升序或降序的 `NAME[N:M]`。值沿声明顺序递增，各生成项共享原声明位置。遇到无法确认的初始化表达式或范围时，递增序列从下一个可确认值恢复。

修改版 VIDE 返回 `enumValueUnavailable` 时，时间追踪将该枚举项计入同名缺口，并保留枚举声明位置。MCP 的 `gaps`、Mermaid、详细报告、Trace Explorer 与追踪原理图均显示该原因。波形绑定统计继续用于波形对象。

有执行记录时，合并时间节点的 `recordedWordEvidence` 按查询段和段内节点保留整字的写入、待确认位范围和同槽回调。Mermaid 和 **Recorded packed word evidence** 报告显示实际提交与贡献的位段。Trace Explorer 的赋值行和追踪原理图的提交节点可以定位对应 RTL。

游标处的采样值保持时，`wave_trace_context` 的 `cursorWriters` 可显示触发和守卫是否排除已列写入路径，以及是否存在同值写入候选。匹配的执行记录可核对实际提交。当完整执行记录和波形共同确认最近一次提交是同值写入时，离线及在线时间图可从该提交回溯。根节点返回 `sameValueWrite: true`，并附提交序号、求值时刻和赋值索引。自动历史窗口可围绕提交时刻采样，显式 `changeOrder` 仍指向所选波形变化。

查询 `TOP.signed_tb.q[2]` 这类单个位时，动态分析使用该位的波形，并排除已知写入范围与该位无交集的候选。需要完整总线的反馈会出现在时间图的观测缺口中。

从标量输出回溯时，已解析的固定 packed 读取也会限制上游路径。例如 `assign result = bus[1]` 的 Driver 图沿 `bus[1]` 找写入该位的赋值，时间图采用该位自己的变化历史。波形或设计缺少范围信息时，时间图保留信号级依赖。

`context.temporalTrace.gaps` 给出上游信号、可选位下标、tick 和停止原因。`use` 指向时间图中受影响的节点及静态赋值，可核对缺的是数据、控制条件还是触发边沿。Mermaid 用虚线表示缺失证据，详细 Markdown 列出对应的 RTL 位置。离线追踪遇到节点或边预算时，已绑定到波形的变化缺口可带有 `continuation`，可直接把其中的 `signal`、`tick` 和可选的 `changeOrder` 用于 `wave_trace_context`，也可在 Trace Explorer 中选择 **Continue from**。`changeOrder` 从 1 开始，表示选定信号或位在该 tick 内的变化次序。`context.selectedTransition` 返回所选变化，`observations` 仍给出游标采样。个别缺口因返回预算省略时，`gapsTruncated` 和信号级摘要会一起返回。

图表超过 Mermaid 默认渲染上限时，单页字段仍返回第一页。静态图、时间因果图、波形观测和附带的执行图分别通过 `mermaidPages`、`temporalMermaidPages`、`observationMermaidPages` 和 `executionMermaidPages` 返回全部页面。单独调用 `wave_execution_trace` 时，执行图使用 `mermaidPages`。详细 RTL 报告嵌入静态图、时间因果图与波形观测图的全部页面。跨页复用节点编号，`pageCursor` 仍用于翻阅静态赋值数据。

VCD 或 FST 在同一 tick 记录根信号的多次变化时，`assignmentCandidates.changesAtTick` 返回该信号的观测顺序，`temporalTrace.rootNodes` 指向各次变化，最近一次排在首位。时间图为每次变化保留可能的上游数据和匹配的触发边沿。同一 tick 的候选边标记为 `sameTickUnordered`。已记录的单信号顺序只用于展示观测和筛选边沿。

```json
{
  "signal": "TOP.trace_tb.dut.owner_q",
  "tick": "7",
  "historyStart": "1",
  "format": "mermaid",
  "detail": "full"
}
```

从命令面板运行 **Set Simulation Filelist for Active Waveform Trace**，选择仿真使用的 filelist 和相对路径的解析目录。关联记录在当前 VS Code 工作区，也可随 `.waveproj` 保存。追踪时修改版 VIDE 自动生成临时 `vide.toml` 并启动隔离会话，按指定顺序加载 TB、RTL、include 路径和宏，也可将 Verilator `-G` 的顶层参数覆盖传给 Slang。若仿真命令另外传入宏、顶层或参数，可用外层 filelist 引用原始清单并列出附加选项。库、编译单元和无法转换的参数出现在详细报告中。MCP 请求也可以传 `filelist` 和可选的 `simulationDirectory` 单次选用构建。

**Preview VIDE Project from Simulation Filelist** 显示追踪实际使用的 `vide.toml`，含按编译顺序排列的绝对路径、工作区外的生成源码及未转换选项。活动波形已关联 Verilator 展开树或 VCS KDB 时，预览也会列出设计实际使用的库源码。

静态 Driver / Load、离线 `wave_trace_context` 和 `wave_live_trace` 可指定 `buildManifest`，格式为 `wave-workbench-build` 且 `schemaVersion` 为 `1`。清单记录 `waveformSha256`、按仿真顺序列出的 `roots`、含 `path` 和 `sha256` 的 `files`、`include_dirs`、`top_modules`、`defines`，以及可选的 `parameter_overrides` 和 `unsupported`。相对路径以清单目录为基准。请求中的 `filelist` 或 `videManifest` 优先，其次是波形已关联的配置，再次是显式 `buildManifest`。直接使用构建清单时，插件自动生成本次查询的临时 VIDE 配置。静态与离线查询可返回 `buildVerification`，离线报告还给出匹配状态与差异。发现明确差异时，离线查询保留波形观测。

离线和在线查询的 `context` 及 `temporalTrace` 当前使用 `schemaVersion: 1`。`context.provider.sampling` 表示采样来源，时间图的 `coverage.reasons` 列出遍历预算、历史窗口、缺失采样、静态关系或编译输入缺口。`resolvedWithinWindow` 表示在当前范围内未发现这些缺口，具体路径的置信度和执行归因仍由各边和事件提供。

要让 MCP 从一个信号尽量展开可达关系，可在静态、离线或在线追踪请求中传入 `expandReachable: true`。未显式传入的静态限制采用深度 256、信号和赋值各 4096 的上限，动态时间图上限为 1024 个节点和 4096 条边。显式的静态预算优先。遇到预算、未解析关系或证据缺口时，响应会保留已有结果并标明停止原因。

`wave_trace_context` 和 `wave_live_trace` 可通过 `maxTemporalNodes` 与 `maxTemporalEdges` 调整时间图预算，分别最多 4096 和 16384。用 `maxTemporalGaps` 可独立设置每段保留的缺口数，默认等于边预算，最多 16384。缺口达到预算时优先保留不同的续查入口，并用 `gapBudget` 标记省略了部分记录。多个候选赋值连接同一对时间节点且证据属性相同时，会共用一条边。边的 `assignment` 和可选的 `alsoAssignments` 保存全部对应的静态赋值编号。

仿真构建也可在波形旁写入同名清单，例如 `trace.fst.wave-build.json`。当查询没有显式或已关联的配置时，插件会自动检查清单与波形的 SHA-256，再加载其 TB、RTL 和编译选项。原有 filelist 关联仍优先。

构建清单只记录了部分编译文件的哈希时，可设置 `"files_complete": false`。VIDE 加载的其余文件会逐项列入核验限制，构建状态为 `unverified`，仍可查询波形时间因果。清单中已列文件缺失或哈希不同，以及编译根、库、宏、顶层或参数发生冲突，仍返回 `mismatched`。完整的哈希清单使用 `true`，省略此字段时默认按完整清单核对。已注明 VCS 重建元数据缺少头文件哈希的旧清单也支持部分核验。

已选 filelist 或 `vide.toml` 时，匹配波形的同名清单仍可用于核对实际编译配置和源码。头文件被替换或删除时，时间追踪保留波形观测，并报告构建差异。若波形旁的清单属于别的仿真，显式选择的项目仍可用于查询。

附加 VCS KDB 后，缺少显式配置和波形清单时，插件可从 VCS 生成的 `vcs_rebuild` 恢复顶层、宏和 filelist，生成隔离的 VIDE 配置。相对路径优先按 `simv.kdb` 记录且与输出路径吻合的编译目录解析，支持源码与 `simv` 产物放在不同目录。编译命令省略 `-top` 时可采用 `simv.kdb` 记录的实际顶层。报告列出元数据来源、采用的编译目录及未映射的选项。选择工作区 VIDE 配置可关闭当前波形的自动发现。

VCS `-timescale=1ns/1ps` 写入构建清单和隔离 VIDE 配置的 `default_timescale`。当前修改版 VIDE 将其用于缺少显式时间声明的设计单元，并在 `compilation.defaultTimescale` 和详细报告中返回该配置。构建核对比较两端的默认时间尺度，波形图的 tick 单位由 VCD、FST 或 FSDB 文件提供。旧清单缺少这一字段时，如果实际配置有默认时间尺度，报告会标为 `unverified`。尚未映射的时间覆盖选项继续列为构建限制。

VCS `-P` 指定的 PLI 表及其链接对象会出现在项目配置预览和追踪报告中。用 `record-trace-run.mjs --vcs-kdb` 启动仿真时，记录可读取文件的 SHA-256 和表中声明的系统调用名称。MCP 的 `buildVerification.vcsPli` 返回各文件相对于本次记录的状态。时间图的 `externalPliCallbacks` 表示回调引起的写入、读入及调用顺序仍缺执行证据。

修改版 VIDE 通过生成配置的 `external_system_calls` 接收 PLI 调用名称。可直接赋值的实参会成为候选读写目标，算式中的信号作为候选输入。Driver、Load 和时间图可定位调用源码。实参访问方向和回调内部行为继续保留为 `unresolvedSubroutineEffects`。

对于可修改 C 源码的同步 PLI 回调，可用 `generate-vcs-pli` 建立调用点和 C 步骤映射，在回调中用 `wave_workbench_pli_evaluate` 与 `wave_workbench_pli_complete` 包住选定的信号写入。探针核对仿真实例与调用行，并采样写入后的实际值。用 `seal-vpi` 封装后，MCP 的 `executionLog` 可将匹配的提交、实参采样和 C 步骤接入时间图与报告。 [VCS PLI 复现步骤](test/fixtures/trace/README.md#vcs-pli-synchronous-write-probes)

`record-trace-run.mjs --vcs-kdb` 直接运行对应的 VCS 可执行文件时会记录可执行文件的 SHA-256，并记录已识别的 Wave Workbench VPI 采集库哈希。在线 `wave_live_trace` 可以用这份波形清单和封装执行日志核验已采集的轨迹。`buildVerification.executionReplayEligible` 表示构建允许尝试逐事件比对，`executionReplayMatch` 返回实际比对结果。已匹配的回调可以归因，整体报告仍保留外部回调覆盖缺口。

VCS 自动配置同时核对 `vcs_rebuild` 和 `simv.kdb`。任一文件变化都会使已加载的 VIDE 会话失效。VIDE 查询进行中发现输入变化时会停止该次查询，下一次查询按当前元数据恢复配置。

TB 的生成模块可列入 `roots`，生成模块和生成头文件的哈希均可列入 `files`。`include_dirs` 应包含仿真实际使用的生成头文件目录。`detail: "full"` 会在 Markdown 中定位 `$test$plusargs`、`$value$plusargs`、`$readmemh` 和 `$readmemb` 的调用点。运行输入缺少可核对的证据时，MCP 的 `frontier` 返回 `unresolvedRuntimeInput`，时间图保留已观测的信号值。

如果主 filelist 引用的子清单尚未生成，追踪会加载其余可用源码，并在预览、MCP 和详细报告中列出缺失路径。子清单出现后，下一次查询会重新加载关联波形的 VIDE 配置。

filelist 中列出的生成 RTL 暂时缺失时，跨端口追踪保留可解析的关系和波形观测，并报告缺失源码及未解析的端口。已列出的源码或库文件出现、替换或修改后，下次查询重新加载隔离的 VIDE 会话。该检查也覆盖文件大小和修改时间保持一致的原子替换。

可用 `scripts/record-trace-run.mjs` 启动仿真并生成运行对应的波形清单。脚本以当前目录启动仿真，从已有的 Wave Workbench 编译清单读取源文件与编译选项，记录传入的 plusargs，并对每个 `--input` 文件在仿真前后核对 SHA-256。

```sh
node /path/to/scripts/record-trace-run.mjs --manifest build.json --waveform runtime.fsdb \
  --input stimulus.hex -- ./simv +ENABLE +MODE=3
```

`--vcs-kdb simv.daidir` 可直接从本次 VCS 构建的重建元数据读取编译根、顶层、宏、库和 include 路径，包含实际编译的生成 testbench。可以同时提供 `--manifest` 复用已有的编译时哈希。如果 KDB 带有 `debug_dump/src_files_verilog`，脚本也保留其中所列 include 的编译时哈希。只有 VCS 源文件清单覆盖编译根与库文件，且现有清单提供完整哈希时，才记录 `files_complete: true`。仿真期间的重建元数据、清单或源码变更会使脚本拒绝写入清单。从源码目录运行此选项前先执行 `npm run build`。

```sh
node /path/to/scripts/record-trace-run.mjs --vcs-kdb simv.daidir --waveform waves.fsdb \
  --input stimulus.hex -- ./simv +ENABLE +MODE=3
```

生成的 `runtime.fsdb.wave-build.json` 包含 `runtime.workingDirectory`、按传入顺序保存的 `runtime.plusargs` 和带哈希的 `runtime.files`。手工编写清单时，运行目录以清单所在目录为基准，激励文件以运行目录为基准。空的 plusargs 数组表示本次启动未传入 plusargs，省略该字段表示未记录。离线查询在 `context.runtimeInputs`、时间图、详细报告及 Trace Explorer 显示可对应到源码字面量的输入。文件状态包括 `matched`、`mismatched`、`missing` 和 `unverified`。调用是否执行、文件是否读取成功仍由波形或执行记录核对。

调用 DPI import 时，Driver / Load 按 SystemVerilog 原型区分输入和输出参数。详细追踪保留调用位置与波形值，外部实现的执行过程列为 `unresolvedSubroutineEffects`。

过程循环的 Driver / Load 图保留循环条件、时钟触发和 `for` 步进中的依赖。离线追踪用 `unresolvedProceduralLoop` 标出循环迭代缺口，用 `unresolvedUpdateEvaluation` 标出前置或后置自增、自减的求值顺序缺口。详细报告包含相应源码位置。

过程 `#delay` 和 `wait` 的控制输入进入 Driver / Load 图。MCP 用 `unresolvedProceduralTiming` 标出当前波形无法重建的调度，并在详细报告中定位延迟或等待的源码。

VCS filelist 可用 `-top tb` 选择 TB，再用 `-pvalue+tb.Mode=1` 或 `-pvalue+tb.dut.Mode=1` 覆盖指定顶层或 DUT 实例的参数。多个顶层存在时，参数仍按完整路径限定作用域。同一路径多次出现时取最后一个值。实例数组和 generate 路径支持十进制下标，例如 `tb.bank[1].Mode` 和 `tb.lanes[-1].u.Mode`。转义标识符等无法映射的路径会列在编译缺口中。详细报告和 MCP 的 `compilation` 字段均显示 VIDE 加载的顶层、全局宏、include 目录和参数覆盖。

VCS 仿真可将 `[01]` 视为 `[1]`，而 KDB 可能忽略前一种写法的覆盖。最后一次参数覆盖使用这类下标时，插件以标准化的路径生成 VIDE 配置。附加 KDB 的查询保留单文件静态图和波形值，并在报告中说明因果分析暂缺可核对的展开依据。

同一命令可选择现有 `vide.toml`、切回自动加载清单，或显式选用工作区的 VIDE 配置。选择的 `vide.toml` 以自身所在目录解析相对路径，MCP 也可传入 `videManifest`。选择工作区配置后，波形旁的自动清单停用。该选择可随 `.waveproj` 保存。

filelist 中的源文件、嵌套清单和 include 路径可引用 VS Code 扩展进程环境中的 `$VAR`、`${VAR}` 或 `$(VAR)`。缺失的变量会列为编译输入缺口，已有源码仍可追踪。仿真时使用独立环境的构建可提供含实际解析路径的构建清单。 [Verilator 的 filelist 参数说明](https://verilator.org/guide/latest/exe_verilator.html#cmdoption-f)

filelist 中的 `-v` 可加载明确列出的库源码。构建清单也可用可选的 `library_files` 列出实际参与编译的库文件，并在 `files` 中记录其内容哈希。修改版 VIDE 将这些库源码作为独立单元解析，MCP 的 `compilation.libraryFiles` 和详细报告会列出实际加载的库。 [Slang 的源库说明](https://www.sv-lang.com/user-manual.html#source-libraries)

波形关联 Verilator `.tree.json` 或 VCS KDB 时，插件用展开结果恢复 filelist 的 `-y` 和 `+libext+` 选择的 `.sv`、`.v` 源码，并写入隔离 VIDE 配置。MCP 的 `simulationProject.resolvedLibraryFiles` 记录展开数据的类型、路径及选中的库文件。VCS 的 `-y` 目录只参与模块查找，头文件目录仍取自 `+incdir+` 等编译选项。缺少设计数据库或来源查询不可用时，报告列出相应的编译缺口。可用构建清单的 `library_files` 核对实际选择。 [Verilator 模块查找规则](https://verilator.org/guide/latest/verilating.html#finding-and-binding-modules)

构建清单和 `vide.toml` 可用 `compilation_units` 指定有序文件分组。分组按顺序恰好覆盖 `roots` 或 `source_files`。例如 `[["rtl/defs.sv","tb/top.sv"],["rtl/debug.sv"]]` 让前两个文件共享编译单元，同时独立解析第三个文件。带有 `--single-unit` 的 filelist 将普通源码放入同一组，`-v` 库文件保持独立。MCP 的 `compilation.compilationUnits` 返回实际分组，构建核验会报告分组差异。 [Slang 编译单元说明](https://sv-lang.com/user-manual.html#compilation-units)

`compilation_unit_options` 按分组顺序为每个单元指定 `defines` 和 `include_dirs`，没有附加配置的单元可用空对象。用 filelist 的 `-C` 引入 Slang 编译单元清单时，插件会从清单导入单元专属的宏和 include 目录，路径相对于该清单。MCP 的 `compilation.compilationUnitOptions` 及详细报告显示这些配置，构建核验同时比较配置和实际加载的头文件。 [Slang 单元清单说明](https://sv-lang.com/user-manual.html#compilation-unit-listing)

filelist 的 `-work` 可为后续显式源码指定库。`-libmap` 解析 `.map` 内相对该文件的精确路径、通配符和目录规则，`-work` 中指定的非默认库优先。构建清单和 `vide.toml` 也可用 `source_libraries` 提供各文件的 `path` 和 `name`，用 `library_maps` 保留映射文件及其中的 IEEE `config`。构建清单的 `files` 记录映射文件哈希。波形追踪沿 Verilator 展开绑定定位同名模块，构建核验比较库归属、映射文件和内容。未支持的映射声明会出现在编译缺口中。 [Verilator 模块查找规则](https://verilator.org/guide/latest/verilating.html#finding-and-binding-modules) · [Slang 源库说明](https://www.sv-lang.com/user-manual.html#source-libraries)

追踪关联了 Verilator 展开树的波形时，命名的 `if/else generate` 和 `case generate` 可按实际实例筛选赋值。MCP 的静态图和时间图都使用筛选后的关系。无名分支、循环中的分支或缺少可核对的展开位置时，图保留相关候选并标为 partial，停止原因是 `unresolvedGenerateBranch`。 [Verilator 展开树](https://verilator.org/guide/latest/exe_verilator.html#cmdoption-json-only)

Verilator 展开树也可绑定 `instance.signal` 形式的层次读取。Driver 追踪继续定位该信号的赋值和上游端口。Load 追踪可核对展开设计中读取该信号、写入单个本地信号的赋值。两个实例共用同一 RTL 声明时，图按实际实例区分输入。无法核对实例或使用点时，结果可标记 `unresolvedHierarchicalRead` 或 `unresolvedHierarchicalLoad`。

对可映射的层次写入，Driver 回到写入点，Load 沿实际被写入的实例继续追踪。MCP 的 `hierarchicalTargets` 包含目标图节点和写入点位置。写入无法与实际实例核对时，可返回 `unresolvedHierarchicalWrite`。

命名接口的 modport 可沿 Verilator 展开树追踪直接数据成员及指向单一成员的别名，例如 `.rx_data(datum)`。MCP 图以实际接口实例的成员作为节点，保留读写端点的源码位置。使用同一源码生成的 Verilator 展开树，已核对 VCS 和 Xcelium 的 VCD。

选择 VCS KDB 时，独立读取器和 Verdi NPI 均可定位接口成员的实际实例、声明和接口类型定义。使用 Verdi NPI 时，指向单一成员的 modport 别名也可通过 KDB 追踪到跨文件的写端与读端。MCP 可以从 FSDB 展示的别名或底层成员发起查询。

独立 KDB 读取器也可沿普通模块的命名、位置、简写和 `.*` 端口连接追踪跨实例信号。普通输入端口支持嵌套拼接、常量次数的重复拼接、加减和按位 `&`、`|`、`^`、`~`，操作数可为信号、位选、定宽范围选和定宽字面量。Driver 和 Load 图保留实际操作数，详细报告显示表达式的源码行及拼接顺序。无法展开的连接会报告 `unresolvedPortExpression`。

独立 KDB 也可追踪一维 packed 固定范围、固定 `+:` 或 `-:` part-select 以及单个位选。普通模块输入端口的动态位选和定宽 `+:`、`-:` 可使用单个信号或上述受支持的表达式作为起始索引。Trace Explorer、静态图和时间图均标出数据与各索引操作数，波形追踪保留四态取值。报告记录端口位宽变化和二态转换，整数和四态字面量按端口宽度显示。暂未解析的端口表达式会保留 `unresolvedPortExpression`。

Verdi NPI KDB 支持等宽固定位选和固定切片，也可追踪实例数组中各端口连接的总线位段。循环 generate 中的端口位选可使用 NPI 为各实例返回的已求值下标，包括负下标、genvar 和局部参数表达式。

对等宽输入端口的运行时位选或定宽范围选，插件可从同一 KDB 的独立读取器恢复表达式。只有端口两端、连接文件和行号及位宽均匹配，且对应的表达式唯一时，Driver、Load 和时间图才使用该表达式。时间图用波形标明运行时索引及所选数据位。索引同 tick 变化时保留调度候选。无法核对的连接继续返回 `unresolvedPortExpression`。

NPI 模式也可从同一 KDB 恢复已识别的普通输入端口组合表达式，包括嵌套拼接、重复拼接、按位运算和带运行时索引的读取。插件核对目标端口、连接位置、两端位宽及 NPI 提供的操作数。图和详细报告保留操作数顺序、索引依赖及符号扩展、截断和二态转换。

NPI 模式下，字面量输入会在 Driver 图和详细报告中显示为实际驱动该端口的常量。插件核对原始四态值、符号属性和端口位宽。对于实例数组，图中显示每个成员按声明顺序分到的位段或收到的广播值。

独立 KDB 和 Verdi NPI 均可追踪普通模块的固定输出拼接，例如 `.q({upper[2:1], lane[1:2], {tail_a, tail_b}})`。各目标按拼接顺序与输出端口的低位对齐，保留升序和降序的位号。目标拼接较宽时，扩展位追到符号位或常量零。目标拼接较窄时，截掉的高位没有对应的 Load。Verdi NPI 当前支持四态逻辑目标。所需的位宽、范围或符号属性无法核对时，报告 `unresolvedPortExpression`。

模块实例数组的 packed 端口按实例声明顺序和信号位序分割。Driver 图会列出每个实例对应的输出位段及分配到的定宽常量，Load 图会列出接收广播输入的每个实例。数组端口宽度无法核对时保留追踪缺口。

循环 generate 中的模块端口使用各展开实例的局部整数参数解析位映射。运行时索引操作数沿每条端口边进入 Driver、Load 和时间图。MCP 可用 KDB 形式的负下标实例路径查询对应的 VCS FSDB 波形。

修改版 VIDE 与独立 KDB 可把命名循环 generate 内的连续赋值绑定到各展开实例，并筛选已展开的命名条件分支。Driver 与 Load 查询显示独立的局部信号和共享的父级信号。无法核对展开位置时，图保留候选并标记 `unresolvedGenerateBranch`。

修改版 VIDE 回传匿名条件 `generate` 子句的源码范围。Verilator JSON 以文件、行和字节列核对具体实例的子句。VCS KDB 的独立后端与 Verdi NPI 在生成作用域的文件和行能够唯一对应子句时使用该分支。多个匿名子句共用同一行时，KDB 图保留候选并标记 `unresolvedGenerateBranch`。Driver、Load 和时间追踪共用该分支证据。

VCS KDB 和 Verilator JSON 可追踪循环 generate 内使用 genvar 的连续赋值。Verilator 用各迭代的源码位置和父作用域核对命名及匿名块。VCS KDB 使用唯一源码行核对匿名块。Driver 与 Load 图记录每个实例写入的位，MCP 单比特时间追踪沿相应迭代回溯，详细报告保留 genvar 值。VCS 将生成作用域写进 VCD 信号名时，时间追踪按完整路径绑定到 KDB 声明。

`wave_trace_drivers` 和 `wave_trace_loads` 的 `signal` 可指定一维 packed 总线中的单个位或固定范围，例如 `packed_feedback_tb.ascending_bus[1:2]`。范围使用声明的位序，完整声明范围可直接作为整总线信号名。静态结果按所选位传播，以 `inputs[].readBits`、`writtenBits` 和 `bitDependencies` 返回确定的读取位、可能写入的位及已解析的逐位关系。Trace Explorer、Mermaid 和详细报告显示对应的位索引。动态索引或位宽无法确定时保留可能相关的关系，超过按位预算时以 `bitTraceBudget` 报告并返回信号级关系。

`wave_trace_context` 查询一维 packed 总线的单个位时，时间图沿受支持的固定选择、拼接和逐位运算回溯上游各位的波形变化。时间节点的 `bit` 字段给出 SystemVerilog 位下标。无法静态定位到某一位的依赖保留信号级候选，同 tick 的调度顺序由可用的波形和执行证据决定。

如果赋值的数据表达式和目标位可解析，静态图和时间图会保留已知的 RHS 位路径，即使分支条件或过程时序仍待确认。报告标明控制或时序缺口，离线时间图保留候选置信度。经同构建执行记录确认的提交仍可归因到具体语句。

修改版 VIDE 会把 `force`、`release`、过程 `assign` 与 `deassign` 加入静态 Driver / Load，记录源码和可解析的数据来源。`proceduralOverride` 标出持续生效时间或恢复顺序的缺口，动态结果保留候选和实际波形值。

同模块直接调用 task 或 function 时，Driver / Load 图包含可解析的实参和沿调用链读取的模块信号。`unresolvedSubroutineEffects` 指向调用处，标记仍未展开的内部副作用。

对可求值的变量位选及定宽 `+:`、`-:`，时间图在索引于相关 tick 稳定时沿实际选中的有效数据位回溯，同时保留索引的来源。索引同 tick 变化且顺序未知时，时间图保留总线级数据候选。对整信号查询，逐位展开支持最多 64 位的写入范围，较宽范围保留信号级关系。

对有可核对触发和守卫的非阻塞赋值，若 RHS 输入在目标更新的同一个 tick 发生变化，`wave_trace_context` 可用进入该 tick 前和 tick 内的观测值比较 RHS。候选赋值的 `rhsSamples` 列出哪些样本值能产生所观测的输出，时间图保留这些候选并标注比对结果。比较覆盖最多 32 种样本组合，跨信号调度顺序仍以波形和执行记录的证据为准。

对于可求值的赋值，已核对的执行记录可以用实际 RHS 值筛选波形候选。每次比较覆盖最多 32 种输入取值组合。时间图将相符的边标为 `rhsSampleEvidence: "recordedEvaluation"`。多个输入在求值 tick 有不同可见值时，`recordedRhsCombinations` 和详细报告列出相符的取值组合。候选组合使用已观测的样本，跨信号调度仍以执行证据为准。输入不完整、含 X/Z 或超出比较预算时保留波形候选。

如果已捕获的操作数和完整写入记录能确认最近一次提交，而该提交晚于上游最近的波形变化，时间图可连接到实际的同值写入。MCP 在边上返回 `sourceWriteEvidence: "recordedSameValueWrite"`，上游节点保留提交序号、时间和源码位置。同槽还有待定写入或日志覆盖不足时，图保留波形候选。

对关联 VCS KDB 的波形调用 `wave_execution_map`，设置 `captureOperands: true` 后，符合条件的阻塞赋值和 NBA 会带有 `sampleOperands`，可交给 `generate-vcs-nba`。适用于固定写入目标、最多八个各读取一次的局部操作数。支持按位运算、移位、三元选择和单个局部变量的固定 packed 位选或位段。其他语句仍返回普通映射。探针使用保存的局部值求 RHS，并在求值事件的 `operandValues` 中记录各值。MCP 和 Markdown 显示这些值。移位量或三元条件的求值操作数齐全且位宽匹配时，时间图使用该次求值的数值确定数据位和分支。

当波形只保留 tick 0 槽末的一位初始值，回放仍可依据完整的写入记录和该位的前后值变化回调关联阻塞提交。两次回调之间须能确定哪次写入改变了该位，后续同值写入保留在执行报告中。缺少回调、写入或源码证据时保留相应的追踪缺口。

未采集操作数的波形，或波形中找不到与实录值相符的变化时，时间图在求值 tick 显示实录样本，并提供 `operandEvaluationOrdinal`。该节点记录采样值。相关波形缺口仍出现在图和报告中，操作数更早的变化需要独立的历史证据。

如果同一日志完整覆盖该操作数的写入，并能核对更早的提交及其 RTL 来源，时间图会沿该提交继续回溯输入。VCS 位段提交携带完整的 packed 下标方向，时间图可按位追到不同时间的写入。节点通过 `executionOnly` 标记执行日志证据。波形缺口仍可查看，提交时序或来源无法核对的位保留采样值。

日志连续且写入进程已声明时，已记录的未观测提交只限制其目标位的回溯。目标位未知时按整信号处理。后续独立时间点的已核实写入可恢复所覆盖位的回溯。在线匹配表示事件序列一致，写入覆盖状态仍单独报告。

在 Trace Explorer 的 **Observed transitions** 中，展开一次变化及其下的赋值，即可沿数据、控制、触发和索引逐层查看上游采样。选择采样跳到波形对应 tick，选择赋值打开 RTL。**Trace gaps** 列出不可用的历史及达到追踪预算的位置。

构建清单可用 `verilatorArtifacts.treeSha256` 和 `verilatorArtifacts.metadataSha256` 记录同一仿真构建的 `.tree.json` 和 `.tree.meta.json` 哈希。插件比对实际已载入的文件内容。任一哈希不符时，静态结果退回单文件追踪并标记 `mismatchedDesign`。静态和离线查询的 `buildVerification` 列出差异，离线和在线查询保留观测值并省略时间因果图。

在 `wave_trace_context` 中添加 `executionLog` 可附上匹配 FST 的执行记录。从波形的「源码」菜单可回放 A 游标的执行记录。MCP 也可直接调用 `wave_execution_trace`，传入 `instance`、`signal`、`executionLog` 和 `tick`，并按需输出 Mermaid 和详细报告。

VCS 可通过 VPI 为选定的信号记录值变化。同一次仿真的 VCD 或 FSDB 可用于封装记录和核对时基。MCP 的 `signal-value-changed` 事件提供实际回调顺序，详细报告逐项对照波形中的值变化。赋值组件的归因仍需求值或提交位置的证据。 [VCS 复现步骤](test/fixtures/trace/README.md#vcs-value-change-recording)

若同一记录包含可达的上游信号，`wave_trace_context` 会在 `upstreamExecution` 返回对应的 `callbackEvents`。当回调序列与节点的整条信号或所选位逐项匹配时，时间图标注 `valueChangeOrdinal`。同 tick 的依赖边可以通过 `callbackOrder` 显示源与目标回调的先后。执行图按记录序号串起回调，时间图保留赋值候选的置信度。

对同一条阻塞 modport 拼接赋值的重叠固定切片，MCP 可以根据完整的 VPI 回调筛选与该次变化相符的写入组件。位级时间图、Trace Explorer 和详细报告会标注唯一相符的范围，结构化节点同时返回 `compatibleModportComponent` 和对应的回调序号。候选筛选会比较整条目标总线和当时可能的 RHS 取值。 [VCS 复现步骤](test/fixtures/trace/README.md#vcs-value-change-recording)

用同次仿真的 `executionLog` 回放 FSDB，或使用已核对的在线执行记录时，若完整的 VPI 回调与已保留变化的顺序及槽末值一致，时间图可补入被合并的变化。有提交记录的时间槽还要核对完整的提交序列能否重现回调变化。`wave_trace_context` 和 `wave_live_trace` 均可用 `changeOrder` 选中某次变化，节点以 `restoredFromCallbacks` 标注回调来源。报告保留原始波形或在线快照的变化。

新版 VPI 记录的 `observationCoverage` 标明选定信号、开始时间和已核对的窗口。若某个信号在覆盖完整的窗口内保持稳定，回放可报告窗口内没有值变化回调。未选信号没有该覆盖项，截断记录则报告覆盖缺口。

要把执行记录和时间因果图一起查看，在「追踪」菜单选择「结合执行记录追踪 A 游标…」。波形变化顺序与实际提交匹配，且提交的源码哈希和 RTL 赋值可以唯一核对时，时间节点的 `recordedWriter` 给出赋值、提交序号和窗口内的求值位置。图从已核对的写入继续追溯输入，求值时间与提交时间不同时使用求值时间采样。同一 tick 内的输入顺序仍由波形和记录中的可用证据决定。

同一日志覆盖时间图中的上游信号时，`upstreamExecution` 返回它们各自的覆盖状态、赋值和匹配的变化。`writeEvents` 提供已到达时间点的求值、提交及未观测结果，也包含日志窗口内被这些写入引用的更早求值。位选查询按已知的 packed 声明范围选择相关事件。执行 Mermaid 按记录序号合并根信号和各级上游事件，详细报告列出上游写入的值、位范围及可用源码位置。缺少源码证据或波形合并中间变化时，报告保留候选和匹配状态。

如果确认的提交和求值时刻使时间图到达新的上游变化，查询会继续核对同一日志里的提交。达到八次归因重建上限时，时间图保留已有结果，并在 `coverage.reasons` 中列出 `recordedAttributionBudget`。

从命令面板运行 **Open Execution Recording** 可直接回放 JSONL，输入完整的实例信号路径和 tick。Trace Explorer 会列出执行事件和可用源码链接。通过波形菜单打开匹配记录时，执行事件也可以跳转到对应的波形 tick。MCP 在没有打开波形时也可以回放已有记录。传入 `recordingOnly: true` 可显式使用记录中的时间单位，波形身份在此模式下显示为未验证。

执行记录可为多个实例信号声明覆盖。查询结果给出匹配实例的求值、提交、NBA 覆盖关系及覆盖缺口。标为 `end-of-slot` 的提交来自仿真时间槽结束时的采样。图中的序号表示记录顺序。记录包含源码哈希时，报告同时核对目前磁盘上的文件内容。 [执行记录示例](test/fixtures/trace/README.md#same-tick-writes-in-multiple-instances)

长记录的回放检查点可在 VS Code 和静默 MCP 重启后复用。`scannedAfterOrdinal` 表示本次跳过的前缀中最后一个事件的序号，省略该字段表示从记录开头扫描。默认索引目录为用户主目录下的 `.wave-workbench/execution-index-v1`，最多保存 32 份索引，每份最多 2 MiB。可用 `WAVE_WORKBENCH_REPLAY_CACHE_DIR` 指定绝对路径，设为空可关闭磁盘索引。回放继续校验波形哈希、时基和当前源码，记录变化或索引损坏会触发重新扫描。

`wave_trace_context` 的 `executionAssignments` 给出已关联的执行事件序号和 RTL 赋值数组索引。关联要求语句源码哈希相符，并能用坐标唯一定位到该信号的赋值。

`executionTransitions` 核对根信号最近变化的 tick 和游标 tick。执行记录覆盖完整且提交值变化与波形逐项匹配时，时间图节点可附上提交序号及已核对的 RTL 赋值。若波形只记录时间槽末值，报告可并列显示观察到的变化与执行记录中的中间写入。只有时间槽末尾采样证据的 NBA 标为 `approximateCommitTiming`。

带 Verilator JSON 的波形可调用 `wave_execution_map`，传入 `instance`、`signal` 以及可选的 `waveform`。它从该实例的直接变量赋值生成语句 ID、过程 ID、源位置和源码哈希，可作为插桩记录的映射输入。

将所需的 `wave_execution_map` 结果保存成 JSON 数组。运行 `node scripts/verilator-execution.mjs generate maps.json instrumented`，脚本会核对源文件哈希，写出源文件副本、DPI 软件包和按实例筛选的探针表。将仿真 filelist 中的对应源码替换成副本，在这些副本之前编译 `instrumented/wave_workbench_probe.sv`。在 Verilator C++ 构建中加入 `native/verilator_execution.cc` 并将 `native` 和 `instrumented` 加入 include 路径。

为单线程 Verilator 模型的同步 DPI 调用记录 C++ 内部步骤时，可在 `generate` 末尾加 `external.json`。其中的 `assignments` 是需要记录的 RTL 赋值语句 ID 数组，`steps` 按自定义步骤 ID 提供 `file`、`line` 和 `column`。路径相对于配置文件。C++ 实现包含 `verilator_execution.h`，在选定位置调用 `wave_workbench_external_step(id, operation, optionalBits)`。记录器将这些步骤附在触发调用的 RTL 赋值求值上。封装和回放核对 C++ 源码哈希，时间图、报告及 Trace Explorer 展示已记录的位置和值。其他外部步骤和异步作用保留为证据缺口。

仿真 harness 在调用 `eval()` 前调用 `wave_workbench_begin_slot(tick)`，结束时调用 `wave_workbench_finish_execution(tick)`。将运行输出写入 JSONL，再运行 `node scripts/verilator-execution.mjs seal instrumented/execution-probes.json trace.fst 1ps raw.jsonl execution.jsonl`。把 `1ps` 替换为实际波形时基。生成的探针记录原始赋值的求值、阻塞提交和可定位的过程触发。对 harness 已确认只有一个写入来源的 NBA 目标，可在 `eval()` 后将实例、信号和实际二进制值传给 `wave_workbench_observe_nba`。同一时槽恰有一次匹配的求值时，回放将提交标为 `end-of-slot`。其他情况保留求值，完整调度顺序仍取决于仿真器提供的事件。

确认插桩覆盖某个信号的所有写入进程后，可给 `seal` 追加一个覆盖文件路径。文件为 JSON 数组，每项使用 `start`、`instance`、`signal` 和 `writers`。起点 `start` 使用十进制 tick 字符串，`writers` 填写该实例信号的生成过程 ID。记录仍会根据序号和提交证据核对已声明的覆盖。

能访问仿真调度器的适配器可在同一时间槽通过 `wave_workbench_nba_evaluation` 取得求值序号，并在观察到覆盖或提交时调用 `wave_workbench_record_nba_superseded` 或 `wave_workbench_record_nba_commit`。提交点事件标为 `simulator-commit`，时间槽结束采样标为 `end-of-slot`。

使用 Verilator 5.054 的单线程 C++ 模型时，可以在生成 C++ 后、编译前运行 `node scripts/verilator-execution.mjs scheduler instrumented/execution-probes.json obj_dir obj_recorded`。在同一父目录生成 `obj_recorded` 可以让 Makefile 继续解析相对源码路径。对可识别的直接写入及整信号掩码存储，该命令把求值序号关联到实际的覆盖和提交点。支持的整信号位宽最多为 64 位，无法验证的生成结构会给出诊断。用生成的 Makefile 编译 `obj_recorded` 后运行 harness，再按上述方式封装记录。

在线使用 **Start Live Trace Harness** 和 **Control Live Trace**，MCP 对应 `wave_live_status` 与 `wave_live_control`。`wave_live_trace` 对已绑定设计的信号，以实时 harness 样本生成时间图和报告。报告记录保留的时间窗口。样例包含 Verilator 记录及实时控制 harness。见 [Trace fixture](test/fixtures/trace/README.md)。

在线追踪结果、分页图的 Provider 和详细报告都会标记 `liveSessionId`。预算前沿返回的 `continuation` 可将 `signal`、`tick` 和 `liveSessionId` 直接传给 `wave_live_trace`。Trace Explorer 的 **Continue from** 和 **Trace Live Signal** 支持停止后保留的历史。查询读取槽末快照，仿真保持当前时间和状态。指定 tick 缺失或会话已替换时，查询返回错误。

启动在线会话时，可以输入 JSON 配置运行目录、plusargs 和要核对哈希的激励文件。相对运行目录以可执行文件所在目录为基准，激励文件以运行目录为基准。留空使用可执行文件所在目录及空的 plusargs 列表。

```json
{"workingDirectory":"../run","plusargs":["+ENABLE","+MODE=3"],"stimulusFiles":["stimulus.hex"]}
```

在线时间图和详细报告使用当前会话的输入。MCP 通过 `context.runtimeInputSource` 标明来源，并在 `context.runtimeMismatches` 列出与参考波形清单的差异。存在差异时，参考执行记录的回放核对状态为 `runtimeInputsDiffer`，当前会话的采样和执行事件仍可查。

VCS 使用 **Start VCS Live Trace**，选择加载了 `native/vpi_execution.c` 回调库的 `simv`，输入带完整层次路径的信号列表，时钟步进需要选中时钟。会话支持暂停、继续、时钟步进和信号值断点。信号断点在时间槽末尾检查，槽内的顺序可在原始值变化回调中查看。`wave_live_status` 会报告 `valueChangeEvents` 与 `statementBreakpoints` 能力。将同一构建的 VCD、KDB 和已封装的 VPI 记录交给 `wave_live_trace`，可以核对目标及上游信号的回调，并生成 Mermaid 时间图、执行图与详细报告。 [VCS 在线复现](test/fixtures/trace/README.md#vcs-live-trace)

启动 VCS 在线追踪时，可为指定的模块实例注册过程赋值入口回调。离线运行使用 `+wave_statement_scope=tb.dut`，回放时使用相同的采集范围及顺序。`assignment-entered` 事件携带实例、语句 ID、源码行和赋值类型，直接写入已被选中的信号时也记录目标。先从 `wave_execution_trace` 或 `wave_live_status` 读取语句 ID，再通过 `wave_live_control` 的 `setStatementBreakpoint` 传入 `instance`、`statementId` 和 `eventKind: "assignment-entered"`。即使目标值保持不变，语句断点也会在该时间槽末尾暂停。VPI 采集提供执行入口和信号值变化。下述 DPI 探针另行采集 RHS 求值和阻塞提交。 [IEEE 1800-2017 VPI 语句回调](https://fpga.mit.edu/6205/_static/F25/documentation/1800-2017.pdf)

VCS 的直接变量赋值可用 `wave_execution_map` 从原始构建生成探针映射，再用 `generate` 生成插桩 RTL 副本。插桩记录赋值的 RHS 求值和阻塞写入后的值，VPI 记录同一序列中的值变化。用 `seal-vpi` 传入生成的探针映射和可选的写入覆盖，封装时核对探针映射 SHA-256。覆盖完整且与波形和原始源码匹配时，时间图可显示阻塞赋值的写入位置、提交序号与求值序号。在线可按 `assignment-committed` 设阻塞写入断点。 [VCS DPI 复现步骤](test/fixtures/trace/README.md#vcs-dpi-assignment-probes)

对由固定 packed 位段和标量组成的输出 modport 拼接，可用物理接口实例和成员名调用 `wave_execution_map`，并将带 `modport` 字段的映射传给 `generate-vcs-nba`。阻塞赋值的 RHS 为简单信号时，副本求值一次，按组件记录各自的值、目标范围和源码位置。物理写入尚未在探针处观测时记录 `assignment-unobserved`。匹配的 VPI 变化可在时间图中关联求值序号，并保留候选状态。 [modport 求值复现步骤](test/fixtures/trace/README.md#vcs-modport-component-evaluations)

整条总线或单个位都可以作为该查询的根信号。执行记录覆盖相关写入过程和全部候选组件时，回放可直接用已记录的求值与目标回调匹配。在线仿真可按组件的 `statementId` 设置 `assignment-evaluated` 断点，并在时间槽末尾暂停。提供匹配的构建清单和执行记录后，`wave_live_trace` 可用已逐项核对的回调补入暂停快照中合并的变化。

`generate-vcs-nba` 也可以从形如 `data = $fgetc(fd);` 的阻塞赋值记录实际读取。将可选的 external JSON 传给生成器，在 `fileReads` 中把赋值 ID 映射到 `steps` 的源码位置 ID，并保留 `assignments` 数组。探针记录可定位文件中的偏移、字节和 EOF，并把它们挂在同次 RHS 求值上。使用原始源码路径映射和已封装的执行记录时，MCP 的详细报告和时间图可以显示读取位置与对应的信号提交。

离线时间图可根据采样索引追踪直接读取的数组字。波形需要采集相应数组元素。用 `executionLog` 提供同次仿真的记录时，离线追踪还可读取有完整回调覆盖的结构体成员。两端采用同一个 package packed struct 定义且端口为直连时，时间图可沿端口继续追踪两端均已记录的同名成员。图和报告标记执行日志来源及同 tick 的候选次序。

VCS 离线录制追踪支持直接查询已采集的数组字，也可从读取该字的信号向上游查询。MCP 的 `recordedWordWriters`、Mermaid、详细报告和 Trace Explorer 显示每段数据最后一次已确认的写入。较新的部分写入覆盖旧来源的对应位。旧写入仍有效的位段列在 `contributingRanges`，来源缺失的位段列在 `recordedWordUnresolved`。简单的数组下标变量与探针记录的目标索引核对。

当 VCS 合并同一时间槽内的数组写入时，回放用同次仿真的回调与 FSDB 核对槽末值，并逐位比较变化序列。与未观测写入相交或变化序列不一致的位标为未解析。独立位段保留经核对的提交、求值和上游来源。

对从二进制文件组装的小端数据字，可在 `seal-vpi` 的探针映射之后传入 `--task-transfers TASK_PROBES_JSON`。JSON 包含模块 `instance`、结构体成员 `signal`、调用输入和成员写入的语句 ID（`input`、`write`）、两处紧随相应提交的索引探针 ID（`inputIndex`、`writeIndex`），以及 `fileReads` 中的文件读取位置 ID。索引通过 task 自动形参传递，值为该字最后一个字节的偏移加一。成员回调须发生在对应写入的求值和提交之间。回放核对波形哈希、源码及静态形参与字段关系，再用采集的索引、字节和事件次序确认关联。续查合并后，时间图和可选报告仍保留关联的入参提交、成员写入、文件字节及源码。

`wave_trace_context` 和 `wave_live_trace` 接受 `output: "report"`。响应包含完整 Markdown 报告及覆盖信息，配合 `format: "mermaid"` 还返回图源。原始图和波形采样可通过默认输出单独获取。

批量续查可设 `output: "temporal"`。响应包含根信号采样、时间图、所引用的信号，以及以原赋值 ID 为键的 `assignmentSources`。时间图中的 `edges[].assignment`、`alsoAssignments` 和写入记录可直接查到源码位置。把 `context.temporalTrace.gaps[].continuation` 中的字段合入同一种查询即可继续。配合 `format: "mermaid"` 可输出时间图和可用的执行图，配合 `detail: "full"` 可附上完整报告。

`wave_trace_context` 和 `wave_live_trace` 可设置 `followContinuations` 为 0 到 8，在一次调用中自动查询对应数量的上游变化。同一段生成的入口中，有执行回调证据的等待原因优先。接回该事件时会核对回调序号。设为 0 并使用 `output: "paged"` 时可先浏览 `frontier`，再用游标和 `frontierIndices` 按需续查。相同信号、tick、变化序号和在线会话的续查只执行一次。各段沿用本次查询的编译配置、波形或在线会话以及图预算。默认返回时间图模式，`format: "mermaid"` 与 `detail: "full"` 同样应用于续查结果。

`continuationWalk.segments` 含每段的请求和结果或错误。根图编号为 0，续查段从 1 开始编号。`links` 的 `segment` 和 `gap` 指向来源图及其中的缺口，`nextSegment` 指向续查段或按相同编号顺延的 `remaining` 请求。查询数或用时到达预算时，链接和未处理请求仍可用于下一次调用。自动续查最多使用本次调用开始后 100 秒内剩余的时间。各图的覆盖状态继续报告静态和波形证据缺口。

响应含 `continuationCursor` 时，可用 `wave_trace_resume` 将下一批结果接入同一张图。传入最新游标和可选的 `followContinuations`，每批默认续查 4 段，范围为 1 至 8。合并图保留已查询的段、节点编号和原始赋值索引。可加 `format: "mermaid"` 导出图，或用 `output: "report"` 获取根查询正文和各续查段的 Markdown。时间图续查保留初次查询的波形观测、构建校验或在线执行证据。每个 VS Code 扩展宿主最多保留 4 个游标。有效游标只能成功使用一次，仍有待查项时返回新游标。重新加载宿主、改变编译或波形输入、用新仿真替换在线会话都会使旧游标失效。停止仿真或自然退出后，原会话保留的快照仍可续查。

静态 Driver / Load、离线时间图和在线 Trace 也可设置 `followAllContinuations: true`。工具会持续查询可解析的前沿，直到队列为空、达到每次调用的 64 个续查入口上限，或用完 100 秒续查时限。该选项默认返回分页图。仍有待查入口时，使用返回的 `continuationCursor` 调用 `wave_trace_resume`，可用同一选项继续。自动遍历与 1–8 次的手动预算 `followContinuations` 分别使用。队列耗尽后仍以图的覆盖状态和 `gaps` 判断有无未解析的关系或缺失观测。

显式提供 `filelist` 时，每个 MCP 调用在本批追踪和续查中复用隔离的 VIDE 工程。调用结束后释放工程。下一批 `wave_trace_resume` 会先复核原输入。合并时间节点和缺口中的 `point.signal`、`evidence.signal` 是来源段内编号。跨请求核对信号时使用合并结果中的完整 `signal` 路径。

静态 Driver、Load 和时间图都支持按 `frontierIndices` 指定本批要续查的 1–8 个入口。先读取最新图快照的 `frontier`，用 `offset` 加上条目在页内的位置得到从 0 开始的编号。将编号和同一批返回的 `continuationCursor` 传给 `wave_trace_resume`。按给定顺序查询，其他入口仍留在队列中。每批返回新编号，继续时读取新快照。`frontierIndices` 与 `followContinuations`、`followAllContinuations: true` 互斥。

Driver、Load、离线与在线时间追踪及 `wave_trace_resume` 都支持 `output: "paged"`。响应中的 `graphSnapshot` 给出 `graphCursor`、图的元数据和各部分的条目数。调用 `wave_trace_graph_page` 时传入图游标和 `section`，从 `offset: 0` 读取，再沿 `nextOffset` 翻页。每页默认 64 条，最多 128 条。节点、边和缺口沿用原图的全局编号。时间图的 `assignmentSources` 按 `segment` 和 `assignment` 取回源码，静态赋值直接包含源码位置与原始查询索引。启用续查时，`frontier` 包含未查询的信号或时间请求，`queryFailures` 包含各个失败的查询及诊断。

分页快照可随时用 `wave_trace_graph_page` 读取 `mermaid` 和 `report`。初次查询保留 `format: "mermaid"` 或 `detail: "full"` 时会立即生成相应部分，并在 `sections` 中报告条数。其余部分列在 `deferredSections`，首次读取时从同一快照生成，响应中的 `total` 给出条数。每条 Mermaid 是一张图，将报告条目按顺序原样拼接可恢复完整 Markdown。每个扩展宿主最多保存 4 张图快照。续查游标推进分析并可生成新图游标，已有图游标读取创建时的快照，直到被替换或宿主重启。

用 `wave_trace_graph_path` 从静态 Driver、Load 或时间图快照提取选定信号与追踪根之间的依赖。静态图的 `nodeIds` 使用 `signals` 分页中的 `id`，也可用 `nodeSelectors: [{"signal":"tb.dut.data"}]` 按声明路径选取。静态输出的 `pathScope` 为 `declaration`，跳数按赋值计算。报告逐条列出赋值的读写位范围与源码位置。跨赋值的位级连通性仍需对应的位级证据。

静态位路径可在每项 `nodeSelectors` 中提供整数 `bit`，例如 `{"signal":"tb.dut.data","bit":3}`。先用带位或位范围的根信号建立 Driver 或 Load 快照，可使原图保留更精确的 RTL 映射。结果的 `pathScope` 为 `recordedBits`。`bitEdges` 分页按 RTL 数据流方向列出输入位、输出位和赋值 ID。对范围已核验的直连端口，按右端对齐低位。截断保留低位依赖，已知有符号源的扩展位连接到符号位，零扩展位没有输入信号依赖。符号性未知时保留已确定的低位依赖。`assignmentsWithoutBitMappings` 包含缺少全部或部分位映射的赋值。由端口连接补出的边带 `fromPort: true`，每次查询最多检查 16,384 个端口位。详细报告包含连接的 RTL 位置、转换位宽和两态目标标记。`unreachable` 表示现有位映射中没有路径。

整总线快照也可从支持的 RTL 赋值推导位依赖，例如直接赋值、固定位选和拼接。派生边带 `fromExpression: true`。端口映射和表达式共用 16,384 单位的推导预算，表达式按目标宽度乘以输入数计费。动态目标和当前无法求解的表达式仍计入位映射缺口。对整总线根使用 `mode: "all"` 可以保留关联到多个根位的路径，`paths` 仍返回最近的一个根位。

静态位路径和按位时间追踪支持固定移位量的左移、逻辑右移和算术右移。移位计算使用赋值上下文的位宽。算术右移的符号填充依赖源符号位，零填充没有数据输入依赖。固定条件的三元表达式使用已选分支，常量 X/Z 条件保留两侧合并所需的位。时间图遇到运行时移位量时，使用波形中可核验的稳定采样确定数据位，并保留移位量的因果边。对于核验过的单一无延迟连续驱动，若与输出相符的同槽采样组合都得到同一移位量，时间图沿对应数据位追踪并标记 `sameTickUnordered`。组合给出多个移位量或证据不全时，数据继续以信号级候选显示。

按位时间追踪根据稳定的三元条件选择数据分支，将条件来源标为 `role: "condition"`。稳定条件含 X/Z 且无法归约为真时，保留两路对应的数据位。对核验过的单一无延迟连续驱动，同槽比较使用完整的四态波形值。只有与输出匹配的采样组合都给出相同的条件真假或四态合并结果时，才按该结果追踪数据位，并保留 `sameTickUnordered`。分支存在歧义时保留原信号级候选。

时间图的 `nodeIds` 使用 `nodes` 分页的零起始索引，也可以用页的 `offset` 加上节点在页内的位置。默认 `mode: "shortest"` 为每个选定节点保留一条最短路径。`mode: "all"` 保留快照中选定节点与追踪根之间已有的分支，包括抵达根之前的反馈边。两种模式下，`paths` 都列出每个起点最近的根和最少跳数，或用 `unreachable` 标记不可达起点。

时间图也可以传入 `nodeSelectors`，用完整信号路径与十进制 `tick` 直接选取节点。总线路径可省略声明范围，单个位选择保留位下标。可选的 `changeOrder` 从 1 开始，指定该 tick 内观测到的第几次变化。若节点已有执行回调，可用 `callbackOrdinal` 按记录的非负回调序号选取，例如 `{"signal":"tb.inhibit","tick":"7","callbackOrdinal":7}`。`matches` 返回每个选择器对应的原图节点编号。`nodeIds` 和 `nodeSelectors` 可以一起传入，去重后最多 16 个节点。详细报告保留槽内变化序号、值变化回调编号、求值时捕获的操作数及等待恢复的事件边界。

局部时间图返回的新游标可以再次传给 `wave_trace_graph_path`。`nodeIds`、`matches` 和 `paths` 使用本次传入的快照编号，`sourceNode` 始终指向首次选取路径前的时间图节点。图和可选 Markdown 保留候选状态、已接回的续查、执行提交及 RTL 位置。详细报告也列出已记录的位段写入操作数、分支入口值、外部执行步骤的源码校验，以及从任务成员写入追到固件读取的提交和求值顺序。路径上的节点仍显示其待查、未匹配和未解决的证据缺口，报告提供可用的续查信号和 tick。局部快照沿用原图的覆盖状态。用原图游标查看全部待查入口和缺口，用原续查游标继续追踪。

自动续查会在每段前后核对波形、分析输入和在线会话。检测到变更时，`stopReasons` 包含 `contextChanged`，并保留根图、已核对的段和剩余请求。在线仿真重启后可从根信号发起新查询，原会话的续查入口仍关联原会话 ID。

配合 `format: "mermaid"` 时，`continuationMermaid` 返回根查询、已查段和待查入口的总览。超过一页时，`continuationMermaidPages` 返回全部页面。使用 `detail: "full"` 或 `output: "report"` 时，Markdown 顶部提供跳转链接，附录列出各段的时间图、源码位置、覆盖状态和待查入口。总览的边表示从哪个缺口发起续查，各段时间图保留对应的因果证据。

`temporalContinuationGraph` 把已查的时间因果图接到根图上。节点保留 tick、波形值和原始查询索引，因果边保留原始置信度及赋值索引，`assignmentSources` 按查询编号提供源码位置。对已有变化的续查，合并时核对 tick、位选择、变化序号及已知值。虚线表示续查接点。待查项和无法核对的变化仍保存在 `gaps`，并影响覆盖状态。合并图可用 `temporalContinuationMermaid` 导出，也包含在详细报告中。

已观测的变化如果抵达静态深度、信号数或赋值数预算，会产生 `staticBudget` 缺口。该缺口的 `anchor` 指向当前时间节点。续查在同一个波形变化处接上额外的 RTL 驱动证据。合并图可共用同一节点，也可用 **Same change · continued static trace** 关联带不同执行证据的观测。自动续查交替处理已排队的静态分支和新发现的上游段。

`staticTraversalBudget` 表示时间图中存在由静态预算产生的接点。合并图在核对完这些接点后移除该原因。无法对应到观测变化的静态前沿和未解析的 RTL 关系继续计入 `staticFrontier`。预算或观测缺口都处理完毕且无其他覆盖问题时，合并图显示 `resolvedWithinWindow`。

离线波形中，若数据或控制输入在当前窗口内持续保持已知值，缺口可以提供带 `historyStart: "auto"` 的续查请求。请求的 `tick` 为原窗口起点前一刻。结果中的实际变化时间可能更早。合并图核对所选位、变化值、边界采样及可用历史，并将接点标为 **Earlier change**。自动续查在每段内优先排入有明确变化时间的请求。

同一 tick 有多个根变化时，未能在节点预算内加入的变化按序号进入续查队列。续查成功后恢复为合并图的根节点。因节点或边预算省略的依赖在 `gaps[].use.evidence` 保留数据、控制、触发或索引角色及原始置信度。Mermaid、Trace Explorer 和报告也会显示适用的同槽顺序与实录采样证据。

在波形中选中一个信号并设置 A 游标，然后选择「追踪 → 自动续查 A 游标的上游」。在线会话可运行 **Wave Workbench: Trace Live Signal with Continuations**。这两个界面入口在续查时间预算内跟进最多 64 个请求，打开带附录的 Markdown。Trace Explorer 显示起始信号，可继续查询图中提供的入口或跳转到 RTL。

**Combined time graph** 有待查入口时，点 **Continue next batch** 可在续查时间预算内再查询最多 64 段。点击一条标有 **Continuation pending** 的缺口，可只查询那条分支。两种操作都保留根信号和原始时间点，更新合并图并打开含全部已查段的 Markdown。关闭 VS Code 后重新打开，已保存且通过输入核验的离线图也可以按缺口继续。

`generate-vcs-nba` 为直接整信号、无赋值内延时的 NBA 生成带求值序号的写入探针。VPI 在观测到序号时核对目标值，匹配后记录 `simulator-commit`，同值写入也可配对。VCS 合并多次更新时，回放用 `assignment-unobserved` 保留缺少独立提交观测的求值，对应 tick 报为部分覆盖。在线可用 `timing: "simulator-commit"` 设断点，会话仍在该时间槽结束时暂停。 [VCS NBA 复现步骤](test/fixtures/trace/README.md#vcs-nba-commit-probes)

同一生成器也支持单维 packed 变量的十进制固定选位和范围，包括升序总线。事件携带 `targetRange` 及该段的值。整总线回放按提交顺序重建值，位查询只将对应位的变化归因到实际写入。插桩可能改变 VCS 可见的同槽中间变化，执行追踪使用同次插桩仿真的波形与记录。 [VCS 固定位段复现步骤](test/fixtures/trace/README.md#vcs-fixed-packed-writes)

VCS 的 `wave_execution_map` 可用 `signal: "mem[36]"` 选择 KDB 中的数组字。将各个目标字的映射一起传给 `generate-vcs-nba`，支持常量或简单变量作为字索引，以及整字和固定 packed 位段的 NBA。生成的 RTL 在求值时保存索引，提交记录使用实际观测的数组字名称。对动态字索引写入，RHS 支持无副作用的表达式。若要使用完整写入覆盖校验，覆盖清单应包含目标字在采集窗口内的所有写入过程。

固定目标和数组字的 NBA 映射可传入 `captureGuards: true`，采集可解析的局部守卫操作数，例如写使能和写掩码。固定目标可同时启用 `captureOperands`，两种采样合计最多八个不同的局部信号。记录使用 NBA 求值时的值，图中的控制边据此选择匹配样本，详细报告显示采集值。分支入口与赋值之间若改变了守卫变量，这些采样反映赋值处的值。

`captureGuardEntry: true` 同时启用求值采集，并在可映射的 `if` 或 `else` 分支入口保存守卫操作数。支持显式块和直接的单语句 NBA。原始条件按仿真器语义求值，采样在选中分支入口执行，包含条件求值产生的副作用。图和报告将入口采样连到同一次 NBA 求值，并给出原始条件的行列。宏生成的条件以及无法绑定到局部信号的操作数仍受源码映射限制。

VCS 的 `generate-vcs-nba` 也支持 `q[index] <= data` 形式的动态单个位 NBA，其中下标是简单变量，RHS 无副作用。探针在求值阶段保存下标并在回放中使用实际写入的位。探针能确认选择完全越界或下标含 X/Z 时，记录 `assignment-no-target` 并关联求值和 RTL 位置。同一时间槽中的有效提交仍可归因。旧记录中的 `assignment-unobserved` 继续按观测缺口处理。 [VCS 动态选位复现步骤](test/fixtures/trace/README.md#vcs-dynamic-packed-writes) · [IEEE 1800-2017 非阻塞赋值规则](https://fpga.mit.edu/6205/_static/F25/documentation/1800-2017.pdf)

对于 `q[index +: 2]` 和 `q[index -: 2]`，VIDE 保留选择方向和恒定宽度，VCS 探针按实际总线方向记录提交范围。探针要求简单变量作为起点和无副作用的 RHS。部分越界时，求值事件保留完整 RHS 和尝试范围。探针收到提交标记并核对在界位后，提交事件的 `targetRange` 给出实际写入范围，`attemptedTargetRange` 给出原选择。时间图使用 VCS 实测的低位截取规则追踪 RHS。无法核实的提交继续记录为 `assignment-unobserved`。 [VCS 动态位段复现步骤](test/fixtures/trace/README.md#vcs-indexed-packed-writes)

VCS 探针为每个 packed 目标分配整信号标记、各固定范围标记，以及按起点表达式、宽度和方向区分的动态选择标记。具有相同范围或选择形式的写入共用对应标记。通过标记和目标位值核对重叠写入的实际提交。回调缺失或目标位值不吻合时记录 `assignment-unobserved`。插桩可使 VCS 波形暴露更多中间值，精确追踪使用同一次插桩仿真的波形与执行记录。 [VCS 重叠写入复现步骤](test/fixtures/trace/README.md#vcs-overlapping-packed-writes)

打开同一构建的参考波形后，执行 **Trace Live Signal**，选择 harness 已采样的信号。可选载入执行 JSONL。命令用参考波形旁的构建清单核对源码与 harness，在 Trace Explorer 展开当前在线时间图，并打开含 Mermaid 和执行证据的 Markdown 报告。

在线构建核对可使用 `buildManifest` 及其中可选的 `harnessSha256`。填写生成参考波形的 harness 可执行文件哈希，Verilator 构建同时提供展开树及元数据哈希。`wave_live_status` 返回启动时核对的 `harnessSha256`。`wave_live_trace` 比对 harness、参考波形、展开信息、时基及 VIDE 实际采用的编译配置，并返回 `buildVerification`。旧清单仍可查询，证据缺失时状态为 `unverified`。发现明确差异时，仍返回实时采样和原始执行事件。

`wave_live_trace` 的 `executionCoverage` 标出会话中缺失的事件序号、请求窗口是否因缓冲区淘汰而不完整，以及本次输出因上限而省略的事件数。

向 `wave_live_trace` 同时传入 `buildManifest` 和同一构建的 `executionLog`，可核对在线事件与 JSONL 中的实例、语句、值及事件次序。匹配的日志提供源码映射。时间图对可确认的变化标注实际 RTL 赋值及求值、提交序号，并按同样的规则追踪已记录的上游信号。通过 `executionReplayMatch` 查看根信号和上游信号的核对状态。构建未验证、日志身份或事件不一致，以及任一方记录缺失时，MCP 保留可用的实时采样和事件。同一时槽的中间变化可能只出现在原始事件里，`executionTransitions` 会标出采样与提交序列的差异。

提供执行事件的 harness 支持语句断点。通过 `wave_live_control` 传入 `action: "setStatementBreakpoint"`、`instance` 和 `statementId`。`eventKind` 可匹配分支、求值、提交或 `assignment-superseded`，默认匹配求值。对 `assignment-committed` 可加 `timing: "simulator-commit"` 匹配调度器实际提交，或用 `end-of-slot` 匹配时间槽末尾采样。VCS 状态中的 `nbaCommitEvents` 和 `modportCommitEvents` 分别表示 harness 支持的精确提交来源。VS Code 的 **Set Statement Breakpoint** 菜单也可选择事件。仿真在命中事件所在的时间槽结束时暂停，`breakEvent` 给出实际命中的事件和序号。

`wave_live_trace` 可随 `format: "mermaid"` 返回在线执行事件图 `executionMermaid`。详细报告列出事件序号、求值和替换关系，以及可用的提交时机。

MCP 客户端取消 `stepClock` 时，仿真完成已发出的当前时间槽后暂停。随后可调用 `wave_live_status` 查看停点和保留的执行事件，再继续步进。

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

## 多引擎事务解码

- MCP `wave_decoder_list` 查询注册的解码器，`wave_decoder_query` 查询指定半开时间窗口的事务。
- MCP `wave_decoder_attach`、`wave_decoder_detach`、`wave_decoder_reload`、`wave_decoder_status` 配置波形事务行。
- Tcl `waveDecodeTransactions decoderId bindingsJson start end ?optionsJson?` 批量查询事务。旧 `waveDecode` 和 `waveDecodeEvents` 仍用于既有标签与串行解码。
- `wave_clip` 和 PNG/JSON 导出包括已配置事务行的结果。 [扩展 API](DECODER_API.md)


## 实数波形与局部 RTL 原理图

- 选中实数信号后，用 **信号 → 设置实数单位** 修改显示单位，或用 **实数 A/B 测量** 查看区间统计。**生成滞回数字波形** 接收低阈值和高阈值，并将结果加入波形。
- Tcl 用 `waveMeasureAnalog /tb/voltage 0 20` 返回区间最值、RMS、均值和有效覆盖 tick。MCP 可通过现有 `wave_tcl` 入口调用。
- 选中波形信号后，用 **原理图 → 打开驱动原理图** 或 **打开负载原理图** 查看局部连接。MCP `wave_schematic` 接收 `signal` 和可选 `waveform`、`direction`、`tick`，返回节点、边、源码位置和已确认的波形绑定。原理图内可选中信号继续展开上游或下游，返回前一张图，或用 **刷新 A 游标** 更新读数。
- 完成追踪后，用 **原理图 → 打开本次追踪原理图** 或 Trace 面板标题栏的同名按钮查看这次的结果。驱动和负载追踪保留原查询方向及续查结果。A 游标追踪图标出原始事件 tick、连线证据和缺口。打开后的图保留当次结果，移动游标后可重新打开更新后的图。
- 原理图中滚轮以鼠标位置为缩放中心，按住左键拖动可平移。点击 **适应视图** 重新居中。大图的总览优先显示节点位置，放大后显示视口中的连线。

## RTL 模块原理图

从波形工具栏的 **原理图** 菜单打开顶层模块或选中信号所属的模块。也可运行 **Wave Workbench: Open RTL Module Schematic**。当前波形关联了设计数据库时，可从对应顶层开始浏览。打开 VCS FSDB 后，使用旁边的 `simv.daidir` 或附加与该波形匹配的 KDB。也可以独立打开 VCS `simv.daidir` 或 Verilator `--json-only` 生成的 `*.tree.json` 和配套元数据。

模块框显示实例名、模块名和端口方向。选择模块可高亮连线或跳到实例化位置。双击模块或用 **打开实例** 进入子模块，用 **上一级** 返回父模块。图上标出总线切片、常量和未接端口。关联波形时可将已记录的端口和网加入波形。局部信号图也提供 **所属模块** 入口。

Verilator 视图还按语句显示模块内部的 `assign` 和 `always_*`。KDB 视图当前显示实例、正式端口和实例间连线，包括后端能够解析的端口表达式。内部行为逻辑、复杂接口连接、综合网表和直接从 RTL 自动生成列入后续。 [Vivado Schematic](https://docs.amd.com/r/en-US/ug906-vivado-design-analysis/Using-the-Schematic-Window) · [Verilator --json-only](https://verilator.org/guide/latest/exe_verilator.html#cmdoption-json-only)

## 前台 MCP、后台 MCP 和 Tcl

前台 `dist/mcp.js` 使用当前 VS Code 窗口的波形工程和在线仿真。后台 `dist/mcp-headless.js` 在波形所在机器上通过 stdio 启动，使用独立的波形、调试和仿真会话。启动参数为工作区绝对路径。两个服务器提供相同的 `tools/list`，Tcl 可用 `waveTool list` 查看这套接口。

后台 MCP 的 `wave_open` 和 Tcl 的 `wvOpenFile` 使用工作区 `.vscode/settings.json` 中的 `waveWorkbench.fsdbBackend`。在 `wave_open` 显式传入 `backend` 可覆盖该次打开的设置，相应的 KDB 使用同一后端偏好。

| 功能 | 命令 |
| --- | --- |
| 波形和工程 | `wave_open`、`wave_close`、`wave_list`、`wave_search`、`wave_view`、`wave_save_project`、`wave_clip`、`wave_export` |
| 源码和原理图 | `wave_design_attach`、`wave_source`、`wave_schematic`、`wave_module_schematic` |
| RTL 追踪和记录 | `wave_trace_drivers`、`wave_trace_loads`、`wave_trace_context`、`wave_trace_resume`、`wave_trace_graph_page`、`wave_trace_graph_path`、`wave_execution_map`、`wave_execution_trace` |
| 模拟和数学 | `wave_math` 的 `measure`、`hysteresis`、`expression`、`derivative`、`integral`、`filter`、`adc`、`dac`、`fft`、`external` |
| 仿真和 RTL 调试 | `wave_live_start`、`wave_live_debug`、`wave_debug_request`、`wave_live_control`、`wave_live_status`、`wave_live_history`、`wave_live_trace`、`wave_live_stop` |
| 协议解码 | `wave_decoder_list`、`wave_decoder_query`、`wave_decoder_attach`、`wave_decoder_detach`、`wave_decoder_status`、`wave_decoder_reload` |

Tcl 使用 `waveTool 工具名 {JSON对象}`，返回 JSON。以下写法的双层花括号保留 JSON 对象本身的花括号。

```tcl
waveTool wave_open {{"path":"mixed.waveproj"}}
waveTool wave_math {{"operation":"adc","signals":["tb.voltage","tb.sample_clk"],"options":{"name":"ADC","bits":8,"low":0,"high":1.8,"sampling":{"mode":"external","edge":"rising","delay":"2"}}}}
waveTool wave_source {{"signal":"tb.dut.data"}}
waveTool wave_live_history {{"start":"0","end":"100000","limit":512}}
```

在后台也可通过 `wave_tcl` 执行 nWave 兼容命令。两个 MCP 的源码和原理图接口均返回数据。前台可以传 `show: true` 打开对应编辑器，或通过 `wave_live_debug` 将仿真附加到 VS Code 调试面板。自动化调试通过 `wave_debug_request` 执行 DAP 请求，涵盖启动、附加、断点、单步、堆栈、变量和求值。历史窗口可使用 `cursor` 取精确采样，或使用 `limit` 和返回的 `nextStart` 分页读取全部采样。停止仿真后仍可查询本次波形。

RTL 分析依赖 Wave Workbench 的修改版 VIDE。后台自动查找已安装的 VIDE 扩展，也可使用 `WAVE_WORKBENCH_VIDE_PATH` 指定其中的服务器程序。若工程提供 KDB、filelist 或 `vide.toml`，分析使用相应的设计和编译配置。后台可读取工作区的 `.vscode/settings.json`。运行 Lua/JS 解码器或外部数学算子时，后台启动环境可设置 `WAVE_WORKBENCH_TRUSTED=1`，前台沿用 VS Code 工作区信任。

状态栏显示前台和后台任务。后台任务与启动参数指定的工作区关联。

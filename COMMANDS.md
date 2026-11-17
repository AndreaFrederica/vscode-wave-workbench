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

使用真实 Tcl 8.6+ 解释器（默认 `/usr/bin/tclsh`，可设 `waveWorkbench.tclshPath`），支持 `set`、`foreach`、`if`、`expr`、`list`、`proc`、`source` 等 Tcl 语法。同一波形窗口的 Tcl 变量跨输入保留。脚本中 `source` 相对当前脚本目录解析。为了避免 EDA 环境内的同名库污染，默认系统 Tcl 进程不继承 EDA 的 `LD_LIBRARY_PATH` 和 Tcl 库覆盖变量。

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

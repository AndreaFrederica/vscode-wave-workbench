# Wave Workbench 模拟波形与混合信号解码计划

目标是在同一波形窗口内查看数字信号和仿真记录的实数采样，完成测量、派生波形、混合信号解码和原理图联动。首批验收用同一次仿真的样本核对 VCD、FST 和 FSDB。复核项见 [检查 TODO](CHECK_TODO.md#模拟波形与混合信号解码)。

## 现状和验证基线

- 用 VCS T-2022.06-SP2 运行最小 SystemVerilog testbench，同次仿真生成 VCD 和 FSDB，再用 `vcd2fst` 转出 FST。数字 `ready` 在 tick 0 为 0，在 tick 9 变为 1，四条读取路径均返回一致结果。
- 实数 `voltage` 在 tick 0、4、9、16 记录为 `-0.125`、`0.125`、`0.9`、`0.75`。原生 VCD、FST、独立 FSDB、Verdi SDK FSDB 都能列出该变量，现有查询返回 `Unsupported signal encoding`。 [VCD 目录](native/src/vcd.rs) · [FST 目录](native/src/fst.rs) · [Verdi SDK 桥接](native/bridge.cpp)
- VCD 解析器已分词读取 `r` 记录。所用 FST 库提供 `FstSignalValue::Real(f64)`。FSDB 两条路径分别用同一份实数样本验证声明类型、样点编码和时间标签。连续时间的电压、电流及其单位另用真实 AMS 或 SPICE 导出产物核对。 [FST 读取 API](https://docs.rs/fst-reader/latest/src/fst_reader/reader.rs.html) · [Synopsys VCS AMS](https://www.synopsys.com/content/dam/synopsys/verification/datasheets/vcs-ams-ds.pdf)

基线样本的取值序列可在支持 VCD dump 的 SystemVerilog 仿真器上用以下模块复现。使用 VCS 和 Verdi PLI 时可加上同一作用域的 `$fsdbDumpfile` 和 `$fsdbDumpvars`。

```systemverilog
`timescale 1ns/1ns
module mixed_tb;
  real voltage;
  logic ready;
  initial begin
    $dumpfile("native.vcd");
    $dumpvars(0, mixed_tb);
    voltage = -0.125;
    ready = 0;
    #4 voltage = 0.125;
    #5 begin
      voltage = 0.9;
      ready = 1;
    end
    #7 voltage = 0.75;
    #1 $finish;
  end
endmodule
```

## 波形与解码契约

- 信号描述包含明确的数字或实数类型。数字宽度保留位宽含义。实数采样在二进制批次中使用 IEEE 754 `float64` 列，时间沿用无损 tick。单位来自波形元数据或用户显式设置。
- 初始值、缺样、NaN 和无穷值分别保留状态。稀疏采样、截断和采集结束后的查询返回对应的有效区间。高密度显示可用每像素最小值和最大值保留窄尖峰。测量从原始采样计算。
- RNM 实数事件默认用阶梯显示。连续波形按来源附带的采样语义或用户选择使用线性插值。越阈值结果记录原始采样区间与所用算法。线性越阈值时刻作为估计值输出，跨缺样区段保留未知状态。
- 多引擎 manifest 声明每路输入的类型。版本化二进制批次携带混合输入、初值与有效状态。Builtin、LuaJIT、V8 对同一组样本和参数须产出等价结果。现有数字脚本继续按四态字符串契约读取数字输入，新实数输入通过数值 API 读取。 [当前批次契约](DECODER_API.md#二进制事件批次)

## 首轮交付

- VCD/FST 实数目录、查询、阶梯绘制、游标值、单独纵轴范围、单位设置和工程恢复已接通。Verdi SDK 已从同次 VCS 的 FSDB 读出四个实数样点，数值与 VCD 一致。独立 FSDB 已支持本次 VCS 样本验证的 64 位实数记录，覆盖 `real` 和 `shortreal`、跨时间窗初值与截断。
- A/B 区间测量支持最值、峰峰值、时间加权平均、RMS 和有效覆盖时间。滞回转换可把实数原始采样生成现有虚拟数字波形，保存派生的数字采样。
- LuaJIT、V8 共用新版二进制实数列。测试通过实数电压和数字就绪信号的混合绑定，在同一个 tick 得到相同事务。Tcl 提供 `waveMeasureAnalog`。PNG、CSV、JSON、VCD 裁剪链路支持实数。
- 局部 RTL 原理图从波形「源码」菜单打开，可选择驱动或负载。图与 MCP `wave_schematic` 共用 RTL Trace 证据，保存采样时的游标值和位范围所对应的连接。界面支持跳到已知源码位置及将匹配到的信号加入波形。Linux VS Code 上用现有 Verilator FST 样例返回 26 个节点和 32 条边。

实际 VCS T-2022.06-SP2 的不等间隔样本共包含 638 个实数样点与 401 个数字样点。两个 `real` 信号和数字信号逐点与 VCD 对照，`shortreal` 与 Verdi SDK 及固定的 testbench 值核对。末尾事件分别位于 `5000080201`、`5000080218` tick。原理图支持针对选中信号打开上游或下游、返回前一张图、按波形当前 A 游标重新取值。 [回归用例](test/analog-wave.test.js) · [VCS 样本](test/fixtures/analog/many_real.sv)

## 实施 TODO

- [x] **A0 现状审计**　生成同源 VCD、FST、FSDB。核对实数目录、失败原因及数字对照信号。
- [ ] **A1 读取与显示**　先接入 VCD `real` 及 FST 实数类型。支持和数字行共用时间轴、Y 轴范围、单位、游标、自动缩放和峰值保留抽稀。随后实测实数 FSDB 的 Verdi SDK 与独立读取路径，以及可获得的 `shortreal`、`wreal` 和 RNM 样本。把每个格式和模拟器的能力记入验收表。
- [ ] **A2 测量与处理**　加入 A/B 区间最小值、最大值、峰峰值、均值、RMS、阈值搜索和游标差值。使用实际采样时间间隔计算区间平均与 RMS。增加显式重采样、转换单位、差分、滤波和派生波形操作，保存参数与原始信号身份。
- [ ] **A3 混合信号解码**　第一批内置解码器覆盖阈值、施密特滞回及按数字时钟采样的 ADC 码值对照。同步接入 LuaJIT 和 JS/TS，支持实数、数字混合绑定，输出事务、派生实数曲线、虚拟数字信号与诊断。验证批次连续性、随机窗口、重放与取消。
- [ ] **A4 导出与联动**　经 Tcl、MCP、CSV、JSON 和 PNG 复用相同采样、单位、时间和有效状态。工程保存显示模式、测量和解码配置。原理图按信号身份显示游标处的实数值与单位，并把测量区间跳转到波形。动态 Trace 用已观测的阈值事件或数字边界事件连接证据，插值估计保留来源及精度区间。
- [ ] **A5 连续时间波形**　用真实 AMS 或 SPICE 数据核对电压、电流、时间精度、非均匀采样和缺样。根据用户实际产物扩展导入，按格式分别验证。

首期可交付范围为 A1 的 VCD/FST，实现实数和数字同屏查看与游标取值。首条解码验收从不等间隔的电压采样开始，经施密特滞回生成虚拟数字信号，再用数字时钟关联 ADC 输出。三个引擎需要对同一份采样给出一致的阈值事件、时间证据和码值对照。

## 厂商 SDK 与 SPICE 实测

Linux x64 扩展使用固定版本的 Ondas fork。安装 SDK 后通过 VS Code 的用户设置配置工具路径。Remote SSH 下配置远端路径。构建 Wave Workbench 时可以直接编译 SDK 适配层。 [Ondas fork](https://github.com/AndreaFrederica/ondas/tree/wave-workbench-sdk)

| 格式 | 使用方式 | 验证范围 |
|---|---|---|
| SHM | 打开 `.shm` 目录内的 `.dsn`，也可向后台 MCP 传入整个 `.shm` 路径。配置 `waveWorkbench.xceliumHome` 或 `XCELIUM_HOME` | Xcelium 23.09，同一时间轴的数字和实数，区间初值和截断 |
| WDB | 打开 `.wdb`，配置 `waveWorkbench.vivadoHome` 或 `XILINX_VIVADO` | XSim 2021.2 的 SDK 路径，同一时间轴的数字和实数，区间初值和截断。原生文件解析仍属研究任务 |
| WLF | 配置 `waveWorkbench.wlf2vcdPath` 指向 Questa 安装的 `wlf2vcd`。后台 MCP 使用 `WAVE_WORKBENCH_WLF2VCD` | 转换后沿用 VCD 读取器和 128 MiB 限制。当前环境缺少 Questa Reader SDK 和转换器，实际 WLF 待验收 |
| PSF ASCII | 从 Spectre 输出实值瞬态数据，打开 `.tran` 或 `.psfascii` | Spectre 25.1 RC 瞬态，电压单位、区间测量和 CSV 导出。二进制 PSF 和 PSFXL 待验收 |
| RAW | 打开 ngspice 的单 plot ASCII 或 little-endian binary 文件 | RC 瞬态电压、电流、AC 复数分量，ASCII 与 binary 逐点对照 |

RAW 和 PSF ASCII 使用现有的窗口查询。瞬态使用 1 fs tick。RAW 的 AC 使用 1 mHz tick，复数保存在成对的 `.re` 和 `.im` 实数通道。当前内存读取上限为每文件 400 万个标量。 [ngspice RAW 文件说明](https://ngspice.sourceforge.io/docs/ngspice-45-manual.pdf)

从工作区外的临时目录复现，以下命令中的 `fixture` 指向本仓库的 `test/fixtures/analog`。WDB 和 SHM 使用同一个 testbench。

```sh
xrun -64bit -access +rwc +define+DUMP_SHM "$fixture/vendor_real.sv"
xvlog -sv "$fixture/vendor_real.sv"
xelab mixed_tb -debug all -s ww_mixed
printf '%s\n' 'log_wave -r /mixed_tb/*' 'run all' 'quit' > run.tcl
xsim ww_mixed -wdb mixed.wdb -tclbatch run.tcl
spectre -64 -format psfascii -raw results "$fixture/rc.scs"
ngspice -n -b "$fixture/rc.cir"
```

回到 Wave Workbench 工作树，构建本机后端后运行回归。环境变量接收实际生成的绝对路径。WDB 直接运行后端测试时需同时设置 Vivado 的 `RDI_DATADIR` 和 `LD_LIBRARY_PATH`。扩展会根据所选工具路径给 WDB 子进程设置这两个变量。

```sh
export WAVE_TEST_ANALOG_SHM=/path/to/mixed.shm
export WAVE_TEST_ANALOG_WDB=/path/to/mixed.wdb
export WAVE_TEST_ANALOG_PSF=/path/to/results/tr.tran.tran
export WAVE_TEST_NGSPICE_DIR=/path/to/ngspice-outputs
export XCELIUM_HOME=/path/to/xcelium
export XILINX_VIVADO=/path/to/vivado
export RDI_DATADIR="$XILINX_VIVADO/data"
export LD_LIBRARY_PATH="$XILINX_VIVADO/lib/lnx64.o${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
npm run build
node --test test/analog-wave.test.js
```

# Wave Workbench

**在 VS Code 里调试 Verilator 仿真。** Wave Workbench 原生读取 **FST** 和 **VCD**，用 Verilator 的 elaboration JSON 连接波形、实例树与 SystemVerilog 源码。Verilator 工作流无需商业仿真器、波形 SDK 或许可证服务器。 [Verilator 开源许可](https://verilator.org/guide/latest/copyright.html)

如果你平时用 GTKWave 打开 VCD 或 FST，同一份波形可以直接在 Wave Workbench 里使用。把光标停在出问题的周期，跳到 RTL 或悬停查看信号值，再把整个调试现场保存成 `.waveproj`。远程项目可在 VS Code Remote SSH 的同一窗口里完成这些操作。

| 功能 | 在 Verilator 工程里怎么用 |
| --- | --- |
| **原生波形** | 小仿真用 VCD，长仿真用 FST。扩展按信号批次和时间窗读取，可分页搜索信号。 |
| **实例树与 RTL** | 浏览参数化实例和 generate 作用域，从波形定位信号声明、模块定义或例化位置。选中 RTL 信号可批量加到波形。 |
| **按时刻查看 RTL** | 设置 A 游标后，在 RTL 信号上悬停即可查看这一时刻的采样值。 |
| **保存调试现场** | `.waveproj` 恢复信号顺序、分组、标签、解码、游标、标记以及实例树的选中和展开状态。 |
| **自动化** | 通过 Tcl 或 MCP 打开工程、查询信号、截取区间、导出 PNG／CSV／JSON／VCD，并直接保存工程。 |

## 安装

准备 Node.js 22+、Rust/Cargo 和平台编译工具，从源码构建当前平台的 VSIX。

```sh
git clone https://github.com/AndreaFrederica/vscode-wave-workbench.git
cd vscode-wave-workbench
npm ci
npm run package:native
```

在 VS Code 扩展视图中选择「从 VSIX 安装…」。使用 Remote SSH 时，在运行工作区扩展的远端主机上构建并安装对应平台的包。打包脚本支持 Linux、macOS 和 Windows 的 x64 与 ARM64 目标。打开现成波形可以先用仓库里的示例。 [示例 VCD](examples/demo.vcd)

平台 VSIX 内置 Tcl 8.6、标准脚本库及许可文件，安装后可直接运行 Tcl。Windows 源码打包请在对应架构的 Visual Studio Developer Command Prompt 运行。跨平台打包时，可用 `--tcl-runtime` 指定为目标平台构建好的 Tcl 运行时目录。目录包含 `bin/tclsh`（Windows 为 `bin/tclsh.exe`）、`lib/tcl8.6`、`LICENSE-Tcl.txt`、`LICENSE-zlib.txt` 和 `LICENSE-LibTomMath.txt`。 [Tcl 构建说明](https://www.tcl-lang.org/doc/howto/compile.html)

**RTL 语言服务（LSP）建议安装 Vide。** 在 VS Code 扩展视图搜索 `pascal-lab.vide-code-extension`。Vide 为 Verilog 和 SystemVerilog 提供代码补全、诊断和语义高亮，Wave Workbench 负责波形浏览和 RTL 联动。 [Vide 扩展](https://marketplace.visualstudio.com/items?itemName=pascal-lab.vide-code-extension)

## 跑通第一个 Verilator 示例

用 Verilator 5.054 和仓库自带的计数器示例生成一份真实 FST 与实例树。FST 仿真构建可能需要系统的 LZ4 和 zlib 开发包。 [Verilator 追踪与 JSON 参数](https://verilator.org/guide/latest/exe_verilator.html)

```sh
cd test/fixtures/verilator
verilator --json-only --top-module top fixture.sv
verilator --cc --exe --build --trace-fst --top-module top --Mdir obj_fst fixture.sv sim.cc
./obj_fst/Vtop
```

1. 在 Wave Workbench 侧栏打开 `top.fst`。扩展会查找 `obj_dir/Vtop.tree.json` 和相邻的 `Vtop.tree.meta.json`。
2. 展开 `top`，再展开参数不同的 `u0` 和 `u1`。启用实例树的「显示信号」，双击 `pc` 添加两路计数器。
3. 将 A 游标设在一次计数回绕附近，从「源码」菜单打开 `pc` 的声明，悬停查看采样值。要同时观察回绕前后，可用 Shift 加单击放置 B 游标。
4. 用「文件 → 保存波形工程…」生成 `.waveproj`，再从「打开波形工程」恢复视图。

用 `--trace-vcd` 和独立的输出目录构建同一个示例，即可生成 `top.vcd`。仓库还提供一个约 477 MiB、包含 1,604 个信号条目的 FST 测试，覆盖信号分页、逐窗读取和末段跳转。 [测试样例与运行方法](test/fixtures/verilator/README.md)

## 接入你自己的 Verilator 工程

构建仿真时启用 `--trace-fst` 或 `--trace-vcd`，并在 testbench 或 C++ 驱动里开启波形输出。再用相同的顶层、RTL 文件、include 路径、宏和参数运行 `verilator --json-only`。将 `.tree.json` 与 `.tree.meta.json` 放在同一目录。 [Verilator JSON 参数](https://verilator.org/guide/latest/exe_verilator.html#cmdoption-json-only)

波形和 JSON 位于不同目录时，可以从侧栏「接入设计数据库」选择 **Verilator elaboration JSON**，或为工作区设置固定路径。

```json
{
  "waveWorkbench.defaultWaveform": "build/top.fst",
  "waveWorkbench.verilatorTreePath": "build/obj_dir/Vtop.tree.json",
  "waveWorkbench.mcpEnabled": true
}
```

`.waveproj` 以相对路径引用波形和设计数据库。分享工程时一并保留 FST 或 VCD、两份 JSON 及 RTL 源码，并保持工程和波形文件的相对位置。RTL 路径迁移时可在 VS Code 里配置 `waveWorkbench.sourcePathMappings`。 [调试工作流](WORKFLOW.md)

## 调试、解码与自动化

- **浏览波形**。拖动底部滚动条浏览整个时间轴，用 Ctrl 加滚轮缩放，按 `[` 和 `]` 跳到选中信号的相邻边沿，按 `M` 添加命名标记。
- **解码与标注**。给总线和指令绑定 RISC-V、TL-UL、AXI、UART 或 I²C 规则，为关键状态添加标签和注释，工作区可以维护自己的解码配置。 [解码规则](COMMANDS.md#波形解码和信号注释)
- **Tcl**。使用侧栏或底部控制台执行 `wvAddSignal`、`wvZoom` 和 `wvSetCursor` 等命令。插件默认使用内置 Tcl，也可通过 `waveWorkbench.tclshPath` 指定其他解释器。 [Tcl 命令](COMMANDS.md)
- **MCP**。Linux 或 macOS 的扩展宿主可启用 `waveWorkbench.mcpEnabled`。用 `wave_open` 打开 FST、VCD 或工程，`wave_clip` 提取原始事件，`wave_export` 导出片段，`wave_save_project` 无弹窗保存。可传 `path` 指定文件，省略时保存到当前工程或波形旁的同名工程。 [MCP 接口](COMMANDS.md#波形工程布局与-mcp090)

## 现有 FSDB 和 VCS KDB 项目

使用 FSDB 和 KDB 的团队可以在 Linux x86-64 的扩展宿主上，用自己的 Verdi 安装和许可构建带 Verdi 桥接的 VSIX。

```sh
export VERDI_HOME=/path/to/verdi
npm ci
npm run package:native -- --target linux-x64 --verdi
```

在 VS Code 中将 `waveWorkbench.verdiHome` 指向 Verdi 根目录，并将 `waveWorkbench.fsdbBackend` 设为 `verdi`。打开 FSDB 后，选择与该次构建对应的 `simv.daidir`，也可通过 `waveWorkbench.kdbPath` 指定。

## 许可

Wave Workbench 源码采用 MPL-2.0。Verilator、Verdi SDK、NPI 和其他依赖适用各自的许可。 [项目许可](LICENSE)

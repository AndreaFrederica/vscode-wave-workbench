# Wave Workbench

Wave Workbench 是 VS Code 的数字波形调试扩展。它支持 VCD，并通过本机 Verdi 的 FSDB Reader 和 NPI 读取 FSDB 与 VCS KDB。接入 KDB 后，可以在波形、实例树和 RTL 之间定位。波形工程支持保存信号分组、游标、标签和解码设置。

## 从源码构建

调试 FSDB 和 KDB 时，请先在运行 VS Code 扩展的 Linux x86-64 环境准备自己的 Verdi 安装和相应许可，再从源码构建 VSIX。使用 Remote SSH 时，在远端准备 Verdi、构建扩展，并把 VSIX 安装到该远端会话。

构建需要 Node.js 22+、Rust/Cargo、C++ 编译器和归档工具 `ar`。将 `VERDI_HOME` 指向包含 `share/FsdbReader` 和 `share/NPI` 的 Verdi 安装根目录。以下命令会编译 Verdi 桥并生成 `wave-workbench-linux-x64-<版本>.vsix`。

```sh
git clone https://github.com/AndreaFrederica/vscode-wave-workbench.git
cd vscode-wave-workbench
export VERDI_HOME=/path/to/verdi
npm ci
npm run package:native -- --target linux-x64 --verdi
```

在 VS Code 扩展视图里选择「从 VSIX 安装…」，打开生成的文件。Tcl 控制台需要 Tcl 8.6+，默认从 `PATH` 查找 `tclsh`。也可通过 `waveWorkbench.tclshPath` 指定解释器路径。

只需查看 VCD 时，在 Linux、macOS 或 Windows 的 x64 或 ARM64 主机上运行 `npm ci` 和 `npm run package:native` 即可为当前平台打包。可用仓库中的示例验证安装。 [示例波形](examples/demo.vcd)

## 配置 Verdi 和打开波形

在 VS Code 设置中将 `waveWorkbench.verdiHome` 指向扩展宿主上的 Verdi 安装目录，并在工作区设置中将 `waveWorkbench.fsdbBackend` 设为 `verdi`。留空的 `verdiHome` 会使用扩展宿主环境中的 `VERDI_HOME` 或 `NOVAS_HOME`。

```json
{
  "waveWorkbench.verdiHome": "/path/to/verdi",
  "waveWorkbench.fsdbBackend": "verdi"
}
```

1. 从 Wave Workbench 侧栏的「选择文件…」打开 `.fsdb`、`.vcd` 或 `.waveproj`。文件已在文本编辑器打开时，使用「重新打开编辑器的方式… → Wave Workbench」。
2. 从侧栏接入与 FSDB 同一次仿真构建生成的 `simv.daidir`。扩展会尝试波形同目录的 `simv.daidir`。也可以手动选择，或设置 `waveWorkbench.kdbPath`。
3. 双击实例下的信号可将它加入波形。在 RTL 编辑器选中信号后，也可以按 `Ctrl+Alt+Enter` 批量添加。

打开 FSDB 后，可从「文件」菜单确认当前后端。遇到加载问题时，在 VS Code 的「输出」面板选择「Wave Workbench」查看诊断信息。

## 浏览波形与 RTL

| 操作 | 用法 |
| --- | --- |
| 平移和缩放 | 拖动底部滚动条浏览完整时间范围。中键拖动可平移，`Ctrl` 加滚轮可缩放，左键拖选区间可放大。 |
| A 游标 | 单击波形或输入顶部 A 时间。`Value @ A` 和 RTL 悬停使用该时刻的值。`[` 和 `]` 可移动到所选信号的前一个或后一个边沿。 |
| B 游标 | `Shift` 加单击波形，或输入顶部 B 时间。`Δ` 显示 A 到 B 的时间差，`A↔B` 缩放到两者之间的区间。 |
| 命名标记 | 按 `M` 在 A 处创建标记。单击标记跳转 A，拖动可改时间，双击可编辑。 |
| 显示和布局 | 顶部可切换时间单位。「显示」菜单可调整行高。拖动分隔线可调整信号名、值列和波形画布的宽度。 |
| 标签和注释 | 点击信号行末的铅笔。侧栏「已打标签的信号」支持筛选和改色，Instance 树开启「显示信号」后也能查看和编辑标签。 |
| RTL 定位 | 接入 KDB 后，从「源码」菜单跳到信号声明、模块实例或模块定义。悬停在 RTL 信号上可查看 A 游标时刻的值。 |

用「文件 → 保存波形工程…」保存 `.waveproj`。工程引用原始波形，保存分组、布局、标签、游标、标记和解码设置。仿真目录移动后，可通过 `waveWorkbench.sourcePathMappings` 调整源码路径，或通过 `waveWorkbench.hierarchyMappings` 调整 FSDB 与 KDB 的层次前缀。 [调试工作流](WORKFLOW.md)

## 解码、导出与自动化

- **解码**。在「解码」菜单为所选信号绑定 RISC-V、TL-UL、AXI、UART 或 IIC 规则。工作区规则放在 `.vscode/wave-decoders/`，内置规则可复制后编辑。 [解码规则](COMMANDS.md#波形解码和信号注释)
- **导出**。按当前视窗或 A/B 区间截取选定的信号，导出 PNG、CSV、JSON 或 VCD。 [波形截取接口](COMMANDS.md#截取--导出波形091)
- **Tcl**。侧栏和底部控制台支持 `wvAddSignal`、`wvZoom`、`wvSetCursor` 等命令。输入 `waveHelp` 查看命令集，或运行 `.tcl` 脚本重放调试视图。 [Tcl 命令文档](COMMANDS.md)
- **MCP**。在 Linux 或 macOS 扩展宿主启用 `waveWorkbench.mcpEnabled` 并重载窗口，可从 MCP 客户端打开波形、执行 Tcl、保存工程及导出片段。 [MCP 配置与接口](COMMANDS.md#波形工程布局与-mcp090)

## 许可

Wave Workbench 源码采用 MPL-2.0。Verdi SDK、NPI 和第三方依赖适用各自的许可。 [项目许可](LICENSE)

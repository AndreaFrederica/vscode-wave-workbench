# Wave Workbench

Wave Workbench 是 VS Code 的数字波形调试扩展。它直接打开 FSDB 和 VCD，接入 VCS 的 KDB 后可以在波形、实例树和 RTL 之间定位。波形工程可以保存信号分组、布局、游标、解码规则和标签，便于重开或共享同一套调试视图。

## 快速开始

1. 在 VS Code 的扩展视图选择「从 VSIX 安装…」。使用 Remote SSH 时，将扩展安装在仿真文件所在的远端。
2. 直接打开 `.fsdb` 或 `.vcd`，也可用 Wave Workbench 侧栏的「选择文件…」打开波形或 `.waveproj` 工程。波形已在文本编辑器中打开时，使用「重新打开编辑器的方式… → Wave Workbench」。仓库内的示例可以直接试用。 [示例波形](examples/demo.vcd)
3. 查看设计层次时，从 Wave Workbench 侧栏接入与 FSDB 同一仿真构建生成的 `simv.daidir`。扩展会尝试波形同目录的 `simv.daidir`，也可手动选择或设置 `waveWorkbench.kdbPath`。
4. 双击目录或实例下的信号即可添加到波形。也可在 RTL 中选中信号，按 `Ctrl+Alt+Enter` 批量添加。

## 切换 FSDB / KDB 后端

打开 FSDB 后，按 `Ctrl+Shift+P` 运行 **Wave Workbench: 选择 FSDB 后端…**。波形编辑器和 Wave Workbench 侧栏的标题工具栏也有这个入口。选中后会切换当前 FSDB 及已接入的 KDB，并将选择保存到工作区。其他已打开的 FSDB 可以分别切换或重新打开。

| 选项 | 读取方式 | 运行要求 |
| --- | --- | --- |
| 独立后端 | WaveBench Reader 直接读取 FSDB 和 KDB | Linux、macOS、Windows 的 x64 和 ARM64，需安装 LZO 2 |
| Verdi 后端 | Rust 后端调用 Verdi Reader 和 NPI | Linux x86-64、与后端兼容的 Verdi 库及相应许可 |
| 自动 | 优先尝试已配置的 Verdi 后端，启动或打开失败时回退至 WaveBench Reader | 取决于选中的后端 |

也可以在工作区设置里直接设置 `waveWorkbench.fsdbBackend`。例如将新打开的 FSDB 默认交给随附的独立后端。

```json
{
  "waveWorkbench.fsdbBackend": "independent"
}
```

打开波形后，展开顶部「文件」菜单，查看文件名下方显示的实际后端。切换失败时，原会话仍可使用，诊断信息在「输出 → Wave Workbench」。 [WaveBench Reader 库与对照验证](native/README.md)

`waveWorkbench.independentBackendPath` 指向自定义独立后端可执行文件，留空时启动随附的 `bin/wave-backend-independent --independent`。`waveWorkbench.backendPath` 用于覆盖 Verdi/VCD 的 `wave-backend` 二进制。`waveWorkbench.verdiHome` 指向 Verdi 安装目录，留空时依次读取 `VERDI_HOME` 和 `NOVAS_HOME`。Remote SSH 环境使用远端设置、可执行文件和系统库。VCD 使用 Rust 读取路径。

同时装有两个后端时，可以在 FSDB 中选择信号，运行「Wave Workbench: 调试对比 Verdi 与独立后端…」，按当前视窗或 A/B 范围生成报告。报告列出两端的文件元数据、首个不同的 tick、截断状态，以及已接入 KDB 的声明位置。未选信号时使用当前显示的物理信号，每次最多 32 个。

## 浏览波形与 RTL

| 操作 | 用法 |
| --- | --- |
| 平移和缩放 | 拖动波形底部的全长滚动条，滑块表示当前视窗的位置和占比。中键拖动可平移，`Ctrl` + 滚轮可缩放，左键拖选区间可放大。 |
| A 游标 | 单击波形或输入顶部 A 时间。`Value @ A` 和 RTL 悬停使用该时刻的值。`[` / `]` 在所选信号的边沿间移动。 |
| B 游标 | `Shift` + 单击波形或输入顶部 B 时间。`Δ` 显示 A 到 B 的时间差，`A↔B` 将视图缩放到两者之间。 |
| 命名标记 | 按 `M` 在 A 处创建标记。单击标记跳转 A，拖动可改时间，双击可编辑。 |
| 时间单位和布局 | 顶部选择原始单位或 fs、ps、ns、µs、ms、s。「显示」可调整行高。拖动两条分隔线可调整 `Signal`、`Value @ A` 和波形画布的宽度。 |
| 标签和注释 | 点击信号行末的铅笔。侧栏「已打标签的信号」支持筛选和改色。打开 Instance 树上的「显示信号」，展开节点即可在信号行上查看和编辑标签。 |
| RTL 定位 | 接入 KDB 后，从「源码」菜单跳到信号声明、模块实例或模块定义。悬停源代码中的信号可查看游标 A 的值。 |

使用「文件 → 保存波形工程…」保存 `.waveproj`。工程文件引用原始波形，保存信号、分组、布局、标签、游标、命名标记和解码绑定。移动仿真构建目录后，可用 `waveWorkbench.sourcePathMappings` 映射源码路径，用 `waveWorkbench.hierarchyMappings` 映射 FSDB 与 KDB 的层次前缀。 [调试工作流](WORKFLOW.md)

## 解码、截取与自动化

- **解码**。选中信号，从「解码」菜单选择 RISC-V、TL-UL、AXI、UART 或 IIC 预设。UART 支持配置波特率、数据位、校验、停止位、位序与反相。IIC 预设解码地址字节。内置规则可编辑副本，工作区规则放在 `.vscode/wave-decoders/`。 [规则文件与 Tcl 命令](COMMANDS.md#波形解码和信号注释)
- **截取**。在「截取 / 导出波形…」选择信号和时间范围，导出 PNG、CSV、JSON 或可重新打开的 VCD。可使用当前视窗或 A/B 区间。 [波形截取接口](COMMANDS.md#截取--导出波形091)
- **Tcl**。侧栏和底部控制台支持 `wvAddSignal`、`wvZoom`、`wvSetCursor` 等常用命令。输入 `waveHelp` 查看当前命令集。支持运行脚本及使用 `.tcl` 重放视图，运行机需要 Tcl 8.6+。 [Tcl 兼容范围](COMMANDS.md)
- **MCP**。启用 `waveWorkbench.mcpEnabled` 并重载窗口。MCP 客户端在扩展宿主所在机器上运行 `node <插件路径>/dist/mcp.js <工作区绝对路径>`，可列出和打开波形、执行 Tcl、保存工程以及截取和导出波形。 [MCP 配置与接口](COMMANDS.md#波形工程布局与-mcp090)

## 从源码构建

需要 Node.js 22+ 和 Rust/Cargo。以下命令生成对应当前系统及架构的 VSIX。

```sh
npm ci
npm run package:native
```

可以通过 `--target` 选择 VS Code 的平台标识。交叉构建需要用 `rustup target add` 安装目标 Rust 标准库，并给 Cargo 提供该目标的链接器和系统 SDK。比如在 Linux x64 上使用 `aarch64-linux-gnu-gcc` 构建 Linux ARM64。

```sh
rustup target add aarch64-unknown-linux-gnu
CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc \
  npm run package:native -- --target linux-arm64
```

GitHub Actions 在六种系统与架构对应的原生 runner 上分别构建、测试并打包 WaveBench Reader。每个 VSIX 通过 `vsce --target` 标明平台，标签构建完成后上传到 GitHub Releases。远程窗口使用远端扩展宿主对应的包。

| 系统 | VSIX 目标 | 独立 FSDB/KDB 的 LZO 2 |
| --- | --- | --- |
| Linux | `linux-x64`、`linux-arm64` | 安装发行版的共享库，例如 Debian/Ubuntu 的 `liblzo2-2` |
| macOS | `darwin-x64`、`darwin-arm64` | `brew install lzo` |
| Windows | `win32-x64`、`win32-arm64` | 安装对应架构的 LZO DLL，例如用 vcpkg 安装 `lzo:x64-windows` 或 `lzo:arm64-windows`，将 DLL 的绝对路径填入 `waveWorkbench.lzoLibraryPath` |

VCD 可直接打开。Tcl 命令需要 Tcl 8.6+，默认从 `PATH` 查找 `tclsh`。Windows 主机上的 MCP 本地桥仍依赖 Unix socket，可在 Linux 扩展宿主（例如 Remote SSH 或 WSL）使用。

Verdi 的 C++ 桥只在原生 Linux x64 上通过 `npm run package:native -- --verdi` 构建。该构建启用 Cargo 的 `verdi-sdk` 功能，需要 `VERDI_HOME`、C++ 编译器以及兼容的 Verdi Reader 和 NPI 开发文件。GitHub 的六平台发布包使用默认 Cargo 构建，运行时由 WaveBench Reader 加载目标平台的 LZO 2 共享库。 [实现结构](ARCHITECTURE.md) · [验证记录](VALIDATION.md)

## 支持范围

波形界面支持数字四态标量及总线。Rust 读取路径保留 64 位整数时间戳，画布支持 JavaScript 安全整数范围内的 tick。VCD 当前在内存中解析，文件上限为 128 MiB、20 万条信号声明、200 万次值变化。独立后端的 FSDB/KDB 格式范围及 Verdi 对照数据见其说明。 [独立后端说明](independent_backend/README.md)

项目采用 MPL-2.0 许可。Verdi SDK、NPI 和系统 LZO 各自适用其许可。 [项目许可](LICENSE)

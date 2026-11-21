# RTL 追踪快速入门

用仓库里的双请求仲裁 testbench，从 `owner_q` 回溯请求、仲裁和寄存器更新。示例使用 Verilator 5.054 与 VCD。

## 安装两份扩展

在 Wave Workbench 工作树执行 `npm ci` 和 `npm run package:native`。驱动与负载追踪、按仿真工程追踪和 VCS KDB 模块内的 RTL 逻辑显示需要项目 fork 提供的 VIDE 接口。此版本已验证的 VIDE 提交是 `cfb0a7c0`，位于 `wave-workbench-trace` 分支。 [Wave Workbench 构建要求](README.md#安装) · [修改版 VIDE 提交](https://github.com/AndreaFrederica/vide/commit/cfb0a7c04e77a93e5f3f2396fc68f91bcc1b97ad)

```sh
git clone --recurse-submodules --branch wave-workbench-trace https://github.com/AndreaFrederica/vide.git
cd vide
git checkout --detach cfb0a7c04e77a93e5f3f2396fc68f91bcc1b97ad
git submodule update --init --recursive
cd editors/vscode
npm ci
npm run package:vsix
```

构建 VIDE 需要仓库指定的 Rust 工具链、CMake 和支持 C++20 的编译器。在同一个 VS Code 扩展宿主中安装两份 VSIX，安装后重载窗口。Remote SSH 下在远端安装。修改版沿用 `pascal-lab.vide-code-extension` 扩展 ID，请为该扩展关闭自动更新，保留从 VSIX 安装的版本。

## 构建并在 VS Code 追踪

从 Wave Workbench 仓库根目录运行。

```sh
fixture="$PWD/test/fixtures/trace"
mkdir -p build/trace-hart1
cd build/trace-hart1
printf '%s\n' '+define+TRACE_PREFER_HART_1' "$fixture/trace_tb.sv" > sources.f
verilator --json-only --top-module trace_tb -f sources.f
verilator --cc --exe --build --trace-vcd --top-module trace_tb \
  --Mdir obj_vcd -f sources.f "$fixture/sim.cc"
./obj_vcd/Vtrace_tb
```

1. 在 VS Code 打开 `build/trace-hart1` 目录作为工作区，再打开 `trace.vcd`。
2. 从「源码 → 接入设计数据库」选择 **Verilator elaboration JSON**，指定 `obj_dir/Vtrace_tb.tree.json`。保留同目录生成的 `Vtrace_tb.tree.meta.json`。
3. 运行 **Set Simulation Filelist for Active Waveform Trace**，选择 `sources.f` 和工作区目录。插件会为本次仿真创建隔离的 VIDE 项目，并索引实际使用的 TB、RTL 和宏。可以通过 **Preview VIDE Project from Simulation Filelist** 核对配置。
4. 将 `TOP.trace_tb.dut.owner_q` 添加到波形并选中。在 tick 3 设置 A 游标，从「追踪」菜单选择「查看 A 游标追踪证据」。Trace Explorer 展开后可定位 RTL 写入和上游变化，Markdown 报告包含 Mermaid。用「追踪驱动」查看静态上游，或选中上游信号并用「追踪负载」查看下游。

两个请求在 tick 3 同时到达，`TRACE_PREFER_HART_1` 使 `owner_q` 更新为 1。tick 5 有请求但未接收，`owner_q` 保持。使用另一目录构建省略该宏的版本，tick 3 的 `owner_q` 为 0。 [样例预期与回归](test/fixtures/trace/README.md#rtl-trace-fixture)

## 通过 MCP 导出图和报告

在同一 VS Code 工作区启用 `waveWorkbench.mcpEnabled` 并重新加载。MCP 客户端的 stdio 命令为 `node`，参数依次为已安装 Wave Workbench 扩展中的 `dist/mcp.js` 绝对路径和工作区绝对路径。可直接在当前构建目录运行以下命令，先把 `mcp` 改为实际安装路径。命令使用 `jq` 提取响应正文。 [MCP 本地连接](COMMANDS.md#波形工程布局与-mcp090)

```sh
mcp="/absolute/path/to/installed-wave-workbench/dist/mcp.js"
workspace="$PWD"
waveform="$workspace/trace.vcd"
signal="TOP.trace_tb.dut.owner_q"

call_trace_tool() {
  jq -cn --arg name "$1" --argjson args "$2" \
    '{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:$name,arguments:$args}}' |
    node "$mcp" "$workspace" |
    jq -e 'if .error then error(.error.message)
      elif .result.isError then error(.result.content[0].text)
      else .result.content[0].text | fromjson end'
}

call_trace_tool wave_open "$(jq -cn --arg path "$waveform" '{path:$path}')"
args="$(jq -cn --arg waveform "$waveform" --arg signal "$signal" \
  --arg filelist "$workspace/sources.f" \
  '{waveform:$waveform,signal:$signal,filelist:$filelist,
    expandReachable:true,format:"mermaid",detail:"full"}')"
call_trace_tool wave_trace_drivers "$args" > drivers.json
call_trace_tool wave_trace_context \
  "$(printf '%s\n' "$args" | jq -c '. + {tick:"3",historyStart:"0"}')" > context.json
jq -er '.mermaid' drivers.json > drivers.mmd
jq -er '.temporalMermaid' context.json > causality.mmd
jq -er '.report' context.json > trace-report.md
```

大图的 `mermaidPages` 和 `temporalMermaidPages` 返回全部图页。需要继续回溯时，静态结果的 `staticCoverage.stops` 和时间图的 `context.temporalTrace.gaps` 给出停止原因以及可用的续查入口。Trace Explorer 对应入口是 **Continue from**。 [预算、分页与续查参数](COMMANDS.md#rtl-追踪与波形证据)

在界面的「追踪」菜单中可自动续查上游驱动、下游负载或 A 游标的上游。每批最多查询 64 段，续查时限为 100 秒。达到预算或在续查期间取消后，Trace Explorer 保留已得到的图和待查入口，可通过 **Continue next batch** 继续。MCP 请求也可用 `followContinuations` 指定较小的续查数量，`detail: "full"` 将续查总览和证据加入同一份报告。 [自动续查输出](COMMANDS.md#rtl-追踪与波形证据)

在 Trace Explorer 的 **Combined static dependencies** 或 **Combined time graph** 中，**Continue next batch** 将下一批结果加入原图，并打开更新后的详细报告。

重新打开工作区后，可在保存的离线合并图上使用 **Continue next batch**。续查会先核验波形、RTL、编译配置、设计数据库及使用过的执行记录。输入变化时仍可查看保存的图，并从当前输入开始一次新追踪。在线续查对应原仿真会话。

MCP 结果含 `continuationCursor` 时，将它交给 `wave_trace_resume` 可查询下一批上游，并把新证据接到同一张图上。后续使用当前 MCP 会话中最新响应的游标。 [跨请求续查](COMMANDS.md#rtl-追踪与波形证据)

MCP 可从单个信号设置 `followAllContinuations: true` 自动追踪可解析路径。静态查询用 `wave_trace_drivers` 或 `wave_trace_loads`，离线时间因果用 `wave_trace_context`，在线仿真用 `wave_live_trace`。达到单次预算时可用 `wave_trace_resume` 继续。分页图的 `frontier`、`queryFailures` 和 `gaps` 分别列出剩余入口、失败查询与证据缺口。

合并时间图的节点保留可用的 `declaration` 和 `waveformSignal`。从 Trace Explorer 或本次追踪原理图选中续查节点，可跳到其 RTL 声明或加入对应的波形。只有已绑定到参考波形的节点提供加入波形操作。

大型图和报告可用 `output: "paged"` 生成快照。之后用 `wave_trace_graph_page` 分页读取 `mermaid` 或 `report`，也可以在创建快照时用 `format: "mermaid"` 和 `detail: "full"` 预先生成。只要图游标仍有效，续查结束后仍可导出图表和完整报告。 [图快照分页](COMMANDS.md#rtl-追踪与波形证据)

在大型时间图的 `nodes` 分页找到关注的上游节点后，将原图游标和节点编号交给 `wave_trace_graph_path`。默认提取每个选定节点到根的一条最短路径。设为 `mode: "all"` 可保留原快照中这些节点通往追踪根的所有已记录分支。用局部快照的游标分页导出 Mermaid 和详细报告。 [路径提取](COMMANDS.md#rtl-追踪与波形证据)

## 回放与在线追踪

| 手头的数据 | VS Code 入口 | MCP 入口与证据 |
| --- | --- | --- |
| 波形、同次展开 JSON 或 KDB、仿真编译配置 | 「追踪驱动」「追踪负载」「查看 A 游标追踪证据」 | `wave_trace_drivers`、`wave_trace_loads`、`wave_trace_context`。离线时间图给出观测及候选路径 |
| 同次构建的执行 JSONL | 「结合执行记录追踪 A 游标…」或 **Open Execution Recording** | `wave_trace_context` 加 `executionLog` 核对波形与执行序列，`wave_execution_trace` 可单独读执行事件 |
| 支持在线控制的 Verilator harness 或 VCS `simv` | **Start Live Trace Harness** 或 **Start VCS Live Trace**，随后使用 **Control Live Trace** 和 **Trace Live Signal** | `wave_live_status` 报告能力，`wave_live_control` 步进和设断点，`wave_live_trace` 查询当前或保留的槽末快照 |

带源码映射的执行回放需要对应的源码、编译信息和覆盖声明。实时会话使用相同构建清单及执行日志时，可核对根信号和上游的求值、提交与回调。VCS 可用 `wave_execution_map` 生成探针，固定目标和数组字 NBA 可选 `captureGuards`。 [执行记录与在线控制参数](COMMANDS.md#rtl-追踪与波形证据) · [VCS NBA 构建及回放命令](test/fixtures/trace/README.md#vcs-nba-commit-probes)

已有 VCS 项目可先关联与波形对应的 `simv.daidir`。插件可从 `vcs_rebuild` 恢复 testbench 的编译参数，也可使用显式 filelist、`vide.toml` 或带哈希的构建清单。报告中的编译缺口、未采集信号及同一时槽的候选用于判断哪些关系还需要更多证据。 [TB 编译配置与兼容性](RTL_TRACE_PLAN.md#testbench-与-vide-工程配置)

## 在桌面 VS Code 验证 VSIX

按双请求仲裁 fixture 的构建说明生成 `hart1` 目录，包含 `trace.vcd`、`trace.fst` 和同一构建配置的 Verilator JSON 与元数据。目录可复制到另一台机器，在目标系统上运行对应架构的两份 VSIX。 [双请求仲裁 fixture](test/fixtures/trace/README.md#rtl-trace-fixture)

```text
node scripts/smoke-rtl-trace.mjs "<VS Code 桌面可执行文件>" "<Wave Workbench VSIX>" "<VIDE VSIX>" "<hart1 目录>"
```

第一个参数使用桌面程序本体，例如 Windows 的 `Code.exe`、macOS 应用包内 `Contents/MacOS/Electron`，或 Linux 的 `/usr/share/code/code`。脚本在隔离目录安装两份扩展，启动真实扩展宿主，通过 MCP 核对 Driver、Load、FST/VCD 时间图及详细报告，并打开对应的 RTL 赋值位置。运行结果和导出的图保存在输出目录。 [VS Code 扩展测试入口](https://code.visualstudio.com/api/working-with-extensions/testing-extension#advanced-setup-your-own-runner)

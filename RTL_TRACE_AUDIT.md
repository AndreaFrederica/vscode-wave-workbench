# RTL Trace 全量待办核查

2026-11-22 核查 Wave Workbench `1e200f0` 和 VIDE `cfb0a7c0` 的本地工作树，两边均包含未提交改动。原计划共 454 个复选项，423 个已记录完成，31 个仍开放。本表逐项核查这 31 项，复跑横跨 Phase 0–7 的代表性回归。已勾选的历史子项以原计划执行记录为索引，复跑范围见下文。

| 阶段 | 已勾选历史子项 | 纳入本表的开放项 |
| --- | ---: | ---: |
| 0 基线、协议与 testbench 配置 | 104 | 8 |
| 1 VIDE 静态语义 | 11 | 4 |
| 2 LSP 与扩展 API | 5 | 0 |
| 3 静态追踪、图与报告 | 112 | 9 |
| 4 离线时间因果 | 81 | 3 |
| 5 精确执行和回放 | 57 | 3 |
| 6 在线调试 | 26 | 0 |
| 7 性能与交付 | 27 | 4 |

## 逐项结论

行号对应首轮核查时的原计划。本轮开始时有 8 项开放。新增通过 1 项，当前有 24 项通过，7 项保留验收缺口。 [原计划](RTL_TRACE_PLAN.md)

| 原计划行 | 检查项 | 已核对的能力 | 验收状态与缺口 |
| ---: | --- | --- | --- |
| 51 | 版本化协议 | 验证静态和时间图、构建清单、执行日志及实时快照的版本。实际 VCS 与 Verilator 的新旧生产端和读取端通过 8 组配对，回归同时验证能力缺失、时基错误及会话内版本变化。 | 通过。 |
| 78 | IDE 隔离项目与加载状态 | `openTraceProject` 接入真实 filelist。复验核对 revision、实际编译根、顶层、宏、包含路径和未采用选项。 | 通过。 |
| 105 | 仿真编译配置导入 | filelist 回归覆盖嵌套文件、环境变量、命名库、`-libmap`、覆盖项和缺失输入。真实 VCS 样本复验部分静态图和构建失配。 | 通过。无法映射的工具选项及生成输入以缺口显示。 |
| 121 | OpenTitan 固件输入端到端 | 新 VCS 运行记录 `+firmware`、固件及 FSDB 哈希。52 次实际读取逐字节匹配文件，仿真报告 `x28=480`。同次波形和执行记录回放把解码器观测接到 TB 任务、总线写入及文件偏移。 | 通过。第 533 项记录了同一次 `x28` 查询接到固件字节的实测路径。 |
| 131 | 解码器到实际取指与固件写入 | 修复数组字和执行日志结构体成员的位读取。真实 OpenTitan 从 `instr_rdata_i @ 2023000 ps` 出发，同一图经过 `cpu_rdata_o @ 2009000 ps`、字 36 的四次实际提交、任务提交和文件偏移 16–19。 | 通过。取指路径保留同槽候选边。 |
| 144 | 自动 task 调用身份 | 原样本用显式调用标识关联 13 次入口与成员写入。实际 VCS 并发夹具验证同一调用点的两个自动 task 在同 tick 反序提交，按身份找回调用点、成员写入和各自的文件字节。 | 通过。 |
| 152 | 四字节写入、握手与文件偏移 | 同次 OpenTitan FSDB 的两级 TL-UL 接受均匹配地址、source、掩码和数据。四个物理提交按位可达任务及文件读取。 | 通过。提交来源使用执行日志，波形允许的其他槽内候选仍显示。 |
| 178 | DPI 和外部激励 | Verilator 真实 C++ 线程记录请求和结果的捕获 tick 与跨线程顺序，也可独立提交完成事件。在线与波形回放核对了捕获、送达及 RTL 消费。同步 VCS DPI 已复验。 | 部分。VCS 自主外部回调仍缺同等采集。 |
| 188 | wildcard、接口与限定引用 | 独立 KDB 的 `.*` 复合 modport，以及 VCS 的参数化 generate、向上和向下读写、跨文件 Load、嵌套头文件宏及标识符拼接均通过。短兄弟路径已用 VCS 核实语义。 | 部分。短路径全工程索引使两项 RV32A 回归超时，已撤回该实现。VCS 对运行时 generate 下标给出编译诊断。 |
| 191 | Driver/Load 双向索引 | Rust 有读写位置、条件、NBA、多驱动和位选择用例。VCS 回归覆盖两次异步复位、同过程 NBA 覆盖、保持、两个 `case` 分支及位选 Load。 | 通过。复杂运行时绑定由第 196、245 和 492 项继续验收。 |
| 196 | 层次、参数与复杂语义诊断 | FST/KDB 覆盖端口、generate、选位和常量。VIDE 与实仿真核对复杂索引、过程循环、任务副作用、虚接口换绑、过程覆盖和未建模调度的诊断。 | 通过静态语义与诊断验收。精确运行时关联继续在第 245、267 项验证。 |
| 201 | 增量索引、取消和编辑功能 | OpenTitan RV32A 的 189 个编译根复验未保存修改、revision 与另一文件的图稳定性。大型样本同样通过 Definition、References、Rename，得到 1 个定义、16 个引用和 17 处重命名编辑。修复取消后的迟到响应。 | 通过功能验收。大型导航请求的延迟见第 533 项。 |
| 218 | FST、层次与实例绑定 | 仲裁 FST/VCD 回归覆盖两种宏构建、重复实例、端口及实际展开参数。单独 FST 样本核对端口切片和常量。 | 通过。复杂对象由第 245、267 项继续验收。 |
| 245 | 虚接口和物理写入 | VCS 语句回调从换绑后的 modport 取出物理成员。MCP 从 `left.data`、`right.data` 与 `result` 回放对应读取、写入、位置及实际值。 | 部分。运行时记录覆盖直接赋值操作数。复杂表达式及无运行记录的静态请求保留绑定缺口。 |
| 267 | KDB 其余端口表达式和匿名 generate | 独立 VCS KDB 补齐左移、右移、乘法和条件端口表达式。真实 VCS 波形核对运行值与 Load。匿名循环和嵌套条件通过 VCD、FSDB 对照。Verilator 覆盖等宽动态位段输出。 | 通过已确认的缺项。VCS 对所测的动态输出位段给出编译诊断。 |
| 274 | 有界 Fan-in/Fan-out 与缓存 | VCS KDB、Verilator 展开树、Xcelium SHM HDL 索引和 Vivado WDB 均通过 MCP 的关闭、取消及重新打开。修复外部设计文件更新后旧续查仍被接受。 | 通过。已有桌面用例复验 filelist 更新与并发查询。 |
| 276 | MCP Driver/Load 与 UI | 当前 Linux VSIX 通过 Driver、Load、时间图及源码联动。同版 VIDE 的静默 MCP 比对了图和报告。 | 通过。跨平台由第 557 项验收。 |
| 297 | 自动递归、预算与环路 | 回归核对共享节点、静态和时间环路、停止原因、分批续查及候选歧义。真实 VCS 样本耗尽前沿后保留缺样及反馈。 | 通过。返回实际覆盖与剩余缺口。 |
| 309 | 静态图与详细报告 | MCP 支持图、Mermaid、分页、续查、Markdown 和源码引用。Trace 界面专项覆盖渲染和操作。 | 通过。见桌面实测。 |
| 322 | 时间图、回放和在线报告 | FST/VCD/FSDB 时间图支持触发、保持和缺口。Verilator 与 VCS 同构建回放核对实际提交。 | 通过。复杂物理提交由第 492 项继续验收。 |
| 326 | UI/MCP 逐边和双 hart 验收 | 打包版 Linux VS Code 与静默 MCP 对照双 hart 回放及真实等值双驱动。既有环路、未 dump 和宽扇入夹具复验前沿、分页及续查。 | 通过。 |
| 363 | 有界组合与顺序时间图 | 回归覆盖跨周期、保持、触发、同值写入、位索引、预算和反馈。 | 通过。无充分采样时以候选、未观测或缺口表示。 |
| 377 | 歧义与诊断 | 同位段 NBA 已用 VCS 与 Xcelium 对照。日志截断、X/Z、时基与构建差异有回归。 | 通过。其他调度器行为随 Provider 增量验收。 |
| 416 | 双 hart 与跨周期 | 两套真实 Verilator FST 核对竞争时的 grant、双路 request 及最近值变化。实际 RV32A VCS 回放核对两路 `selected_hart`、ready 位、捕获和跨周期保持。 | 通过。 |
| 436 | Verilator 插桩入口 | 实测 Verilator 5.054 单线程的探针流式记录、两级 NBA 实际提交和在线离线回放。真实 `--threads 2` 模型返回明确诊断，未生成补丁目录。 | 通过。实际提交目前覆盖可识别的单线程模型存储点。 |
| 440 | 构建级 ID 与语句映射 | Verilator 5.054 为每实例的两个单行赋值宏调用生成独立 ID，回放显示调用与定义位置并核对哈希。实测六组 NBA 求值和提交，包括常量折叠存储。 | 部分。跨文件、多语句及复杂预处理宏仍缺通用的执行插桩。 |
| 492 | VCS 合并与复杂目标 | 延后 modport 传播可在本时间槽结束前关联唯一匹配的物理回调。同步样本与歧义反例通过。 | 部分。VCS 合并后无独立回调的同范围 NBA、无法唯一匹配的重叠组件和部分复杂左值保留未观测。 |
| 533 | 性能和预算 | 二分查找缩短历史定位，复用同一波形的信号名查询。单次 `x28` MCP 查询指定已观察到的解码器变更后到达四次 IMEM 提交及固件偏移 16–19。 | 部分。已测窗口读取、MCP 游标更新及进程内存。大型设计桌面 A 游标的端到端延迟和自动选择大图续查入口仍有缺口。 |
| 540 | 缓存、取消、分页及过期结果 | 图回归覆盖共享、环路、缓存、续查和并发文件更新。相同 MCP 用 VCD、FST 和独立及 NPI FSDB 对照分页、取消及退出。 | 通过。其他平台桌面由第 557 项继续验收。 |
| 557 | 原生平台与 VSIX | 本地 Linux x64 桌面通过。远端 `main` 的六平台 package smoke 全部通过，含原生 Windows x64/arm64 命名管道。 | 部分。原生 Windows 与 macOS 桌面 Trace 仍待运行。 |
| 562 | 使用文档与交付证据 | Quickstart 区分公开基线和本地构建，记录复现命令、六平台打包与四块 VIDE 验收。 | 通过文档验收。当前修改版的原生桌面覆盖由第 557 项继续验证。 |

## 本轮实测

### 2026-11-23 非跨平台修复

- Verilator 5.054 真实 C++ 工作线程在 1 ps 捕获输入 3、结果 6 和独立完成事件。独立事件在 2 ps 进入记录，RTL 在 3 ps 消费结果，此时 RTL 输入已经是 4。在线与同次 VCD 回放一致。
- 真实 VCS 的嵌套宏及标识符拼接可追踪完整的层次路径。Load 从 `u_leaf.stimulus` 经 `u_leaf.middle` 到达 `u_observer.observed`，`u_other` 保持独立。时间图也从 2 ns 的实际变化接上。
- VCS 虚接口的四次实际访问分别指向 `left.data` 和 `right.data`。MCP 回放保留访问方向、物理成员和原 RTL 行号，独立的物理变化事件核对了值 3 和 9。
- 独立 KDB 将四种端口表达式绑定到实际操作数。VCS 上四个端口在 2 ns 的值依次为 `f0`、`0f`、`2c` 和 `3c`。匿名 generate 复跑覆盖独立 KDB、VCD 和 FSDB。
- Verilator 两个实例的常规和条件宏调用得到四个语句 ID。日志里六次提交的源码哈希匹配，回放报告同时显示宏定义和调用位置。
- 延后传播的 VCS 重叠 modport 样本在 2 ns 核对两个 `data` 提交，求值 27 和 26 分别关联回调 29 和 31。同步重叠样本保留原有提交，4 ns 具备两个相容解释的反例保留未观测。更换同范围 NBA 的探针标记后，VCS 仍只提供最终物理结果。
- MCP `wave_trace_context` 从 `x28 @ 2051001 ps` 使用 `continueFrom` 接合 `id_stage_i.instr_rdata_i @ 2023000 ps`。合并图有 5,623 个节点和 12,178 条边。逐边核对根可达 IMEM 提交 553、555、557、559 及固件文件偏移 16–19。其余分支仍遵循预算。

- 同一个 OpenTitan FSDB 会话做 100 次游标位置 MCP 查询。信号名查找从 2,500 次降至 22 次，波形窗口读取均为 200 次。热查询中位数从 3.72 秒降至 3.06 秒，第 95 百分位从 3.89 秒降至 3.22 秒。采样点最高 MCP 进程 RSS 从 370 MiB 降至 332 MiB。单次完整路径查询使用 61 次波形读取，耗时约 99 秒。
- Linux VS Code 1.124.2 的最小双 hart 夹具用实际 A 游标菜单命令查询六个位置。VCD 首次用时 175 ms，后续为 22–43 ms。FST 首次用时 178 ms，后续为 19–51 ms。两种格式的静态图、时间图和源码跳转继续通过。
- 最终 Node 回归通过 193 项，跳过 67 项，失败 0 项。撤回短路径全工程索引后，两项 RV32A 分别在 13.9 秒和 27.5 秒通过。最终两个 Linux x64 VSIX 在隔离的 VS Code 1.124.2 重跑 VCD、FST 和源码联动，两个格式各有 34 个时间节点和 43 条边。

### 2026-11-23 首次补测

- 实际 VCS 的三文件夹具中，旧版从 `u_leaf.stimulus` 展开漏掉了另一文件中的 `u_observer.observed`。VIDE 批量匹配当前图中的声明，Workbench 从 `u_leaf.middle` 接上该引用。同名 `u_other.middle` 保持独立，Driver 时间图核对 2 ns 的实际变化。 [复现夹具](test/fixtures/trace/README.md#vcs-load-through-an-intermediate-cross-file-reference)
- 通过头文件宏生成同一层次路径时，Workbench 在名称内部发起声明查询，保留名称起始列用于源码核验。VIDE 直接解析展开树中的引用 token，避免根据共享的源码偏移回查错误 token。VCS 夹具的 Driver、Load 和时间图通过。嵌套宏带标识符拼接的 VCS 对照样本能解析 `observed` 声明，VIDE 仍将展开后的右值标为未知。
- 同机对照的 RV32A Load，原版约 6.4 秒，批量搜索所有短引用的草稿约 74 秒，按完整层次路径匹配中间节点的版本约 8.5 秒。最终查询保留 115 个信号和 140 条赋值。
- 从 `x28` 图选中 `decoder_i.instr_rdata_i @ 2023000 ps` 的前沿并调用一次 MCP 续查。合并图有 6,062 个节点、16,384 条边，尚未进入 IMEM 提交，仍可通过两段独立查询核对接点和完整路径。
- 最终 Node 回归 187 项通过、69 项跳过。VIDE Trace 41 项通过。两个更新包在隔离的 Linux VS Code 1.124.2 中通过 VCD 和 FST 的 Driver、Load、时间图及源码联动验证。

### 修复与复验

- Verdi NPI 的 modport 成员查询按实际物理声明填充 `packedRange`，同时保留别名的 `interfaceRange`。重新构建 Verdi SDK 后端后，真实 VCS KDB 的 modport 位选、切片、拼接、嵌套别名和源码跳转通过。NPI 专项 7 项通过、22 项跳过。
- 独立 KDB 读取接口实际端口时接受与普通端口相同的连接记录类型。真实 VCS KDB 复验 `.*` 从 `sink.link.selected` 映射到 `link.data[7]` 与 `link.data[5:4]`，Verdi NPI 同时通过。VCD 时间图在 2 ns 从顶层 `result[0]` 追到 `link.data[4]`。 [复现夹具](test/fixtures/trace/README.md#wildcard-modport-binding)
- 对照同一查询的原始 VIDE LSP 与 MCP 响应，定位到 Wave Workbench 缺少普通 KDB 层次引用绑定。VIDE 输出引用点的相对路径，Wave Workbench 核对展开实例、声明文件及行号后接入因果图。VCS VCD/KDB 的 MCP 回归追到 `u_leaf.p`、`u_leaf.local_value` 和 `lane[1].u_indexed.local_value`。从 `stimulus` 做 Load 查询可见 `u_leaf.external_value` 的写入。4 ns 时间图把 `q_pair` 连到 `u_other.local_value`。在 Linux VS Code 1.124.2 复验 `q_pair`，9 个赋值、7 个时间节点和 6 条边与静默 MCP 相同，源码跳转通过。 [复现夹具](test/fixtures/trace/README.md#vcs-hierarchical-reads)
- 将叶模块与父模块拆成两个源文件，用 VCS T-2022.06-SP2 重新生成 KDB 和 VCD。独立 MCP 的 Load 从 `u_leaf.local_value` 到 `q_local`、`q_pair` 和下一级 `q_follow`，从 `u_other.local_value` 只到 `q_pair`，从 `lane[1]` 到 `q_indexed`，`lane[0]` 无对应读点。Driver 从 `u_leaf.external_value` 找到父层的 `stimulus` 赋值。Linux VS Code 1.124.2 扩展宿主复验 Load 与 Driver 各三条赋值及父模块源码跳转。 [复现夹具](test/fixtures/trace/README.md#vcs-hierarchical-reads)
- 另用 VCS 生成两个同类型父实例的 KDB 与 VCD。以模块类型名 `xmr_up_middle` 限定信号时，Wave Workbench 使用最近的实际祖先实例。独立 MCP 的 Driver 和时间图分别在 `u_left` 的 2 ns、`u_right` 的 4 ns 匹配各自的 `shared_value`。从两个叶实例的 `write_value` 发起 Load 均指向各自父实例的 `external_value`。以这两个父信号为根，工作区索引找到另一源文件中的读点和写点，KDB 复验每个引用点属于各自的叶实例。同文件向下引用样本也复验了兄弟实例的引用不会生成未解析 Load。 [复现夹具](test/fixtures/trace/README.md#vcs-upward-references)
- Linux x64 0.9.33 VSIX 解包到独立扩展目录后，在 VS Code 1.124.2 复验跨文件 Driver、Load、时间图和源码跳转。向上引用的两个实例各得到 3 条 Load 赋值、5 条 Driver 赋值和 7 个时间节点、6 条边，反查写入点跳到 `xmr_up_leaf.sv`。
- 实际 VCS 核对默认参数 `SELECT=0` 和覆盖参数 `SELECT=1`。两个实例的 Driver 和时间图分别追到 `lane[0]` 的 2 ns 与 `lane[1]` 的 4 ns。以叶信号为根的 Load 只发现该实例中被选元素的引用。使用运行时 `stimulus` 作 generate 下标的对照样本在 VCS 展开时返回 `XMRE`。 [复现夹具](test/fixtures/trace/README.md#vcs-parameterized-xmr)
- 同一 VCS 夹具加入 `lane[(SELECT + 1) % 2]`。VIDE 返回表达式和参数声明 ID，Wave Workbench 用各实例 KDB 参数值求下标。两套 Driver、Load 和时间图分别命中互补元素。另将 `q_local` 的 RHS 替换为宏 `LOCAL_REF(u_leaf)`，Driver 和反向 Load 均保留该引用。 [复现夹具](test/fixtures/trace/README.md#vcs-parameterized-xmr)
- 回归先复现了 VIDE 在取消后返回成功响应时 Trace 仍接收旧结果的问题。修复在响应返回后再次检查取消状态，单测验证 Load 结果被拒绝。静态契约、构建清单及执行日志版本校验的回归同时通过。
- 回归覆盖隔离 VIDE 项目在响应返回前关闭的情况。查询入口、返回和跨实例展开均检查会话状态。
- 用真实 VCS VCD、Verilator FST 和 OpenTitan RV32A FSDB 复验静默 MCP，FSDB 分别使用独立读取器和 Verdi NPI。分页保留首节点，取消的请求不发迟到响应，紧随其后的查询成功。关闭波形使旧续查入口失效，同一进程仍可读取已生成的固定图快照。终止 MCP 进程后旧快照失效，新进程重查返回相同的节点、边和缺口统计。
- Xcelium 23.09 生成 SHM 和实际 HDL 源码索引，Vivado 2021.2 生成 WDB。两者均通过上述生命周期复验。使用已附加的 SHM 索引时，在原路径写入更新可复现 MCP 误接收旧续查。修复把设计文件纳入普通续查的输入核验，更新后返回 `contextChanged`。
- 修复实时快照接受无效时基的问题，拒绝未知单位、零值、溢出和下溢。重新编译 VCS T-2022.06-SP2 的 VPI 库和 Verilator 5.054 的 FST 夹具。两个仿真器分别用旧生产端和快照格式 v1，与旧 VSIX 和当前读取端交叉，8 组均从 tick 0 启动并步进到 tick 1。VCS 返回 1 ns 和槽内值变化能力，Verilator 返回 1 ps。两组实仿真的步进、断点和离线回放测试通过，实时专项 10 项通过、3 项跳过。
- VIDE IDE 单元套件通过 247 项，忽略 6 项。实际 LSP 对跨文件 XMR 的 `shared_value` 和 `external_value` 分别核对唯一的定义和引用，两个 Rename 各返回涉及两个文件的编辑。在包含 189 个编译根的 RV32A 工程中，`hart_q` 返回 1 个定义、16 个引用和 17 处重命名编辑。未保存的修改把输入从 `selected_hart` 改到 `rr_q`，revision 从 7 更新为 8，另一 TB 文件的 Trace 结果保持一致。包含导航、源码更新和查询的整轮耗时约 156 秒。
- 两套最小仲裁 FST 在 tick 2 读到 `request=11`，两组 `grant` 分别为 `01` 和 `10`。真实双 hart VCS 样本核对 `hart_q @ 380000 ps` 保持自 375000 ps 的提交 200，`hart_q @ 470000 ps` 保持自 465000 ps 的提交 274。对应的 `selected_hart` 为 1、0，两条捕获边来自 370000、455000 ps 的求值。后续保持查询已加入两路 VCS 回放回归。
- 用 Linux x64 VSIX 与 VIDE 在 VS Code 1.124.2 对照同一双 hart VCS VCD、KDB 和日志。两次查询各有 45 个静态信号、132 条赋值。hart1 的时间图有 24 个节点、26 条边、16 个缺口，hart0 有 226 个节点、442 条边、163 个缺口。静态图、时间图、局部路径分页、Mermaid 和 Markdown 与静默 MCP 逐项一致，两个实际写入点均通过源码跳转。
- VCS 的 `equal_drivers_tb.q @ 2 ns` 在同一 tick 依次观测到 `x` 和 `1`。两条连续赋值均保留为候选。VS Code 扩展宿主与静默 MCP 的静态赋值、候选和完整时间图一致，两个候选均可跳到源码。 [复现夹具](test/fixtures/trace/README.md#equal-vcs-drivers)
- 实际 VCS 采集两个同时进入的自动 task。1 ns 的输入提交 7、11 在 3 ns 以 17、23 的顺序写同一 packed 成员。静默 MCP 按调用标识 2、1 追到文件偏移 1、0，关联源文件位置通过哈希匹配。 [复现夹具](test/fixtures/trace/README.md#concurrent-vcs-task-calls)
- 以 Verilator 5.054 给同一个两级流水线分别生成 `--threads 1` 和 `--threads 2` 模型。单线程补丁在 1、3、5、7 ps 记录八次实际 NBA 提交，在线和封装 FST 的离线回放逐项匹配。双线程模型返回要求单线程的诊断。 [复现夹具](test/fixtures/trace/README.md#recorded-pipeline-in-live-mode)
- VCS 对输出端口 `.result(bus[idx+:2])` 返回 `IPC-E`。同源 Verilator 5.054 生成展开 JSON 和 VCD。修复前 Trace 返回 `unresolvedPortExpression`。修复后 `bus[3] @ 2 ns` 的 Driver 和时间图包含 `dut.result` 与 `idx`，`bus[0]` 的最近变化仍在 tick 0，`idx` 的 Load 到达 `bus`。同 tick 的采样仍保留候选。 [复现夹具](test/fixtures/trace/README.md#dynamic-verilator-output-part-select)
- 用第二组 Verilator 输出连接核对五种展开形式。2 ns 的时间图从 `plain[3]`、`expr[4]`、`minus[3]`、`asc[2]`、`offset[7]` 分别追到各自实例的输出和 `idx`。从 `idx` 反查能到达五个目标。物理低位偏移按目标声明范围转换为 HDL 下标。 [复现夹具](test/fixtures/trace/README.md#dynamic-verilator-output-part-select)
- 复跑 VCS FSDB 和 KDB 的过程覆盖。强制期间 `net_out @ 3 ps = 1`，释放后 `net_out @ 5 ps = 0`。过程赋值取消后 `temporary @ 7 ps = 1`。静态图保留相应语句，三次查询均报告 `proceduralOverride`。
- 新建 VCS 夹具复验位置实参、命名实参和嵌套函数。三个结果在 2 ns 均为 0，图保留 `data` 和任务或内部函数读取的 `config_bit`，并显示 `unresolvedSubroutineEffects`。
- 本次复跑含大型 Verilator FST 的 Playwright 共 38 项通过、6 项跳过。最新 Linux x64 原生包、Tcl 和 MCP IPC 冒烟通过。Verdi NPI 专项复验 wildcard、切片、范围和嵌套别名，4 项通过、2 项跳过。
- 最新 Linux x64 0.9.33 VSIX 与本地修改后的 VIDE 1.3.0 通过隔离 VS Code 1.124.2 冒烟。VCD 和 FST 各有 16 条赋值、34 个时间节点和 43 条边。使用实际 VCS 和 Verilator 夹具的 Node 回归 156 项通过、94 项跳过。
- 完成数组字、结构体成员和设计索引失效修复后，启用实际仿真与宏映射夹具的 Node 回归 159 项通过、94 项跳过。
- 补上动态输出位段矩阵，并启用更多 VCS 和 KDB 夹具后，Node 回归 185 项通过、69 项跳过。重新生成的 KDB 核对了有符号接口索引及有效常量宽度。Verdi NPI 的 KDB 回归 9 项通过、20 项跳过。最新 Workbench VSIX 通过 Linux MCP IPC 和隔离桌面冒烟。
- OpenTitan MAC 同构建回放中，当前 Linux VS Code、当前静默 MCP 和本次修改前的 VSIX 对同一 `x28 @ 2051001 ps` 请求均返回 2,884 个节点、8,192 条边和 `traversalBudget`。归档的早期 0.9.22 桌面结果为 3,177 个节点和 6,133 条边，含整字和文件字节路径。当前复验提高边预算后达到 4,096 节点上限。分段可从解码器追到 `instr_aligned=0x9062be2b @ 2009000 ps`，从 `u_imem.cpu_rdata_o` 追到 `mem[36] @ 931000 ps` 的四次提交 553、555、557、559。同一次执行日志也确认文件偏移 16–19、任务输入提交 514 和总线写入提交 525。当前整图尚未复现归档路径。
- 交叉换包使用同一 FSDB、执行日志及源码映射。0.9.22 Workbench 配当前 VIDE 得到 3,222 个节点、6,224 条边，能找到四次写入和文件输入。当前 Workbench 配旧 VIDE 仍返回 2,884 个节点、8,192 条边。将旧查询的静态图及相同波形观测分别交给两版时间图生成器，旧版发现 26 次数组字读取，当前版在相同预算内发现 1 次。
- 进一步核对 `x28` 图的 ALU 扇入，发现 VIDE 对超过 32 个标签的过程 `case` 放弃了条件求值。提高到 128 个标签并加入 48 标签的优先级回归后，真实 FSDB 的 `alu_i.result_o @ 2051000 ps` 依据稳定的 `operator_i=0x18` 只保留第 943 行的写入，直接上游边从 84 条降至 18 条。整图仍达到 8,192 条边，保留预算缺口。更新 VIDE 后扩展 Node 回归仍为 185 项通过、69 项跳过，最新两份 VSIX 通过 Linux 桌面 Trace 冒烟。
- 修复等宽 packed 数组字读取的位依赖，按声明的低有效端对齐输出和样本位，并按位核对读值。真实 FSDB 的 `cpu_rdata_o[5] @ 2009000 ps` 到 `mem[36][5] @ 931000 ps = 1` 保留地址同槽切换的候选标记。本地试验扩大时间图预算后，`x28` 图中 11 个位节点连接到提交 553、555、557 和 559，文件读取仍未接回。该试验使用更高的临时上限，单次墙钟约 70 秒，峰值 RSS 约 2.0 GiB。正式请求上限沿用原值。
- 修复读取已记录的等宽结构体成员时比较位值与整字段的问题。当前 MCP 从解码器 `instr_rdata_i @ 2023000 ps` 一次返回 2,608 个节点、3,986 条边。位 3、10、17、28 各经 23 条边到字 36 的对应提交，并各经 13 条边到任务输入 514、总线成员写入 525 和真实文件偏移 16–19。内存实际写入由日志确认。跨组合和总线的路径保留采样能够支持的候选关系。
- 同版静默 MCP 的 `x28=480 @ 2051000 ps` 到解码器变化点有 13 条边。用同一 FSDB、执行日志、信号全名、tick、值及槽内序号核对两段查询，从 `x28` 接到上述四次 IMEM 提交和固件字节。Linux VS Code 的打包版按同一请求得到逐节点、逐边一致的路径证据，两段分别约 99 和 90 秒。原预算为 3,091 个节点和 8,192 条边，扩大边预算后为 4,096 个节点和 12,144 条边。两种预算下的单次 `x28` 查询都保留了遍历预算缺口。
- 同次 FSDB 在 TL-UL CDC 的两侧核对实际接受。主端在 895000 ps、设备端在 931000 ps 上升沿前均满足 `valid=ready=1`，地址为 `0x90`、source 为 `0x21`、掩码为 `0xf`，数据为 `0x9062be2b`。IMEM 同时有请求、授权和写使能。四次提交的字节值分别与偏移 16–19 的文件读取一致。
- 用原 VCS 插桩可执行文件重新运行 `+firmware=cv_mac_trace.bin`。启动清单和封装后的执行记录均核对到本次 FSDB。逐字节核对了 52 次实际读取及固件 SHA-256 `5b53d4bd3ac4447219808815b7ddcda2082c646a2fc04e56cc658d22cebe2b1f`。仿真报告 `x28=480`，新日志的 1,532 项事件与已验收记录逐项一致。使用原 RTL 的显式 filelist 时，编译清单正确标出插桩构建的差异。回放副本使用相同的波形哈希和新执行记录，保留原 RTL 的源码坐标，得到相同的 2,608 节点、3,986 条边和四次字节读取。
- 实际 Verilator 5.054 的 `wave_execution_map` 在两个实例中均返回两个不同的宏调用坐标。宏生成的赋值现在报告 `unsupportedMacroExpansion`，保留源文件与调用行。 [复现夹具](test/fixtures/trace/README.md#verilator-assignments-written-with-macros)
- Verilator 5.054 的延后 DPI 夹具在第一个上升沿启动 C++ 工作线程，在第二个上升沿消费结果。3 ps 的当前 RTL 输入为 4，探针捕获的实际请求值为 3，结果为 6。VCD 封装回放和在线逐项一致，两个 C++ 位置通过哈希核对。这组记录的时间对应 RTL 消费点。
- 实际 VCS 虚接口样本先在 1 ns 写入 `left.data=3`，再在 4 ns 写入 `right.data=9`，`result` 在 2、5 ns 读到对应值。修复前静态 Load 把两次写入都指向 `write_port` 变量，修复后保留两个写入位置的 `unresolvedVirtualInterfaceBinding`。Driver 对两个读取位置报告同一缺口，MCP 保留四个实际观测。VIDE IDE 回归 247 项通过、6 项忽略。 [复现夹具](test/fixtures/trace/README.md#vcs-virtual-modport-handles)
- 实际 VCS Driver/Load 夹具核对 1、10 ns 的异步复位、3 ns 的顺序 NBA 覆盖、5 ns 的保持以及 7、9 ns 的 `case` 数据。Load 确认连续与阻塞数据关系、控制关系、位选、上升时钟与下降复位边沿。波形不能确定槽内顺序时保留候选。 [复现夹具](test/fixtures/trace/README.md#vcs-driver-and-load-matrix)
- 解码器视图的实例标识改用 Web Crypto 的随机字节。标签按钮的布局断言等待重绘后取两行坐标，项目往返测试连续通过 8 次。加载真实 MAC FSDB/KDB 及大型 FST 的全量 UI 回归 40 项通过、4 项跳过，覆盖项目恢复、标签及 UART。
- Verilator 展开树读取参数时，识别 `GPARAM` 和 `LPARAM` 的已展开常量。两种仲裁构建在 VCD 和 FST 中分别核对 `PreferHart1=0/1`。使用同一份修改版 VIDE 后，Linux VS Code 与静默 MCP 的 FST/VCD 静态图和时间图逐项相同，报告仅归一化本地 revision。每种波形有 16 条赋值及 34 个时间节点、43 条边。
- 真实 VCS 环路样本按一层起步自动续查，耗尽前沿后保留两条反馈边和 17 项缺口。未采集的 `hidden` 在分页缺口和报告中均可检索。
- 用真实 VCS VCD/KDB 对照隔离 filelist。嵌套 `-F`、宏、包含路径和顶层均回传实际配置，缺失的生成子清单及 `-licqueue` 出现在编译缺口，静态图仍可查询。改写构建清单中的源码哈希后，MCP 返回 `mismatched` 并保留波形观测。
- Linux 本地 VSIX 打包、桌面 Trace 和 Unix socket 冒烟通过。当前 Windows 冒烟使用生产注册目录函数，在 Wine 6 的 Windows x64 Node 22.22.2 和原生 Windows CI 上完成两宿主路由、取消与清理。原生 Windows 与 macOS 桌面 Trace 仍待复验。
- 启用可用的仿真和 KDB 样本后，修复工作树的 Node 回归 163 项通过、76 项跳过。原生 SDK-free Rust 回归 13 项通过、1 项忽略。

### 首轮核查记录

- Wave Workbench 的 TypeScript 类型检查、Prettier、构建和 Linux x64 VSIX 打包通过。Linux Unix socket MCP 冒烟通过，覆盖双会话路由、取消与正常退出清理。
- Node 独立后端全套回归 184 项通过、54 项跳过。另跑 Verdi NPI 的 KDB/FSDB 回归，6 项通过、22 项跳过、1 项失败。对 `slice_tb.tx.link.tx` 查询得到 `interfaceRange: [7, 6]`，其物理声明 `slice_tb.x.datum` 的 `packedRange: [7, 4]` 未随别名返回。普通信号解析填充位宽，NPI 的 `interfaceMember` 走独立查找入口。 [对应实现](native/src/kdb.rs) · [对应回归](test/kdb.test.js)
- VIDE 以 GCC 14 和 Python 3.11 重新构建并运行 `ide`、`project-model` 和 `preproc-expand`，354 项通过、6 项忽略。
- 当前 0.9.33 VSIX 与修改版 VIDE 1.3.0 在实际 Linux VS Code 1.124.2 完成桌面冒烟。用 Verilator 5.054 从当前仓库重建夹具，VCD 与 FST 逐项匹配，均有 16 条赋值、38 个时间节点和 50 条边。检查了 Driver、Load、分页、详细报告和 RTL 源码跳转。较早一组 Verilator 夹具的 Load 查询找不到 `TOP.trace_tb.request`。
- 用当前 `native/vpi_execution.c` 重建 VCS 入口与值变化 fixture。分开封装有语句入口与仅值回调两份记录，覆盖同值 NBA 的入口断点、步进、自然退出和在线/离线事件序列。
- 复跑 Verilator 两种仲裁构建、匿名 generate、多实例执行顺序、在线流水线及语句断点。VCS 复跑嵌套守卫、索引位段、部分越界、多个 wait 形式和同位段 NBA。
- 同位段 NBA 的 Linux 桌面与静默 MCP 已逐项对照 VCS 在线/离线与 Xcelium 离线的六份分页图。Xcelium 的回调可核对物理值序列，VCS 的合并更新保留未观测结果。 [复现步骤](test/fixtures/trace/README.md#same-range-nba-writes-in-vcs-and-xcelium)
- 当前静默 MCP 使用同次 OpenTitan MAC FSDB、KDB 与执行 JSONL 回放 `u_imem.mem[36] @ 931000 ps`，核出四次实际字节提交。取指和文件读取之间的其余归因仍按上表验收。
- Trace Playwright 专项为 6 项通过、1 项跳过，包含约 499 MB 的 Verilator FST 及层级源码联动。常规全量 Playwright 为 34 项通过、7 项跳过、3 项失败，失败集中在解码器的项目还原、叠加值和 UART 参数测试。

### 静默 MCP 性能复测

Linux x64 使用当前工作树构建和 Release VIDE。查询限制为深度 3、256 信号、512 赋值。打开波形、接入展开数据库后测量单次请求墙钟时间。同一进程重复传入显式 filelist，重复请求耗时包含配置准备。

| 样本 | Driver 首次 / 重复 | Load | 时间图首次 / 重复 | 时间图摘要 / 节点页 |
| --- | ---: | ---: | ---: | ---: |
| Verilator 小 FST `multi.q @ 5` | 165 / 143 ms | 141 ms | 162 / 146 ms | 643 / 2,902 字节 |
| OpenTitan RV32A FSDB `hart_q @ 280000 ps` | 3,001 / 2,813 ms | 2,883 ms | 2,957 / 2,844 ms | 972 / 15,968 字节 |

FST 有 9 个节点和 18 条边，FSDB 有 33 个节点、39 条边和 19 个缺口。Driver 响应分别为 2,423 与 112,705 字节。RV32A Load 响应为 741,873 字节。FSDB 节点页首次读取约 10 ms。这些数据是单机单次采样。

重新构建独立读取器后，对同样的两个样本执行十条请求，测试进程与子进程的最大 RSS 为 518,008 KiB，合计墙钟耗时 16.17 秒。RV32A 时间图首次 3,077 ms，复查 3,004 ms，首次节点页 3 ms。该峰值是 `time -v` 报告的单进程最大值。

向上层次引用反查复验后，同组十条请求合计 17.36 秒，最大 RSS 为 515,784 KiB。RV32A 首次 Driver 为 3,061 ms，重复 Driver 为 3,070 ms，Load 为 3,328 ms，首次和重复时间图为 3,447 和 3,301 ms。时间图保持 33 个节点、39 条边和 19 个缺口。草稿对局部图中的每个信号执行全工作区查询时，实测 Load 耗时 36.10 秒。当前实现对每次局部查询的根信号查找非祖先引用，图中其他信号沿用祖先模块检查。

RV32A 的独立 VIDE LSP 进程加载 189 个编译根。深度 1 的 `hart_q` Driver 首次 2,255 ms，热查询 48 ms，修改 RTL 后首次 2,260 ms。另一文件的 TB 查询在修改前后分别为 343 和 327 ms。本次采样记录了响应时间和图的等价性。

单独分段计时复查中，RV32A 的 References 为 75,519 ms，随后 Rename 为 78,595 ms。该次 Trace 冷查询为 2,275 ms，热查询为 51 ms，修改后为 2,307 ms。导航超时与已证实的功能结果分别记录。

双 hart 回放单批四条时间查询约 27 秒，每条约 6.5–7.0 秒。分段计时中，每条请求的首个 VIDE 查询约 4.7 秒，波形采样约 1–3 ms。测试在同一 MCP 会话内加验了两次保持查询，原有 20 秒的子进程超时不足。该夹具允许 40 秒，产品查询预算沿用原值。

同一 OpenTitan MAC VCS 探针可执行文件每种模式运行三次。关闭执行采集时墙钟耗时 1.10–1.12 秒，启用 12 路观察和执行记录时为 1.09–1.13 秒。峰值 RSS 的两组范围均在 153–157 MiB。每次采集生成 1,532 个事件及 276,555 字节的原始 JSONL。六次仿真均得到 `x28=480`。这些数据测量同一二进制文件的采集开关。

### VIDE 验收

| 改动 | 本地验证 |
| --- | --- |
| 读写引用分类 | `cargo test --locked --offline -p ide --lib semantic_index::` 通过 7 项，覆盖读写、端口方向和宏实参映射。 |
| 静态分析 | `cargo test --locked --offline -p ide --lib assignment_trace::` 通过 41 项，覆盖 Driver、Load、层次索引、虚接口缺口和长 `case` 优先级。上一轮完整 IDE 通过 247 项、忽略 6 项。 |
| LSP | 实际 Release 服务器通过跨文件 XMR、189 个编译根的 RV32A 增量查询及 Definition、References、Rename。静默 MCP 使用同一服务器通过 VCD、FST、FSDB 查询和取消。 |
| VS Code 扩展 API | 在 `editors/vscode` 执行 `npm run typecheck` 和 `node --import tsx --test test/analysisApi.test.ts`，两项 API 测试分别核对超时、取消及拒绝旧会话的响应。Linux VS Code 1.124.2 安装两份当前本地 VSIX 并核对源码跳转。 |

### 原生平台

| 平台 | 核对结果 |
| --- | --- |
| Linux x64 | 本地 VSIX、Tcl、两种打包读取器和 MCP IPC。桌面结果见本轮实测。 |
| Linux arm64 | 当前 `main` 的 CI 打包与包冒烟通过。桌面 Trace 待测。 |
| macOS x64 / arm64 | 当前 `main` 的两项 CI 打包与包冒烟通过。两种架构的原生桌面 Trace 待测。 |
| Windows x64 / arm64 | 旧 CI 在第二宿主命名管道注册断言失败。当前 `main` 两个架构的日志均报告 `MCP local IPC smoke passed on win32`。VS Code 桌面 Trace 待测。 |

旧平台工作流使用 `8707800`。之后的冒烟脚本改用生产注册目录函数，本轮手动从 `main` 的 `1e200f0` 运行六平台矩阵。当前 HEAD 的普通 Checks 在 `npm run format:check` 失败。本地核查已修正 `wave-tools.ts` 的格式。 [六平台复验](https://github.com/AndreaFrederica/vscode-wave-workbench/actions/runs/45012295235) · [旧平台工作流](https://github.com/AndreaFrederica/vscode-wave-workbench/actions/runs/44798601976) · [HEAD Checks](https://github.com/AndreaFrederica/vscode-wave-workbench/actions/runs/44922011340)

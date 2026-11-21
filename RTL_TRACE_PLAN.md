# Wave Workbench × VIDE RTL Trace 实施计划

**项目目标**　在波形中选中信号、实例、位范围和时间点，查看驱动与负载、追溯该值形成的原因，并在 Trace Explorer 和 MCP 中获得可核对的 RTL 源码、实例路径和仿真证据。支持 FST、VCD、现有 FSDB 路径，以及可选的 Verilator 执行记录和实时调试。

**当前进度**　Linux VS Code 已验证修改版 VIDE、Verilator FST 和 OpenTitan FSDB 的静态图、时间因果图及 MCP 详细报告。仿真 filelist、波形旁构建清单或 VCS 生成的元数据可生成隔离的 testbench 配置。Verilator 样本已核对实际调度提交点和在线语句断点。VCS 样本已核对在线步进、信号断点、赋值入口断点及上游回放。复杂语义、通用调度器接入和 macOS、Windows 原生验收仍在计划中。PR 创建暂缓。

[当前实现目标](IMPLEMENTATION_GOAL.md) 优先交付局部 RTL 原理图与模拟波形。RTL Trace 验收与复核待办列于 [检查 TODO](CHECK_TODO.md)。原理图的实数值标注及模拟事件证据见 [模拟波形计划](ANALOG_WAVE_PLAN.md)。

## 仓库与职责

| 仓库 | 职责 | 基线 |
| --- | --- | --- |
| [Wave Workbench](https://github.com/AndreaFrederica/vscode-wave-workbench) | 实例映射、波形查询、动态求值、运行时接入、Trace Explorer、MCP | `3f103622d1a62f16d17521862d3c0dda1f06759f` |
| [VIDE 开发 fork](https://github.com/AndreaFrederica/vide) | 复用 syntax、HIR、SemanticIndex 和 Salsa，提供静态 Driver/Load、控制依赖、源码映射和公共分析 API | 上游 `master` 的 `9592808f3a39fc5d95aa2bf139abf9c413797a88` |
| [VIDE 上游](https://github.com/pascal-lab/vide) | 上游基线和兼容性参照 | 本地 fork 的 `upstream` |

本地 VIDE 位于 `/home/user005/project/vide`，`origin` 指向开发 fork。读写分类、静态分析核心、LSP 和扩展 API 各自保持可审查的改动边界。

Wave Workbench 通过 VIDE 已有的 LanguageClient 调用分析 API。VIDE 保持独立于 Wave Workbench、仿真器和波形格式。静态关系由 SystemVerilog 语义确定，动态归因根据已解析的表达式、执行语义和仿真证据确定，MCP 返回同一分析服务的结构化结果。VIDE 缺失、版本不兼容或正在重启时，用户仍可使用现有波形、KDB、Tcl、源码联动和常规 MCP 功能。

| 模式 | 所需输入 | 交付结果 |
| --- | --- | --- |
| Static Driver/Load Trace | RTL 与工程配置 | 可能的赋值点、读写、数据和控制依赖、时钟、复位、端口来源和去向 |
| Waveform Annotated Trace | 静态图与离线波形 | A 游标处的可观察值、时基和缺失原因 |
| Dynamic Causality Trace | 静态图、波形历史和触发事件 | 候选活动路径、跨周期来源、保持和歧义 |
| Exact Execution Trace | RTL、匹配的构建清单和执行记录，波形可选 | 已记录的过程触发、分支、赋值求值与提交。在线版本复用同一时间模型 |

## 里程碑和依赖

| Phase | 交付 | 前置 |
| --- | --- | --- |
| 0 | 仓库基线、公共数据契约和最小测试工程 | — |
| 1 | VIDE 引用分类、静态 Driver/Load 与增量查询 | 0 |
| 2 | VIDE LSP 和公共 VS Code 扩展 API | 1 |
| 3 | Wave Workbench 静态追踪、实例映射、Trace Explorer 和 MCP | 2 |
| 4 | 波形值注解与离线时间因果图 | 3 |
| 5 | Verilator 精确执行记录、映射和回放 | 4 |
| 6 | 实时仿真与断点、暂停、继续和步进 | 5 |
| 7 | 大工程性能、回归、跨平台和本地交付验收 | 3–6 |

首轮验收是 Phase 0–3，要求在实际 VS Code 扩展宿主中从真实 FST 信号追到 VIDE 返回的 RTL 赋值点。离线阶段保留独立使用价值，精确执行和实时调试纳入最终验收。Windows MCP 传输可在接口明确后独立推进。

## Phase 0　基线与协议

- [x] 核对 Wave Workbench 当前入口和基线 SHA，执行基础 Node、Rust 和 Playwright 测试。将环境相关跳过项记入证据。
- [x] 创建并验证 `AndreaFrederica/vide` fork，克隆本地，配置 `origin` 和 `upstream`，记录对应版本。
- [x] 核对 VIDE 引用分类入口、VS Code 扩展激活方式，以及 Wave Workbench 批量波形查询、DesignSession、路径映射和 MCP 入口。
- [x] 验证 VIDE 固定 nightly 和 Slang 子模块、Rust IDE 和 LSP 测试、扩展构建，以及 Verilator 5.054 的 `--json-only` 和真实 FST 集成。
- [x] 验证 HIR 对常见赋值、控制流、事件、端口和源范围的覆盖。记录最小可实现范围、需补充的语义信息和部分支持的特性。
- [x] 用真实仿真产物调查 testbench 编译上下文。对照现有 `vide.toml`、实际 filelist、命令参数和源码快照，记录 VIDE 可以直接表达的配置及其缺口。
- [ ] 建立版本化静态图、时间图、执行事件、编译清单和 Provider 契约，并用双端序列化、时间对齐及能力缺失用例校验。
  - [x] 静态图、MCP 采样上下文与时间图、执行回放结果及构建清单均发布版本字段。离线和在线上下文提供采样类型，同一时间图结构标注当前证据范围和结构化缺口。
- [x] 建立可重复生成的 [Trace fixture](test/fixtures/trace/README.md)，包含组合、时序、层次、generate 和多驱动。验证两种构建的 FST/VCD、仲裁值、保持、异步复位和实例映射。
- [x] 在 VIDE 的 Driver/Load 测试中核对仲裁语义，覆盖 `owner_q` 的两个 NBA、时钟触发、跨模块读取的各自源码位置，以及 `selected_request` 的两个连续驱动。

**验收**　两仓库各自的构建、测试及基线 SHA 可复现。现有波形路径能映射到真实 FST 实例，接口对同一组示例输入产生可核对的结果。

### 数据契约

| 对象 | 字段与语义 |
| --- | --- |
| Static Trace Graph | `schemaVersion`、分析 `revision`、根节点、节点、边、完成状态和诊断。节点涵盖信号、赋值、过程、端口和供确定性求值的类型化表达式。边涵盖 Data、Control、Clock、Reset、Port。保留原始源码范围、位范围、过程内顺序和触发关系。 |
| Trace Signal Identity | 工作区和设计会话、波形信号 ID 和路径、完整实例路径、声明 URI 与范围、定义与位范围。VIDE 内部语义 ID 随 revision 管理。 |
| Temporal Dependency Graph | 信号或事件身份、实例、位范围、十进制字符串 tick、时间尺度、四态值、可用时的 delta/调度阶段和事件 ID。边携带数据、控制、触发、保持或提交关系及证据。相同信号的不同时刻可分别访问。 |
| Execution Event | `eventId`、时间、可用时的 delta/顺序、实例、`processId`，以及适用时的 `statementId`、目标信号和值。事件类型覆盖 `process-trigger`、`branch-taken`、`assignment-evaluated`、`assignment-committed`。使用关联 ID 对应 NBA 的求值与提交。 |
| Build Manifest | schema 版本、构建 ID、工作目录、仿真 target、顶层 testbench 与 DUT 实例、源码快照和内容哈希、有顺序的编译文件与编译单元、宏、include、库、生成文件、bind 文件、参数覆盖及其他影响 elaboration 的选项。运行时语句标识由构建时映射表关联到编译单元、源范围和实例，随构建产物保存。 |
| SimulationProvider | 能力发现、会话身份和时基，提供批量 `getValuesAt`、有界 `getEvents` 和 `getPreviousEvent`。统一返回历史不足、截断、未 dump、已知调度精度和取消状态。实时扩展提供 `pause`、`resume`、`stepClock`、`setBreakpoint`，根据适配器能力开放。 |

源码匹配状态为 `matched`、`unverified`、`mismatched`。匹配同时验证文件内容和编译配置，包含未保存的编辑器修改。动态状态为 `confirmed`、`inferred`、`ambiguous`、`unsupported`，并携带原因和证据。语句执行的 `confirmed` 需要匹配构建的执行事件及受支持的记录范围。离线因果即使只剩一个候选也使用 `inferred`。无波形值用 `unavailable` 表示，X/Z 保持四态值。

### Testbench 与 VIDE 工程配置

VIDE 通过工作区根目录的 `vide.toml` 读取 `sources`、`include_dirs`、`defines`、`top_modules`、`libraries` 和 `exclude`。修改版增加 `source_files`、`library_files`、`source_libraries`、`library_maps`、`compilation_units`、`compilation_unit_options` 和 `parameter_overrides`，可按原顺序指定源码、编译单元、库文件和命名库归属，保留全局及单元专属的 include 路径与宏，并接收 Verilator `-G` 的顶层参数覆盖和 VCS `-pvalue+` 指定的实例参数覆盖。Verilator 的 `-y` 可从波形关联的展开结果恢复实际使用的库文件。`-libmap` 可导入 `.map` 中的文件、通配符与目录规则，并保留 IEEE `config` 声明。命名条件 generate 的追踪按 Verilator 的实例展开筛选赋值。其他仿真器的目录搜索及逐次循环展开的赋值归属仍需建模。

Wave Workbench 在开始追踪时按关联的仿真构建生成配置。优先使用本次查询指定或波形项目保存的配置。进入自动选择时，先查找波形旁的构建清单，再尝试从已附加的 VCS KDB 恢复编译输入。VIDE 扩展把生成的 `vide.toml` 写入临时工作区，由独立的 VIDE 进程加载，索引就绪后执行查询，关闭分析会话时清理临时目录。详细报告应给出采用的配置来源、VIDE 实际加载的编译输入及缺口。

- [x] **Phase 0**　对同一仲裁设计的 `hart0` 与 `hart1` 仿真 target 核对清单与实际编译输入。验证顶层、TB/DUT 连接、generate 实例、宏分支和顶层参数覆盖。另用 OpenTitan MAC 与 RV32A VCS 快照核对 filelist 转换和真实 TB/DUT 路径。
- [ ] **Phase 2**　为既有 VIDE LanguageClient 设计项目上下文选择和加载状态回传。先验证可表达的字段能否用独立分析工作区下的 `vide.toml` 加载。仅在精确文件顺序、独立编译单元、库映射或 top 参数覆盖影响语义时，评估在 VIDE fork 的项目加载层添加结构化输入。API 返回实际使用的上下文身份、revision 和未采用的配置项。
  - [x] 修改版 VIDE 通过扩展 API 启动隔离分析会话，加载带精确源文件列表的临时 `vide.toml`。LSP 返回实际根文件、include 路径、宏、顶层及 revision，索引完成后才查询。
  - [x] LSP 返回 Slang 编译配置中的顶层参数覆盖，MCP 构建核验比较该字段。`-GMode=0` 和 `-GMode=1` 分别验证了实际展开诊断的变化。
  - [x] VIDE 和 MCP 接受明确列出的库源码。LSP 返回实际的库文件及其顺序，核验时同时检查库文件和头文件的内容哈希。
  - [x] `vide.toml` 与构建清单可声明有序编译单元。Slang 按组解析，同组文件共享跨文件宏和声明，源码位置映射回各自文件。MCP 返回实际分组及构建身份核验。
  - [x] 构建清单和 Slang `-C` 清单可指定单元专属宏与 include 目录。MCP 报告实际配置及 Slang 加载的头文件。单元配置差异及缺少头文件均有实测核验。
  - [x] filelist 的 `-work` 和构建清单的 `source_libraries` 可传递命名库归属。同库名称可从编辑器直接跳转，波形追踪沿实际展开绑定。LSP 和详细报告返回库名及源码路径。
  - [x] `-libmap` 使用 Verilator 的映射优先级，VIDE 加载原始 `.map`。构建核验检查映射及文件内容，更换映射文件会使缓存的分析配置失效。
- [x] **Phase 3**　从选中的仿真构建读取配置并预览，允许复用或显式选择已有 `vide.toml`。可表达的配置写入构建或扩展管理的隔离位置，保留用户维护的清单。路径以 filelist 或构建工作目录的实际解析规则为准，映射回真实源文件。波形项目保存配置引用及构建身份，同一打开窗口切换不同 target 时使相关静态和动态缓存失效。
  - [x] 插件可读取显式选择的 filelist，展开 `-f`、`-F`，采集宏、include、top、源文件哈希和未表示的参数，并在独立文档预览实际用于追踪的 `vide.toml`。预览保留工作区外的生成文件和活动波形展开数据库选中的库源码。
  - [x] VS Code 命令将选中的 filelist 关联到波形，追踪时自动生成隔离 `vide.toml`。关联可随 `.waveproj` 保存。MCP 可为一次查询指定 filelist。两个实际构建分别验证宏分支、配置和波形身份。
  - [x] 静态 Driver / Load、离线查询和在线查询可指定构建清单生成本次查询的隔离 `vide.toml`，按清单目录解析相对路径。显式配置及波形关联优先，实际使用的来源随结果返回。静态分页查询也返回构建身份核验。
  - [x] 没有显式或已关联的 filelist 或构建清单时，静态和动态查询可自动发现 `<波形文件名>.wave-build.json`。采用前核对波形 SHA-256。真实 VS Code 验证匹配的 FST、错误的哈希和显式 filelist 优先级。
  - [x] 可显式选用工作区 VIDE 配置或恢复自动清单。真实 VS Code 重开 `.waveproj` 后，MCP 使用工作区的 testbench 配置。
  - [x] 可选用任意项目目录的现有 `vide.toml`，以清单所在目录解析相对路径。真实 VS Code 验证外部 testbench 配置的宏、MCP 查询、`.waveproj` 重开及替换清单后读取新宏，并对比了清单原始内容。
  - [x] 同一波形构建清单可以供自动续查的隔离 VIDE 会话复用。会话间核对实际加载的编译输入及文件指纹，会话内核对 revision。Linux VS Code 1.124.2 用 261 路 VCS 扇入 FSDB 验证清单身份为 `matched`，深度 1 查询成功续查 4 段。
  - [x] 持久仿真会话在查询前后检查嵌套 filelist 的文件身份。真实 VS Code 验证替换同名、同大小的嵌套清单后，下一次 MCP 查询加载新的宏配置。
  - [x] filelist 可展开源文件、include 目录和嵌套清单中的环境变量。未设置的变量进入编译缺口，已加载的 TB 和 RTL 仍可查询。
  - [x] 有 Verilator 展开结果时，从 `-y` 和 `+libext+` 导入实际选中的 `.v` 和 `.sv` 库文件。报告保留展开文件路径及库文件列表。更换关联设计时重新加载隔离分析配置。
  - [x] VCS filelist 的 `-y` 和 `+libext+` 结合附加 KDB 恢复已展开的库模块源码。独立后端和 Verdi NPI 均验证同名库文件中的实际选择、VIDE 加载的源码列表及构建身份。VCS 库目录与头文件目录按各自的选项加载。
  - [x] 在没有显式项目或波形构建清单时，从附加 KDB 下的 VCS 生成命令读取编译输入。只解析生成格式的静态参数，报告明确列出自动使用的文件、编译目录与未映射的选项。实测无手工 filelist 关联的动态追踪以及显式清单优先。
  - [x] 从 `simv.kdb` 恢复编译目录，并核对 `vcs_rebuild` 的输出路径指向当前 KDB。真实 VCS 样例将绝对路径输出与编译目录分开，Linux VS Code 自动解析相对 `-F`、TB 源文件及头文件目录。
  - [x] 自动加载时将 `vcs_rebuild` 和 `simv.kdb` 一起记录为编译输入，覆盖命令显式指定 `-top` 的情况。在真实 VCS KDB 与 VCD 的隔离副本上，Linux VS Code 测试钩子在返回 VIDE 结果前替换 `COMPILE_PATH`。旧版 MCP 返回了过期驱动 `a`，修复后拒绝这次查询，重查按新目录得到驱动 `b`。Trace Explorer 同样未发布旧结果。恢复原构建后，Trace Explorer 和 MCP 的时间图逐项一致，包含 5 个节点和 4 条边，界面报告列出实际采用的 VCS 配置。
  - [x] RV32A 仲裁波形只关联 KDB，Trace Explorer 和 MCP 从 `vcs_rebuild` 自动选取编译输入，使用隔离的 `vide.toml`。VIDE 返回顶层 `rv32a_atomic_adapter_tb` 和 189 个编译输入。两端报告均列出未映射的 `-licqueue` 和 `-timescale=1ns/1ps`。验收同时比对了用户工作区的 `vide.toml`。
  - [x] VCS 命令省略 `-top` 时使用 `simv.kdb` 记录的实际顶层。真实样例核对唯一顶层及其 `-pvalue+` 参数，详细报告返回 VIDE 的实际配置。
  - [x] VCS filelist 中的 `-pvalue+` 支持多个顶层及指定子实例的参数覆盖。保留 VCS 对同一路径取最后一次赋值的规则。Linux VS Code 1.124.2 从真实 VCS KDB 自动生成配置，MCP 确认 VIDE 收到 `tb_a.SELECT=1` 和 `tb_a.u.SELECT=1`。静态及时间图覆盖两个顶层及两个同类型 DUT 实例。动态节点分别追到 `tb_a.b @ 5 ns` 和 `tb_b.a @ 2 ns`，`tb_a` 下被覆盖的 DUT 和其兄弟实例分别追到 `b @ 5 ns` 和 `a @ 2 ns`。VIDE 的 project-model 和 slang-sys 共 72 项通过。Wave Workbench 独立后端 130 项通过，Verdi NPI 119 项通过并跳过 11 项独立专用用例。
  - [x] 导入实例数组及 generate 层次中的十进制下标，含负数。用真实 VCS KDB 和 VCD 在 Linux VS Code 1.124.2 检查 `tb.bank[1]` 与 `tb.lanes[-1].u`。被覆盖的两路在 5 ns 追到 `tb.b`，相邻元素在 2 ns 追到 `tb.a`。同一编译路径的 `[1]`、`[01]` 冲突时，VCS T-2022.06-SP2 的仿真采用最后一项，KDB 在实测中保留旧值。MCP 保留归一化后的配置、单文件静态图和波形观测，并报告该构建的因果证据缺口。VCS 实测拒绝带分隔空格的转义标识符路径，此类选项继续列为编译缺口。VIDE 相关测试 73 项通过，Wave Workbench 独立后端 131 项通过，Verdi NPI 120 项通过并跳过 11 项独立专用用例。
- [ ] **Phase 3–4**　导入时分辨 `-f`、`-F`、`+incdir+`、`+define+`、顶层、库和参数的已支持形式，对无法解析的外部路径、缺失的生成文件、顺序或参数信息标记 `unverified` 或 partial。对已证明的宏、top、参数或源码差异标记 `mismatched`，并在 Trace Explorer 和 MCP 中解释受影响部分。缺少 manifest 时支持显式选择配置，并保留可用的静态追踪。
  - [x] 构建清单声明文件哈希不完整时，继续核对已记录输入，并逐项列出缺少哈希的文件。真实 OpenTitan MAC VCS FSDB 的历史清单记录 54 个编译根，修改版 VIDE 另展开四个 include 文件。旧清单及显式 `files_complete: false` 均报告 `unverified`。从 `x28 @ 2051001 ps` 续查四段后得到 199 个时间节点、400 条边及 70 个待查入口。声明清单完整或更改已记录文件哈希的反例均报告 `mismatched`。Linux VS Code 1.124.2 前台与静默 MCP 的分页、Mermaid 和详细报告逐项一致。
  - [x] 用 VCS KDB 的 `debug_dump/src_files_verilog` 为运行清单保留已有的 include 哈希。重跑 OpenTitan MAC 归档中的实际 `simv`，生成与新 FSDB 匹配的清单。KDB 记录的 58 个文件均有归档哈希并与 VIDE 加载的文件集合一致。Linux VS Code 前台和静默 MCP 从 `x28 @ 2051001 ps` 续查四段的分页、Mermaid 和详细报告一致，比较时归一化 VIDE revision。错误的 include 哈希返回 `mismatched`。正常样本的构建限制仍列出 VCS 时间单位和 PLI 选项。
  - [x] 项目清单和修改版 VIDE 支持 VCS `-timescale=` 指定的默认时间尺度。用真实 VCS 的隐式模块、`timescale` 指令与显式 `timeunit` 核对三路实际尺度，VCD 以 10 fs 为刻度。前台和静默 MCP 均返回 `matched`，额外 filelist 覆盖为 `10ns/100ps` 后均报告 `Default RTL timescale` 冲突。OpenTitan MAC FSDB 保留默认尺度及 PLI 核验限制，两端时间图、Mermaid 和 Markdown 一致，比较时归一化 VIDE revision。Slang 回归核对显式模块声明的优先级。
  - [x] 构建清单可核对实际已载入的 Verilator 展开文件和伴随元数据。哈希不符时静态图退回单文件，离线和在线查询保留观测值并省略时间因果图。
  - [x] 从现有 OpenTitan MAC 的 `simv.daidir/vcs_rebuild` 自动恢复 TB 工程。配置生成检查得到顶层 `cv32e40p_mac_trace_tb`、宏 `CV32E40P_ASSERT_OFF`、54 个可核验哈希的源码和 2 个 include 目录。VCS 时间单位与 PLI 参数列入未映射项。检查前后的 OpenTitan 根目录 `vide.toml` 内容一致。
  - [x] 生成子清单缺失时保留其余可用的编译输入，并在预览、MCP 和报告中列出缺失路径。真实 VCS 波形通过 Linux VS Code 1.124.2 验证，同一已关联的 `.waveproj` 补齐子清单后，下一次查询加载生成模块和生成头文件，恢复对应驱动关系。独立后端通过 121 项，Verdi NPI 通过 110 项并跳过 11 项独立专用用例。
  - [x] Linux VS Code 1.124.2 使用真实 VCS KDB 和 VCD 验证生成 RTL 缺失与恢复。缺失时 MCP 返回缺失路径、未解析端口及 `q=1` 的波形观测。生成文件出现后，在同一波形窗口追到 `a=1 @ 2 ps`。分别以同大小、同修改时间的替换文件更新 RTL 和嵌套 filelist，静态驱动均切换到 `b`，后者确认加载了 `USE_B`。独立后端通过 126 项，Verdi NPI 通过 115 项并跳过 11 项独立专用用例。
  - [x] Linux VS Code 1.124.2 在同一 VCS VCD 窗口中保留显式 filelist，并用波形旁匹配清单核验嵌套头文件。等长原子替换使静态输入从 `a` 切到 `b`。替换和删除头文件时，MCP 离线查询报告 `mismatched`、保留 `q=1` 的观测并停止时间归因。波形菜单打开的报告也显示替换差异。恢复头文件后状态回到 `matched`，时间图追到 `a=1 @ 2 ps`。错误波形哈希的同名清单仍允许显式 filelist 查询。

**验收**　最小 testbench 中切换两个宏或参数不同的构建，同一信号应解析到各自的 TB 驱动与 DUT 实例路径。真实 OpenTitan 样本应能从 TB 跳到 DUT，后续 Trace 查询再验证端口、复位或激励的驱动关系。对缺少专属编译信息的会话报告缺口。

对于完整 TB 分析，验收同时核对构建期和运行期输入。构建期的 filelist 或波形旁清单用于生成隔离 `vide.toml`，并核对实际索引的 TB、生成源码、头文件和展开配置。涉及运行期 plusargs、激励文件或 DPI 的关系，按可用的波形或执行记录验证。

- [x] 用实际 VCS testbench 核对清单中的显式顶层、生成模块和生成头文件。MCP 确认 VIDE 加载这些文件，构建身份为 `matched`。
- [x] 对 `$test$plusargs`、`$value$plusargs` 和 `$readmemh` 的运行期输入，在静态与动态图保留源码及可用的波形观测。证据不足时，详细报告标出调用位置及 `unresolvedRuntimeInput`。
- [ ] **Phase 4–6**　以 OpenTitan MAC 的 `+firmware` 和 `cv_mac_trace.bin` 核对 TB 调用点、输入文件身份和可观测的 DUT 变化。把运行输入与实际执行的外部读操作关联。
  - [x] 通过仿真启动脚本记录运行目录、顺序 plusargs、激励文件哈希和波形哈希。从实际 VCS 可执行文件运行两套激励，通过 Linux VS Code 1.124.2 的 MCP 核对每份 FSDB 的运行输入及 tick 5 输出。替换或移除激励文件后，报告保留观测值并给出对应的文件状态。
  - [x] 对可匹配的字面量调用，Trace Explorer、Mermaid 与 Markdown 显示运行配置，保留调用是否执行的证据缺口。通过实机 VS Code 的波形菜单打开两次仿真的报告，在 Trace Explorer 核对 `$readmemh` 的激励文件状态，报告中的文件哈希分别对应各自的运行目录。四张 Mermaid 图在 Chromium 渲染。独立后端通过 110 项，Verdi NPI 通过 99 项并跳过 11 项独立专用用例。
  - [x] 在独立运行目录用同一脚本执行现有 OpenTitan MAC 的 VCS 可执行文件。生成新的 FSDB 及记录 `+firmware` 和二进制文件 SHA-256 的清单，仿真输出 `MAC_TRACE_PASS`，DUT 结果为 480。
  - [x] 在线会话接收运行目录、顺序 plusargs 和激励文件列表并在启动时核对哈希。以同一 VCS 可执行文件启动两套输入，在 Linux VS Code 1.124.2 和 MCP 核对 tick 5 的结果与输入。第一套与参考执行记录匹配，第二套报告运行目录、参数及激励差异，继续显示第二套采样和原始事件。
  - [x] VCS 阻塞赋值探针已记录 `$fgetc` 实际读取的字节、文件偏移及 EOF。Linux VS Code 1.124.2 的 MCP 在最小样本中核对三个提交及原始源码位置。OpenTitan MAC 实跑核对了 52 个字节、EOF、13 次 TileLink 握手、PC `0x90` 解码和寄存器 x28 的值 480。MCP 回放进一步核对了偏移 16–19 的原始读取位置、四个字节及随后的 TileLink 数据 `0x9062be2b`。
  - [x] 将 OpenTitan 的文件读、固件写入、指令解码和寄存器提交统一到一次从 DUT 信号发起的 MCP 自动查询。一次 `wave_trace_context` 从 `x28=480` 追到 testbench 的 `tl_i.a_data`，并在同一节点连接 task 输入提交 354、成员写入提交 365 和文件偏移 16–19 的四次求值。硬件路径仍保留候选边及覆盖缺口，IMEM 按字节确认实际写入单独验收。
    - [x] 对波形中单独采集的数组元素，VIDE 返回外层索引。Wave Workbench 用 KDB 的 generate 下标解析该索引，在分配追踪预算前筛选根元素的写入。用同一份 OpenTitan MAC FSDB 从 MCP 分别查询 `mem[27]` 与 `mem[28]`。两次各保留对应迭代的三条写入，时间图从 `mem[28]=480 @ 2051000 ps` 穿过写回端口回到 `mult_result=480 @ 2037000 ps`，沿途仍标为候选。取指和固件加载间的依赖仍待接入。
    - [x] 实例展开按距根信号的层级分配最终预算，保留整条赋值及其参与信号。使用 OpenTitan 原始源码清单和真实 FSDB，以深度 17、300 个信号为上限，从 `x28` 一次查询到 ID 阶段的 `mult_en_ex_o=1 @ 2037000 ps`，经过写回数据路径到 `x28=480 @ 2051000 ps`。所有相关边仍标为候选，结果保留预算前沿。独立后端通过 112 项，Verdi NPI 通过 101 项并跳过 11 项独立专用用例。
    - [x] VIDE 复用同一编译配置的 Salsa 缓存。Linux VS Code 冷查询原先 640 个信号超时，修改后约 18 秒返回。修改后的深度 24 查询允许 2048 个信号和 4096 条赋值，从 `x28` 经乘法使能回到解码器的 `instr_rdata_i=0x9062be2b @ 2023000 ps`，实际耗时约 33 秒。若独立 KDB 缺少某个中间信号声明，保留图和观测缺口。
    - [ ] 从解码器指令输入继续定位实际取指响应、固件所在地址的最近有效写入与对应的文件读取事件。
      - [x] 时间图合并具有相同采样及证据属性的边，保留全部候选赋值编号。相连的等宽直连端口有值匹配样本时，只追踪这些样本。离线与在线 MCP 支持显式时间图预算。
      - [x] 使用同一 OpenTitan MAC FSDB，在深度 30、4096 个时间节点和 8192 条时间边预算下，从 `x28=480 @ 2051000 ps` 一次查询回到取指阶段 `instr_aligned=0x9062be2b @ 2009000 ps`。该路径经过解压、解码、乘法使能和写回，逐段保留候选标记。实际图包含 1596 个节点和 3298 条时间边。独立后端通过 114 项，Verdi NPI 通过 103 项并跳过 11 项独立专用用例。
      - [x] MCP 允许显式提高静态赋值预算至 8192。使用深度 34 的真实 FSDB 单次查询，从 `x28=480 @ 2051000 ps` 经过对齐器、预取缓冲和 OBI 路由，追到 IMEM 的 `cpu_rdata_o=0x9062be2b` 和 `rd_idx_q=36 @ 2009000 ps`，对应字节地址 `0x90`。查询约 49 秒，返回 4885 条静态赋值及 2020 个时间节点。
      - [x] VIDE 保留 `mem[wr_idx][位段]` 的字索引、字内位段和 RHS。通过真实 VS Code 的 MCP 核对 IMEM 四条按字节使能的 NBA 写入及其源码位置。
      - [x] 直接查询单独采集的数组元素时，按已观测的字索引排除其他地址的候选，索引稳定时核对写入位段的值，同一 tick 发生索引切换时保留候选。真实 FSDB 中 `u_imem.mem[36]` 在 `931000 ps` 更新为 `0x9062be2b`，此处仍有同 tick 的索引歧义。独立后端通过 115 项，Verdi NPI 通过 104 项并跳过 11 项独立专用用例。
      - [x] 离线时间图按读端口采样时的索引绑定已采集的数组元素。在真实 FSDB 的一次 MCP 查询中，从 `x28=480 @ 2051000 ps` 自动追到 `u_imem.mem[36]=0x9062be2b @ 931000 ps` 和相应的 `wr_data` 样本。读索引同 tick 变化时逐一核对候选元素与读出值。约 48 秒返回 4885 条静态赋值和 2240 个时间节点。
      - [x] 同次 VCS 运行生成的 FSDB 和 VPI 记录用于联合验收。一次 MCP 查询经过 39 条时间边到 `imem_host_wdata`。验收脚本验证了两级 TileLink 握手、IMEM 本地时钟上升沿、字索引 36 和四个字节写使能，并在取指前排除该地址的后续写入。独立后端通过 116 项，Verdi NPI 通过 105 项并跳过 11 项独立专用用例。
      - [x] VIDE 记录整信号连续赋值中直接读取的结构体成员。若同次执行日志覆盖该成员，MCP 用与波形哈希匹配的回调补全采样。从 `x28` 一次查询追到 FSDB 未采集的 `u_core.tl_i.a_data=0x9062be2b @ 917000 ps`，Mermaid 和 Trace Explorer 标记其执行日志来源。独立后端通过 117 项，Verdi NPI 通过 106 项并跳过 11 项独立专用用例。
      - [x] 通过同一 package packed struct 类型的无转换直连端口传递已记录成员。一次 MCP 查询经 `u_core.tl_i.a_data` 继续到 CDC 下游的 `dut.tl_dsp_h2d.a_data=0x9062be2b @ 917000 ps`。两端都由同次 VPI 记录覆盖。查询约 49 秒，返回 2504 个时间节点。
      - [x] KDB 用已展开 generate 实例的名称和源码位置排除未选分支。参数化数组索引的 packed 切片采用 KDB 实例参数。在真实 FSDB 中从 CDC FIFO 的 `rdata_o @ 917000 ps` 追到 `storage[3] @ 895000 ps` 和该次 `wdata_i @ 890000 ps`，完整 107 位请求一致。独立后端通过 118 项，Verdi NPI 通过 107 项并跳过 11 项独立专用用例。
      - [x] 独立 KDB 后端解析请求 FIFO 的结构体成员拼接端口，核对每个成员的位宽和连接顺序。一次 MCP 查询从 `x28` 穿过 CDC 的 `storage[3]`，追到 testbench 的 `tl_i.a_data=0x9062be2b @ 890000 ps`。查询约 56 秒，返回 3179 个时间节点。
      - [x] 静态图连接本地 task 的有名和位置输入实参，保留结构体成员写入的目标和 RHS。在真实 OpenTitan 的根查询中，`tl_i.a_data` 写入关联到 `host_access` 的 `wdata`，静态调用关系覆盖固件循环中传入的 `run.word_value`。同一次查询绑定了命名过程块的波形，分别核对 `word_value=0x9062be2b` 与 `byte_value=0x90 @ 880000 ps`。
      - [ ] 捕获自动 task 的调用点、输入求值和对应成员写入，区分并发或同 tick 的调用。VCS 当前的 VPI 自变量回调无法采集该自动 task 的形参。需要在调用与赋值的记录中携带调用身份，才能把静态实参关系和四次文件读取并入同一因果链。
        - [x] OpenTitan 验收探针把固件输入的字节计数随 `host_access` 调用传入自动形参，从任务入口和成员写入处分别采样。同次 VCS 执行记录逐一核对了 13 次调用、对应字段提交及四字节组。字节计数 20 的调用在 `880000 ps` 取到 `0x9062be2b`，`890000 ps` 写入 `tl_i.a_data`。用同次 FSDB 在真实 VS Code 的 MCP 根查询中找到该成员节点。
        - [x] `seal-vpi --task-transfers` 保存探针约定。回放核对波形哈希、源文件、调用和成员写入的索引、对应的文件读提交及成员回调顺序。并发回归覆盖两个同 tick 进入且随后反序写入的调用。真实 VS Code 的 OpenTitan MCP 一次查询返回任务与文件字节证据。独立后端通过 119 项，Verdi NPI 通过 108 项并跳过 11 项独立专用用例。
        - [x] `output: "report"` 可单独取得 Markdown 报告与所选 Mermaid 图。OpenTitan 实测响应约 38 MB，包含调用提交和四次文件读取。精选 Mermaid 图在 Chromium 成功渲染。
        - [x] 合并时间图保留已录制的 task 入参、成员写入与文件读取。Linux VS Code 1.124.2 对同次 OpenTitan MAC FSDB 和执行记录从 `x28=480` 查询并续查一段。逐页核对 5457 个时间节点及 11723 条边，从根沿证据边到达 `0x9062be2b` 对应的提交 354、365 与文件偏移 16–19。图仍有 228 个待查入口。合并 Mermaid 与详细报告包含该路径，Trace Explorer 与原理图回归核对源码跳转。
        - [x] 从另一份包含 IMEM 字节写入探针的 OpenTitan MAC VCS 记录提取 `u_imem.mem[36] @ 931000 ps` 的局部路径。Linux VS Code 前台与静默 MCP 的详细报告和 Mermaid 一致，包含 `tl_i.a_data` 对应的任务输入提交 514、成员写入提交 525 及固件偏移 16–19 的读取。Chromium 渲染局部图。
        - [x] 用同次 OpenTitan VCS FSDB 和执行记录从 `x28 @ 2051001 ps` 复验。根图已有 IMEM 地址 36 的四次字节提交。通过 `wave_trace_resume` 指定两个 `wr_data` 位的前沿编号，接回从 `x28` 到 `tl_i.a_data @ 890000 ps` 的 49 边最短路径及固件读取证据。Linux VS Code 前台与静默 MCP 的 13 页局部 Mermaid、Markdown 和结构化分页一致。合并图保留 680 个待查入口。
        - [x] 静默 MCP 从同一 `x28` 查询按默认队列顺序续查两段，同样在局部图中取得 49 边最短路径及四次固件读取证据。合并图保留 682 个待查入口。
      - [ ] 按写入求值时的索引、守卫和掩码逐字节区分实际写入与同 tick 候选，并将 IMEM 写数据连到 TileLink 接受及文件读取事件。
        - [x] 在带任务和文件读探针的同一次 VCS 仿真中补采 IMEM 时钟、读写字索引、写使能、掩码和数据。新记录验证了字索引 36 在 `931000 ps` 之前的采样为 `wr_en=1`、`wr_be=0xf`、`wr_data=0x9062be2b`，随后在 `2009000 ps` 读回。
        - [x] 针对 OpenTitan 的 `mem[36]` 在隔离的 RTL 副本加四个 NBA 探针。来自同次 VCS 运行的 FSDB 与回调核对了 `931000 ps` 的四次字内变化，聚合执行回放匹配四次提交 553、555、557、559。一次从 `x28` 发起的 MCP 查询在时间图中保留四次变化及最后一个字节的实际写入。
        - [x] 对写满整字且互不重叠的位段显示各自的来源。真实 VCS 和 Linux VS Code 1.124.2 的同一次 `wave_trace_context` 从 `x28=480` 追到 IMEM 字 36 的四次精确提交，并通过匹配的 `wr_data` 样本接到 TB 的四次 `$fgetc`。MCP、Mermaid 和 Markdown 分别保留位段、求值及提交序号。独立后端通过 122 项，Verdi NPI 通过 111 项并跳过 11 项独立专用用例。
        - [x] `wave_execution_map` 和 `generate-vcs-nba` 自动为选定数组字生成整字或固定位段的 NBA 探针。用原始 OpenTitan KDB 经 MCP 查询 `mem[36]` 和 `mem[37]`，各取得四条源码映射。用生成的 RTL 副本实跑 VCS，两个字各核对四次实际提交，仿真结果为 480。同一次带 TB 文件读探针的运行经 MCP 从 `x28` 再次回溯到 `mem[36]` 的四次提交、写数据及固件偏移 16–19。回归覆盖多个字共用同一源码写入、固定负下标和源文件行号。独立后端通过 123 项，Verdi NPI 通过 112 项并跳过 11 项独立后端专用用例。
        - [x] 数组字按位保留最后一次已确认写入。真实 VCS 掩码用例在 5、15 和 25 ps 分别写入 `[7:4]`、`[3:0]` 和 `[5:2]`。Linux VS Code 的 MCP 从读出端和数组字本身均核对三个提交，最终来源分别对应 `[7:6]`、`[1:0]` 和 `[5:2]`。首个时间点将尚无来源的 `[3:0]` 标为未解析。回归覆盖较早时间槽未观测写入仅影响相交位，并验证探针声明位于 `timeunit` 和 `timeprecision` 之后。
        - [x] 实际 VCS 同槽用例在 5 ps 记录 `[7:4]` 提交 4、`[3:0]` 未观测结果 7 和 `[2:0]` 提交 8。MCP 从读端和数组字查询均核对槽末值 `0xa3`，保留高四位的提交和上游，低四位标为未解析。回归覆盖波形与日志无法匹配、槽末值不同以及单个位变化序列不一致。独立后端通过 123 项，Verdi NPI 通过 112 项并跳过 11 项独立后端专用用例。
        - [x] 数组字的 `wave_execution_map` 支持 `captureGuards`，`generate-vcs-nba` 可记录求值时的局部守卫操作数。实际 VCS 用例在 5 ps 记录三个 NBA 求值时的 `mask=111`，随后在同槽观察到 `mask=000`。Linux VS Code 的 MCP 从读端和数组字均使用 `111` 的样本解释已核验的高四位提交。详细报告和 Mermaid 保留控制边的求值证据。
        - [x] 固定目标 NBA 同样可记录 `if/else` 分支入口。真实 VCS 在线提交与离线回放核对，在 5 ns 进入时 `select_a=1`，赋值求值时因块内写入变成 0。已确认的提交 6 沿入口值回溯到 2 ns 的采样。9 ns 的单语句 else 入口为 0，对应提交 12。前台和静默 MCP 的图与报告一致，在线报告比较时归一化本次会话 ID。 [复现步骤](test/fixtures/trace/README.md#vcs-fixed-target-branch-entry)
        - [x] 普通 `case`、`casez`、`casex` 和 `case inside` 使用 VIDE 的分支源码范围生成入口探针。在真实 VCS 的零时间 NBA 分支中保留四态选择值及默认分支标记。离线与在线证据沿原始选择值回溯。 [复现步骤](test/fixtures/trace/README.md#vcs-case-branch-entry)
        - [x] 为入口采样记录 VPI 原始 tick，与 NBA 求值和提交分别关联。实际 VCS `#3` 分支在 5 ns 进入，8 ns 求值和提交。时间图沿 2 ns 的选择变化与 7 ns 的数据变化回溯。短历史窗口保留 5 ns 已记录入口和波形缺口。前台、静默和在线暂停实测一致。 [复现步骤](test/fixtures/trace/README.md#vcs-timestamped-branch-entry-after-a-procedural-delay)
        - [x] 记录 VCS 简单 `wait` 直接控制的 NBA 恢复值与时间。真实 VCD/KDB 用例中，`case` 的入口在 5 ns，`ready` 解除等待和提交在 9 ns。时间图及报告分别标注分支入口与等待恢复，前台和静默 MCP 的离线与在线查询一致。 [复现步骤](test/fixtures/trace/README.md#vcs-wait-resume-inside-a-case)
        - [x] 同一顺序块内独立 `wait` 与相邻 NBA 建立 Driver/Load 控制依赖，允许中间有独立数字延迟。真实 VCS `wait (ready); #3;` 样本在 7 ns 恢复，10 ns 提交。时间图保留原始恢复值和时间，离线与在线断点都指向 7 ns 的上游变化。 [复现步骤](test/fixtures/trace/README.md#vcs-standalone-wait-before-an-nba)
        - [x] 为由局部信号、`!`、`&&`、`||` 和括号构成的 VCS `wait` 条件记录全部恢复采样。`case` 内直接等待和独立等待后延迟的 NBA 均经真实仿真核对。时间图保留 `inhibit=0 @ 7 ns` 的同 tick 变化及较早的 `ready` 和 `rescue` 来源，详细报告保留三路恢复值。前台与静默 MCP 的离线及在线图和报告一致。 [复现步骤](test/fixtures/trace/README.md#vcs-compound-wait-before-an-nba)
        - [x] 用已绑定的四态谓词、恢复采样及完整波形窗口标出等待转为真时唯一观测到的输入变化。真实 VCS 两条路径均将 `inhibit @ 7 ns` 标为该变化，报告、时间图及 Trace Explorer 共用对应的因果边属性。回归覆盖多路同 tick、条件已为真和历史缺失。 [复现步骤](test/fixtures/trace/README.md#vcs-compound-wait-before-an-nba)
        - [x] VCS 等待条件扩展至整数常量、按位操作、相等及关系比较。实测掩码保留 `X` 位，四态相等和有符号阈值参与同一因果判断。直接分支在 7 ns 提交 9，独立等待加延迟在 10 ns 提交 15。在线断点及离线回放均沿同一控制边定位到 7 ns 的 `status` 变化。 [复现步骤](test/fixtures/trace/README.md#vcs-masked-and-signed-comparisons-in-a-wait)
        - [x] 对同 tick 的多路条件变化，利用已核对的 VCS 回调顺序重算条件。真实样本中回调 4 后条件仍为假，回调 5 后条件为真。直接和延迟写入的在线、离线时间图及详细报告均保留因果边的回调序号。 [复现步骤](test/fixtures/trace/README.md#vcs-ordered-callbacks-in-a-wait)
        - [x] 对同一操作数在同 tick 的重复变化，逐个核对波形变化与 VCS 回调。真实样本中 `ready` 在 7 ns 两次变为 1，因果边使用第三次变化和回调 7。若谓词在该 tick 内反复成立，保留候选证据。 [复现步骤](test/fixtures/trace/README.md#vcs-repeated-changes-in-a-wait)
        - [x] 等待采样增加当时的下一事件序号，并在核对完整回调后仅重放恢复前的变化。真实 VCS 样本在 7 ns 两次使条件成立，当前探针的在线和离线图均定位到第一次成立的回调 5，旧日志仍保留原有推断。 [复现步骤](test/fixtures/trace/README.md#vcs-wait-resumed-during-a-pulse)
        - [x] 等待原因节点保留已经核验的值变化回调序号，MCP 可按该序号提取局部上游路径。真实 VCS 从直接及延迟 NBA 反查到阻塞提交 8 的 RTL 驱动和 3 ns 的 `trigger_value`，分页报告保留恢复边界与两个赋值的源码位置。 [复现步骤](test/fixtures/trace/README.md#vcs-upstream-writer-of-a-wait-condition)
        - [x] 时间图预算切断等待控制边时，续查匹配同一个值变化回调。真实 VCS 的在线及离线 MCP 在一条边的预算下优先续查回调 7，一段后接回阻塞提交 8。按回调编号提取路径时仍保留该等待原因及源码位置。 [复现步骤](test/fixtures/trace/README.md#vcs-upstream-writer-of-a-wait-condition)
        - [x] OpenTitan 实跑在 IMEM 地址 36 的四次求值中记录 `wr_en=1` 和 `wr_be=1111`。Linux VS Code 的单次 MCP 查询从 `x28=480` 回溯到四次提交、各自带采样证据的两个控制输入及固件偏移 16–19。独立后端通过 123 项，Verdi NPI 通过 112 项并跳过 11 项独立后端专用用例。
        - [x] 实际 VCS 用例在带嵌套逻辑条件的命名 `if` 块内记录入口 `mask=111`。分支改写后，同次 NBA 求值记录 `mask=110`，并连到高四位提交 7。MCP 从读端和数组字查询均核对两次采样，Markdown 和 Chromium 渲染的 Mermaid 图显示原始条件位置。独立后端通过 123 项，Verdi NPI 通过 112 项并跳过 11 项独立后端专用用例。
        - [x] 实际 VCS 用例采集命名 `else` 块入口的 `mask=111`、同次 NBA 求值的 `mask=110`，以及两条无显式块的 `if` 写入。MCP 从读端和数组字查询均返回假分支入口及原始条件位置。回归覆盖单语句假分支和嵌套 `if` 的 `else` 归属。独立后端通过 124 项，Verdi NPI 通过 113 项并跳过 11 项独立后端专用用例。
        - [x] 实际 VCS 用例验证条件函数的副作用。原始与插桩仿真均只调用 `take_lane()` 一次，读端结果均为 `0xa3`。MCP 从读端和数组字查询均核对函数执行后的入口值 `mask=110`、分支改写后的求值 `mask=111` 与高四位提交 8。回归覆盖 VIDE 只能提供条件源码位置时的入口采集，并核对生成的条件保留一次函数调用。独立后端通过 124 项，Verdi NPI 通过 113 项并跳过 11 项独立后端专用用例。
- [x] 用真实 VCS DPI 仿真核对 SystemVerilog 调用的输入、返回值和输出参数。MCP 保留调用点、波形观测和外部执行缺口。
- [ ] 将 DPI 函数内部及其他外部激励关联到可复验的执行记录。
  - [x] 记录 VCS `-P` 表、链接对象及本次运行前的文件哈希。真实自定义 PLI 和 Verdi FSDB 用例均通过前台与静默 MCP 验收。自定义回调在 5 ns 写入信号，报告同时显示已观测的赋值传播与 `externalPliCallbacks` 覆盖缺口。文件缺失和哈希冲突分别返回 `missing` 与 `mismatched`。回调内部的读写顺序仍待采集。
  - [x] 将运行清单或 VCS `-P` 表的调用名称载入隔离 VIDE 配置。真实 `$wb_drive` 的 Driver 与 Load 都定位到 RTL 调用，时间图保留 2 ns 输入和 5 ns 输出之间的候选边。前台与静默 MCP 核对静态图、时间图和详细报告。未注册的调用不推断实参写入。保留 `unresolvedSubroutineEffects` 和 `externalPliCallbacks`，仍需收集回调本身的实参读写及顺序证据。
  - [x] 对可插桩的同步 VCS PLI 写入，采集两次 C 操作的值和顺序、RTL 调用位置及写入后的实际信号。用真实 `$wb_drive` VCD 和封装记录回放，Linux 前台与静默 MCP 均从 `observed` 追到 `target @ 5 ns` 的提交 4。两端时间图和报告一致，Mermaid 在 Chromium 渲染。覆盖核对依赖波形、探针映射和源码哈希，跨槽提交反例被拒绝。
  - [x] 使用同一 VCS 可执行文件在线暂停于 `$wb_drive` 的提交 4。核对运行参数、RTL 编译配置、PLI 表与对象、采集库和各信号的事件序列后，VS Code、前台 MCP 与静默 MCP 恢复同步写入的 C 步骤与源码，在线图与离线图一致。采集库、PLI 对象或 plusargs 的反例保留在线观测，撤除旧日志归因。未插桩回调继续计入覆盖缺口。
  - [x] 单线程 Verilator 的同步 DPI 调用可显式记录 C++ 内部步骤。按实际的 RTL 求值封装这些步骤，核对 C++ 源码哈希，在动态时间图和报告中链接步骤。已验证实参、返回值和源哈希变化。

## Phase 1　VIDE 静态语义

- [x] 在现有引用索引中使用 AST 上下文和 HIR 符号绑定分类 READ、WRITE、READ|WRITE 和非数据引用。测试覆盖连续赋值、blocking/NBA、复合赋值、索引、位选择、拼接、字段、条件、宏参数和未解析引用。模块端口分类覆盖命名、位置和简写连接及 input/output/inout/ref。
- [ ] 在构建静态索引时验证更多访问形式，包括 wildcard、复杂 interface/modport 和跨作用域限定。对于无法判断的驱动来源返回部分结果和原因。
  - [x] VIDE 保留层次读取的源文件位置并将表达式操作数按引用位置区分。从读取关系继续查询该信号自身的赋值时，使用展开实例对应的源码上下文。
  - [x] VIDE 解析命名接口的 modport 所公开的直接数据成员及指向单一成员的显式别名，保留固定十进制位选和范围的源码边界。隐藏成员和暂未支持的复合表达式保留未解析状态。
- [ ] 实现 Driver/Load 双向索引。先完成单模块、连续赋值、基础过程赋值和控制依赖，再增加 `if/else`、`case`、顺序覆盖、保持、时钟/异步复位、多驱动、位范围和端口依赖。
  - [x] 验证单文件连续赋值、blocking/NBA、`if/else` 条件引用与上升/下降触发边沿。索引经 Salsa 和 AnalysisSnapshot 暴露，递归遍历支持上下游、停止预算和环路终止。
  - [x] 静态图包含声明初始化和 `case` 的选择信号及相关分支标签。动态报告对 `case`、`casez`、`casex` 核对四态标签与分支优先级。模式匹配、复杂事件与延迟赋值仍保留候选。
  - [x] 为直接包裹赋值的 TB `#(delay)` 和 `wait (condition)` 收集控制读依赖，正向及反向 Trace 均可访问。时间报告保留候选与实际观测。
  - [x] 静态赋值关系保留所属 `always`、`initial` 等过程的源码范围。MCP 和详细报告返回该位置。同一过程内的多个赋值共享过程范围。
- [ ] 扩展跨模块端口、常量连接、参数化和 generate 所需的语义信息。对复杂动态索引、循环、任务副作用、interface/modport、force/release 和无法建模的调度返回明确诊断。
  - [x] VIDE 将 `force`、`release`、过程 `assign` 和 `deassign` 纳入 Driver / Load 图，保留目标、数据来源和源码坐标。`proceduralOverride` 标记持续生效时间与恢复顺序的缺口，离线报告保留候选。
  - [x] 修改版 VIDE 识别有明确方向的 task 参数，保留位置和命名调用的读写关系。沿同模块的直接 task / function 调用链加入可解析的模块信号读依赖，并以 `unresolvedSubroutineEffects` 标注其余副作用。
  - [x] 静态图保留六种过程循环的控制依赖、循环所在位置、`for` 初始化与步进，以及前置和后置自增、自减的读写关系。MCP 与 Trace Explorer 标明离线波形无法还原的迭代和表达式求值顺序。
  - [x] VIDE 的两种 Trace 请求回传赋值所在的条件 generate 分支及其同级分支位置，区分语法分支与运行时控制条件。实测覆盖命名 `if/else`、`case` 和嵌套分支内的过程赋值。
- [ ] 复用 Salsa 和 AnalysisSnapshot，支持 revision、局部失效、取消、深度/节点限制与环路终止。保留现有 Definitions、References、Rename 行为及宏映射。

**验收**　Rust 测试核对每个读写引用、源码定位、依赖类型、多驱动和赋值顺序。文件修改后只重算相关索引，查询取消、循环终止和截断均有覆盖。

## Phase 2　VIDE LSP 与扩展 API

- [x] 实现基础 `vide/traceDrivers` 和 `vide/traceLoads`，接收文档 URI、位置及图预算，回传 schema 版本、revision、源码位置和查询前沿。当前结果标记为单文件。
- [x] 从 `pascal-lab.vide-code-extension` 导出公共 `VideAnalysisApi`，以已有 LanguageClient 转发请求，处理能力协商、取消、超时、服务重启及不支持的服务端。
  - [x] 桌面扩展已导出版本化 API，按 LSP 能力可用性转发两个请求并传递取消令牌。
  - [x] 工作区和隔离会话共用有界请求。取消或超时能立即结束等待，并通知服务端。只有初次索引未就绪时重试。
- [x] 分别测试 Rust/LSP 与 VS Code 扩展调用，覆盖版本兼容、请求取消、服务重启和语义修改后对旧结果的处理。

**验收**　LSP 客户端可独立查询，VS Code 消费扩展可使用现有 VIDE 会话，收到一致的图和错误状态。

## Phase 3　静态 Trace Explorer 与 MCP

- [x] 实现 VIDE 客户端、信号解析、实例映射和统一 Trace Service。复用 `src/kdb.ts`、`src/verilator.ts` 的 DesignSession、`src/source-sync.ts` 以及已有路径配置。
- [ ] 先贯通 FST 中一个单模块信号，再加入端口跨模块、重复实例、generate、切片和常量连接。用 DesignSession 验证映射，保留 `unresolved`/partial 并返回具体原因。
  - [x] Verilator JSON 基础端口连接已合并进跨实例图，包括简单变量引用、命名和位置端口，以及生成实例的一位选择。边保存源和目标位索引。
  - [x] Verilator JSON 固定 packed 端口切片支持升序和降序声明。Trace Explorer、Mermaid 与详细报告显示所选范围。尚未建模的复杂端口表达式在查询前沿明确标记。
  - [x] Verilator JSON 中 elaboration 后的直接常量输入端口进入静态图，图和报告可定位常量连接的 RTL。
  - [x] Verilator 用实例展开位置筛选命名条件 generate 的赋值和上下游信号。MCP 静态图、时间图和报告使用同一筛选结果。无法确认的分支保留候选并提供 `unresolvedGenerateBranch`。
  - [x] 用 Verilator 5.054 的展开 JSON、VCD 和 FST 核对循环 generate 的逐次绑定。三个匿名迭代各写入一个确定的输出位，内层条件各自选择 `src_a` 或 `src_b`。前台和静默 MCP 共核对六张分页时间图、源码位置和报告。命名循环与内层命名分支通过单独的 VCD 样本复核。 [复现步骤](test/fixtures/trace/README.md#verilator-generate-loops)
  - [x] Verilator 循环内的单语句 `if/else` 使用其隐式展开作用域。VCD 与 FST 在同一行的两个赋值之间按列号核对实际分支。三个输出位的前台和静默 MCP 分页图均保留各自的迭代、源码列号和输入变化。 [复现步骤](test/fixtures/trace/README.md#verilator-generate-loops)
  - [x] 循环内无 `else` 的条件在展开作用域缺失时，用当前实例的 genvar 核对条件。真实 VCS KDB/VCD 和 Verilator JSON/VCD 均验证 `lane < 0` 与 `lane == 0`，两组总线共保留两个有效写入位。条件为真或无法求值而作用域缺失时继续报告 `unresolvedGenerateBranch`。 [复现步骤](test/fixtures/trace/README.md#generate-loops-without-else)
  - [x] 循环内无 `default` 的 `case generate` 在展开作用域缺失时核对全部标签。真实 VCS KDB/VCD 和 Verilator JSON/VCD 均验证多标签分支、负 genvar 和无匹配迭代。匹配标签仍存在、无法求值或操作数位宽不一致时保留 `unresolvedGenerateBranch`。 [复现步骤](test/fixtures/trace/README.md#generate-case-without-default)
  - [x] Verilator 波形按展开位置绑定直接的层次读取。Driver 查询递归追踪到叶子实例输入。Load 查询可追踪展开设计中读取该信号并写入单个本地信号的使用点。复杂层次写入和其他设计后端的绑定仍待覆盖。
  - [x] Verilator 波形的直接层次写入按展开的实际目标和 RTL 写入点绑定。Driver 可从叶实例跳到 TB 写入点，再沿 TB 信号向上游追踪。Load 可从 TB 输入沿写入继续到实际目标实例。
  - [x] 使用 Verilator 展开树可将命名 modport 的直接成员及指向单一成员的别名绑定到实际接口实例。直接成员的读写端可跨转接模块追踪。别名用 VCS 和 Xcelium 的 VCD 验证。
  - [x] 两种 KDB 读取模式都为接口成员返回实际的接口实例和接口类型定义。在 VCS 的两个同类型接口实例上核对了实例路径及声明行。
  - [x] Verdi NPI 可通过 VCS KDB 将命名 modport 的简单别名绑定到实际接口成员，并反查源码分属不同文件的驱动和读取端。已从 FSDB 展示的读写别名及底层成员出发验证 MCP 追踪，并在一条通道上核对中间模块转接。
  - [x] 独立 KDB 将命名单接口端口上的直接 modport 别名绑定到实际接口成员，并反查读写端。独立 FSDB 读取器保留接口下的别名路径。用两条通道及实际 VCS VCD、FSDB 核对静态 Driver / Load 和动态时间图。
  - [x] 独立 KDB 按声明顺序连接一维接口数组，并支持从单个实际元素反查固定十进制下标的 modport 读写端。真实 VCS VCD 和 FSDB 使用相反方向及负下标端口验证实例隔离、Driver / Load 和时间图。
  - [x] 接口数组下标支持可求值的定宽表达式、32 位有符号十进制常量和已验证展开作用域中的 genvar。真实 VCS 样例核对算术求值、负下标和两个 generate 实例在 Driver / Load 与时间图中的实际接口元素。
  - [x] 独立 KDB 为接口数组下标提供当前实例的整型 parameter 和 localparam 值，保留位宽、符号及源码位置。真实 VCS 样例验证参数覆盖、负下标及重复实例，MCP 和时间图标记展开参数。
  - [x] 独立 KDB 可解析连接到标量接口实例的通用端口。VIDE 依据实际接口声明索引成员，两个同名成员属于不同接口类型时保留各自的来源。
  - [x] 独立 KDB 保留显式传给通用端口或经过包装模块转发的标量 modport 视图。VIDE 按实际视图解析直接成员和别名，未公开的成员无法参与绑定。
  - [x] 独立 KDB 核对同一通用数组端口的实际元素是否共享接口声明，再按上下界的声明顺序定位具体实例。真实 VCS 的 VCD 和 FSDB 验证两种接口类型、正负下标和四条独立的 Driver、Load 与时间因果链。
  - [x] 虚接口成员访问使用 `unresolvedVirtualInterfaceBinding` 报告所需的运行时绑定证据。VCS 样例在运行中重绑句柄，VCD 和 FSDB 保留结果及物理接口数据，MCP 和详细报告定位三处访问。
  - [x] 用独立 KDB 和 Verdi NPI 核对固定 modport 切片。真实 VCS 的 VCD 和 FSDB 验证升降序及同一总线的互斥切片。独立 KDB 另外验证负下标、超过 255 的下标，以及直接从 FSDB 标量别名开始的 MCP 追踪。
  - [x] 独立 KDB 与 VIDE 支持由变量、固定个位选或切片组成的一层 modport 拼接。读操作按源码顺序保留各项及重复项。写操作按目标位宽分配 RHS，保留各成员的位方向。用真实 VCS VCD 和 FSDB 验证逐位 Driver、Load 和时间图。
  - [x] 独立后端与 Verdi NPI 均可从 FSDB 中的整条拼接别名或单个位直接查询。以真实 VCS receiver/sender 别名验证 MCP Driver、Load 和时间图，以及 VS Code 波形菜单、Trace Explorer 和源码位置。
  - [x] 独立 KDB 与 Verdi NPI 按源码顺序展开嵌套 modport 拼接。重叠写入保留各组件的目标位与 RHS 位，时间报告结合可用波形记录保留写入候选。已用真实 VCS FSDB 和 VCD 核对 Driver、Load、别名根节点和同 tick 的多次变化。
  - [x] Verdi NPI 通过已绑定的 modport 枚举负下标别名。实测 FSDB 标量别名 `ni` 的范围为 `[-2:-2]`，切片别名 `n` 的范围为 `[-2:-3]`，MCP Driver、Load 和时间查询保留实际位号。
  - [ ] 将虚接口运行时目标关联到对应读写事件。继续验证未能从展开数据库取得值的参数及重叠写入的精确执行顺序。VCS T-2022.06-SP2 可仿真所测的变量拼接，对所测的 net 拼接返回 `SV-FNYI`。Xcelium 23.09 对所测的位选、切片和拼接返回 `MODPXE`。
  - [x] Verdi NPI KDB 可追踪直接信号端口，抽查了 RV32A 的输入、输出方向和 TB 到 DUT 的时钟连接。
  - [x] 独立 KDB 和 Verdi NPI 支持普通模块等宽的固定输出拼接，从形式端口的左界按顺序映射到整信号、固定位选和固定位段。真实 VCS FSDB 和 VCD 的 MCP 时间图均核对四条路径。`upper[2]`、`lane[1]`、`tail_a` 和 `tail_b` 分别经 `dut.q[0]`、`[2]`、`[4]` 和 `[5]`，回溯至 `src[5] @ 2 ps`、`[3] @ 5 ps`、`[1] @ 8 ps` 和 `[0] @ 11 ps`。Load 核对首尾位的对应目标。Verdi NPI 当前验收范围为四态逻辑目标。独立后端通过 133 项，Verdi NPI 通过 127 项。
  - [x] 普通模块的固定输出拼接与形式端口位宽不同时，两个 KDB 后端按低位对齐。真实 VCS VCD 和 FSDB 在 Linux VS Code 通过 MCP 核对了各 10 条时间查询和 5 条 Load 查询，包括原有等宽用例。`sign_hi[1] @ 2 ps` 经 `s.q[0]` 回溯至 `tb.a[2]`，`zero_hi[1]` 对应常量零，截断的 `n.q[0]` 无拼接 Load。四种组合均从 `vcs_rebuild` 自动恢复顶层 `tb` 和工作区外的源码，由隔离 VIDE 会话加载。回归通过 134 项独立后端测试、128 项 Verdi NPI 测试及 9 项 Rust 测试。
  - [x] 独立 KDB 读取器可解析普通模块的命名、位置、简写及通配连接，保留 input、output、inout 的方向和连接行。VCS FSDB 中验证了 MCP 跨实例图。未解析的拼接在 Driver 与 Load 前沿报告，显式空连接保留为断开。
  - [x] 独立 KDB 支持一维 packed 固定范围、固定 indexed part-select、单个位选，以及连接到简单输入端口的整数和四态字面量。图保留升序和降序选择。报告显示常量实际位宽，以及所选端口的位宽变化和二态转换。
  - [x] 独立 KDB 对有明确 packed 位宽的整信号端口生成转换关系，并使用已展开的参数化宽度。MCP 可追踪有符号扩展、无符号扩展、截断及二态转换。
  - [x] 独立 KDB 按数组实例的声明顺序分配 packed 端口位段。支持升降序和负下标、固定切片的输出拼接，以及等宽输入广播。定宽字面量可以按总宽度分割或按单实例宽度广播。
  - [x] Verdi NPI 补入普通输入端口的字面量驱动，核对展开实例、连接位置、位宽、原始四态位串和符号属性。真实 VCS FSDB 的 MCP Driver 图和波形报告核对了八个信号。数组输入 `4'b1001` 依次分配为 `10`、`01`，`2'sb10` 广播后两个实例均收到 `10`。普通端口分别核对符号扩展 `11`、零扩展 `01`、四态值 `xz` 和填充值 `11`。独立后端通过 132 项，Verdi NPI 通过 126 项。
  - [x] Verdi NPI 拿到实例数组端口的固定 packed 位选和切片后，可从父实例或子实例查询等宽连接。真实 VCS KDB 回归覆盖升降序、负下标实例和等宽广播。Linux VS Code 与真实 VCS VCD 的 MCP Driver 和时间图从 `arr_target` 经 `bank_value[1]` 追到 `bank[1]` 和 `tb.b @ 5 ns`，从 `arr_sibling` 经 `bank_value[0]` 追到 `bank[0]` 和 `tb.a @ 2 ns`。Load 从各位到达对应标量读取端。
  - [x] Verdi NPI 从实例专属的展开名称恢复循环 generate 端口的固定位选。真实 VCS VCD 中 `lane_value[-1]` 和 `lane_value[0]` 各自追到对应实例，MCP 静态图和时间图与独立 KDB 的四条样例路径一致。真实 VCS FSDB 的三条路径分别从 `output_bus[1]`、`[2]`、`[5]` 经各自实例回溯到 `input_bus[0] @ 5 ps`、`[3] @ 6 ps`、`[4] @ 7 ps`。
  - [x] Verdi NPI 对等宽输入端口的运行时位选和定宽范围选可从同一 KDB 补入独立读取器解析的表达式，并核对两端、连接位置、位宽和匹配唯一性。真实 VCS FSDB 中，MCP 从三条分支的 `shift` Load 保留各自的实际输入端口。`shifted_bus[0] @ 5 ps` 从 `input_bus[0]` 取样，`shifted_bus[2] @ 7 ps` 从 `input_bus[5]` 取样。两条路径都保留 `shift` 的索引边。`shift` 与数据同 tick 变化时，报告保留 `sameTickUnordered`。另在真实 VCS FSDB 的 5 ps 核对 `+:` 读取第 2、3 位，`-:` 读取第 1、2 位，两条时间路径均保留索引。无法核对的表达式保留追踪缺口。独立后端通过 132 项，Verdi NPI 通过 124 项。
  - [x] 独立 KDB 可追踪由单个信号提供索引的输入端口动态位选。Driver 图列出数据和索引，Load 图可从任一操作数到达目标端口。
  - [x] 独立 KDB 支持普通输入端口的动态 `+:` 和 `-:`。索引为单个信号，宽度为常量。升序和降序声明、负索引、部分越界、X/Z 在真实 VCS 波形验收中覆盖。Trace Explorer、MCP 静态图和时间因果图标明索引依赖。
  - [x] 独立 KDB 支持普通模块输入端口的嵌套拼接、按位 `&`、`|`、`^`、`~`，可组合信号、定宽四态字面量和 packed 选择。Driver / Load 图保留跨实例操作数，详细报告显示表达式，时间图以实际 FSDB 观测核对求值。
  - [x] Verdi NPI 从同一 KDB 补入普通输入端口的组合表达式。匹配核对目标端口、连接位置、两端位宽及可见操作数，只有选择索引可以由独立读取器补充。真实 VCS FSDB 的 MCP 在 5 ps 核对了九个输出和 Mermaid、Markdown，覆盖四态拼接、按位运算、运行时位选、重复拼接、符号扩展、截断及二态转换。零次重复的输入从依赖图移除。`mask` 的 Load 图验证了四个目标实例。定位和表达式恢复失败时保留追踪缺口。独立后端通过 132 项，Verdi NPI 通过 125 项。
  - [x] 独立 KDB 支持输入端口的常量次数重复拼接、加减表达式，以及由支持的表达式驱动的动态位选和定宽范围选。图标记各索引操作数，重复零次的项从依赖图移除。
  - [x] 独立 KDB 的循环 generate 端口按展开实例解析固定输入、输出位。复合输入表达式保留各次迭代的局部整数参数和实际运行时操作数。FSDB 转义的负下标实例可从波形名和 KDB 名双向绑定。
  - [x] 修改版 VIDE 回传命名循环 generate 和条件分支的源位置。与独立 KDB 核对后，块内连续赋值按迭代绑定局部信号和父作用域信号。Driver、Load 和时间图可区分共用源码的各实例。
  - [x] 命名循环 generate 内的 genvar 在赋值表达式中按各展开实例解析。Driver / Load 图记录确定的写入位和 RHS 选择表达式，MCP 单位时间查询按写入位筛选候选，详细报告记录迭代值。
  - [x] 从一维 packed 总线的单个位开始静态 Driver 查询。按确定的写入位筛选赋值，再通过固定选择、拼接和受支持的按位表达式向上游传播位索引。Trace Explorer、MCP 和 Mermaid 显示确定位索引。跨同一总线其他位的路径可继续展开，按位判断反馈环。
  - [x] Driver 和 Load 可从一维 packed 总线的固定位或固定范围追踪。MCP 返回读位、写位及可确定的逐位关系，Trace Explorer 在沿关系展开时使用对应位。动态索引的回归验证了可能相关的读取端和写入位被保留。
  - [ ] 扩展独立 KDB 的其余端口表达式及无名 generate 的赋值绑定。VCS T-2022.06-SP2 对测试的动态输出位选及范围选择报 `IPC-E`，动态输出仍需以能生成对应展开数据库的仿真器验证。
    - [x] 匿名条件 generate 子句从修改版 VIDE 获得源码范围。真实 VCS KDB 在两个实例上按生成作用域的唯一源码行选中不同分支，Verilator JSON 还使用列号区分同一行上的两个子句。前台与静默 MCP 的 Driver、Load、时间图和详细报告核对到实际路径。KDB 同行反例保留两个候选和明确缺口。 [复现步骤](test/fixtures/trace/README.md#parameterized-generate-branches)
    - [x] 用同次 VCS 仿真的 KDB、FSDB 和 VCD 核对匿名循环与嵌套条件。循环下标 −1、0、1 分别写入 `result_bus` 的第 0、1、2 位。独立 KDB 与 Verdi NPI 核对实际赋值上下文。VCD 将作用域写进变量名时按完整波形路径绑定并继续自动回溯。前台和静默 MCP 的六个分页时间图、源码引用、Mermaid 和报告逐项一致。 [复现步骤](test/fixtures/trace/README.md#vcs-anonymous-generate-loops)
- [x] 从波形信号菜单、层级视图和 RTL 选中位置提供适用的 Driver/Load 入口。用原生 VS Code 树实现懒展开、源码/赋值跳转、加入波形、复制路径和以当前节点继续追踪。
  - [x] 已接入原生 Trace Explorer、波形信号菜单、RTL 光标命令、源码跳转、加入波形及复制路径。
  - [x] Trace Explorer 的信号节点可作为新的根继续追踪。VS Code 扩展测试使用实际 FST 验证该入口。
  - [x] 层级视图的实例信号列表可直接启动 Driver 或 Load 查询。真实 VCD 的 Webview 回归核对两种命令及完整信号路径。
- [ ] 实现有界 Fan-in/Fan-out 和静态缓存。静态缓存包含工作区、VIDE revision、源码位置、实例、方向、选项和设计身份。查询切换、关闭或重启时取消请求并丢弃过期结果。
  - [x] Verilator 图的深度预算包含本地赋值和实例端口两种边。用两个构建的 FST 与 VCD 核对同一深度边界的停止位置。
- [ ] 在 `src/mcp.ts` 接入 `wave_trace_drivers` 和 `wave_trace_loads`。验证节点预算、空结果、歧义、部分图以及与 UI 对同一查询返回一致的证据。
  - [x] 波形信号菜单和 MCP 已连接同一个 VIDE API。MCP 可选 Mermaid 和 Markdown 详细报告，范围与预算前沿随结果返回。
- [x] 确认无 VIDE、能力不兼容及未配置设计映射时的 Trace 入口状态，通过波形、KDB、Tcl、MCP 与源码联动回归。

**验收**　在真实 VS Code 中选中 FST 信号，完成 Driver、Load、跨模块展开、源码跳转和加入波形。重复 CPU 实例及简单 TL-UL 连接拥有各自的正确路径。MCP 输出与 UI 共用查询和同一源码证据。

### 从单个信号生成图表和报告

- [x] MCP 提供 `followAllContinuations` 自动遍历，默认返回分页图。当前每次续查最多 64 段或 100 秒。分页包含未访问的前沿与失败诊断，达到预算后仍可使用游标续查。Linux VS Code 和静默后台使用同一 Verilator VCD 的 161 级链验证 Driver 在首批 64 段后仍有一个待查入口，第二批累计 80 段并抵达源输入。静默后台从源输入反向执行 Load 同样得到 161 条赋值。两端时间图在一次调用中完成 40 个续查，得到相同的 323 节点、322 条边。队列为空时仍明确保留 `missingObservations`。从只查一段的时间图续查，节点从 17 增至 323，根查询报告正文逐字保留。
  - [x] Linux VS Code 1.124.2 与静默 MCP 用同一 OpenTitan FSDB 从 `x28 @ 2051001 ps` 自动续查。首批 64 段分别用 46.5 秒和 45.4 秒，保留 5,172 个节点、12,462 条边、169 页 Mermaid 和 336 个待查入口。恢复八段后保留原节点身份、边和赋值位置，累计 5,598 个节点、13,324 条边、174 页 Mermaid 和 328 个待查入口。两端的完整报告及前沿逐字节一致，共用 `requestBudget` 和 `gapBudget` 覆盖状态。用隔离 VS Code 宿主的测试钩子加载首批 MCP 保存的图。Trace Explorer 的 36,614 条未接合缺口按 128 条分页，287 页逐项与 MCP 的对应缺口核对，并在实际侧栏展开首页。
  - [x] 时间图输出按原因和状态汇总已经保留的缺口。以相同 OpenTitan FSDB 的 `x28` 续查 64、8、8 段，从前台和静默 MCP 的分页数据逐项重算汇总。第 80 段后共 51,534 条缺口，其中 243 条已接合，1,479 条待查缺口共享 322 个入口。未解决项中 41,535 条未建立波形绑定，8,261 条在窗口内无可用变化，16 条历史截断。两端的详细报告与去重后的待查入口逐字节一致。仍有 `gapBudget`。
  - [x] 时间图中的 `unmapped` 缺口提供具体的 `bindingIssue`，详细报告、Mermaid、Trace Explorer 和原理图显示这一步失败的位置。用同一 OpenTitan FSDB 在前台和静默 MCP 续至 80 段，两端从缺口分页重算的结果均为 41,534 条未找到匹配波形、1 条多个同名波形对象。原生 FSDB 按实例路径查询确认 `a_data[31:0]` 对应 ID 841、867 和 891。回归覆盖 RTL 声明缺失、类型不支持、设计库查询无结果、设计对象没有源位置、声明行和文件不匹配。
  - [x] 对位宽已验证的 RTL 枚举字面量使用 VIDE 源码值。OpenTitan 的 `ALU_AND` 由 package 参数 `ALU_OP_WIDTH` 确认 7 位，字面量为 `0010101`。在前台、静默 MCP 从 `x28 @ 2051001 ps` 复查六段，两个可达的 `ALU_AND` 常量均定位到 `cv32e40p_pkg.sv` 第 94 行。报告逐字节一致，Mermaid 在 Chromium 渲染。已验证 49 个枚举常量节点，仍有 45 个上游待查入口。受影响的 VIDE Rust 套件通过 358 项、忽略 6 项。Node 通过 100 项、跳过 65 项。
  - [x] VIDE 在声明位宽内恢复负的有符号枚举字面量和隐式递增。用 VCS 同一次仿真的 FSDB、VCD 和 KDB 验证，Linux VS Code 1.146.0（隔离测试窗口）和静默 MCP 的 Driver 查询均从 `signed_q` 找到 `NEG_NEXT` 和 `ZERO`，Load 查询从 `gate` 找到 `q` 和 `signed_q`。5 ps 与 10 ps 的两种波形格式均核对到实际变化。四条常量路径为 `NEXT=1000`、`START=0001`、`ZERO=0000`、`NEG_NEXT=1111`。枚举声明位于 `enum_tb.sv` 第 5 或第 8 行。两端 FSDB 详细报告逐字节一致，Mermaid 以 Chromium 渲染。VIDE Rust 套件通过 359 项、忽略 6 项，Node 通过 100 项、跳过 65 项。初始化表达式和带下标范围的枚举项仍待支持。
  - [x] 另一组 VCS 仿真的 FSDB、VCD 和 KDB 核对枚举初始化表达式。无符号表达式由乘法、减法和位掩码求得 `BASE=7`，有符号表达式由加法和取负求得 `NEG_BASE=-2`。Linux VS Code 前台和静默 MCP 均通过 Driver、Load 和八次时间查询。5 ps 的 `q=1000` 追到 `NEXT`，10 ps 的 `signed_q=1111` 追到 `NEG_NEXT`，均保留枚举声明位置。两端 Driver 和时间详细报告逐字节一致，Chromium 渲染两种图。Rust 通过 359 项、忽略 6 项，Node 通过 100 项、跳过 65 项。混合位宽、依赖名称的表达式及带下标范围的枚举仍待支持。
  - [x] 通过 VIDE 的位置感知名称解析计算枚举值。VCS 样本中的 `START=WAITING+1` 使用导入的 `LOWER`，`BASE` 使用限定名称 `encodings::STRIDE`，有符号起始项使用 `encodings::NEGATIVE`。Linux VS Code 前台和静默 MCP 的 Driver 与 Load 结果一致，FSDB 和 VCD 的八个时间点查询核对到 `NEXT=1000`、`START=0010`、`ZERO=0000`、`NEG_NEXT=1111` 及声明位置。静态详细报告逐字节一致，时间报告仅 VIDE revision 不同。两种图均经 Chromium 渲染。Rust 通过 360 项、忽略 6 项，Node 通过 100 项、跳过 65 项。
  - [x] 枚举初始化支持混合位宽和可验证的符号扩展。前台和静默 MCP 用同一次 VCS 仿真的 FSDB、VCD 及 KDB 核对了 12 条已确认的时间路径。另在两种格式核对 `mixed_q @ 5 ps` 保留根波形值 2 和上游缺口。单独的 Verilator 5.054 仿真对相同的嵌套表达式给出 18。两端结构化核对结果一致，详细报告忽略 VIDE revision 后一致，Driver 和时间图均经 Chromium 渲染。Verilator 还独立核对可无损收窄的正负值，VCS T-2022.06-SP2 在相应声明上报告 `ENUMSIZE_MIS`。Rust 通过 360 项、忽略 6 项，Node 通过 100 项、跳过 65 项。
  - [x] 支持 `SLOT[2]`、`UP[3:4]` 与 `DOWN[7:6]` 形式的字面量枚举范围。VCS 仿真的 FSDB、VCD 与 KDB 验证前台和静默 MCP 的 Driver、Load 及 12 条时间查询。降序经 `DOWN7=16` 到 `DOWN6=17`，后续普通枚举项为 `NEXT=18`。生成项保持独立身份、共享声明位置，禁止单独重命名。两端详细报告忽略 VIDE revision 后一致，两种 Mermaid 图均在 Chromium 渲染。Rust 回归和新增重命名测试共通过 366 项，忽略 6 项。Node 通过 100 项、跳过 65 项。
  - [x] 对 VIDE 识别但无法求值的枚举项返回 `enumValueUnavailable`。用 VCS 的 FSDB 和 VCD 从 `mixed_q @ 5 ps` 复验，前台和静默 MCP 均保留根值 `00000010`，缺口定位到 `enum_tb.sv` 第 17 行，并计入相应原因的汇总。详细报告忽略 VIDE revision 后一致，Chromium 渲染包含缺口的时间图。Rust 通过 366 项、忽略 6 项，Node 通过 100 项、跳过 65 项。
- [x] 以带执行记录的两级 Verilator 流水线复核自动遍历。Linux VS Code 与静默后台的离线 FST 和在线 Trace 都将 tick 3 的提交 8 追到 tick 1 的提交 4，在线查询保持暂停在 tick 3。Chromium 渲染自动续查输出的四张静态、时间和在线图。实际 Linux VS Code 冒烟同时覆盖仲裁样本的 FST、VCD、源码跳转及详细报告分页。

- [ ] **Phase 3**　从信号、实例和可选位范围自动递归遍历所有可解析的上游关系，包含数据来源、控制条件、端口、时钟与复位。图中合并重复节点并标记环路。若达到资源预算、遇到未解析边或查询取消，返回已得到的图、停止原因以及可继续展开的节点。完整遍历只有在可达前沿耗尽且没有遗漏边时才标记为完成。
  - [x] Trace Explorer 在同一路径的重复信号处终止展开。MCP 的 `feedbackEdges` 返回闭合环路的信号和赋值，Mermaid 和 Markdown 对应标出反馈。共享依赖的无环图回归通过。
  - [x] MCP 的 `staticCoverage` 报告当前分析范围、停止原因、未解析赋值和编译缺口。达到预算后，带有实例路径的前沿可以作为下一次查询的根。
  - [x] 遇到端口声明与展开数据库不一致时，跨实例 Driver / Load 仅保留已匹配的连接，并将覆盖状态标为 `partial`。使用真实 Verilator FST 与展开树，在隔离的 Linux VS Code 中通过测试钩子偏移远端 VIDE 声明一行。MCP 和 Trace Explorer 均报告缺失的端口连接，界面提示分别跳到输出和输入连接的第 25、22 行。撤销偏移后，两种查询恢复原来的赋值。独立后端 126 项通过，Verdi NPI 115 项通过并跳过 11 项独立专用用例。
  - [x] 位级预算前沿返回可直接查询的 `continuationSignals`。Linux VS Code 与实际 VCS FSDB 核对 `result[2]` 经 `mid[2]`、`data[6]` 到达 `source_hi[2]`。五页拼接的赋值与一次查询相同，预算前沿的信号信息可以跨页读取。TreeDataProvider 回归验证 Trace Explorer 可以保留根位选择。独立后端通过 124 项，Verdi NPI 通过 113 项并跳过 11 项独立后端专用用例。
  - [x] 修改版 VIDE 提供固定字面量声明范围。用 VCS VCD 与 KDB 的 `tb.q[2:1]` 核对完整采集以及分别只采集 `middle[1]` 或 `middle[2]` 的副本。前台和静默 MCP 继续追踪可采集位，在同一信号上保留 `unavailableBits` 并返回 `partial`。VS Code 波形菜单、详细报告和 Mermaid 核对到具体缺失位。VIDE 回归覆盖升序、负下标和实例参数决定的范围。
  - [x] 对一维整型总线，用 VCS KDB 或 Verilator 展开树提供实例范围。`parameter_packed_tb.sv` 的两个实例共用 `middle` 声明，展开为 `[2:0]` 与 `[5:0]`。真实 VCS 和 Verilator 的完整及部分采集 VCD 验证前台、静默 MCP 的 Driver 与时间追踪。Verdi NPI 从同一 KDB 读取范围时还核对实例和源码位置。测试固定声明与实例展开的证据来源。
  - [x] Trace Explorer 的可续查前沿提供 **Continue from** 操作。Linux VS Code 的隔离验收通过树项命令从 `result[2]` 续查 `mid[2]`，并与 MCP 比对两次查询的直接赋值位置。源码跳转定位到相同行列。
  - [x] 静态续查使用核对过的波形层级和位下标。将真实 Verilator FST 转为 VCD，并给测试副本设置映射，将波形顶层 `dump_tb` 关联到 RTL 的 `port_slice_tb`。从 `dump_tb.dut.request[1]` 开始，MCP 和 Trace Explorer 均续查到 `dump_tb.tb_request[2]`。从另一份测试副本移除上游信号后，MCP 保留静态前沿并返回 `waveformUnavailable`。Trace Explorer 的树模型回归验证了对应提示。VS Code 测试钩子设置界面查询的深度预算。
  - [x] `expandReachable` 提高静态和时间图的默认遍历上限，保留显式静态预算。实测同一根信号的浅层结果报告深度前沿，完整静态查询抵达外部输入，动态查询回溯同一输入的变化。
  - [x] 静态 Driver / Load 的 `followContinuations` 跨过单段预算自动查询波形前沿。实测 Linux VS Code 1.124.2 的 Verilator 波形以深度 1 从 `dump_tb.dut_response[5]` 续查四段并到达 `tb_request`，保留其过程延迟缺口。Load 从 `tb_request[2]` 续查三段并到达 `dut_response`。预算为 1 时返回两条待查路径，深度为 0 时返回 `noProgress`，移除 TB 输入的波形副本返回 `waveformUnavailable`。独立测试验证共享入口、回边、取消及上下文变化。用隔离宿主的测试钩子将界面深度设为 1，界面报告附录与 MCP 逐字一致。Playwright 验证波形菜单命令，Chromium 渲染续查总览。
  - [x] 静态 Driver / Load 可通过 `wave_trace_resume` 跨批扩展同一张图。Linux VS Code 1.124.2 使用 Verilator 波形的层级映射测试副本，Driver 分两批完成 4 段，Load 完成 3 段。两张图分别包含 6 和 5 条赋值，均与一次查询逐项一致。更改隔离 filelist 后，旧游标失效。Trace Explorer 以隔离宿主的测试预算触发分批，从 `dump_tb.dut_response[5]` 的首批 1 段续查到 4 段，报告附录与 MCP 一致，可跳到 `result[1]` 对应的第 11 行。独立后端 129 项通过，Verdi NPI 118 项通过并跳过 11 项独立后端专用用例。
- [ ] **Phase 3**　从统一追踪结果生成静态依赖图。插件内可展开、定位源码和添加波形信号。MCP 可返回结构化图或导出 Mermaid，支持自动遍历、分页续查与可选 Markdown 详细报告。报告列出实例、位范围、各边的依赖类型、RTL 位置、遍历范围和缺口。
  - [x] 静态 Driver 和 Load 快照可按信号 ID 或声明路径提取最短路径及已有的全部分支。用真实 Verilator 仲裁器 FST 核对 `request` 与 `owner_q` 之间两种追踪方向，前台和静默 MCP 的图与报告一致。报告记录单条赋值的读写位范围，路径搜索在声明层级运行。
  - [x] 静态快照保留 RTL 数据位映射时，MCP 可按声明和位提取最短路径或全部已映射分支。真实 VCS FSDB 核对 `lanes[0]` 到升序总线 `ascending_bus[1]` 的三条赋值和另一条无关位。Driver 和 Load 的前台与静默结果一致。缺少映射的赋值保留为覆盖限制。
  - [x] 已展开的等宽直连端口可为静态位路径补充连接证据，图和报告标出 RTL 连接位置。真实 VCS 和 Verilator 分别核对父模块输入位经端口到达子模块输出，以及子模块输出经过端口到达父模块的 Load 路径。
  - [x] 位路径保留已核验端口声明的展开范围，使用匹配的转换位宽确定截断、符号扩展和零扩展依赖。真实 VCS FSDB/KDB 的 Driver 和 Load 共九次查询在前台、静默 MCP 一致，包含位级三跳跨模块路径及整总线快照中的端口位边。详细报告保留 RTL 连接位置和两态转换，Chromium 渲染五张图。符号性未知的扩展位和缺少位映射的 RTL 赋值仍计入证据缺口。
  - [x] 使用整总线查询保存跨续查段的 RTL 表达式，以已知位宽和位序推导普通赋值的位映射。真实 VCS FSDB/KDB 的整总线 Driver 从 `whole_signed_input` 追到 `whole_signed[1]`，保留 9 条位边，分别通往输出的位 1、2、3。从整总线 `whole_signed` 查询 Load，到 `whole_signed_input[3]` 的路径共 3 条赋值。两个结果均包含中间连续赋值。前台与静默 MCP 的 10 个结果逐项一致，Chromium 渲染上述两图。
  - [x] 静态位路径和时间证据按赋值宽度追踪固定移位和常量三元表达式。真实 VCS VCD/KDB 复验窄输入向宽目标左移、算术右移的符号填充，以及带 `1x` 常量条件的分支选择。两种 MCP 的三份静态图和三份时间图在结构化证据及 Markdown 报告上一致。运行时移位量继续保留信号级候选。
  - [x] 静态 Driver、Load 和时间图可通过 MCP 在同一快照按前沿编号续查。隔离的 Linux VS Code 1.124.2 在真实 Verilator VCD 上重启，分别从静态 Driver 和 Load 视图选取待查分支，两版合并图的信号、赋值和缺口均与前台 MCP 一致。真实仲裁器 FST 验证静默 MCP 可先查队尾的 `accept`，保留前三个入口及原顺序。
  - [x] 大规模静态 Driver / Load 图、时间因果图、波形观测图和执行图可按 Mermaid 渲染能力分成多页。页间复用相同编号的节点，图表分页保留全部边，静态赋值数据仍可用 `pageCursor` 分页。
  - [x] MCP 静态 Driver / Load 查询可分页返回赋值及其信号、Mermaid 和详细报告。实际 VS Code 在独立 VIDE 会话之间取回全部 7 条关系，拼接后与一次查询一致。原图变化后旧页游标失效。
  - [x] `staticContinuationGraph` 将根查询和静态续查合成一张图，保留各赋值的原始查询、源码位置和位选择。Linux VS Code 1.124.2 的 Verilator 端口切片用例得到 Driver 图 5 个信号和 6 条赋值，Load 图 7 个信号和 5 条赋值。两张图保留未解析项，所有赋值逐项核对原始查询。Chromium 渲染两张合并图。使用隔离宿主的测试钩子限制界面查询深度后，VS Code 与 MCP 输出相同的报告附录。回归覆盖跨段反馈及不同位造成的伪环路。独立后端 128 项通过，Verdi NPI 117 项通过并跳过 11 项独立后端专用用例。
  - [x] MCP Driver / Load 支持 `output: "graph"`、合并图分页和完整 Markdown 报告。Linux VS Code 的 261 路 VCS 扇入样例从 `q` 得到 264 个信号和 528 条赋值，分 5 页取回原编号、源码位置及赋值来源，与单次响应逐项一致。Chromium 渲染首页，并用 `input_data` 验证 Load 独立查询的分页。独立后端 129 项通过，Verdi NPI 118 项通过并跳过 11 项独立后端专用用例。
  - [x] Trace Explorer 可展开合并静态图并添加位投影。Linux VS Code 1.124.2 使用真实 Verilator 波形的层级映射测试副本，从 `dump_tb.dut_response[5]` 展开到 `result[1]` 和续查段的第 11 行赋值，点击信号行的 **+** 添加 `result[1]`。测试钩子将界面查询深度设为 1，报告附录与 MCP 一致。回归覆盖剩余前沿续查和旧节点操作失效。
- [ ] **Phase 4–6**　输入波形信号和时间点生成时间因果图，包含跨周期数据来源、控制条件、相关触发、候选驱动和保持原因。报告按需附上波形值、仿真时间、源码与构建身份、证据来源和确定性。执行记录回放与在线会话可附上关联的事件及求值、提交顺序。
  - [x] 时间图检测已保留关系中的反馈闭环。直接查询、自动续查和局部路径图共用检测逻辑。真实 VCS VCD/KDB 从 `time_feedback_tb.q @ 3 ns` 自动续查七段，前台与静默 MCP 分页结果在归一化 VIDE revision 后一致。`feedbackEdges`、Mermaid 和详细报告均标注启动和 3 ns 的闭环。待查队列为空时仍保留未 dump 的 `hidden` 所产生的部分覆盖。 [复现步骤](test/fixtures/trace/README.md#feedback-and-missing-samples-in-a-time-trace)
  - [x] 从续查合并的时间图逐层提取局部因果路径。真实 Verilator VCD 从 `TOP.chain_tb.q @ 5 ns` 分批续查 80 段到达 `stimulus`。前台与静默 MCP 均返回 161 跳，再用局部图游标选取 `s120 @ 5 ns` 得到 40 跳。两张局部图各保留 40 和 10 条续查接回记录，重新选取后稳定保留原图节点号及每条因果边的 RTL 位置。前台与静默 MCP 的图、分页和 Markdown 逐项一致，Chromium 渲染两张图。
  - [x] 分支或过程时序存在未解析项时，静态 Driver / Load 和时间图保留可解析的 RHS 位依赖。报告继续标明控制缺口，波形推断保留候选置信度。相同构建的执行记录可独立确认具体写入。
- [ ] **验收**　对同一根信号调用 UI 和 MCP，逐边核对静态与动态图的输入、路径和证据。双 Ibex 仲裁样本应覆盖两个 hart 输入及真正导致指定周期更新的路径。用含环路、多个等值候选、未 dump 和大规模扇入的样本验证停止状态、续查和详细报告。
  - [x] Linux VS Code 1.124.2 的 Trace Explorer 与 MCP 查询同一 RV32A FSDB 的 `hart_q @ 280000 ps`。两端的两个直接写入位置一致，界面跳转到构建快照中的赋值行。时间图的 103 个节点、168 条边、247 个边到赋值的链接及 299 项缺口逐项匹配。波形记录两路请求在 `270000 ps` 同时有效，`ready=10`，`capture_atomic=1`，`hart_q` 于 `275000 ps` 变为 1。FSDB 时间图保留 `selected_hart` 数据边及 `capture_atomic` 控制边为可能的依赖，槽内先后仍属证据缺口。Chromium 渲染三页静态图及两页时间图。此项验证使用隔离的 VS Code 扩展宿主与 Trace Explorer 测试钩子。
  - [x] 以 Linux VS Code 的波形菜单和前台 MCP 对同一 RV32A FSDB 的 `hart_q[0:0] @ 280000 ps` 自动续查。MCP 的分段时间图使用完整波形路径，与界面保留相同的总线后缀。静态和时间报告分别逐字节一致，静态图含 213 个信号、774 条赋值，时间图含 4,547 个节点、11,910 条边和 8,929 个缺口。首批查 64 段，仍有 520 个待查入口。Chromium 渲染两图首页。
  - [x] 修复 Trace Explorer 时间续查仅更新内存的问题。实际 VCS FSDB 的 `wide_causal_tb.q @ 5 ps` 在隔离宿主将每批设为两段后，使用续查命令使工作区保存的合并图从 261 增至 265 个节点。节点、267 条边、1,028 个缺口逐项匹配相同预算的 MCP 游标恢复。测试钩子用于读工作区状态和取得 Trace Explorer 命令参数。Node 通过 100 项、跳过 65 项。
  - [x] 追踪查询和批次续查等待工作区状态写入后完成。Linux VS Code 1.124.2 运行真实 VCS FSDB，在隔离宿主将首批设为两段，首批查询结束后立即关闭窗口。重新启动后图数据逐项一致，包含 261 个节点、261 条边和 1,026 个缺口。从恢复的缺口追查 `wide_causal_tb.d_257 @ 2` 并打开报告。回归覆盖离线执行记录路径、tick 和变化序号。Node 通过 101 项，跳过 65 项。
  - [x] 在工作区状态保存离线批量续查的已查段、待查入口及报告。重启后先核对波形、编译输入、设计数据库和执行记录的文件指纹，再用当前配置核对根查询。Linux VS Code 1.124.2 中，隔离宿主每批查询两段，重启后从第 3 段继续。Verilator VCD 的 Driver 与 Load 图均从 96 增至 160 条赋值，VCS FSDB 时间图从 261 增至 265 个节点。静态图的信号、赋值和缺口，以及时间图的节点、边和缺口均逐项匹配前台 MCP 的同预算分页结果。修改隔离 VCD 后拒绝旧的批次并保留历史图。Node 通过 102 项，跳过 65 项，含执行记录变更回归。
  - [x] MCP 支持 `output: "temporal"`，保留时间图、原 ID 对应的赋值源码位置和结构化续查入口。实际 OpenTitan MAC FSDB 的 `x28` 查询含 2,881 个静态信号及 4,888 条赋值，默认响应正文为 35,160,117 字节。精简输出含 Mermaid 为 54,516 字节，24 个时间节点和 26 条边逐项相同。用预算前沿直接续查 `regfile_alu_wdata_fw_o[31:0] @ 2051000 ps`，到达乘法相关信号并返回 768 个节点和 1,546 条边。Chromium 渲染起始图和续查图首页。
  - [x] 在线精简输出也保留会话标识、槽末采样和写入的赋值位置。实测 Verilator 流水线按同一会话的前沿续查 tick 1，在相同时间图中定位实际提交 4。
  - [x] `followContinuations` 可在一条 MCP 请求内自动跟进多个时间图前沿，合并重复查询并保留来源缺口、失败原因及尚待查询的入口。实际 OpenTitan MAC FSDB 的 `x28` 查询自动续查写回总线的 `2051000 ps` 与 `2037000 ps` 两次变化，各得到 24 个节点和 23 条边。返回 35 条前沿链接与 16 个剩余续查请求。Verilator 在线回查在同一会话中定位 tick 1 的提交 4，仿真保持在 tick 3。独立后端 125 项通过，Verdi NPI 114 项通过并跳过 11 项独立专用用例。
  - [x] 自动续查报告新增总览和文档内跳转。实际 OpenTitan MAC MCP 查询的同一份 Markdown 包含根图、两段已查时间图、赋值源码位置和 16 个待查入口。Chromium 渲染总览，19 个节点和 21 条汇总链接对应结构化续查结果。在线 Verilator 报告也在同一附录内关联 tick 1 的提交 4。独立后端 125 项通过，Verdi NPI 114 项通过并跳过 11 项独立专用用例。
  - [x] 离线与在线的自动续查返回合并的时间因果图。接点核对时间单位、采样方式、tick、位选择、变化序号及已知值。OpenTitan MAC 的 `x28` 图包含 62 个时间节点和 72 条原有证据边，接上两处续查，保留 33 个待查缺口。Verilator 在线流水线由 tick 3 的输出连到 tick 1 的提交 4，仿真保持在 tick 3。逐边核对两张图的原始查询及源码位置，并用 Chromium 渲染。Linux VS Code 波形菜单的合并图附录与 MCP 一致，包含 265 个时间节点、267 条原有证据边和 4 处续查接点。独立后端 129 项通过，Verdi NPI 118 项通过并跳过 11 项独立后端专用用例。
  - [x] 时间因果续查可在有观测变化的静态预算前沿切换查询根。Linux VS Code 1.124.2 对真实 OpenTitan MAC FSDB 的 `x28=480 @ 2051000 ps` 使用单段深度 5 和 8 次续查预算，合并图从 61 个节点扩至 518 个根可达节点。14 个接点包含已查段之间共享的变化，实际接到 `alu_operand_a_ex_o` 和 `decoder_i.deassert_we_i` 的上游证据。剩余 107 项静态前沿仍为待查。Chromium 渲染 14 页 Mermaid 的首页及含续查节点的页面。Verilator 在线流水线在静态深度 1 时接回 tick 1 的提交 4，保留当前暂停位置 tick 3。独立后端 129 项通过，Verdi NPI 118 项通过并跳过 11 项独立后端专用用例。
  - [x] 合并图在所有可对应的静态预算接点均已核对时清除 `staticTraversalBudget`，保留未覆盖的位、未解析静态关系及波形观测缺口。Linux VS Code 1.124.2 用真实 Verilator VCD 和 FST 验证三段寄存器链。单段深度设为 1，续查一次时保留预算缺口，续查两段后从 `q @ 13 ns` 到达 `seed @ 2 ns`，两种格式均得到 7 个节点、6 条边和 `resolvedWithinWindow`。FST 界面验收在隔离宿主将深度设为 1，波形菜单的报告附录与 MCP 一致，合并图无剩余缺口条目。组合逻辑样例接齐静态前沿后继续标记槽前变化缺口。独立后端 129 项通过，Verdi NPI 118 项通过并跳过 11 项独立后端专用用例。
  - [x] `wave_trace_resume` 用游标跨 MCP 请求累积同一根信号的时间图。Linux VS Code 1.124.2 中，真实 OpenTitan MAC FSDB 的 `x28` 查询分三批完成 2、6、10 段，节点依次从 390 增至 489 和 629。逐项核对已查段、旧边及节点编号，最后一批返回含根查询和全部续查段的 Markdown。Verilator VCD、FST 的两批合并图与一次查询逐项相同，并验证源码改动使游标失效。在线流水线验证两批结果保留提交 4，查询期间仍暂停在 tick 3，重启后旧游标失效。Linux IPC 冒烟验证同一工作区内按游标路由到原扩展宿主。独立后端 129 项通过，Verdi NPI 118 项通过并跳过 11 项独立后端专用用例。
  - [x] Trace Explorer 的 **Continue next batch** 在同一时间因果图上续查并更新报告。Linux VS Code 1.124.2 用 261 路扇入 VCS FSDB 从 `q` 累积 4、8 段。更新报告保留了第一批的根查询正文，最终显示 MCP 对应的 270 个节点及 8 个续查段，待查队列为空后操作入口收起。以隔离宿主的测试预算触发在线续查，核对 Verilator 流水线提交 4，续查时仿真仍暂停在 tick 3，启动新会话后清除旧图及入口。回归验证图更新后旧续查命令失效。独立后端 129 项通过，Verdi NPI 118 项通过并跳过 11 项独立后端专用用例。
  - [x] VS Code 波形菜单与在线命令可以生成自动续查报告，每次最多跟进四个请求。在真实 Linux VS Code 1.124.2 点击 261 路 VCS 扇入样例的波形菜单，256 个时间节点达到预算后，自动续查 `d_255` 至 `d_258` 在 tick 2 的变化。界面报告的附录与相同条件的 MCP 报告逐字一致，保留四个待查入口。Verilator 流水线的在线命令核对 tick 3 的提交 8 与同一时刻的 MCP 报告。
  - [x] Trace Explorer 可展开合并时间图、定位原始赋值和跳到上游采样。Linux VS Code 1.124.2 的实际波形菜单和侧栏从 `wide_causal_tb.q` 展开到 `d_255`，将 A 游标跳到 tick 2，并打开 MCP 标记的第 265 行。在线 Verilator 侧栏由提交 8 展开到提交 4，点击后仿真仍处于 tick 3。启动新在线会话会清除上一会话的合并图。独立回归覆盖跨段环路停止和旧节点命令失效。独立后端 129 项通过，Verdi NPI 118 项通过并跳过 11 项独立后端专用用例。
  - [x] 在隔离的 Linux VS Code 宿主中将界面检查的单段静态深度设为 1。通过内置在线命令打开 Verilator 流水线报告，侧栏从 `second_q` 的提交 8 展开到 `first_q` 的静态续查接点，点击标为同一次变化的提交 4 时，仿真仍暂停在 tick 3。

## Phase 4　离线注解与动态因果

- [x] 用已有 `BackendProtocol.query` 批量读取窗口和初值，提供点值、位投影、历史事件和时钟边沿。覆盖 FST、VCD 和现有 FSDB 路径，对调度精度不足和历史截断给出诊断。
- [x] 接入编译清单与源码校验。A 游标变更只刷新相关值或因果视图，复用静态图。快速拖动、切换会话和重新加载波形时取消或丢弃过期响应。
  - [x] MCP 的 `buildManifest` 核对波形 SHA-256、源码和头文件内容、未保存编辑，以及 VIDE 实际使用的有序源码、宏、include 路径和顶层，返回 `matched`、`mismatched` 或 `unverified`。发现明确差异时保留观测，抑制源码归因。
  - [x] Trace Explorer 在 A 游标移动时复用静态图和信号绑定，合并快速游标更新，替换查询或更换波形后丢弃旧的波形结果。
- [x] 实现类型化四态表达式求值，覆盖逻辑与按位运算、比较、三目、常量、位选、简单拼接和基础算术，处理位宽与符号。未支持的表达式返回 unknown/unsupported。
  - [x] 修改版 VIDE 为整信号赋值及 `if` 守卫提供结构化表达式。离线求值支持四态常量、固定 packed 位选和切片、拼接、按位与逻辑运算、相等和全等比较、三目及等位宽加减。可从波形确定 packed 范围时保留索引方向。遇到混合位宽、未知有符号扩展或同 tick 操作数变动等无法验证的情形时保留候选。
  - [x] 基础加减、比较、位运算和三目支持目标类型决定的位宽及可验证的有符号扩展。VIDE 为基础整数和 packed vector 声明返回有符号属性。普通 `case` 标签的宽度或扩展规则不明时保留候选。
  - [x] 乘、除、取余、逻辑移位和算术右移已接入。真实 Verilator FST 与 MCP 核对了六个运算结果，回归涵盖除零、未知移位量和超出位宽的移位。
  - [x] 内建整型和有符号、无符号转换保留运算宽度与符号。真实 Verilator 样本核对了 `int'`、`integer'`、`byte'`、`signed'` 和 `unsigned'` 参与的求值。
  - [x] `case`、`casez`、`casex` 支持多个标签、首个匹配分支和 `default` 的排除条件。按波形验证时，求值不明的标签继续保留可能的路径。模式分支待建模。
  - [x] packed 变量位选使用波形范围和实时索引值，关系比较使用声明中的有符号属性。实际 FST 和 MCP 测试核对了 `request[requester_id]`、有符号关系守卫和 `casez` 的通配标签。
  - [x] 对可求值的变量位选和定宽 `+:`、`-:`，离线时间图在索引稳定时追到实际读取的数据位并保留索引来源。覆盖负索引、部分越界、参与运算的稳定数据位和索引同 tick 变化时的总线级候选。
  - [x] 固定 packed 写入范围随静态赋值返回。动态报告按该范围比较 RHS 与波形，并标注哪些范围变化。真实 FST 与 MCP 验证了同一寄存器上的 `q[3:2]` 和 `q[1:0]` 两条 NBA。
  - [x] 查询单个位时，按已知的固定写入范围筛选动态候选。真实 FST 与 MCP 验证了 `q[2]` 的观测和预期值。复用总线样本追踪同一总线的其他位，按各选定位自身的变化定位时间节点。总线历史缺失或截断时保留原因。
  - [x] 从读取固定位的标量输出发起 MCP 查询，静态 Driver 和时间图都沿实际读取的位回溯。Linux VS Code 1.124.2 与真实 VCS VCD 验证 `bank_value[1]` 和 `lane_value[-1]` 各自连到被参数覆盖的实例和 `tb.b @ 5 ns`，相邻两路各自连到兄弟实例和 `tb.a @ 2 ns`。独立 KDB 和 Verdi NPI 均核对了四路展开及 Mermaid 和 Markdown。Node 回归覆盖负下标和缺少范围时的信号级路径。
  - [x] 对单维 packed 向量的变量写入索引保留静态依赖，按波形计算目标位并比较对应 RHS。索引没有可验证的值时保留候选。真实 FST 在 tick 5 和 tick 9 验证同一条 `q[index]` 分别写入 bit 2 和 bit 1，其索引来源进入时间图。
- [ ] 构建有界时间图。组合依赖在相关时间槽内搜索，顺序依赖按时钟或异步复位回退并区分前值、求值和提交。支持赋值覆盖、无写入时保持、同值写入候选及跨多周期递归。
  - [x] VIDE 在 ANSI 输出网线声明具有可核对的 `wire`、`tri` 或 `uwire` 类型时，为无延迟、无强度说明的连续赋值提供同槽值核对标记。真实 Verilator VCD 从 `q @ 5 ns` 续查至 `stimulus`，排除与根变化不符的初始值分支及其 160 条初始求值顺序缺口。MCP 两种宿主均得到 162 个节点、161 条候选边和 40 条续查接回记录，覆盖为 `resolvedWithinWindow`。VCS VCD/KDB 的反例保留 `#2` 延迟来源、强度赋值的前值候选和双驱动证据。Rust 回归还覆盖输出变量、`wand` 及延迟网线声明。
  - [x] 波形时间图可按稳定的运行时移位量追踪数据位，并继续追踪移位量来源。真实 VCS VCD/KDB 的 `q[5] @ 6 ns` 回溯至 `data[4] @ 6 ns` 和 `amount=2 @ 2 ns`。同槽移位量在多个值之间变化时保留总线候选和 `sameTickUnordered`。前台与静默 MCP 的 6、9、12、15 ns 图及分页一致，报告仅 VIDE revision 数字不同。
  - [x] 单一无延迟连续驱动可从与输出相符的同槽采样组合推断一致的移位量。用相同 VCS VCD/KDB 样本核对 12 ns 缩小到 `data[4]`，9 ns 保留总线和两个移位量，15 ns 保留 X 变化。前台和静默 MCP 的边及报告在归一化本地 VIDE revision 后一致。推断的位边仍保留 `sameTickUnordered`。
  - [x] 三元表达式按稳定条件或一致的同槽采样结果追踪所选数据位，将条件依赖标为 `condition`。真实 VCS VCD/KDB 样本核对升序输入真分支、同槽选择假分支、条件发生 X 变化的总线级候选，以及稳定 X 条件下的两路逐位合并。两种 MCP 的四组图与分页一致，报告仅含本地 VIDE revision 差异。
  - [x] 四态同槽比较使用波形中实际的 X/Z 样本。真实 VCS VCD/KDB 的 `q[2] @ 8 ns` 由不定条件合并两路相反的数据位，图保留 `a[1]`、`b[2]` 及条件的三条候选因果边。Node 回归覆盖条件变为 X 和 Z。两种 MCP 的四组结果按本地 VIDE revision 归一化后一致。
  - [x] VCS 移位和三元选择的 NBA 使用 KDB 自动映射和插桩生成捕获实际操作数。真实回放在 tick 3 从 `q[5]`、`r[3]` 分别查到已记录的移位量、条件和共同的数据位 `a[4]`。前台与静默 MCP 的位路径、执行证据和报告一致，移除操作数记录后保留信号级候选。原始与插桩 VCD 的设计信号观测一致。
  - [x] 将 tick 0 的首个波形值作为初始采样，保留声明初始化的候选赋值与源码位置。真实 VCS VCD 和 Linux VS Code 1.124.2 从 `result @ 0` 回到 `q` 的声明，从 `result @ 4 ns` 回到 `seed @ 0`，并给仅有首个时钟采样的 `gated` 标注触发边沿待证。前台与静默 MCP 的三张时间图和 Mermaid 逐项一致，分页保留初始化赋值位置，Chromium 渲染三个图。回归覆盖同槽变化序号和非零时刻首次采集。
  - [x] 修改版 VIDE 标记仅在仿真开始时执行的声明初始化。真实 VCS VCD 中 `state @ 0` 保留 `seed` 和声明位置，`state @ 6 ns` 只连接到运行时赋值的 `runtime_value`，报告列出初始化被排除的原因。4 ns 与 8 ns 两次进入过程时，自动局部变量的初始化仍保留在静态链中，波形未采集该变量。前台与静默 MCP 的四张时间图和 Mermaid 一致，两张 `state` 图已在 Chromium 渲染。VIDE 回归覆盖模块、generate、显式 static、automatic 和循环初始化。
  - [x] 游标值与上一采样相同时，使用游标时刻的触发、守卫和 RHS 证据判断已列写入路径是否可排除，或是否存在同值写入候选。执行记录可同时核对实际提交或保持。
  - [x] Linux VS Code 1.124.2 与真实 VCS VCD 核对了根信号的同值提交。查询 `left_q @ 5 ns` 时，纯波形时间图以 1 ns 的可见变化为根。回放和在线 MCP 均匹配到 3 ns 的提交 14，自动历史窗口随提交时间重新取样。Mermaid 和详细报告标记为已记录的同值写入，显式 `changeOrder` 仍能选择 1 ns 的波形变化。
  - [x] 有可核对触发和守卫的非阻塞赋值可比较同 tick 的多个 RHS 样本组合。MCP、Mermaid 和详细报告标出波形匹配结果，保留调度候选。两级流水线复现跨时钟周期的数据来源。
  - [x] 修改版 VIDE 标记可核实无延迟的普通 net 声明赋值及连续赋值。时间图对单一驱动、完整静态覆盖和可求值的二态样本枚举同槽 RHS 组合，只在找到兼容样本时收窄候选，并保留同槽顺序未知。实际 VCS VCD 在 4 ns 验证直连与反相均只保留 `q=0`，net 声明延迟、显式赋值延迟及多驱动各保留两种候选。Linux VS Code 与静默 MCP 的五张时间图和 Mermaid 一致，Chromium 渲染五图。VIDE 回归覆盖声明赋值、显式赋值和两种延迟位置。
  - [x] 使用与波形一致的完整 VPI 回调重放无延时单驱动连续赋值的 RHS。起始 RHS 必须与前一个输出值一致，到达目标值的回调必须唯一且 RHS 保持到输出回调。前台和静默 MCP 在实际 VCS 样本中将 `a[1]` 回调 0 和 `q` 回调 1 关联到同一条边，分页查询、按位路径、Mermaid 和 Markdown 使用该证据。Trace Explorer 在边详情显示两个序号。覆盖缺失或 RHS 多次到达目标值时保留候选。 [复现步骤](test/fixtures/trace/README.md#vcs-late-callbacks-on-an-undelayed-assignment)
- [ ] 为竞争、等值候选、同 tick 多次更新、X/Z、未 dump、时基差异和源码不一致保留候选及诊断。将缺少精度的节点和边作为结构化证据返回。
  - [x] 普通 `case`、`casez` 与 `casex` 共用整条语句的比较位宽和符号属性。真实 VCS 样本验证未采样的后置固定宽度标签仅提供类型，轮到读取该标签时报告 `waveformMissing`。同一 X 样本在三种 case 中分别核对精确 X 匹配、默认分支和首个通配匹配。前台和静默 MCP 的静态图、八张时间图及报告一致。 [复现步骤](test/fixtures/trace/README.md#procedural-case-comparison-type)
  - [x] 修改版 VIDE 输出过程 `case inside` 的范围、标签和源码位置，时间图用整条 case 的公共类型和先匹配规则判断候选写入。真实 VCS VCD/KDB 样本的七次查询核对闭区间、重叠标签、标签通配位、选择值中的 X/Z、default 和后置无符号标签。前台与静默 MCP 的静态 Driver/Load、时间分页、Mermaid 和报告一致。 [复现步骤](test/fixtures/trace/README.md#procedural-case-inside)
  - [x] 在时间图中分别使用 RTL 声明范围计算位依赖、用波形范围核对采样。实际 VCS VCD 查询 `tb.scalar @ 2 ps` 时，前台与静默 MCP 的完整图保留两条位路径。单个位采集仍能续查已采集位，另一位保留 `waveformBitsUnavailable`，VS Code 报告和 Mermaid 显示同一缺位。回归覆盖固定和动态位选，并区分声明范围内缺样与越界 `X`。
  - [x] 过程 `#delay` 和 `wait` 保留控制输入。静态前沿、Trace Explorer 和详细报告标出无法仅用当前波形重建的过程调度，MCP 返回对应源码范围。
  - [x] `temporalTrace.gaps` 保留未采集信号、截断历史、无法核实的触发边沿及节点或边预算，并关联具体赋值和时间节点。Mermaid、Markdown 和 Trace Explorer 显示同一缺口。预算前沿包含上游信号、位下标及 tick，可从 UI 或 MCP 继续追踪。
  - [x] 离线波形的时间图前沿返回可用于 `wave_trace_context` 的 `continuation`，Trace Explorer 提供同址续查并保留赋值源码入口。隔离 Linux VS Code 与真实 VCS FSDB 在单节点预算下核对从 `result[2]` 续查 `mid[2] @ 5 ps`，再到 `source_hi[2]` 的同一时刻变化。
  - [x] 同槽预算前沿保留 `changeOrder`，MCP 可按该序号选择根变化。Linux VS Code 的 VCD 和 FST 用例从 5 ps 的预算前沿续查第 2 次变化，核对变化值为 0、槽末游标采样为 1，且第 4 次变化不可用。隔离的 Trace Explorer 操作在 FST 中打开相同的第 2 次变化。
  - [x] 单节点预算下保留同槽其余根变化各自的续查入口，成功匹配后恢复到合并图根节点。Linux VS Code 1.124.2 从 VCD 和 FST 的 5 ps 补回第 2 次与第 1 次变化，两种格式均得到 3 个根节点和 8 个已匹配接点。预算缺口保留原始候选置信度、依赖角色和同槽顺序。Verilator 在线流水线保留上游数据的观测一致状态和提交位置。实测 VCS 波形侧栏仍跳到上游 tick 2，Markdown 附录与 MCP 一致。Chromium 渲染 VCD、FST 合并图。独立后端 129 项通过，Verdi NPI 118 项通过并跳过 11 项独立专用用例。
  - [x] 数据或控制输入在目标变化的同一 tick 也变化时，时间图保留同 tick 和更早的可观察来源，将同 tick 的边标为调度顺序未知。
  - [x] FST 和 VCD 验证了恰在查询起点的变化可保留前值。后端返回同 tick 的多个目标样本时，报告标识该时间槽并保留候选，跳过无法定位到具体写入的 RHS 比较。
  - [x] VCD 和 FST 的追踪查询保留同一信号在一个 tick 内的全部记录变化。MCP、时间图和 Trace Explorer 显示同信号的变化序号，每个根变化可回溯到同 tick 的多个数据样本、进入该 tick 前的值及匹配的触发边沿。跨信号顺序保留为未知。
  - [x] 自动回溯单个位时按该位最近一次变化选择历史窗口。VCD 验证跳过其他位的变化与密集总线事件下的局部重读。
  - [x] 位历史从 tick 0 起可连续核实时，稳定的总线位可回溯至初始波形采样。OpenTitan MAC FSDB 的 `x28 @ 2051001 ps` 首批 64 段中，19 次位级查询将 57 条缺口接回 tick 0。Mermaid 边与 Trace Explorer 区分初始采样和前序变化。VCD、FST 读取结果一致，晚开始采集的反例保留缺口。
  - [x] 将可核实的 package 参数作为 RTL 操作数参与数据和守卫核对。真实 OpenTitan MAC FSDB 的 `x28 @ 2051001 ps` 首批 64 段保留 120 个参数节点及声明位置，前台和静默 MCP 的完整分页、Mermaid 与 Markdown 一致。无法求值的 package 参数给出专门诊断，可被实例覆盖的模块参数沿用展开数据。
  - [x] 修改版 VIDE 识别实例参数声明，Wave Workbench 用独立 KDB 核对实例和声明位置后读取实际展开值。OpenTitan MAC FSDB 的同一查询消除 43 条参数绑定缺口，保留 7 个已使用的参数节点。前台和静默 MCP 逐项对照完整结果。
  - [x] Verdi NPI 桥接读取实例展开后的整型和位向量参数。真实 OpenTitan MAC KDB 中五个值及声明位置与独立后端相同。VCS 测试工程覆盖同声明的两个实例、符号、68 位和四态参数。用 Verdi NPI 与 SDK FSDB Reader 对 `x28 @ 2051001 ps` 续查 64 段，前台和静默 MCP 的分页、图及报告一致，Chromium 渲染 `P_WMACC` 的证据图页。
  - [x] Verdi SDK 波形窗口保留窗口前的真实采样时刻。同一 OpenTitan MAC FSDB 查询补回复位变化和稳定信号初始采样，首批 64 段与独立读取器的分页、Mermaid 和报告一致。回归使用 VCS 的 `selective.fsdb` 核对窄窗口、相同边界和跨变化窗口。
  - [x] 自动续查及恢复批次按信号、时间、变化序号、会话和实际生效的历史起点识别同一次查询。OpenTitan MAC FSDB 的 `x28 @ 2051001 ps` 由前台与静默 MCP 各查询 64 段并续查 8 段，图、57 页 Mermaid 和详细报告逐项一致。72 段接回 681 条缺口，并报告 423 个待查入口和 `requestBudget`。
  - [x] 通过图游标按需读取同一快照的 Mermaid 和 Markdown。用 OpenTitan MAC FSDB 验证原查询和恢复批次的图表及报告分别等同于预先生成的结果。Verilator FST 复验已结束的静态 Driver 和离线时间查询。
  - [x] 静默 MCP 连续十批查询同一 OpenTitan MAC FSDB 的 `x28 @ 2051001 ps`，走到 640 段，累计接回 9,138 处缺口。仍有 728 个待查入口，另有两条 RTL 声明定位失败，均指向不在当前构建清单内的生成 testbench。
  - [x] 用 VCS 实际编译的生成 testbench 重建 OpenTitan MAC 样本清单，首轮及两批恢复共 192 段，确认两条时钟与复位查询恢复。运行记录脚本接收 `--vcs-kdb` 并保留实际编译根。用同一 VCS 可执行文件生成新 FSDB，隔离的 Linux VS Code 前台和静默 MCP 验证静态 Driver、Load、时钟和复位时间图、Mermaid 及 Markdown。四张图已在 Chromium 渲染。
  - [x] 修正清单后再次进行 OpenTitan MAC FSDB 十批续查，640 段全部返回，无未接合缺口。9,140 条缺口已接回，730 个待查入口保留。匹配错误已消除，tick 0 的 42,666 条初始求值顺序缺口与 450 条触发边沿缺口仍需更多仿真执行证据。
  - [x] 用同次 VCS FSDB 和执行记录核对 OpenTitan ALU 两条 tick 0 路径。VCS 执行映射支持阻塞赋值和固定 packed 位段的操作数采集。回放使用完整的阻塞写入顺序和前后两次值变化回调，将 `adder_in_a[1]` 与 `adder_in_b[1]` 分别绑定到改变该位的提交 38 和 88。前台与静默 MCP 的详细报告及图一致，两条局部图的初始求值顺序缺口已消除。
  - [x] 整条 packed 总线的 tick 0 波形初始采样可按位关联到实际阻塞提交。OpenTitan 两条 ALU 总线各核对 32 位和四次提交，另有 4 位未核对。从 `x28` 启动自动续查，经五批共 320 段，两条总线及其记录证据均可由根节点沿候选和续查边到达。仍有 670 个待查入口。
  - [x] MCP 可从分页时间图提取选定节点到根的一条最短路径。OpenTitan MAC FSDB 的 `x28` 合并图中，两条 ALU 路径各经过 13 条边，保留上述八次实际提交及原图候选关系。Linux VS Code 前台和静默 MCP 返回一致的路径、Mermaid 和详细报告。
  - [x] MCP 路径导出支持保留快照中通往追踪根的全部分支。OpenTitan MAC FSDB 的同一批 320 段，从上述两条 ALU 总线导出 198 个节点、1,216 条候选边、311 个已接合缺口和 728 条赋值来源。Linux VS Code 前台和静默 MCP 的每个分页章节一致，独立正反可达性核对重现边集合。Chromium 渲染全部 4 张 Mermaid 图。原图保留部分覆盖状态和 670 个待查入口。
  - [x] 同一个 MCP 批次内，使用构建清单的时间续查可在不同 tick 复用静态 RTL 查询。OpenTitan 前三批共 192 段中复用 37 次。构建和续查输入仍逐段检查，波形按各自 tick 采样。Linux VS Code 前台、静默 MCP 与缓存前的图和诊断一致。
  - [x] 同槽输入只有初始采样、求值顺序无法核实时，保留候选边，并在缺口中携带已观测的值和对应赋值。真实 OpenTitan MAC FSDB 首批 64 段有 5,177 条此类缺口与 6 条未证实的触发边沿。VS Code 前台和静默 MCP 逐项比对分页及详细报告，Chromium 渲染包含启动顺序诊断的图页。
  - [x] 时间图保留候选赋值使用的稳定输入值。输入在窗口内有连续的已知采样时，离线续查可沿其窗口边界查找前序变化，并在位选择和保持值一致时将结果接入合并图。Linux VS Code 1.124.2 的 MCP 在 Verilator VCD、FST 和 VCS FSDB 上从 `q[1] @ 200 ns` 回溯到 `data[1] @ 5 ns` 和 `seed @ 2 ns`。同一波形的整总线查询回溯到 `data[2:0] @ 115 ns`。三种格式均核对了单独提交续查参数和详细报告。Chromium 渲染 VCD、FST 合并图。回归验证历史中有不可用采样时保留缺口。独立后端 129 项通过，Verdi NPI 118 项通过并跳过 11 项独立后端专用用例。
  - [x] 稳定输入的离线回溯可从读取器返回的窗口前采样时刻开始。多个窗口使用同一采样时，共用信号、位选择和时间相同的续查请求。真实 OpenTitan MAC FSDB 的 `x28 @ 2051001 ps` 从 `rst_n @ 1911000 ps` 接回复位来源。首批 64 段接回 100 处前序历史缺口，包含 10 个查询段中共用 `shift_left @ 0` 的 16 个接点。前台和静默 MCP 的分页、Mermaid 与报告一致，仍有 389 个待查入口。Verilator VCD、FST 和 VCS FSDB 复验整总线、位查询及手动续查。
- [x] 接入 `wave_trace_context`，包含静态依赖、当前值、必要历史、候选路径、报告状态和缺失原因。Trace Explorer 支持回到各证据时间点和对应源码。
  - [x] Trace Explorer 列出时间因果图的观测变化。选择变化将波形游标移到该 tick 并调整视窗，展开可定位关联候选赋值的源码。
  - [x] Trace Explorer 按候选赋值逐层展开时间图的上游采样，显示依赖类型、RHS 比对和同 tick 调度歧义。路径重复时终止展开，历史缺口和预算前沿可在时间视图中查看。
  - [x] MCP 可指定整数 tick 和可选历史起点，波形菜单可使用 A 游标。附加证据给出绑定实例、观测值、可用历史、截断和未映射信号，以及可选观测序列图。
  - [x] 对观测窗口的最后一次根信号变化匹配直接赋值的触发边沿和基本四态布尔守卫。保留未验证的候选与证据。完整 RHS 验证和保持解释仍待实现。
  - [x] 对可求值的整信号赋值比对计算值与观测值，详细报告列出参与求值的 RHS 信号。已解析且求值结果匹配的三目赋值可沿激活分支回溯，静态图保留完整依赖。
  - [x] 从根信号变化递归连接静态候选路径上较早的可观察变化，输出带时间、边类型和置信度的有限时间图。无记录的前序变化和达到预算的前沿分别返回。精确执行及完整时序因果仍待验收。
  - [x] 波形 A 游标使用根信号最近一次采样事件附近的有限历史，游标值单独读取。MCP 可选 `historyStart: "auto"`。两个实际构建的 FST 和 VCD 验证了该回溯，报告保留构建匹配状态和候选矛盾证据。
- [ ] 用最小同步设计及双 Ibex / RV32A 仲裁覆盖最近有效赋值、保持、`grant`、`request`、`requester_id`、两个 hart 请求和跨周期证据。固定真实工程版本与仿真产物后复跑。
  - [x] 固定 OpenTitan RV32A Adapter 的真实 KDB、FSDB 和 189 个编译根。复跑静态端口关系及时间图，核对两路请求 `11`、就绪 `10`、选中 hart 1 和紧随其后的 `hart_q` 提交值。结果继续标注同 tick 行为及静态关系的证据缺口。
  - [x] 以 `+rv32a_random_delay=3 +ntb_random_seed=1` 重跑 RV32A Adapter 的原始版和探针版。两路请求于 `370000 ps` 同时有效，`ready=10`。离线回放将 `375000 ps` 的 `hart_q=1` 对应到第 747 行的求值 120 和 NBA 提交 121，确认保持至 `380000 ps`。八个仲裁信号在两次仿真的 11,495 个槽末值一致。
  - [x] 前台与静默 MCP 对已归档的 RV32A VCS VCD、KDB 和执行记录重新生成时间图。`wave_trace_graph_path` 按信号、tick 和槽内变化序号提取请求 `10`、请求 `11`、就绪 `10` 和较早的 `selected_hart` 变化到 `hart_q` 的路径。按节点编号重查得到同一份图。局部 Markdown 保留波形回调 115–117、求值 120 的操作数、提交 121 和 RTL 位置。请求到组合控制的边保留候选及同槽顺序诊断。
  - [x] 逻辑与、逻辑或纳入动态位依赖推导，确定选择索引时按被选中的请求和就绪位追踪。归档的双 hart VCS 回放核对 `hart_q` 提交 121 和 151。前者从 370000 ps 的 `valid[1]` 和 `ready[1]` 经 `capture_atomic` 到达根，后者从 370000 ps 的 `valid[0]` 与 455000 ps 的 `ready[0]` 到达根。前台与静默 MCP 的两份分页路径和报告一致。组合握手边保留证据置信度。
  - [x] VIDE 对局部整数变量上无延时且无强度标注的连续赋值提供时间语义。双 hart VCS 回放中，两次 `capture_atomic=1` 都通过波形组合排除选中握手位的低电平候选。就绪路径在 MCP 和 Trace Explorer 标注波形组合证据，仍保留同槽调度不确定性。Rust 回归包含局部变量正常与带延时的赋值，Node 回归保留多个相容组合。
  - [x] 在可核验的单驱动无延时路径上，按完整波形和回调一致性排除晚于输出的输入变化。真实 VCS 样本在 5 ns 由回调 0、1、2 依次记录 `a[1]`、`q`、`b[1]`，回放显示 `a[1]` 上升和 `b[1]` 的先前值。归档的两次 RV32A 仲裁仍保留各自的请求、就绪位和源回调。 [复现步骤](test/fixtures/trace/README.md#vcs-late-callbacks-on-an-undelayed-assignment)
  - [x] 补采 RV32A 的握手输入与枚举状态。VCS 在 370000 ps 记录 `ready[1]` 回调 131 和 `capture_atomic` 回调 132，在 455000 ps 记录 `ready[0]` 回调 168 和 `capture_atomic` 回调 169。两条时间图接回 `hart_q` 的 NBA 提交 136、174。在线断点与离线回放逐条核对这两条因果边。原始与探针 VCD 的 11 路信号在 11,495 个槽末值一致。 [复现步骤](test/fixtures/trace/README.md#vcs-rv32a-dual-hart-ready-callbacks)
  - [x] VCS 为简单变量索引的单 bit 阻塞写入记录实际目标位及求值时的控制操作数。RV32A 双 hart 的时间图从 `hart_q` 接回 `ready[selected_hart]` 的提交 162、219，并继续到枚举空闲状态、初始化标志和选择有效位。独立升序总线样本核对两个有效位、越界索引和 X 索引，后两者记录 `assignment-no-target`。 [复现步骤](test/fixtures/trace/README.md#vcs-rv32a-dual-hart-ready-callbacks)
  - [x] `wave_trace_graph_path` 的局部图和报告保留所选节点关联的待查、未匹配和未解决缺口。用 RV32A VCS 回放核对 8 处尚待核实的证据，并用单个位采集的 VCS VCD 核对 `waveformBitsUnavailable`、消费者和原始 RTL 赋值位置。前台和静默 MCP 返回相同的分页结果，Chromium 渲染两图。回归覆盖缺口不会成为可达路径、保留初始化引用及滤除路径外的缺口。

**验收**　对明确的简单同步用例能解释状态形成的时间及原因。对观测不足、竞争和等值分支能复现歧义。仲裁用例能从 `owner_q` 依次追到相关触发、仲裁输入和 RTL。

## Phase 5　精确执行记录与回放

- [ ] 确定 Verilator 的可选插桩入口和支持范围。按调试信号、过程或范围选择性启用，输出版本化、可流式读取且可索引的事件记录。
  - [x] 选择 `wave_execution_map` 中的直接过程赋值，可生成带 DPI 探针的 RTL 副本和按实例过滤的配置。通用运行时记录求值和阻塞提交，并为可定位的过程块入口记录触发事件。harness 核对单写入 NBA 目标时可记录时槽结束证据。通用调度器提交仍待实现。
  - [x] 可定位的 `if` 分支入口生成独立语句 ID。实际 Verilator 日志在 tick 1 记录进入分支并提交 NBA，在 tick 3 仅记录过程触发。
  - [x] 回放维护有界内存和磁盘检查点，重复访问同一记录与目标的较晚窗口时可跳过已核对的前缀。真实 VCS RV32A 的 17,801 条记录由静默 MCP 建索引。新启动的 Linux VS Code 1.124.2 和静默 MCP 均从序号 17,287 之后扫描，返回与冷回放一致的 `hart_q @ 57315000 ps` 求值 17,762、提交 17,763、源码核验、Mermaid 和 Markdown。等长修改结束事件计数后重新扫描，返回 `missingEventOrdinals`。回归覆盖索引损坏、波形哈希不符及命中索引后重新核对源码。
- [ ] 生成构建级 `statementId`/ `processId` 与源码映射表，覆盖实例、宏展开及多赋值点。明确事件 ID 关联、事件序列、NBA 求值和提交、丢失事件及记录覆盖边界。
  - [x] `wave_execution_map` 从已附加的 Verilator JSON 获取指定实例信号的直接变量赋值，按实例、源坐标和内容哈希生成语句与过程 ID。示例记录器可将已有的源探针映射到这些 ID。
- [x] 实现执行记录 Provider 和回放查询，与离线波形会话的时基和构建身份关联。UI/MCP 展示精确证据及记录缺口，支持仅回放执行记录。
  - [x] 最小 Verilator 工程可选记录过程、分支、NBA 求值和提交。MCP 接收 JSONL，验证波形 SHA-256 和时基，检查事件顺序及 NBA 配对并附上可选报告。
  - [x] 执行回放支持单独的波形菜单与 `wave_execution_trace`。示例的记录声明被覆盖的写入进程，使用连续事件序号和结束记录核对回放范围，验证同值提交、保持及日志尾部缺失。
  - [x] 同一记录可声明多个实例和信号的写入覆盖。回放分别核对赋值求值、阻塞提交、被覆盖的 NBA、替代它的求值和最终提交。记录缺失、未声明的写入进程和未结算的求值会在 MCP 和报告中显示为覆盖缺口。
  - [x] 执行记录中的语句映射可携带源码 SHA-256。回放分别报告波形身份和磁盘源码身份，兼容未提供源码哈希的旧记录。
  - [x] 生成探针的 `seal` 可核对并封装显式写入进程覆盖。Verilator 记录实测单信号的最后提交及其后的保持。
  - [x] VS Code 命令面板和 MCP 支持直接回放 JSONL，也可继续使用已打开的波形做身份核验。
  - [x] Trace Explorer 直接列出回放事件和源码链接。与波形绑定的事件支持跳转到对应 tick。
  - [x] `wave_trace_context` 将源码坐标唯一匹配的运行事件关联到同信号的静态赋值。磁盘源码哈希变化、编译上下文明显不匹配或坐标存在歧义时保留原始记录。
- [x] 对同值写入、同 tick 多次更新、多个实例、阻塞与 NBA 覆盖以及保持执行对照测试，用记录验证离线归因的正确性和降级。
  - [x] 执行覆盖从 tick 0 开始且同槽提交可唯一核实时，初始波形采样可关联提交与求值。真实 VCS 仿真中 `early` 保留求值记录捕获的 `seed=0` 与缺少该波形值的证据，`late` 继续追到求值前的同槽阻塞提交。VS Code 前台与静默 MCP 的时间图、Mermaid 和详细报告一致。
  - [x] `wave_trace_context` 对照根信号的波形变化和匹配执行记录的提交。在完整记录中跳过同值写入，逐项匹配可归因的变化，时间图标注提交序号。实际 FST 隐去同 tick 的中间写入时，报告保留执行序列和波形之间的差异。
  - [x] 一次回放扫描同时核对根信号与时间图中的已记录上游信号。唯一匹配的提交选择实际赋值，按可用求值时刻回溯输入。MCP 和 Trace Explorer 显示提交及求值位置，未核对的路径保留为波形候选。
  - [x] 归因改变可访问的上游变化时，使用同一次扫描取得的执行证据继续确认。图达到重建预算时提供部分状态和停止原因。Linux 独立复跑双实例竞争、两级流水线、在线 DPI、UI 和 MCP。
  - [x] 离线与在线 MCP 返回可达上游写入的事件值、位范围和源码位置。详细报告与执行图按记录序号展示根信号及上游求值、提交和未观测结果，评估后续提交时可包含窗口内较早的求值。
  - [x] 从执行记录核对实际 RHS 值，对可求值的单数据输入筛选同 tick 候选。时间图保留和记录相符的上游样本及证据字段。多个样本相符时仍保留歧义。
  - [x] 多个数据输入在求值 tick 有不同可见值时，MCP 和详细报告保留与记录 RHS 相符的联合取值组合。时间图及 Trace Explorer 显示组合数，缺少观察或超过比较预算时保留原波形候选。
  - [x] VCS 固定目标 NBA 可按语句选择采集简单局部按位操作数。求值事件记录确实用于计算 RHS 的保存值。MCP 和详细报告显示操作数值，时间图用它们筛选相同 RHS 的多种观测组合。
  - [x] VCS 的 `wave_execution_map` 支持 `captureOperands`。通过 VIDE 的数据引用和原始 RTL 核对可采集的操作数，生成器复用同一表达式检查。普通映射保留对包含常量和重复读取语句的支持。
  - [x] 操作数缺少波形或没有相符的变化时，时间图从已核对的求值记录显示实录样本及求值序号。图和详细报告保留波形历史缺口，有可核对波形的并行输入仍继续追踪。
  - [x] 实录操作数可通过完整写入覆盖回溯更早的整信号提交。时间图标明执行日志证据及波形缺口，沿已验证的赋值继续追踪。源映射、提交时序或写入覆盖不足时保留实录样本。
  - [x] 上游同值写入发生在最近一次波形变化之后时，时间图可按完整写入记录和捕获的操作数关联实际提交。真实 VCS T-2022.06-SP2 样例在 `5 ns` 写入 `or_q`。波形观测只定位到 `left_q` 和 `right_q` 在 `1 ns` 的变化，Linux VS Code 1.124.2 的离线及在线 MCP 时间图均核对了 `3 ns` 的提交 14、15 和各自 RTL 位置。Chromium 渲染两张 Mermaid。回归验证同槽仍有后续变化时保留波形候选。独立后端 129 项通过，Verdi NPI 118 项通过并跳过 11 项独立后端专用用例。
  - [x] 未采集的 packed 操作数可使用 VCS 日志中的完整下标范围，按位回溯多次位段写入。证据不足的位保留求值样本。
  - [x] 连续日志中的未观测提交按目标位限制归因。后续独立时间点的已核实提交可恢复所写入位的回溯。在线报告保留写入覆盖缺口及对应事件。
  - [x] Verilator 双实例 fixture 复现阻塞写入后两次 NBA 和无变化波形。生成 C++ 中每个实例共用一个 NBA 临时值，最终更新在时间槽结束时由 harness 核对。跨实例的精确提交调度及通用调度器插桩待实现。
  - [x] 运行库提供按求值序号记录 NBA 覆盖和提交的回调。针对 Verilator 5.054 双实例样本，在生成的 C++ 中接入实际覆盖存储与 NBA 提交点，回放验证同 tick 两个实例的提交序号和最终值。自动定位其他调度器的提交点待实现。
  - [x] `scheduler` 命令从 Verilator 5.054 生成的单线程 C++ 自动核对探针、直接写入及整信号掩码存储，生成可编译的插桩模型。真实双实例结果覆盖提交顺序与 NBA 覆盖，额外样本覆盖直接写入。其他生成结构和多线程调度仍待接入。
  - [x] VCS VPI 记录选定信号的值变化回调，封装时读取实际时间精度并绑定波形哈希。MCP 和执行图保留回调序号。轨迹上下文可逐项核对 VCD 和 FSDB 样本。精确关联重叠拼接的两个赋值组件仍待验收。
  - [x] 用同次仿真的完整 VPI 目标与 RHS 回调，筛选阻塞 modport 拼接的重叠固定切片。Linux VS Code 1.124.2 上，两种 KDB 后端的 MCP 在真实 VCS VCD 中将 tick 3 的两次位变化分别追到 `data[2:0] ← d[2]` 和 `data[3:1] ← d[5]`，对应回调 20 和 22。两次变化可独立查询，四种 Mermaid 结果已在 Chromium 渲染。FSDB 在 tick 3 合并了变化，两种后端均保留原始回调和差异，精确提交仍需执行探针。独立后端 135 项通过，Verdi NPI 129 项通过。
  - [x] 离线 FSDB 时间图可用同次仿真的完整 VPI 回调补入被合并的变化，并保留原始波形观测。Linux VS Code 1.124.2 的独立与 Verdi NPI 后端在真实 VCS FSDB 恢复 `data[2] @ 3 ns` 的 `1 → 0`，按 `changeOrder` 分别追到 `d[2]` 和 `d[5]`。整总线、单 tick 窗口和持有值处的自动回查均已实测。回调缺失或槽末值冲突时保留原始观测。Chromium 渲染两张恢复后的 FSDB 时间图，并对照 VCD 的四张逐变化图。独立后端 136 项通过，Verdi NPI 130 项通过。
  - [x] VCS 阻塞输出 modport 拼接可记录实际组件求值。Linux VS Code 1.124.2 的 MCP 从原始 KDB 导出三组件映射。真实 VCS 在 3 ns 记录 `data[3:1]=100`、`data[2:0]=101`、`bypass=0`，沿用原始拼接写入。原始和插桩 VCD 的五个相关信号具有相同的有序变化。VCD 与 FSDB 的两个 KDB 后端均核对数据位段的候选分别关联求值 38、37 及回调 43、45。物理提交仍记录为 `assignment-unobserved`。独立后端通过 137 项，Verdi NPI 通过 131 项。
  - [x] VCS modport 的整总线及位级查询可用完整组件求值匹配物理回调。只监视两个目标的真实 VCS 运行中，Linux VS Code 1.124.2 的两个后端均通过 VCD 和 FSDB 验证 `data[2:0]`、`data[3:1]` 分别关联求值 32、31 及回调 37、39。在线 MCP 在 3 ns 命中求值 32 的断点。以 FSDB 为参考波形的 `wave_live_trace` 在核对执行序列后恢复停顿快照之间合并的两次位变化。在线和离线原始记录逐字节相同。修改参考组件值的反例报告 `eventSequenceDiffers`。物理写入提交仍未观测，直接在原始别名赋值前后读物理数据也验证了延迟传播。
  - [x] 用 VCS T-2022.06-SP2 同槽三次阻塞 modport 写入验证重复 RHS。以整个时间槽的完整回调检查一对一的求值配对。总线五次变化的回调 → 求值为 43 → 38、45 → 37、54 → 49、55 → 48、64 → 58。第 3 次回调未改变 bit 2，单比特查询仍可用该回调约束全槽配对。VCD、恢复同槽变化的 FSDB、在线 MCP 和 Linux VS Code 在线报告得到相同的配对。采集到的物理提交状态为 `assignment-unobserved`。
  - [x] 用 VCS VCD/FSDB 验证两个实例从同一 RTL 位置写同一重叠 modport。按进程身份和范围关联求值事件，全槽一对一配对后，前两个物理回调归到第一个实例，后两个归到第二个实例。在线暂停与离线回放得到相同的配对。缺少任一实例的有效求值证据时保留候选。 [复现步骤](test/fixtures/trace/README.md#two-writer-instances-on-the-same-modport)
  - [x] VCS 阻塞 modport 拼接探针使用语句求值前后的物理总线值与槽内回调，验证能够唯一归因的同步写入。两个实例在 3 ns 的四次物理提交均支持逐次波形追踪，在线提交断点命中序号 23。延后传播、同值写入和两组件均能解释的回调保留 `assignment-unobserved`。 [复现步骤](test/fixtures/trace/README.md#two-writer-instances-on-the-same-modport)
  - [x] 同一时间槽同时存在明确及未观测提交时，审计物理回调、求值和提交三个序号。真实 VCS VCD、FSDB 和在线回放均将 4 ns 的第二次变化和 bit 3 关联到回调 43、提交 44 与 `writer2.d`，第一次变化与 bit 2 保留候选。FSDB 槽末采样可通过记录恢复两次变化。 [复现步骤](test/fixtures/trace/README.md#mixed-commit-coverage-in-a-single-time-slot)
  - [x] 对整槽已有精确提交的记录逐条核对回调、位段和波形序列。真实 VCS 的 3 ns 时间图保留四组回调和提交序号。把提交 15 的回调换成同槽旁路信号的回调后，VCD 保留其他三条归因，FSDB 保留槽末采样并报告记录差异。 [复现步骤](test/fixtures/trace/README.md#mixed-commit-coverage-in-a-single-time-slot)
  - [x] 从根信号的同一份 VPI 记录一次读取可达上游的值变化。在逐项匹配的时间节点标记回调序号，并显示同 tick 上游与目标回调的先后。执行图包含根与可达上游，保留回调顺序与赋值候选各自的证据。
  - [x] VPI 记录携带成功注册的观测信号与采集开始时间。回放区分覆盖完整且无值变化、未选信号与截断记录。观测覆盖独立于赋值和提交覆盖。
  - [x] VCS 可为指定模块内可遍历的过程赋值注册语句入口回调，记录源码文件、行号、实例与赋值类型。直接写入已选信号的事件可跟踪到根或上游，即使对应时间槽内信号未变化。VCS 的求值结果及位级提交归因仍需独立证据。
  - [x] `wave_execution_map` 可结合 VCS KDB 和 VIDE 定位直接过程赋值，生成带源码哈希的探针映射。VCS 插桩副本可记录实际 RHS、阻塞提交和 NBA 求值。运行时绑定探针映射哈希，回放可确认目标及可达上游的阻塞写入。
  - [x] `captureGuards` 支持固定目标 NBA，可与 RHS 局部操作数合并采集。RV32A 的 `hart_q` 求值记录 `selected_hart=1`、`capture_atomic=1` 和 `rst_ni=1`。时间图通过此求值排除提交后才出现的 `capture_atomic=0` 候选。Linux VS Code 1.124.2 经 MCP 在同一提交处命中断点，在线报告与回放均关联提交 121。在线、离线原始记录逐字节一致。Chromium 渲染离线和在线时间图及执行图。独立后端通过 124 项，Verdi NPI 通过 113 项并跳过 11 项独立专用用例。
  - [x] VCS 的直接整信号 NBA 可在生成副本中携带求值序号，VPI 核对标记与实际目标值后记录提交。同值写入也能配对。合并更新中缺少独立观测的求值保留为 `assignment-unobserved`，仅受影响的时间槽缺少完整归因证据。
  - [x] VCS 覆盖单维 packed 变量的固定选位与范围。互不重叠的 NBA 位段各自观测提交。阻塞写入和 NBA 事件携带有方向的目标范围，回放可逐次还原总线值，并在位查询中将变化归因到写入该位的 RTL。
  - [x] VCS 动态单个位 NBA 可保存简单变量下标的求值结果，按实际目标位核对提交。含 X 或越界的下标保留为未观测结果，其他时间槽的独立提交仍可归因。
  - [x] VIDE 静态图保留 `+:`、`-:` 的方向和宽度。VCS 为简单变量起点、十进制恒定宽度的多位 NBA 保存实际目标范围，时间图可继续追到 RHS 对应位。部分越界和 X 的写入保留仿真行为，执行结果报告未观测。
  - [x] 部分越界的 VCS NBA 同时保留求值 RHS 和尝试写入的范围。真实 VCS T-2022.06-SP2 与 Linux VS Code 1.124.2 验证升序总线在 6 ns 的 `[7:8]`、降序总线在 8 ns 的 `[0:-1]`，分别只有 bit 7 和 bit 0 落在总线内。MCP 执行图和报告保留这两个范围与未观测状态。在线及离线原始记录逐字节一致。回归验证同槽及较早时间槽的部分越界写入只影响相交位的归因。
  - [x] 扩展 VCS 部分越界探针，在观察到提交标记且在界位的值吻合时记录实际提交。用 VCS T-2022.06-SP2 实测升序和降序总线两端的四个写入，核对 2 ns 的同值提交与 4 ns 的位变化。在线和离线时间图均可从实际写入位回溯至 `d[0] @ 3 ns`，保留尝试范围和完整的 RHS。核对源码位置后两种模式的证据一致。显式未观测的旧记录继续保留原覆盖状态。
  - [x] VCS 接受同一 packed 变量的重叠固定范围、动态选择和整信号 NBA。各求值保留实际目标范围，回放报告无法确认的提交。独立位段和后续时间槽仍可获得提交归因。
  - [x] VCS 探针确认动态选择无可写位时，记录与原求值关联的 `assignment-no-target`。回放和在线时间图可以核对同槽的有效写入。VCS T-2022.06-SP2 在完全越界及 X 下标的两个时间槽中，分别将 `q[0]` 与 `q[1]` 的变化关联到提交 6 和 13。图回溯到对应输入变化，图和详细报告同时保留两次无目标求值的 RTL 位置。旧记录中的未观测提交、部分越界和重叠合并的覆盖缺口继续保留。
  - [ ] VCS 合并更新中间写入的精确调度及复杂左值组件仍需位级证据。
    - [x] 为不同固定范围、动态选择形式和整信号写入分配各自的 VCS 提交标记。在同一个 packed 目标中验证动态、固定和整信号写入。前台与静默 MCP 的在线和离线时间图均可按 `changeOrder` 区分 `mixed[1]` 在 2 ns 的两次变化。回调核对覆盖实际范围、求值和提交顺序。相同标记内无法确认的合并仍保留观测缺口。 [复现步骤](test/fixtures/trace/README.md#vcs-overlapping-packed-writes)
    - [x] 同一目标只包含固定范围 NBA 时，区分不同的范围标记。真实 VCS VCD/KDB 在 2 ns 验证 `q[2:1]` 和 `q[1:0]` 的两个重叠提交。前台、静默 MCP 用同次执行记录和波形核对两条 `q[1]` 时间路径。在线快照的槽末值与 VPI 回调一致，精确提交重建出相同顺序后补入中间变化。相同范围、动态选择和整信号写入的合并缺口继续保留。

**验收**　给定同一构建，能逐条定位已记录的过程、分支、求值及提交，并证明不同实例及同时间戳事件可区分。构建不一致及日志截断均能发现。

## Phase 6　在线仿真调试

- [x] 用 Verilator Harness 实现首个实时 Provider，将实时事件、离线回放和 Trace Explorer/MCP 接到共同的时间图和证据格式。
  - [x] `wave_live_trace` 将 harness 保留的采样与静态图组合，复用离线时间图和报告。构建清单可核对启动时的 harness 哈希、波形、时基、展开和编译配置。构建证据缺失时显示 `unverified`，未采样信号保留 `unavailable` 状态。
  - [x] 在线样本用波形元数据恢复 packed 范围和单个位。真实 Verilator harness 在 tick 5 复现 `q[index]` 写 bit 2，MCP 返回与离线相符的观测与目标索引。
  - [x] 在线预算前沿按保留的槽末快照和会话 ID 续查。实际 Verilator 流水线停在 tick 3，隔离 Linux VS Code 的 MCP 和 Trace Explorer 从预算前沿回查 tick 1 的 `first_q`，核对提交 4，仿真仍处于 tick 3。MCP 拒绝缺失快照和已替换会话的请求。独立后端通过 124 项，Verdi NPI 通过 113 项并跳过 11 项独立后端专用用例。
  - [x] 首次查询可用 `followContinuations: 0` 保存根图和待查队列，再按编号续查。真实 Verilator 流水线停在 tick 3，前台与静默 MCP 从 `second_q` 的提交 8 追到 `first_q @ tick 1` 的提交 4。Trace Explorer 点击待查缺口后得到与前台 MCP 相同的续查附录。新仿真启动后清除旧的界面续查入口并拒绝旧续查游标，旧图仍可分页读取。
- [x] 实现声明能力的暂停、继续、指定时钟步进、信号条件或语句断点，以及明确的断点命中和时间语义。
  - [x] Verilator harness 声明有无执行事件。UI 和 MCP 支持按实例与语句 ID 设断点，MCP 可指定分支、求值或提交事件。命中响应携带准确事件序号，仿真在对应时间槽结束时暂停。
  - [x] 自动生成的探针可向在线 harness 发送执行事件。同一生成分支的在线断点和离线回放已核对语句 ID 与事件序号。
  - [x] VS Code 和 MCP 可在实际 NBA 提交或覆盖事件上设断点，按提交时机过滤。自动插桩双实例模型核对命中序号、在线执行图和同一模型的离线记录。
- [x] 验证会话断开、仿真退出、取消、重复暂停/继续、事件缓冲和不支持能力。保留 VPI 适配点，按具体仿真器支持报告能力。
  - [x] 在线 MCP 按所选实例、信号和时间查询保留的事件。响应标注会话序号缺口、缓冲区淘汰及返回上限。用断开测试核对步进和暂停会共同返回失败状态。
  - [x] MCP 取消多周期步进时等待已发出的时间槽返回，再停止推进。真实仿真验收覆盖暂停边界、保留提交事件和重新步进。
  - [x] VCS VPI 在只读时间槽采样，支持启动后暂停、继续、重复暂停、时钟步进、信号值断点与自然退出。仅采集值变化时，能力显示值变化回调可用。真实 VCS 验证 VS Code 入口及 MCP 控制。
  - [x] 启用 VCS 过程赋值入口采集后，在线会话声明 `assignment-entered` 断点能力。实际样本在无值变化的 NBA 时间槽命中，MCP 返回语句 ID、源码行和原始序号，仿真停在相应时间槽末尾。
  - [x] VCS DPI 插桩支持 `assignment-evaluated` 与阻塞赋值的 `assignment-committed` 断点。真实仿真核对停下时的最终值、对应源码和在线回放。
  - [x] VCS NBA 探针在真实仿真中支持 `simulator-commit` 断点，核对同值写入以及有变化的 NBA 与其上游阻塞提交。
  - [x] 在线追踪、分页图和详细报告保留来源会话 ID。真实 Verilator 流水线在 tick 3 重复暂停，停止后两种 MCP 宿主都能从首批 1 段续查到 3 段，Linux VS Code 命令也能打开同一会话的报告。替换会话后旧续查游标和显式旧会话请求失效，旧分页图仍保留原节点与报告。新会话在 tick 7 自然退出后仍可查询 tick 3。启用真实 Verilator 和 VCS 样本的在线回归 11 项全部通过，覆盖连接中断、重复暂停、取消、序号缺口、缓冲淘汰及未支持的断点类型。
- [x] 回放同一在线会话的记录，逐项核对断点时间、当前值、候选/精确路径、实例与语句位置。
  - [x] 在实际运行的 Verilator harness 上验证暂停、步进、继续和条件断点，同一 fixture 的在线序列与离线记录一致。
  - [x] `wave_live_trace` 和 VS Code 的 **Trace Live Signal** 使用已验证的参考构建及对应的执行 JSONL，逐条核对根信号与上游信号的在线事件。已确认的赋值、求值和提交出现在时间图及报告。日志不匹配时保留波形候选。同 tick 中间变化丢失时保留序列差异。
  - [x] VCS 在线回放使用选定信号的观测覆盖，逐项核对根信号和可达上游的回调。MCP 返回回放核对状态，配套时间图与执行图标注回调序号，Trace Explorer 命令可打开详细报告。
  - [x] 真实 VCS 在 tick 0 暂停时，在线 `early` 和 `late` 时间图与离线回放一致。MCP 分页保留执行回放核对状态，合并图保留捕获操作数的求值序号及上游提交。修改根信号的操作数记录会取消该信号的执行归因，其他信号仍按各自记录核验。VS Code 与静默 MCP 均复跑通过。
  - [x] 真实 VCS 在 3 ns 的 `q` 提交 5 暂停。前台与静默 MCP 使用求值 2 的移位量和求值 3 的三元条件，将 `q[5]` 和 `r[3]` 都追到 `a[4] @ 1 ns`。在线与离线的节点值、来源位、求值、提交和边的证据一致。在线整总线标签沿用观察名，离线标签带声明范围。VS Code 的 Trace Live Signal 报告与前台 MCP 在归一化本地 VIDE revision 后一致。修改日志里的移位量后，在线回放报告序列差异并撤下根提交归因。继续仿真自然退出后，两份在线原始记录与离线记录逐字节一致。
  - [x] 从仓库样本重新编译，并通过可重复运行的静默 MCP 回归验证上述 VCS 断点、位路径和回放拒绝。 [构建与回归步骤](test/fixtures/trace/README.md#vcs-recorded-shift-and-mux-operands)
  - [x] 在线图的整总线节点采用已绑定波形的声明范围。真实 VCS 在线和离线查询使用相同的 `tb.amount[2:0]` 与 `tb.choose[1:0]` 筛选到相同节点及路径。前台和静默 MCP 的局部图一致，映射后的波形别名也可作为路径选择器。

- [x] 接入 VS Code「运行和调试」。实际 Verilator 调试命中 RTL 源码行并步进至下一时钟上升沿。实际 VCS 附加调试命中 VPI 源码行和采样值断点。 [启动配置](WORKFLOW.md#在-vs-code-中调试在线-rtl)

**验收**　实际仿真在预期条件暂停，可由 UI 执行继续和步进，UI/MCP 查到与同一时刻的离线回放一致的证据。仅支持部分控制能力的 Provider 显示对应状态。

## Phase 7　性能、兼容性与交付

- [ ] 用最小工程和大型 SoC 测量冷/热静态查询、增量索引、波形窗口读次数、A 游标更新、图展开、MCP 数据量、内存、插桩运行开销和事件文件大小。用结果确定并记录预算。初始默认建议为深度 3、节点数 256，包含控制和时序边。
  - [x] 因果图按目标信号索引赋值，波形身份核验复用同一文件版本的 SHA-256。文件替换或内容修改后重新核对。
  - [x] 在 Linux VS Code 中测量最小 FST 和 OpenTitan RV32A adapter FSDB 的冷查询、热查询和 MCP 数据量。计时包含启动 MCP stdio 客户端。RV32A adapter 使用 189 个编译根，深度 8 的查询返回 86 个信号和 85 条赋值，含图及详细报告的响应为 576933 字节。
  - [x] 从相邻或显式构建清单加载的 MCP 续查在同一批内复用 VIDE 工程，逐段核对声明的构建输入，批次结束释放工程。真实 OpenTitan RV32A VCD 的 189 根构建用 `hart_q[0:0] @ 280000 ps` 对照同一工作树修改前后的响应。静默 MCP 首批四段从 25.68 秒降至 6.58 秒，VIDE 从启动 5 次降至 1 次。同一会话重复查询从 25.77 秒降至 6.61 秒，后续两段从 10.23 秒降至 5.45 秒。Linux VS Code 1.124.2 前台分别为 7.30、6.70、5.51 秒。改动前后及两种 MCP 的各分页章节、Mermaid 和 Markdown 逐项一致。首批摘要 1,306 字节，八次分页共 287,402 字节。续查后 49 个节点、134 条边、256 个缺口和 17 个待查入口。隔离宿主用测试钩子在第二段查询返回后改写清单，保留第一段并返回 `contextChanged`。
  - [x] 在 Linux VS Code 1.124.2 用同一份 OpenTitan MAC FSDB 对比 `x28` 的默认静态响应与 `output: "graph"`。深度 24 并续查 1 段时，两种响应的合并图逐项相同，均含 2,674 个信号和 4,683 条赋值。MCP 响应正文从 64,327,555 字节降到 17,553,749 字节。
  - [x] `output: "paged"` 和 `wave_trace_graph_page` 支持读取静态、离线及在线合并图的快照。Linux VS Code 1.124.2 用真实 OpenTitan MAC FSDB 续查 6 段后，离线时间图的首页摘要为 809 字节，43 次取回 489 个节点、925 条边、3,168 个缺口、440 条赋值源码引用、14 张 Mermaid 和完整 Markdown。拼接后与完整响应逐项一致。静态 Driver 的分页测试核对 167 条赋值、反馈边、Mermaid 和报告。在线 Verilator 样例的分页保留提交 4 及赋值位置，重启后仍可读取先前的图快照。Linux 本地 IPC 冒烟、独立后端 129 项及 Verdi NPI 118 项通过，另有 11 项独立后端专用测试跳过。
  - [x] 在同一 Verilator 双实例模型上测量未插桩、DPI 探针和实际 NBA 提交记录的时间开销、事件数及文件大小，逐项比对输出波形变化。
- [ ] 验证图共享节点、静态及动态环路终止、局部缓存失效、时间窗口和批量点值缓存、异步取消、分页及过期结果丢弃。
  - [x] 跨请求恢复时间前沿时恢复上一批的优先分支。在 Linux VS Code 1.124.2 对真实 OpenTitan MAC FSDB 的 `x28 @ 2051001 ps` 比较一次续查 6 段与分批续查 2、1、3 段，两次均得到 1419 个节点、2843 条边、4664 条缺口、440 条赋值源码、24 页 Mermaid 及 102 个待查入口。合并图、MCP 分页数据与 Mermaid 逐项一致，报告扣除独立编译的 VIDE revision 后一致。首次查询约 26.9 秒，分批版三次分别约 11.0、2.9 和 12.8 秒，两者的查询顺序分别为先冷、后热。
  - [x] 对同一真实 FSDB 的 `x28 @ 2051001 ps` 复验合并图的 RTL 赋值来源。证据边和有使用点的缺口标出段内赋值编号，详细报告提供实例与源码行列索引。使用修改版 VIDE，Linux VS Code 1.124.2 前台 MCP 耗时约 26.7 秒，静默 MCP 约 33.3 秒。两端逐条核对 8,537 组边与赋值编号关联及 440 条源码引用，27 页 Mermaid 和约 2.94 MB 的详细报告完全一致。Chromium 用默认 Mermaid 限制渲染全部页面，并核对每页保留的赋值编号。六段续查后仍有 102 个入口受请求预算限制。
  - [x] 用同一 VCS 运行的 OpenTitan FSDB 与执行记录核对合并时间图的多位写入。前台 VS Code 与静默 MCP 均由四次字节提交 553、555、557、559 重建 `u_imem.mem[36] @ 931000 ps = 0x9062be2b`，并将提交定位到 RTL 第 116–119 行。详细报告的整字证据章节一致，Chromium 渲染的 Mermaid 保留四个提交和段内赋值编号。回归另外覆盖两段合并时保留各自的未核对位范围、同槽回调和源码位置。
  - [x] 定位并修复该 OpenTitan 整字样本两端的上游图差异。捕获的 VIDE 编译清单逐字节相同，进入差异前的请求和响应一致。修复前静默 MCP 省略 `backend` 时按 `auto` 使用 Verdi，显式指定 `independent` 即与前台完整报告一致。修复后两端均默认采用工作区设置，直接查询和续查后的完整报告、两页 Mermaid、四次写入的来源和分页统计一致。续查一段有 157 个节点、355 条边、197 条缺口和 56 个待查入口。
  - [x] 分页同时返回图和详细报告时共用已生成的合并 Mermaid。用真实 OpenTitan FSDB 的 `u_imem.mem[36] @ 931000 ps` 验证首批一段、恢复两段及静态 Driver。前台和静默 MCP 逐项比较所有分页章节，另将时间图各章节与改动前的静默 MCP 比对。Markdown 比较前归一化 VIDE revision。恢复后获得 206 个时间节点、468 条边、三页图及 62 个待查入口。静态 Driver 获得 160 个节点、176 条赋值、两页图及 24 个待查入口。逐页核对所有返回的合并 Mermaid 都出现在各自的详细报告中。
  - [x] 显式 filelist 的 MCP 根查询和续查在同一批次复用隔离的 VIDE 工程。每次恢复先复核原输入，再启动本批工程。OpenTitan `x28 @ 2051001 ps` 通过静默 MCP 一次续查六段，VIDE 从启动 7 次降到 1 次，单次实测从 27.4 秒降到 10.8 秒。分批 2、4 段分别用 7.6、6.7 秒，各启动一次。前台复测分别为 10.8、7.1、6.7 秒。前台静态 Driver 首批三段和续查两段各启动一次。验证批次进程退出，并对比 1419 个节点、2843 条边、4664 条缺口、440 条源码引用、27 页 Mermaid 及详细报告。局部信号编号按路径归一化，报告按 VIDE revision 归一化。六段后仍有 102 个待查入口。
  - [x] 在真实 VCS 样本的显式 filelist 续查中，用隔离宿主的测试钩子在第二段查询后改写嵌套 filelist。结果返回 `contextChanged`，保留第一段和七个待查入口。恢复文件后新查询完成四段。
  - [x] MCP stdio 读到取消通知后关闭该请求的 IPC 连接，扩展把取消传到 VIDE 查询。动态采样检查批次之间的取消。测试用两个服务进程验证取消和连接路由，并在扩展宿主测试中观察到 VIDE API 的取消令牌。
  - [x] MCP 取消离线执行回放时终止 JSONL 流读取。后续查询可重新扫描，完整查询建立的检查点仍可复用。
  - [x] 隔离 VIDE 会话按源码 revision、文档版本和查询预算复用端口分析。复用后再次核对 revision。真实 VS Code 验证两次查询等价，保存子模块赋值修改后转到新输入。
  - [x] 自动续查在每段前后核对波形、KDB、编译文件、执行日志和在线会话。在隔离的 Linux VS Code 测试宿主中，分别于第二段 VCS 查询返回时改写嵌套 filelist、于第一段 Verilator 查询返回时启动新会话。两次 MCP 返回 `contextChanged` 并丢弃当时返回的续查段。VCS 结果保留第一段和七个待查入口，复查完成四段。Verilator 新会话位于 tick 0，待查入口仍关联原来位于 tick 3 的会话。独立后端通过 126 项，Verdi NPI 通过 115 项并跳过 11 项独立专用用例。
  - [x] 并发查询在同一份仿真 filelist 更新后共享刷新后的 VIDE 会话。在隔离的 Linux VS Code 测试宿主中，用测试钩子同步并发的 filelist 检查，三轮各发出八次 MCP 查询。24 次查询均返回当前宏对应的驱动。通过 VS Code 切换到另一份 filelist 时，进行中的旧查询被拒绝，新查询使用切换后的驱动。
- [x] 实现并验证 Windows MCP 本地 IPC，例如 Named Pipe。覆盖当前 Unix socket 路径、同工作区多 VS Code 实例及退出清理。保持 MCP stdio 桥采用本地传输。
  - [x] Windows 命名管道按会话生成随机注册名和凭证，读取时跳过损坏的登记，正常退出移除本会话记录。跨平台发现对每个候选执行有界探测。
  - [x] Linux 两个真实 VS Code 窗口用同一工作区打开不同 FSDB，MCP 按波形路径分别返回正确的时间图，关闭一个窗口后发现与查询正常。Windows x64 Node 在 Wine 下通过命名管道冒烟，覆盖凭证拒绝、损坏旧登记、无响应候选、取消和退出清理。原生 Windows VS Code 实测仍待补。
  - [x] 平台打包冒烟检查通过实际 MCP stdio 与两个服务进程联调，检查多会话路由和正常退出清理。Linux 上用长临时目录实测 Unix socket 路径处理。
- [ ] 完成 Linux/macOS/Windows 的适用构建、平台 VSIX、真实 IDE 与 MCP 冒烟验证。区分开源 Verilator/FST/VCD 必测场景和需要对应环境的既有 FSDB/KDB 场景，记录各平台实测范围。
  - [x] 从当前工作树打包 Linux x64 的 Wave Workbench 0.9.22 与 VIDE 1.3.0，在隔离的 VS Code 1.124.2 中安装。开源 Verilator VCD 双构建验证静态与时间图、TB 配置和可选详细报告。商业 VCS 用例通过同一对包复测 RV32A 在线提交断点及回放。打包冒烟通过内置 Tcl、原生读取器和多会话 MCP 传输检查。
  - [x] 追踪采样按信号位宽展开 VCD 的缩写二进制值。相同仲裁配置的现有 FST 和新建 VCD 在 Linux VS Code 中返回逐项相同的 28 个时间节点和 33 条边。从 MCP 导出的静态和时间 Mermaid 均已在 Chromium 渲染。独立后端 124 项通过，Verdi NPI 113 项通过并跳过 11 项独立后端专用用例。
  - [x] 增加桌面 VS Code 的 [VSIX 冒烟脚本](scripts/smoke-rtl-trace.mjs)。安装两份包后，经 MCP 验证隔离 VIDE 配置、Driver / Load、FST 与 VCD 图及 Markdown，并实际打开 RTL 赋值行。在 Linux x64 VS Code 1.124.2 通过。
  - [x] 从当前工作树交叉构建 Windows x64 GNU 读取器和 VSIX。在 Wine 下使用 Windows Node 22.22.2，包内 Tcl 和读取器通过冒烟，MCP 命名管道通过会话路由、取消与清理检查。仲裁 FST 和 VCD 均得到 `owner_q` 在 tick 0、3、8 的变化 `0 → 1 → 0`。当前原生读取器通过 macOS 和 Windows 两种架构的交叉 `cargo check`。
- [ ] 补齐使用文档、复现命令、能力表、兼容范围和发布验证证据。四块 VIDE 改动保留独立的验证记录，PR 创建继续暂缓。
  - [x] 新增 [RTL 追踪快速入门](RTL_TRACE_QUICKSTART.md)，从安装、Verilator 样例与隔离 VIDE 配置走到 VS Code 和 MCP。文档包含可执行的构建及导出命令、四种追踪模式的入口，并链接执行探针、格式和兼容性说明。

**验收**　四种分析模式通过语义、实例、波形、历史推断、执行/回放和 UI/MCP 检查。开源工具链可完成主流程，现有波形、KDB、Tcl、项目恢复和源码联动通过适用回归。

## 跨阶段验收矩阵

### 当前可复现能力

| 能力 | 已验证入口和数据 | 尚待验收或需要额外证据 |
| --- | --- | --- |
| 静态 Driver / Load | Linux VS Code 的 Trace Explorer 和 MCP。Verilator 展开 JSON、VCS KDB、位选、跨实例端口、循环 generate、固定 modport 切片和反馈关系 | 复合 modport 表达式、未解码的复合端口及动态输出选择 |
| 离线时间因果 | FST、VCD、独立 FSDB 和 Verdi NPI。支持历史瞬态、触发与控制、跨周期上游、Mermaid 及 Markdown | C++/DPI 和其他运行期输入需要对应的执行记录。单靠波形保留跨信号同 tick 的顺序缺口 |
| 精确执行回放 | 单线程 Verilator 5.054 的阻塞写入、支持形式的 NBA 求值、覆盖和提交及同步 DPI 步骤。VCS T-2022.06-SP2 的 VPI 回调及选定写入的探针记录，可核对求值、提交、局部操作数和波形 | 其他调度器生成形式、多线程提交、复杂左值的精确提交、异步外部执行及更多宏展开语句的映射 |
| 在线 Trace | Verilator harness 和 VCS T-2022.06-SP2 的暂停、继续、时钟步进、信号值与受支持的语句断点。使用同构建记录时，UI 和 MCP 可核对根与上游写入 | 其他仿真器的在线适配器、其他 VCS 版本及平台 |
| TB 编译配置 | 隔离 `vide.toml` 接收显式 filelist、清单、已有 VIDE 配置及 VCS `vcs_rebuild`。实际 OpenTitan 用例验证 54 个编译根 | 未恢复的构建参数、无法读取的产物及部分层次化参数语义仍进入报告 |
| 平台 | Linux 真实 VS Code。Windows x64 交叉构建和 Wine 下的 Tcl、MCP、独立波形及 KDB 验证 | 原生 Windows 与 macOS VS Code，macOS 和 Windows arm64 的原生打包及实跑 |

### 用例

| 用例 | 核对点 | 首次验收 |
| --- | --- | --- |
| 连续赋值、blocking/NBA、复合赋值、字段、索引、位选 | 引用语义、依赖类型、原始源码范围、两向查询 | 1 |
| if/case、顺序覆盖、保持、异步复位、多驱动 | 候选与优先级、保持语义、正确触发事件、歧义 | 1 / 4 / 5 |
| 两个同模块实例、端口、generate、切片 | 实例与位范围消歧、跨层次节点、partial | 3 |
| 两个仿真 target、真实 OpenTitan testbench | 配置导入、TB 到 DUT、宏和参数变体、切换后缓存失效 | 0 / 3 / 4 |
| 缺失 VIDE、版本不符、取消、重启、大图 | 明确诊断、恢复、预算与现有功能回归 | 2 / 3 / 7 |
| 未 dump、四态、同 tick、源码/配置不一致 | 值可用性、推断精度、时间轴、构建匹配状态 | 4 / 5 |
| 双 Ibex / RV32A Atomic Adapter | `hart_q` 最近更新与保持、仲裁及两个 hart 请求、源码与波形证据 | 4 / 7 |
| 精确执行覆盖、多实例回放、在线断点 | 语句映射、求值/提交配对、实时与回放一致 | 5 / 6 |

## 执行记录

每项工作完成且存在对应证据后勾选。每阶段完成时在本节记录日期、两仓库 SHA、修改文件、可复现命令和结果、支持范围及剩余限制。若仓库现状与方案冲突，记录变更理由并更新相关验收项。

| 日期 | 阶段 | 已验证的证据 |
| --- | --- | --- |
| 2026-11-20 | 3–7 | Linux x64 VSIX 来自包含在途修改的 Wave Workbench `3f103622` 和 VIDE `9592808f` 工作树。在 Linux VS Code 1.124.2 执行快速入门的 MCP 导出命令。Verilator 5.054 两份 VCD 在 tick 3 的 `owner_q` 为 0 和 1，在 tick 5 保持。优先 hart 1 的时间图有 28 个节点和 33 条边，另一构建在 tick 7 有 36 个节点和 52 条边。实测 VCS 同一对包的 RV32A 在线与离线日志逐字节一致，源码匹配，断点在 `375000 ps` 命中提交 121。 |
| 2026-11-19 | 0 | Wave Workbench `npm test` 通过类型检查和构建，17 项通过、8 项跳过。环境相关跳过覆盖真实 FSDB/KDB 和 Verilator 数据。 |
| 2026-11-19 | 0 | `cargo test --locked --manifest-path native/Cargo.toml` 通过，9 项通过、1 项 LZO 用例默认忽略。Cargo 经 `/home/user005/.cargo/bin` 调用。 |
| 2026-11-19 | 0 | `npm run test:ui` 通过，25 项通过、5 项跳过。该证据来自 Playwright，真实 VS Code 双插件联调待验收。 |
| 2026-11-19 | 0 | GitHub 确认 `AndreaFrederica/vide` 的父仓库为 `pascal-lab/vide`。本地 clone 与上游默认分支基线 SHA 一致。 |
| 2026-11-19 | 0 | VIDE 的 `crates/ide/src/references.rs` 仍用空引用分类，`semantic_index/build.rs` 调用该入口，`editors/vscode/src/extension.ts` 的 `activate` 尚无分析 API。Wave Workbench 的 `BackendProtocol.query` 已接收信号数组和字符串时间范围，`src/extension.ts` 的 MCP 启用条件排除原生 Windows。 |
| 2026-11-19 | 0 | 使用本机 Verilator 5.054 已生成的常规波形与 477 MiB FST 压力用例，运行 `node --test test/verilator*.test.js`，5 项通过。覆盖 VCD/FST 值、重复实例、源码映射和大文件晚时间点查询。复现生成方式见 [Verilator fixture](test/fixtures/verilator/README.md)。 |
| 2026-11-19 | 0 | VIDE 初始化 Slang 子模块 `ce0a6b0c0c20cd60af7f5190ebd799ea7c5e824a`，安装仓库固定 nightly。在 `editors/vscode` 运行 `npm ci` 和 `npm test`，编译成功且 55 项通过。 |
| 2026-11-19 | 0–1 | VIDE 使用仓库固定 nightly、GCC 14 和清理后的 C/C++ include 环境通过 `cargo test --workspace -j 4`。引用分类工作位于本地 `feature/reference-access-classification`，新增分类用例包括同一宏参数同时读写的源码映射。 |
| 2026-11-19 | 0 | OpenTitan 根目录现有 `vide.toml` 为 `sources = []`。用 MAC 仿真快照 `build/cv32e40p_mac_trace_vcs/latest` 的 `sources.f`、`manifest.json` 和构建脚本中的宏，在临时目录生成 `vide.toml`，加载 54 个 SV 文件和 2 个 include 目录。VIDE 1.3.0 报告项目 `loaded`、0 项加载错误，并从 `cv32e40p_mac_trace_tb` 的 DUT 实例定位到 `cv32e40p_dsp.sv`。参数覆盖、编译顺序等价及两个 target 切换仍待验证。 |
| 2026-11-19 | 0 | 实际生成 `hart0` 和 `hart1` 的 Verilator JSON、FST 和 VCD。启用 Trace 与原 Verilator fixture 后 Node 测试 27 项通过，5 项未启用真实 FSDB/KDB 环境。4 个新增 target × 格式组合均验证五个边沿或保持时刻的值，以及 DUT 与两个生成实例的路径。 |
| 2026-11-19 | 1–2 | VIDE `cargo test --workspace -j 4` 通过，679 项通过、9 项默认忽略。新增测试核对宏参数读写、单文件驱动和负载、触发边沿、组合环和三个预算限额。LSP 集成测试通过两个版本化请求。桌面扩展 `npm test` 55 项通过。 |
| 2026-11-19 | 3–4 | Wave Workbench 使用真实 Verilator FST，经扩展宿主测试中的 VIDE API 替身和真实本地 MCP stdio 桥，验证静态图、报告、实例定位与指定 tick 的波形观测。真实 VS Code 双扩展和跨层次语义仍待联调。 |
| 2026-11-19 | 3–4 | Node 测试 27 项通过，5 项真实 FSDB/KDB 相关用例跳过。Playwright 26 项通过，4 项环境相关用例跳过。宿主与 MCP 测试核对波形菜单、时序观测图和同 tick 的上升触发候选。 |
| 2026-11-19 | 2–4 | 用本地修改版 VIDE 进程，通过真实 LSP 分别加载 `hart0` 与 `hart1` 的 `vide.toml`，两次均返回 `owner_q` 的 7 个信号、4 条赋值和可求值守卫。将响应与匹配构建的 FST 一起送入 Wave Workbench 的观察与候选逻辑，查询 tick 7 时分别找到 tick 7 与 tick 3 的最近值变化。接收分支的触发和守卫在两组观测中一致。 |
| 2026-11-19 | 3–4 | 对两个构建的 FST 和 VCD，使用实际 Verilator JSON 验证 `active[0]` 与 `active[1]` 连到两个不同的生成实例。Node 28 项通过，5 项真实 FSDB/KDB 用例跳过。Filelist 预览用 OpenTitan MAC 快照验证 54 个带哈希源文件和 2 个 include 目录。 |
| 2026-11-19 | 3–6 | Linux VS Code 1.124.2 的隔离扩展宿主加载两个开发扩展，实际从 RTL 打开静态报告，再经 MCP 获取真实 FST 的 18 个信号、16 条赋值及连接、17 个时间节点。修正了 LanguageClient 将可选令牌序列化为位置参数数组的问题。 |
| 2026-11-19 | 5–6 | Verilator 5.054 生成同一构建的 FST 和 17 条执行事件。测试核对 tick 3 的等值 NBA 写入、tick 5 的保持和 tick 7 的条件断点，比较在线序列与离线回放，并验证不同波形哈希被拒绝。 |
| 2026-11-19 | 7 | 独立后端启用真实 FSDB/KDB、全芯片 FPU、Verilator 大文件、执行回放及在线 fixture，Node 35 项全部通过。 |
| 2026-11-19 | 7 | Linux Verdi NPI 测试的 Node 35 项与 Playwright 30 项通过。原生后端通过 Windows MSVC 和 macOS 的 x64、arm64 目标交叉 `cargo check`，原生 VS Code 运行验证仍待对应系统。 |
| 2026-11-19 | 0–4 | RV32A adapter unit sim 的 VCS 快照经 VIDE 分析，加载 189 个编译根、194 个源码或 include 文件。`hart_q` 的有界静态图包含 55 个信号、44 条赋值，涉及 `selected_hart`、`capture_atomic`、时钟和复位。修复了 Slang 未知宏来源导致的退出。 |
| 2026-11-19 | 4 | 通过 NPI 读取 1.37 GB 的 OpenTitan RV32A `add` FSDB，在 `4066041701 ps` 观测到 `hart_q` 从 0 到 1，与上升的时钟和 `selected_hart=1` 同时段。全芯片对应原始 KDB 缺失，编译来源未验证。同 tick 降低的 `capture_atomic` 无法从波形唯一排序。 |
| 2026-11-19 | 2–4 | Linux VS Code 1.124.2 使用 UI 为一个波形选择 filelist，并由 MCP 为第二个波形显式传入 filelist。两次构建身份均匹配，`owner_q` 在 tick 7 查询分别回溯到 tick 7 和 tick 3，各包含 18 个信号、16 条赋值及连接和 17 个时间节点。隔离会话另验证按 filelist 先后加载源码并切换宏分支。 |
| 2026-11-19 | 2–4 | OpenTitan MAC 的 VCS filelist 及实际构建命令提供的宏和顶层经同一生成路径加载，VIDE 回传 54 个有序编译根、58 个源文件及头文件、2 个 include 目录，并验证 TB 复位驱动和 DUT 定义跳转。 |
| 2026-11-19 | 7 | 更新后的 Linux Node 回归在独立后端和 Verdi NPI 后端均为 36/36。修改版 VIDE Rust 工作区通过 679 项、9 项默认忽略，桌面扩展 55 项通过。 |
| 2026-11-19 | 3 | 实际 Linux VS Code 宿主通过 MCP 保存 `.waveproj`，切换到工作区 VIDE 工程后重新打开该项目，恢复其 filelist 与仿真顶层。 |
| 2026-11-19 | 1–7 | 修改版 VIDE Rust 工作区通过 680 项、9 项默认忽略。两个 Linux x64 VSIX 在隔离 VS Code 宿主安装并验证了真实波形、两种 filelist 入口、项目重开、MCP 及报告。另用真实 Verilator harness 验证了暂停正在进行的步进。 |
| 2026-11-19 | 2–5 | 修改版 VIDE Rust 工作区通过 681 项、9 项默认忽略。真实 LSP 验证两个 `-GMode` 设置和展开诊断。真实 Linux VS Code 中通过 `wave_execution_trace` 回放 Verilator 记录，确认 tick 5 保持、tick 3 为最近提交，并返回流程图与详细报告。 |
| 2026-11-19 | 6 | Linux VS Code 启动实际 Verilator harness，MCP 设定 `owner_q` 条件断点并步进，在 tick 7 取到值 `1`、提交事件和在线时间图。 |
| 2026-11-19 | 3–4 | Linux VS Code 使用 Verdi NPI 打开 RV32A 单元仿真的 FSDB 和 KDB，并用仿真快照 filelist 启动隔离 VIDE。`hart_q` 的 MCP 图有 58 个信号、45 条赋值和 27 个波形绑定，回溯到 `275000 ps` 的 `0 → 1` 变化，包含 `selected_hart`、`capture_atomic` 和 `clk_i` 的观测。旧构建未携带内容哈希，匹配状态为 `unverified`。 |
| 2026-11-19 | 3–4 | 接入 NPI 端口关系后，以深度 2 从 RV32A `hart_q` 追到 `rv32a_atomic_adapter_tb.clk → dut.clk_i`。MCP 返回 15 个信号、7 条关系、11 个波形绑定。深度 10 的冷查询在 Debug 版 VIDE 下超过测试客户端的 80 秒，性能验收保持打开。 |
| 2026-11-19 | 2–4 | 两个 Verilator 仲裁构建的 FST 和 VCD 均验证 `owner_q <= grant[1]` 的 RHS 与观测值一致。真实 Linux VS Code 双扩展通过 `wave_trace_context`、隔离的 VIDE 配置和构建清单重放 FST，详细报告显示 `grant` 为 RHS 输入，Mermaid 时间图分别回溯到 tick 7 和 tick 3。 |
| 2026-11-19 | 2–4 | 真实 Linux VS Code 使用含相对路径的 `buildManifest` 自动加载第二个仲裁构建，核对有序源码、宏、构建身份和时序报告。已有 filelist 关联优先。 |
| 2026-11-19 | 4 | 用 Verilator 重建多标签 `case (grant)` 变体。在真实 Linux VS Code 的 MCP 报告中，tick 7 的两条候选 RHS 均计算为 `1`，守卫证据保留匹配分支并排除 `default`。 |
| 2026-11-19 | 7 | Wave Workbench Node 回归在独立后端和 Verdi NPI 后端下各 38 项通过。Playwright 29 项通过，百万信号用例换用 1.37 GB 的 RV32A `add` 波形后单项通过。VIDE Rust 工作区 682 项通过、9 项默认忽略，桌面扩展 55 项通过。 |
| 2026-11-19 | 5 | Verilator 5.054 双实例构建检查了生成的延迟临时变量，并生成一份 FST 和一份执行记录。Linux VS Code 1.124.2 的 MCP 对两个实例分别核对 tick 3 的阻塞写入与 NBA 覆盖、tick 5 的保持、源码哈希、Mermaid 和报告。命令面板和 MCP 单独打开同份 JSONL 的回放也通过。 |
| 2026-11-19 | 6 | 实际 Verilator harness 在 `owner.accept` 求值时命中语句断点。Linux VS Code 中通过 MCP 步进至 tick 3，暂停后用离线执行回放核对命中事件。独立后端与 Verdi NPI 后端的 Node 回归各 41 项通过。 |
| 2026-11-19 | 4 | Trace Explorer 回归用真实 Verilator FST 验证历史 tick 的定位和候选赋值源码链接，并核对三次快速 A 游标更新只显示最后一个位置的时间证据且复用静态图。Playwright 验证跳到窗口外的 tick 时，波形会调整窗口并显示 A 游标。 |
| 2026-11-19 | 4–5 | Linux VS Code 双扩展在同一个 MCP `wave_trace_context` 查询中读取真实 FST、执行记录和 VIDE 静态图，验证 tick 7 的 `owner_q` 提交关联到对应的 RTL 非阻塞赋值。 |
| 2026-11-19 | 7 | OpenTitan RV32A 单元仿真通过 Linux VS Code、Verdi NPI 和 Debug 版 VIDE 测得深度 2 冷查询 41.5 秒、同配置复查 12.0 秒。深度 3 在已加载会话中用时 16.0 秒，报告 21 个信号、20 条关系，MCP 结果正文 144003 字节。 |
| 2026-11-19 | 7 | 同一个 RV32A 用例使用 Release 版 VIDE，在持久化 filelist 会话下测得深度 3 冷查询 7.4 秒、复查 2.2 秒。深度 10 两次各约 9.5 和 9.4 秒，返回 120 个信号、127 条关系、55 个观测绑定，MCP 结果正文 576961 字节。两种深度均找到 `275000 ps` 的根信号变化。 |
| 2026-11-19 | 4–7 | Linux x64 Release 版 VIDE 和 Wave Workbench VSIX 安装到独立 VS Code 1.124.2 环境。实测两个实例的记录回放、无波形回放、在线语句断点和运行事件关联到 VIDE 静态赋值。 |
| 2026-11-19 | 7 | 本地 1.37 GB RV32A FSDB 的第一次 SHA-256 用时 5.72 秒，同一进程内两次复查各约 0.2 毫秒。同长度内容变更走独立回归用例。 |
| 2026-11-19 | 5 | 真实 VS Code MCP `wave_execution_map` 对两个 Verilator 实例各生成三条赋值映射。重复查询保持 ID 稳定，两个实例的 ID 各自独立。使用导出的映射封装真实 DPI 记录后，两实例的最终提交均可按生成的 ID 回放。 |
| 2026-11-19 | 4–5 | 双仲裁构建的 FST 和 VCD 均验证了游标保持分析。真实 Linux VS Code 的 `wave_trace_context` 在 tick 3 发现 `owner_q` 可能同值写入，执行记录确认提交。在 tick 5，守卫排除已列写入路径，执行记录确认保持。 |
| 2026-11-19 | 4 | Verilator 实测不同位宽的有符号和无符号加法、目标位宽内的进位及全等比较。真实 Linux VS Code 双扩展还验证了带符号 RTL 输入 `a` 的语义经 VIDE 进入 MCP，tick 5 的 4 位赋值结果为 `1111`，与 FST 值一致。 |
| 2026-11-19 | 5 | 从未插桩双实例 Verilator JSON 生成源副本和探针，重编译并产生真实 FST 与执行记录。回放核对选中实例的过程触发、阻塞求值与提交、NBA 求值和未选实例无事件。harness 提供 NBA 目标的实际值后，两次单写入也成功核对时槽结束提交。 |
| 2026-11-19 | 5–7 | 12.8 MB、125000 事件的记录回放在本机首次约 715 ms，随后约 12 ms。重复查询从序号 123161 后开始，变更日志会使旧检查点失效。回归同时覆盖 CRLF 和非 ASCII 实例名。 |
| 2026-11-19 | 3–4 | Verilator 5.054 的真实 FST 经 Linux VS Code 与 MCP 从 TB 的 `dut_response[5:4]` 回溯到 DUT 再到 TB 的 `tb_request[2:3]`。核对了 tick 5 的波形、Mermaid 位范围和 filelist 自动配置。回归另外验证复杂端口表达式的 Driver / Load 前沿。 |
| 2026-11-19 | 3 | 两个 Linux VSIX 安装联调后，使用同一仿真的反馈信号核对 `feedbackEdges`、Mermaid 反馈标记、详细报告与 tick 6 的 FST 值。 |
| 2026-11-19 | 4–7 | 使用实际 RV32A VCS 单元仿真的 FSDB、KDB 和 filelist，在 Linux VS Code 经 MCP 查询仲裁。两路请求在 `270000 ps` 同时有效，ready 为 `10`，`capture_atomic=1`。随后 `hart_q` 于 `275000 ps` 从 0 更新到 1。深度 8 的三个查询返回 86–120 个静态信号与 4–33 个时间节点，保留 5–11 个追踪前沿。 |
| 2026-11-19 | 3 | Linux VS Code 安装两份 VSIX。深度 1 的 MCP 查询在 `port_slice_tb.dut.result` 返回预算前沿。以下一次查询从该信号出发，成功继续回溯到 TB 的 `tb_request`。 |
| 2026-11-19 | 5–7 | Verilator 双实例样本运行 200001 个 tick，启用 FST。生成探针记录一个实例的过程、分支及两条赋值，产生 350000 个事件和约 95 MB 的 JSONL。三次运行的中位时间由 0.13 秒增至 0.93 秒，在七个 tick 核对六个信号的 FST 值相同。绑定波形及写入范围后，末尾查询首轮约 2.62 秒，复查约 5 ms。 |
| 2026-11-19 | 4 | 从 OpenTitan RV32A FSDB 导出 `hart_q` 的静态 Mermaid、时间因果 Mermaid、完整 JSON 与详细 Markdown。时间图含 50 个节点和 121 条边，其中 17 个节点为稳定采样，包括 `275000 ps` 的 `selected_hart=1`。 |
| 2026-11-19 | 5–7 | Linux 上用 Verilator 5.054 的生成模型实测 NBA 提交回调。两个实例在 tick 3 的最终提交序号分别为 31 和 30，回放核对实际值、覆盖关系和保持。Wave Workbench 两种后端各通过 48 项 Node 回归，Verdi NPI 路径通过 30 项 Playwright 验收。Windows 和 macOS 的 x64、arm64 原生后端通过交叉 `cargo check`。 |
| 2026-11-19 | 1–4 | Linux VS Code 1.124.2 安装两份 x64 VSIX，经 MCP 载入工作区之外的 `vide.toml`，核对宏、`q[index]` 的 bit 2 和赋值所属过程。重开 `.waveproj` 恢复同一清单。VIDE Rust 工作区通过 684 项、9 项默认忽略，桌面扩展通过 55 项。 |
| 2026-11-19 | 2–4 | Linux VS Code 1.124.2 的两份 x64 VSIX 经 `wave_trace_drivers` 使用显式构建清单，按相对路径加载 TB 并在分页返回时得到 `buildVerification.status=matched`、Mermaid 和续查游标。独立后端与 Verdi NPI 后端各通过 48 项 Node 回归。 |
| 2026-11-19 | 2–4 | 使用含三种环境变量路径写法的同一份 filelist 运行 Verilator 5.054 和 Linux VS Code 的两份 x64 VSIX。MCP 核对两份有序源码、带空格的 include 目录及其头文件，并从 VCD 的 `env_tb.q=1` 回溯到 TB 的 `src`。移除可选路径的环境变量后，追踪仍返回现有关系并报告编译缺口。 |
| 2026-11-19 | 2–4 | Verilator 5.054 从嵌套 filelist 的 `-v` 加载 DUT 库并生成 VCD。Linux VS Code 1.124.2 安装两份 x64 VSIX，经 MCP 分别用 filelist 和带 `library_files` 的构建清单加载，从 `env_tb.q=1` 追到库源码，再回到 TB 的 `src`，构建清单返回 `matched`。Slang 回归检验未实例化的库模块不参与顶层展开。 |
| 2026-11-19 | 2–4 | Verilator 5.054 使用两个 `-y` 目录和 `+libext+.sv+.v` 生成 VCD 和展开 JSON。Linux VS Code 1.124.2 安装两份 x64 VSIX，通过 MCP 自动加载首选 DUT 与回退目录中的子模块，绕过同名备用模块和未引用文件。从 `search_tb.q=1` 跨两层库追到 TB 的 `src`，独立构建清单核验为 `matched`。通过 `.waveproj` 更换关联设计后，报告切换到新的展开文件。两种后端各通过 49 项 Node 回归。 |
| 2026-11-19 | 2–4 | Verilator 5.054 实际用两个源码文件共享宏和 typedef 后生成 VCD。Linux VS Code 1.124.2 的 MCP 经显式分组清单和 `--single-unit` filelist 均从 `grouped_tb.q=10` 追溯到宏引用的 `src`，保持各自源码的位置。文件哈希和顺序相同而分组不同的清单核验为 `mismatched`。Slang 回归覆盖不同单元的宏隔离。 |
| 2026-11-19 | 2–4 | 两个源文件分别经 Verilator 预处理，使用各自的 `UNIT_CHOICE` 宏和同名 `options.svh`，再生成 VCD。Linux VS Code 1.124.2 的 MCP 经显式构建清单及 `-C` filelist 均得到 `matched`，并从 `options_tb.q=1` 追到 DUT 赋值和 TB 的 `src`。交换单元配置得到 `mismatched`，移除 include 路径后报告编译不完整，实际文件清单也不再包含对应头文件。VIDE 686 项、Wave Workbench 两种后端各 49 项回归通过。 |
| 2026-11-19 | 2–4 | Verilator 5.054 用 `-work` 编译两个含同名 `named_cell` 的库。Linux VS Code 1.124.2 用两份 VSIX 验证了两个 wrapper 分别跳到各自库中的声明，MCP 对 `pa=1` 与 `nb=0` 返回各自库的赋值和 TB 输入。filelist 与显式清单核验均为 `matched`，修改库归属得到 `mismatched`。Slang 原生回归通过 IEEE `config` 验证两条精确绑定。VIDE 687 项、Wave Workbench 两种后端各 49 项回归通过。 |
| 2026-11-19 | 2–4 | Verilator 5.054 使用 `-libmap` 的精确路径、通配符和目录规则加载两个命名库，IEEE `config` 交换同名实例的绑定。Linux VS Code 1.124.2 的两份 VSIX 经 filelist 和显式构建清单实测 `pa=0` 追到 `b/cell.sv`，`nb=1` 追到 `a/cell.sv`。重开 `.waveproj` 后恢复配置。替换同名、同大小的映射文件后重新分析并报告库归属及源哈希不匹配。VIDE 通过 688 项，Wave Workbench 两种后端各通过 50 项。 |
| 2026-11-19 | 1–4 | Verilator 5.054 生成含两个参数特化实例的 VCD 和展开树。Linux VS Code 1.124.2 安装两个 x64 VSIX，经 MCP 自动从构建清单加载 TB。四个输出分别匹配命名 `if/else generate`、嵌套过程赋值及 `case generate` 的活动分支。静态图、三个边的时间链和详细报告回溯到正确的 TB 输入。Load 查询排除未展开赋值。无名分支返回 `unresolvedGenerateBranch`，TB 的 `#delay` 仍使完整静态覆盖为 partial。VIDE 通过 688 项，Wave Workbench 两种后端各通过 51 项。 |
| 2026-11-19 | 2–6 | Linux VS Code 1.124.2 的 MCP 自动发现 VCD 旁的构建清单并核验实际载入的两个 Verilator 展开文件。分别提供错误的展开树哈希和元数据哈希时得到 `mismatched`，保留 VCD 根值并省略时间因果图。独立在线 harness 在 tick 5 复现元数据差异，保留 bit 2 的观测值。匹配的展开文件仍可进行在线因果追踪。 |
| 2026-11-19 | 1–4、7 | Verilator VCD 与两份 Linux x64 VSIX 实测 `#(latency) wait (ready) q = data`。MCP 将 `latency` 和 `ready` 记录为控制依赖，`data` 记录为数据依赖，两项控制信号均可反向查询到该赋值。波形在 tick 9 观测到 `q=1`，赋值标为 `possible`。VIDE 工作区 689 项通过、9 项默认忽略。Linux Verdi NPI 环境 30 项 Playwright 用例全部通过。 |
| 2026-11-19 | 4、7 | 用手工写入的 VCD 和由该 VCD 转换的 FST 复现 tick 5 的 `1 → 0 → 1`。Linux VS Code 1.124.2 两份 VSIX 的 MCP 在指定和自动历史模式下均返回三个根节点、18 条候选边，以及两个可能触发的上升沿。常规波形查询仍返回该 tick 末值。独立和 Verdi NPI 后端各通过 52 项 Node 测试。 |
| 2026-11-19 | 4–5、7 | Linux VS Code MCP 对实际 Verilator 调度器日志及匹配 FST 核验了执行关联。第二实例 tick 1 的波形变化对应提交 14，同值提交 3 出现在执行序列。tick 3 的两个实例分别记录了提交 26、31 和 19、30，FST 均省去了中间变化，报告返回 `sequenceDiffers`。独立和 Verdi NPI 后端各通过 53 项 Node 测试。 |
| 2026-11-19 | 7 | Linux VS Code 复跑 RV32A adapter 的 `hart_q`，tick 280000 观测到 1，最近变化在 tick 275000。复用端口分析前后时间图、静态赋值和信号逐项一致。五次热静态查询中位数从 3875 ms 降到 382 ms，四次热动态查询中位数从 3823 ms 降到 396 ms，单次冷静态查询约 6.5 s。剖析记录中的热动态追踪执行一次批量波形查询，缓存命中时该调用耗时低于 1 ms。真实子模块修改使 VIDE revision 从 3 变为 4，MCP 上游输入从 `a` 切换为 `b`。 |
| 2026-11-19 | 7 | 同 tick 读盘改动后，Windows MSVC 和 macOS 的 x64、arm64 后端通过交叉 `cargo check`。原生 VS Code 及 MCP 运行待对应系统验收。 |
| 2026-11-19 | 1–4 | Verilator 5.054 与 Linux VS Code MCP 验证同一声明的 `left.internal_a` 和 `right.internal_a` 保持独立。跨文件 Driver 追踪经 XOR 及两个叶实例各自的赋值返回 TB 输入。tick 5 观测为左 1、右 0、输出 1。反向追踪从左实例到 XOR 和独立的观察实例，右实例只到 XOR。深度预算在叶实例声明处报告前沿，缺少展开读取信息时返回 `unresolvedHierarchicalRead`。VIDE 690 项通过，Wave Workbench 两种后端各通过 53 项。 |
| 2026-11-19 | 1–4 | Linux VS Code MCP 结合真实 Verilator VCD，区分 TB 对两个同模块实例的直接写入。Driver 找到 `l.q = a` 与 `r.q = b` 各自的源码和输入，Load 从各输入到达对应 TB 输出。波形观测左路为 1，右路为 0。VIDE 691 项通过，独立和 Verdi NPI 后端各通过 53 项。 |
| 2026-11-19 | 3–4 | 两个 writer 实例执行同一源码语句并写同一目标时，MCP、Markdown 报告及静态图保留两个赋值实例。真实 Linux VS Code 实测返回 `dual_tb.first` 和 `dual_tb.second`，两条赋值均定位到同一目标及源码位置。 |
| 2026-11-19 | 2–4 | 文件级层次访问前沿随 LSP 返回具体位置。实测已核对的层次读写由展开图提供关系，去除相应的未解析提示。缺少绑定信息的展开树仍返回部分图及未解析原因。 |
| 2026-11-19 | 1–4 | 真实 Verilator VCD 和 Linux VS Code MCP 验证两条命名 modport 通道。输出 `p` 在 tick 2 沿 `x.datum` 追到 `a`，`n` 在 tick 5 沿 `y.datum` 追到 `b`。增加一层接口转接模块后，静态和动态图保持正确的通道绑定，Load 查询各自到达对应输出。VIDE 692 项通过、9 项默认忽略。 |
| 2026-11-19 | 1–4 | Linux VS Code 1.124.2 经 MCP 分别打开 VCS T‑2022.06‑SP2 和 Xcelium 23.09-s013 的真实 VCD，并绑定同一源码的 Verilator 5.054 展开树。两组报告的 `p` 在 tick 3 沿 `x.datum` 追到 `a` 在 tick 2 的路径，`n` 在 tick 5 沿 `y.datum` 追到 `b`。Load 图分别保留显式读写别名的源码位置及实际接口实例。Verilator 5.054 生成该样例的仿真模型时出错。VIDE 692 项通过、9 项默认忽略。 |
| 2026-11-19 | 1–4 | VCS `-kdb` 生成的数据库中，`alias_tb.x.datum` 与 `alias_tb.y.datum` 解析到各自的接口实例与同一个 `channel` 类型定义。独立 Rust KDB 与 Verdi NPI 各通过 54 项 Node 测试，包括真实 OpenTitan 产物。 |
| 2026-11-19 | 1–4 | 将接口、写端、读端及 testbench 分开编译。Linux VS Code 1.124.2 通过 Verdi NPI 装载 VCS T‑2022.06‑SP2 KDB 和同次仿真的 FSDB、VCD。两份波形均用 MCP 验证 `p` 在 tick 2 的变化经 `x.datum` 关联到 `a`，`n` 在 tick 5 经 `y.datum` 关联到 `b`。静态 Load 图保留对应读端的源码位置。直接查询 FSDB 中的读写别名也映射到各自底层成员，读到正确的波形值。VIDE 692 项通过、9 项默认忽略。独立模式和 NPI 模式各通过 54 项 Node 测试。 |
| 2026-11-19 | 1–4 | 在 VCS 样例的第一条通道各加一层写端和读端转接模块，第二条通道保持直连。重新生成 KDB、FSDB 和 VCD，在真实 VS Code MCP 重跑动态因果、底层成员 Load 和 FSDB 读写别名查询，两条通道分别保持正确的实例映射。另用正式端口与接口类型同名的构建核对了同一声明行出现多个候选 token 时的绑定。 |
| 2026-11-19 | 3–4 | Linux VS Code 1.124.2 使用独立 KDB 与 FSDB 后端验证跨文件的 VCS 样例。MCP 从 `p`、`n` 和 `q` 分别追到 `a`、`b` 和 `d`，从 `other` 经 `gen.lg`、`gen.internal` 追到 TB 的 `b`。Load 图保留匹配输出，拼接返回 `unresolvedPortExpression`。实际 OpenTitan MAC KDB 的回归核对了 TB 时钟、DUT 时钟及核实例的输入方向。独立模式 55 项通过，NPI 模式 54 项通过并跳过独立专用用例。 |
| 2026-11-19 | 3–4 / 7 | 修复 OpenTitan RV32A adapter FSDB 的旧式声明组读取。独立读取器与 Verdi 对照得到相同的 180 个信号路径、位宽和 280000 ps 的采样值，时间单位和结束时间也一致。真实 Linux VS Code 经 MCP 在独立模式下查询 `hart_q`，tick 280000 的观测值为 1，最近变化为 275000 ps。深度 6 返回 52 个信号、60 条赋值及因果图。从 TB 时钟发起 Load 可到达 DUT 的 `clk_i`。 |
| 2026-11-19 | 7 | 增加 RV32A FSDB 的端口归属和时间跳转回归后，独立模式 56 项通过，Verdi NPI 模式 55 项通过并跳过独立专用用例。macOS、Windows 的 x64 和 arm64 目标均通过 Rust `cargo check`。真实 Linux MCP 打开损坏 FSDB 时返回读取器诊断，随后同一会话成功打开并追踪 RV32A 波形。 |
| 2026-11-19 | 3–4 | Linux VS Code 1.124.2 用 VCS FSDB、独立 KDB 和同构建的源码清单完成 8 个 MCP 动态查询。端口边保留 `tb_request[2:3]` 到请求端、结果端到 `dut_response[5:4]` 的映射，tick 5 读到 `00100000`。两个固定 indexed part-select 同为 `10`。符号扩展、零扩展、四态字面量和填充常量分别与 `11`、`01`、`xz`、`11` 的波形值一致。动态索引两端报告停止。同一源码行出现端口声明和使用时，VIDE 返回的声明位置可消歧。独立模式 57 项通过，NPI 模式 55 项通过并跳过两项独立专用用例。 |
| 2026-11-19 | 3–4 / 7 | 用包含端口选择和常量的 Linux VSIX 复跑 OpenTitan RV32A adapter，`hart_q` 在 280000 ps 为 1，最近变化仍在 275000 ps，TB 时钟 Load 到达 DUT。macOS 和 Windows 的 x64、arm64 目标通过原生读取器的 Rust `cargo check`。 |
| 2026-11-19 | 3–4 | 扩展同一 VCS fixture，Linux VS Code MCP 核对 12 个动态查询。按波形游标的源值计算，固定选择的四种端口转换分别得到补零 `0010`、截断 `01`、符号扩展到输出切片 `1110`、二态转换 `10`，均与目标波形一致。同 tick 更新保留调度顺序未知标记。独立 FSDB 与 Verdi 的 48 个信号路径、位宽和两个采样时刻一致。独立模式 58 项通过，NPI 模式 56 项通过并跳过两项独立专用用例。 |
| 2026-11-19 | 3–4 | 扩展 VCS fixture 至 17 个 MCP 动态查询。五种整信号端口转换的游标求值与 FSDB 一致，包括参数化端口按展开宽度执行的符号扩展，以及无符号信号接入有符号输入时的补零。 |
| 2026-11-19 | 3–4 | Linux VS Code MCP 使用真实 VCS FSDB 和 KDB，核对升序、降序和含负下标的三组模块实例数组。六个数组成员的切片及广播输入与波形一致，三个输出为 `1001`、`0110`、`00111100`。Load 查询从共享输入到达两个数组成员。修正独立 FSDB 对合法多边连接图的边数校验，25 个信号在采样点与 Verdi 一致。 |
| 2026-11-19 | 3–4 | 用扩展后的实例数组夹具验证定宽字面量。MCP 把四位常量分别追踪到两个实例的 `10` 与 `01`，把同宽有符号常量 `10` 广播给两个实例。FSDB 输出分别为 `1001` 和 `1010`，报告保留每个实例的常量关系。 |
| 2026-11-19 | 3–4 | 以同一 VCS KDB 和 FSDB 在 Linux VS Code 完成 20 个 MCP 动态查询。动态输入位选 `tb_request[index]` 在 tick 5、6、7 的求值与波形一致，结果为 `1`、`0`、`x`。Driver 图保留数据与索引，Load 查询从 `index` 到达 `dynamic_bit` 并保留 `tb_request` 作为另一操作数。用此次 VSIX 复跑数组输出、常量和广播，以及 OpenTitan RV32A Adapter 的时钟 Load 与 `hart_q` 时间因果。 |
| 2026-11-19 | 7 | 独立模式通过 60 项，NPI 模式通过 57 项并跳过三项独立专用用例。macOS 和 Windows 的 x64 及 arm64 原生读取器通过 Rust 交叉检查。 |
| 2026-11-19 | 2–4 / 7 | VCS T-2022.06-SP2 编译三个带 TB 顶层参数覆盖的构建并输出 KDB 和 FSDB。Linux VS Code 1.124.2 运行九次 MCP 查询，核对隔离 VIDE 的顶层、宏、include 目录和头文件。`USE_B=0` 从 `from_a.dut` 回溯到 `stimulus_a`，波形为 `0011`。`USE_B=1` 及重复覆盖 `0 → 1` 均从 `from_b.dut` 回溯到 `stimulus_b`，波形为 `1100`。三个同名构建清单均自动加载且返回 `matched`。详细报告及 Mermaid 时间图已核对。独立模式通过 61 项，NPI 模式通过 58 项，跳过三项独立专用用例。 |
| 2026-11-19 | 3–4 / 7 | 真实 VCS KDB 和 FSDB 在 Linux VS Code 1.124.2 验证 40 次动态 MCP 查询，其中 20 次核对四种动态范围连接的实际波形。覆盖升降序、`+:`、`-:`、参数宽度、负索引、X/Z 和越界。另核对八次静态 Driver / Load 查询及 Trace Explorer 的索引标签。索引在 tick 6 单独变化时，时间图保留索引边并标记同 tick 顺序未知。独立 FSDB 与 Verdi NPI 对采样值一致。四个 macOS 和 Windows 架构的读取器通过 Rust 交叉检查。 |
| 2026-11-19 | 3–4 | 真实 VCS KDB 和 FSDB 在 Linux VS Code 1.124.2 验证八种输入端口表达式，共 24 次 MCP 时间查询。各端口的表达式求值与独立 FSDB 和 Verdi NPI 采样一致，覆盖嵌套拼接、四态常量、动态位选、按位运算、符号扩展、截断及二态转换。Load 追踪覆盖五个读取同一掩码的实例，并保留各自其他操作数。重复拼接的 Driver 查询保留 `unresolvedPortExpression`。修正独立 FSDB 的内联 X/Z 常量顺序并补齐两种文本表达式操作。 |
| 2026-11-19 | 7 | 端口表达式更新后，独立模式通过 63 项。NPI 模式通过 59 项，跳过四项独立专用用例。macOS 与 Windows 的 x64、arm64 读取器通过 Rust 交叉检查。 |
| 2026-11-19 | 3–4 | VCS 的 KDB 与 FSDB 在 Linux VS Code 1.124.2 验证 48 次 MCP 时间查询，其中 24 次覆盖三种重复拼接和三种复合索引。两种 FSDB 后端对采样一致。窄索引加法在 tick 8 溢出回绕，`complex_bit` 由 `x` 变为 `1`。Mermaid 时间图标出 `index` 和 `offset`，Load 图核对单个操作数的下游，零次重复项不产生依赖。 |
| 2026-11-19 | 3–4 | VCS KDB 与 FSDB 在 Linux VS Code 1.124.2 验证循环 generate 的三个迭代 `[-1]`、`[0]`、`[1]`，含内部条件分支。24 次 MCP 实例时间查询与 8 次总线查询覆盖固定端口位映射、局部参数 `0/2/4` 及运行时 `shift`。Driver 图核对输出位 `1/2/5`，Load 图从 `shift` 到达三个动态索引端口。VCS FSDB 转义负下标与 KDB 名称的绑定经正反两个查询方向核对，两种 FSDB 后端的 16 个信号在四个采样点一致。 |
| 2026-11-19 | 7 | 循环 generate 端口更新后，独立模式通过全部 65 项。NPI 模式通过 60 项，跳过五项独立专用用例。macOS 与 Windows 的 x64、arm64 读取器通过 Rust 交叉检查。 |
| 2026-11-19 | 1–4 | Linux VS Code 1.124.2 使用修改版 VIDE、真实 VCS KDB 和 FSDB 完成循环 generate 的九次 MCP 时间查询及三次 Load 查询。迭代 `[-1]`、`[1]` 的连续赋值追到 `src_a`，迭代 `[0]` 追到 `src_b`，三条路径均保留各自的 `intermediate` 和共享的 `gate`。报告和 Mermaid 图核对了实际分支、源码位置与独立的局部波形变化。 |
| 2026-11-19 | 7 | 修改版 VIDE Rust 工作区通过 692 项，默认忽略九项。Wave Workbench 独立模式通过 66 项，NPI 模式通过 60 项并跳过六项独立专用用例。真实 VS Code 复跑 Verilator 的四个条件 generate 输出，核对实际分支、上下游、同 tick 候选及展开文件的哈希校验。 |
| 2026-11-19 | 1–4 / 7 | 真实 VCS KDB 和 FSDB 在 Linux VS Code 1.124.2 验证 genvar 位选。三个展开实例分别读 `input_bits[-1]`、`input_bits[0]`、`input_bits[1]`，写 `output_bits[2]`、`output_bits[1]`、`output_bits[0]`。MCP 核对三个单比特时间查询、总线 Driver / Load 及迭代报告，并复跑九次局部信号时间查询和三次 Load 查询。独立模式 66 项通过，NPI 模式 60 项通过。 |
| 2026-11-19 | 7 | Linux VS Code 1.124.2 的两个扩展宿主同时打开同一工作区，分别用同构建的两份 FSDB 运行 MCP 时间查询。未指定波形时提示消歧，指定后得到各自的因果图和详细报告，关闭窗口后移除对应 socket。Node 22.22.2 的 Windows x64 程序经 Wine 6.0.2 运行相同 MCP 冒烟，通过真实 Windows 版 Node 的命名管道接口核对注册、路由、凭证、取消和清理。Linux 包冒烟也通过。 |
| 2026-11-19 | 3–4 / 7 | 真实 VCS KDB 和 FSDB 在 Linux VS Code 1.124.2 验证静态按位 Driver。`ascending_bus[1]` 经 `lanes[3]`、`lanes[2]`、`lanes[0]` 到达 `seed`，同一总线中的其他写入按位过滤。`lanes[4]` 的寄存器反馈保留环路标记。核对 MCP 分页、Mermaid、详细报告、Trace Explorer 展开及 tick 5 的波形观测。独立后端通过 67 项，Verdi NPI 后端通过 61 项并跳过六项独立专用用例。 |
| 2026-11-19 | 3–4 / 7 | 使用真实 VCS 波形及 Linux VS Code 1.124.2 验证固定范围。MCP 对升序 `ascending_bus[1:2]` 向上追到 `seed` 与 `enable`，从降序 `lanes[3:2]` 向下追到 `ascending_bus[1]`，`lanes[5:4]` 的 Load 查询标出寄存器反馈。核对了 Mermaid、详细报告、分页及 Trace Explorer 逐位展开。回归包含 256 位映射及动态索引的候选保留。独立后端通过 67 项，Verdi NPI 后端通过 61 项并跳过六项独立专用用例。 |
| 2026-11-19 | 4 / 7 | 真实 VCS FSDB 在 Linux VS Code 1.124.2 通过 MCP 验证按位时间图。`ascending_bus[1]` 在 tick 5 经 `lanes[3]`、`lanes[2]` 和 `lanes[0]` 回溯到 `seed`。在 tick 6 用自动历史查询仍定位到 tick 5。同 tick 边注明顺序未知。对 `lanes[2]` 的查询直接追溯同一总线的 `lanes[0]`，Trace Explorer 的时间节点显示位下标。独立后端通过 67 项，Verdi NPI 后端通过 61 项并跳过六项独立专用用例。 |
| 2026-11-19 | 4 / 7 | Linux VS Code 1.124.2 用真实 VCS KDB 和 FSDB 复跑 40 次 MCP 时间查询和八项索引静态检查。tick 5 的 `dynamic_bit` 追溯到 `tb_request[2]` 及索引，`ascending_plus` 同时显示变化的 bit 2 和稳定的 bit 3。tick 6 和 7 的索引发生同 tick 变化，时间图保留总线级候选。回归另覆盖负索引和部分越界。独立后端通过 68 项，Verdi NPI 后端通过 62 项并跳过六项独立专用用例。 |
| 2026-11-19 | 4 / 7 | 两级流水线使用 VCS 生成 KDB 和 FSDB，Linux VS Code 1.124.2 通过 MCP 验证 `second_q` 在 tick 9 和 13 的更新。时间图的 RHS 兼容样本分别来自 `first_q` 在 tick 5 和 9 的变化，再追到更早的 `d`。同 tick 的 `first_q` 新值仍列为候选，并标注 RHS 比对结果。构建身份核验为 `matched`。独立后端通过 69 项，Verdi NPI 后端通过 63 项并跳过六项独立专用用例。 |
| 2026-11-19 | 4 / 7 | Linux VS Code 1.124.2 使用真实 VCS 流水线波形的 MCP 结果验证 Trace Explorer 分支。在 tick 9 和 13 展开 `second_q`、候选赋值、前一周期 `first_q` 和更早的 `d`，核对 RTL 行号、跳转参数、RHS 比对标签和刷新后的旧节点处理。Verilator FST 扩展回归覆盖波形入口和游标跳转，单元回归覆盖反馈与历史缺口。独立后端通过 70 项，Verdi NPI 后端通过 64 项并跳过六项独立专用用例。 |
| 2026-11-19 | 5 / 7 | Verilator 5.054 双实例生成模型通过 `scheduler` 自动插桩，真实 FST 和 JSONL 经 Linux VS Code 1.124.2 的 MCP 验证。两个实例在 tick 3 的提交序号为 31 和 30，各有两次 NBA 覆盖。另编译运行直接写入模型，核对 tick 1 和 3 的两个提交。含额外存储的模型返回诊断，安装版脚本生成相同的 C++ 插桩结果。独立后端通过 70 项，Verdi NPI 后端通过 64 项并跳过六项独立专用用例。 |
| 2026-11-19 | 6 / 7 | 同一个自动插桩 Verilator 5.054 双实例模型生成 FST 和离线记录并运行在线 harness。在 Linux VS Code 1.124.2 中，MCP 分别命中 tick 1 的实际提交序号 15 和 tick 3 的 NBA 覆盖序号 22。在线执行图与报告覆盖 16 个事件，逐条核对离线记录、实例、语句 ID 和匹配的 RTL 源码，清除断点后正常运行至 tick 5。回归验证精确提交断点跳过时间槽末尾采样。独立后端通过 71 项，Verdi NPI 后端通过 65 项并跳过六项独立专用用例。 |
| 2026-11-19 | 6 / 7 | Linux VS Code 1.124.2 用真实 Verilator 双实例模型验证 MCP `notifications/cancelled`。在 tick 1 快照等待期间取消五周期步进，释放快照后暂停于 tick 1，并保留 NBA 提交事件 15。新的单周期步进到 tick 3，随后推进到 tick 5 并正常退出。独立后端通过 72 项，Verdi NPI 后端通过 66 项并跳过六项独立专用用例。 |
| 2026-11-19 | 4 / 6 / 7 | Linux VS Code 1.124.2 用同一个 Verilator 双实例可执行文件产生参考 FST 并运行在线 harness。MCP 核对启动时的 SHA-256、参考波形、时基、展开树、源码和 VIDE 编译配置，结果为 `matched`。错误的 harness 哈希返回 `mismatched`，保留实时采样和 16 条执行事件。省略哈希的旧清单返回 `unverified` 并保留时间图。独立后端通过 72 项，Verdi NPI 后端通过 66 项并跳过六项独立专用用例。 |
| 2026-11-19 | 7 | Linux 上用 Verilator 5.054 运行双实例的 100000 个时间槽，五次计时的中位数分别为原始模型 10.1 ms、DPI 探针 449.7 ms、带 NBA 提交点的探针 625.1 ms。计时关闭波形并把事件输出到 `/dev/null`，含事件格式化和运行时记录成本。产生 FST 和文件日志的单次运行分别为 36.6、608.7 和 834.8 ms。DPI 和提交点模型分别记录 60 万和 80 万个事件，原始 JSONL 分别为 172803760 和 246144506 字节。独立读取器逐项比对三个 FST 的 100001 次输出采样，结果一致。 |
| 2026-11-19 | 5 / 7 | 回放 Verilator 5.054 的 80 万事件记录，查询末尾窗口获得 40 条事件和完整覆盖。进程内首次 3069.7 ms，复查 5.4 和 4.8 ms，复查从序号 799119 后恢复，事件与首次逐条一致。Linux VS Code 1.124.2 的实际 MCP 客户端取消冷查询后可以重查，随后复查命中检查点并得到相同事件。 |
| 2026-11-19 | 1–4 / 7 | 真实 VCS FSDB 和 Linux VS Code 1.124.2 验证过程覆盖。`net_out` 的静态图包含普通驱动、`force` 和 `release`，`temporary` 包含过程 `assign` 和 `deassign`。`stimulus` 的 Load 图返回两条覆盖关系。MCP 核对 tick 3 的强制值和 tick 5 释放后的观测，动态候选标明时序缺口。VIDE 694 项通过、九项默认忽略，Wave Workbench 独立模式通过 72 项，NPI 模式通过 66 项并跳过六项独立专用用例。 |
| 2026-11-19 | 1–4 / 7 | 使用真实 VCS FSDB 在 Linux VS Code 1.124.2 验证位置和命名 task 调用及嵌套 function 调用。MCP 从三个结果追到显式实参 `data` 和子程序读取的 `config_bit`，包含被调用函数中读取点的源码坐标。六次时间查询核对 tick 2 和 tick 4 的实际变化，Load 图覆盖两个 task 调用。每个调用处保留内部副作用缺口。VIDE 695 项通过、九项默认忽略。 |
| 2026-11-19 | 1–4 / 7 | Linux VS Code 1.124.2 使用独立 KDB 和 FSDB 读取器复跑真实 OpenTitan RV32A 仲裁。修复 `generate` 内断言动作的词法作用域及 KDB 的 `longint` 声明。MCP 在 `270000 ps` 观察到 ready 为 `10`、`capture_atomic` 为 `1`，在 `280000 ps` 查询确认 `hart_q` 最近于 `275000 ps` 更新为 `1`。三个时间图分别有 10、12、69 个节点。 |
| 2026-11-19 | 1–4 / 7 | VCS T-2022.06-SP2 以 filelist 编译生成模块、生成头文件及 `runtime_inputs_tb`。Linux VS Code 的 MCP 使用波形旁清单或显式 filelist，核对两个有序编译根、生成头文件与实际顶层。同一可执行文件跑两组运行输入，tick 5 分别得到 `result=0101`、`file_result=1010` 和 `result=0000`、`file_result=0011`。详细报告定位两个 plusarg 和一个 `$readmemh` 调用，保留观测与运行期输入缺口。 |
| 2026-11-19 | 1–4 / 7 | 用 VCS 编译 SystemVerilog DPI import 和实际 C 实现。Linux VS Code 的 MCP 在 tick 5 从返回值 `result=6` 和输出参数 `side_effect=7` 追到同一 SystemVerilog 调用与输入 `input_arg`。Load 从输入到达两个结果。时间图保留波形值、调用点和未记录的副作用。VIDE 698 项通过、九项默认忽略。Wave Workbench 独立后端 72 项通过，Verdi NPI 后端 66 项通过并跳过六项独立专用用例。 |
| 2026-11-19 | 1–4 / 7 | Linux VS Code 1.124.2 用 VCS KDB 和 FSDB 完成 12 次 MCP 时间查询。六种循环的时间图保留时钟边沿、循环条件和迭代缺口。`repeat` 计数的 Load 图到达循环内赋值。自增计数从 1 到 2，前置自减和接收值均为 8。`write_lanes[cursor++]` 返回对 `cursor` 和 `write_lanes` 的两处写入，`for` 初始化和步进分别保留各自依赖。详细报告定位循环及自增、自减的位置。VIDE 700 项通过、九项默认忽略。 |
| 2026-11-19 | 4 / 7 | Linux VS Code 1.124.2 用 Verilator 生成的真实 VCD 和 VCS 选择性采集的 FSDB 验证未采集依赖。`q` 在 tick 5 为 1，时钟边沿仍可核对，Mermaid 和 Markdown 将 `hidden_data` 缺口连到该次变化和实际赋值行。修复独立 FSDB 的选择性声明读取，独立与 Verdi NPI 后端均通过标量及 `[7:4]`、`[-1:2]` 向量的样本核对。 |
| 2026-11-19 | 4 / 7 | VCS 仿真中 261 路输入汇入同一赋值。MCP 时间图达到 256 个节点并返回前沿。从缺口中的 `d_255` 和 tick 2 再查，追到同 tick 更新的 `input_data`。回归也覆盖边预算、首个时钟样本缺少前值，以及 Trace Explorer 按缺口 tick 续查。独立后端通过 74 项，Verdi NPI 后端通过 68 项并跳过六项独立专用用例。 |
| 2026-11-19 | 4 / 7 | 261 路扇入结果的时间图按 Mermaid 默认文本和边限制分成三页。Chromium 实际渲染三份 SVG，分别包含 500、397 和 130 条关系，与时间图的观测边及缺口逐项计数一致。Markdown 报告嵌入全部页面，MCP 返回 `temporalMermaidPages`。 |
| 2026-11-19 | 3–7 | 同一 VCS 样例在真实 Linux VS Code 通过 MCP 导出 528 条 Driver 赋值和 262 条 Load 赋值。Chromium 渲染各三页，分别核对 1312 和 1046 条有向关系。所有静态图页出现在 Markdown 中，`pageCursor` 仍从第 64 条赋值续查。波形观测和执行图的分页压力用例分别渲染 509 和 1198 条关系。 |
| 2026-11-19 | 3–7 | 真正的 VCS 按位 Driver / Load 回归再次通过，并检查保留的每个赋值输入都有信号节点。Verilator 在线样例核对 16 条执行事件，80 万事件的离线回放复跑取消及再查询。独立后端通过 75 项，Verdi NPI 后端通过 69 项并跳过六项独立专用用例。 |
| 2026-11-19 | 4–7 | Verilator 5.054 的两级流水线在同一日志中记录 `first_q` 和 `second_q` 的实际 NBA 提交。补齐调度器中先读当前寄存器值、再将临时值写回整信号的生成形式。Linux VS Code 的同一 MCP 查询从 `second_q` 在 tick 3 的提交 8 回溯到 `first_q` 在 tick 1 的提交 4，再追到 `value`。移除上游语句哈希后保留波形候选。复跑双实例竞争时，完整的波形变化选中提交 14，合并同 tick 中间变化的波形保留差异。Trace Explorer 核对实际赋值和序号，Webview 测试核对录制追踪菜单入口。 |
| 2026-11-19 | 5–7 | 在线冷启动复跑在 VIDE 初次索引时收到 `ContentModified`，追踪查询等待索引就绪后完成。再次核对提交断点 15、覆盖断点 22、16 条在线和离线事件及构建身份。80 万条执行记录的回放仍可取消、重查并复用检查点。 |
| 2026-11-19 | 5–7 | Linux VS Code 1.124.2 与 Verilator 5.054 验证 `wave_live_trace` 和 **Trace Live Signal**。在线与离线时间图从 `second_q` 的 tick 3、提交 8、求值 7 回溯到 `first_q` 的 tick 1、提交 4、求值 1。双实例再次核对提交 14 和求值 5，篡改日志值或波形哈希后保留原始在线事件，时槽末采样省略中间写入时保留 `sequenceDiffers`。独立后端通过 79 项，Verdi NPI 通过 73 项并跳过六项独立专用用例。 |
| 2026-11-19 | 2–4 / 7 | 使用 VCS T-2022.06-SP2 编译两个库目录中存在同名模块的 testbench。实际 KDB 指向第一个目录，VCD 在 tick 2 记录 `result=1`。在 Linux VS Code 1.124.2 中关联原 filelist，独立 KDB 和 Verdi NPI 均仅向隔离 VIDE 配置加载实际使用的 `leaf_model.sv`。MCP 的静态 Driver 和动态查询均定位到实际库赋值，构建身份为 `matched`。 |
| 2026-11-19 | 2–4 / 7 | Linux VS Code 1.124.2 从实际 VCS `vcs_rebuild` 自动加载双库样例和 OpenTitan MAC 仿真。双库样例核对显式清单优先。OpenTitan 恢复 54 个编译根及实际 TB 顶层，独立 KDB 保留无法读取的端口缺口和已解码的端口边。MCP 从核心时钟沿静态图回到 TB 的 `clk_dsp_i`，动态时间图也跨越 DUT 和 TB。独立后端通过 81 项，Verdi NPI 通过 75 项并跳过六项独立专用用例。 |
| 2026-11-20 | 2–4 / 7 | Linux VS Code 1.124.2 用真实 VCS 双库仿真核对 filelist 预览与 VIDE 实际编译配置相同，包含工作区外的 TB 及 KDB 选中的库源码。MCP 的静态 Driver 与时间图均通过构建核验。用真实 OpenTitan MAC FSDB 再次验证自动恢复 54 个编译根、TB 顶层和从 DUT 回到 TB 的静态与动态时钟追踪。报告保留未转换的 VCS timescale 和 PLI 参数。独立后端 98 项通过。 |
| 2026-11-19 | 4–7 | OpenTitan MAC 独立 KDB 遇到未解码的封装常量输入后继续读取同一实例的其他端口。断言核对 TB 时钟、后续的 `intr_done_o → intr_done` 以及 `corei_tl_h_i` 的独立缺口。改动通过 macOS 和 Windows 各两个架构的 Rust 交叉检查。 |
| 2026-11-19 | 4–6 | Verilator 5.054 的真实 DPI 模型记录实参及返回值。Linux VS Code 1.124.2 在 tick 3 将值 4 和 8 及两个 C++ 位置关联到 RTL 求值 4、提交 5。在线与离线的归因一致，更改记录中的 C++ 源哈希后，时间图显示该来源已变化。独立后端通过 82 项，Verdi NPI 通过 76 项并跳过六项独立专用用例。 |
| 2026-11-19 | 0–1 / 7 | VIDE 仲裁回归核对 `owner_q` 的 NBA 和两个连续驱动，Rust 工作区通过 701 项并跳过九项。Verdi NPI 的 Playwright 常规、完整 FPU 和独立运行的百万信号用例共通过 30 项。 |
| 2026-11-19 | 0 / 4–7 | 真实 Linux VS Code 核对在线和离线时间图的版本、采样类型和证据缺口。DPI 示例保留可核对的 C++ 步骤，同时报告静态图覆盖范围。 |
| 2026-11-19 | 7 | 交叉构建 Windows x64 读取器和 VSIX。从解包目录在 Wine 6 运行 Windows Node 和 Tcl 8.6，验证 Tcl 退出及 MCP 命名管道冒烟。Windows 版读取器用 VCD、FST、VCS KDB 及选择性采集的 FSDB 验证波形和库源码；测试目录补充 LZO 2.10 及旧 Wine 缺失的随机数入口。原生 Windows 与 macOS VS Code 仍待验收。 |
| 2026-11-19 | 3–4 / 7 | 当前 Linux VSIX 复跑实际 RV32A 仲裁。tick 270000 的两个 hart 同时请求，就绪为 `10`，`selected_hart=1`、`capture_atomic=1`。在 tick 280000 回溯至 tick 275000 的 `hart_q` 更新。时间图有 57 个节点和 149 条边，并列出缺失采样及静态前沿。 |
| 2026-11-19 | 2 / 6 | VIDE 桌面扩展测试 57 项通过，覆盖不兼容协议、无响应请求超时和取消、重启后拒绝旧回复。真实 Linux VS Code 用修改版扩展执行 `vide.restartServer` 后重新查询同一 RTL，赋值位置一致。隔离会话及在线流水线 UI/MCP 同时复跑。 |
| 2026-11-19 | 2–3 / 7 | 两个独立 Linux VS Code 实例分别使用无 VIDE 和公开版 VIDE 1.3.0 环境。MCP 区分缺少设计以及缺少 Trace 能力，两个环境均继续打开波形并执行 Tcl。 |
| 2026-11-19 | 3–4 | Verilator 5.054 连续赋值链在 Linux VS Code 实测 `expandReachable`。默认追踪止于 32 条关系，展开后返回 161 条静态赋值和 323 个时间节点，找到输入 `stimulus`。显式深度 32 仍返回部分结果。 |
| 2026-11-19 | 3–4 / 7 | Linux VS Code 1.124.2 使用独立 KDB 及 VCS 的 VCD 和 FSDB 核对两个同类型接口。Driver 和时间图从 `p`、`n` 分别追到 `x.datum`、`y.datum` 及 TB 输入 `a`、`b`。从底层成员和波形公开的读写别名发起 Load 查询，结果留在相应实例。独立后端通过 83 项，Verdi NPI 通过 77 项并跳过六项独立专用用例。 |
| 2026-11-19 | 2–4 / 7 | VCS T-2022.06-SP2 用绝对 `-o` 将产物输出到另一个目录，编译命令使用相对 `-F`。Linux VS Code 1.124.2 的 MCP 仅打开 VCD，自动附加 KDB 并恢复原始编译目录。省略 `-top` 的变体自动加载 `absolute_tb`、`ENABLE=1` 和生成头文件目录。Driver 和动态报告均定位到 `absolute_tb.a`，tick 1 的结果为 1。独立后端通过 84 项，Verdi NPI 通过 78 项并跳过六项独立专用用例。 |
| 2026-11-20 | 1–4 / 7 | OpenTitan MAC 复跑自动恢复 54 个编译根，静态和动态结果均到达 TB 的 `clk_dsp_i`。绝对输出路径的 VCS 样例同时核对 `#1` 的源码范围、MCP 过程调度缺口及实际波形值。VIDE 工作区通过 702 项，九项默认忽略。 |
| 2026-11-20 | 2–4 / 7 | 在空扩展目录从两份 Linux x64 VSIX 安装修改版 VIDE 和 Wave Workbench，在真实 VS Code 1.124.2 复查隐式顶层、`ENABLE=1`、动态样本和 `#1` 的结构化前沿。 |
| 2026-11-20 | 1–4 / 7 | 在 Linux VS Code 1.124.2 中用真实 VCS VCD 和 FSDB 核对 modport 数组。MCP 从 `p` 在 tick 1 的变化追到 `channels[4].data` 和 `a`，从 `n` 在 tick 3 的变化追到 `channels[5].data` 和 `b`。从成员或输入反查 Load，各自回到对应输出。FSDB 的读别名可作为追踪根。报告避免把已确认属于另一元素的赋值列为缺口。VIDE 通过 703 项并忽略九项，独立后端通过 86 项，Verdi NPI 通过 79 项并跳过七项独立专用用例。 |
| 2026-11-20 | 1–4 / 7 | Linux VS Code 1.124.2 用真实 VCS VCD 和 FSDB 核对 `link[7-i]`。MCP 将同一赋值的 `drive[0]` 和 `drive[1]` 分别绑定到 `channels[4].data` 和 `channels[5].data`。接收端使用 `-(2-1)` 和 `2*2-4`，Load 各自到达正确的输出。时间图实测 tick 1 和 tick 3，并在 Chromium 渲染核对接口实例。VIDE 通过 704 项并忽略九项，独立后端通过 86 项，Verdi NPI 通过 79 项并跳过七项独立专用用例。 |
| 2026-11-20 | 1–4 / 7 | Linux VS Code 1.124.2 用真实 VCS VCD 和 FSDB 验证参数化下标。MCP 在两组重复实例中分别找到 `lx.DEST=7`、`rx.DEST=-1` 和 `ly.DEST=6`、`ry.DEST=0`。Driver、Load、FSDB 别名和时间图保持正确的接口实例。时间图将四个值标为展开参数。VIDE 通过 705 项并忽略九项，独立后端通过 87 项，Verdi NPI 通过 79 项并跳过八项独立专用用例。 |
| 2026-11-20 | 1–4 / 7 | VCS 用两个不同接口类型展开同一个通用 source/sink 模块。Linux VS Code 1.124.2 经独立 KDB 和 MCP，在 VCD 和 FSDB 中分别从 tick 1 的 `p` 经 `x.data` 回到 `a`，从 tick 3 的 `n` 经 `y.data` 回到 `b`。源位置定位到各自接口类型，反向 Load 到达对应输出，Mermaid 时间图在 Chromium 渲染。VIDE 通过 706 项并忽略九项，独立后端通过 89 项，Verdi NPI 通过 80 项并跳过九项独立专用用例。 |
| 2026-11-20 | 1–4 / 7 | VCS 分别用显式指定和经包装模块转发的 sender/receiver 视图连接通用端口。真实 Linux VS Code 1.124.2 的 MCP 核对 VCD 和 FSDB 的 Driver、Load 及时间图，两条链各自保留 `x.data` 或 `y.data`。FSDB 的 `sender.tx` 和 `receiver.rx` 均可作为追踪根。已验证视图隐藏的成员不会参与绑定。VIDE 通过 707 项并忽略九项，独立后端通过 90 项，Verdi NPI 通过 80 项并跳过十项独立专用用例。 |
| 2026-11-20 | 1–4 / 7 | VCS 将声明方向不同的两组实际接口数组连接到通用端口。Wave Workbench 与修改版 VIDE 的 Linux VSIX 在真实 VS Code 中分别核对 `x[4]`、`x[5]`、`y[3]`、`y[2]` 的源码、Driver、Load 和动态链。两个 FSDB 后端在信号匹配时合并完全相同的记录。独立后端通过 92 项，Verdi NPI 通过 81 项并跳过 11 项独立专用用例。 |
| 2026-11-20 | 1–4 / 7 | VCS 仿真将虚接口句柄从 `x.reader` 切换到 `y.reader`。实际 Linux VS Code 的 MCP 在 VCD 和 FSDB 中确认 `p` 在 tick 3 和 5 分别为 1 和 0，并在三处 `view_handle.value` 源码位置返回运行时绑定缺口。VIDE 工作区通过 708 项并忽略九项。 |
| 2026-11-20 | 1–4 / 7 | Linux VS Code 1.124.2 用独立 KDB 及 Verdi NPI 分别打开真实 VCS VCD 和 FSDB，验证 `p[1]`、`n[0]`、`o[1]` 在 tick 1、2、3 经过 `datum[7]`、`datum[4]`、`ascending[1]` 回到 TB 激励。整条总线的时间追踪也只沿所读取的切片追溯，反查 Load 到达对应输出。六张 Mermaid 时间图在 Chromium 渲染。独立后端另外从 FSDB 的单个位别名反查 `q` 的对应位，覆盖 −2、140 和 300。VIDE 通过 709 项并忽略九项，独立后端通过 95 项，Verdi NPI 通过 83 项并跳过 12 项独立专用用例。 |
| 2026-11-20 | 1–4 / 7 | 安装两份 Linux VSIX，在 VS Code 1.124.2 的 MCP 用真实 VCS VCD 和 FSDB 验证 `p` 和 `r` 的六个输出位。两处读取 `datum[4]` 分别到达 `r[3]` 和 `r[0]`，两条路径均经拼接写入追到 `a[1]`。`r[2]` 经升序成员 `ascending[2]` 追到 `a[0]`，`r[1]` 经 `datum[7]` 追到 `b`。整条总线在 tick 3 观测为 `1111`。两种波形的八张 Mermaid 时间图均在 Chromium 渲染并核对了位标签。VIDE 通过 710 项并忽略九项，独立后端通过 96 项，Verdi NPI 通过 83 项并跳过 13 项独立专用用例。 |
| 2026-11-20 | 3–4 / 7 | Linux VS Code 1.124.2 分别用独立后端和 Verdi NPI，通过 MCP 直接从真实 FSDB 的 `concat_tb.x.receiver.with_repeat` 整条别名、四个位及 `sender.pair[0]` 查询。MCP 保留别名作为根节点，源码定位到实际 `modport` 声明。两次从 `datum[4]` 取值都追到 `a[1]`，两个别名位的 Load 都找到 `p[1]`、`r[3]` 和 `r[0]`。整条别名在 tick 3 为 `1111`，时间图保留 tick 1–3 的三路变化。独立后端的六张 Mermaid 图在 Chromium 渲染。两种后端的波形菜单 Driver 和 A 游标入口均打开详细报告，Trace Explorer 显示 `with_repeat[3]`。独立后端 96 项回归通过，Verdi NPI 通过 84 项并跳过 12 项独立专用用例。 |
| 2026-11-20 | 1–4 / 7 | 两种后端在 Linux VS Code 1.124.2 通过 MCP 验证 VCS 的五条嵌套别名位路径。读别名重复读取的 `data[7]` 均追到 `a[5]`，反查同时到达 `q[4]` 和 `q[0]`。对重叠写入的 `overlap.data[2]`，静态查询及 VCD 时间图保留 `b[5]` 和 `b[2]`，VCD 在 tick 3 保存了先变为 1 再回到 0 的波形样本。两个候选源的 Load 均到达 `overlap_value[2]`。旁路标量的时间图独立指向 `b[3]`。两种后端的嵌套别名和重叠写入时间图均在 Chromium 渲染。另在 Verdi NPI 模式验证负下标 FSDB 别名 `ni` 和 `n`。它们的 Load 分别到达 `q[10]`、`q[12]` 和 `q[12:10]` 对应的三个输出位。VIDE 通过 710 项并忽略 9 项，独立后端通过 97 项，Verdi NPI 通过 86 项并跳过 11 项独立专用用例。 |
| 2026-11-20 | 4–5 / 7 | VCS T-2022.06-SP2 在原始重叠拼接样例中通过 VPI 记录 `overlap.data` 于 tick 3 的 `0101` 和 `1001`，序号为 8、9。Linux VS Code 1.124.2 的执行回放及 MCP 在同次仿真的 VCD、FSDB 上验证文件哈希和 `1ns` 时基。VCD 回放比对得到所选位的 `1 → 0`，FSDB 只保留末值，报告中的两个回调仍可查看。两张执行图已在 Chromium 渲染。VCS 语句回调定位到原始赋值行，重叠组件的归因仍待验证。Verilator 5.054 对该源报复杂 modport 表达式不支持。独立后端通过 98 项，Verdi NPI 通过 87 项并跳过 11 项独立专用用例。 |
| 2026-11-20 | 4–5 / 7 | Linux VS Code 1.124.2 从根信号的同一份 VCS VPI 记录核对可达上游。正式覆盖样本在 tick 3 保存 `b`、`writer.d` 和 `overlap.data` 的回调 13、14、15、17。VCD 的目标节点匹配 15、17 并标明上游回调先后。FSDB 保留末值，报告仍展示两个目标回调及样本差异。另验证 tick 1 的 `overlap.bypass` 已观测且无变化，未选的 `nested.data` 无观测覆盖。截断回归报告不完整。 |
| 2026-11-20 | 6–7 | Linux VS Code 1.124.2 从两份 x64 VSIX 启动真实 VCS T-2022.06-SP2。MCP 验证 tick 0 暂停、两次时钟上升沿到 tick 3、`q=1010` 的断点停在 tick 5，以及 tick 8 自然退出。`q`、`d` 和 `clk` 的在线回调均与同一可执行文件的离线记录匹配，完整原始记录逐字节相同。**Trace Live Signal** 打开详细报告，MCP 的两张 Mermaid 图均在 Chromium 渲染并核对标签。独立后端通过 99 项，Verdi NPI 通过 88 项并跳过 11 项独立专用用例。 |
| 2026-11-20 | 5–7 | VCS T-2022.06-SP2 在 `vpi_live_tb.sv` 第 8 行记录 `q` 的 NBA 入口。Linux VS Code 1.124.2 经 MCP 读取该语句 ID，从 tick 0 步进时在 tick 1 命中事件 2，`q` 仍为 `0000`。tick 5 核对 `q`、`d` 和 `clk` 的语句入口与值变化回放，在线原始记录与离线逐字节一致。**Trace Live Signal** 打开含源码行的报告，Chromium 渲染两张 Mermaid 图。独立后端通过 100 项，Verdi NPI 通过 89 项并跳过 11 项独立专用用例。 |
| 2026-11-20 | 5–7 | Linux VS Code 1.124.2 经 MCP 从未插桩 VCS KDB 与 VIDE 生成 `d` 和 `q` 的探针映射。VCS T-2022.06-SP2 插桩样本保留原始信号的波形变化，拒绝 SHA-256 不符的探针映射。tick 4 的阻塞赋值第 14 行以序号 9 求值得到 `1010`，序号 11 记录提交。离线从 `q` 追到 `d` 的此处提交，在线命中相同序号并核对回放。两张 Mermaid 图在 Chromium 渲染。独立后端通过 101 项，Verdi NPI 通过 90 项并跳过 11 项独立专用用例。 |
| 2026-11-20 | 5–7 | VCS T-2022.06-SP2 的直接 NBA 探针记录 `q` 在 tick 1 的同值提交 2。Linux VS Code 1.124.2 经 MCP 在该提交处命中断点，在线与离线原始记录一致。tick 5 的 `q` 提交 18 与求值 16 配对，时间图追到 `d` 的阻塞写入。三次 NBA 合并的样本在 tick 1 保留两个未观测结果及最后提交，tick 2 的独立提交仍能归因。两张 Mermaid 图在 Chromium 渲染。独立后端通过 102 项，Verdi NPI 通过 91 项并跳过 11 项独立专用用例。 |
| 2026-11-20 | 5–7 | VCS T-2022.06-SP2 与 Linux VS Code 1.124.2 的 MCP 验证四处降序 `d` 阻塞写入及两处升序 `q` NBA 位段。tick 3 整总线重建 `10010000 → 10010101`，提交 16 和 18 分别从 `q[0]`、`q[7]` 追到 `d[7]`、`d[0]`。tick 5 在线及离线均把 `q[7]` 的提交 32 追到单个位 `d[0]` 的提交 24。插桩与原始仿真的槽末值一致，插桩波形额外保留槽内的中间变化。四张 Mermaid 图在 Chromium 渲染。独立后端通过 103 项，Verdi NPI 通过 92 项并跳过 11 项独立专用用例。 |
| 2026-11-20 | 5–7 | VCS T-2022.06-SP2 与 Linux VS Code 1.124.2 的 MCP 从原始 KDB 生成动态 NBA 映射。在 tick 2 和 4，`index` 的槽末值分别是 2 和 X，实际 NBA 仍按求值时的下标提交到 `q[-1]`、`q[2]`，序号为 5、11。tick 6 的 X 和 tick 8 的越界保留为未观测，tick 10 的 `q[1]` 仍归因到提交 26。在线断点和离线记录核对一致，原始和插桩仿真的槽末值一致。四张 Mermaid 图在 Chromium 渲染。独立后端通过 104 项，Verdi NPI 通过 93 项并跳过 11 项独立专用用例。 |
| 2026-11-20 | 1 / 5–7 | Linux VS Code 1.124.2 安装新打包的 VIDE 和 Wave Workbench，通过原始 VCS KDB 生成 `+:` 和 `-:` 探针映射。tick 4 观测保存的起点 4，提交 15 和 17 分别写入升序 `[4:5]` 和降序 `[4:3]`。两条 bit 4 时间图均指向 `d[1]`。部分越界及 X 写入保留未观测结果，tick 12 恢复归因。在线断点命中，同次序的在线与离线原始记录一致，原始与插桩仿真的槽末值一致。Chromium 渲染四张图。VIDE 赋值追踪测试通过 29 项，独立后端通过 105 项，Verdi NPI 通过 94 项并跳过 11 项独立专用用例。 |
| 2026-11-20 | 5–7 | Linux VS Code 1.124.2 从原始 VCS KDB 生成重叠 NBA 探针映射。tick 2 保留 `q[2:1]`、`q[1:0]` 的求值和未观测结果，独立的 `q[3]` 提交 12 追到 `a[0]`，在线断点命中同一语句。tick 4 的提交 23 将 `q[2]` 追到 `b[1]`。另一总线验证动态、固定和整信号写入共用标记时的范围记录。原始与插桩仿真的七个信号在七个 tick 的槽末值一致，在线与离线原始记录逐字节一致。Chromium 渲染五张图。独立后端通过 106 项，Verdi NPI 通过 95 项并跳过 11 项独立专用用例。 |
| 2026-11-20 | 1 / 3–7 | Linux VS Code 1.124.2 安装两份新 VSIX，使用 VCS T-2022.06-SP2 的 VCD 和原始 KDB。MCP 的 Driver 将 `q[3]` 追到 `data[0]`，Load 查询从 `data[1]` 保留未解析的函数赋值并排除 `q[3]`。波形时间图从 tick 2 回到 `data[0]` 于 tick 1 的变化。详细报告保留 `$time` 分支缺口。插桩回放确认为提交 5，在线断点在 tick 2 命中，在线与离线执行记录逐字节一致。Chromium 渲染三张图。VIDE 赋值追踪通过 29 项，独立后端通过 107 项，Verdi NPI 通过 96 项并跳过 11 项独立专用用例。 |
| 2026-11-20 | 4–7 | Linux VS Code 1.124.2 以同一 Verilator 流水线 harness 的 FST 和执行日志验证跨级事件输出。MCP 从 `second_q` 的提交 8 回溯到 `first_q` 的提交 4，执行 Mermaid 保留求值 7 → 提交 8 及求值 1 → 提交 4。离线、在线两次查询均匹配构建，VS Code 在线命令打开的 Markdown 与在线 MCP 的上游写入明细一致。移除 `first_q` 源码哈希后仍能查看原始事件，时间图保留候选。Chromium 渲染四张图。独立后端通过 107 项，Verdi NPI 通过 96 项并跳过 11 项独立专用用例。 |
| 2026-11-20 | 4–7 | Verilator 5.054 两级流水线在 tick 3 同时更新 `first_q=0` 与 `second_q=1`。仅用 FST 时，MCP 保留 `first_q` 在 tick 1 和 tick 3 的候选。读取已核对的求值 7 后，时间图确认旧值 1 与 RHS 相符，保留 tick 1 的上游路径。Linux VS Code 1.124.2 的离线、在线 MCP 和界面报告核对一致。独立后端通过 107 项，Verdi NPI 通过 96 项并跳过 11 项独立专用用例。 |
| 2026-11-20 | 4–7 | VCS T-2022.06-SP2 的两个上游寄存器在 tick 3 同时下降。Linux VS Code 1.124.2 经 MCP 核对求值 16 和 17。按记录的 RHS 值 1，与运算仅保留 `(1,1)`，或运算保留 `(0,1)`、`(1,0)`、`(1,1)`。在线与离线执行记录逐字节一致，在线 MCP 和 IDE 报告的组合列表一致。Chromium 渲染三张图。独立后端通过 107 项，Verdi NPI 通过 96 项并跳过 11 项独立专用用例。 |
| 2026-11-20 | 4–7 | 同一 VCS 用例启用 `sampleOperands` 后，求值 16、17 均记录 `left_q=1` 与 `right_q=1`。离线及在线 MCP 确认或运算只保留 `(1,1)`，源码身份匹配。移除操作数记录后复现三个候选。VS Code 1.124.2 的 Markdown 和在线 MCP 明细一致，在线与离线原始记录逐字节一致。Chromium 渲染三张对照图。独立后端通过 107 项，Verdi NPI 通过 96 项并跳过 11 项独立专用用例。 |
| 2026-11-20 | 4–7 | Linux VS Code 1.124.2 通过 `wave_execution_map` 从实际 VCS KDB 直接生成四条 NBA 的操作数采集映射。两条上游赋值采集 `seed`，与和或赋值均采集 `left_q`、`right_q`。原样使用映射编译并完成离线及在线回放，在线记录与离线逐字节一致，IDE 与 MCP 报告一致。回归核对跨行注释、常量和重复读取。独立后端通过 108 项，Verdi NPI 通过 97 项并跳过 11 项独立专用用例。 |
| 2026-11-20 | 4–7 | VCS T-2022.06-SP2 的测试将 `right_q` 排除在 VCD 和在线观测列表之外。Linux VS Code 1.124.2 离线与在线 MCP 均从求值 16 提取 tick 3 的 `right_q=1`，将 `left_q` 回溯至 tick 1，并保留 `right_q` 的历史缺口。在线与离线原始记录逐字节一致，VS Code 报告显示同一实录样本。Chromium 渲染两张图。独立后端通过 108 项，Verdi NPI 通过 97 项并跳过 11 项独立专用用例。 |
| 2026-11-20 | 4–7 | 在同一未采集 `right_q` 波形的 VCS 用例中，离线、在线 MCP 将 tick 3 的求值 16 追到 `right_q` 在 tick 1 的提交 7，再追到 `seed`。移除写入覆盖后离线回放保留求值样本及波形缺口。在线、离线原始记录逐字节一致，VS Code 1.124.2 报告显示同一执行日志来源。独立后端通过 109 项，Verdi NPI 通过 98 项并跳过 11 项。 |
| 2026-11-20 | 4–7 | VCS T-2022.06-SP2 用例在 VCD 中省略升序总线 `q[4:7]`。Linux VS Code 1.124.2 经离线、在线 MCP 将 tick 5 的 `1010` 分别追溯到 tick 1 提交 3 写的 `q[4:5]` 及 tick 3 提交 11 写的 `q[6:7]`，并继续核对各自的 `hi`、`lo` 位。移除第二处写入的源码哈希后，前两位仍可回溯，后两位保留求值样本。原始执行记录逐字节一致。独立后端通过 109 项，Verdi NPI 通过 98 项并跳过 11 项。 |
| 2026-11-20 | 4–7 | VCS T-2022.06-SP2 在 tick 3 对 `q[6:7]` 产生未观测提交 12。Linux VS Code 1.124.2 的离线与在线 MCP 在 tick 5 保留这两位的求值样本，同时将 `q[4:5]` 追到 tick 1 的提交 4。在 tick 7，`q[6:7]` 经 tick 5 的提交 20 追到 `recovery[1:0]`。在线报告包含未观测提交。在线与离线原始记录逐字节一致。独立后端通过 109 项，Verdi NPI 通过 98 项并跳过 11 项。 |
| 2026-11-21 | 3–7 | Linux VS Code 与静默后台从真实 Verilator VCD 的 `TOP.chain_tb.q` 自动续查。静态图累计 80 段、162 个信号和 161 条赋值，前台约 13 秒，后台约 13 秒。时间图的 40 段无失败，保留 201 条缺口记录及 `missingObservations`。两端的静态、时间及在线 Mermaid 输出逐字一致。Verilator 流水线的离线、在线记录均对应提交 8 和 4。带厂商样本的本地回归通过 107 项、跳过 55 项。 |
| 2026-11-21 | 4–7 | 使用原始 VCS KDB 生成重复 RHS 样本的组件探针。原始与插桩仿真的目标总线 10 个有序回调逐项一致。Linux VS Code 独立后端与 Verdi NPI、静默后台复核总线及 bit 2 的逐变化结果。在线会话在 3 ns 保持暂停，MCP 与 VS Code 报告均将回调 64 配对到求值 58。Chromium 渲染 VCD、FSDB 和在线时间图。扩展了包含固定、动态、索引位段及重叠 NBA 的回归，113 项通过、49 项跳过。 |
| 2026-11-21 | 7 | 新版 MCP 传输在 Linux 和 Wine 6 下的 Windows x64 Node 22.22.2 通过冒烟。Linux 另通过现有发行二进制与 Tcl 冒烟。四个 macOS、Windows x64/arm64 的 Rust 交叉检查停在 LuaJIT 编译，Linux 环境分别缺少 Darwin 目标编译器与 MSVC `cl`。原生系统 VSIX 验收仍待完成。 |
| 2026-11-21 | 7 | 在隔离的 Linux x64 VS Code 1.124.2 中安装 Wave Workbench 0.9.23 与修改版 VIDE 1.3.0，使用 `TOP.trace_tb.dut.owner_q` 验证 VCD 和 FST。两种格式均返回 16 条静态赋值和 32 节点、37 条边的时间图。解包 VSIX 后，静默 MCP 通过实际波形打开、区间截取和 Tcl 查询。GitHub 基线 `c8530be` 通过 Linux 和 macOS 的 x64、arm64 构建与打包，Windows 的两个架构在 Tcl 源码版本清单构建失败。 [GitHub 构建记录](https://github.com/AndreaFrederica/vscode-wave-workbench/actions/runs/44797050649) |
| 2026-11-21 | 3–7 | 拆分扩展宿主入口后，在隔离的 Linux VS Code 1.124.2 安装实际 VSIX 和修改版 VIDE。VCD、FST 均保留 16 条静态赋值、32 个时间节点及 37 条边。用前台 MCP 和实际 Verilator 模型核对离线 FST 与在线执行记录，两张图均从 tick 3 的提交 8 回溯到 tick 1 的提交 4，仿真停留在 tick 3。解包 VSIX 的静默 MCP、Tcl 和本地 IPC 冒烟均通过。 |
| 2026-11-21 | 3–4 | 界面自动续查与 MCP 共用 64 段和 100 秒预算，静态和时间续查保留取消前已确认的结果。Linux VS Code 波形菜单对真实 Verilator VCD 的 Driver 与 Load 均跨 5 段取得 161 条赋值，真实 VCS FSDB 的 A 游标时间图跨 8 段取得 270 个节点和 273 条边，保留 `gapBudget`。报告附录和 MCP 分页结果核对时忽略独立查询产生的 VIDE revision 数字。默认 Node 回归通过 98 项、跳过 65 项，Webview 回归通过 34 项、跳过 5 项。 |
| 2026-11-21 | 7 | GitHub 的 `8707800` 通过 Checks。六个平台均构建 VSIX。Linux 和 macOS 的 x64 与 arm64 通过包冒烟。Windows x64 与 arm64 通过原生后端、静默 MCP 及 Tcl 查询，随后在 `smoke-mcp.mjs` 的管道注册查验失败，安装后的 Windows 桌面验收待测。 [平台矩阵](https://github.com/AndreaFrederica/vscode-wave-workbench/actions/runs/44798601976) |
| 2026-11-21 | 4–7 | 时间图的缺口预算可独立设置，优先保留不同续查入口。Linux VS Code 1.124.2 用真实 VCS FSDB 的 `wide_causal_tb.q @ 5 ns` 验证根图在一节点、一边、12 缺口预算下保留 12 个不同的上游入口。默认图含 270 节点、273 边、1030 条缺口。提高缺口预算后恢复至 1033 条，清除 `gapBudget`，图仍记录观测、遍历与静态覆盖缺口。用 Chromium 渲染分页图首页。Verilator FST 与在线 MCP 在显式缺口预算下继续核对提交 8 与 4，在线会话停留于 tick 3。Node 回归通过 98 项、跳过 65 项。Windows 冒烟脚本复用生产注册目录函数，Linux 与 Wine 下的 Windows x64 Node 通过。 |

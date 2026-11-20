# 当前实现目标

优先交付两条可以在 Wave Workbench 中直接使用的功能链路。

1. **模拟与混合信号**。读取和显示实数波形，支持 A/B 测量、滞回生成数字波形、导出及 LuaJIT 和 V8 混合信号解码。先以 VCD、FST 和可运行的 Verdi SDK 样本交付，独立 FSDB 已验收 VCS 的 `real` 和 `shortreal` 样本，继续核对 RNM 和 AMS/SPICE。 [模拟波形计划](ANALOG_WAVE_PLAN.md)
2. **RTL 模块原理图**。以 Verilator JSON 和 VCS KDB 为输入，从展开后的顶层逐级浏览子实例和端口连线，并跳到源码。Verilator 视图支持模块内的赋值与时序过程。局部信号图可切换上游或下游、显示 A 游标值，也可打开信号所属模块。后续扩展复杂接口连线、综合网表、时间因果标注和直接从 RTL 自动生成。 [现有 RTL Trace 计划](RTL_TRACE_PLAN.md)

检查项、实测结果和跨平台待验收内容见 [检查 TODO](CHECK_TODO.md)。多引擎解码器的接口扩展见 [解码器计划](DECODER_PLAN.md)。

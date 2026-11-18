# 独立 FSDB / KDB 后端

Wave Workbench 0.9.18 的独立后端用 Rust 直接读取 FSDB 和 VCS 的 `simv.daidir`。源码在 `native/src/independent/`，发布包通过 `bin/wave-backend-independent --independent` 启动。支持 Linux、macOS 和 Windows 的 x64 与 ARM64，FSDB/KDB 需要安装目标架构的 LZO 2 共享库。 [安装及构建](../README.md#从源码构建)本目录的 Python 实现留作差分测试的参考，打包时排除。 [项目许可](../LICENSE)

在波形编辑器标题栏、侧栏标题栏或命令面板运行「Wave Workbench: 选择 FSDB 后端…」。选择「独立后端」后，当前 FSDB 和已接入的 KDB 一起切换，工作区记住选项。可用 `waveWorkbench.independentBackendPath` 指定自定义可执行文件。Remote SSH 使用远端路径和库。

## 格式与验证范围

已验证 VCS / Verdi T-2022.06-SP2 生成的 FSDB 版本 86 和 `kdb.elab++`。读取器按需访问文件索引和值页。波形协议用字符串传递整数时间戳，用四态位串传递数字信号值。遇到 real、shortreal 或 string 波形值会返回不支持。KDB 提供实例和源码定位、包、生成块、信号声明和接口连接查询。其他编译器版本需要用其生成的数据库复查。

## 使用本地数据库复查

从仓库根目录启动 `bin/wave-backend-independent --independent`，每行写入一个请求。

```jsonl
{"id":1,"method":"open","path":"/path/to/simulation.fsdb"}
{"id":2,"method":"kdbOpen","path":"/path/to/simv.daidir"}
{"id":3,"method":"kdbChildren","query":""}
```

扩展宿主测试使用本地 MAC 仿真。将 `WAVE_TEST_KDB` 指向 `simv.daidir`，同级目录保留 `waves.fsdb`。

```sh
npm run build
WAVE_TEST_INDEPENDENT=1 WAVE_TEST_KDB="/path/to/mac/simv.daidir" \
  node --test test/kdb-extension.test.js
```

如需在两套后端间往返切换，使用 `WAVE_TEST_SWITCH_BACKEND=1` 并提供启用了 Verdi SDK 的 `bin/wave-backend`。 [构建步骤](../README.md#从源码构建)

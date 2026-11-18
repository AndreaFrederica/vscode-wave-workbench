# 独立 FSDB / KDB 后端

这个后端在 Linux x86-64 上直接打开 FSDB 和 VCS 的 `simv.daidir`。它使用 Wave Workbench 的行分隔 JSON 协议，支持与波形一起浏览设计层次、查找 RTL 定义并查询信号。

运行需要 Python 3.8 或更新版本和系统的 `liblzo2.so.2`。源码采用仓库的 MPL-2.0 许可。系统 LZO 由发行版提供，遵循其 GPL v2+ 许可。 [LZO 项目](https://www.oberhumer.com/opensource/lzo/) · [项目许可](../LICENSE)

在波形编辑器标题栏、Wave Workbench 侧栏标题栏或命令面板运行「Wave Workbench: 选择 FSDB 后端…」。可选「独立后端」「Verdi 后端」或「自动」。当前 FSDB 的波形和已接入的 KDB 一起切换，工作区会记住选项。

独立后端默认启动扩展随附的 Python 读取器。可设置 `waveWorkbench.independentBackendPath` 指向自定义独立后端可执行文件。使用 Remote SSH 时，Python 和自定义路径都在远端机器上。Verdi 模式由 `waveWorkbench.verdiHome` 或 `VERDI_HOME` 指定 SDK。

```json
{
  "waveWorkbench.fsdbBackend": "independent"
}
```

## 验证范围

参考环境采用 VCS / Verdi T-2022.06-SP2。已验证 FSDB 容器版本 86 和当前 VCS 的 `kdb.elab++` 格式。

| 功能 | 对照结果 |
| --- | --- |
| KDB 实例、定义、父级、作用域和实例反查 | FPU 全芯片 209,256 个递归作用域和 39,039 条模块反查 |
| KDB 信号声明、类型、索引、位宽和源码位置 | FPU 的 485,604 条可解析路径逐字段吻合，860 条无效路径两端均拒绝 |
| KDB 语言构造 | 579 条声明、207 个参数值、6 条无效路径，另有 18 组接口绑定 |
| FSDB 声明及四态事件 | FPU 的 620,128 条声明和 1,542,875 条事件逐项吻合 |
| FSDB 声明、连接图和事件 | MAC 工作区的 266,367 条声明和 173,324 条事件逐项吻合 |
| 波形协议 | 检索、分页、名称匹配、5 类虚拟信号、带上限的缓存和时间区间对照 |
| VS Code 扩展宿主 | MAC 的 FSDB / KDB 打开、侧栏树、RTL 定位和批量添加信号 |

物理波形、索引和值页都按需读取。插件用字符串传递整数时刻，以保留后端的时间精度。当前波形协议用四态位串表示值，遇到 real、shortreal 和 string 编码会返回不支持。

对于起点早于首事件的区间，独立后端保留区间内发生的转换。该行为已与普通 FFR 的首事件遍历结果核对。

## 使用本地数据库复查

启动 `./backend.py` 后，每行写入一个请求。可使用 `open` 和 `kdbOpen` 打开自己的仿真数据。

```jsonl
{"id":1,"method":"open","path":"/path/to/simulation.fsdb"}
{"id":2,"method":"kdbOpen","path":"/path/to/simv.daidir"}
{"id":3,"method":"kdbChildren","query":""}
```

扩展宿主测试支持本地完整 MAC 测试数据。把 `WAVE_TEST_KDB` 指向其 `simv.daidir`，同层放置 `waves.fsdb`。在仓库根目录运行以下命令。

```sh
npm run build
WAVE_TEST_BACKEND="$PWD/independent_backend/backend.py" \
  WAVE_TEST_KDB="/path/to/mac/simv.daidir" \
  node --test test/kdb-extension.test.js
```

## Rust 迁移

Rust 的第一步是读取 FSDB 文件头、声明快照、时间窗口、块索引和字典位置。可用 `fsdb-inspect` 将这些字段与 Python 读取器逐项对照。

`native/src/fsdb_container/` 中，`mod.rs` 提供容器入口，`header.rs` 校验文件头，`directory.rs` 解析声明快照、时间窗口和块目录，`reader.rs` 负责带边界检查的字节读取。

```sh
cargo build --locked --manifest-path native/Cargo.toml --bin fsdb-inspect
python3 test/compare-fsdb-container.py native/target/debug/fsdb-inspect /path/to/simulation.fsdb
```

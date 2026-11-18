# WaveBench Reader

WaveBench Reader is the MPL-2.0 Rust library behind the independent backend of Wave Workbench. It reads digital FSDB and VCD waveforms directly and resolves hierarchy and source locations in VCS KDB databases.

| Module | API |
| --- | --- |
| `wavebench_reader::fsdb` | Open an FSDB, enumerate declarations, and query four-state value changes by signal ID and tick range |
| `wavebench_reader::vcd` | Open a VCD file or parse its text, enumerate declarations, and query value changes |
| `wavebench_reader::kdb` | Open a VCS `simv.daidir` and query elaborated hierarchy, instances, and source locations |

## Use from Rust

Add the library with `wavebench-reader = { path = "../vscode-wave-workbench/native" }` in your Cargo manifest. The extension and the `wave-backend --independent` JSON-lines process use the same library.

```rust
use wavebench_reader::{fsdb, vcd};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let vcd = vcd::Vcd::open("run.vcd")?;
    let signal = vcd.signals.iter().find(|signal| signal.supported).unwrap();
    let (events, truncated) = vcd.query(&signal.id, 0, vcd.end, 1_000)?;
    println!("VCD events: {} (truncated: {truncated})", events.len());

    let mut fsdb = fsdb::Session::open("run.fsdb")?;
    let signal = fsdb.declarations.iter().find(|signal| signal.supported).unwrap();
    let id = signal.native_id;
    let (start, end) = (fsdb.container().start, fsdb.container().end);
    let (events, truncated) = fsdb.query(id, start, end, 1_000)?;
    println!("FSDB events: {} (truncated: {truncated})", events.len());
    Ok(())
}
```

Queries use integer ticks and can include a prior event to seed the value at the start of a window. The second return value indicates whether the event limit truncated the result. FSDB and KDB use the system LZO 2 shared library. VCD works without LZO. [Platform and dependency setup](../README.md#从源码构建)

## Format research and validation

The project-authored parser was developed by examining FSDB and KDB files emitted by controlled RTL simulations. Differential tests use Verdi's Reader and NPI APIs as a reference. The default Cargo build is independent of Verdi code and the Verdi SDK. The opt-in `verdi-sdk` Cargo feature builds the C++ bridge against a locally installed SDK.

Validated fixtures include VCS T-2022.06-SP2 FSDB version 86 and `kdb.elab++` databases. FSDB/KDB format coverage depends on the encoding emitted by the simulator. The current waveform API targets digital values and supports four-state bits. VCD files are parsed in memory with a 128 MiB file limit, 200,000 declaration limit, and 2 million transition limit. [Wave Workbench validation notes](../VALIDATION.md)

```sh
cargo test --locked --manifest-path native/Cargo.toml
cargo test --locked --manifest-path native/Cargo.toml -- --ignored
```

The ignored test checks both LZO formats and requires the shared library. [Project license](../LICENSE)

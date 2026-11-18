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

## How FSDB and KDB are decoded

WaveBench Reader infers FSDB and KDB record layouts from observations of files produced by controlled RTL simulations. The project checks those interpretations against sample files.

The default Cargo build is independent of Verdi code and the Verdi SDK. The opt-in `verdi-sdk` Cargo feature builds the C++ bridge against a locally installed SDK.

## Experimental status

The readers and their documentation are still under development.

- The inferred layouts may be incomplete or incorrect, and different simulator versions and settings can emit different layouts.
- Validation covers specific samples, including VCS T-2022.06-SP2 FSDB version 86 and `kdb.elab++` databases. Compatibility with other files varies. [Wave Workbench validation notes](../VALIDATION.md)
- The library makes no guarantees about API stability, data accuracy or completeness, or suitability for a particular purpose.

The waveform API focuses on digital four-state values. VCD files are parsed in memory with a 128 MiB file limit, a 200,000-declaration limit, and a 2-million-transition limit.

## Warranty and liability

WaveBench Reader is provided **as is**, without express, implied, or statutory warranties, including warranties of merchantability or fitness for a particular purpose. Users bear the risk as to the software's quality and performance. The applicable warranty disclaimer and limits of liability are set out in sections 6 and 7 of the MPL-2.0 license. [Project license](../LICENSE)

## Running the tests

```sh
cargo test --locked --manifest-path native/Cargo.toml
cargo test --locked --manifest-path native/Cargo.toml -- --ignored
```

The ignored test checks both LZO formats and requires the shared library.

// SPDX-License-Identifier: MPL-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const version = "8.6.18";
const sourceUrl =
  "https://codeload.github.com/tcltk/tcl/tar.gz/refs/tags/core-8-6-18";
const sourceHash =
  "8b9b554f3539b37bea20ee6cef14faa63df1259896e466328f596eca9f0c49a5";
const sourceRevision = "515167c897a7c8066abfbd71e8fe7bd8bf3569de";

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error?.code === "ENOENT" && command === "nmake")
    throw Error(
      "Run the Windows package build from a Visual Studio Developer Command Prompt.",
    );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw Error(command + " exited with " + result.status);
}

export async function packageTcl(platform, preparedRuntime) {
  const host = process.platform + "-" + process.arch;
  if (!preparedRuntime && host !== platform)
    throw Error(
      "Cross packaging requires --tcl-runtime with a Tcl runtime built for " +
        platform,
    );

  const staging = mkdtempSync(join(resolve("bin"), ".tcl-"));
  const runtime = join(staging, "runtime");
  const build = mkdtempSync(join(tmpdir(), "wave-tcl-build-"));
  const windows = platform.startsWith("win32-");
  const executable = windows ? "tclsh.exe" : "tclsh";
  try {
    if (preparedRuntime) {
      cpSync(resolve(preparedRuntime), runtime, { recursive: true });
    } else {
      const response = await fetch(sourceUrl, {
        signal: AbortSignal.timeout(120000),
      });
      if (!response.ok)
        throw Error("Tcl source download returned HTTP " + response.status);
      const archive = Buffer.from(await response.arrayBuffer());
      if (createHash("sha256").update(archive).digest("hex") !== sourceHash)
        throw Error("Tcl source archive checksum mismatch");
      const archivePath = join(build, "tcl.tar.gz");
      writeFileSync(archivePath, archive);
      run("tar", ["-xzf", archivePath, "--strip-components", "1"], build);

      const binaryDir = join(runtime, "bin");
      const buildDir = join(build, windows ? "win" : "unix");
      mkdirSync(binaryDir, { recursive: true });
      let shell;
      if (windows) {
        // The source archive has no Git checkout for makefile.vc to query.
        writeFileSync(
          join(build, "manifest.uuid"),
          readFileSync(join(buildDir, "gitmanifest.in"), "utf8") +
            sourceRevision +
            "\r\n",
        );
        const machine = platform.endsWith("-arm64") ? "ARM64" : "AMD64";
        const output = join(buildDir, "wave-out");
        run(
          "nmake",
          [
            "/nologo",
            "/f",
            "makefile.vc",
            "OPTS=static,nomsvcrt",
            "MACHINE=" + machine,
            "OUT_DIR=" + output,
            "shell",
          ],
          buildDir,
        );
        const name = readdirSync(output).find((name) =>
          /^tclsh86t?s?\.exe$/i.test(name),
        );
        if (!name) throw Error("Tcl build did not produce a Windows shell");
        shell = join(output, name);
      } else {
        run(
          "sh",
          ["./configure", "--disable-shared", "--enable-threads"],
          buildDir,
        );
        run(
          "make",
          ["-j", String(Math.min(availableParallelism(), 8)), "binaries"],
          buildDir,
        );
        shell = join(buildDir, "tclsh");
      }
      copyFileSync(shell, join(binaryDir, executable));
      cpSync(join(build, "library"), join(runtime, "lib", "tcl8.6"), {
        recursive: true,
      });
      for (const [source, destination] of [
        ["license.terms", "LICENSE-Tcl.txt"],
        ["compat/zlib/LICENSE", "LICENSE-zlib.txt"],
        ["libtommath/LICENSE", "LICENSE-LibTomMath.txt"],
      ]) {
        copyFileSync(join(build, source), join(runtime, destination));
      }
      writeFileSync(
        join(runtime, "README.txt"),
        "Tcl " + version + "\nSource: " + sourceUrl + "\n",
      );
    }

    for (const file of [
      join("bin", executable),
      join("lib", "tcl8.6", "init.tcl"),
      "LICENSE-Tcl.txt",
      "LICENSE-zlib.txt",
      "LICENSE-LibTomMath.txt",
    ]) {
      if (!existsSync(join(runtime, file)))
        throw Error("Tcl runtime is missing " + file);
    }
    const destination = resolve("bin", "tcl");
    rmSync(destination, { recursive: true, force: true });
    renameSync(runtime, destination);
  } finally {
    rmSync(staging, { recursive: true, force: true });
    rmSync(build, { recursive: true, force: true });
  }
}

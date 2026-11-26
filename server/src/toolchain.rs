//! Drives avr-gcc to build sketches against the Bitbench mini core.

use anyhow::{Context, Result, anyhow, bail};
use regex::Regex;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::Duration;
use tokio::process::Command;
use tokio::sync::OnceCell;

use crate::sketch;

#[derive(Debug, Clone, Serialize)]
pub struct Board {
    pub id: &'static str,
    pub name: &'static str,
    pub mcu: &'static str,
    pub f_cpu: u32,
    pub flash_bytes: u32,
    pub ram_bytes: u32,
    pub upload_protocol: &'static str,
    pub upload_baud: u32,
    pub define: &'static str,
}

pub const BOARDS: &[Board] = &[
    Board {
        id: "uno",
        name: "Arduino Uno",
        mcu: "atmega328p",
        f_cpu: 16_000_000,
        flash_bytes: 32_256,
        ram_bytes: 2048,
        upload_protocol: "stk500v1",
        upload_baud: 115_200,
        define: "ARDUINO_AVR_UNO",
    },
    Board {
        id: "nano",
        name: "Arduino Nano (new bootloader)",
        mcu: "atmega328p",
        f_cpu: 16_000_000,
        flash_bytes: 30_720,
        ram_bytes: 2048,
        upload_protocol: "stk500v1",
        upload_baud: 115_200,
        define: "ARDUINO_AVR_NANO",
    },
    Board {
        id: "nano-old",
        name: "Arduino Nano (old bootloader)",
        mcu: "atmega328p",
        f_cpu: 16_000_000,
        flash_bytes: 30_720,
        ram_bytes: 2048,
        upload_protocol: "stk500v1",
        upload_baud: 57_600,
        define: "ARDUINO_AVR_NANO",
    },
];

pub fn board(id: &str) -> Option<&'static Board> {
    BOARDS.iter().find(|b| b.id == id)
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Diagnostic {
    pub line: u32,
    pub column: u32,
    pub severity: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CompileOutput {
    pub ok: bool,
    pub hex: Option<String>,
    pub log: String,
    pub diagnostics: Vec<Diagnostic>,
    pub flash_used: Option<u32>,
    pub flash_max: u32,
    pub ram_used: Option<u32>,
    pub ram_max: u32,
}

pub struct Toolchain {
    core_dir: PathBuf,
    build_root: PathBuf,
    libs: std::collections::HashMap<&'static str, OnceCell<PathBuf>>,
    timeout: Duration,
}

const CXXFLAGS: &[&str] = &[
    "-c", "-g", "-Os", "-Wall", "-std=gnu++17", "-fpermissive", "-fno-exceptions",
    "-ffunction-sections", "-fdata-sections", "-fno-threadsafe-statics", "-MMD",
];

impl Toolchain {
    pub fn new(core_dir: PathBuf, build_root: PathBuf) -> Self {
        let libs = BOARDS.iter().map(|b| (b.id, OnceCell::new())).collect();
        Self { core_dir, build_root, libs, timeout: Duration::from_secs(60) }
    }

    fn defines(b: &Board) -> Vec<String> {
        vec![
            format!("-mmcu={}", b.mcu),
            format!("-DF_CPU={}L", b.f_cpu),
            "-DARDUINO=10819".into(),
            format!("-D{}", b.define),
            "-DARDUINO_ARCH_AVR".into(),
            "-DBITBENCH_CORE".into(),
        ]
    }

    async fn run(&self, program: &str, args: &[String], cwd: &Path) -> Result<(bool, String)> {
        let fut = Command::new(program).args(args).current_dir(cwd).kill_on_drop(true).output();
        let out = tokio::time::timeout(self.timeout, fut)
            .await
            .map_err(|_| anyhow!("{program} timed out"))?
            .with_context(|| format!("failed to run {program} (is the AVR toolchain installed?)"))?;
        let mut text = String::from_utf8_lossy(&out.stderr).to_string();
        text.push_str(&String::from_utf8_lossy(&out.stdout));
        Ok((out.status.success(), text))
    }

    /// Build (once per board) the core into a static library.
    async fn core_lib(&self, b: &'static Board) -> Result<PathBuf> {
        let cell = self.libs.get(b.id).ok_or_else(|| anyhow!("unknown board"))?;
        cell.get_or_try_init(|| async {
            let dir = self.build_root.join(format!("core-{}", b.id));
            tokio::fs::create_dir_all(&dir).await?;
            let mut objs = Vec::new();
            let mut entries = tokio::fs::read_dir(self.core_dir.join("src")).await
                .context("core directory not found")?;
            let mut sources = Vec::new();
            while let Some(e) = entries.next_entry().await? {
                let p = e.path();
                if p.extension().is_some_and(|x| x == "cpp" || x == "c") {
                    sources.push(p);
                }
            }
            sources.sort();
            for src in sources {
                let obj = dir.join(src.file_name().unwrap()).with_extension("o");
                let mut args: Vec<String> = CXXFLAGS.iter().map(|s| s.to_string()).collect();
                args.extend(Self::defines(b));
                args.push(format!("-I{}", self.core_dir.join("src").display()));
                args.push(src.display().to_string());
                args.push("-o".into());
                args.push(obj.display().to_string());
                let (ok, log) = self.run("avr-g++", &args, &dir).await?;
                if !ok {
                    bail!("core build failed:\n{log}");
                }
                objs.push(obj.display().to_string());
            }
            let lib = dir.join("libcore.a");
            let _ = tokio::fs::remove_file(&lib).await;
            let mut args = vec!["rcs".to_string(), lib.display().to_string()];
            args.extend(objs);
            let (ok, log) = self.run("avr-ar", &args, &dir).await?;
            if !ok {
                bail!("avr-ar failed:\n{log}");
            }
            Ok(lib)
        })
        .await
        .cloned()
    }

    pub async fn compile(&self, b: &'static Board, source: &str) -> Result<CompileOutput> {
        let mut result = CompileOutput {
            ok: false,
            hex: None,
            log: String::new(),
            diagnostics: vec![],
            flash_used: None,
            flash_max: b.flash_bytes,
            ram_used: None,
            ram_max: b.ram_bytes,
        };
        if let Err(e) = sketch::check_includes(source) {
            result.log = format!("sketch.ino: error: {e}\n");
            result.diagnostics.push(Diagnostic { line: 1, column: 1, severity: "error".into(), message: e });
            return Ok(result);
        }
        let lib = self.core_lib(b).await?;
        let tmp = tempfile::Builder::new().prefix("sketch-").tempdir_in(&self.build_root)?;
        let dir = tmp.path();
        let cpp = sketch::preprocess(source, "sketch.ino");
        tokio::fs::write(dir.join("sketch.ino.cpp"), cpp).await?;

        let mut args: Vec<String> = CXXFLAGS.iter().map(|s| s.to_string()).collect();
        args.extend(Self::defines(b));
        args.push(format!("-I{}", self.core_dir.join("src").display()));
        args.extend(["sketch.ino.cpp", "-o", "sketch.o"].map(String::from));
        let (ok, log) = self.run("avr-g++", &args, dir).await?;
        result.log.push_str(&self.clean(&log, dir));
        result.diagnostics = parse_diagnostics(&result.log);
        if !ok {
            return Ok(result);
        }

        let args: Vec<String> = vec![
            "-Os".into(), "-Wl,--gc-sections".into(), "-Wl,--demangle".into(), format!("-mmcu={}", b.mcu),
            "sketch.o".into(), lib.display().to_string(), "-lm".into(), "-o".into(), "sketch.elf".into(),
        ];
        let (ok, log) = self.run("avr-gcc", &args, dir).await?;
        let log = self.clean(&log, dir);
        result.log.push_str(&log);
        if !ok {
            result.diagnostics.extend(parse_diagnostics(&log));
            // Newer binutils print mangled names (`_Z5setupv`) unless asked to demangle.
            for (sym, mangled, hint) in [
                ("setup()", "_Z5setupv", "Every sketch needs a `void setup()` function."),
                ("loop()", "_Z4loopv", "Every sketch needs a `void loop()` function."),
            ] {
                if log.contains(&format!("undefined reference to `{sym}'")) || log.contains(&format!("undefined reference to `{mangled}'")) {
                    result.log.push_str(&format!("hint: {hint}\n"));
                    result.diagnostics.push(Diagnostic { line: 1, column: 1, severity: "error".into(), message: hint.into() });
                }
            }
            return Ok(result);
        }

        let args: Vec<String> = ["-O", "ihex", "-R", ".eeprom", "sketch.elf", "sketch.hex"].map(String::from).to_vec();
        let (ok, log) = self.run("avr-objcopy", &args, dir).await?;
        if !ok {
            result.log.push_str(&log);
            return Ok(result);
        }
        let (_, size) = self.run("avr-size", &["-A".into(), "sketch.elf".into()], dir).await?;
        let (flash, ram) = parse_size(&size);
        result.flash_used = Some(flash);
        result.ram_used = Some(ram);
        result.log.push_str(&format!(
            "Sketch uses {flash} bytes ({}%) of program storage space. Maximum is {} bytes.\n\
             Global variables use {ram} bytes ({}%) of dynamic memory. Maximum is {} bytes.\n",
            flash * 100 / b.flash_bytes, b.flash_bytes, ram * 100 / b.ram_bytes, b.ram_bytes
        ));
        if flash > b.flash_bytes {
            result.log.push_str("error: Sketch too big.\n");
            return Ok(result);
        }
        result.hex = Some(tokio::fs::read_to_string(dir.join("sketch.hex")).await?);
        result.ok = true;
        Ok(result)
    }
}

impl Toolchain {
    /// Strip server paths so logs only mention `sketch.ino` and `core/…`.
    fn clean(&self, log: &str, dir: &Path) -> String {
        let core_src = format!("{}/", self.core_dir.join("src").display());
        let root = format!("{}/", self.build_root.display());
        let mut out = log.replace(&format!("{}/", dir.display()), "").replace(&core_src, "core/");
        // Anything else under the build root (e.g. the prebuilt core archive).
        while let Some(i) = out.find(&root) {
            let end = out[i + root.len()..].find('/').map(|j| i + root.len() + j + 1).unwrap_or(out.len());
            out.replace_range(i..end, "");
        }
        // Drop the linker's install path, e.g. "/usr/lib/gcc/avr/14.3.0/../../../avr/bin/ld: ".
        static LD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?m)^\S*/bin/ld: ").unwrap());
        let out = LD.replace_all(&out, "ld: ").into_owned();
        out.replace("sketch.ino.cpp", "sketch.ino")
    }
}

static DIAG: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?m)^sketch\.ino:(\d+):(?:(\d+):)?\s*(error|warning|note|fatal error):\s*(.*)$").unwrap()
});

pub fn parse_diagnostics(log: &str) -> Vec<Diagnostic> {
    DIAG.captures_iter(log)
        .map(|c| Diagnostic {
            line: c[1].parse().unwrap_or(1),
            column: c.get(2).and_then(|m| m.as_str().parse().ok()).unwrap_or(1),
            severity: if &c[3] == "fatal error" { "error".into() } else { c[3].to_string() },
            message: c[4].trim().to_string(),
        })
        .collect()
}

/// Parse `avr-size -A` output into (flash, ram) bytes.
pub fn parse_size(out: &str) -> (u32, u32) {
    let mut text = 0;
    let mut data = 0;
    let mut bss = 0;
    for line in out.lines() {
        let parts: Vec<_> = line.split_whitespace().collect();
        if parts.len() < 2 {
            continue;
        }
        let v: u32 = parts[1].parse().unwrap_or(0);
        match parts[0] {
            ".text" => text = v,
            ".data" => data = v,
            ".bss" => bss = v,
            _ => {}
        }
    }
    (text + data, data + bss)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_gcc_diagnostics() {
        let log = "sketch.ino: In function 'void loop()':\nsketch.ino:7:3: error: 'foo' was not declared in this scope\nsketch.ino:9:10: warning: unused variable 'x' [-Wunused-variable]\n";
        let d = parse_diagnostics(log);
        assert_eq!(d.len(), 2);
        assert_eq!(d[0], Diagnostic { line: 7, column: 3, severity: "error".into(), message: "'foo' was not declared in this scope".into() });
        assert_eq!(d[1].severity, "warning");
    }

    #[test]
    fn cleans_server_paths_from_logs() {
        let tc = Toolchain::new(PathBuf::from("/srv/core"), PathBuf::from("/tmp/bb-x"));
        let log = "/tmp/bb-x/core-uno/libcore.a(main.o): In function `main':\n/srv/core/src/main.cpp:9: undefined reference to `setup()'\n";
        let out = tc.clean(log, Path::new("/tmp/bb-x/sketch-1"));
        assert_eq!(out, "libcore.a(main.o): In function `main':\ncore/main.cpp:9: undefined reference to `setup()'\n");
    }

    #[test]
    fn parses_avr_size() {
        let out = "sketch.elf  :\nsection           size      addr\n.data               18   8388864\n.text              924         0\n.bss                 9   8388882\n";
        assert_eq!(parse_size(out), (942, 27));
    }
}

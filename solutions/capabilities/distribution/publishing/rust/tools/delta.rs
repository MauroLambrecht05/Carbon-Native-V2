// carbon-delta — the publish-time delta tool.
//
//   carbon-delta diff     <old> <new> <patch>    bsdiff patch between two files
//   carbon-delta apply    <old> <patch> <new>    and back again
//   carbon-delta compress <in> <out> [level]     zstd
//   carbon-delta decompress <in> <out>
//
// ── WHAT THIS REPLACED ──────────────────────────────────────────────────────
// Two prebuilt Windows executables committed at .tools/vendor: `bsdiff.exe`
// and `zig-zstd.exe`. They worked, and they meant `carbon publish` could only
// run on Windows — a contributor on macOS or Linux had to install both tools
// natively and point BSDIFF / ZSTD at them. Their README named this as the
// real fix and it never got done.
//
// ── ON PATCH FORMAT ─────────────────────────────────────────────────────────
// The `bsdiff` crate emits its own framing, NOT mendsley/bsdiff's
// "ENDSLEY/BSDIFF43" header, so a patch produced here is not interchangeable
// with one produced by the old binary. That is safe today for a specific
// reason and not for a general one: nothing in V2 applies patches yet — the
// updater crate has no patch path at all — so no published patch has ever been
// consumed. `apply` exists below so the format round-trips within our own
// tooling, and so the applier that eventually lands in carbon-updater has
// something to be tested against.
//
// If a patch produced by the old binary is ever found in the wild, it must be
// re-generated rather than applied here.

use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use anyhow::{anyhow, bail, Context, Result};

/// zstd level 19. The old `zig-zstd.exe` defaulted to 3; 19 is what a release
/// artifact wants — it is compressed once and downloaded many times, and the
/// extra seconds are paid by CI rather than by a user.
const DEFAULT_LEVEL: i32 = 19;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();

    match run(&args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            // One line to stderr, the way the tools this replaced behaved —
            // publish.ts surfaces whatever it finds there.
            eprintln!("carbon-delta: {e:#}");
            ExitCode::FAILURE
        }
    }
}

fn run(args: &[String]) -> Result<()> {
    let Some(command) = args.first().map(String::as_str) else {
        bail!("{}", USAGE);
    };

    match command {
        "diff" => {
            let (old, new, patch) = three(args, "diff <old> <new> <patch>")?;
            diff(&old, &new, &patch)
        }
        "apply" => {
            let (old, patch, new) = three(args, "apply <old> <patch> <new>")?;
            apply(&old, &patch, &new)
        }
        "compress" => {
            let (input, output) = two(args, "compress <in> <out> [level]")?;
            let level = match args.get(3) {
                Some(raw) => raw
                    .parse()
                    .with_context(|| format!("compression level must be a number, got {raw:?}"))?,
                None => DEFAULT_LEVEL,
            };
            compress(&input, &output, level)
        }
        "decompress" => {
            let (input, output) = two(args, "decompress <in> <out>")?;
            decompress(&input, &output)
        }
        "--help" | "-h" | "help" => {
            println!("{USAGE}");
            Ok(())
        }
        other => bail!("unknown command {other:?}\n\n{USAGE}"),
    }
}

const USAGE: &str = "\
carbon-delta — publish-time binary delta and compression

  carbon-delta diff       <old> <new> <patch>
  carbon-delta apply      <old> <patch> <new>
  carbon-delta compress   <in> <out> [level]     default level 19
  carbon-delta decompress <in> <out>
";

// ── Commands ────────────────────────────────────────────────────────────────

/// A bsdiff patch that turns `old` into `new`.
///
/// Both inputs are read whole. That is the algorithm's requirement rather than
/// a shortcut — bsdiff builds a suffix array over the old file — and it is why
/// this runs on layer tars rather than on a whole release.
///
/// ── THE OUTPUT IS NOT SMALL ─────────────────────────────────────────────────
/// bsdiff emits three raw streams, and the largest is a byte-wise difference
/// that is mostly zeros. A patch between two 500 KB files that differ in 50
/// bytes comes out at ~500 KB. The size win is entirely in what compresses
/// afterwards — which is why the pipeline is `diff` then `compress`, and why
/// `mendsley/bsdiff` bzip2s the streams inside its own container.
///
/// So `patch_size` in the published manifest now means the UNCOMPRESSED patch,
/// where the old binary reported an already-compressed one.
/// `patch_compressed_size` is what it always was and what the
/// full-versus-patch decision reads.
fn diff(old: &Path, new: &Path, patch: &Path) -> Result<()> {
    let old_bytes = read(old)?;
    let new_bytes = read(new)?;

    let mut out = BufWriter::new(create(patch)?);
    bsdiff::diff(&old_bytes, &new_bytes, &mut out)
        .with_context(|| format!("diffing {} -> {}", old.display(), new.display()))?;
    out.flush().context("flushing the patch")?;
    Ok(())
}

/// The inverse. Not used by the publish flow — it is here so the format
/// round-trips within our own tooling, which is the only thing that makes the
/// patch format a contract rather than an implementation detail.
fn apply(old: &Path, patch: &Path, new: &Path) -> Result<()> {
    let old_bytes = read(old)?;
    let patch_bytes = read(patch)?;

    let mut produced = Vec::new();
    bsdiff::patch(&old_bytes, &mut patch_bytes.as_slice(), &mut produced)
        .with_context(|| format!("applying {}", patch.display()))?;

    let mut out = BufWriter::new(create(new)?);
    out.write_all(&produced)
        .with_context(|| format!("writing {}", new.display()))?;
    out.flush().context("flushing the result")?;
    Ok(())
}

fn compress(input: &Path, output: &Path, level: i32) -> Result<()> {
    if !(1..=22).contains(&level) {
        bail!("zstd level must be 1..=22, got {level}");
    }
    // Streamed rather than read-whole: a layer tar is the largest thing this
    // tool touches, and compression has no reason to hold it all in memory.
    let mut reader = BufReader::new(open(input)?);
    let mut writer = BufWriter::new(create(output)?);
    zstd::stream::copy_encode(&mut reader, &mut writer, level)
        .with_context(|| format!("compressing {}", input.display()))?;
    writer.flush().context("flushing the archive")?;
    Ok(())
}

fn decompress(input: &Path, output: &Path) -> Result<()> {
    let mut reader = BufReader::new(open(input)?);
    let mut writer = BufWriter::new(create(output)?);
    zstd::stream::copy_decode(&mut reader, &mut writer)
        .with_context(|| format!("decompressing {}", input.display()))?;
    writer.flush().context("flushing the result")?;
    Ok(())
}

// ── Argument plumbing ───────────────────────────────────────────────────────

fn two(args: &[String], usage: &str) -> Result<(PathBuf, PathBuf)> {
    match (args.get(1), args.get(2)) {
        (Some(a), Some(b)) => Ok((PathBuf::from(a), PathBuf::from(b))),
        _ => Err(anyhow!("usage: carbon-delta {usage}")),
    }
}

fn three(args: &[String], usage: &str) -> Result<(PathBuf, PathBuf, PathBuf)> {
    match (args.get(1), args.get(2), args.get(3)) {
        (Some(a), Some(b), Some(c)) => {
            Ok((PathBuf::from(a), PathBuf::from(b), PathBuf::from(c)))
        }
        _ => Err(anyhow!("usage: carbon-delta {usage}")),
    }
}

fn open(path: &Path) -> Result<File> {
    File::open(path).with_context(|| format!("opening {}", path.display()))
}

fn create(path: &Path) -> Result<File> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating {}", parent.display()))?;
        }
    }
    File::create(path).with_context(|| format!("creating {}", path.display()))
}

fn read(path: &Path) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    open(path)?
        .read_to_end(&mut bytes)
        .with_context(|| format!("reading {}", path.display()))?;
    Ok(bytes)
}

// ── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// A temp dir that cleans up, without a dev-dependency for it.
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("carbon-delta-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    /// Something compressible and diffable, like a tar of a release layer.
    fn layer(seed: u8, len: usize) -> Vec<u8> {
        (0..len).map(|i| (i as u8).wrapping_mul(seed).wrapping_add(7)).collect()
    }

    #[test]
    fn a_patch_round_trips() {
        let dir = scratch("roundtrip");
        let old_path = dir.join("old.tar");
        let new_path = dir.join("new.tar");
        let patch_path = dir.join("patch.bsdiff");
        let rebuilt = dir.join("rebuilt.tar");

        let old_bytes = layer(3, 200_000);
        let mut new_bytes = old_bytes.clone();
        // A realistic release delta: most of the layer is untouched.
        new_bytes[100_000..100_100].fill(0xAB);
        new_bytes.extend_from_slice(b"a newly added file's contents");

        std::fs::write(&old_path, &old_bytes).unwrap();
        std::fs::write(&new_path, &new_bytes).unwrap();

        diff(&old_path, &new_path, &patch_path).expect("diff");
        apply(&old_path, &patch_path, &rebuilt).expect("apply");

        assert_eq!(std::fs::read(&rebuilt).unwrap(), new_bytes);
    }

    #[test]
    fn a_compressed_patch_is_far_smaller_than_the_file_it_rebuilds() {
        // The property the release flow actually depends on, and it is the
        // COMPRESSED patch that has it. `diff` emits raw streams that are
        // mostly zeros — comparable in size to the input, and highly
        // compressible. Asserting on the raw patch instead was this test's
        // first form, and it failed at 500,024 bytes against a 500,000 byte
        // file, which is the correct behaviour of the algorithm rather than a
        // bug in it. See the note on `diff`.
        let dir = scratch("size");
        let old_path = dir.join("old.tar");
        let new_path = dir.join("new.tar");
        let patch_path = dir.join("patch.bsdiff");
        let packed = dir.join("patch.bsdiff.zst");

        let old_bytes = layer(5, 500_000);
        let mut new_bytes = old_bytes.clone();
        new_bytes[250_000..250_050].fill(0x11);

        std::fs::write(&old_path, &old_bytes).unwrap();
        std::fs::write(&new_path, &new_bytes).unwrap();
        diff(&old_path, &new_path, &patch_path).expect("diff");
        compress(&patch_path, &packed, DEFAULT_LEVEL).expect("compress");

        let packed_size = std::fs::metadata(&packed).unwrap().len();
        assert!(
            packed_size < new_bytes.len() as u64 / 10,
            "compressed patch was {packed_size} bytes against a {} byte file",
            new_bytes.len()
        );
    }

    #[test]
    fn compression_round_trips_and_shrinks() {
        let dir = scratch("zstd");
        let raw = dir.join("layer.tar");
        let packed = dir.join("layer.tar.zst");
        let unpacked = dir.join("layer.out");

        let bytes = layer(9, 300_000);
        std::fs::write(&raw, &bytes).unwrap();

        compress(&raw, &packed, DEFAULT_LEVEL).expect("compress");
        decompress(&packed, &unpacked).expect("decompress");

        assert_eq!(std::fs::read(&unpacked).unwrap(), bytes);
        assert!(std::fs::metadata(&packed).unwrap().len() < bytes.len() as u64);
    }

    #[test]
    fn an_out_of_range_level_is_refused_rather_than_clamped() {
        let dir = scratch("level");
        let raw = dir.join("in");
        std::fs::write(&raw, b"x").unwrap();
        assert!(compress(&raw, &dir.join("out"), 99).is_err());
    }

    #[test]
    fn a_missing_input_names_the_file() {
        let dir = scratch("missing");
        let err = compress(&dir.join("nope"), &dir.join("out"), 3).unwrap_err();
        assert!(format!("{err:#}").contains("nope"), "message was: {err:#}");
    }

    #[test]
    fn unknown_commands_and_bad_arity_are_usage_errors() {
        assert!(run(&["frobnicate".into()]).is_err());
        assert!(run(&["diff".into(), "only-one".into()]).is_err());
        assert!(run(&[]).is_err());
    }
}

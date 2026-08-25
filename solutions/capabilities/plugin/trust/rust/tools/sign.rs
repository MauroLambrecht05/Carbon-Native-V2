// carbon-plugin-sign — the executable half of the plugin trust pipeline.
//
//   carbon-plugin-sign keygen [--out PATH]
//   carbon-plugin-sign sign   <artifact...> [--key PATH]
//   carbon-plugin-sign verify <artifact...> --pubkey <hex>
//   carbon-plugin-sign hash   <artifact...>
//
// ── WHY A BINARY AND NOT A SCRIPT ───────────────────────────────────────────
// It has to produce the exact bytes the loader checks. A script that shells out
// to `openssl` or hashes with a different tool is a second implementation of
// the agreement, and the first time the two disagree is the first time a real
// plugin fails to load on a user's machine. This links the same
// `carbon-plugin-trust` library the runtime does.
//
// Argument parsing is hand-rolled: four subcommands and two flags do not earn a
// clap dependency in a tool whose whole purpose is a small trusted surface.

use anyhow::{anyhow, Result};
use carbon_plugin_trust::digest::{decode_hex, encode_hex};
use carbon_plugin_trust::{keyfile, signing, verification, ContentHash};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

const USAGE: &str = "\
carbon-plugin-sign — Ed25519 signing for carbon native plugins

USAGE:
  carbon-plugin-sign keygen [--out <path>]
      Mint a new signing key. Defaults to ~/.carbon/keys/plugin-signing.key.
      Prints the PUBLIC key, including the Rust constant to paste into
      solutions/infrastructure/plugin-host/adapters/plugin_loader.rs.
      Refuses to overwrite an existing key.

  carbon-plugin-sign sign <artifact>... [--key <path>]
      Hash each artifact and write a detached <artifact>.sig beside it.

  carbon-plugin-sign verify <artifact>... --pubkey <64-hex-chars>
      Check each artifact against its .sig, exactly as the loader does.
      Also runs the revocation-list check. Exit 1 if any artifact fails.

  carbon-plugin-sign hash <artifact>...
      Print each artifact's SHA-256 content hash — the identity the
      revocation list names. No key needed.
";

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("carbon-plugin-sign: {e:#}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(command) = args.first().map(String::as_str) else {
        print!("{USAGE}");
        return Err(anyhow!("no subcommand given"));
    };

    match command {
        "-h" | "--help" | "help" => {
            print!("{USAGE}");
            Ok(())
        }
        "keygen" => keygen(&args[1..]),
        "sign" => sign(&args[1..]),
        "verify" => verify(&args[1..]),
        "hash" => hash(&args[1..]),
        other => {
            print!("{USAGE}");
            Err(anyhow!("unknown subcommand `{other}`"))
        }
    }
}

// ── Subcommands ────────────────────────────────────────────────────────────

fn keygen(args: &[String]) -> Result<()> {
    let (flags, rest) = split_flags(args)?;
    if !rest.is_empty() {
        return Err(anyhow!("keygen takes no positional arguments"));
    }
    let path = match flags.get("out") {
        Some(p) => PathBuf::from(p),
        None => keyfile::default_path()?,
    };

    let key = keyfile::generate()?;
    keyfile::write(&path, &key)?;
    let public = key.verifying_key().to_bytes();

    println!("Private key written to: {}", path.display());
    println!();
    println!("  KEEP THIS FILE SECRET AND BACK IT UP.");
    println!("  It is not in the repository and must never be. Anyone holding it");
    println!("  can sign a plugin that every Carbon app will load; losing it means");
    println!("  no already-published plugin can ever be re-signed.");
    println!();
    println!("Public key (hex): {}", encode_hex(&public));
    println!();
    println!("Paste this into plugin_loader.rs as CARBON_PLUGIN_PUBLIC_KEY:");
    println!();
    println!("{}", rust_array_literal(&public));
    Ok(())
}

fn sign(args: &[String]) -> Result<()> {
    let (flags, artifacts) = split_flags(args)?;
    if artifacts.is_empty() {
        return Err(anyhow!("sign needs at least one artifact path"));
    }
    let key_path = match flags.get("key") {
        Some(p) => PathBuf::from(p),
        None => keyfile::default_path()?,
    };
    let key = keyfile::read(&key_path)?;

    for artifact in &artifacts {
        let signed = signing::sign_artifact(Path::new(artifact), &key)?;
        println!("signed  {}", signed.artifact.display());
        println!("  hash      {}", signed.content_hash);
        println!("  signature {}", signed.signature.display());
    }
    Ok(())
}

fn verify(args: &[String]) -> Result<()> {
    let (flags, artifacts) = split_flags(args)?;
    if artifacts.is_empty() {
        return Err(anyhow!("verify needs at least one artifact path"));
    }
    let hex = flags.get("pubkey").ok_or_else(|| {
        anyhow!(
            "verify needs --pubkey <64 hex chars>.\n  \
             The authoritative one is CARBON_PLUGIN_PUBLIC_KEY in \
             solutions/infrastructure/plugin-host/adapters/plugin_loader.rs — \
             this tool deliberately does not read it from anywhere, so that \
             `verify` passing can never mean anything weaker than the loader's \
             own check."
        )
    })?;
    let public = parse_public_key(hex)?;

    let mut failures = 0usize;
    for artifact in &artifacts {
        let path = Path::new(artifact);
        match verification::verify_artifact(path, &public)
            .and_then(|h| carbon_plugin_trust::ensure_not_revoked(&h).map(|()| h))
        {
            Ok(h) => println!("OK      {}  {h}", path.display()),
            Err(e) => {
                failures += 1;
                println!("REFUSED {}\n  {e:#}", path.display());
            }
        }
    }
    if failures > 0 {
        return Err(anyhow!("{failures} artifact(s) failed verification"));
    }
    Ok(())
}

fn hash(args: &[String]) -> Result<()> {
    let (_, artifacts) = split_flags(args)?;
    if artifacts.is_empty() {
        return Err(anyhow!("hash needs at least one artifact path"));
    }
    for artifact in &artifacts {
        let bytes = std::fs::read(artifact).map_err(|e| anyhow!("reading {artifact}: {e}"))?;
        println!("{}  {artifact}", ContentHash::of(&bytes));
    }
    Ok(())
}

// ── Argument handling ──────────────────────────────────────────────────────

type Flags = std::collections::BTreeMap<String, String>;

/// Split `--name value` pairs from positional arguments. `--name=value` works
/// too. Anything else starting with `--` is an error rather than being ignored,
/// because a silently-dropped `--key` would sign with the wrong key.
fn split_flags(args: &[String]) -> Result<(Flags, Vec<String>)> {
    let mut flags = Flags::new();
    let mut positional = Vec::new();
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        if let Some(body) = arg.strip_prefix("--") {
            if let Some((name, value)) = body.split_once('=') {
                flags.insert(name.to_string(), value.to_string());
            } else {
                let value = args
                    .get(i + 1)
                    .ok_or_else(|| anyhow!("`--{body}` needs a value"))?;
                flags.insert(body.to_string(), value.clone());
                i += 1;
            }
        } else {
            positional.push(arg.clone());
        }
        i += 1;
    }
    Ok((flags, positional))
}

fn parse_public_key(hex: &str) -> Result<[u8; verification::PUBLIC_KEY_LEN]> {
    let bytes = decode_hex(hex.trim(), verification::PUBLIC_KEY_LEN).ok_or_else(|| {
        anyhow!(
            "--pubkey must be exactly {} hex characters",
            verification::PUBLIC_KEY_LEN * 2
        )
    })?;
    let mut out = [0u8; verification::PUBLIC_KEY_LEN];
    out.copy_from_slice(&bytes);
    Ok(out)
}

/// The public key as a Rust array literal, formatted to paste straight into the
/// loader — copying 32 numbers by hand is how a trust anchor gets a typo.
fn rust_array_literal(public: &[u8; verification::PUBLIC_KEY_LEN]) -> String {
    let mut s = String::from("const CARBON_PLUGIN_PUBLIC_KEY: [u8; 32] = [\n");
    for row in public.chunks(8) {
        s.push_str("    ");
        for b in row {
            s.push_str(&format!("0x{b:02x}, "));
        }
        s.push('\n');
    }
    s.push_str("];\n");
    s
}

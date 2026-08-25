//! carbon-import-check — run the import-table denylist against a built plugin.
//!
//!   carbon-import-check <artifact.dll>...        check, exit 1 on any violation
//!   carbon-import-check --list <artifact.dll>    print the import table, exit 0
//!   carbon-import-check --allow <module> ...     widen the allowlist, per run
//!   carbon-import-check --host <module> ...      name the host executable
//!
//! `--list` is not a convenience. The C-runtime allowlist in lib.rs was
//! derived by running it against real zig-compiled plugins rather than
//! written from memory, and the next person to wonder whether a new module is
//! legitimate needs the same evidence in the same form.
//!
//! `--allow` exists for the roadmap's escape hatch — a developer's own
//! first-party plugin, which is a different trust tier and never flows through
//! the signing path. It is a per-invocation flag rather than a config file so
//! that widening the policy is visible in the command that did it.

use std::path::PathBuf;
use std::process::ExitCode;

use carbon_plugin_trust::{read_pe_imports, ImportPolicy};

fn main() -> ExitCode {
    match run() {
        Ok(code) => code,
        Err(e) => {
            eprintln!("carbon-import-check: {e:#}");
            ExitCode::from(2)
        }
    }
}

struct Args {
    artifacts: Vec<PathBuf>,
    list_only: bool,
    allow: Vec<String>,
    host: Option<String>,
}

fn parse_args() -> anyhow::Result<Args> {
    let mut artifacts = Vec::new();
    let mut list_only = false;
    let mut allow = Vec::new();
    let mut host = None;

    let mut argv = std::env::args().skip(1);
    while let Some(arg) = argv.next() {
        match arg.as_str() {
            "--list" => list_only = true,
            "--allow" => allow.push(
                argv.next()
                    .ok_or_else(|| anyhow::anyhow!("--allow needs a module name"))?,
            ),
            "--host" => {
                host = Some(
                    argv.next()
                        .ok_or_else(|| anyhow::anyhow!("--host needs a module name"))?,
                )
            }
            "-h" | "--help" => {
                println!("{}", HELP);
                std::process::exit(0);
            }
            other if other.starts_with("--") => {
                anyhow::bail!("unknown flag {other}\n\n{HELP}")
            }
            other => artifacts.push(PathBuf::from(other)),
        }
    }

    if artifacts.is_empty() {
        anyhow::bail!("no artifact given\n\n{HELP}");
    }
    Ok(Args {
        artifacts,
        list_only,
        allow,
        host,
    })
}

const HELP: &str = "\
usage: carbon-import-check [--list] [--allow <module>]... [--host <module>] <artifact>...

  --list            print the import table and exit 0 without judging it
  --allow <module>  allow one more module for this run only (first-party
                    plugins, which are a different trust tier)
  --host <module>   the host executable whose exports are the carbon SDK

Exit codes: 0 clean, 1 at least one violation, 2 could not read an artifact.";

fn run() -> anyhow::Result<ExitCode> {
    let args = parse_args()?;

    let mut policy = ImportPolicy::carbon_plugin();
    for module in &args.allow {
        policy = policy.allow_module(module);
    }
    if let Some(host) = &args.host {
        policy = policy.with_host_module(host);
    }

    let mut any_failed = false;

    for path in &args.artifacts {
        let imports = read_pe_imports(path)
            .map_err(|e| anyhow::anyhow!("{}: {e}", path.display()))?;

        if args.list_only {
            println!("{} — {} imports", path.display(), imports.len());
            for import in &imports {
                println!("  {import}");
            }
            continue;
        }

        let report = policy.check(imports);
        if report.passed() {
            println!(
                "PASS  {}  ({} imports from {})",
                path.display(),
                report.imports.len(),
                report.modules().join(", ")
            );
        } else {
            any_failed = true;
            println!(
                "FAIL  {}  ({} violation(s))",
                path.display(),
                report.violations.len()
            );
            for violation in &report.violations {
                println!("      {violation}");
            }
        }
    }

    Ok(if any_failed {
        ExitCode::from(1)
    } else {
        ExitCode::SUCCESS
    })
}

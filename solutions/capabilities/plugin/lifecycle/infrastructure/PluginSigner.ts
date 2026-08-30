// Signing a standard (carbon-sdk) plugin artifact with Carbon's own
// plugin-signing key.
//
// ── WHY THIS IS DIFFERENT FROM `carbon plugin build`/`install` ─────────────
// Those two stay unsigned on purpose — they're what a THIRD-PARTY plugin
// AUTHOR uses on their OWN plugin, and plugin_loader.rs's own comment on
// "the first-party escape hatch" is explicit that unsigned-by-default is the
// correct state for that case until a real per-project developer-key
// mechanism exists.
//
// carbon-sdk plugins (fonts, clipboard, dialog, ...) are different: they are
// NOT third-party code an end user's app happens to load — they ship AS
// PART of carbon-sdk, built and distributed by `carbon plugin add <name>`.
// Treating them as "just another unsigned local build" would mean every
// carbon app either sets CARBON_ALLOW_UNSIGNED_PLUGINS permanently (defeats
// the trust boundary for every OTHER plugin too, since that env var has no
// per-plugin scope) or ships with official plugins the loader refuses to
// load outside `carbon dev`. Neither is acceptable, so `AddPluginCommand`
// signs the artifact itself before installing it, using the SAME real key
// `plugin_loader.rs`'s hardcoded `CARBON_PLUGIN_PUBLIC_KEY` verifies
// against (generated once via `carbon-plugin-sign keygen`, kept at
// `~/.carbon/keys/plugin-signing.key`, never committed — see
// solutions/capabilities/plugin/trust/rust/infrastructure/keyfile.rs).
//
// Deliberately NOT auto-generating a key if one is missing: the private key
// is a real secret with real blast radius ("anyone holding it can sign a
// plugin that every Carbon app will load", per keygen's own printed
// warning) — minting one silently on whatever machine happens to run
// `carbon plugin add` first would produce a key nobody backed up and,
// worse, could produce a DIFFERENT key than the one plugin_loader.rs's
// hardcoded public half actually verifies against, making every official
// plugin fail to load with a confusing signature error instead of a clear
// "you don't have the signing key" one.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Logger } from "@carbon/logging";
import { run as spawnRun } from "@carbon/process";
import { CARGO_WORKSPACE_DIR, TARGET_DIR } from "@carbon/workspace";

const EXE = process.platform === "win32" ? ".exe" : "";
const BINARY_PROFILES = ["release", "debug"] as const;

function signToolPath(profile: (typeof BINARY_PROFILES)[number]): string {
  return join(TARGET_DIR, profile, `carbon-plugin-sign${EXE}`);
}

function resolveSignTool(): string | null {
  for (const profile of BINARY_PROFILES) {
    const p = signToolPath(profile);
    if (existsSync(p)) return p;
  }
  return null;
}

/** `~/.carbon/keys/plugin-signing.key` (`%USERPROFILE%` on Windows) — must
 *  match keyfile.rs's `default_path()` exactly; this is diagnostic only
 *  (the actual signing invocation lets carbon-plugin-sign resolve its own
 *  default), so drift here means a wrong hint, not a wrong key. */
function defaultKeyPathHint(): string {
  return join(homedir(), ".carbon", "keys", "plugin-signing.key");
}

export class MissingSigningKeyError extends Error {
  constructor() {
    super(
      `no Carbon plugin-signing key found at ${defaultKeyPathHint()}.\n` +
        `  carbon-sdk plugins ship as official Carbon plugins and must be signed —\n` +
        `  see solutions/capabilities/plugin/lifecycle/infrastructure/PluginSigner.ts\n` +
        `  for why this isn't auto-generated. If you're a Carbon maintainer, restore\n` +
        `  the key from wherever it's backed up; \`carbon-plugin-sign keygen\` mints a\n` +
        `  NEW one, which will NOT match plugin_loader.rs's hardcoded public key.`,
    );
    this.name = "MissingSigningKeyError";
  }
}

async function ensureSignTool(logger: Logger): Promise<string> {
  const existing = resolveSignTool();
  if (existing) return existing;

  logger.step("building carbon-plugin-sign (first run only)…");
  const cargoEnv = { ...process.env, CARGO_TARGET_DIR: TARGET_DIR };
  const { code, stderr } = await spawnRun(
    "cargo",
    ["build", "--bin", "carbon-plugin-sign", "-p", "carbon-plugin-trust"],
    { cwd: CARGO_WORKSPACE_DIR, env: cargoEnv, stdio: "pipe" },
  );
  if (code !== 0) {
    if (stderr) logger.raw(stderr.trimEnd());
    throw new Error(`cargo build for carbon-plugin-sign failed (exit ${code})`);
  }
  const built = resolveSignTool();
  if (!built) throw new Error("cargo finished but carbon-plugin-sign binary was not found");
  return built;
}

/**
 * Signs `artifactPath` in place (writes `<artifactPath>.sig` beside it)
 * using Carbon's own key at its default location. Throws
 * {@link MissingSigningKeyError} if that key isn't present on this
 * machine — never falls back to leaving the plugin unsigned.
 */
export async function signStandardPluginArtifact(artifactPath: string, logger: Logger): Promise<void> {
  if (!existsSync(defaultKeyPathHint())) throw new MissingSigningKeyError();

  const tool = await ensureSignTool(logger);
  const { code, stderr } = await spawnRun(tool, ["sign", artifactPath], { stdio: "pipe" });
  if (code !== 0) {
    if (stderr) logger.raw(stderr.trimEnd());
    throw new Error(`carbon-plugin-sign failed (exit ${code})`);
  }
}

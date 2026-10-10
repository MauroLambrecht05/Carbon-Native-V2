// The BuildPipeline for Carbon apps: the same compile and package steps
// `carbon build` runs locally (through the LocalPipeline port), with the
// Windows code-signing certificate taken from the lease's secrets.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { InstallerTargetId } from "@carbon/contracts/distribution";
import type { AuthenticodeCredentials } from "@carbon/signing";
import { loadCarbonConfig, manifestPath } from "@carbon/workspace";
import { BuildFailure, type BuildPipeline, type BuildResult, type BuildRun } from "../application/ports/LeasedBuild.ts";
import type { LocalPipeline } from "../application/ports/LocalPipeline.ts";

/** Installer targets each platform can produce. */
const TARGETS: Record<string, readonly InstallerTargetId[]> = { windows: ["nsis", "wix"], linux: ["appimage", "deb"], macos: ["dmg"] };

/** Secret names a build may bind to have its Windows installers Authenticode-signed. */
export const WINDOWS_CERTIFICATE_SECRET = "WINDOWS_CERTIFICATE";
export const WINDOWS_CERTIFICATE_PASSWORD_SECRET = "WINDOWS_CERTIFICATE_PASSWORD";

export class CarbonBuildPipeline implements BuildPipeline {
  /** `pipeline` builds the LocalPipeline for one run, given the signing credentials that run's secrets provide. */
  constructor(private readonly pipeline: (authenticode: AuthenticodeCredentials | undefined, log: (text: string) => void) => LocalPipeline) {}

  async run(input: BuildRun): Promise<BuildResult> {
    const allowed = TARGETS[input.source.platform] ?? [];
    const targets = input.source.targets.map(target => { if (!allowed.includes(target as InstallerTargetId)) throw new BuildFailure("target.unsupported", `${target} cannot be built on ${input.source.platform}`); return target as InstallerTargetId; });
    let config: Awaited<ReturnType<typeof loadCarbonConfig>>;
    try { config = await loadCarbonConfig(input.sourceDirectory); } catch { throw new BuildFailure("configuration.invalid", "The project configuration could not be read"); }
    const manifest = manifestPath(input.sourceDirectory);

    // A PFX, base64-encoded in the secret. It is written inside the workspace, so it is erased with it.
    let authenticode: AuthenticodeCredentials | undefined; const certificate = input.secrets[WINDOWS_CERTIFICATE_SECRET];
    if (certificate !== undefined) {
      const password = input.secrets[WINDOWS_CERTIFICATE_PASSWORD_SECRET];
      if (password === undefined) throw new BuildFailure("signing.misconfigured", "The signing certificate has no password secret");
      const certPath = join(input.scratchDirectory, "signing.pfx"); writeFileSync(certPath, Buffer.from(certificate, "base64"), { mode: 0o600 });
      authenticode = { certPath, certPassword: password };
    }

    const pipeline = this.pipeline(authenticode, input.log);
    const fail = (category: string) => (error: unknown) => { throw new BuildFailure(category, String(error)); };
    const { binaryPath } = await pipeline.compile(input.sourceDirectory, config).catch(fail("compile.failed"));
    const outputs: { target: string; path: string }[] = [];
    for (const target of targets) {
      if (input.signal.aborted) break;
      input.log(`Packaging ${target}`);
      outputs.push({ target, path: (await pipeline.packageTarget(config, binaryPath, target, join(input.outputDirectory, target)).catch(fail("package.failed"))).path });
    }
    return { outputs, tools: [{ name: "bun", version: Bun.version }],
      configurationDigest: existsSync(manifest) ? createHash("sha256").update(readFileSync(manifest)).digest("hex") : null };
  }
}

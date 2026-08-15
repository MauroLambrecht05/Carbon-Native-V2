// macOS code signing + notarization — the two-step Gatekeeper needs before
// a downloaded binary runs without a warning. Single-executable scope only
// (see the KNOWN GAP in packaging's dmg.ts builder: nothing produces a
// proper .app bundle yet, so there's no bundle-signing dance to mirror from
// sign-macos.sh here, just its "signing a single executable" branch).
//
// notarytool's `--wait` blocks until Apple's done, rather than this
// replicating sign-macos.sh + notarize-poll.sh's separate submit/poll
// scripts — appropriate for a worker, which needs one synchronous result,
// not a human watching progress in a terminal.

import type { ProcessRunner } from "@carbon/process";

export interface MacOsCredentials {
  readonly developerId: string; // codesign identity, e.g. "Developer ID Application: ..."
  readonly appleId: string;
  readonly appPassword: string;
  readonly teamId: string;
}

export class CodesignError extends Error {
  constructor(readonly code: number) {
    super(`codesign exited with code ${code}`);
  }
}

export class NotarizeError extends Error {
  constructor(readonly code: number) {
    super(`notarytool submit exited with code ${code}`);
  }
}

export class StapleError extends Error {
  constructor(readonly code: number) {
    super(`stapler staple exited with code ${code}`);
  }
}

export async function signAndNotarizeMacOs(
  filePath: string,
  credentials: MacOsCredentials,
  runner: ProcessRunner,
): Promise<void> {
  const signed = await runner.run("codesign", [
    "--force", "--options", "runtime", "--timestamp",
    "--sign", credentials.developerId,
    filePath,
  ]);
  if (signed.code !== 0) throw new CodesignError(signed.code);

  const submitted = await runner.run("xcrun", [
    "notarytool", "submit", filePath,
    "--apple-id", credentials.appleId,
    "--password", credentials.appPassword,
    "--team-id", credentials.teamId,
    "--wait",
  ]);
  if (submitted.code !== 0) throw new NotarizeError(submitted.code);

  const stapled = await runner.run("xcrun", ["stapler", "staple", filePath]);
  if (stapled.code !== 0) throw new StapleError(stapled.code);
}

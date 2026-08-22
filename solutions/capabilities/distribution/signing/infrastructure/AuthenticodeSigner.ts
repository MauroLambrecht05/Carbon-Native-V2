// Windows code signing via signtool.exe — a real OS signature (what SmartScreen
// and Windows Defender check), separate from the minisign signature
// SignFileUseCase produces for update-manifest verification. An installer
// commonly carries both: this one so Windows trusts the binary at all, the
// minisign one so the updater trusts it came from this release.
//
// Mirrors .tools/automation/ci/sign-windows.ps1's Sign-FileWithSignTool
// exactly (same flags, same default timestamp server) — that script is now
// the CI-only path for a workstation without this repo's TS toolchain; a
// build worker uses this instead.

import type { ProcessRunner } from "@carbon/process";

export interface AuthenticodeCredentials {
  readonly certPath: string;
  readonly certPassword: string;
  readonly timestampServer?: string;
}

export class AuthenticodeSignError extends Error {
  constructor(readonly code: number) {
    super(`signtool sign exited with code ${code}`);
  }
}

const DEFAULT_TIMESTAMP_SERVER = "http://timestamp.digicert.com";

export async function signAuthenticode(
  filePath: string,
  credentials: AuthenticodeCredentials,
  runner: ProcessRunner,
): Promise<void> {
  const result = await runner.run("signtool", [
    "sign",
    "/f", credentials.certPath,
    "/p", credentials.certPassword,
    "/fd", "SHA256",
    "/tr", credentials.timestampServer ?? DEFAULT_TIMESTAMP_SERVER,
    "/td", "SHA256",
    filePath,
  ]);
  if (result.code !== 0) throw new AuthenticodeSignError(result.code);
}

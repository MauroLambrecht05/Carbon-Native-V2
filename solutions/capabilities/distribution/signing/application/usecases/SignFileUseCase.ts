// Use case: sign an artifact, producing a detached `<file>.sig`.

import { readFileSync } from "node:fs";
import { SIGNATURE_BYTES } from "../../domain/value-objects/Keypair.ts";
import { ALGORITHM, readSecretKey, writeSigFile, type SigFile } from "../../infrastructure/MinisignKeyStore.ts";

// Purpose is an agreement with `updating`, which checks it when verifying, so
// it lives in contracts/security rather than here. Re-exported because callers
// have always imported it from @carbon/signing.
export type { Purpose } from "@carbon/contracts/security";
import type { Purpose } from "@carbon/contracts/security";

/** Signs `file` and writes `<file>.sig` beside it; returns the .sig path. */
export function signFile(
  file: string,
  keyFile: string,
  password: string,
  _purpose: Purpose = "app",
): string {
  const bytes = new Uint8Array(readFileSync(file));
  const sk = readSecretKey(keyFile, password);

  const sigFile: SigFile = {
    algorithm: ALGORITHM,
    keyId: sk.keyId,
    globalSignature: sk.sign(bytes),
    trustedComment: "",
    commentSignature: new Uint8Array(SIGNATURE_BYTES),
  };

  const sigPath = `${file}.sig`;
  writeSigFile(sigFile, sigPath);
  return sigPath;
}

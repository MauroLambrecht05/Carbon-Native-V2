// Use case: check an artifact against a detached signature and a public key.

import { readFileSync } from "node:fs";
import { readPublicKey, readSigFile } from "../../infrastructure/MinisignKeyStore.ts";

/**
 * Throws if the signature does not verify, matching the Rust crate's
 * `Result<()>` contract — callers treat "returned" as "valid" and are not
 * tempted to ignore a boolean.
 */
export function verifyFile(file: string, sigFile: string, pubkeyFile: string): void {
  const bytes = new Uint8Array(readFileSync(file));
  const sigData = readSigFile(sigFile);
  const pubkey = readPublicKey(pubkeyFile);
  pubkey.verify(bytes, sigData.globalSignature);
}

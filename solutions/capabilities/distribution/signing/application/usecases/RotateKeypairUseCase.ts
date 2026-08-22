// Use case: mint a new keypair and cross-sign it with the outgoing one.
//
// Ported from V1 tools/signer/src/rotate.rs, unchanged in behaviour.
//
// The cross-signature is what makes rotation safe for clients that only know
// the old public key: they can check that whoever controls the old key vouched
// for the new one, and adopt it without an out-of-band trust step.

import { basename, extname } from "node:path";
import { generateKeypair } from "../../domain/value-objects/Keypair.ts";
import { readSecretKey, writeKeypair } from "../../infrastructure/MinisignKeyStore.ts";
import type { KeyringEntry } from "./SignManifestUseCase.ts";
import { KEYRING_DEFAULT_VALIDITY_WINDOW_DAYS } from "@carbon/contracts/security";

// The window is part of the agreement with `updating`, which honours it when
// deciding whether a signature from the outgoing key is still acceptable.
export const DEFAULT_VALIDITY_WINDOW_DAYS = KEYRING_DEFAULT_VALIDITY_WINDOW_DAYS;

export function rotateKeypair(
  oldKeyPath: string,
  oldPassword: string,
  outDir: string,
  newPassword: string,
): KeyringEntry {
  const oldSk = readSecretKey(oldKeyPath, oldPassword);
  const oldVk = oldSk.verifyingKey();

  const { signingKey: newSk, verifyingKey: newVk } = generateKeypair();

  // NOTE: the new keypair is written under the OLD key's basename, so when
  // outDir is the old key's own directory this overwrites the outgoing secret
  // key — which is still needed for the validity window. Inherited from V1.
  const name = basename(oldKeyPath, extname(oldKeyPath)) || "rotated";
  writeKeypair(newSk, newVk, name, newPassword, outDir);

  const newVkB64 = Buffer.from(newVk.toBytes()).toString("base64");
  const oldVkB64 = Buffer.from(oldVk.toBytes()).toString("base64");

  // Signed by the OLD key, over old||new — the direction that matters, since
  // the old key is the one clients already trust.
  const crossSigMessage = new TextEncoder().encode(`${oldVkB64}${newVkB64}`);
  const crossSigB64 = Buffer.from(oldSk.sign(crossSigMessage)).toString("base64");

  return {
    primary: newVkB64,
    secondary: oldVkB64,
    secondary_signed_by_primary: crossSigB64,
    validity_window_days: DEFAULT_VALIDITY_WINDOW_DAYS,
  };
}

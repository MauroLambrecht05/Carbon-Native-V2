// Use case: mint a new signing identity and write it to disk.

import { mkdirSync } from "node:fs";
import { generateKeypair, type VerifyingKey } from "../../domain/value-objects/Keypair.ts";
import { writeKeypair } from "../../infrastructure/MinisignKeyStore.ts";

export interface GenerateResult {
  readonly verifyingKey: VerifyingKey;
  readonly pubkeyPath: string;
  readonly seckeyPath: string;
}

export function generate(name: string, password: string, outDir: string): GenerateResult {
  mkdirSync(outDir, { recursive: true });
  const { signingKey, verifyingKey } = generateKeypair();
  const { pubkeyPath, seckeyPath } = writeKeypair(signingKey, verifyingKey, name, password, outDir);
  return { verifyingKey, pubkeyPath, seckeyPath };
}

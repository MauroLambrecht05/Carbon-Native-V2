import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { TotpVerifier } from "../application/ports/TotpVerifier.ts";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function encodeBase32(bytes: Uint8Array): string {
  let value = 0; let bits = 0; let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { output += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
    value &= (1 << bits) - 1;
  }
  if (bits) output += ALPHABET[(value << (5 - bits)) & 31];
  return output;
}
function decodeBase32(secret: string): Buffer {
  if (!/^[A-Z2-7]{32,128}$/.test(secret)) throw new Error("Invalid TOTP key");
  let value = 0; let bits = 0; const bytes: number[] = [];
  for (const character of secret) {
    value = (value << 5) | ALPHABET.indexOf(character); bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; }
    value &= (1 << bits) - 1;
  }
  if (value !== 0) throw new Error("Noncanonical TOTP key");
  return Buffer.from(bytes);
}

/** RFC 6238, SHA-1/30 seconds/6 digits for authenticator interoperability. */
export class Rfc6238Totp implements TotpVerifier {
  generateSecret(): string { return encodeBase32(randomBytes(20)); }
  code(secret: string, counter: number, digits: 6 | 8 = 6): string {
    if (!Number.isSafeInteger(counter) || counter < 0) throw new Error("Invalid TOTP counter");
    const bytes = Buffer.alloc(8); bytes.writeBigUInt64BE(BigInt(counter));
    const key = decodeBase32(secret);
    try {
      const digest = createHmac("sha1", key).update(bytes).digest();
      const offset = digest[digest.length - 1]! & 15;
      return ((digest.readUInt32BE(offset) & 0x7fffffff) % (10 ** digits)).toString().padStart(digits, "0");
    } finally { key.fill(0); }
  }
  verify(secret: string, code: string, now: Date): number | null {
    if (!/^[0-9]{6}$/.test(code)) return null;
    const current = Math.floor(now.getTime() / 30000); let matched: number | null = null;
    for (const counter of [current - 1, current, current + 1]) {
      if (counter < 0) continue;
      if (timingSafeEqual(Buffer.from(this.code(secret, counter)), Buffer.from(code))) matched = counter;
    }
    return matched;
  }
}

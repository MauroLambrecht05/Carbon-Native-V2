import { expect, test } from "bun:test";
import { Rfc6238Totp, encodeBase32 } from "../infrastructure/Rfc6238Totp.ts";

test("TOTP matches independent RFC 6238 SHA-1 test vectors, including dates beyond 2038", () => {
  const totp = new Rfc6238Totp();
  const secret = encodeBase32(Buffer.from("12345678901234567890"));
  const vectors: [number, string][] = [[59, "94287082"], [1111111109, "07081804"], [1111111111, "14050471"], [1234567890, "89005924"], [2000000000, "69279037"], [20000000000, "65353130"]];
  for (const [seconds, expected] of vectors) expect(totp.code(secret, Math.floor(seconds / 30), 8)).toBe(expected);
});

test("TOTP bounds clock skew, validates input and generates 160-bit secrets", () => {
  const totp = new Rfc6238Totp(); const secret = totp.generateSecret(); const now = new Date("2026-09-12T12:00:00Z");
  expect(secret).toMatch(/^[A-Z2-7]{32}$/);
  const counter = now.getTime() / 30000;
  for (const offset of [-1, 0, 1]) expect(totp.verify(secret, totp.code(secret, counter + offset), now)).toBe(counter + offset);
  expect(totp.verify(secret, totp.code(secret, counter + 3), now)).toBeNull();
  for (const invalid of ["", "12345", "1234567", "abcdef", " 123456"]) expect(totp.verify(secret, invalid, now)).toBeNull();
});

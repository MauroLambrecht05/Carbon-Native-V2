// Signing, end to end, against a real filesystem.
//
// This is the test that was being run by hand every turn, and it caught two
// real regressions — a rewritten minisign format after a data loss, and a use
// case left calling a method that had moved to a repository. Neither was
// visible to a unit test, because both were about layers agreeing.
//
// It crosses: contracts -> domain (Keypair) -> application (use cases) ->
// infrastructure (the minisign byte format) -> the filesystem.
//
// ON THE TIMEOUTS. Every key operation runs Argon2id at m=65540 KiB, t=3, p=4
// — roughly 2-4 seconds in pure TypeScript. That cost is the point: it is a
// password KDF, and cheap would mean a weak one. So keypairs are generated
// once in beforeAll and shared, and the timeouts are generous. Written the
// obvious way, with a fresh key per test, this file needed ~17 derivations and
// took over a minute.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generate, signFile, verifyFile, rotateKeypair } from "../index.ts";

/** One Argon2id derivation is seconds; give anything touching a key room. */
const KDF = 60_000;

const PASSWORD = "correct horse battery staple";
let dir: string;
let mine: { pubkeyPath: string; seckeyPath: string };
let theirs: { pubkeyPath: string; seckeyPath: string };

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "carbon-signing-"));
  mine = generate("mine", PASSWORD, dir);
  theirs = generate("theirs", PASSWORD, dir);
}, KDF);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function artifact(name: string, contents: string): string {
  const path = join(dir, name);
  writeFileSync(path, contents);
  return path;
}

describe("round trip", () => {
  test("a signed artifact verifies", () => {
    const file = artifact("payload.bin", "carbon release 1.0.0");
    const sigPath = signFile(file, mine.seckeyPath, PASSWORD);

    expect(sigPath).toBe(`${file}.sig`);
    expect(() => verifyFile(file, sigPath, mine.pubkeyPath)).not.toThrow();
  }, KDF);

  test("the key files are the minisign shape V1 wrote", () => {
    const pub = readFileSync(mine.pubkeyPath, "utf8").split("\n");
    expect(pub[0]).toBe("untrusted comment: minisign public key");
    // algorithm(2) + key id(8) + public key(32)
    expect(Buffer.from(pub[1], "base64").length).toBe(42);

    const sec = readFileSync(mine.seckeyPath, "utf8").split("\n");
    expect(sec[0]).toBe("untrusted comment: minisign secret key");
    // 2+2+2 tags + 32 salt + 8 + 8 limits + 8 key id + 24 nonce + 80 sealed
    expect(Buffer.from(sec[1], "base64").length).toBe(166);
  });

  test("a signature file is algorithm + key id + signature", () => {
    const file = artifact("shape.bin", "x");
    const sigPath = signFile(file, mine.seckeyPath, PASSWORD);

    const sig = readFileSync(sigPath, "utf8").split("\n");
    expect(sig[0]).toBe("untrusted comment: signature");
    expect(Buffer.from(sig[1], "base64").length).toBe(74);
  }, KDF);
});

describe("rejects what it should", () => {
  test("a wrong password does not open the key", () => {
    const file = artifact("wrongpw.bin", "x");
    expect(() => signFile(file, mine.seckeyPath, "not the password")).toThrow(/wrong password/i);
  }, KDF);

  test("a tampered artifact fails verification", () => {
    const file = artifact("tamper.bin", "original");
    const sigPath = signFile(file, mine.seckeyPath, PASSWORD);

    writeFileSync(file, "tampered");

    expect(() => verifyFile(file, sigPath, mine.pubkeyPath)).toThrow(/verification failed/i);
  }, KDF);

  test("a signature from another key fails verification", () => {
    const file = artifact("crosskey.bin", "payload");
    const sigPath = signFile(file, theirs.seckeyPath, PASSWORD);

    expect(() => verifyFile(file, sigPath, mine.pubkeyPath)).toThrow(/verification failed/i);
  }, KDF);
});

describe("key rotation", () => {
  test("cross-signs the new key with the old so clients can adopt it", () => {
    const outgoing = generate("rotate-me", PASSWORD, dir);
    const before = readFileSync(outgoing.pubkeyPath, "utf8");

    const keyring = rotateKeypair(outgoing.seckeyPath, PASSWORD, dir, "new-password");

    expect(keyring.secondary).toBeTruthy();
    expect(keyring.primary).not.toBe(keyring.secondary);
    expect(keyring.secondary_signed_by_primary).toBeTruthy();
    expect(keyring.validity_window_days).toBeGreaterThan(0);

    // The rotated keypair is written under the OLD key's basename, so the
    // outgoing secret key is overwritten — which you still need for the
    // validity window. Inherited from V1, asserted here so that the day
    // someone fixes it, this test says the behaviour changed on purpose.
    expect(readFileSync(outgoing.pubkeyPath, "utf8")).not.toBe(before);

    // And the rotated key works under its new password.
    const file = artifact("rotated.bin", "after rotation");
    const sigPath = signFile(file, outgoing.seckeyPath, "new-password");
    expect(() => verifyFile(file, sigPath, outgoing.pubkeyPath)).not.toThrow();
  }, KDF * 2);
});

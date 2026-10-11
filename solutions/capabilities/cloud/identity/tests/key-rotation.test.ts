import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { EnvelopeMessageProtector } from "../index.ts";

// The key that protects Cloud's stored messages (pending email, list cursors) is rotated by adding a new key,
// making it the active one, and removing the old key once nothing sealed with it is still needed.
test("rotating the message key: old data opens while the old key is kept, new data uses the new key, and a removed key opens nothing", async () => {
  const first = randomBytes(32).toString("base64"); const second = randomBytes(32).toString("base64");
  const before = new EnvelopeMessageProtector("key-2026-01", { "key-2026-01": first });
  const sealed = await before.seal("the pending message", "mail:1");
  // Step 1: both keys are present and the new one is active.
  const during = new EnvelopeMessageProtector("key-2026-02", { "key-2026-01": first, "key-2026-02": second });
  expect(await during.open(sealed, "mail:1")).toBe("the pending message");
  const fresh = await during.seal("a newer message", "mail:2"); expect(await during.open(fresh, "mail:2")).toBe("a newer message");
  // Sealed under the new key: the old deployment, which never had it, cannot open it.
  await expect(before.open(fresh, "mail:2").then(() => "opened", () => "refused")).resolves.toBe("refused");
  // Step 2: the old key is removed. What it sealed is gone for good; what the new key sealed is unaffected.
  const after = new EnvelopeMessageProtector("key-2026-02", { "key-2026-02": second });
  await expect(after.open(sealed, "mail:1").then(() => "opened", () => "refused")).resolves.toBe("refused"); expect(await after.open(fresh, "mail:2")).toBe("a newer message");
  // A sealed value is bound to what it was sealed for, under either key.
  await expect(during.open(sealed, "mail:2").then(() => "opened", () => "refused")).resolves.toBe("refused");
  // An active key that is not among the keys is a start-up error, not a silent fallback.
  expect(() => new EnvelopeMessageProtector("key-2026-03", { "key-2026-02": second })).toThrow();
});

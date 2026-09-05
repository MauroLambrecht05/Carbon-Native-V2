import { describe, expect, test } from "bun:test";
import {
  ConsumeMagicLinkUseCase,
  InMemoryAuthRepository,
  MAGIC_LINK_TTL_MS,
  RequestMagicLinkUseCase,
  VerifyEndUserSessionUseCase,
} from "../index.ts";
import { MagicLinkToken } from "../domain/entities/MagicLinkToken.ts";

function harness() {
  const auth = new InMemoryAuthRepository();
  return {
    auth,
    requestLink: new RequestMagicLinkUseCase(auth),
    consumeLink: new ConsumeMagicLinkUseCase(auth),
    verifySession: new VerifyEndUserSessionUseCase(auth),
  };
}

const ORG_A = "org-a";
const ORG_B = "org-b";

describe("magic-link sign-in", () => {
  test("requesting a link for a new email creates the end user and issues a usable token", async () => {
    const h = harness();
    const { endUserId, plaintextToken } = await h.requestLink.execute(ORG_A, "Person@Example.com");

    expect(endUserId).toBeTruthy();
    expect(plaintextToken).toStartWith("ml_");

    const { sessionToken, orgId, endUserId: consumedUserId } = await h.consumeLink.execute(plaintextToken);
    expect(sessionToken).toStartWith("es_");
    expect(orgId).toBe(ORG_A);
    expect(consumedUserId).toBe(endUserId);
  });

  test("requesting a link twice for the SAME email finds the existing end user rather than duplicating it", async () => {
    const h = harness();
    const first = await h.requestLink.execute(ORG_A, "same@example.com");
    const second = await h.requestLink.execute(ORG_A, "same@example.com");
    expect(second.endUserId).toBe(first.endUserId);
  });

  test("email is case- and whitespace-normalized", async () => {
    const h = harness();
    const a = await h.requestLink.execute(ORG_A, "  Mixed.Case@Example.com  ");
    const b = await h.requestLink.execute(ORG_A, "mixed.case@example.com");
    expect(b.endUserId).toBe(a.endUserId);
  });

  test("rejects a request with no @ in the email", async () => {
    const h = harness();
    await expect(h.requestLink.execute(ORG_A, "not-an-email")).rejects.toThrow(/valid email/);
  });

  test("the SAME email in two different orgs is two different end users", async () => {
    const h = harness();
    const a = await h.requestLink.execute(ORG_A, "shared@example.com");
    const b = await h.requestLink.execute(ORG_B, "shared@example.com");
    expect(a.endUserId).not.toBe(b.endUserId);
  });

  test("a token can only be consumed once", async () => {
    const h = harness();
    const { plaintextToken } = await h.requestLink.execute(ORG_A, "once@example.com");
    await h.consumeLink.execute(plaintextToken);
    await expect(h.consumeLink.execute(plaintextToken)).rejects.toThrow(/invalid, already used, or has expired/);
  });

  test("an expired token is refused", async () => {
    const h = harness();
    // Issue directly with a `now` in the past so isUsable()'s expiry check
    // is what fails, not consumption — the same technique
    // signing.rs's own tests use a fixed seed for: deterministic, not
    // dependent on a real 15-minute wait.
    const longAgo = new Date(Date.now() - MAGIC_LINK_TTL_MS - 1000);
    const { endUserId } = await h.requestLink.execute(ORG_A, "expired@example.com");
    const expiredToken = MagicLinkToken.issue({ id: crypto.randomUUID(), endUserId, plaintext: "ml_expiredtoken", now: longAgo });
    await h.auth.saveMagicLinkToken(expiredToken);

    await expect(h.consumeLink.execute("ml_expiredtoken")).rejects.toThrow(/invalid, already used, or has expired/);
  });

  test("a garbage token is refused, not a crash", async () => {
    const h = harness();
    await expect(h.consumeLink.execute("not-a-real-token")).rejects.toThrow();
  });

  test(
    "consuming a magic link always scopes the session to the token's OWN org — " +
      "there is no way for a caller to claim a different org (see ConsumeMagicLinkUseCase's own comment)",
    async () => {
      const h = harness();
      const { plaintextToken } = await h.requestLink.execute(ORG_A, "scoped@example.com");
      const { orgId } = await h.consumeLink.execute(plaintextToken);
      expect(orgId).toBe(ORG_A);
      expect(orgId).not.toBe(ORG_B);
    },
  );
});

describe("session verification", () => {
  test("a real session verifies to its end user and org", async () => {
    const h = harness();
    const { plaintextToken } = await h.requestLink.execute(ORG_A, "verify@example.com");
    const { sessionToken, endUserId, orgId } = await h.consumeLink.execute(plaintextToken);

    expect(await h.verifySession.execute(sessionToken)).toEqual({ endUserId, orgId });
  });

  test("a garbage session token verifies to null, not an error", async () => {
    const h = harness();
    expect(await h.verifySession.execute("not-a-real-session")).toBeNull();
  });

  test("the magic-link token itself does not verify as a session", async () => {
    const h = harness();
    const { plaintextToken } = await h.requestLink.execute(ORG_A, "wrong-namespace@example.com");
    expect(await h.verifySession.execute(plaintextToken)).toBeNull();
  });
});

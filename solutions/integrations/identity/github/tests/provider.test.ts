import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { GitHubAccountProvider } from "../index.ts";

const callback = "https://cloud.example.test/platform/v1/auth/github/callback";
const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const token = { access_token: "gho_fixture_secret", token_type: "bearer", scope: "user:email", refresh_token: "refresh_fixture_secret" };
const user = { id: 123456, type: "User", login: "mutable-login", name: "Carbon member", email: "unverified-public@example.test", two_factor_authentication: true };
const emails = [{ email: "Verified@example.test", primary: true, verified: true }, { email: "other@example.test", primary: false, verified: true }, { email: "unverified@example.test", primary: false, verified: false }];
function harness(replies: (unknown | Response | Error)[] = [token, user, emails]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const provider = new GitHubAccountProvider("fixture-client", "fixture-client-secret", callback, (async (input, init) => {
    calls.push({ url: String(input), init: init! }); const value = replies.shift();
    if (value instanceof Error) throw value;
    return value instanceof Response ? value : Response.json(value);
  }) as typeof fetch);
  return { provider, calls };
}

test("GitHub authorization pins callback, explicit email scope, account picker and RFC S256 challenge", () => {
  const { provider } = harness(); const challenge = createHash("sha256").update(verifier).digest("base64url");
  expect(challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  const url = new URL(provider.authorizationUrl("state_" + "a".repeat(43), challenge));
  expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
  expect(Object.fromEntries(url.searchParams)).toEqual({ client_id: "fixture-client", redirect_uri: callback, state: "state_" + "a".repeat(43), scope: "user:email", code_challenge: challenge, code_challenge_method: "S256", prompt: "select_account" });
  expect(url.href).not.toContain("fixture-client-secret");
  expect(() => provider.authorizationUrl("weak", challenge)).toThrow();
});

test("GitHub exchange revalidates immutable subject and verified email without returning provider credentials or MFA claims", async () => {
  const { provider, calls } = harness(); const result = await provider.exchange("temporary-code", verifier);
  expect(result).toEqual({ provider: "github", subject: "123456", name: "Carbon member", primaryEmail: "verified@example.test", verifiedEmails: ["other@example.test", "verified@example.test"] });
  expect(JSON.stringify(result)).not.toMatch(/secret|unverified|two_factor/);
  expect(calls.map(call => call.url)).toEqual(["https://github.com/login/oauth/access_token", "https://api.github.com/user", "https://api.github.com/user/emails?per_page=100&page=1"]);
  expect(Object.fromEntries(new URLSearchParams(String(calls[0]!.init.body)))).toEqual({ client_id: "fixture-client", client_secret: "fixture-client-secret", code: "temporary-code", code_verifier: verifier, redirect_uri: callback });
  for (const call of calls) { expect(call.init.redirect).toBe("error"); expect(call.init.signal).toBeInstanceOf(AbortSignal); }
  expect(new Headers(calls[1]!.init.headers).get("authorization")).toBe("Bearer gho_fixture_secret");
  expect(new Headers(calls[1]!.init.headers).get("x-github-api-version")).toBe("2026-03-10");
});

test("GitHub email enumeration uses bounded pinned pages and normalizes the display name by Unicode characters", async () => {
  const first = Array.from({ length: 100 }, (_, i) => ({ email: `email-${i}@example.test`, primary: false, verified: false }));
  const { provider, calls } = harness([token, { ...user, name: "\n" + "😀".repeat(101) }, first, emails]);
  const result = await provider.exchange("code", verifier);
  expect(Array.from(result.name)).toHaveLength(100); expect(result.name).not.toContain("\n");
  expect(result.primaryEmail).toBe("verified@example.test"); expect(calls.at(-1)!.url).toBe("https://api.github.com/user/emails?per_page=100&page=2");
  const exhausted = harness([token, user, ...Array.from({ length: 10 }, () => first)]);
  await expect(exhausted.provider.exchange("code", verifier)).rejects.toMatchObject({ code: "unavailable" });
  expect(exhausted.calls).toHaveLength(12);
});

test("GitHub rejects missing verified primary email, bot identities and unsafe numeric subjects", async () => {
  for (const candidate of [[], [{ email: "unverified@example.test", primary: true, verified: false }], [...emails, { email: "ambiguous@example.test", primary: true, verified: true }]]) {
    await expect(harness([token, user, candidate]).provider.exchange("code", verifier)).rejects.toMatchObject({ code: "forbidden" });
  }
  for (const candidate of [{ ...user, id: Number.MAX_SAFE_INTEGER + 1 }, { ...user, id: -1 }, { ...user, type: "Bot" }, { ...user, id: "123" }]) {
    await expect(harness([token, candidate]).provider.exchange("code", verifier)).rejects.toMatchObject({ code: "unauthenticated" });
  }
});

test("GitHub sanitizes errors, rejects redirects and oversized responses, and never retries a code exchange", async () => {
  const failures = [new Error("fixture-client-secret gho_fixture_secret"), new Response("secret error", { status: 503 }), new Response("secret redirect", { status: 302, headers: { location: "https://attacker.example" } }), new Response("x".repeat(262145)), new Response("invalid secret JSON")];
  for (const failure of failures) {
    const { provider, calls } = harness([failure]); let error: unknown;
    try { await provider.exchange("code", verifier); } catch (value) { error = value; }
    expect(error).toMatchObject({ code: "unavailable" }); expect(String(error)).not.toContain("secret"); expect(calls).toHaveLength(1);
  }
  for (const candidate of [{ error: "bad_verification_code", error_description: "secret" }, { ...token, access_token: "secret\r\nheader: injection" }, { ...token, token_type: "mac" }, null]) {
    await expect(harness([candidate]).provider.exchange("code", verifier)).rejects.toMatchObject({ code: "unauthenticated" });
  }
});

test("GitHub rejects malformed proofs before transport and permits only an exact configured secure or loopback callback", async () => {
  const { provider, calls } = harness();
  await expect(provider.exchange("code", "short")).rejects.toMatchObject({ code: "validation" });
  await expect(provider.exchange("code\n", verifier)).rejects.toMatchObject({ code: "validation" }); expect(calls).toHaveLength(0);
  for (const url of ["http://cloud.example.test/platform/v1/auth/github/callback", callback + "?next=evil", callback + "#state", "https://user:password@cloud.example.test/platform/v1/auth/github/callback", "https://cloud.example.test/other"]) {
    expect(() => new GitHubAccountProvider("client", "secret", url)).toThrow();
  }
  expect(() => new GitHubAccountProvider("client", "secret", "http://127.0.0.1:3000/platform/v1/auth/github/callback")).not.toThrow();
});

import { beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPair, SignJWT } from "jose";
import { ServiceAssertionIssuer, ServiceAssertionVerifier, bodyDigest, type AssertionInput, type AssertionKey, type AssertionRequest } from "../infrastructure/ServiceAssertions.ts";
import type { AssertionSecurityStore } from "../application/ports/AssertionSecurityStore.ts";
import { assertion, ids, principal, scope } from "../../../../contracts/platform/fixtures/conformance.ts";
import { accountGrants, hasGrant } from "../domain/policies/PlatformAuthorization.ts";

const now = new Date("2026-09-12T08:00:00Z");
const seconds = now.getTime() / 1000;
let privateKey: AssertionKey;
let publicKey: AssertionKey;
beforeAll(async () => {
  const pair = await generateKeyPair("EdDSA", { crv: "Ed25519" });
  privateKey = { id: "key-2026-09", key: pair.privateKey, notBefore: seconds - 3600, notAfter: seconds + 3600 };
  publicKey = { ...privateKey, key: pair.publicKey };
});

function setup() {
  let current = true;
  const consumed = new Set<string>();
  const security: AssertionSecurityStore = {
    async isCurrent() { return current; },
    async consume(issuer, audience, jti) { const id = `${issuer}|${audience}|${jti}`; if (consumed.has(id)) return false; consumed.add(id); return true; },
  };
  const input: AssertionInput = { aud: "carbon-database", principal, scope, roles: ["Developer"], grants: [{ permission: "data.read", scope }], requestId: ids.request, request: assertion.request };
  const request: AssertionRequest = { ...assertion.request, scope, permission: "data.read", principalKinds: ["account"] };
  return { input, request, security, revoke: () => { current = false; },
    issuer: new ServiceAssertionIssuer(assertion.iss, privateKey, () => now),
    verifier: new ServiceAssertionVerifier(assertion.iss, "carbon-database", [publicKey], security, () => now) };
}

describe("service assertions", () => {
  test("signs exact scope/request and consumes each assertion once", async () => {
    const s = setup(); const token = await s.issuer.issue(s.input);
    expect((await s.verifier.verify(token, s.request)).principal).toEqual(principal);
    await expect(s.verifier.verify(token, s.request)).rejects.toThrow("Invalid service assertion");
    // A transport retry mints a new assertion; its command idempotency key stays unchanged.
    expect((await s.verifier.verify(await s.issuer.issue(s.input), s.request)).scope).toEqual(scope);
  });
  test("rejects audience, permission, resource, request and principal confusion", async () => {
    for (const patch of [
      { scope: { ...scope, orgId: ids.account } }, { scope: { ...scope, projectId: ids.account } },
      { scope: { ...scope, environmentId: ids.account } }, { permission: "data.write" as const },
      { path: "/another-path" }, { method: "POST" as const }, { bodyDigest: bodyDigest("changed") },
      { principalKinds: ["operator" as const] },
    ]) {
      const s = setup(); await expect(s.verifier.verify(await s.issuer.issue(s.input), { ...s.request, ...patch })).rejects.toThrow("Invalid service assertion");
    }
    const s = setup();
    const token = await s.issuer.issue({ ...s.input, aud: "carbon-registry" });
    await expect(s.verifier.verify(token, s.request)).rejects.toThrow("Invalid service assertion");
  });
  test("checks live revocation and fails closed on authority-store outage", async () => {
    const s = setup(); const token = await s.issuer.issue(s.input); s.revoke();
    await expect(s.verifier.verify(token, s.request)).rejects.toThrow("Invalid service assertion");
    const verifier = new ServiceAssertionVerifier(assertion.iss, "carbon-database", [publicKey], { ...s.security, isCurrent: async () => { throw new Error("backend unavailable"); } }, () => now);
    await expect(verifier.verify(token, s.request)).rejects.toThrow("Invalid service assertion");
  });
  test("rejects expired/future tokens and revoked or unknown keys", async () => {
    const s = setup(); const token = await s.issuer.issue(s.input);
    for (const date of [new Date(now.getTime() + 66000), new Date(now.getTime() - 60000)]) {
      await expect(new ServiceAssertionVerifier(assertion.iss, "carbon-database", [publicKey], s.security, () => date).verify(token, s.request)).rejects.toThrow("Invalid service assertion");
    }
    for (const key of [{ ...publicKey, revoked: true }, { ...publicKey, id: "new-key" }]) {
      await expect(new ServiceAssertionVerifier(assertion.iss, "carbon-database", [key], s.security, () => now).verify(token, s.request)).rejects.toThrow("Invalid service assertion");
    }
  });
  test("rejects malicious signed claims, token types and key-discovery headers", async () => {
    const s = setup();
    const claims = { ...assertion, iat: seconds, nbf: seconds, exp: seconds + 60 };
    for (const patch of [{ exp: seconds + 3600 }, { sub: ids.org }, { version: 2 }, { principal: { ...principal, audience: "operator" } }, { grants: [{ permission: "data.read", scope: { orgId: ids.account } }] }]) {
      const token = await new SignJWT({ ...claims, ...patch }).setProtectedHeader({ alg: "EdDSA", typ: "carbon-internal+jwt", kid: publicKey.id }).sign(privateKey.key);
      await expect(s.verifier.verify(token, s.request)).rejects.toThrow("Invalid service assertion");
    }
    for (const header of [{ typ: "JWT" }, { jku: "https://attacker.example.test/keys" }]) {
      const token = await new SignJWT(claims).setProtectedHeader({ alg: "EdDSA", typ: "carbon-internal+jwt", kid: publicKey.id, ...header }).sign(privateKey.key);
      await expect(s.verifier.verify(token, s.request)).rejects.toThrow("Invalid service assertion");
    }
  });
  test("allows pinned rotation overlap", async () => {
    const s = setup(); const pair = await generateKeyPair("EdDSA", { crv: "Ed25519" });
    const next = { ...privateKey, id: "next", key: pair.privateKey };
    const verifier = new ServiceAssertionVerifier(assertion.iss, "carbon-database", [publicKey, { ...next, key: pair.publicKey }], s.security, () => now);
    await verifier.verify(await s.issuer.issue(s.input), s.request);
    await verifier.verify(await new ServiceAssertionIssuer(assertion.iss, next, () => now).issue(s.input), s.request);
  });
});

test("membership resolution denies other tenants, stale authority, operators and Billing data access", () => {
  const resource = { organizationState: "active", projectState: "active", environmentState: "active", environmentKind: "development" } as const;
  const membership = { accountId: ids.account, orgId: ids.org, role: "Developer" as const, state: "active" as const, permissionRevision: "1", projectIds: [ids.project], grants: [{ permission: "data.read" as const, scope }] };
  expect(hasGrant(accountGrants(principal, membership, scope, resource), "data.read", scope)).toBe(true);
  expect(accountGrants(principal, membership, { ...scope, orgId: ids.account }, resource)).toEqual([]);
  expect(accountGrants(principal, membership, { ...scope, projectId: ids.account }, resource)).toEqual([]);
  expect(accountGrants({ ...principal, permissionRevision: "2" }, membership, scope, resource)).toEqual([]);
  expect(accountGrants({ ...principal, kind: "operator", audience: "operator" }, membership, scope, resource)).toEqual([]);
  const grants = accountGrants(principal, { ...membership, role: "Billing", grants: [{ permission: "data.read", scope }] }, scope, resource);
  expect(hasGrant(grants, "data.read", scope)).toBe(false);
  expect(hasGrant(grants, "billing.manage", scope)).toBe(true);
});

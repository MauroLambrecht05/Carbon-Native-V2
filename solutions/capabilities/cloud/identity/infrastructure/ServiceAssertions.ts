import { createHash, randomUUID } from "node:crypto";
import { SignJWT, jwtVerify, type CryptoKey, type KeyObject } from "jose";
import { parseComponent, type InternalAssertion, type Permission, type Scope, type ServiceAudience } from "@carbon/contracts/platform";
import { hasGrant, sameScope, scopeContains } from "../domain/policies/PlatformAuthorization.ts";
import type { AssertionSecurityStore } from "../application/ports/AssertionSecurityStore.ts";

const TYPE = "carbon-internal+jwt";
const MAX_TTL_SECONDS = 60;
const CLOCK_TOLERANCE_SECONDS = 5;
type SigningKey = CryptoKey | KeyObject;
export interface AssertionKey {
  readonly id: string;
  readonly key: SigningKey;
  readonly notBefore: number;
  readonly notAfter: number;
  readonly revoked?: boolean;
}
export type AssertionInput = Omit<InternalAssertion, "version" | "iss" | "jti" | "iat" | "nbf" | "exp" | "sub">;

export function bodyDigest(bytes: Uint8Array | string = ""): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function validateAuthority(assertion: InternalAssertion): void {
  if (assertion.sub !== assertion.principal.id) throw new Error("Invalid assertion subject");
  if (assertion.principal.kind === "app_user" && !assertion.scope.realmId) throw new Error("App assertion requires realm");
  if (assertion.grants.some(grant => !scopeContains(assertion.scope, grant.scope))) throw new Error("Grant exceeds assertion scope");
}

export class ServiceAssertionIssuer {
  constructor(private readonly issuer: string, private readonly signingKey: AssertionKey, private readonly now = () => new Date()) {
    const url = new URL(issuer);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) throw new Error("Assertion issuer requires HTTPS");
  }

  async issue(input: AssertionInput): Promise<string> {
    const timestamp = Math.floor(this.now().getTime() / 1000);
    const key = this.signingKey;
    if (key.revoked || timestamp < key.notBefore || timestamp + MAX_TTL_SECONDS > key.notAfter) throw new Error("No active assertion signing key");
    const claims = parseComponent("InternalAssertion", {
      ...input, version: 1, iss: this.issuer, sub: input.principal.id,
      jti: randomUUID(), iat: timestamp, nbf: timestamp, exp: timestamp + MAX_TTL_SECONDS,
    });
    validateAuthority(claims);
    return new SignJWT(claims).setProtectedHeader({ alg: "EdDSA", typ: TYPE, kid: key.id }).sign(key.key);
  }
}

export class InvalidServiceAssertionError extends Error {
  constructor() { super("Invalid service assertion"); this.name = "InvalidServiceAssertionError"; }
}

export interface AssertionRequest {
  readonly scope: Scope;
  readonly permission: Permission;
  readonly method: InternalAssertion["request"]["method"];
  /** Exact pathname plus query string as received, without decoding/reordering. */
  readonly path: string;
  readonly bodyDigest: string;
  readonly principalKinds: readonly InternalAssertion["principal"]["kind"][];
}

/** Pinned issuer + locally configured keys only. No jku/x5u discovery from tokens. */
export class ServiceAssertionVerifier {
  private readonly keys: ReadonlyMap<string, AssertionKey>;
  constructor(
    private readonly issuer: string,
    private readonly audience: ServiceAudience,
    keys: readonly AssertionKey[],
    private readonly security: AssertionSecurityStore,
    private readonly now = () => new Date(),
  ) {
    if (!keys.length || new Set(keys.map(k => k.id)).size !== keys.length) throw new Error("Assertion keys must be nonempty and uniquely identified");
    this.keys = new Map(keys.map(k => [k.id, k]));
  }

  /** Cryptographic inspection only. It grants no request or live resource authority. */
  async inspect(token: string): Promise<InternalAssertion> {
    try {
      if (token.length > 32768) throw new Error("Oversized assertion");
      const currentDate = this.now();
      const timestamp = Math.floor(currentDate.getTime() / 1000);
      const { payload } = await jwtVerify(token, header => {
        if (header.alg !== "EdDSA" || header.typ !== TYPE || !header.kid
          || Object.keys(header).some(k => !["alg", "typ", "kid"].includes(k))) throw new Error("Invalid header");
        const key = this.keys.get(header.kid);
        if (!key || key.revoked || timestamp < key.notBefore || timestamp >= key.notAfter) throw new Error("Unknown/inactive key");
        return key.key;
      }, { issuer: this.issuer, audience: this.audience, algorithms: ["EdDSA"], typ: TYPE, currentDate, clockTolerance: CLOCK_TOLERANCE_SECONDS, maxTokenAge: MAX_TTL_SECONDS });
      const assertion = parseComponent("InternalAssertion", payload);
      validateAuthority(assertion);
      if (assertion.exp <= assertion.iat || assertion.exp - assertion.iat > MAX_TTL_SECONDS || assertion.nbf !== assertion.iat) throw new Error('Invalid assertion lifetime');
      return assertion;
    } catch { throw new InvalidServiceAssertionError(); }
  }

  async verify(token: string, request: AssertionRequest): Promise<InternalAssertion> {
    try {
      const assertion = await this.inspect(token);
      if (!sameScope(assertion.scope, request.scope) || !request.principalKinds.includes(assertion.principal.kind)
        || !hasGrant(assertion.grants, request.permission, request.scope)
        || assertion.request.method !== request.method || assertion.request.path !== request.path
        || assertion.request.bodyDigest !== request.bodyDigest) throw new Error("Assertion binding mismatch");
      if (!await this.security.isCurrent(assertion, token)) throw new Error("Revoked authority");
      if (!await this.security.consume(assertion.iss, assertion.aud, assertion.jti, new Date((assertion.exp + CLOCK_TOLERANCE_SECONDS) * 1000))) throw new Error("Replayed assertion");
      return assertion;
    } catch {
      // Deliberately exclude token, claims and cryptographic diagnostics.
      throw new InvalidServiceAssertionError();
    }
  }
}

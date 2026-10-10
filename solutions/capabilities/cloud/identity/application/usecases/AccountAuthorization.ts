import { PlatformFault, parseComponent, type Scope } from "@carbon/contracts/platform";
import type { PlatformAccessRepository } from "../ports/PlatformAccessRepository.ts";
import { AccountAuthentication, tokenDigest } from "./AccountAuthentication.ts";

export class AccountAuthorization {
  constructor(private readonly auth: AccountAuthentication, private readonly repository: PlatformAccessRepository) {}
  async resolve(token: string, input: Scope) {
    const scope = parseComponent("Scope", input);
    if (scope.realmId) throw new PlatformFault("capability", "Realm authority is not configured");
    const session = await this.auth.session(token);
    if (!session) throw new PlatformFault("unauthenticated", "Sign in to resolve access");
    return this.repository.resolve({ accountId: session.account.id, sessionId: session.id, tokenHash: tokenDigest(token), csrfHash: session.csrfHash,
      permissionRevision: session.account.permissionRevision, securityRevision: session.account.securityRevision }, scope);
  }
}

import { PlatformFault } from "@carbon/contracts/platform";
import type { OrganizationActor } from "../ports/OrganizationRepository.ts";
import { tokenDigest, tokenMatches, type AccountAuthentication } from "./AccountAuthentication.ts";

/**
 * Turns what a request presented into the account it speaks for.
 *
 * A browser presents its session and, for a change, its CSRF token. A tool presents a device (`dc_`) or
 * personal (`pt_`) credential instead; the account behind it is the actor, limited to what that credential was
 * given. A credential is not ambient the way a cookie is, so there is no CSRF token to check for one.
 *
 * Only the use cases that call this accept a credential. Everything else takes a session and nothing else.
 */
export async function requestActor(auth: AccountAuthentication, token: string, csrf: string | undefined, signIn: string): Promise<OrganizationActor> {
  const delegated = await auth.delegation(token);
  if (delegated) return { accountId: delegated.accountId, sessionId: delegated.credentialId, securityRevision: "0", permissionRevision: delegated.permissionRevision,
    tokenHash: tokenDigest(token), csrfHash: "", delegation: delegated.kind };
  const session = await auth.session(token);
  if (!session) throw new PlatformFault("unauthenticated", signIn);
  if (csrf !== undefined && !tokenMatches(csrf, session.csrfHash)) throw new PlatformFault("forbidden", "Invalid CSRF token");
  return { accountId: session.account.id, sessionId: session.id, securityRevision: session.account.securityRevision,
    permissionRevision: session.account.permissionRevision, tokenHash: tokenDigest(token), csrfHash: session.csrfHash };
}

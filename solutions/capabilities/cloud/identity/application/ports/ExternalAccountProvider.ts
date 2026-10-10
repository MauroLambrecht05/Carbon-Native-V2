/** Verified provider identity only: provider access/refresh tokens never leave the adapter. */
export interface ExternalAccountIdentity {
  readonly provider: "github";
  readonly subject: string;
  readonly name: string;
  readonly primaryEmail: string;
  readonly verifiedEmails: readonly string[];
}
export interface ExternalAccountProvider {
  readonly provider: "github";
  authorizationUrl(state: string, codeChallenge: string): string;
  /** Exchange once. The account use case must first consume its browser-bound state. */
  exchange(code: string, codeVerifier: string): Promise<ExternalAccountIdentity>;
}

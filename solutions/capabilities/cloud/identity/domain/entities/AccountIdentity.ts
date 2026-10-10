export interface AccountIdentity {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly avatar: string;
  readonly verifiedAt: string;
  readonly termsVersion: string;
  readonly securityRevision: string;
  readonly permissionRevision: string;
  readonly revision: string;
  readonly mfa: boolean;
}

export interface BrowserSession {
  readonly id: string;
  readonly account: AccountIdentity;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly freshUntil: string;
  readonly deviceName: string;
  readonly csrfHash: string;
}

export interface SessionIssue {
  readonly id: string;
  readonly tokenHash: string;
  readonly csrfHash: string;
  readonly expiresAt: Date;
  readonly freshUntil: Date;
  readonly deviceName: string;
  readonly requestId: string;
}

export interface AccountChallenge {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly purpose: "registration" | "login" | "recovery" | "fresh_auth";
  readonly tokenHash: string;
  readonly browserHash: string;
  readonly termsVersion: string;
  readonly redirectPath: string;
  readonly expiresAt: Date;
  readonly requestKey: string;
  readonly requestDigest: string;
  readonly requestId: string;
  readonly rateKeys: readonly string[];
  readonly protectedMessage: string;
  readonly freshAuth?: FreshAuthBinding;
}

/** Proof bound to one live browser session and its account security revision. */
export interface FreshAuthBinding {
  readonly accountId: string;
  readonly sessionId: string;
  readonly securityRevision: string;
  readonly tokenHash: string;
  readonly csrfHash: string;
}

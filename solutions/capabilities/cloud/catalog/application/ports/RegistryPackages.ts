import type { EnvironmentScope, Principal, RegistryCommand, RegistryPublicPackage, RegistryResult, RegistryVersion } from '@carbon/contracts/platform';

/** Who is asking, for which environment, and a check that they may still ask. `permit` is called again just before anything is committed. */
export interface RegistryAuthority {
  readonly scope: EnvironmentScope;
  readonly bindingId: string;
  readonly principal: Principal;
  readonly requestId: string;
  permit(): Promise<boolean>;
}

/** Where archive bytes are kept. Quarantined and published archives live under different key prefixes of a private bucket. */
export interface RegistryArchiveStore {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
}

export interface ReviewDecision {
  readonly versionId: string;
  /** Who decided. An operator identity, never a customer account. */
  readonly operator: string;
  readonly reason: string;
  readonly requestId: string;
}
export interface ReviewRecord { readonly id: string; readonly versionId: string; readonly decision: 'approved' | 'rejected' | 'revoked'; readonly operator: string; readonly reason: string; readonly evidence: Record<string, unknown>; readonly createdAt: string }

export interface RegistryPackages {
  /** Every canonical command except `namespace.get`, for the organization that owns the request's environment. */
  execute(authority: RegistryAuthority, command: Exclude<RegistryCommand, { kind: 'namespace.get' }>): Promise<RegistryResult>;
  /** Takes the bytes for one reserved upload. The token is the only authority, and exactly the declared bytes are accepted. */
  upload(token: string, bytes: Uint8Array, requestId: string): Promise<RegistryVersion>;

  // Review. Not reachable by any customer credential.
  pending(limit: number): Promise<readonly RegistryVersion[]>;
  approve(decision: ReviewDecision): Promise<RegistryVersion>;
  reject(decision: ReviewDecision): Promise<RegistryVersion>;
  revoke(decision: ReviewDecision): Promise<RegistryVersion>;
  reviews(versionId: string): Promise<readonly ReviewRecord[]>;

  // Public distribution. No credential.
  publicPackage(publisher: string, name: string): Promise<RegistryPublicPackage>;
  publicArchive(publisher: string, name: string, version: string, target: string): Promise<{ readonly bytes: Uint8Array; readonly sha256: string }>;
}

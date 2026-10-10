import type {
  EnvironmentCredential, EnvironmentCredentialCommand, EnvironmentCredentialCreate,
  EnvironmentCredentialPermission, EnvironmentCredentialReceipt, EnvironmentScope,
} from '@carbon/contracts/platform';
import type { OrganizationActor } from '@carbon/identity';

export type EnvironmentCredentialMutation = {
  readonly actor: OrganizationActor;
  readonly scope: EnvironmentScope;
  readonly credentialId?: string;
  readonly command: ({ readonly kind: 'create' } & EnvironmentCredentialCreate) | EnvironmentCredentialCommand;
  readonly token?: { readonly prefix: string; readonly hash: string };
  readonly expectedRevision: string;
  readonly keyDigest: string;
  readonly requestDigest: string;
  readonly requestId: string;
};

export interface EnvironmentCredentialGrant {
  readonly credentialId: string;
  readonly scope: EnvironmentScope;
  readonly audience: 'automation';
  readonly permissions: readonly EnvironmentCredentialPermission[];
  readonly revision: string;
}

export interface EnvironmentCredentialRepository {
  list(actor: OrganizationActor, scope: EnvironmentScope, limit: number, afterId?: string): Promise<readonly EnvironmentCredential[]>;
  execute(mutation: EnvironmentCredentialMutation): Promise<EnvironmentCredentialReceipt>;
  verify(token: string, scope: EnvironmentScope, permission: EnvironmentCredentialPermission): Promise<EnvironmentCredentialGrant>;
}

import type { EnvironmentSecret, EnvironmentSecretCommand, EnvironmentSecretCreate, EnvironmentSecretReceipt, EnvironmentScope } from '@carbon/contracts/platform';
import type { OrganizationActor } from '@carbon/identity';

export interface EnvironmentSecretMutation {
  readonly actor: OrganizationActor;
  readonly scope: EnvironmentScope;
  readonly secretId?: string;
  readonly command: ({ readonly kind: 'create' } & EnvironmentSecretCreate) | EnvironmentSecretCommand;
  readonly expectedRevision: string;
  readonly keyDigest: string;
  readonly requestDigest: string;
  readonly requestId: string;
}

export interface EnvironmentSecretRepository {
  list(actor: OrganizationActor, scope: EnvironmentScope, limit: number, afterId?: string): Promise<readonly EnvironmentSecret[]>;
  execute(mutation: EnvironmentSecretMutation): Promise<EnvironmentSecretReceipt>;
}

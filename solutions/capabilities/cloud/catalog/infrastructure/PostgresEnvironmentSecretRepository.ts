import { randomUUID } from 'node:crypto';
import { PlatformFault, parseComponent, type EnvironmentSecret, type EnvironmentSecretReceipt, type EnvironmentScope } from '@carbon/contracts/platform';
import { PostgresPlatformAuthority, type OrganizationActor } from '@carbon/identity';
import type { EnvironmentSecretMutation, EnvironmentSecretRepository } from '../application/ports/EnvironmentSecretRepository.ts';
import type { SecretProtector } from '../application/ports/SecretProtection.ts';

function projection(row: Record<string, any>): EnvironmentSecret {
  return parseComponent('EnvironmentSecret', {
    id: row.id, scope: { orgId: row.org_id, projectId: row.project_id, environmentId: row.environment_id },
    name: row.name, state: row.state, currentVersion: row.current_version, revision: row.revision,
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
  });
}

export class PostgresEnvironmentSecretRepository extends PostgresPlatformAuthority implements EnvironmentSecretRepository {
  constructor(sql: Bun.SQL, private readonly protector: SecretProtector) { super(sql); }

  private rows(tx: Bun.TransactionSQL, scope: EnvironmentScope, secretId?: string, limit = 1, afterId?: string) {
    return tx<Record<string, any>[]>`SELECT s.*, s.revision::text FROM environment_secrets s
      WHERE s.org_id = ${scope.orgId} AND s.project_id = ${scope.projectId} AND s.environment_id = ${scope.environmentId}
        AND (${secretId ?? null}::uuid IS NULL OR s.id = ${secretId ?? null}::uuid)
        AND (${afterId ?? null}::uuid IS NULL OR s.id > ${afterId ?? null}::uuid)
      ORDER BY s.id LIMIT ${limit}`;
  }

  async list(actor: OrganizationActor, scope: EnvironmentScope, limit: number, afterId?: string) {
    return this.sql.begin(async tx => {
      const access = await this.resolveInTransaction(tx, actor, scope);
      if (!access.permissions.includes('metadata.read')) throw new PlatformFault('forbidden', 'Secret metadata access is not permitted');
      return (await this.rows(tx, scope, undefined, limit, afterId)).map(projection);
    });
  }

  async execute(mutation: EnvironmentSecretMutation): Promise<EnvironmentSecretReceipt> {
    try {
      return await this.sql.begin(async tx => {
        const { actor: inputActor, scope, command } = mutation;
        await tx`SELECT id FROM environments WHERE id = ${scope.environmentId} AND project_id = ${scope.projectId} AND org_id = ${scope.orgId} FOR UPDATE`;
        await this.lockAccounts(tx, [inputActor.accountId]); const currentActor = await this.actor(tx, inputActor);
        const actor = { ...inputActor, permissionRevision: currentActor.permission_revision as string };
        const access = await this.resolveInTransaction(tx, actor, scope);
        if (!access.permissions.includes('resources.configure')) throw new PlatformFault('forbidden', 'Secret management is not permitted');
        const scopeKey = `environment-secret:${scope.orgId}:${scope.projectId}:${scope.environmentId}:${mutation.secretId ?? 'create'}`;
        const previous = await tx`SELECT request_digest, result FROM environment_secret_commands
          WHERE actor_account_id = ${actor.accountId} AND scope_key = ${scopeKey} AND key_digest = ${mutation.keyDigest}`;
        if (previous.length) {
          if (previous[0].request_digest !== mutation.requestDigest) throw new PlatformFault('conflict', 'The idempotency key was used for another command');
          return parseComponent('EnvironmentSecretReceipt', previous[0].result);
        }
        if (!currentActor.fresh) throw new PlatformFault('forbidden', 'Recent authentication is required', { authentication: 'fresh_required' });

        let id = mutation.secretId; let message: string; let action: string; let versionId: string | undefined;
        if (command.kind === 'create') {
          if (mutation.expectedRevision !== access.environmentRevision) throw new PlatformFault('conflict', 'The environment changed; refresh before retrying');
          id = randomUUID(); versionId = randomUUID();
          const protectedValue = await this.protector.seal(command.value, `environment-secret:${id}:version:${versionId}`);
          await tx`INSERT INTO environment_secrets (id, org_id, project_id, environment_id, name, created_by)
            VALUES (${id}, ${scope.orgId}, ${scope.projectId}, ${scope.environmentId}, ${command.name}, ${actor.accountId})`;
          await tx`INSERT INTO environment_secret_versions (id, secret_id, version, wrapping_key_id, envelope, created_by)
            VALUES (${versionId}, ${id}, 1, ${protectedValue.wrappingKeyId}, ${protectedValue.envelope}, ${actor.accountId})`;
          message = 'Environment secret created'; action = 'secret.created';
        } else {
          const current = (await tx<Record<string, any>[]>`SELECT *, revision::text FROM environment_secrets
            WHERE id = ${id!} AND org_id = ${scope.orgId} AND project_id = ${scope.projectId} AND environment_id = ${scope.environmentId} FOR UPDATE`)[0];
          if (!current) throw new PlatformFault('not_found', 'Environment secret not found');
          if (current.revision !== mutation.expectedRevision) throw new PlatformFault('conflict', 'The secret changed; refresh before retrying');
          if (command.kind === 'rotate') {
            versionId = randomUUID(); const nextVersion = current.current_version + 1;
            const protectedValue = await this.protector.seal(command.value, `environment-secret:${id}:version:${versionId}`);
            await tx`INSERT INTO environment_secret_versions (id, secret_id, version, wrapping_key_id, envelope, created_by)
              VALUES (${versionId}, ${id!}, ${nextVersion}, ${protectedValue.wrappingKeyId}, ${protectedValue.envelope}, ${actor.accountId})`;
            await tx`UPDATE environment_secrets SET current_version = ${nextVersion}, revision = revision + 1, updated_at = now() WHERE id = ${id!}`;
            message = 'Environment secret rotated'; action = 'secret.rotated';
          } else {
            const state = command.disabled ? 'disabled' : 'active';
            if (current.state === state) throw new PlatformFault('conflict', `The secret is already ${state}`);
            await tx`UPDATE environment_secrets SET state = ${state}, revision = revision + 1, updated_at = now() WHERE id = ${id!}`;
            message = command.disabled ? 'Environment secret disabled' : 'Environment secret enabled';
            action = command.disabled ? 'secret.disabled' : 'secret.enabled';
          }
        }
        const secret = projection((await this.rows(tx, scope, id))[0]!);
        const receipt = parseComponent('EnvironmentSecretReceipt', { secret, message });
        await tx`INSERT INTO environment_secret_commands (actor_account_id, scope_key, key_digest, request_digest, secret_id, result)
          VALUES (${actor.accountId}, ${scopeKey}, ${mutation.keyDigest}, ${mutation.requestDigest}, ${id!}, ${JSON.stringify(receipt)}::text::jsonb)`;
        await tx`INSERT INTO environment_secret_events
          (id, org_id, project_id, environment_id, secret_id, actor_account_id, action, revision, request_id, metadata)
          VALUES (${randomUUID()}, ${scope.orgId}, ${scope.projectId}, ${scope.environmentId}, ${id!}, ${actor.accountId}, ${action}, ${secret.revision},
            ${mutation.requestId}, ${JSON.stringify({ state: secret.state, version: secret.currentVersion })}::text::jsonb)`;
        return receipt;
      });
    } catch (error: any) {
      if (error instanceof PlatformFault) throw error;
      if (error?.errno === '23505') throw new PlatformFault('conflict', 'A secret with this name already exists');
      throw error;
    }
  }
}

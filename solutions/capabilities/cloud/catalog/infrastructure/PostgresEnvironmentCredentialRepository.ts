import { randomUUID } from 'node:crypto';
import {
  PlatformFault, parseComponent, type EnvironmentCredential, type EnvironmentCredentialPermission,
  type EnvironmentCredentialReceipt, type EnvironmentScope,
} from '@carbon/contracts/platform';
import { PostgresPlatformAuthority, tokenDigest, type OrganizationActor } from '@carbon/identity';
import type {
  EnvironmentCredentialGrant, EnvironmentCredentialMutation, EnvironmentCredentialRepository,
} from '../application/ports/EnvironmentCredentialRepository.ts';

function projection(row: Record<string, any>): EnvironmentCredential {
  return parseComponent('EnvironmentCredential', {
    id: row.id, scope: { orgId: row.org_id, projectId: row.project_id, environmentId: row.environment_id },
    name: row.name, prefix: row.token_prefix, audience: row.audience, permissions: row.permissions,
    status: row.projected_status, expiresAt: row.expires_at.toISOString(), overlapEndsAt: row.overlap_ends_at?.toISOString() ?? null,
    lastUsedAt: row.last_used_at?.toISOString() ?? null, revision: row.revision, createdAt: row.created_at.toISOString(),
  });
}

export class PostgresEnvironmentCredentialRepository extends PostgresPlatformAuthority implements EnvironmentCredentialRepository {
  private async rows(tx: Bun.TransactionSQL, scope: EnvironmentScope, credentialId?: string, limit = 1, afterId?: string) {
    return tx<Record<string, any>[]>`SELECT c.*, c.revision::text,
      CASE WHEN c.status = 'revoked' THEN 'revoked' WHEN c.expires_at <= now() THEN 'expired' ELSE 'active' END AS projected_status,
      (SELECT max(o.valid_until) FROM environment_credential_overlaps o WHERE o.credential_id = c.id AND o.valid_until > now()) AS overlap_ends_at
      FROM environment_credentials c
      WHERE c.org_id = ${scope.orgId} AND c.project_id = ${scope.projectId} AND c.environment_id = ${scope.environmentId}
        AND (${credentialId ?? null}::uuid IS NULL OR c.id = ${credentialId ?? null}::uuid)
        AND (${afterId ?? null}::uuid IS NULL OR c.id > ${afterId ?? null}::uuid)
      ORDER BY c.id LIMIT ${limit}`;
  }

  async list(actor: OrganizationActor, scope: EnvironmentScope, limit: number, afterId?: string) {
    return this.sql.begin(async tx => {
      const access = await this.resolveInTransaction(tx, actor, scope);
      if (!access.permissions.includes('metadata.read')) throw new PlatformFault('forbidden', 'Credential metadata access is not permitted');
      return (await this.rows(tx, scope, undefined, limit, afterId)).map(projection);
    });
  }

  async execute(mutation: EnvironmentCredentialMutation): Promise<EnvironmentCredentialReceipt> {
    try {
      return await this.sql.begin(async tx => {
        const { actor: inputActor, scope, command } = mutation;
        await tx`SELECT id FROM environments WHERE id = ${scope.environmentId} AND project_id = ${scope.projectId} AND org_id = ${scope.orgId} FOR UPDATE`;
        await this.lockAccounts(tx, [inputActor.accountId]);
        const currentActor = await this.actor(tx, inputActor);
        const actor = { ...inputActor, permissionRevision: currentActor.permission_revision as string };
        const access = await this.resolveInTransaction(tx, actor, scope);
        if (!access.permissions.includes('resources.configure')) throw new PlatformFault('forbidden', 'Credential management is not permitted');

        const scopeKey = `environment-credential:${scope.orgId}:${scope.projectId}:${scope.environmentId}:${mutation.credentialId ?? 'create'}`;
        const previous = await tx`SELECT request_digest, kind, result FROM environment_credential_commands
          WHERE actor_account_id = ${actor.accountId} AND scope_key = ${scopeKey} AND key_digest = ${mutation.keyDigest}`;
        if (previous.length) {
          if (previous[0].request_digest !== mutation.requestDigest) throw new PlatformFault('conflict', 'The idempotency key was used for another command');
          if (previous[0].kind !== 'revoke') throw new PlatformFault('conflict', 'The credential was already issued and its token cannot be disclosed again');
          return parseComponent('EnvironmentCredentialReceipt', previous[0].result);
        }
        if (!currentActor.fresh) throw new PlatformFault('forbidden', 'Recent authentication is required', { authentication: 'fresh_required' });

        const clock = (await tx<{ now: Date; limit: Date }[]>`SELECT now() AS now, now() + interval '366 days' AS limit`)[0]!;
        let id = mutation.credentialId; let message: string;
        if (command.kind === 'create') {
          if (mutation.expectedRevision !== access.environmentRevision) throw new PlatformFault('conflict', 'The environment changed; refresh before retrying');
          if (!mutation.token) throw new PlatformFault('internal', 'Credential token material is missing');
          const expiresAt = new Date(command.expiresAt);
          if (expiresAt <= clock.now || expiresAt > clock.limit) throw new PlatformFault('validation', 'Credential expiry must be in the future and within 366 days');
          for (const permission of command.permissions) {
            if (!access.permissions.includes(permission)) throw new PlatformFault('forbidden', 'A credential cannot receive permissions you do not have');
          }
          id = randomUUID();
          await tx`INSERT INTO environment_credentials
            (id, org_id, project_id, environment_id, name, token_prefix, token_hash, permissions, expires_at, created_by)
            VALUES (${id}, ${scope.orgId}, ${scope.projectId}, ${scope.environmentId}, ${command.name}, ${mutation.token.prefix},
              ${mutation.token.hash}, ${JSON.stringify(command.permissions)}::text::jsonb, ${expiresAt}, ${actor.accountId})`;
          message = 'Environment credential created';
        } else {
          const locked = await tx<Record<string, any>[]>`SELECT *, revision::text FROM environment_credentials
            WHERE id = ${id!} AND org_id = ${scope.orgId} AND project_id = ${scope.projectId} AND environment_id = ${scope.environmentId} FOR UPDATE`;
          const current = locked[0];
          if (!current) throw new PlatformFault('not_found', 'Environment credential not found');
          if (current.revision !== mutation.expectedRevision) throw new PlatformFault('conflict', 'The credential changed; refresh before retrying');
          if (current.status === 'revoked') throw new PlatformFault('conflict', 'The credential is revoked');
          if (command.kind === 'rotate') {
            if (!mutation.token) throw new PlatformFault('internal', 'Credential token material is missing');
            const expiresAt = new Date(command.expiresAt);
            if (expiresAt <= clock.now || expiresAt > clock.limit) throw new PlatformFault('validation', 'Credential expiry must be in the future and within 366 days');
            await tx`DELETE FROM environment_credential_overlaps WHERE credential_id = ${id!}`;
            if (command.overlapSeconds > 0 && current.expires_at > clock.now) {
              const validUntil = new Date(Math.min(current.expires_at.getTime(), clock.now.getTime() + command.overlapSeconds * 1000));
              await tx`INSERT INTO environment_credential_overlaps (credential_id, token_prefix, token_hash, valid_until)
                VALUES (${id!}, ${current.token_prefix}, ${current.token_hash}, ${validUntil})`;
            }
            await tx`UPDATE environment_credentials SET token_prefix = ${mutation.token.prefix}, token_hash = ${mutation.token.hash},
              expires_at = ${expiresAt}, revision = revision + 1, updated_at = now() WHERE id = ${id!}`;
            message = 'Environment credential rotated';
          } else {
            await tx`DELETE FROM environment_credential_overlaps WHERE credential_id = ${id!}`;
            await tx`UPDATE environment_credentials SET status = 'revoked', revoked_at = now(), revision = revision + 1, updated_at = now() WHERE id = ${id!}`;
            message = 'Environment credential revoked';
          }
        }

        const row = (await this.rows(tx, scope, id))[0]!;
        const receipt = parseComponent('EnvironmentCredentialReceipt', { credential: projection(row), message });
        await tx`INSERT INTO environment_credential_commands
          (actor_account_id, scope_key, key_digest, request_digest, kind, credential_id, result)
          VALUES (${actor.accountId}, ${scopeKey}, ${mutation.keyDigest}, ${mutation.requestDigest}, ${command.kind}, ${id!}, ${JSON.stringify(receipt)}::text::jsonb)`;
        await tx`INSERT INTO environment_credential_events
          (id, org_id, project_id, environment_id, credential_id, actor_account_id, action, revision, request_id, metadata)
          VALUES (${randomUUID()}, ${scope.orgId}, ${scope.projectId}, ${scope.environmentId}, ${id!}, ${actor.accountId},
            ${`credential.${command.kind === 'create' ? 'created' : command.kind === 'rotate' ? 'rotated' : 'revoked'}`}, ${receipt.credential.revision},
            ${mutation.requestId}, ${JSON.stringify({ permissions: receipt.credential.permissions, audience: receipt.credential.audience })}::text::jsonb)`;
        return receipt;
      });
    } catch (error: any) {
      if (error instanceof PlatformFault) throw error;
      if (error?.errno === '23505') throw new PlatformFault('conflict', 'A credential with this name or token already exists');
      throw error;
    }
  }

  async verify(token: string, scope: EnvironmentScope, permission: EnvironmentCredentialPermission): Promise<EnvironmentCredentialGrant> {
    const digest = tokenDigest(token);
    return this.sql.begin(async tx => {
      const rows = await tx<Record<string, any>[]>`SELECT c.*, c.revision::text FROM environment_credentials c
        JOIN organizations o ON o.id = c.org_id
        JOIN projects p ON p.id = c.project_id AND p.org_id = c.org_id
        JOIN environments e ON e.id = c.environment_id AND e.project_id = c.project_id AND e.org_id = c.org_id
        WHERE c.org_id = ${scope.orgId} AND c.project_id = ${scope.projectId} AND c.environment_id = ${scope.environmentId}
          AND c.status = 'active' AND o.state = 'active' AND p.state = 'active' AND e.state <> 'deleted'
          AND c.permissions ? ${permission}
          AND ((c.token_hash = ${digest} AND c.expires_at > now()) OR EXISTS (
            SELECT 1 FROM environment_credential_overlaps overlap
            WHERE overlap.credential_id = c.id AND overlap.token_hash = ${digest} AND overlap.valid_until > now()
          )) FOR UPDATE OF c`;
      if (!rows.length) throw new PlatformFault('unauthenticated', 'The environment credential is invalid, expired, or revoked');
      const row = rows[0]!;
      await tx`UPDATE environment_credentials SET last_used_at = now() WHERE id = ${row.id}`;
      return { credentialId: row.id, scope, audience: 'automation', permissions: row.permissions, revision: row.revision };
    });
  }
}

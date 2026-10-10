import { randomUUID } from 'node:crypto';
import { PlatformFault, parseComponent, type LegacyToken } from '@carbon/contracts/platform';
import type { LegacyClaimInput, LegacyTokenMutation, LegacyTokenRepository } from '../application/ports/LegacyTokenRepository.ts';
import type { OrganizationActor } from '../application/ports/OrganizationRepository.ts';
import { PostgresPlatformAuthority } from './PostgresPlatformAuthority.ts';

function legacyToken(row:Record<string,any>):LegacyToken { return parseComponent('LegacyToken',{ id:row.id, orgId:row.org_id, kind:row.scope, status:row.status, createdAt:row.created_at.toISOString(), lastUsedAt:row.last_used_at?.toISOString()??null, retiredAt:row.retired_at?.toISOString()??null, replacedByServiceAccountId:row.replaced_by_service_account??null, revision:row.revision }); }

/** Legacy cc_/wk_ rows from migration 0002. Token hashes are never returned and never deleted here. */
export class PostgresLegacyTokenRepository extends PostgresPlatformAuthority implements LegacyTokenRepository {
  private async currentActor(tx:Bun.TransactionSQL,input:OrganizationActor) { await this.lockAccounts(tx,[input.accountId]);const current=await this.actor(tx,input);return {actor:{...input,permissionRevision:current.permission_revision as string},current}; }
  private async manager(tx:Bun.TransactionSQL,actor:OrganizationActor,orgId:string) { const access=await this.resolveInTransaction(tx,actor,{orgId});if(!access.permissions.includes('organization.manage'))throw new PlatformFault('forbidden','Managing legacy tokens is not permitted'); }
  /**
   * Attaches an unowned legacy organization to the signed-in account. Possession of an active cc_ organization token is
   * the proof of control; no owner is ever inferred. An organization that already has any member cannot be claimed.
   */
  async claim(input:LegacyClaimInput) { try { return await this.sql.begin(async tx=>{
    const {actor,current}=await this.currentActor(tx,input.actor);const key='legacy-claim';
    const old=(await tx`SELECT request_digest,result FROM legacy_token_commands WHERE actor_account_id=${actor.accountId} AND scope_key=${key} AND key_digest=${input.keyDigest}`)[0];if(old){if(old.request_digest!==input.requestDigest)throw new PlatformFault('conflict','The idempotency key was used for another command');return parseComponent('LegacyOrganizationClaimReceipt',old.result);}
    if(!current.fresh)throw new PlatformFault('forbidden','Recent authentication is required',{authentication:'fresh_required'});
    const row=(await tx<Record<string,any>[]>`SELECT t.id AS token_id,o.id,o.human_managed,o.state FROM api_tokens t JOIN organizations o ON o.id=t.org_id WHERE t.token_hash=${input.credentialHash} AND t.scope='org' AND t.status='active' FOR UPDATE OF o`)[0];
    if(!row||row.state!=='active')throw new PlatformFault('not_found','Legacy organization not found');
    if(row.human_managed||(await tx`SELECT 1 FROM memberships WHERE org_id=${row.id} LIMIT 1`).length)throw new PlatformFault('conflict','This organization already has an owner');
    await tx`INSERT INTO memberships (id, account_id, org_id, role, state) VALUES (${randomUUID()}, ${actor.accountId}, ${row.id}, 'Owner', 'active')`;
    const revision=(await tx<{revision:string}[]>`UPDATE organizations SET slug=${input.slug},human_managed=true,revision=revision+1 WHERE id=${row.id} RETURNING revision::text`)[0]!.revision;
    await tx`UPDATE accounts SET permission_revision = permission_revision + 1, revision = revision + 1, updated_at = now() WHERE id = ${actor.accountId}`;
    const receipt=parseComponent('LegacyOrganizationClaimReceipt',{organizationId:row.id,revision,message:'Organization claimed'});
    await tx`INSERT INTO legacy_token_commands VALUES (${actor.accountId},${key},${input.keyDigest},${input.requestDigest},${JSON.stringify(receipt)}::text::jsonb,now())`;await tx`INSERT INTO legacy_token_events(id,org_id,token_id,account_id,action,request_id,metadata) VALUES (${randomUUID()},${row.id},${row.token_id},${actor.accountId},'legacy.claimed',${input.requestId},'{}')`;return receipt;
  }); } catch(error) { if(error instanceof PlatformFault)throw error;if((error as {errno?:string}).errno==='23505')throw new PlatformFault('conflict','That organization slug is unavailable');throw error; } }
  async list(input:OrganizationActor,orgId:string,limit:number,afterId?:string) { return this.sql.begin(async tx=>{await this.manager(tx,input,orgId);const rows=await tx<Record<string,any>[]>`SELECT id,org_id,scope,status,created_at,last_used_at,retired_at,replaced_by_service_account,revision::text FROM api_tokens WHERE org_id=${orgId} AND (${afterId??null}::uuid IS NULL OR id>${afterId??null}::uuid) ORDER BY id LIMIT ${limit}`;return rows.map(legacyToken);}); }
  async execute(input:LegacyTokenMutation) { return this.sql.begin(async tx=>{
    const {actor,current}=await this.currentActor(tx,input.actor);await this.manager(tx,actor,input.orgId);
    const row=(await tx<Record<string,any>[]>`SELECT id,org_id,scope,status,created_at,last_used_at,retired_at,replaced_by_service_account,revision::text FROM api_tokens WHERE id=${input.tokenId} AND org_id=${input.orgId} FOR UPDATE`)[0];if(!row)throw new PlatformFault('not_found','Legacy token not found');const key=`legacy-token:${row.id}`;
    const old=(await tx`SELECT request_digest,result FROM legacy_token_commands WHERE actor_account_id=${actor.accountId} AND scope_key=${key} AND key_digest=${input.keyDigest}`)[0];if(old){if(old.request_digest!==input.requestDigest)throw new PlatformFault('conflict','The idempotency key was used for another command');return parseComponent('LegacyTokenReceipt',old.result);}
    if(row.revision!==input.expectedRevision)throw new PlatformFault('conflict','Legacy token changed; refresh before retrying');if(!current.fresh)throw new PlatformFault('forbidden','Recent authentication is required',{authentication:'fresh_required'});
    const command=input.command;let updated:Record<string,any>;
    if(command.kind==='retire'){if(row.status!=='active')throw new PlatformFault('conflict','Legacy token is already retired');const replacement=command.replacedByServiceAccountId??null;
      if(replacement&&!(await tx`SELECT 1 FROM service_accounts WHERE id=${replacement} AND org_id=${input.orgId} AND managed AND status='active'`).length)throw new PlatformFault('validation','The replacement service account is not active in this organization');
      updated=(await tx<Record<string,any>[]>`UPDATE api_tokens SET status='retired',retired_at=now(),retired_by=${actor.accountId},replaced_by_service_account=${replacement},revision=revision+1 WHERE id=${row.id} RETURNING id,org_id,scope,status,created_at,last_used_at,retired_at,replaced_by_service_account,revision::text`)[0]!;
    }else{if(row.status!=='retired')throw new PlatformFault('conflict','Legacy token is not retired');
      updated=(await tx<Record<string,any>[]>`UPDATE api_tokens SET status='active',retired_at=NULL,retired_by=NULL,replaced_by_service_account=NULL,revision=revision+1 WHERE id=${row.id} RETURNING id,org_id,scope,status,created_at,last_used_at,retired_at,replaced_by_service_account,revision::text`)[0]!;}
    const receipt=parseComponent('LegacyTokenReceipt',{legacyToken:legacyToken(updated),message:command.kind==='retire'?'Legacy token retired':'Legacy token restored'});
    await tx`INSERT INTO legacy_token_commands VALUES (${actor.accountId},${key},${input.keyDigest},${input.requestDigest},${JSON.stringify(receipt)}::text::jsonb,now())`;await tx`INSERT INTO legacy_token_events(id,org_id,token_id,account_id,action,request_id,metadata) VALUES (${randomUUID()},${input.orgId},${row.id},${actor.accountId},${command.kind==='retire'?'legacy.retired':'legacy.restored'},${input.requestId},'{}')`;return receipt;
  }); }
}

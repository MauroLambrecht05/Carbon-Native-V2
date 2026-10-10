import { randomUUID } from 'node:crypto';
import { PlatformFault, parseComponent, type PersonalCredential, type PersonalCredentialIssue, type Scope } from '@carbon/contracts/platform';
import type { PersonalCredentialCreateInput, PersonalCredentialRepository, PersonalCredentialRevokeInput, PersonalCredentialRotateInput } from '../application/ports/PersonalCredentialRepository.ts';
import type { OrganizationActor } from '../application/ports/OrganizationRepository.ts';
import { PostgresPlatformAuthority } from './PostgresPlatformAuthority.ts';

const ACTIVE_LIMIT = 20;
function scope(row:Record<string,any>):Scope { return { orgId:row.org_id, ...(row.project_id?{projectId:row.project_id}:{}), ...(row.environment_id?{environmentId:row.environment_id}:{}) }; }
function pgArray(value:readonly string[]) { return `{${value.join(',')}}`; }
function credential(row:Record<string,any>):PersonalCredential { return parseComponent('PersonalCredential',{ id:row.id, name:row.name, scope:scope(row), permissions:row.permissions, prefix:row.token_prefix, status:row.status==='active'&&row.expires_at<=new Date()?'expired':row.status, expiresAt:row.expires_at.toISOString(), lastUsedAt:row.last_used_at?.toISOString()??null, revision:row.revision, createdAt:row.created_at.toISOString() }); }

export class PostgresPersonalCredentialRepository extends PostgresPlatformAuthority implements PersonalCredentialRepository {
  private async currentActor(tx:Bun.TransactionSQL,input:OrganizationActor) { await this.lockAccounts(tx,[input.accountId]);const current=await this.actor(tx,input);return {actor:{...input,permissionRevision:current.permission_revision as string},current}; }
  /** The owner must hold metadata.read and every delegated permission on the exact scope right now. */
  private async delegable(tx:Bun.TransactionSQL,actor:OrganizationActor,target:Scope,permissions:readonly string[]) { const access=await this.resolveInTransaction(tx,actor,target);if(!access.permissions.includes('metadata.read')||permissions.some(permission=>!access.permissions.includes(permission as any)))throw new PlatformFault('forbidden','Requested permissions exceed your access'); }
  private async replay(tx:Bun.TransactionSQL,accountId:string,key:string,input:{keyDigest:string;requestDigest:string}) { const old=(await tx`SELECT request_digest,result FROM personal_credential_commands WHERE actor_account_id=${accountId} AND scope_key=${key} AND key_digest=${input.keyDigest}`)[0];if(old&&old.request_digest!==input.requestDigest)throw new PlatformFault('conflict','The idempotency key was used for another command');return old; }
  async list(input:OrganizationActor,limit:number,afterId?:string) { return this.sql.begin(async tx=>{const {actor}=await this.currentActor(tx,input);const rows=await tx<Record<string,any>[]>`SELECT *,revision::text FROM personal_credentials WHERE account_id=${actor.accountId} AND (${afterId??null}::uuid IS NULL OR id>${afterId??null}::uuid) ORDER BY id LIMIT ${limit}`;return rows.map(credential);}); }
  async create(input:PersonalCredentialCreateInput):Promise<PersonalCredentialIssue> { try { return await this.sql.begin(async tx=>{
    const {actor,current}=await this.currentActor(tx,input.actor);const key='personal-credential:create';
    // The token is disclosed once. A retry cannot show it again, so it is refused rather than answered with a second secret.
    if(await this.replay(tx,actor.accountId,key,input))throw new PlatformFault('conflict','This personal credential was already issued; its token cannot be shown again');
    if(!current.fresh)throw new PlatformFault('forbidden','Recent authentication is required',{authentication:'fresh_required'});
    await this.delegable(tx,actor,input.scope,input.permissions);
    const active=(await tx<{count:number}[]>`SELECT count(*)::integer AS count FROM personal_credentials WHERE account_id=${actor.accountId} AND status='active' AND expires_at>now()`)[0]!.count;if(active>=ACTIVE_LIMIT)throw new PlatformFault('quota','Too many active personal credentials');
    const row=(await tx<Record<string,any>[]>`INSERT INTO personal_credentials(id,account_id,org_id,project_id,environment_id,name,permissions,token_hash,token_prefix,permission_revision,expires_at) VALUES (${input.id},${actor.accountId},${input.scope.orgId},${input.scope.projectId??null},${input.scope.environmentId??null},${input.name},${pgArray(input.permissions)}::text[],${input.tokenHash},${input.tokenPrefix},${actor.permissionRevision},${input.expiresAt}) RETURNING *,revision::text`)[0]!;
    const issued=credential(row);await tx`INSERT INTO personal_credential_commands VALUES (${actor.accountId},${key},${input.keyDigest},${input.requestDigest},${JSON.stringify({credentialId:row.id})}::text::jsonb,now())`;await tx`INSERT INTO personal_credential_events(id,credential_id,account_id,action,request_id,metadata) VALUES (${randomUUID()},${row.id},${actor.accountId},'personal.created',${input.requestId},${JSON.stringify({scope:input.scope,permissions:input.permissions})}::text::jsonb)`;
    return parseComponent('PersonalCredentialIssue',{credential:issued,token:input.token});
  }); } catch(error) { if(error instanceof PlatformFault)throw error;const code=(error as {errno?:string}).errno;if(code==='23503')throw new PlatformFault('validation','The requested credential scope is invalid');if(code==='23505')throw new PlatformFault('conflict','An active personal credential already uses this name');throw error; } }
  async rotate(input:PersonalCredentialRotateInput):Promise<PersonalCredentialIssue> { return this.sql.begin(async tx=>{
    const {actor,current}=await this.currentActor(tx,input.actor);const row=(await tx<Record<string,any>[]>`SELECT *,revision::text FROM personal_credentials WHERE id=${input.credentialId} AND account_id=${actor.accountId} FOR UPDATE`)[0];if(!row)throw new PlatformFault('not_found','Personal credential not found');const key=`personal-credential:${row.id}`;
    if(await this.replay(tx,actor.accountId,key,input))throw new PlatformFault('conflict','This personal credential was already rotated; its token cannot be shown again');
    if(row.revision!==input.expectedRevision)throw new PlatformFault('conflict','Personal credential changed; refresh before retrying');if(row.status==='revoked')throw new PlatformFault('conflict','Personal credential is revoked');
    if(!current.fresh)throw new PlatformFault('forbidden','Recent authentication is required',{authentication:'fresh_required'});
    // Rotation re-delegates: access the owner no longer holds cannot be carried forward.
    await this.delegable(tx,actor,scope(row),row.permissions);
    const updated=(await tx<Record<string,any>[]>`UPDATE personal_credentials SET token_hash=${input.tokenHash},token_prefix=${input.tokenPrefix},expires_at=${input.expiresAt},permission_revision=${actor.permissionRevision},revision=revision+1,updated_at=now() WHERE id=${row.id} RETURNING *,revision::text`)[0]!;
    await tx`INSERT INTO personal_credential_commands VALUES (${actor.accountId},${key},${input.keyDigest},${input.requestDigest},${JSON.stringify({credentialId:row.id})}::text::jsonb,now())`;await tx`INSERT INTO personal_credential_events(id,credential_id,account_id,action,request_id,metadata) VALUES (${randomUUID()},${row.id},${actor.accountId},'personal.rotated',${input.requestId},'{}')`;
    return parseComponent('PersonalCredentialIssue',{credential:credential(updated),token:input.token});
  }); }
  async revoke(input:PersonalCredentialRevokeInput) { return this.sql.begin(async tx=>{
    const {actor}=await this.currentActor(tx,input.actor);const row=(await tx<Record<string,any>[]>`SELECT *,revision::text FROM personal_credentials WHERE id=${input.credentialId} AND account_id=${actor.accountId} FOR UPDATE`)[0];if(!row)throw new PlatformFault('not_found','Personal credential not found');const key=`personal-credential:${row.id}`;
    const old=await this.replay(tx,actor.accountId,key,input);if(old?.result.receipt)return parseComponent('PersonalCredentialReceipt',old.result.receipt);
    if(row.revision!==input.expectedRevision)throw new PlatformFault('conflict','Personal credential changed; refresh before retrying');if(row.status==='revoked')throw new PlatformFault('conflict','Personal credential is already revoked');
    const updated=(await tx<Record<string,any>[]>`UPDATE personal_credentials SET status='revoked',token_hash=NULL,revision=revision+1,updated_at=now() WHERE id=${row.id} RETURNING *,revision::text`)[0]!;const receipt=parseComponent('PersonalCredentialReceipt',{credential:credential(updated),message:'Personal credential revoked'});
    await tx`INSERT INTO personal_credential_commands VALUES (${actor.accountId},${key},${input.keyDigest},${input.requestDigest},${JSON.stringify({receipt})}::text::jsonb,now())`;await tx`INSERT INTO personal_credential_events(id,credential_id,account_id,action,request_id,metadata) VALUES (${randomUUID()},${row.id},${actor.accountId},'personal.revoked',${input.requestId},'{}')`;return receipt;
  }); }
}

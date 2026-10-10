import { randomBytes, randomUUID } from 'node:crypto';
import { PlatformFault, parseComponent, type DeviceAssertionExchange, type DeviceAssertionResponse, type DeviceRegistryAssertionExchange, type CommandOptions, type EnvironmentCredentialPermission, type PageRequest, type PersonalCredentialCommand, type PersonalCredentialCreate, type PersonalCredentialIssue, type PersonalCredentialPage, type PersonalCredentialReceipt, type Scope } from '@carbon/contracts/platform';
import type { MessageProtector } from '../ports/AccountNotification.ts';
import type { OrganizationActor } from '../ports/OrganizationRepository.ts';
import type { PersonalCredentialRepository } from '../ports/PersonalCredentialRepository.ts';
import { AccountAuthentication, tokenDigest, tokenMatches } from './AccountAuthentication.ts';

const MAX_LIFETIME_MS=90*86400_000;
export interface PersonalCredentialPrincipal { readonly accountId:string; readonly credentialId:string; readonly scope:Scope; readonly permissions:readonly EnvironmentCredentialPermission[]; readonly permissionRevision:string; }

export class AccountPersonalCredentials {
  constructor(private readonly auth:AccountAuthentication,private readonly repository:PersonalCredentialRepository,private readonly cursors:MessageProtector,private readonly now:()=>Date=()=>new Date()){}
  private async actor(token:string,csrf?:string):Promise<OrganizationActor>{const session=await this.auth.session(token);if(!session)throw new PlatformFault('unauthenticated','Sign in to manage personal credentials');if(csrf!==undefined&&!tokenMatches(csrf,session.csrfHash))throw new PlatformFault('forbidden','Invalid CSRF token');return {accountId:session.account.id,sessionId:session.id,securityRevision:session.account.securityRevision,permissionRevision:session.account.permissionRevision,tokenHash:tokenDigest(token),csrfHash:session.csrfHash};}
  private secret(){const token=`pt_${randomBytes(32).toString('base64url')}`;return {token,tokenHash:tokenDigest(token),tokenPrefix:token.slice(0,11)};}
  private expiry(value:string){const expiresAt=new Date(value);const remaining=expiresAt.getTime()-this.now().getTime();if(!(remaining>0)||remaining>MAX_LIFETIME_MS)throw new PlatformFault('validation','Personal credentials must expire within 90 days');return expiresAt;}
  async list(token:string,query:PageRequest):Promise<PersonalCredentialPage>{parseComponent('PageRequest',query);if(query.filter||(query.sort&&query.sort!=='id'))throw new PlatformFault('validation','Only ID ordering is supported');const actor=await this.actor(token);const limit=query.limit??25;const context=`personal-credentials:${actor.sessionId}:${actor.permissionRevision}:${limit}`;let afterId:string|undefined;if(query.cursor)try{afterId=parseComponent('Id',JSON.parse(await this.cursors.open(query.cursor,context)).afterId);}catch{throw new PlatformFault('validation','The page cursor is invalid or expired');}const rows=await this.repository.list(actor,limit+1,afterId);const items=rows.slice(0,limit);return parseComponent('PersonalCredentialPage',{items,nextCursor:rows[limit]&&items.length?await this.cursors.seal(JSON.stringify({afterId:items.at(-1)!.id}),context):null});}
  async create(token:string,csrf:string,value:PersonalCredentialCreate,options:CommandOptions,requestId:string):Promise<PersonalCredentialIssue>{const input=parseComponent('PersonalCredentialCreate',{...value,name:value.name.trim(),permissions:[...value.permissions].sort()});parseComponent('CommandOptions',options);parseComponent('Id',requestId);if(input.scope.realmId)throw new PlatformFault('validation','Personal credentials cannot target an application realm');const expiresAt=this.expiry(input.expiresAt);return this.repository.create({actor:await this.actor(token,csrf),id:randomUUID(),name:input.name,scope:input.scope,permissions:input.permissions,expiresAt,...this.secret(),keyDigest:tokenDigest(options.idempotencyKey),requestDigest:tokenDigest(JSON.stringify(input)),requestId});}
  async command(token:string,csrf:string,credentialId:string,value:PersonalCredentialCommand,options:CommandOptions,requestId:string):Promise<PersonalCredentialIssue|PersonalCredentialReceipt>{parseComponent('Id',credentialId);const command=parseComponent('PersonalCredentialCommand',value);parseComponent('CommandOptions',options);parseComponent('Id',requestId);if(!options.expectedRevision)throw new PlatformFault('validation','A current revision is required');const actor=await this.actor(token,csrf);const base={actor,credentialId,expectedRevision:options.expectedRevision,keyDigest:tokenDigest(options.idempotencyKey),requestDigest:tokenDigest(JSON.stringify({credentialId,command,expectedRevision:options.expectedRevision})),requestId};if(command.kind==='rotate')return this.repository.rotate({...base,expiresAt:this.expiry(command.expiresAt),...this.secret()});return this.repository.revoke(base);}
}

/**
 * Exchanges a pt_ credential for a 60-second assertion bound to one Database or Registry request. The request shapes
 * are the device ones: a personal credential stands for the same account, acting through a tool instead of a browser.
 */
export class PersonalCredentialExchange {
  constructor(private readonly verifier: { verify(token:string,scope:Scope,permission:EnvironmentCredentialPermission):Promise<PersonalCredentialPrincipal> }, private readonly issuer?: import('../../infrastructure/ServiceAssertions.ts').ServiceAssertionIssuer) {}
  async exchange(authorization:string,value:DeviceAssertionExchange,requestId:string):Promise<DeviceAssertionResponse>{return this.issue(authorization,parseComponent('DeviceAssertionExchange',value),requestId);}
  async exchangeRegistry(authorization:string,value:DeviceRegistryAssertionExchange,requestId:string):Promise<DeviceAssertionResponse>{return this.issue(authorization,parseComponent('DeviceRegistryAssertionExchange',value),requestId);}
  private async issue(authorization:string,input:DeviceAssertionExchange|DeviceRegistryAssertionExchange,requestId:string):Promise<DeviceAssertionResponse>{if(!this.issuer)throw new PlatformFault('capability','Personal credential assertion exchange is not configured');parseComponent('Id',requestId);const match=/^Bearer (pt_[A-Za-z0-9_-]{43})$/.exec(authorization);if(!match)throw new PlatformFault('unauthenticated','A personal credential is required');const grant=await this.verifier.verify(match[1]!,input.scope,input.permission);const principal=parseComponent('Principal',{id:grant.accountId,kind:'account',audience:'cli',credentialId:grant.credentialId,permissionRevision:grant.permissionRevision});const token=await this.issuer.issue({aud:input.audience,principal,scope:input.scope,roles:[],grants:[{permission:input.permission,scope:input.scope}],requestId,request:input.request});return parseComponent('DeviceAssertionResponse',{tokenType:'Bearer',token,expiresInSeconds:60});}
}

/** Verifies a pt_ token for one exact scope and permission against current account, membership and resource state. */
export class PersonalCredentialAuthentication {
  constructor(private readonly sql:Bun.SQL){}
  async verify(token:string,requestedScope:Scope,permission:EnvironmentCredentialPermission):Promise<PersonalCredentialPrincipal>{
    parseComponent('Scope',requestedScope);parseComponent('EnvironmentCredentialPermission',permission);if(!/^pt_[A-Za-z0-9_-]{43}$/.test(token))throw new PlatformFault('unauthenticated','Personal credential is invalid');
    return this.sql.begin(async tx=>{const row=(await tx<Record<string,any>[]>`SELECT c.*,c.permission_revision::text AS credential_permission_revision,a.state AS account_state,a.permission_revision::text AS account_permission_revision,o.state AS organization_state,p.state AS project_state,e.state AS environment_state,m.state AS membership_state
      FROM personal_credentials c JOIN accounts a ON a.id=c.account_id JOIN organizations o ON o.id=c.org_id JOIN memberships m ON m.account_id=c.account_id AND m.org_id=c.org_id
      LEFT JOIN projects p ON p.id=c.project_id AND p.org_id=c.org_id LEFT JOIN environments e ON e.id=c.environment_id AND e.project_id=c.project_id AND e.org_id=c.org_id
      WHERE c.token_hash=${tokenDigest(token)} FOR UPDATE OF c`)[0];
      const exact=row&&!requestedScope.realmId&&row.org_id===requestedScope.orgId&&(row.project_id??undefined)===requestedScope.projectId&&(row.environment_id??undefined)===requestedScope.environmentId;
      if(!row||!exact||row.status!=='active'||row.expires_at<=new Date()||row.account_state!=='active'||row.organization_state!=='active'||row.membership_state!=='active'||(row.project_id&&row.project_state!=='active')||(row.environment_id&&row.environment_state!=='active')||row.credential_permission_revision!==row.account_permission_revision||!row.permissions.includes(permission))throw new PlatformFault('unauthenticated','Personal credential is invalid or revoked');
      await tx`UPDATE personal_credentials SET last_used_at=now() WHERE id=${row.id}`;return {accountId:row.account_id,credentialId:row.id,scope:requestedScope,permissions:row.permissions,permissionRevision:row.credential_permission_revision};
    });
  }
}

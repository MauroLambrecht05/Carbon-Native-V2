import type { EnvironmentCredentialPermission, Scope, ServiceAccount, ServiceAccountCommand, ServiceAccountCredential, ServiceAccountCredentialCommand, ServiceAccountCredentialReceipt, ServiceAccountReceipt } from '@carbon/contracts/platform';
import type { OrganizationActor } from './OrganizationRepository.ts';

export interface ServiceAccountMutation {
  readonly actor: OrganizationActor;
  readonly orgId: string;
  readonly serviceAccountId?: string;
  readonly command: ({ readonly kind:'create'; readonly name:string; readonly scope:Scope; readonly permissions:readonly EnvironmentCredentialPermission[] }) | ServiceAccountCommand;
  readonly expectedRevision:string; readonly keyDigest:string; readonly requestDigest:string; readonly requestId:string;
}
export interface ServiceAccountCredentialMutation {
  readonly actor:OrganizationActor; readonly orgId:string; readonly serviceAccountId:string; readonly credentialId?:string;
  readonly command:({readonly kind:'create';readonly name:string;readonly expiresAt:string})|ServiceAccountCredentialCommand;
  readonly token?:{readonly prefix:string;readonly hash:string}; readonly expectedRevision:string; readonly keyDigest:string; readonly requestDigest:string; readonly requestId:string;
}
export interface ServiceAccountGrant { readonly principalId:string; readonly credentialId:string; readonly scope:Scope; readonly permissions:readonly EnvironmentCredentialPermission[]; readonly permissionRevision:string; }
export interface ServiceAccountRepository {
  list(actor:OrganizationActor,orgId:string,limit:number,afterId?:string):Promise<readonly ServiceAccount[]>;
  execute(input:ServiceAccountMutation):Promise<ServiceAccountReceipt>;
  listCredentials(actor:OrganizationActor,orgId:string,serviceAccountId:string,limit:number,afterId?:string):Promise<readonly ServiceAccountCredential[]>;
  executeCredential(input:ServiceAccountCredentialMutation):Promise<ServiceAccountCredentialReceipt>;
  verify(token:string,scope:Scope,permission:EnvironmentCredentialPermission):Promise<ServiceAccountGrant>;
}

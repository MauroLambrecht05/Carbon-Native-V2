import type { EnvironmentCredentialPermission, PersonalCredential, PersonalCredentialIssue, PersonalCredentialReceipt, Scope } from '@carbon/contracts/platform';
import type { OrganizationActor } from './OrganizationRepository.ts';

export interface PersonalCredentialSecret { readonly token:string; readonly tokenHash:string; readonly tokenPrefix:string; }
export interface PersonalCredentialCreateInput extends PersonalCredentialSecret { readonly actor:OrganizationActor; readonly id:string; readonly name:string; readonly scope:Scope; readonly permissions:readonly EnvironmentCredentialPermission[]; readonly expiresAt:Date; readonly keyDigest:string; readonly requestDigest:string; readonly requestId:string; }
export interface PersonalCredentialRotateInput extends PersonalCredentialSecret { readonly actor:OrganizationActor; readonly credentialId:string; readonly expiresAt:Date; readonly expectedRevision:string; readonly keyDigest:string; readonly requestDigest:string; readonly requestId:string; }
export interface PersonalCredentialRevokeInput { readonly actor:OrganizationActor; readonly credentialId:string; readonly expectedRevision:string; readonly keyDigest:string; readonly requestDigest:string; readonly requestId:string; }
export interface PersonalCredentialRepository {
  list(actor:OrganizationActor,limit:number,afterId?:string):Promise<readonly PersonalCredential[]>;
  create(input:PersonalCredentialCreateInput):Promise<PersonalCredentialIssue>;
  rotate(input:PersonalCredentialRotateInput):Promise<PersonalCredentialIssue>;
  revoke(input:PersonalCredentialRevokeInput):Promise<PersonalCredentialReceipt>;
}

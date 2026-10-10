import type { LegacyOrganizationClaimReceipt, LegacyToken, LegacyTokenCommand, LegacyTokenReceipt } from '@carbon/contracts/platform';
import type { OrganizationActor } from './OrganizationRepository.ts';

export interface LegacyClaimInput { readonly actor:OrganizationActor; readonly credentialHash:string; readonly slug:string; readonly keyDigest:string; readonly requestDigest:string; readonly requestId:string; }
export interface LegacyTokenMutation { readonly actor:OrganizationActor; readonly orgId:string; readonly tokenId:string; readonly command:LegacyTokenCommand; readonly expectedRevision:string; readonly keyDigest:string; readonly requestDigest:string; readonly requestId:string; }
export interface LegacyTokenRepository {
  claim(input:LegacyClaimInput):Promise<LegacyOrganizationClaimReceipt>;
  list(actor:OrganizationActor,orgId:string,limit:number,afterId?:string):Promise<readonly LegacyToken[]>;
  execute(input:LegacyTokenMutation):Promise<LegacyTokenReceipt>;
}

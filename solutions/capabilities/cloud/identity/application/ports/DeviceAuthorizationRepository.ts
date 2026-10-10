import type { DeviceAuthorizationReceipt, DeviceAuthorizationReview, DeviceGrant, DeviceGrantReceipt, DeviceTokenResponse, Permission, Scope } from '@carbon/contracts/platform';
import type { OrganizationActor } from './OrganizationRepository.ts';

export interface DeviceRequestInput { readonly id:string; readonly deviceCodeHash:string; readonly userCodeHash:string; readonly clientName:string; readonly deviceName:string; readonly scope:Scope; readonly permissions:readonly Permission[]; readonly peerDigest:string; readonly expiresAt:Date; readonly requestId:string; }
export interface DeviceDecisionInput { readonly actor:OrganizationActor; readonly userCodeHash:string; readonly approve:boolean; readonly credentialId:string; readonly credentialExpiresAt:Date; readonly expectedRevision:string; readonly keyDigest:string; readonly requestDigest:string; readonly requestId:string; }
export interface DevicePollInput { readonly deviceCodeHash:string; readonly credentialId:string; readonly tokenHash:string; readonly tokenPrefix:string; readonly token:string; readonly requestId:string; }
export interface DeviceRevokeInput { readonly actor:OrganizationActor; readonly grantId:string; readonly expectedRevision:string; readonly keyDigest:string; readonly requestDigest:string; readonly requestId:string; }
export interface DeviceAuthorizationRepository {
  create(input:DeviceRequestInput):Promise<void>;
  review(actor:OrganizationActor,userCode:string,userCodeHash:string):Promise<DeviceAuthorizationReview>;
  decide(input:DeviceDecisionInput):Promise<DeviceAuthorizationReceipt>;
  poll(input:DevicePollInput):Promise<DeviceTokenResponse>;
  list(actor:OrganizationActor,limit:number,afterId?:string):Promise<readonly DeviceGrant[]>;
  revoke(input:DeviceRevokeInput):Promise<DeviceGrantReceipt>;
}

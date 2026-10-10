import { PlatformFault, parseComponent, type Permission, type Scope } from '@carbon/contracts/platform';
import { tokenDigest } from './AccountAuthentication.ts';

export interface DeviceCredentialPrincipal { readonly accountId:string; readonly credentialId:string; readonly scope:Scope; readonly permissions:readonly Permission[]; readonly permissionRevision:string; }
export class DeviceCredentialAuthentication {
  constructor(private readonly sql:Bun.SQL){}
  async verify(token:string,requestedScope:Scope,permission:Permission):Promise<DeviceCredentialPrincipal>{
    parseComponent('Scope',requestedScope);parseComponent('Permission',permission);if(!/^dc_[A-Za-z0-9_-]{43}$/.test(token))throw new PlatformFault('unauthenticated','Device credential is invalid');
    return this.sql.begin(async tx=>{const row=(await tx<Record<string,any>[]>`SELECT g.*,g.permission_revision::text AS grant_permission_revision,a.state AS account_state,a.permission_revision::text AS account_permission_revision,o.state AS organization_state,p.state AS project_state,e.state AS environment_state,m.state AS membership_state
      FROM device_grants g JOIN accounts a ON a.id=g.account_id JOIN organizations o ON o.id=g.org_id JOIN memberships m ON m.account_id=g.account_id AND m.org_id=g.org_id
      LEFT JOIN projects p ON p.id=g.project_id AND p.org_id=g.org_id LEFT JOIN environments e ON e.id=g.environment_id AND e.project_id=g.project_id AND e.org_id=g.org_id
      WHERE g.token_hash=${tokenDigest(token)} FOR UPDATE OF g`)[0];
      const exact=row&&row.org_id===requestedScope.orgId&&(row.project_id??undefined)===requestedScope.projectId&&(row.environment_id??undefined)===requestedScope.environmentId;
      if(!row||!exact||row.status!=='active'||row.expires_at<=new Date()||row.account_state!=='active'||row.organization_state!=='active'||row.membership_state!=='active'||(row.project_id&&row.project_state!=='active')||(row.environment_id&&row.environment_state!=='active')||row.grant_permission_revision!==row.account_permission_revision||!row.permissions.includes(permission))throw new PlatformFault('unauthenticated','Device credential is invalid or revoked');
      await tx`UPDATE device_grants SET last_used_at=now() WHERE id=${row.id}`;return {accountId:row.account_id,credentialId:row.id,scope:requestedScope,permissions:row.permissions,permissionRevision:row.grant_permission_revision};
    });
  }
}

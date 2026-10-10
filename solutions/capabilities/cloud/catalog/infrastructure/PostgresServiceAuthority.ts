import { PostgresPlatformAuthority, bodyDigest, sameScope } from '@carbon/identity';
import { serviceLifecycleBody, serviceLifecycleStatusPath, dataRequestPath, dataPermission, dataImportPath, registryRequestPath, registryPermission, type DataRequest, type InternalAssertion, type Permission, type RegistryRequest } from '@carbon/contracts/platform';
import type { ServiceAuthority } from '../application/ports/ServiceAuthority.ts';

/** Live authority for the implemented lifecycle, signed Database data and signed Registry protocols. */
export class PostgresServiceAuthority extends PostgresPlatformAuthority implements ServiceAuthority {
  async isCurrent(assertion: InternalAssertion): Promise<boolean> {
    if (/^\/internal\/platform\/v1\/environments\/[^/]+\/registry\//.test(assertion.request.path)) return this.registryAuthority(assertion);
    if (assertion.request.path.includes('/imports/')) return this.importAuthority(assertion);
    if (assertion.request.path.includes('/data/')) return this.dataAuthority(assertion);
    const scope = assertion.scope; const principal = assertion.principal;
    const reading = assertion.request.method === 'GET';
    let readBinding: string | undefined;
    if (reading && scope.environmentId && scope.projectId && !scope.realmId) {
      try {
        readBinding = new URL(assertion.request.path, 'https://internal.invalid').searchParams.get('bindingId') ?? undefined;
        if (!readBinding || assertion.request.path !== serviceLifecycleStatusPath({ orgId: scope.orgId, projectId: scope.projectId, environmentId: scope.environmentId }, readBinding)) return false;
      } catch { return false; }
    }
    if (principal.kind !== 'account' || principal.audience !== 'dashboard' || !scope.environmentId || scope.realmId
      || (!reading && (assertion.request.method !== 'POST' || assertion.request.path !== `/internal/platform/v1/environments/${scope.environmentId}/lifecycle`))
      || !['carbon-database', 'carbon-registry'].includes(assertion.aud)
      || assertion.grants.length !== 1 || assertion.grants[0]!.permission !== (reading ? 'metadata.read' : 'resources.configure') || !sameScope(assertion.grants[0]!.scope, scope)) return false;
    return this.sql.begin(async tx => {
      await tx`SELECT id FROM organizations WHERE id = ${scope.orgId} FOR SHARE`;
      await this.lockAccounts(tx, [principal.id], true);
      const session = (await tx`SELECT token_hash, csrf_hash, security_revision::text FROM account_sessions WHERE id = ${principal.credentialId} AND account_id = ${principal.id}`)[0];
      if (!session) return false;
      if (reading) {
        if (assertion.request.bodyDigest !== bodyDigest('')) return false;
        const binding = await tx`SELECT id FROM service_bindings WHERE id = ${readBinding!} AND org_id = ${scope.orgId} AND project_id = ${scope.projectId!}
          AND environment_id = ${scope.environmentId!} AND owner = ${assertion.aud === 'carbon-database' ? 'database' : 'registry'}`;
        if (!binding.length) return false;
        try {
          const access = await this.resolveInTransaction(tx, { accountId: principal.id, sessionId: principal.credentialId, permissionRevision: principal.permissionRevision,
            tokenHash: session.token_hash, csrfHash: session.csrf_hash, securityRevision: session.security_revision }, scope);
          const org = await this.organization(tx, scope.orgId, principal.id);
          return access.permissions.includes('metadata.read') && assertion.roles.length === 1 && assertion.roles[0] === org.role;
        } catch { return false; }
      }
      const rows = await tx`SELECT o.id, o.kind, o.lease_id, o.request_id, o.actor, s.id AS step_id, s.kind AS action, b.id AS binding_id, b.remote_resource_id
        FROM operations o JOIN operation_steps s ON s.operation_id = o.id JOIN service_bindings b ON b.id = s.binding_id AND b.operation_id = o.id
        JOIN projects p ON p.id = o.project_id AND p.org_id = o.org_id JOIN environments e ON e.id = o.environment_id AND e.project_id = p.id AND e.org_id = p.org_id
        WHERE o.org_id = ${scope.orgId} AND o.project_id = ${scope.projectId!} AND o.environment_id = ${scope.environmentId}
          AND o.state = 'running' AND NOT o.cancellation_requested AND o.lease_expires_at > now() AND s.state = 'running'
          AND b.owner = ${assertion.aud === 'carbon-database' ? 'database' : 'registry'}
          AND p.authority_revision = o.project_revision AND e.authority_revision = o.environment_revision`;
      const row = rows[0]; if (!row || row.actor.id !== principal.id || row.actor.credentialId !== principal.credentialId
        || row.actor.permissionRevision !== principal.permissionRevision || row.request_id !== assertion.requestId) return false;
      const expectedBody = serviceLifecycleBody({ scope: { orgId: scope.orgId, projectId: scope.projectId!, environmentId: scope.environmentId! },
        operationId: row.id, stepId: row.step_id, leaseId: row.lease_id, bindingId: row.binding_id, action: row.action, remoteResourceId: row.remote_resource_id });
      if (bodyDigest(expectedBody) !== assertion.request.bodyDigest) return false;
      try {
        const access = await this.resolveInTransaction(tx, { accountId: principal.id, sessionId: principal.credentialId, permissionRevision: principal.permissionRevision,
          tokenHash: session.token_hash, csrfHash: session.csrf_hash, securityRevision: session.security_revision }, scope, undefined,
          row.kind === 'environment.ensure' ? undefined : 'environment-resume');
        const org = await this.organization(tx, scope.orgId, principal.id);
        return access.permissions.includes('resources.configure') && assertion.roles.length === 1 && assertion.roles[0] === org.role;
      } catch { return false; }
    });
  }

  private async dataAuthority(assertion: InternalAssertion): Promise<boolean> {
    const scope = assertion.scope; const principal = assertion.principal;
    if (principal.kind === 'app_user') return this.appUserAuthority(assertion);
    if (assertion.aud !== 'carbon-database' || !((principal.kind === 'account' && ['dashboard','cli'].includes(principal.audience)) || (principal.kind === 'service_account' && principal.audience === 'automation')) || !scope.projectId || !scope.environmentId || scope.realmId || assertion.request.method !== 'POST') return false;
    let bindingId: string; let permission: ReturnType<typeof dataPermission>;
    try {
      const url = new URL(assertion.request.path, 'https://internal.invalid');
      const kind = url.pathname.split('/').at(-1) as DataRequest['command']['kind'];
      bindingId = url.searchParams.get('bindingId')!;
      if (assertion.request.path !== dataRequestPath({ orgId: scope.orgId, projectId: scope.projectId, environmentId: scope.environmentId }, bindingId, kind)) return false;
      permission = dataPermission(kind);
      if (assertion.grants.length !== 1 || assertion.grants[0]!.permission !== permission || !sameScope(assertion.grants[0]!.scope, scope)) return false;
    } catch { return false; }
    return this.sql.begin(async tx => {
      await tx`SELECT id FROM organizations WHERE id = ${scope.orgId} FOR SHARE`;
      const binding = await tx`SELECT id FROM service_bindings WHERE id = ${bindingId} AND org_id = ${scope.orgId} AND project_id = ${scope.projectId}
        AND environment_id = ${scope.environmentId} AND owner = 'database' AND remote_resource_id IS NOT NULL AND state IN ('ready', 'paused')`;
      if (!binding.length) return false;
      if (principal.kind === 'service_account' || principal.audience === 'cli') return assertion.roles.length === 0 && this.credentialAuthority(tx, assertion, permission);
      await this.lockAccounts(tx, [principal.id], true);
      const session = (await tx`SELECT token_hash, csrf_hash, security_revision::text FROM account_sessions WHERE id = ${principal.credentialId} AND account_id = ${principal.id}`)[0];
      if (!session) return false;
      if (permission !== 'data.read' && permission !== 'metadata.read') {
        const fresh = (await tx`SELECT fresh_until > clock_timestamp() AS current FROM account_sessions WHERE id = ${principal.credentialId} AND account_id = ${principal.id}`)[0];
        if (!fresh?.current) return false;
      }
      try {
        const access = await this.resolveInTransaction(tx, { accountId: principal.id, sessionId: principal.credentialId, permissionRevision: principal.permissionRevision,
          tokenHash: session.token_hash, csrfHash: session.csrf_hash, securityRevision: session.security_revision }, scope);
        const organization = await this.organization(tx, scope.orgId, principal.id);
        return access.permissions.includes(permission) && assertion.roles.length === 1 && assertion.roles[0] === organization.role;
      } catch { return false; }
    });
  }
  /**
   * An app user's assertion is current only while their session, their user record and the realm are all live and
   * the realm's claims revision is the one the assertion was issued under. App users can only ever read or write rows.
   */
  private async appUserAuthority(assertion: InternalAssertion): Promise<boolean> {
    const scope = assertion.scope; const principal = assertion.principal;
    if (assertion.aud !== 'carbon-database' || principal.audience !== 'app' || !scope.projectId || !scope.environmentId || !scope.realmId
      || assertion.request.method !== 'POST' || assertion.roles.length !== 0) return false;
    const environment = { orgId: scope.orgId, projectId: scope.projectId, environmentId: scope.environmentId };
    let bindingId: string;
    try {
      const url = new URL(assertion.request.path, 'https://internal.invalid');
      const kind = url.pathname.split('/').at(-1) as DataRequest['command']['kind'];
      bindingId = url.searchParams.get('bindingId')!;
      if (assertion.request.path !== dataRequestPath(environment, bindingId, kind)) return false;
      const permission = dataPermission(kind);
      if (permission !== 'data.read' && permission !== 'data.write') return false;
      if (assertion.grants.length !== 1 || assertion.grants[0]!.permission !== permission || !sameScope(assertion.grants[0]!.scope, scope)) return false;
    } catch { return false; }
    return this.sql.begin(async tx => {
      const binding = await tx`SELECT id FROM service_bindings WHERE id = ${bindingId} AND org_id = ${scope.orgId} AND project_id = ${scope.projectId}
        AND environment_id = ${scope.environmentId} AND owner = 'database' AND remote_resource_id IS NOT NULL AND state = 'ready'`;
      if (!binding.length) return false;
      const live = await tx`SELECT 1 FROM app_sessions s JOIN app_users u ON u.id = s.user_id AND u.realm_id = s.realm_id JOIN realms r ON r.id = s.realm_id
        JOIN environments e ON e.id = r.environment_id JOIN projects p ON p.id = r.project_id JOIN organizations o ON o.id = r.org_id
        WHERE s.id = ${principal.credentialId} AND s.user_id = ${principal.id} AND r.id = ${scope.realmId!} AND r.org_id = ${scope.orgId} AND r.project_id = ${scope.projectId}
          AND r.environment_id = ${scope.environmentId} AND r.state = 'active' AND u.state = 'active' AND s.revoked_at IS NULL AND s.expires_at > now()
          AND s.claims_revision = r.claims_revision AND r.claims_revision::text = ${principal.permissionRevision}
          AND e.state = 'active' AND p.state = 'active' AND o.state = 'active'`;
      return live.length === 1;
    });
  }
  /** Exact-scope device (dc_) and managed service-account (cs_) credentials, rechecked against current state. */
  private async credentialAuthority(tx: Bun.TransactionSQL, assertion: InternalAssertion, permission: Permission): Promise<boolean> {
    const scope = assertion.scope; const principal = assertion.principal;
    if (!scope.projectId || !scope.environmentId) return false;
    if(principal.kind==='service_account'){
      const service=(await tx`SELECT s.permission_revision::text,c.service_account_permission_revision::text AS credential_permission_revision
        FROM service_accounts s JOIN service_account_credentials c ON c.service_account_id=s.id
        JOIN organizations o ON o.id=s.org_id JOIN projects p ON p.id=s.project_id AND p.org_id=s.org_id
        JOIN environments e ON e.id=s.environment_id AND e.project_id=s.project_id AND e.org_id=s.org_id
        WHERE s.managed AND s.id=${principal.id} AND c.id=${principal.credentialId} AND s.org_id=${scope.orgId} AND s.project_id=${scope.projectId}
          AND s.environment_id=${scope.environmentId} AND s.status='active' AND c.status='active' AND c.expires_at>now()
          AND o.state='active' AND p.state='active' AND (e.state='active' OR (e.state='paused' AND ${permission} IN ('metadata.read','data.read'))) AND ${permission}=ANY(s.permissions)`)[0];
      return !!service&&service.permission_revision===principal.permissionRevision&&service.credential_permission_revision===service.permission_revision;
    }
    if(principal.audience==='cli'){
      const grant=(await tx`SELECT g.permission_revision::text AS grant_permission_revision,a.permission_revision::text AS account_permission_revision
        FROM device_grants g JOIN accounts a ON a.id=g.account_id JOIN organizations o ON o.id=g.org_id
        JOIN memberships m ON m.account_id=g.account_id AND m.org_id=g.org_id
        JOIN projects p ON p.id=g.project_id AND p.org_id=g.org_id
        JOIN environments e ON e.id=g.environment_id AND e.project_id=g.project_id AND e.org_id=g.org_id
        WHERE g.id=${principal.credentialId} AND g.account_id=${principal.id} AND g.org_id=${scope.orgId} AND g.project_id=${scope.projectId}
          AND g.environment_id=${scope.environmentId} AND g.status='active' AND g.expires_at>now() AND a.state='active'
          AND o.state='active' AND m.state='active' AND p.state='active' AND (e.state='active' OR (e.state='paused' AND ${permission} IN ('metadata.read','data.read'))) AND ${permission}=ANY(g.permissions)`)[0];
      if(grant)return grant.grant_permission_revision===principal.permissionRevision&&grant.account_permission_revision===grant.grant_permission_revision;
      // Not a device grant: the same account acting through a personal credential.
      const personal=(await tx`SELECT c.permission_revision::text AS credential_permission_revision,a.permission_revision::text AS account_permission_revision
        FROM personal_credentials c JOIN accounts a ON a.id=c.account_id JOIN organizations o ON o.id=c.org_id
        JOIN memberships m ON m.account_id=c.account_id AND m.org_id=c.org_id
        JOIN projects p ON p.id=c.project_id AND p.org_id=c.org_id
        JOIN environments e ON e.id=c.environment_id AND e.project_id=c.project_id AND e.org_id=c.org_id
        WHERE c.id=${principal.credentialId} AND c.account_id=${principal.id} AND c.org_id=${scope.orgId} AND c.project_id=${scope.projectId}
          AND c.environment_id=${scope.environmentId} AND c.status='active' AND c.expires_at>now() AND a.state='active'
          AND o.state='active' AND m.state='active' AND p.state='active' AND e.state='active' AND ${permission}=ANY(c.permissions)`)[0];
      return !!personal&&personal.credential_permission_revision===principal.permissionRevision&&personal.account_permission_revision===personal.credential_permission_revision;
    }
    return false;
  }
  private async registryAuthority(assertion: InternalAssertion): Promise<boolean> {
    const scope = assertion.scope; const principal = assertion.principal;
    if (assertion.aud !== 'carbon-registry' || !((principal.kind === 'account' && principal.audience === 'cli') || (principal.kind === 'service_account' && principal.audience === 'automation')) || !scope.projectId || !scope.environmentId || scope.realmId || assertion.request.method !== 'POST' || assertion.roles.length !== 0) return false;
    let bindingId: string; let permission: Permission;
    try {
      const url = new URL(assertion.request.path, 'https://internal.invalid');
      const kind = url.pathname.split('/').at(-1) as RegistryRequest['command']['kind'];
      bindingId = url.searchParams.get('bindingId')!;
      if (assertion.request.path !== registryRequestPath({ orgId: scope.orgId, projectId: scope.projectId, environmentId: scope.environmentId }, bindingId, kind)) return false;
      permission = registryPermission(kind);
      if (assertion.grants.length !== 1 || assertion.grants[0]!.permission !== permission || !sameScope(assertion.grants[0]!.scope, scope)) return false;
    } catch { return false; }
    return this.sql.begin(async tx => {
      await tx`SELECT id FROM organizations WHERE id = ${scope.orgId} FOR SHARE`;
      const binding = await tx`SELECT id FROM service_bindings WHERE id = ${bindingId} AND org_id = ${scope.orgId} AND project_id = ${scope.projectId}
        AND environment_id = ${scope.environmentId} AND owner = 'registry' AND remote_resource_id IS NOT NULL AND state IN ('ready', 'paused')`;
      if (!binding.length) return false;
      return this.credentialAuthority(tx, assertion, permission);
    });
  }
  private async importAuthority(assertion: InternalAssertion): Promise<boolean> {
    const scope = assertion.scope; const principal = assertion.principal;
    if (assertion.aud !== 'carbon-database' || principal.kind !== 'account' || principal.audience !== 'dashboard' || !scope.projectId || !scope.environmentId || scope.realmId || assertion.request.method !== 'POST') return false;
    let bindingId: string; let operationId: string; let action: 'execute' | 'status';
    try {
      const url = new URL(assertion.request.path, 'https://internal.invalid'); const parts = url.pathname.split('/');
      action = parts.at(-1) as 'execute' | 'status'; operationId = parts.at(-2)!; bindingId = url.searchParams.get('bindingId')!;
      if (assertion.request.path !== dataImportPath({ orgId: scope.orgId, projectId: scope.projectId, environmentId: scope.environmentId }, bindingId, operationId, action)) return false;
      if (assertion.grants.length !== 1 || assertion.grants[0]!.permission !== (action === 'execute' ? 'data.write' : 'metadata.read') || !sameScope(assertion.grants[0]!.scope, scope)) return false;
    } catch { return false; }
    return this.sql.begin(async tx => {
      await tx`SELECT id FROM organizations WHERE id = ${scope.orgId} FOR SHARE`; await this.lockAccounts(tx, [principal.id], true);
      const row = (await tx`SELECT j.*, j.project_revision::text, j.environment_revision::text, p.authority_revision::text AS current_project_revision, e.authority_revision::text AS current_environment_revision
        FROM data_import_jobs j JOIN projects p ON p.id = j.project_id AND p.org_id = j.org_id JOIN environments e ON e.id = j.environment_id AND e.project_id = p.id AND e.org_id = p.org_id
        JOIN service_bindings b ON b.id = j.binding_id AND b.environment_id = e.id AND b.project_id = p.id AND b.org_id = p.org_id
        WHERE j.id = ${operationId} AND j.org_id = ${scope.orgId} AND j.project_id = ${scope.projectId} AND j.environment_id = ${scope.environmentId}
          AND j.binding_id = ${bindingId} AND b.owner = 'database' AND b.state IN ('ready', 'paused') AND b.remote_resource_id IS NOT NULL
          AND j.state IN ('running', 'cancel_requested') AND j.lease_expires_at > clock_timestamp()`)[0];
      if (!row || row.actor_id !== principal.id || row.actor.credentialId !== principal.credentialId || row.request_id !== assertion.requestId || row.dispatch_digest !== assertion.request.bodyDigest) return false;
      const execute = action === 'execute';
      if (execute ? row.phase !== 'execute' || row.state !== 'running' || row.cancellation_requested || row.deadline_at <= new Date()
        || row.actor.permissionRevision !== principal.permissionRevision || row.project_revision !== row.current_project_revision || row.environment_revision !== row.current_environment_revision
        : row.phase !== 'reconcile') return false;
      try {
        const actor = { ...row.authority_actor, ...(execute ? {} : { permissionRevision: principal.permissionRevision }) };
        const access = await this.resolveInTransaction(tx, actor, scope); const org = await this.organization(tx, scope.orgId, principal.id);
        if (execute) {
          const session = (await tx`SELECT fresh_until > clock_timestamp() AS current FROM account_sessions WHERE id = ${principal.credentialId} AND account_id = ${principal.id}`)[0];
          if (!session?.current) return false;
        }
        return access.permissions.includes(execute ? 'data.write' : 'metadata.read') && assertion.roles.length === 1 && assertion.roles[0] === org.role;
      } catch { return false; }
    });
  }
}

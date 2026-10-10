import { randomUUID } from 'node:crypto';
import { PlatformFault, parseComponent, serviceLifecycleBody, type ServiceLifecycleCommand, type Principal, type EnvironmentScope } from '@carbon/contracts/platform';
import { bodyDigest } from '@carbon/identity';
import type { ServiceLifecycleRepository } from '../application/ports/ServiceLifecycleRepository.ts';
import type { NativeEnvironmentDriver } from './NativeEnvironmentDriver.ts';

export class PostgresServiceLifecycleRepository implements ServiceLifecycleRepository {
  constructor(private readonly sql: Bun.SQL, private readonly driver: NativeEnvironmentDriver) {}
  async status(scope: EnvironmentScope, bindingId: string, stillAuthorized: () => Promise<boolean>) {
    return this.sql.begin(async tx => {
      await tx`SET LOCAL lock_timeout = '5s'`; await tx`SET LOCAL statement_timeout = '10s'`;
      const row = (await tx`SELECT id, state FROM platform_environments WHERE org_id = ${scope.orgId} AND project_id = ${scope.projectId}
        AND environment_id = ${scope.environmentId} AND binding_id = ${bindingId} FOR SHARE`)[0];
      if (!row) throw new PlatformFault('not_found', 'Environment resource not found');
      if (!await stillAuthorized()) throw new PlatformFault('forbidden', 'Lifecycle authority is no longer current');
      return parseComponent('ServiceLifecycleStatus', { scope, bindingId, remoteResourceId: row.id, state: row.state });
    });
  }
  async execute(command: ServiceLifecycleCommand, principal: Principal, requestId: string, stillAuthorized: () => Promise<boolean>) {
    const scope = command.scope;
    // Lease IDs authorize attempts, not new side effects; the business intent remains stable across leases.
    const digest = bodyDigest(serviceLifecycleBody({ ...command, leaseId: '00000000-0000-4000-8000-000000000000' }));
    try { return await this.sql.begin(async tx => {
      await tx`SET LOCAL lock_timeout = '5s'`; await tx`SET LOCAL statement_timeout = '10s'`;
      await tx`SELECT pg_advisory_xact_lock(1128354372, hashtext(${scope.environmentId}))`;
      const resources = await tx`SELECT * FROM platform_environments WHERE environment_id = ${scope.environmentId} OR binding_id = ${command.bindingId}
        OR id::text = ${command.remoteResourceId} FOR UPDATE`;
      let resource = resources[0];
      if (resources.length > 1 || (resource && (resource.org_id !== scope.orgId || resource.project_id !== scope.projectId || resource.environment_id !== scope.environmentId
        || resource.binding_id !== command.bindingId || (command.remoteResourceId !== null && resource.id !== command.remoteResourceId)))) throw new PlatformFault('conflict', 'Canonical resource binding cannot be changed');
      const previous = await tx`SELECT request_digest, result FROM platform_lifecycle_commands WHERE step_id = ${command.stepId}`;
      if (previous.length) {
        if (previous[0].request_digest !== digest) throw new PlatformFault('conflict', 'Lifecycle step was used for a different request');
        if (!resource || !await stillAuthorized()) throw new PlatformFault('forbidden', 'Lifecycle authority is no longer current');
        return parseComponent('ServiceLifecycleStatus', previous[0].result);
      }
      if (!resource) {
        if (command.action !== 'ensure' || command.remoteResourceId !== null) throw new PlatformFault('not_found', 'Environment resource not found');
        const id = randomUUID();
        resource = (await tx`INSERT INTO platform_environments (id, org_id, project_id, environment_id, binding_id, state)
          VALUES (${id}, ${scope.orgId}, ${scope.projectId}, ${scope.environmentId}, ${command.bindingId}, 'active') RETURNING *`)[0];
        await this.driver.initialize(tx, scope, id);
      } else if (command.action === 'ensure' && resource.state !== 'active') throw new PlatformFault('conflict', 'Resume the existing environment explicitly');
      if (command.action !== 'ensure') {
        if (command.remoteResourceId === null) throw new PlatformFault('validation', 'Lifecycle changes require the existing remote resource ID');
        const state = command.action === 'pause' ? 'paused' : 'active';
        await this.driver.setState(tx, scope, resource.id, state);
        await tx`UPDATE platform_environments SET state = ${state}, revision = revision + 1, updated_at = now() WHERE id = ${resource.id}`;
        resource.state = state;
      }
      if (!await stillAuthorized()) throw new PlatformFault('forbidden', 'Lifecycle authority is no longer current');
      const result = parseComponent('ServiceLifecycleStatus', { scope, bindingId: command.bindingId, remoteResourceId: resource.id, state: resource.state });
      await tx`INSERT INTO platform_lifecycle_commands (step_id, operation_id, environment_id, request_digest, result)
        VALUES (${command.stepId}, ${command.operationId}, ${scope.environmentId}, ${digest}, ${JSON.stringify(result)}::text::jsonb)`;
      await tx`INSERT INTO platform_security_events (id, environment_id, actor, action, step_id, request_id)
        VALUES (${randomUUID()}, ${scope.environmentId}, ${JSON.stringify(principal)}::text::jsonb, ${`environment.${command.action}`}, ${command.stepId}, ${requestId})`;
      return result;
    }); } catch (error) {
      if ((error as { errno?: string })?.errno === '23505') throw new PlatformFault('conflict', 'This canonical resource or lifecycle step is already bound');
      throw error;
    }
  }
}

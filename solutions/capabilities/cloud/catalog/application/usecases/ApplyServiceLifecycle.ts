import { PlatformFault, parseComponent, type ServiceLifecycleCommand, type EnvironmentScope } from '@carbon/contracts/platform';
import { bodyDigest, type ServiceAssertionVerifier, type AssertionSecurityStore } from '@carbon/identity';
import type { ServiceLifecycleRepository } from '../ports/ServiceLifecycleRepository.ts';

export class ApplyServiceLifecycle {
  constructor(private readonly verifier: ServiceAssertionVerifier, private readonly security: AssertionSecurityStore, private readonly repository: ServiceLifecycleRepository) {}
  async status(token: string, scope: EnvironmentScope, bindingId: string, path: string, requestId: string) {
    parseComponent('EnvironmentScope', scope); parseComponent('Id', bindingId);
    const assertion = await this.verifier.verify(token, { scope, permission: 'metadata.read', method: 'GET', path, bodyDigest: bodyDigest(''), principalKinds: ['account'] });
    if (assertion.requestId !== requestId) throw new PlatformFault('validation', 'Request correlation must match the signed assertion');
    return this.repository.status(scope, bindingId, () => this.security.isCurrent(assertion, token));
  }
  async execute(token: string, input: ServiceLifecycleCommand, path: string, bytes: string, idempotencyKey: string, requestId: string, signal?: AbortSignal) {
    const command = parseComponent('ServiceLifecycleCommand', input);
    if (idempotencyKey !== command.stepId) throw new PlatformFault('validation', 'Idempotency key must match the lifecycle step');
    const assertion = await this.verifier.verify(token, { scope: command.scope, permission: 'resources.configure', method: 'POST', path,
      bodyDigest: bodyDigest(bytes), principalKinds: ['account'] });
    if (assertion.requestId !== requestId) throw new PlatformFault('validation', 'Request correlation must match the signed assertion');
    return this.repository.execute(command, assertion.principal, requestId, async () => !signal?.aborted && await this.security.isCurrent(assertion, token));
  }
}

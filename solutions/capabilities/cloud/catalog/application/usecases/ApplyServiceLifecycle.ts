import { PlatformFault, parseComponent, type ServiceErasureCommand, type ServiceLifecycleCommand, type EnvironmentScope } from '@carbon/contracts/platform';
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
  /**
   * Erases an environment on Cloud's instruction. Only the platform itself can ask, never an account, a service
   * account or an operator, and the assertion must be for exactly this erasure: its principal is the erasure.
   */
  async erase(token: string, input: ServiceErasureCommand, path: string, bytes: string, idempotencyKey: string, requestId: string, signal?: AbortSignal, afterCommit?: () => void) {
    const command = parseComponent('ServiceErasureCommand', input);
    if (idempotencyKey !== command.erasureId) throw new PlatformFault('validation', 'Idempotency key must match the erasure');
    const assertion = await this.verifier.verify(token, { scope: command.scope, permission: 'resources.configure', method: 'POST', path, bodyDigest: bodyDigest(bytes), principalKinds: ['platform'] });
    if (assertion.requestId !== requestId) throw new PlatformFault('validation', 'Request correlation must match the signed assertion');
    if (assertion.principal.id !== command.erasureId || assertion.principal.credentialId !== command.erasureId) throw new PlatformFault('forbidden', 'The assertion is for another erasure');
    const receipt = await this.repository.erase(command, requestId, async () => !signal?.aborted && await this.security.isCurrent(assertion, token));
    afterCommit?.();
    return receipt;
  }
}

import { PlatformFault, parseComponent, registryPermission, registryRequestPath, type RegistryRequest } from '@carbon/contracts/platform';
import { bodyDigest, type ServiceAssertionVerifier, type AssertionSecurityStore } from '@carbon/identity';
import type { RegistryNamespaces } from '../ports/RegistryNamespaces.ts';

export class ExecuteServiceRegistry {
  constructor(private readonly verifier: ServiceAssertionVerifier, private readonly security: AssertionSecurityStore, private readonly namespaces: RegistryNamespaces) {}
  async execute(token: string, input: RegistryRequest, path: string, bytes: string, requestId: string, signal?: AbortSignal) {
    const request = parseComponent('RegistryRequest', input);
    const permission = registryPermission(request.command.kind);
    if (path !== registryRequestPath(request.scope, request.bindingId, request.command.kind)) throw new PlatformFault('validation', 'Registry request does not match its canonical path');
    const assertion = await this.verifier.verify(token, { scope: request.scope, permission, method: 'POST', path, bodyDigest: bodyDigest(bytes), principalKinds: ['account', 'service_account'] });
    if (assertion.requestId !== requestId) throw new PlatformFault('validation', 'Request correlation does not match the signed assertion');
    const result = await this.namespaces.get(request.scope, request.bindingId, async () => !signal?.aborted && await this.security.isCurrent(assertion, token));
    return parseComponent('RegistryResponse', { scope: request.scope, bindingId: request.bindingId, result });
  }
}

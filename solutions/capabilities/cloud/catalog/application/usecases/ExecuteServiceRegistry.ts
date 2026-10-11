import { PlatformFault, parseComponent, registryPermission, registryRequestPath, type RegistryRequest, type RegistryResponse } from '@carbon/contracts/platform';
import { bodyDigest, type ServiceAssertionVerifier, type AssertionSecurityStore } from '@carbon/identity';
import type { RegistryNamespaces } from '../ports/RegistryNamespaces.ts';
import type { RegistryPackages } from '../ports/RegistryPackages.ts';

/** Registry's side of a canonical command: verify the signed request, then run it under authority that is checked again before anything is committed. */
export class ExecuteServiceRegistry {
  /** Without `packages` only `namespace.get` is served: publishing needs trust material this Registry may not have been given. */
  constructor(private readonly verifier: ServiceAssertionVerifier, private readonly security: AssertionSecurityStore, private readonly namespaces: RegistryNamespaces, private readonly packages?: RegistryPackages) {}

  async execute(token: string, input: RegistryRequest, path: string, bytes: string, requestId: string, signal?: AbortSignal, idempotencyKey: string | null = null): Promise<RegistryResponse> {
    const request = parseComponent('RegistryRequest', input); const command = request.command;
    const permission = registryPermission(command.kind);
    if (path !== registryRequestPath(request.scope, request.bindingId, command.kind)) throw new PlatformFault('validation', 'Registry request does not match its canonical path');
    if ('commandId' in command ? idempotencyKey !== command.commandId : idempotencyKey !== null) throw new PlatformFault('validation', 'Invalid idempotency key');
    const assertion = await this.verifier.verify(token, { scope: request.scope, permission, method: 'POST', path, bodyDigest: bodyDigest(bytes), principalKinds: ['account', 'service_account'] });
    if (assertion.requestId !== requestId) throw new PlatformFault('validation', 'Request correlation does not match the signed assertion');
    const permit = async () => !signal?.aborted && await this.security.isCurrent(assertion, token);
    let result;
    if (command.kind === 'namespace.get') result = await this.namespaces.get(request.scope, request.bindingId, permit);
    else {
      if (!this.packages) throw new PlatformFault('capability', 'Publishing is not configured on this Registry');
      result = await this.packages.execute({ scope: request.scope, bindingId: request.bindingId, principal: assertion.principal, requestId, permit }, command);
    }
    return parseComponent('RegistryResponse', { scope: request.scope, bindingId: request.bindingId, result });
  }
}

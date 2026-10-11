import { PlatformFault, blobPermission, blobRequestPath, parseComponent, type BlobCommand, type BlobRequest, type BlobResponse, type CommandOptions, type EnvironmentScope, type Principal, type Role } from '@carbon/contracts/platform';
import { bodyDigest, tokenDigest, tokenMatches, type AccountAuthentication, type AssertionSecurityStore, type OrganizationActor, type ServiceAssertionVerifier } from '@carbon/identity';
import type { AccountDataAuthority } from '../ports/AccountDataAuthority.ts';
import type { BlobAuthority, BlobStorageRepository } from '../ports/BlobStorage.ts';

/** Cloud's transport to the service that owns blob storage. */
export interface BlobTransport {
  execute(request: BlobRequest, actor: { principal: Principal; role: Role; requestId: string }, signal?: AbortSignal): Promise<BlobResponse>;
}

/** The owning service's side: verifies a signed blob request and runs it under live authority. */
export class ExecuteServiceBlobs {
  constructor(private readonly verifier: ServiceAssertionVerifier, private readonly security: AssertionSecurityStore, private readonly repository: BlobStorageRepository) {}

  async execute(token: string, input: BlobRequest, path: string, bytes: string, requestId: string, idempotencyKey: string | null, signal?: AbortSignal): Promise<BlobResponse> {
    const request = parseComponent('BlobRequest', input); const command = request.command; const permission = blobPermission(command.kind);
    if (path !== blobRequestPath(request.scope, request.bindingId, command.kind)) throw new PlatformFault('validation', 'Blob request does not match its canonical path');
    if ('commandId' in command ? idempotencyKey !== command.commandId : idempotencyKey !== null) throw new PlatformFault('validation', 'Invalid blob idempotency key');
    const assertion = await this.verifier.verify(token, { scope: request.scope, permission, method: 'POST', path, bodyDigest: bodyDigest(bytes), principalKinds: ['account', 'service_account'] });
    if (assertion.requestId !== requestId) throw new PlatformFault('validation', 'Request correlation does not match the signed assertion');
    const authority: BlobAuthority = { scope: request.scope, bindingId: request.bindingId, principal: assertion.principal, requestId,
      permit: async required => required === permission && !signal?.aborted && await this.security.isCurrent(assertion, token) };
    return parseComponent('BlobResponse', { scope: request.scope, bindingId: request.bindingId, result: await this.repository.execute(authority, command) });
  }
}

/** Developers manage buckets and objects through the browser session. Cloud authorizes, then forwards to the owning service. */
export class AccountBlobs {
  constructor(private readonly auth: AccountAuthentication, private readonly authority: AccountDataAuthority, private readonly transport: BlobTransport) {}

  async execute(token: string, csrf: string, input: EnvironmentScope, value: BlobCommand, options: CommandOptions | undefined, requestId: string, signal?: AbortSignal): Promise<BlobResponse['result']> {
    const scope = parseComponent('EnvironmentScope', input); const command = parseComponent('BlobCommand', value); parseComponent('Id', requestId);
    const session = await this.auth.session(token);
    if (!session) throw new PlatformFault('unauthenticated', 'Sign in to access storage');
    if (!tokenMatches(csrf, session.csrfHash)) throw new PlatformFault('forbidden', 'Invalid CSRF token');
    const actor: OrganizationActor = { accountId: session.account.id, sessionId: session.id, securityRevision: session.account.securityRevision,
      permissionRevision: session.account.permissionRevision, tokenHash: tokenDigest(token), csrfHash: session.csrfHash };
    const mutation = 'commandId' in command;
    if (mutation) {
      if (!options) throw new PlatformFault('validation', 'Command options are required'); parseComponent('CommandOptions', options);
      if (options.idempotencyKey.toLowerCase() !== command.commandId.toLowerCase() || ('revision' in command && options.expectedRevision !== command.revision)) throw new PlatformFault('validation', 'Command identity and revision must match the headers');
    }
    // Changing what is stored needs a recently authenticated session, as other mutations do.
    const resolved = await this.authority.authorize(actor, scope, blobPermission(command.kind), mutation);
    const response = await this.transport.execute({ scope, bindingId: resolved.bindingId, command }, { principal: resolved.principal, role: resolved.role, requestId }, signal);
    return response.result;
  }
}

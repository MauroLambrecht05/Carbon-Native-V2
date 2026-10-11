import { PlatformFault, canonicalRegistryRequest, parseComponent, registryPermission, registryRequestPath, type CommandOptions, type EnvironmentScope, type Permission, type Principal, type RegistryCommand, type RegistryRequest,
  type RegistryResponse, type RegistryResult, type Role } from '@carbon/contracts/platform';
import { bodyDigest, sameScope, tokenDigest, tokenMatches, type AccountAuthentication, type OrganizationActor, type ServiceAssertionIssuer } from '@carbon/identity';

/** Cloud's decision that an account may send one Registry command for one environment, and which binding it goes to. */
export interface AccountRegistryAuthority {
  authorize(actor: OrganizationActor, scope: EnvironmentScope, permission: Permission, mutation: boolean): Promise<{ principal: Principal; role: Role; bindingId: string }>;
}
export interface RegistryTransport { execute(request: RegistryRequest, actor: { principal: Principal; role: Role; requestId: string }, signal?: AbortSignal): Promise<RegistryResponse> }

/** Cloud's HTTP transport to Registry. Each call carries a fresh assertion bound to this exact request. */
export class HttpRegistryClient implements RegistryTransport {
  private readonly origin: string;
  constructor(origin: string, private readonly issuer: ServiceAssertionIssuer, private readonly transport: typeof fetch = fetch) {
    const url = new URL(origin);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/'
      || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('Registry transport requires a pinned HTTPS or loopback origin');
    this.origin = url.origin;
  }

  async execute(input: RegistryRequest, actor: { principal: Principal; role: Role; requestId: string }, signal?: AbortSignal): Promise<RegistryResponse> {
    const request = parseComponent('RegistryRequest', input); const command = request.command;
    const body = canonicalRegistryRequest(request); const path = registryRequestPath(request.scope, request.bindingId, command.kind);
    const proof = await this.issuer.issue({ aud: 'carbon-registry', principal: actor.principal, scope: request.scope, roles: [actor.role],
      grants: [{ permission: registryPermission(command.kind), scope: request.scope }], requestId: actor.requestId, request: { method: 'POST', path, bodyDigest: bodyDigest(body) } });
    const deadline = AbortSignal.timeout(20000); let response: Response;
    try {
      response = await this.transport(this.origin + path, { method: 'POST', body, redirect: 'error', signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
        headers: { authorization: `Bearer ${proof}`, 'content-type': 'application/json', 'x-request-id': actor.requestId, ...('commandId' in command ? { 'idempotency-key': command.commandId } : {}) } });
    } catch { throw new PlatformFault('unavailable', 'The registry service could not be reached'); }
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new PlatformFault(response.status === 400 ? 'validation' : response.status === 401 ? 'unauthenticated' : response.status === 403 ? 'forbidden' : response.status === 404 ? 'not_found'
        : response.status === 409 ? 'conflict' : response.status === 429 ? 'quota' : response.status === 501 ? 'capability' : 'unavailable', 'The registry service rejected this request');
    }
    try {
      if (response.redirected || response.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json' || response.headers.get('x-request-id') !== actor.requestId) throw new Error('Invalid response');
      const text = await response.text(); if (text.length > 2_000_000) throw new Error('Oversized response');
      const result = parseComponent('RegistryResponse', JSON.parse(text));
      if (result.bindingId !== request.bindingId || !sameScope(result.scope, request.scope)) throw new Error('Mismatched scope');
      if ('commandId' in command && (result.result as { commandId?: string }).commandId !== command.commandId) throw new Error('Mismatched receipt');
      return result;
    } catch { throw new PlatformFault('unavailable', 'The registry service returned an invalid response'); }
  }
}

/** Developers claim publisher names and submit, follow, yank and withdraw versions through the browser session. Cloud authorizes, then forwards. */
export class AccountRegistry {
  constructor(private readonly auth: AccountAuthentication, private readonly authority: AccountRegistryAuthority, private readonly transport: RegistryTransport) {}

  async execute(token: string, csrf: string, input: EnvironmentScope, value: unknown, options: CommandOptions | undefined, requestId: string, signal?: AbortSignal): Promise<RegistryResult> {
    const scope = parseComponent('EnvironmentScope', input); const command = parseComponent('RegistryCommand', value as RegistryCommand); parseComponent('Id', requestId);
    const session = await this.auth.session(token);
    if (!session) throw new PlatformFault('unauthenticated', 'Sign in to use the registry');
    if (!tokenMatches(csrf, session.csrfHash)) throw new PlatformFault('forbidden', 'Invalid CSRF token');
    const actor: OrganizationActor = { accountId: session.account.id, sessionId: session.id, securityRevision: session.account.securityRevision,
      permissionRevision: session.account.permissionRevision, tokenHash: tokenDigest(token), csrfHash: session.csrfHash };
    const mutation = 'commandId' in command;
    if (mutation) {
      if (!options) throw new PlatformFault('validation', 'Command options are required'); parseComponent('CommandOptions', options);
      if (options.idempotencyKey.toLowerCase() !== command.commandId.toLowerCase() || ('revision' in command && options.expectedRevision !== command.revision)) throw new PlatformFault('validation', 'Command identity and revision must match the headers');
    }
    const resolved = await this.authority.authorize(actor, scope, registryPermission(command.kind), mutation);
    return (await this.transport.execute({ scope, bindingId: resolved.bindingId, command }, { principal: resolved.principal, role: resolved.role, requestId }, signal)).result;
  }
}

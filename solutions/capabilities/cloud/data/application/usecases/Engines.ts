import { PlatformFault, canonicalEngineRequest, enginePermission, engineRequestPath, parseComponent, type CommandOptions, type EngineFamily, type EnvironmentScope, type GraphCommand, type GraphRequest, type GraphResponse,
  type GraphResult, type Principal, type Role, type VectorCommand, type VectorRequest, type VectorResponse, type VectorResult } from '@carbon/contracts/platform';
import { bodyDigest, sameScope, tokenDigest, tokenMatches, type AccountAuthentication, type AssertionSecurityStore, type OrganizationActor, type ServiceAssertionIssuer, type ServiceAssertionVerifier } from '@carbon/identity';
import type { AccountDataAuthority } from '../ports/AccountDataAuthority.ts';
import type { NativeDataAuthority } from '../ports/NativeTables.ts';

type Command = VectorCommand | GraphCommand;
type EngineRequest = VectorRequest | GraphRequest;
type EngineResponse = VectorResponse | GraphResponse;
const COMPONENTS = { vectors: { request: 'VectorRequest', response: 'VectorResponse', command: 'VectorCommand' }, graph: { request: 'GraphRequest', response: 'GraphResponse', command: 'GraphCommand' } } as const;

/** Whatever stores a family's data on the owning service. */
export interface EngineRepository<C extends Command, R> { execute(authority: NativeDataAuthority, command: C): Promise<R> }
/** Cloud's transport to the owning service for one family. */
export interface EngineTransport { execute(request: EngineRequest, actor: { principal: Principal; role: Role; requestId: string }, signal?: AbortSignal): Promise<EngineResponse> }

/** The owning service's side for vector and graph commands: verify the signed request, then run it under live authority. */
export class ExecuteServiceEngine<C extends Command, R extends VectorResult | GraphResult> {
  constructor(private readonly family: EngineFamily, private readonly verifier: ServiceAssertionVerifier, private readonly security: AssertionSecurityStore, private readonly repository: EngineRepository<C, R>) {}

  async execute(token: string, input: unknown, path: string, bytes: string, requestId: string, idempotencyKey: string | null, signal?: AbortSignal): Promise<EngineResponse> {
    const names = COMPONENTS[this.family]; const request = parseComponent(names.request, input as EngineRequest); const command = request.command as Command; const permission = enginePermission(this.family, command.kind);
    if (path !== engineRequestPath(this.family, request.scope, request.bindingId, command.kind)) throw new PlatformFault('validation', 'Request does not match its canonical path');
    if ('commandId' in command ? idempotencyKey !== command.commandId : idempotencyKey !== null) throw new PlatformFault('validation', 'Invalid idempotency key');
    const assertion = await this.verifier.verify(token, { scope: request.scope, permission, method: 'POST', path, bodyDigest: bodyDigest(bytes), principalKinds: ['account', 'service_account'] });
    if (assertion.requestId !== requestId) throw new PlatformFault('validation', 'Request correlation does not match the signed assertion');
    const authority: NativeDataAuthority = { scope: request.scope, bindingId: request.bindingId, principal: assertion.principal, requestId,
      permit: async required => required === permission && !signal?.aborted && await this.security.isCurrent(assertion, token) };
    return parseComponent(names.response, { scope: request.scope, bindingId: request.bindingId, result: await this.repository.execute(authority, command as C) } as EngineResponse);
  }
}

/** Cloud's HTTP transport for one family. Each call carries a fresh assertion bound to this exact request. */
export class HttpEngineClient implements EngineTransport {
  private readonly origin: string;
  constructor(private readonly family: EngineFamily, origin: string, private readonly issuer: ServiceAssertionIssuer, private readonly transport: typeof fetch = fetch) {
    const url = new URL(origin);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/'
      || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('Engine transport requires a pinned HTTPS or loopback origin');
    this.origin = url.origin;
  }

  async execute(input: EngineRequest, actor: { principal: Principal; role: Role; requestId: string }, signal?: AbortSignal): Promise<EngineResponse> {
    const names = COMPONENTS[this.family]; const request = parseComponent(names.request, input); const command = request.command as Command;
    const body = canonicalEngineRequest(this.family, request); if (Buffer.byteLength(body) > 4_194_304) throw new PlatformFault('validation', 'Request exceeds the byte limit');
    const path = engineRequestPath(this.family, request.scope, request.bindingId, command.kind);
    const proof = await this.issuer.issue({ aud: 'carbon-database', principal: actor.principal, scope: request.scope, roles: [actor.role],
      grants: [{ permission: enginePermission(this.family, command.kind), scope: request.scope }], requestId: actor.requestId, request: { method: 'POST', path, bodyDigest: bodyDigest(body) } });
    const deadline = AbortSignal.timeout(20000); let response: Response;
    try {
      response = await this.transport(this.origin + path, { method: 'POST', body, redirect: 'error', signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
        headers: { authorization: `Bearer ${proof}`, 'content-type': 'application/json', 'x-request-id': actor.requestId, ...('commandId' in command ? { 'idempotency-key': command.commandId } : {}) } });
    } catch { throw new PlatformFault('unavailable', 'The data service could not be reached'); }
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new PlatformFault(response.status === 400 ? 'validation' : response.status === 401 ? 'unauthenticated' : response.status === 403 ? 'forbidden' : response.status === 404 ? 'not_found'
        : response.status === 409 ? 'conflict' : response.status === 429 ? 'quota' : response.status === 501 ? 'capability' : 'unavailable', 'The data service rejected this request');
    }
    try {
      if (response.redirected || response.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json' || response.headers.get('x-request-id') !== actor.requestId) throw new Error('Invalid response');
      const text = await response.text(); if (text.length > 8_000_000) throw new Error('Oversized response');
      const result = parseComponent(names.response, JSON.parse(text));
      if (result.bindingId !== request.bindingId || !sameScope(result.scope, request.scope)) throw new Error('Mismatched scope');
      if ('commandId' in command && (result.result as { commandId?: string }).commandId !== command.commandId) throw new Error('Mismatched receipt');
      return result;
    } catch { throw new PlatformFault('unavailable', 'The data service returned an invalid response'); }
  }
}

/** Developers use vector collections and the graph through the browser session. Cloud authorizes, then forwards. */
export class AccountEngine {
  constructor(private readonly family: EngineFamily, private readonly auth: AccountAuthentication, private readonly authority: AccountDataAuthority, private readonly transport: EngineTransport) {}

  async execute(token: string, csrf: string, input: EnvironmentScope, value: unknown, options: CommandOptions | undefined, requestId: string, signal?: AbortSignal): Promise<VectorResult | GraphResult> {
    const scope = parseComponent('EnvironmentScope', input); const command = parseComponent(COMPONENTS[this.family].command, value as Command) as Command; parseComponent('Id', requestId);
    const session = await this.auth.session(token);
    if (!session) throw new PlatformFault('unauthenticated', 'Sign in to access data');
    if (!tokenMatches(csrf, session.csrfHash)) throw new PlatformFault('forbidden', 'Invalid CSRF token');
    const actor: OrganizationActor = { accountId: session.account.id, sessionId: session.id, securityRevision: session.account.securityRevision,
      permissionRevision: session.account.permissionRevision, tokenHash: tokenDigest(token), csrfHash: session.csrfHash };
    const mutation = 'commandId' in command;
    if (mutation) {
      if (!options) throw new PlatformFault('validation', 'Command options are required'); parseComponent('CommandOptions', options);
      if (options.idempotencyKey.toLowerCase() !== command.commandId.toLowerCase() || ('revision' in command && options.expectedRevision !== command.revision)) throw new PlatformFault('validation', 'Command identity and revision must match the headers');
    }
    const resolved = await this.authority.authorize(actor, scope, enginePermission(this.family, command.kind), mutation);
    const response = await this.transport.execute({ scope, bindingId: resolved.bindingId, command } as EngineRequest, { principal: resolved.principal, role: resolved.role, requestId }, signal);
    return response.result;
  }
}

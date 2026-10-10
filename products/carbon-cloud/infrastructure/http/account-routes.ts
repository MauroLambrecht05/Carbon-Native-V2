import { randomUUID } from "node:crypto";
import type { AccountBuilds } from '@carbon/orchestration';
import type { AccountRealms } from '@carbon/auth';
import type { AccountCatalog, AccountEnvironmentCredentials, AccountWorkers, AccountEnvironmentSecrets, AccountRepositories, CatalogCommand } from '@carbon/catalog';
import type { AccountData, AccountImports } from '@carbon/data';
import { AccountAuthentication, opaqueToken, type PersonalCredentialExchange, type AccountAudit, type AccountPersonalCredentials, type AccountLegacyTokens, type AccountDeviceAuthorization, type AccountServiceAccounts, type AccountSecurity, type AccountProfile, type OrganizationAccess, type OrganizationInvitations, type ExternalAccountAuthentication, type AccountAuthorization } from "@carbon/identity";
import { ContractError, PlatformFault, parseComponent, type ErrorCode } from "@carbon/contracts/platform";

const STATUS: Record<ErrorCode, number> = { unauthenticated: 401, forbidden: 403, not_found: 404, conflict: 409, validation: 400, capability: 501, quota: 429, rate_limited: 429, unavailable: 503, internal: 500 };
const BASE = "/platform/v1";
function cookieValue(request: Request, name: string): string {
  const matches = (request.headers.get("cookie") ?? "").split(";").map(value => value.trim()).filter(value => value.startsWith(name + "="));
  // Reject ambiguous duplicates, including attempted path-cookie shadowing.
  return matches.length === 1 ? matches[0]!.slice(name.length + 1) : "";
}

export function createAccountRoutes(auth: AccountAuthentication, origin: string, security?: AccountSecurity, profile?: AccountProfile, organizations?: OrganizationAccess, invitations?: OrganizationInvitations, github?: ExternalAccountAuthentication, access?: AccountAuthorization, catalog?: AccountCatalog, data?: AccountData, imports?: AccountImports, credentials?: AccountEnvironmentCredentials, secrets?: AccountEnvironmentSecrets, repositories?: AccountRepositories, devices?: AccountDeviceAuthorization, serviceAccounts?: AccountServiceAccounts, personal?: AccountPersonalCredentials, legacy?: AccountLegacyTokens, workers?: AccountWorkers, audit?: AccountAudit, realms?: AccountRealms, personalExchange?: PersonalCredentialExchange, builds?: AccountBuilds) {
  const secure = new URL(origin).protocol === "https:";
  const names = { session: `${secure ? "__Host-" : ""}carbon-session`, csrf: `${secure ? "__Host-" : ""}carbon-csrf`, browser: `${secure ? "__Host-" : ""}carbon-browser` };
  const cookie = (name: string, value: string, seconds: number, httpOnly = true) => `${name}=${value}; Path=/; Max-Age=${seconds}; SameSite=Lax${httpOnly ? "; HttpOnly" : ""}${secure ? "; Secure" : ""}`;

  return async (request: Request, peerAddress: string): Promise<Response> => {
    let requestId = request.headers.get("x-request-id") ?? randomUUID();
    const headers = new Headers({
      "content-type": "application/json", "cache-control": "no-store", "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    });
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
    try {
      try { parseComponent("Id", requestId); } catch { requestId = randomUUID(); }
      headers.set("x-request-id", requestId);
      const url = new URL(request.url);
      // Ingress may terminate TLS. Host is pinned, and browser Origin must still
      // match the configured HTTPS origin; forwarded headers are never trusted.
      if (url.host !== new URL(origin).host) throw new PlatformFault("forbidden", "Invalid request origin");
      const githubWebhook = url.pathname === `${BASE}/webhooks/github` && request.method === 'POST';
      if (githubWebhook) {
        if (!repositories) throw new PlatformFault('capability', 'GitHub repositories are not configured');
        if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') throw new PlatformFault('validation', 'A JSON request is required');
        const contentLength = Number(request.headers.get('content-length') ?? '0');
        if (!Number.isSafeInteger(contentLength) || contentLength > 1048576) throw new PlatformFault('validation', 'Request body exceeds the limit');
        const raw = new Uint8Array(await request.arrayBuffer());
        if (raw.byteLength > 1048576) throw new PlatformFault('validation', 'Request body exceeds the limit');
        return json(await repositories.webhook(raw, request.headers.get('x-hub-signature-256') ?? '', request.headers.get('x-github-delivery') ?? '', request.headers.get('x-github-event') ?? '', requestId), 202);
      }
      if ([`${BASE}/device/authorizations`,`${BASE}/device/token`].includes(url.pathname) && request.method==='POST') {
        if(!devices)throw new PlatformFault('capability','Device authorization is not configured');const externalOrigin=request.headers.get('origin');if(externalOrigin&&externalOrigin!==origin)throw new PlatformFault('forbidden','Cross-origin request denied');if(request.headers.get('content-type')?.split(';')[0]?.trim()!=='application/json')throw new PlatformFault('validation','A JSON request is required');const raw=new Uint8Array(await request.arrayBuffer());if(raw.byteLength>8192)throw new PlatformFault('validation','Request body exceeds the limit');let value:unknown;try{value=JSON.parse(Buffer.from(raw).toString('utf8'));}catch{throw new PlatformFault('validation','Invalid JSON request');}
        if(url.pathname.endsWith('/authorizations'))return json(await devices.create(parseComponent('DeviceAuthorizationCreate',value),peerAddress,requestId),201);
        return json(await devices.poll(parseComponent('DeviceTokenRequest',value).deviceCode,requestId));
      }
      if(url.pathname===`${BASE}/device/assertions`&&request.method==='POST'){
        if(!devices)throw new PlatformFault('capability','Device assertion exchange is not configured');const externalOrigin=request.headers.get('origin');if(externalOrigin&&externalOrigin!==origin)throw new PlatformFault('forbidden','Cross-origin request denied');if(request.headers.get('content-type')?.split(';')[0]?.trim()!=='application/json')throw new PlatformFault('validation','A JSON request is required');const raw=new Uint8Array(await request.arrayBuffer());if(raw.byteLength>8192)throw new PlatformFault('validation','Request body exceeds the limit');let value:unknown;try{value=JSON.parse(Buffer.from(raw).toString('utf8'));}catch{throw new PlatformFault('validation','Invalid JSON request');}return json(await devices.exchange(request.headers.get('authorization')??'',parseComponent('DeviceAssertionExchange',value),requestId));
      }
      if(url.pathname===`${BASE}/device/registry-assertions`&&request.method==='POST'){
        if(!devices)throw new PlatformFault('capability','Device assertion exchange is not configured');const externalOrigin=request.headers.get('origin');if(externalOrigin&&externalOrigin!==origin)throw new PlatformFault('forbidden','Cross-origin request denied');if(request.headers.get('content-type')?.split(';')[0]?.trim()!=='application/json')throw new PlatformFault('validation','A JSON request is required');const raw=new Uint8Array(await request.arrayBuffer());if(raw.byteLength>8192)throw new PlatformFault('validation','Request body exceeds the limit');let value:unknown;try{value=JSON.parse(Buffer.from(raw).toString('utf8'));}catch{throw new PlatformFault('validation','Invalid JSON request');}return json(await devices.exchangeRegistry(request.headers.get('authorization')??'',parseComponent('DeviceRegistryAssertionExchange',value),requestId));
      }
      if(url.pathname===`${BASE}/personal/assertions`&&request.method==='POST'){
        if(!personalExchange)throw new PlatformFault('capability','Personal credential assertion exchange is not configured');const externalOrigin=request.headers.get('origin');if(externalOrigin&&externalOrigin!==origin)throw new PlatformFault('forbidden','Cross-origin request denied');if(request.headers.get('content-type')?.split(';')[0]?.trim()!=='application/json')throw new PlatformFault('validation','A JSON request is required');const raw=new Uint8Array(await request.arrayBuffer());if(raw.byteLength>8192)throw new PlatformFault('validation','Request body exceeds the limit');let value:unknown;try{value=JSON.parse(Buffer.from(raw).toString('utf8'));}catch{throw new PlatformFault('validation','Invalid JSON request');}return json(await personalExchange.exchange(request.headers.get('authorization')??'',parseComponent('DeviceAssertionExchange',value),requestId));
      }
      if(url.pathname===`${BASE}/personal/registry-assertions`&&request.method==='POST'){
        if(!personalExchange)throw new PlatformFault('capability','Personal credential assertion exchange is not configured');const externalOrigin=request.headers.get('origin');if(externalOrigin&&externalOrigin!==origin)throw new PlatformFault('forbidden','Cross-origin request denied');if(request.headers.get('content-type')?.split(';')[0]?.trim()!=='application/json')throw new PlatformFault('validation','A JSON request is required');const raw=new Uint8Array(await request.arrayBuffer());if(raw.byteLength>8192)throw new PlatformFault('validation','Request body exceeds the limit');let value:unknown;try{value=JSON.parse(Buffer.from(raw).toString('utf8'));}catch{throw new PlatformFault('validation','Invalid JSON request');}return json(await personalExchange.exchangeRegistry(request.headers.get('authorization')??'',parseComponent('DeviceRegistryAssertionExchange',value),requestId));
      }
      if(url.pathname===`${BASE}/service-assertions`&&request.method==='POST'){
        if(!serviceAccounts)throw new PlatformFault('capability','Service account assertion exchange is not configured');const externalOrigin=request.headers.get('origin');if(externalOrigin&&externalOrigin!==origin)throw new PlatformFault('forbidden','Cross-origin request denied');if(request.headers.get('content-type')?.split(';')[0]?.trim()!=='application/json')throw new PlatformFault('validation','A JSON request is required');const raw=new Uint8Array(await request.arrayBuffer());if(raw.byteLength>8192)throw new PlatformFault('validation','Request body exceeds the limit');let value:unknown;try{value=JSON.parse(Buffer.from(raw).toString('utf8'));}catch{throw new PlatformFault('validation','Invalid JSON request');}return json(await serviceAccounts.exchange(request.headers.get('authorization')??'',parseComponent('ServiceAccountAssertionExchange',value),requestId));
      }
      if(url.pathname===`${BASE}/service-registry-assertions`&&request.method==='POST'){
        if(!serviceAccounts)throw new PlatformFault('capability','Service account assertion exchange is not configured');const externalOrigin=request.headers.get('origin');if(externalOrigin&&externalOrigin!==origin)throw new PlatformFault('forbidden','Cross-origin request denied');if(request.headers.get('content-type')?.split(';')[0]?.trim()!=='application/json')throw new PlatformFault('validation','A JSON request is required');const raw=new Uint8Array(await request.arrayBuffer());if(raw.byteLength>8192)throw new PlatformFault('validation','Request body exceeds the limit');let value:unknown;try{value=JSON.parse(Buffer.from(raw).toString('utf8'));}catch{throw new PlatformFault('validation','Invalid JSON request');}return json(await serviceAccounts.exchangeRegistry(request.headers.get('authorization')??'',parseComponent('ServiceAccountRegistryAssertionExchange',value),requestId));
      }
      const requestOrigin = request.headers.get("origin");
      const githubCallback = url.pathname === `${BASE}/auth/github/callback` && request.method === "GET";
      // The provider's top-level redirect is authorized by single-use state,
      // PKCE and the bound SameSite=Lax browser cookie, not by its Origin.
      if (!githubCallback && ((requestOrigin && requestOrigin !== origin) || request.headers.get("sec-fetch-site") === "cross-site")) throw new PlatformFault("forbidden", "Cross-origin request denied");
      if (!["GET", "HEAD"].includes(request.method) && requestOrigin !== origin) throw new PlatformFault("forbidden", "State changes require the configured origin");
      if (githubCallback) {
        if (!github) throw new PlatformFault("capability", "GitHub identity is not configured");
        if (url.search.length > 4096) throw new PlatformFault("validation", "GitHub callback exceeds the limit");
        for (const key of url.searchParams.keys()) if (!["state", "code", "error", "error_description", "error_uri"].includes(key) || url.searchParams.getAll(key).length !== 1) throw new PlatformFault("validation", "Invalid GitHub callback parameters");
        if (url.searchParams.has("code") === url.searchParams.has("error")) throw new PlatformFault("validation", "Invalid GitHub callback parameters");
        headers.set("location", await github.callback(url.searchParams.get("state") ?? "", url.searchParams.get("code"), cookieValue(request, names.browser)));
        return new Response(null, { status: 303, headers });
      }
      const body = async (maximumBytes = 8192): Promise<unknown> => {
        if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") throw new PlatformFault("validation", "A JSON request is required");
        const reader = request.body?.getReader();
        if (!reader) throw new PlatformFault("validation", "A request body is required");
        const chunks: Uint8Array[] = []; let length = 0;
        try {
          while (true) {
            const { value, done } = await reader.read(); if (done) break;
            length += value.byteLength;
            if (length > maximumBytes) { await reader.cancel(); throw new PlatformFault("validation", "Request body exceeds the limit"); }
            chunks.push(value);
          }
          return JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch (error) { if (error instanceof PlatformFault) throw error; throw new PlatformFault("validation", "Invalid JSON request"); }
      };
      const page = () => {
        for (const key of url.searchParams.keys()) {
          if (!["limit", "cursor", "sort"].includes(key) || url.searchParams.getAll(key).length !== 1) throw new PlatformFault("validation", "Unsupported list query");
        }
        return parseComponent("PageRequest", {
          ...(url.searchParams.has("limit") ? { limit: Number(url.searchParams.get("limit")) } : {}),
          ...(url.searchParams.has("cursor") ? { cursor: url.searchParams.get("cursor") } : {}),
          ...(url.searchParams.has("sort") ? { sort: url.searchParams.get("sort") } : {}),
        });
      };
      const invitationRoute = new RegExp(`^${BASE}/orgs/([^/]+)/invitations$`).exec(url.pathname);
      const serviceAccountRoute=new RegExp(`^${BASE}/orgs/([^/]+)/service-accounts(?:/([^/]+))?(?:/(credentials)(?:/([^/]+))?)?$`).exec(url.pathname);
      if(serviceAccountRoute){if(!serviceAccounts)throw new PlatformFault('capability','Service accounts are not configured');const orgId=serviceAccountRoute[1]!;const id=serviceAccountRoute[2];const credentialsSegment=serviceAccountRoute[3];const credentialId=serviceAccountRoute[4];const token=cookieValue(request,names.session);
        if(request.method==='GET'&&!id)return json(await serviceAccounts.list(token,orgId,page()));
        if(request.method==='POST'&&!id){const input=parseComponent('ServiceAccountCreate',await body());const options=parseComponent('CommandOptions',{idempotencyKey:request.headers.get('idempotency-key')??'',expectedRevision:request.headers.get('if-match')?.replace(/^"([1-9][0-9]*)"$/,'$1')});return json(await serviceAccounts.create(token,request.headers.get('x-csrf-token')??'',orgId,input,options,requestId),201);}
        if(request.method==='POST'&&id&&!credentialsSegment){const input=parseComponent('ServiceAccountCommand',await body());const options=parseComponent('CommandOptions',{idempotencyKey:request.headers.get('idempotency-key')??'',expectedRevision:request.headers.get('if-match')?.replace(/^"([1-9][0-9]*)"$/,'$1')});return json(await serviceAccounts.command(token,request.headers.get('x-csrf-token')??'',orgId,id,input,options,requestId));}
        if(request.method==='GET'&&id&&credentialsSegment&&!credentialId)return json(await serviceAccounts.credentials(token,orgId,id,page()));
        if(request.method==='POST'&&id&&credentialsSegment&&!credentialId){const input=parseComponent('ServiceAccountCredentialCreate',await body());const options=parseComponent('CommandOptions',{idempotencyKey:request.headers.get('idempotency-key')??'',expectedRevision:request.headers.get('if-match')?.replace(/^"([1-9][0-9]*)"$/,'$1')});return json(await serviceAccounts.createCredential(token,request.headers.get('x-csrf-token')??'',orgId,id,input,options,requestId),201);}
        if(request.method==='POST'&&id&&credentialsSegment&&credentialId){const input=parseComponent('ServiceAccountCredentialCommand',await body());const options=parseComponent('CommandOptions',{idempotencyKey:request.headers.get('idempotency-key')??'',expectedRevision:request.headers.get('if-match')?.replace(/^"([1-9][0-9]*)"$/,'$1')});return json(await serviceAccounts.credentialCommand(token,request.headers.get('x-csrf-token')??'',orgId,id,credentialId,input,options,requestId));}}
      if(url.pathname===`${BASE}/account/device-authorizations/review`&&request.method==='POST'){if(!devices)throw new PlatformFault('capability','Device authorization is not configured');const input=parseComponent('DeviceAuthorizationLookup',await body());return json(await devices.review(cookieValue(request,names.session),input.userCode));}
      if(url.pathname===`${BASE}/account/device-authorizations`&&request.method==='POST'){if(!devices)throw new PlatformFault('capability','Device authorization is not configured');const input=parseComponent('DeviceAuthorizationDecision',await body());const options=parseComponent('CommandOptions',{idempotencyKey:request.headers.get('idempotency-key')??'',expectedRevision:request.headers.get('if-match')?.replace(/^"([1-9][0-9]*)"$/,'$1')});return json(await devices.decide(cookieValue(request,names.session),request.headers.get('x-csrf-token')??'',input,options,requestId));}
      const buildRoute = new RegExp(`^${BASE}/orgs/([^/]+)/projects/([^/]+)/environments/([^/]+)/builds(?:/([^/]+)(/logs)?)?$`).exec(url.pathname);
      if (buildRoute) {
        if (!builds) throw new PlatformFault('capability', 'Builds are not configured');
        const scope = parseComponent('EnvironmentScope', { orgId: buildRoute[1], projectId: buildRoute[2], environmentId: buildRoute[3] });
        const session = cookieValue(request, names.session); const csrf = request.headers.get('x-csrf-token') ?? ''; const buildId = buildRoute[4];
        if (request.method === 'GET' && buildRoute[5]) {
          for (const key of url.searchParams.keys()) if (!['after', 'limit'].includes(key) || url.searchParams.getAll(key).length !== 1) throw new PlatformFault('validation', 'Unsupported log query');
          return json(await builds.logs(session, scope, buildId!, Number(url.searchParams.get('after') ?? '0'), Number(url.searchParams.get('limit') ?? '100')));
        }
        if (request.method === 'GET' && !buildId) return json(await builds.list(session, scope, page()));
        if (request.method === 'GET') return json(await builds.get(session, scope, buildId!));
        if (request.method === 'POST' && !buildId) return json(await builds.create(session, csrf, scope, parseComponent('BuildCreate', await body()), parseComponent('CommandOptions', { idempotencyKey: request.headers.get('idempotency-key') ?? '', expectedRevision: request.headers.get('if-match')?.replace(/^"([1-9][0-9]*)"$/, '$1') }), requestId), 201);
        if (request.method === 'POST' && buildId && !buildRoute[5]) return json(await builds.command(session, csrf, scope, buildId, parseComponent('BuildCommand', await body()), parseComponent('CommandOptions', { idempotencyKey: request.headers.get('idempotency-key') ?? '', expectedRevision: request.headers.get('if-match')?.replace(/^"([1-9][0-9]*)"$/, '$1') }), requestId));
      }
      const realmRoute = new RegExp(`^${BASE}/orgs/([^/]+)/projects/([^/]+)/environments/([^/]+)/realm(?:/(users)(?:/([^/]+))?)?$`).exec(url.pathname);
      if (realmRoute) {
        if (!realms) throw new PlatformFault('capability', 'App authentication is not configured');
        const scope = parseComponent('EnvironmentScope', { orgId: realmRoute[1], projectId: realmRoute[2], environmentId: realmRoute[3] });
        const session = cookieValue(request, names.session); const csrf = request.headers.get('x-csrf-token') ?? '';
        if (request.method === 'GET' && !realmRoute[4]) return json(await realms.get(session, scope));
        if (request.method === 'GET' && realmRoute[4] && !realmRoute[5]) return json(await realms.users(session, scope, page()));
        if (request.method === 'POST' && !realmRoute[4]) return json(await realms.command(session, csrf, scope, parseComponent('RealmCommand', await body()), parseComponent('CommandOptions', { idempotencyKey: request.headers.get('idempotency-key') ?? '', expectedRevision: request.headers.get('if-match')?.replace(/^"([1-9][0-9]*)"$/, '$1') }), requestId));
        if (request.method === 'POST' && realmRoute[5]) return json(await realms.userCommand(session, csrf, scope, realmRoute[5], parseComponent('AppUserCommand', await body()), parseComponent('CommandOptions', { idempotencyKey: request.headers.get('idempotency-key') ?? '', expectedRevision: request.headers.get('if-match')?.replace(/^"([1-9][0-9]*)"$/, '$1') }), requestId));
      }
      const auditRoute = new RegExp(`^${BASE}/orgs/([^/]+)/(audit|events/stream)$`).exec(url.pathname);
      if (auditRoute && request.method === 'GET') {
        if (!audit) throw new PlatformFault('capability', 'Audit events are not configured');
        const streaming = auditRoute[2] !== 'audit';
        for (const key of url.searchParams.keys()) {
          if (!(streaming ? ['cursor', 'projectId', 'environmentId'] : ['limit', 'cursor', 'projectId', 'environmentId']).includes(key) || url.searchParams.getAll(key).length !== 1) throw new PlatformFault('validation', 'Unsupported audit query');
        }
        const scope = parseComponent('Scope', { orgId: auditRoute[1], ...(url.searchParams.has('projectId') ? { projectId: url.searchParams.get('projectId') } : {}),
          ...(url.searchParams.has('environmentId') ? { environmentId: url.searchParams.get('environmentId') } : {}) });
        const session = cookieValue(request, names.session);
        if (!streaming) return json(await audit.list(session, scope, parseComponent('PageRequest', {
          ...(url.searchParams.has('limit') ? { limit: Number(url.searchParams.get('limit')) } : {}), ...(url.searchParams.has('cursor') ? { cursor: url.searchParams.get('cursor') } : {}) })));
        // A reconnecting EventSource resends the last frame's id.
        const cursor = url.searchParams.get('cursor') ?? request.headers.get('last-event-id') ?? undefined;
        if (cursor !== undefined && (cursor.length < 1 || cursor.length > 4096)) throw new PlatformFault('validation', 'The cursor is invalid or expired');
        const streamHeaders = new Headers(headers); streamHeaders.set('content-type', 'text/event-stream; charset=utf-8'); streamHeaders.set('x-accel-buffering', 'no');
        return new Response(await audit.stream(session, scope, cursor, request.signal), { headers: streamHeaders });
      }
      const workerRoute=new RegExp(`^${BASE}/orgs/([^/]+)/workers(?:/([^/]+))?$`).exec(url.pathname);if(workerRoute){if(!workers)throw new PlatformFault('capability','Workers are not configured');const orgId=workerRoute[1]!;const id=workerRoute[2];if(request.method==='GET'&&!id)return json(await workers.list(cookieValue(request,names.session),orgId,page()));if(request.method==='POST'&&!id){const input=parseComponent('WorkerEnrollmentCreate',await body());return json(await workers.createEnrollment(cookieValue(request,names.session),request.headers.get('x-csrf-token')??'',orgId,input,parseComponent('CommandOptions',{idempotencyKey:request.headers.get('idempotency-key')??'',expectedRevision:request.headers.get('if-match')?.replace(/^"([1-9][0-9]*)"$/,'$1')}),requestId),201);}if(request.method==='POST'&&id){const input=parseComponent('WorkerCommand',await body());return json(await workers.command(cookieValue(request,names.session),request.headers.get('x-csrf-token')??'',orgId,id,input,parseComponent('CommandOptions',{idempotencyKey:request.headers.get('idempotency-key')??'',expectedRevision:request.headers.get('if-match')?.replace(/^"([1-9][0-9]*)"$/,'$1')}),requestId));}}
      const personalRoute=new RegExp(`^${BASE}/account/personal-credentials(?:/([^/]+))?$`).exec(url.pathname);if(personalRoute){if(!personal)throw new PlatformFault('capability','Personal credentials are not configured');const id=personalRoute[1];if(request.method==='GET'&&!id)return json(await personal.list(cookieValue(request,names.session),page()));if(request.method==='POST'&&!id){const input=parseComponent('PersonalCredentialCreate',await body());return json(await personal.create(cookieValue(request,names.session),request.headers.get('x-csrf-token')??'',input,parseComponent('CommandOptions',{idempotencyKey:request.headers.get('idempotency-key')??'',expectedRevision:request.headers.get('if-match')?.replace(/^"([1-9][0-9]*)"$/,'$1')}),requestId),201);}if(request.method==='POST'&&id){const input=parseComponent('PersonalCredentialCommand',await body());return json(await personal.command(cookieValue(request,names.session),request.headers.get('x-csrf-token')??'',id,input,parseComponent('CommandOptions',{idempotencyKey:request.headers.get('idempotency-key')??'',expectedRevision:request.headers.get('if-match')?.replace(/^"([1-9][0-9]*)"$/,'$1')}),requestId));}}
      if(url.pathname===`${BASE}/account/legacy-claims`&&request.method==='POST'){if(!legacy)throw new PlatformFault('capability','Legacy token migration is not configured');const input=parseComponent('LegacyOrganizationClaim',await body());return json(await legacy.claim(cookieValue(request,names.session),request.headers.get('x-csrf-token')??'',input,parseComponent('CommandOptions',{idempotencyKey:request.headers.get('idempotency-key')??'',expectedRevision:request.headers.get('if-match')?.replace(/^"([1-9][0-9]*)"$/,'$1')}),requestId));}
      const legacyTokenRoute=new RegExp(`^${BASE}/orgs/([^/]+)/legacy-tokens(?:/([^/]+))?$`).exec(url.pathname);if(legacyTokenRoute){if(!legacy)throw new PlatformFault('capability','Legacy token migration is not configured');const orgId=legacyTokenRoute[1]!;const id=legacyTokenRoute[2];if(request.method==='GET'&&!id)return json(await legacy.list(cookieValue(request,names.session),orgId,page()));if(request.method==='POST'&&id){const input=parseComponent('LegacyTokenCommand',await body());return json(await legacy.command(cookieValue(request,names.session),request.headers.get('x-csrf-token')??'',orgId,id,input,parseComponent('CommandOptions',{idempotencyKey:request.headers.get('idempotency-key')??'',expectedRevision:request.headers.get('if-match')?.replace(/^"([1-9][0-9]*)"$/,'$1')}),requestId));}}
      const deviceGrantRoute=new RegExp(`^${BASE}/account/devices(?:/([^/]+))?$`).exec(url.pathname);if(deviceGrantRoute){if(!devices)throw new PlatformFault('capability','Device authorization is not configured');if(request.method==='GET'&&!deviceGrantRoute[1])return json(await devices.list(cookieValue(request,names.session),page()));if(request.method==='POST'&&deviceGrantRoute[1]){parseComponent('DeviceGrantCommand',await body());const options=parseComponent('CommandOptions',{idempotencyKey:request.headers.get('idempotency-key')??'',expectedRevision:request.headers.get('if-match')?.replace(/^"([1-9][0-9]*)"$/,'$1')});return json(await devices.revoke(cookieValue(request,names.session),request.headers.get('x-csrf-token')??'',deviceGrantRoute[1],options,requestId));}}
      const repositoryInstallationsRoute = new RegExp(`^${BASE}/orgs/([^/]+)/repository-installations$`).exec(url.pathname);
      if (repositoryInstallationsRoute) {
        if (!repositories) throw new PlatformFault('capability', 'GitHub repositories are not configured');
        const orgId = repositoryInstallationsRoute[1]!; const token = cookieValue(request, names.session);
        if (request.method === 'GET') return json(await repositories.installations(token, orgId, page()));
        if (request.method === 'POST') {
          const input = parseComponent('RepositoryInstallationConnect', await body());
          const options = parseComponent('CommandOptions', { idempotencyKey: request.headers.get('idempotency-key') ?? '', expectedRevision: request.headers.get('if-match')?.replace(/^"([1-9][0-9]*)"$/, '$1') });
          return json({ receipt: await repositories.connect(token, request.headers.get('x-csrf-token') ?? '', orgId, input.installationId, options, requestId) }, 201);
        }
      }
      const projectRepositoryRoute = new RegExp(`^${BASE}/orgs/([^/]+)/projects/([^/]+)/repository(?:/(resolve|proposal))?$`).exec(url.pathname);
      if (projectRepositoryRoute) {
        if (!repositories) throw new PlatformFault('capability', 'GitHub repositories are not configured');
        const scope = parseComponent('Scope', { orgId: projectRepositoryRoute[1], projectId: projectRepositoryRoute[2] }); const token = cookieValue(request, names.session);
        if (request.method === 'GET' && !projectRepositoryRoute[3]) return json(await repositories.configuration(token, scope));
        if (request.method === 'POST' && projectRepositoryRoute[3] === 'resolve') { const input = parseComponent('RepositoryCommitResolve', await body()); return json(await repositories.resolve(token, request.headers.get('x-csrf-token') ?? '', scope, input.ref, requestId)); }
        if (request.method === 'POST' && projectRepositoryRoute[3] === 'proposal') {
          const input=parseComponent('RepositoryFileProposal',await body(270336));const options=parseComponent('CommandOptions',{idempotencyKey:request.headers.get('idempotency-key')??'',expectedRevision:request.headers.get('if-match')?.replace(/^"([1-9][0-9]*)"$/,'$1')});
          return json(await repositories.propose(token,request.headers.get('x-csrf-token')??'',scope,input,options,requestId),201);
        }
        if (request.method === 'POST') {
          const command = parseComponent('ProjectRepositoryCommand', await body());
          const options = parseComponent('CommandOptions', { idempotencyKey: request.headers.get('idempotency-key') ?? '', expectedRevision: request.headers.get('if-match')?.replace(/^"([1-9][0-9]*)"$/, '$1') });
          return json({ receipt: await repositories.command(token, request.headers.get('x-csrf-token') ?? '', scope, command, options, requestId) });
        }
      }
      const importRoute = new RegExp(`^${BASE}/orgs/([^/]+)/projects/([^/]+)/environments/([^/]+)/data/imports(?:/([^/]+)/(status|cancel))?$`).exec(url.pathname);
      if (importRoute && request.method === 'POST') {
        if (!imports) throw new PlatformFault('capability', 'Durable imports are not configured');
        if (url.search) throw new PlatformFault('validation', 'Import scope belongs in the path');
        const scope = parseComponent('EnvironmentScope', { orgId: importRoute[1], projectId: importRoute[2], environmentId: importRoute[3] });
        const token = cookieValue(request, names.session); const csrf = request.headers.get('x-csrf-token') ?? '';
        if (importRoute[5] === 'status') {
          const input = await body();
          if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) throw new PlatformFault('validation', 'Import status requires an empty JSON object');
          return json(await imports.get(token, csrf, scope, importRoute[4]!));
        }
        const options = parseComponent('CommandOptions', { idempotencyKey: request.headers.get('idempotency-key') ?? '',
          expectedRevision: request.headers.get('if-match')?.replace(/^"([1-9][0-9]*)"$/, '$1') });
        if (importRoute[5] === 'cancel') return json({ receipt: await imports.cancel(token, csrf, scope, importRoute[4]!, parseComponent('DataImportJobCancel', await body()), options) }, 202);
        return json({ receipt: await imports.enqueue(token, csrf, scope, parseComponent('DataImportJobCreate', await body(393216)), options, requestId) }, 202);
      }
      const dataRoute = new RegExp(`^${BASE}/orgs/([^/]+)/projects/([^/]+)/environments/([^/]+)/data$`).exec(url.pathname);
      if (dataRoute && request.method === 'POST') {
        if (!data) throw new PlatformFault('capability', 'Database forwarding is not configured');
        if (url.search) throw new PlatformFault('validation', 'Data scope belongs in the path');
        const scope = parseComponent('EnvironmentScope', { orgId: dataRoute[1], projectId: dataRoute[2], environmentId: dataRoute[3] });
        const command = parseComponent('AccountDataRequest', await body(393216));
        const options = 'commandId' in command ? parseComponent('CommandOptions', { idempotencyKey: request.headers.get('idempotency-key') ?? '',
          expectedRevision: request.headers.get('if-match')?.replace(/^"([1-9][0-9]*)"$/, '$1') }) : undefined;
        return json(await data.execute(cookieValue(request, names.session), request.headers.get('x-csrf-token') ?? '', scope, command, options, requestId, request.signal));
      }
      const accessRoute = new RegExp(`^${BASE}/orgs/([^/]+)/access$`).exec(url.pathname);
      if (accessRoute && request.method === 'GET') {
        if (!access) throw new PlatformFault("capability", "Platform authority is not configured");
        for (const key of url.searchParams.keys()) if (!["projectId", "environmentId", "realmId"].includes(key) || url.searchParams.getAll(key).length !== 1) throw new PlatformFault("validation", "Unsupported access scope query");
        return json(await access.resolve(cookieValue(request, names.session), parseComponent("Scope", { orgId: accessRoute[1], ...Object.fromEntries(url.searchParams) })));
      }
      if (invitationRoute) {
        if (!invitations) throw new PlatformFault("capability", "Invitations are not configured");
        const orgId = invitationRoute[1]!; const token = cookieValue(request, names.session);
        if (request.method === "GET") return json(await invitations.list(token, orgId, page()));
        if (request.method === "POST") {
          const options = parseComponent("CommandOptions", { idempotencyKey: request.headers.get("idempotency-key") ?? "",
            expectedRevision: request.headers.get("if-match")?.replace(/^"([1-9][0-9]*)"$/, "$1") });
          return json({ receipt: await invitations.command(token, request.headers.get("x-csrf-token") ?? "", orgId,
            parseComponent("InvitationCommand", await body()), options, requestId, peerAddress) });
        }
      }
      if ([`${BASE}/invitations/preview`, `${BASE}/invitations/accept`].includes(url.pathname) && request.method === "POST") {
        if (!invitations) throw new PlatformFault("capability", "Invitations are not configured");
        const input = parseComponent("InvitationProof", await body()); const token = cookieValue(request, names.session); const csrf = request.headers.get("x-csrf-token") ?? "";
        if (url.pathname.endsWith("/preview")) return json(await invitations.preview(token, csrf, input));
        const options = parseComponent("CommandOptions", { idempotencyKey: request.headers.get("idempotency-key") ?? "" });
        return json({ receipt: await invitations.accept(token, csrf, input, options, requestId) });
      }
      const secretRoute = new RegExp(`^${BASE}/orgs/([^/]+)/projects/([^/]+)/environments/([^/]+)/secrets(?:/([^/]+))?$`).exec(url.pathname);
      if (secretRoute) {
        if (!secrets) throw new PlatformFault('capability', 'Environment secrets are not configured');
        const scope = parseComponent('EnvironmentScope', { orgId: secretRoute[1], projectId: secretRoute[2], environmentId: secretRoute[3] });
        const secretId = secretRoute[4]; const token = cookieValue(request, names.session);
        if (request.method === 'GET' && !secretId) return json(await secrets.list(token, scope, page()));
        if (request.method === 'POST') {
          if (url.search) throw new PlatformFault('validation', 'Secret scope belongs in the path');
          const options = parseComponent('CommandOptions', { idempotencyKey: request.headers.get('idempotency-key') ?? '',
            expectedRevision: request.headers.get('if-match')?.replace(/^"([1-9][0-9]*)"$/, '$1') });
          const csrf = request.headers.get('x-csrf-token') ?? '';
          if (secretId) return json(await secrets.command(token, csrf, scope, secretId,
            parseComponent('EnvironmentSecretCommand', await body(73728)), options, requestId));
          return json(await secrets.create(token, csrf, scope, parseComponent('EnvironmentSecretCreate', await body(73728)), options, requestId), 201);
        }
      }
      const credentialRoute = new RegExp(`^${BASE}/orgs/([^/]+)/projects/([^/]+)/environments/([^/]+)/credentials(?:/([^/]+))?$`).exec(url.pathname);
      if (credentialRoute) {
        if (!credentials) throw new PlatformFault('capability', 'Environment credentials are not configured');
        const scope = parseComponent('EnvironmentScope', { orgId: credentialRoute[1], projectId: credentialRoute[2], environmentId: credentialRoute[3] });
        const credentialId = credentialRoute[4]; const token = cookieValue(request, names.session);
        if (request.method === 'GET' && !credentialId) return json(await credentials.list(token, scope, page()));
        if (request.method === 'POST') {
          if (url.search) throw new PlatformFault('validation', 'Credential scope belongs in the path');
          const options = parseComponent('CommandOptions', { idempotencyKey: request.headers.get('idempotency-key') ?? '',
            expectedRevision: request.headers.get('if-match')?.replace(/^"([1-9][0-9]*)"$/, '$1') });
          const csrf = request.headers.get('x-csrf-token') ?? '';
          if (credentialId) return json(await credentials.command(token, csrf, scope, credentialId,
            parseComponent('EnvironmentCredentialCommand', await body()), options, requestId));
          return json(await credentials.create(token, csrf, scope, parseComponent('EnvironmentCredentialCreate', await body()), options, requestId), 201);
        }
      }
      const catalogRoute = new RegExp(`^${BASE}/orgs/([^/]+)/projects(?:/([^/]+)(?:/(environments)(?:/([^/]+)(?:/operations/([^/]+))?)?)?)?$`).exec(url.pathname);
      if (catalogRoute) {
        if (!catalog) throw new PlatformFault('capability', 'The catalog is not configured');
        const [, orgId, projectId, collection, environmentId, operationId] = catalogRoute;
        const scope = parseComponent('Scope', { orgId, ...(projectId ? { projectId } : {}), ...(environmentId ? { environmentId } : {}) });
        const token = cookieValue(request, names.session);
        if (request.method === 'GET') {
          if (!projectId || (collection && !environmentId)) return json(await catalog.list(token, scope, page()));
          if (url.search) throw new PlatformFault('validation', 'This endpoint does not accept query parameters');
          return json(operationId ? await catalog.operation(token, scope, operationId) : await catalog.get(token, scope));
        }
        if (request.method === 'POST') {
          if (url.search) throw new PlatformFault('validation', 'This endpoint does not accept query parameters');
          let command: CatalogCommand;
          const input = await body();
          if (operationId) command = { action: 'operation-command', operationId, input: parseComponent('CatalogOperationCommand', input) };
          else if (environmentId) command = { action: 'environment-command', input: parseComponent('CatalogEnvironmentCommand', input) };
          else if (collection) command = { action: 'environment-create', input: parseComponent('CatalogEnvironmentCreate', input) };
          else if (projectId) command = { action: 'project-command', input: parseComponent('CatalogProjectCommand', input) };
          else command = { action: 'project-create', input: parseComponent('CatalogProjectCreate', input) };
          const options = parseComponent('CommandOptions', { idempotencyKey: request.headers.get('idempotency-key') ?? '', expectedRevision: request.headers.get('if-match')?.replace(/^"([1-9][0-9]*)"$/, '$1') });
          const receipt = await catalog.execute(token, request.headers.get('x-csrf-token') ?? '', scope, command, options, requestId);
          if (receipt.operationId) headers.set('location', `${BASE}/orgs/${receipt.scope.orgId}/projects/${receipt.scope.projectId}/environments/${receipt.scope.environmentId}/operations/${receipt.operationId}`);
          return json({ receipt }, receipt.operationId ? 202 : 200);
        }
      }
      const memberAccessRoute = new RegExp(`^${BASE}/orgs/([^/]+)/members/([^/]+)/access$`).exec(url.pathname);
      if (memberAccessRoute && request.method === 'GET') {
        if (!organizations) throw new PlatformFault("capability", "Organizations are not configured");
        if (url.search) throw new PlatformFault("validation", "This endpoint does not accept query parameters");
        return json(await organizations.memberAccess(cookieValue(request, names.session), memberAccessRoute[1]!, memberAccessRoute[2]!));
      }
      const organizationRoute = new RegExp(`^${BASE}/orgs(?:/([^/]+)(?:/(members|settings))?)?$`).exec(url.pathname);
      if (organizationRoute) {
        if (!organizations) throw new PlatformFault("capability", "Organizations are not configured");
        const orgId = organizationRoute[1]; const section = organizationRoute[2];
        const token = cookieValue(request, names.session);
        if (request.method === "GET" && section !== "settings") {
          if (!orgId || section === "members") return json(await organizations.list(token, page(), orgId));
          return json(await organizations.get(token, orgId));
        }
        if (request.method === "POST" && (!orgId || section)) {
          const options = parseComponent("CommandOptions", { idempotencyKey: request.headers.get("idempotency-key") ?? "",
            ...(orgId ? { expectedRevision: request.headers.get("if-match")?.replace(/^"([1-9][0-9]*)"$/, "$1") } : {}) });
          const csrf = request.headers.get("x-csrf-token") ?? "";
          let receipt;
          if (orgId) {
            const command = parseComponent("OrganizationCommand", await body());
            const settings = ["update", "policy", "delete", "delete-cancel"].includes(command.kind);
            if (settings !== (section === "settings")) throw new PlatformFault("validation", "This command belongs to another organization endpoint");
            receipt = await organizations.command(token, csrf, orgId, command, options, requestId);
          } else receipt = await organizations.create(token, csrf, parseComponent("OrganizationCreate", await body()), options, requestId);
          return json({ receipt }, orgId ? 200 : 201);
        }
      }
      if (url.pathname === `${BASE}/auth/bootstrap` && request.method === "GET") {
        const existing = cookieValue(request, names.browser);
        if (!/^browser_[A-Za-z0-9_-]{43}$/.test(existing)) headers.append("set-cookie", cookie(names.browser, opaqueToken("browser"), 1800));
        return json({ ...auth.configuration(), githubAvailable: Boolean(github) });
      }
      if (url.pathname === `${BASE}/auth/github/start` && request.method === "POST") {
        if (!github) throw new PlatformFault("capability", "GitHub identity is not configured");
        return json(await github.start(parseComponent("GithubAuthStart", await body()), cookieValue(request, names.browser), request.headers.get("idempotency-key") ?? "", requestId, peerAddress,
          cookieValue(request, names.session), request.headers.get("x-csrf-token") ?? ""));
      }
      if (url.pathname === `${BASE}/auth/github/complete` && request.method === "POST") {
        if (!github) throw new PlatformFault("capability", "GitHub identity is not configured");
        const result = await github.complete(parseComponent("GithubAuthComplete", await body()), cookieValue(request, names.browser), requestId, request.headers.get("user-agent") ?? "Browser",
          cookieValue(request, names.session), request.headers.get("x-csrf-token") ?? "");
        const seconds = Math.max(0, Math.floor((new Date(result.expiresAt).getTime() - Date.now()) / 1000));
        headers.append("set-cookie", cookie(names.session, result.sessionToken, seconds)); headers.append("set-cookie", cookie(names.csrf, result.csrfToken, seconds, false));
        headers.append("set-cookie", cookie(names.browser, "", 0));
        return json(parseComponent("GithubAuthCompleteResponse", { returnTo: result.returnTo, linked: result.linked }));
      }
      if (url.pathname === `${BASE}/auth/challenges` && request.method === "POST") {
        const input = parseComponent("AccountAuthRequest", await body());
        const options = parseComponent("CommandOptions", { idempotencyKey: request.headers.get("idempotency-key") ?? "" });
        const receipt = await auth.request(input, cookieValue(request, names.browser), options.idempotencyKey, requestId, peerAddress);
        return json(receipt, 202);
      }
      if (url.pathname === `${BASE}/account/fresh-auth/challenges` && request.method === "POST") {
        const input = parseComponent("AccountFreshAuthRequest", await body());
        const options = parseComponent("CommandOptions", { idempotencyKey: request.headers.get("idempotency-key") ?? "" });
        return json(await auth.requestFresh(cookieValue(request, names.session), request.headers.get("x-csrf-token") ?? "", input,
          cookieValue(request, names.browser), options.idempotencyKey, requestId, peerAddress), 202);
      }
      if ([`${BASE}/auth/complete`, `${BASE}/account/fresh-auth/complete`].includes(url.pathname) && request.method === "POST") {
        const input = parseComponent("AccountAuthComplete", await body());
        const result = url.pathname === `${BASE}/auth/complete`
          ? await auth.complete(input.token, cookieValue(request, names.browser), requestId, request.headers.get("user-agent") ?? "Browser", input.code)
          : await auth.completeFresh(cookieValue(request, names.session), request.headers.get("x-csrf-token") ?? "", input.token, cookieValue(request, names.browser), requestId, input.code);
        const seconds = Math.max(0, Math.floor((new Date(result.session.expiresAt).getTime() - Date.now()) / 1000));
        headers.append("set-cookie", cookie(names.session, result.sessionToken, seconds));
        headers.append("set-cookie", cookie(names.csrf, result.csrfToken, seconds, false));
        headers.append("set-cookie", cookie(names.browser, "", 0));
        return json({ returnTo: result.redirectPath });
      }
      if (url.pathname === `${BASE}/account/profile` && request.method === "GET") {
        if (!profile) throw new PlatformFault("capability", "Account profiles are not configured");
        return json(await profile.view(cookieValue(request, names.session)));
      }
      if (url.pathname === `${BASE}/account/profile` && request.method === "POST") {
        if (!profile) throw new PlatformFault("capability", "Account profiles are not configured");
        const command = parseComponent("AccountProfileCommand", await body());
        const revision = request.headers.get("if-match")?.replace(/^"([1-9][0-9]*)"$/, "$1");
        const options = parseComponent("CommandOptions", { idempotencyKey: request.headers.get("idempotency-key") ?? "", expectedRevision: revision });
        return json({ receipt: await profile.execute(cookieValue(request, names.session), request.headers.get("x-csrf-token") ?? "",
          command, options, requestId, cookieValue(request, names.browser), peerAddress) }, command.kind === "email-change" ? 202 : 200);
      }
      if (url.pathname === `${BASE}/account/email/complete` && request.method === "POST") {
        if (!profile) throw new PlatformFault("capability", "Account profiles are not configured");
        const result = await profile.completeEmail(cookieValue(request, names.session), request.headers.get("x-csrf-token") ?? "",
          parseComponent("AccountEmailComplete", await body()), cookieValue(request, names.browser), requestId);
        const seconds = Math.max(0, Math.floor((new Date(result.expiresAt).getTime() - Date.now()) / 1000));
        headers.append("set-cookie", cookie(names.session, result.sessionToken, seconds));
        headers.append("set-cookie", cookie(names.csrf, result.csrfToken, seconds, false));
        headers.append("set-cookie", cookie(names.browser, "", 0));
        return json({ returnTo: "/account/profile" });
      }
      if (url.pathname === `${BASE}/account/session` && request.method === "GET") {
        const session = await auth.session(cookieValue(request, names.session));
        if (!session) return json({ session: null });
        const { csrfHash: _, ...safe } = session;
        return json({ session: parseComponent("AccountSession", safe) });
      }
      if (url.pathname === `${BASE}/account/sessions` && request.method === "GET") {
        if (!security) throw new PlatformFault("capability", "Account security is not configured");
        return json(await security.listSessions(cookieValue(request, names.session), page()));
      }
      if (url.pathname === `${BASE}/account/identities` && request.method === "GET") {
        if (!security) throw new PlatformFault("capability", "Account security is not configured");
        return json(await security.listIdentities(cookieValue(request, names.session)));
      }
      if (url.pathname === `${BASE}/account/security` && request.method === "POST") {
        if (!security) throw new PlatformFault("capability", "Account security is not configured");
        const command = parseComponent("AccountSecurityCommand", await body());
        const revision = request.headers.get("if-match")?.replace(/^"([1-9][0-9]*)"$/, "$1");
        const options = parseComponent("CommandOptions", { idempotencyKey: request.headers.get("idempotency-key") ?? "", expectedRevision: revision });
        const result = await security.execute(cookieValue(request, names.session), request.headers.get("x-csrf-token") ?? "", command, options, requestId);
        if (result.rotatedSession) {
          const seconds = Math.max(0, Math.floor((new Date(result.rotatedSession.expiresAt).getTime() - Date.now()) / 1000));
          headers.append("set-cookie", cookie(names.session, result.rotatedSession.token, seconds));
          headers.append("set-cookie", cookie(names.csrf, result.rotatedSession.csrfToken, seconds, false));
        }
        return json(parseComponent("AccountSecurityResponse", { receipt: result.receipt, ...(result.enrollment ? { enrollment: result.enrollment } : {}), ...(result.recoveryCodes ? { recoveryCodes: result.recoveryCodes } : {}) }));
      }
      if (url.pathname === `${BASE}/auth/signout` && request.method === "POST") {
        parseComponent("CommandOptions", { idempotencyKey: request.headers.get("idempotency-key") ?? "" });
        await auth.signOut(cookieValue(request, names.session), request.headers.get("x-csrf-token") ?? "", requestId);
        headers.append("set-cookie", cookie(names.session, "", 0)); headers.append("set-cookie", cookie(names.csrf, "", 0, false));
        return json({ signedOut: true });
      }
      throw new PlatformFault("not_found", "Route not found");
    } catch (error) {
      const fault = error instanceof PlatformFault ? error : error instanceof ContractError ? new PlatformFault("validation", "Invalid request") : new PlatformFault("internal", "The request could not be completed");
      if (fault.code === "rate_limited") headers.set("retry-after", "900");
      return json({ error: { code: fault.code, message: fault.message, requestId, ...(fault.fieldErrors ? { fieldErrors: fault.fieldErrors } : {}) } }, STATUS[fault.code]);
    }
  };
}

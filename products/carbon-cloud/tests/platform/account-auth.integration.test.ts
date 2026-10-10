import { canonicalRegistryRequest, dataRequestPath, parseComponent, registryRequestPath, type DeviceAuthorizationCreate, type EnvironmentScope } from "@carbon/contracts/platform";
import { AccountCatalog, AccountEnvironmentCredentials, AccountEnvironmentSecrets, AccountRepositories, AccountWorkers, WorkerLeases, WorkerProtocol, PostgresWorkerRepository, CatalogLifecycle, PostgresProviderSecretReader, EnvelopeSecretProtector, EnvironmentCredentialAuthentication, LocalAesSecretKeyCustodian, PostgresCatalogRepository, PostgresEnvironmentCredentialRepository, PostgresEnvironmentSecretRepository, PostgresProvisioningRepository, PostgresRepositoryIntegrationRepository, PostgresServiceAuthority, ProvisionEnvironment, type ProvisioningWork, type RepositoryProvider } from '@carbon/catalog';
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { createHash, createHmac, randomBytes, generateKeyPairSync } from "node:crypto";
import {
  AccountAuthentication, AccountDeviceAuthorization, AccountServiceAccounts, AccountAudit, OrganizationLifecycle, PostgresAuditLog, AccountPersonalCredentials, PersonalCredentialAuthentication, PostgresPersonalCredentialRepository, AccountLegacyTokens, PostgresLegacyTokenRepository, PostgresIdentityRepository, CreateOrganizationUseCase, IssueWorkerTokenUseCase, VerifyTokenUseCase, DeviceCredentialAuthentication, DeliverAccountMail, EnvelopeMessageProtector, PostgresAccountIdentityRepository, PostgresDeviceAuthorizationRepository, PostgresServiceAccountRepository, ServiceAccountAuthentication, ServiceAssertionIssuer, ServiceAssertionVerifier,
  PostgresAccountMailQueue, bodyDigest, tokenDigest, type AccountEmail,
  AccountSecurity, PostgresAccountSecurityRepository, PostgresMfaVerification, Rfc6238Totp,
  AccountProfile, PostgresAccountProfileRepository,
  OrganizationAccess, PostgresOrganizationRepository, OrganizationInvitations, PostgresOrganizationInvitationsRepository,
  ExternalAccountAuthentication, PostgresExternalAccountRepository, AccountAuthorization, PostgresPlatformAuthority,
} from "@carbon/identity";
import { GitHubAccountProvider } from "@carbon/github-identity";
import { ResendAccountNotification } from "@carbon/resend-notification";
import { migrate } from "../../infrastructure/persistence/Database.ts";
import { SignJWT } from "jose";
import { AccountRealms, AppAuthentication, HttpOidcClient, PostgresAppAuthRepository, PostgresAppMailQueue } from "@carbon/auth";
import { createAppRoutes } from "../../presentation/http/app-routes.ts";
import { createWorkerRoutes } from "../../presentation/http/worker-routes.ts";
import { createAccountRoutes } from "../../presentation/http/account-routes.ts";
import { accountPlatformConfigFromEnv } from "../../composition/account-platform.ts";
import { catalogProvisionersFromEnv } from '../../composition/catalog-worker.ts';
import { dataClientFromEnv, importClientFromEnv } from '../../composition/data-platform.ts';

const databaseUrl = process.env.CARBON_PLATFORM_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const cleanups: (() => Promise<void>)[] = [];
const origin = "https://cloud.example.test";
async function cleanupDatabases() { while (cleanups.length) { await cleanups.at(-1)!(); cleanups.pop(); } }
afterEach(cleanupDatabases, 30000);
afterAll(cleanupDatabases, 30000);

async function harness() {
  const url = new URL(databaseUrl!);
  if (url.pathname !== "/carbon_platform_test") throw new Error("Requires the dedicated carbon_platform_test database");
  const admin = new Bun.SQL(url.href, { max: 1 });
  const name = `carbon_platform_test_${crypto.randomUUID().replaceAll("-", "")}`;
  await admin.unsafe(`CREATE DATABASE "${name}"`); url.pathname = `/${name}`;
  const sql = new Bun.SQL(url.href, { max: 3 });
  cleanups.push(async () => {
    await sql.close();
    if (!/^carbon_platform_test_[a-f0-9]{32}$/.test(name)) throw new Error("Unsafe test database cleanup");
    await admin.unsafe(`DROP DATABASE "${name}"`); await admin.close();
  });
  await migrate(sql);
  const encryptionKey = randomBytes(32).toString("base64");
  const protector = new EnvelopeMessageProtector("test-key", { "test-key": encryptionKey });
  const secretProtector = new EnvelopeSecretProtector(new LocalAesSecretKeyCustodian('secret-test-key', { 'secret-test-key': randomBytes(32).toString('base64') }));
  const config = { origin, termsVersion: "2026-09-12", rateLimitKey: randomBytes(32).toString("base64") };
  const assertionKeys=generateKeyPairSync('ed25519');const assertionSeconds=Math.floor(Date.now()/1000);const assertionKey={id:'service-account-test',key:assertionKeys.privateKey,notBefore:assertionSeconds-60,notAfter:assertionSeconds+3600};const assertionIssuer=new ServiceAssertionIssuer(origin,assertionKey);
  let now = Date.now(); const totp = new Rfc6238Totp();
  const mfa = new PostgresMfaVerification(protector, totp, () => new Date(now));
  const makeAuth = () => new AccountAuthentication(new PostgresAccountIdentityRepository(sql, mfa), protector, config, () => new Date(now));
  let githubAccount = { id: 123456, email: "github@example.test", aliases: [] as string[] }; let githubFailure = false;
  const githubCalls: { url: string; init: RequestInit }[] = [];
  const githubProvider = new GitHubAccountProvider("fixture-client", "fixture-secret", origin + "/platform/v1/auth/github/callback", (async (url, init) => {
    githubCalls.push({ url: String(url), init: init! });
    if (githubFailure) return Response.json({ error: "fixture provider secret" }, { status: 503 });
    if (String(url).endsWith("/login/oauth/access_token")) return Response.json({ access_token: "gho_fixture_secret", token_type: "bearer", scope: "user:email" });
    if (String(url).endsWith("/user")) return Response.json({ id: githubAccount.id, type: "User", login: "mutable-handle", name: "GitHub member" });
    return Response.json([{ email: githubAccount.email, primary: true, verified: true }, ...githubAccount.aliases.map(email => ({ email, primary: false, verified: true }))]);
  }) as typeof fetch);
  let repositoryAvailable = true; let repositoryRefreshes = 0; let repositoryResolutions = 0; let repositoryProposals = 0;
  const repositoryProvider: RepositoryProvider = {
    provider: 'github',
    async refresh(installationId) { repositoryRefreshes++; if (installationId !== '42') throw new Error('unexpected installation'); return { installationId, accountId: '77', account: 'carbon-team', accountKind: 'organization', repositories: repositoryAvailable ? [{ id: '99', fullName: 'carbon-team/desktop', defaultBranch: 'main', private: true, archived: false }] : [] }; },
    async resolveCommit(installationId, repositoryId, ref) { repositoryResolutions++; await this.refresh(installationId); if (!repositoryAvailable || repositoryId !== '99') throw new Error('repository unavailable'); return { repositoryId, requestedRef: ref, sha: 'b'.repeat(40) }; },
    async createProposal(_installationId, _repositoryId, _baseBranch, proposal) { repositoryProposals++; return { pullRequestNumber: 12, url: 'https://github.com/carbon-team/desktop/pull/12', branch: proposal.branch, baseSha: 'b'.repeat(40), headSha: 'c'.repeat(40) }; },
    verifyWebhook(raw, signature, deliveryId, event) { const expected='sha256='+createHmac('sha256','repository-webhook-secret').update(raw).digest('hex'); if(signature!==expected||!deliveryId||!event) throw new Error('invalid webhook'); },
  };
  const makeHandler = (auth: AccountAuthentication) => createAccountRoutes(auth, origin, new AccountSecurity(auth, new PostgresAccountSecurityRepository(sql, mfa), protector, totp), new AccountProfile(auth, new PostgresAccountProfileRepository(sql, mfa), protector, config), new OrganizationAccess(auth, new PostgresOrganizationRepository(sql), protector), new OrganizationInvitations(auth, new PostgresOrganizationInvitationsRepository(sql), new PostgresOrganizationRepository(sql), protector, config), new ExternalAccountAuthentication(auth, new PostgresExternalAccountRepository(sql, mfa), githubProvider, protector, config), new AccountAuthorization(auth, new PostgresPlatformAuthority(sql)), new AccountCatalog(auth, new PostgresCatalogRepository(sql), protector), undefined, undefined, new AccountEnvironmentCredentials(auth, new PostgresEnvironmentCredentialRepository(sql), protector), new AccountEnvironmentSecrets(auth, new PostgresEnvironmentSecretRepository(sql, secretProtector), protector), new AccountRepositories(auth, new PostgresRepositoryIntegrationRepository(sql), repositoryProvider, protector), new AccountDeviceAuthorization(auth,new PostgresDeviceAuthorizationRepository(sql),protector,origin,config.rateLimitKey,new DeviceCredentialAuthentication(sql),assertionIssuer),new AccountServiceAccounts(auth,new PostgresServiceAccountRepository(sql),protector,assertionIssuer),new AccountPersonalCredentials(auth,new PostgresPersonalCredentialRepository(sql),protector),new AccountLegacyTokens(auth,new PostgresLegacyTokenRepository(sql),protector,'accept'),new AccountWorkers(auth,new PostgresWorkerRepository(sql,secretProtector),protector),new AccountAudit(auth,new PostgresAuditLog(sql),protector,{pollMs:15,heartbeatMs:120,maxMs:900}),new AccountRealms(auth,new PostgresAppAuthRepository(sql),protector));
  let auth = makeAuth(); let handler = makeHandler(auth);
  // A stand-in identity provider: real discovery, token and key endpoints over the OIDC client's transport, a real signing key.
  const idpIssuer = 'https://login.example.test'; const idpKeys = generateKeyPairSync('ec', { namedCurve: 'P-256' }); const forgedKeys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  type IdpAnswer = { subject: string; email: string; emailVerified?: boolean; nonce?: string; audience?: string; issuer?: string; forged?: boolean; expired?: boolean; refuse?: boolean };
  const idp = { issuer: idpIssuer, next: undefined as (IdpAnswer & { challenge: string; expectedNonce: string }) | undefined, last: undefined as Record<string, unknown> | undefined,
    arm(url: URL, answer: IdpAnswer) { idp.next = { ...answer, challenge: url.searchParams.get('code_challenge')!, expectedNonce: url.searchParams.get('nonce')! }; } };
  const idpTransport = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.href === `${idpIssuer}/.well-known/openid-configuration`) return Response.json({ issuer: idpIssuer, authorization_endpoint: `${idpIssuer}/authorize`, token_endpoint: `${idpIssuer}/token`, jwks_uri: `${idpIssuer}/keys` });
    if (url.href === `${idpIssuer}/keys`) return Response.json({ keys: [{ ...idpKeys.publicKey.export({ format: 'jwk' }), kid: 'idp-key', alg: 'ES256', use: 'sig' }] });
    if (url.href === `${idpIssuer}/token` && init?.method === 'POST') {
      const form = new URLSearchParams(String(init.body)); const answer = idp.next; idp.next = undefined;
      if (!answer || answer.refuse || form.get('code') !== 'good-code' || form.get('grant_type') !== 'authorization_code') return Response.json({ error: 'invalid_grant' }, { status: 400 });
      idp.last = { pkce: createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') === answer.challenge, clientSecret: form.get('client_secret'), redirectUri: form.get('redirect_uri'), clientId: form.get('client_id') };
      const seconds = Math.floor(Date.now() / 1000);
      const idToken = await new SignJWT({ nonce: answer.nonce ?? answer.expectedNonce, email: answer.email, email_verified: answer.emailVerified ?? true })
        .setProtectedHeader({ alg: 'ES256', kid: 'idp-key' }).setIssuer(answer.issuer ?? idpIssuer).setAudience(answer.audience ?? 'carbon-client').setSubject(answer.subject)
        .setIssuedAt(answer.expired ? seconds - 7200 : seconds).setExpirationTime(answer.expired ? seconds - 3600 : seconds + 300).sign(answer.forged ? forgedKeys.privateKey : idpKeys.privateKey);
      return Response.json({ access_token: 'unused', token_type: 'Bearer', id_token: idToken });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  const appRepository = new PostgresAppAuthRepository(sql);
  const appHandler = createAppRoutes(new AppAuthentication(appRepository, protector, { rateLimitKey: config.rateLimitKey }, new HttpOidcClient(idpTransport), new PostgresProviderSecretReader(sql, secretProtector), assertionIssuer), origin);
  // App calls carry no cookie and no Origin unless a test adds them on purpose.
  const app = (path: string, method = 'GET', input?: unknown, overrides: Record<string, string> = {}, peer = '203.0.113.10') => appHandler(new Request(origin + path, { method,
    headers: { ...(input === undefined ? {} : { 'content-type': 'application/json' }), ...overrides }, body: input === undefined ? undefined : JSON.stringify(input) }), peer);
  const workerHandler = createWorkerRoutes(new WorkerProtocol(new PostgresWorkerRepository(sql, secretProtector)), origin);
  // Worker calls carry no Origin and no cookies unless a test adds them on purpose.
  const workerApi = (path: string, input?: unknown, overrides: Record<string, string> = {}) => workerHandler(new Request(origin + path, { method: 'POST',
    headers: { ...(input === undefined ? {} : { 'content-type': 'application/json' }), ...overrides }, body: input === undefined ? undefined : JSON.stringify(input) }));
  const leases = new WorkerLeases(new PostgresWorkerRepository(sql, secretProtector));
  const organizationLifecycle = new OrganizationLifecycle(new PostgresAuditLog(sql)); const catalogLifecycle = new CatalogLifecycle(new PostgresCatalogRepository(sql));
  const mail: (AccountEmail & { idempotencyKey: string })[] = [];
  const accepted = new Set<string>(); let failProvider = false;
  const provider = new ResendAccountNotification("resend-test-only", "Carbon <auth@example.test>", (async (input, init) => {
    expect(input).toBe("https://api.resend.com/emails");
    const headers = new Headers(init?.headers); expect(headers.get("authorization")).toBe("Bearer resend-test-only");
    const payload = JSON.parse(String(init?.body)); const key = headers.get("idempotency-key")!;
    if (failProvider) return Response.json({ message: "provider failure with secret data" }, { status: 503 });
    if (!accepted.has(key)) { mail.push({ to: payload.to[0], subject: payload.subject, text: payload.text, idempotencyKey: key }); accepted.add(key); }
    return Response.json({ id: crypto.randomUUID() });
  }) as typeof fetch);
  const makeWorker = () => new DeliverAccountMail(new PostgresAccountMailQueue(sql), protector, provider);
  let worker = makeWorker();
  const deliverApp = () => new DeliverAccountMail(new PostgresAppMailQueue(sql), protector, provider).execute();
  const cookies = new Map<string, string>();
  const call = async (path: string, method = "GET", input?: unknown, overrides: Record<string, string> = {}) => {
    const headers = new Headers({ origin, "content-type": "application/json", "idempotency-key": crypto.randomUUID(), cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join("; "), ...overrides });
    const response = await handler(new Request(origin + path, { method, headers, body: input === undefined ? undefined : JSON.stringify(input) }), "127.0.0.1");
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(";"); const index = pair!.indexOf("=");
      const key = pair!.slice(0, index); const value = pair!.slice(index + 1);
      if (value) cookies.set(key, value); else cookies.delete(key);
    }
    return response;
  };
  const challenge = async (email = "member@example.test", purpose = "registration", key = crypto.randomUUID()) => {
    await call("/platform/v1/auth/bootstrap");
    return call("/platform/v1/auth/challenges", "POST", { email, purpose, termsAccepted: true, termsVersion: "2026-09-12", name: "Member", returnTo: "/organizations" }, { "idempotency-key": key });
  };
  const token = () => /#token=(ac_[A-Za-z0-9_-]{43})/.exec(mail.at(-1)!.text)![1]!;
  const complete = (code?: string) => call("/platform/v1/auth/complete", "POST", { token: token(), code });
  const freshRequest = async (input: unknown = {}, overrides: Record<string, string> = {}) => {
    await call("/platform/v1/auth/bootstrap");
    return call("/platform/v1/account/fresh-auth/challenges", "POST", input, { "x-csrf-token": cookies.get("__Host-carbon-csrf") ?? "", ...overrides });
  };
  const freshComplete = (code?: string, overrides: Record<string, string> = {}) => call("/platform/v1/account/fresh-auth/complete", "POST", { token: token(), code }, { "x-csrf-token": cookies.get("__Host-carbon-csrf") ?? "", ...overrides });
  const security = async (command: unknown, overrides: Record<string, string> = {}) => {
    const current = await (await call("/platform/v1/account/session")).json() as { session: { account: { revision: string } } };
    return call("/platform/v1/account/security", "POST", command, { "if-match": `"${current.session.account.revision}"`, "x-csrf-token": cookies.get("__Host-carbon-csrf")!, ...overrides });
  };
  const profile = async (command: { kind: string; [key: string]: unknown }, overrides: Record<string, string> = {}) => {
    if (command.kind === "email-change") await call("/platform/v1/auth/bootstrap");
    const current = await (await call("/platform/v1/account/session")).json() as { session: { account: { revision: string } } };
    return call("/platform/v1/account/profile", "POST", command, { "if-match": current.session.account.revision, "x-csrf-token": cookies.get("__Host-carbon-csrf")!, ...overrides });
  };
  const emailToken = () => /#token=(ec_[A-Za-z0-9_-]{43})/.exec([...mail].reverse().find(m => m.text.includes("#token=ec_"))!.text)![1]!;
  const emailComplete = (code?: string, overrides: Record<string, string> = {}) => call("/platform/v1/account/email/complete", "POST", { token: emailToken(), code }, { "x-csrf-token": cookies.get("__Host-carbon-csrf")!, ...overrides });
  const createOrganization = (name: string, slug: string, overrides: Record<string, string> = {}) => call("/platform/v1/orgs", "POST", { name, slug }, { "x-csrf-token": cookies.get("__Host-carbon-csrf")!, ...overrides });
  const catalogCommand = (path: string, input: unknown, revision: string, overrides: Record<string, string> = {}) => call(path, 'POST', input, { 'if-match': revision, 'x-csrf-token': cookies.get('__Host-carbon-csrf')!, ...overrides });
  const createProject = async (org: string, name = 'App', slug = 'app', overrides: Record<string, string> = {}) => {
    const current = await (await call(`/platform/v1/orgs/${org}`)).json() as { organization: { revision: string } };
    return catalogCommand(`/platform/v1/orgs/${org}/projects`, { name, slug, services: ['database', 'registry'] }, current.organization.revision, overrides);
  };
  const organizationCommand = async (id: string, command: { kind: string; [key: string]: unknown }, overrides: Record<string, string> = {}) => {
    const current = await (await call(`/platform/v1/orgs/${id}`)).json() as { organization: { revision: string } };
    return call(`/platform/v1/orgs/${id}/${command.kind === "update" || command.kind === "policy" ? "settings" : "members"}`, "POST", command, { "if-match": current.organization.revision, "x-csrf-token": cookies.get("__Host-carbon-csrf")!, ...overrides });
  };
  const restoreCookies = (saved: ReadonlyMap<string, string>) => { cookies.clear(); for (const [key, value] of saved) cookies.set(key, value); };
  const invitation = async (orgId: string, command: unknown, overrides: Record<string, string> = {}) => {
    const { organization } = await (await call(`/platform/v1/orgs/${orgId}`)).json() as { organization: { revision: string } };
    return call(`/platform/v1/orgs/${orgId}/invitations`, "POST", command, { "if-match": organization.revision, "x-csrf-token": cookies.get("__Host-carbon-csrf")!, ...overrides });
  };
  const invitationToken = () => /#token=(inv_[A-Za-z0-9_-]{43})/.exec([...mail].reverse().find(m => m.text.includes("#token=inv_"))!.text)![1]!;
  const invitationProof = (proof: string, action = "accept", overrides: Record<string, string> = {}) => call(`/platform/v1/invitations/${action}`, "POST", { token: proof }, { "x-csrf-token": cookies.get("__Host-carbon-csrf")!, ...overrides });
  const githubStart = async (purpose = "registration", overrides: Record<string, string> = {}, extra: Record<string, unknown> = {}) => {
    await call("/platform/v1/auth/bootstrap");
    return call("/platform/v1/auth/github/start", "POST", { purpose, ...(purpose === 'registration' ? { termsAccepted: true, termsVersion: config.termsVersion } : {}), ...extra }, { "x-csrf-token": cookies.get("__Host-carbon-csrf") ?? "", ...overrides });
  };
  const githubCallback = (state: string, code: string | null = "fixture-code", overrides: Record<string, string> = {}) => call(`/platform/v1/auth/github/callback?state=${encodeURIComponent(state)}&${code === null ? 'error=access_denied' : 'code=' + encodeURIComponent(code)}`, "GET", undefined, { origin: "https://github.com", "sec-fetch-site": "cross-site", ...overrides });
  const githubComplete = (token: string, code?: string, overrides: Record<string, string> = {}) => call("/platform/v1/auth/github/complete", "POST", { token, code }, { "x-csrf-token": cookies.get("__Host-carbon-csrf") ?? "", ...overrides });
  const githubBegin = async (purpose = 'registration', extra: Record<string, unknown> = {}) => {
    const response = await githubStart(purpose, {}, extra); expect(response.status).toBe(200);
    const body = parseComponent("GithubAuthStartResponse", await response.json()); const url = new URL(body.authorizationUrl);
    const redirected = await githubCallback(url.searchParams.get('state')!); expect(redirected.status).toBe(303);
    return redirected.headers.get('location')!.split('#token=')[1]!;
  };
  return { sql, protector, secretProtector, workerApi, leases, organizationLifecycle, catalogLifecycle, app, idp, deliverApp, assertionPublicKey:assertionKeys.publicKey, assertionKey, mail, cookies, call, challenge, complete, token, freshRequest, freshComplete, profile, emailToken, emailComplete, createOrganization, organizationCommand, restoreCookies,
    catalogCommand, createProject,
    invitation, invitationToken, invitationProof,
    githubStart, githubCallback, githubComplete, githubBegin, githubCalls,
    repositoryStats: () => ({ refreshes: repositoryRefreshes, resolutions: repositoryResolutions, proposals: repositoryProposals }), setRepositoryAvailable: (value:boolean) => { repositoryAvailable=value; },
    expireGithub: () => new PostgresExternalAccountRepository(sql, mfa).expire(),
    setGithubAccount: (id: number, email: string, aliases: string[] = []) => { githubAccount = { id, email, aliases }; }, failGithub: (value: boolean) => { githubFailure = value; },
    security, advance: (seconds: number) => { now += seconds * 1000; },
    code: (secret: string) => totp.code(secret, Math.floor(now / 30000)),
    deliver: () => worker.execute(),
    failProvider: (value: boolean) => { failProvider = value; },
    restart: () => { auth = makeAuth(); handler = makeHandler(auth); worker = makeWorker(); },
  };
}

async function invitationResponse(response: Promise<Response> | Response) {
  const body = await (await response).json() as { receipt: unknown };
  return { receipt: parseComponent("InvitationReceipt", body.receipt) };
}
async function organizationResponse(response: Promise<Response>) {
  const body = await (await response).json() as { receipt: unknown };
  return { receipt: parseComponent("OrganizationReceipt", body.receipt) };
}
async function invitationPage(response: Promise<Response>) { return parseComponent("InvitationsPage", await (await response).json()); }
async function securityResponse(response: Promise<Response>) { return parseComponent("AccountSecurityResponse", await (await response).json()); }
async function credentialRejection(promise: Promise<unknown>, message: string) {
  let failure: unknown;
  try { await promise; } catch (error) { failure = error; }
  expect(String(failure)).toContain(message);
}

suite("real account authentication", () => {
  test('service accounts issue distinct credentials once, enforce exact authority, rotate, disable, and revoke',async()=>{
    const h=await harness();await h.challenge();await h.deliver();await h.complete();const orgId=(await organizationResponse(h.createOrganization('Automation team','automation-team'))).receipt.id;const project=parseComponent('CatalogReceipt',(await (await h.createProject(orgId)).json() as {receipt:unknown}).receipt);const environmentResponse=await h.catalogCommand(`/platform/v1/orgs/${orgId}/projects/${project.scope.projectId}/environments`,{name:'Automation',kind:'development',services:['database','registry']},project.revision);const environment=parseComponent('CatalogReceipt',(await environmentResponse.json() as {receipt:unknown}).receipt);const scope={orgId,projectId:project.scope.projectId!,environmentId:environment.scope.environmentId!};const csrf=()=>h.cookies.get('__Host-carbon-csrf')!;
    const createKey=crypto.randomUUID();const createdResponse=await h.call(`/platform/v1/orgs/${orgId}/service-accounts`,'POST',{name:'Release automation',scope,permissions:['metadata.read','data.read']},{'if-match':environment.revision,'idempotency-key':createKey,'x-csrf-token':csrf()});expect(createdResponse.status).toBe(201);const created=parseComponent('ServiceAccountReceipt',await createdResponse.json());expect(created.serviceAccount.audience).toBe('automation');expect(created.serviceAccount.scope).toEqual(scope);
    await h.sql`INSERT INTO service_accounts(id,org_id,name,state) VALUES (${crypto.randomUUID()},${orgId},'Legacy broad token','active')`;const accounts=parseComponent('ServiceAccountPage',await (await h.call(`/platform/v1/orgs/${orgId}/service-accounts`)).json());expect(accounts.items).toHaveLength(1);expect(JSON.stringify(accounts)).not.toContain('token_hash');
    const expiresAt=new Date(Date.now()+30*86400_000).toISOString();const issueKey=crypto.randomUUID();const issueHeaders={'if-match':created.serviceAccount.revision,'idempotency-key':issueKey,'x-csrf-token':csrf()};const issueResponse=await h.call(`/platform/v1/orgs/${orgId}/service-accounts/${created.serviceAccount.id}/credentials`,'POST',{name:'CI credential',expiresAt},issueHeaders);expect(issueResponse.status).toBe(201);const issued=parseComponent('ServiceAccountCredentialIssue',await issueResponse.json());expect(issued.token).toMatch(/^cs_[A-Za-z0-9_-]{43}$/);expect((await h.call(`/platform/v1/orgs/${orgId}/service-accounts/${created.serviceAccount.id}/credentials`,'POST',{name:'CI credential',expiresAt},issueHeaders)).status).toBe(409);
    const stored=(await h.sql`SELECT c.token_hash,c.token_prefix,s.permissions FROM service_account_credentials c JOIN service_accounts s ON s.id=c.service_account_id WHERE c.id=${issued.credential.id}`)[0];expect(stored.token_hash).toBe(tokenDigest(issued.token));expect(JSON.stringify(stored)).not.toContain(issued.token);const verifier=new ServiceAccountAuthentication(new PostgresServiceAccountRepository(h.sql));expect((await verifier.verify(issued.token,scope,'metadata.read')).principalId).toBe(created.serviceAccount.id);await credentialRejection(verifier.verify(issued.token,{...scope,projectId:crypto.randomUUID()},'metadata.read'),'invalid');await credentialRejection(verifier.verify(issued.token,scope,'data.write'),'invalid');
    const rotateKey=crypto.randomUUID();const rotated=parseComponent('ServiceAccountCredentialIssue',await (await h.call(`/platform/v1/orgs/${orgId}/service-accounts/${created.serviceAccount.id}/credentials/${issued.credential.id}`,'POST',{kind:'rotate',expiresAt,overlapSeconds:60},{'if-match':issued.credential.revision,'idempotency-key':rotateKey,'x-csrf-token':csrf()})).json());expect(rotated.token).not.toBe(issued.token);expect((await verifier.verify(issued.token,scope,'data.read')).credentialId).toBe(issued.credential.id);expect((await verifier.verify(rotated.token,scope,'data.read')).credentialId).toBe(issued.credential.id);
    const binding=(await h.sql`UPDATE service_bindings SET state='ready',remote_resource_id='service-account-test' WHERE environment_id=${scope.environmentId} AND owner='database' RETURNING id`)[0];const dataBody=JSON.stringify({scope,bindingId:binding.id,command:{kind:'tables.list',limit:25}});const boundRequest={method:'POST' as const,path:dataRequestPath(scope,binding.id,'tables.list'),bodyDigest:bodyDigest(dataBody)};const exchangeInput={audience:'carbon-database' as const,scope,permission:'metadata.read' as const,request:boundRequest};expect((await h.call('/platform/v1/service-assertions','POST',exchangeInput)).status).toBe(401);expect((await h.call('/platform/v1/service-assertions','POST',exchangeInput,{authorization:`Bearer ${rotated.token}`,origin:'https://attacker.test'})).status).toBe(403);const exchanged=parseComponent('ServiceAccountAssertionResponse',await (await h.call('/platform/v1/service-assertions','POST',exchangeInput,{authorization:`Bearer ${rotated.token}`})).json());expect(exchanged.expiresInSeconds).toBe(60);const assertionVerifier=new ServiceAssertionVerifier(origin,'carbon-database',[{...h.assertionKey,key:h.assertionPublicKey}],{isCurrent:async()=>true,consume:async()=>true});const assertion=await assertionVerifier.verify(exchanged.token,{scope,permission:'metadata.read',...boundRequest,principalKinds:['service_account']});expect(assertion.principal).toEqual({id:created.serviceAccount.id,kind:'service_account',audience:'automation',credentialId:issued.credential.id,permissionRevision:created.serviceAccount.permissionRevision});const liveAuthority=new PostgresServiceAuthority(h.sql);expect(await liveAuthority.isCurrent(assertion)).toBe(true);
    // Registry exchange is a separate contract and audience; neither exchange can mint the other's assertion.
    const registryBinding=(await h.sql`UPDATE service_bindings SET state='ready',remote_resource_id='service-account-registry-test' WHERE environment_id=${scope.environmentId} AND owner='registry' RETURNING id`)[0];const registryBound={method:'POST' as const,path:registryRequestPath(scope,registryBinding.id,'namespace.get'),bodyDigest:bodyDigest(canonicalRegistryRequest({scope:scope,bindingId:registryBinding.id,command:{kind:'namespace.get'}}))};const registryExchange={audience:'carbon-registry' as const,scope:scope,permission:'metadata.read' as const,request:registryBound};const bearer={authorization:`Bearer ${rotated.token}`};
    expect((await h.call('/platform/v1/service-assertions','POST',registryExchange,bearer)).status).toBe(400);expect((await h.call('/platform/v1/service-registry-assertions','POST',exchangeInput,bearer)).status).toBe(400);expect((await h.call('/platform/v1/service-registry-assertions','POST',{...registryExchange,request:boundRequest},bearer)).status).toBe(400);expect((await h.call('/platform/v1/service-assertions','POST',{...exchangeInput,request:registryBound},bearer)).status).toBe(200);expect((await h.call('/platform/v1/service-registry-assertions','POST',registryExchange)).status).toBe(401);expect((await h.call('/platform/v1/service-registry-assertions','POST',registryExchange,{...bearer,origin:'https://attacker.test'})).status).toBe(403);
    const registryExchanged=parseComponent('ServiceAccountAssertionResponse',await (await h.call('/platform/v1/service-registry-assertions','POST',registryExchange,bearer)).json());const registryVerifier=new ServiceAssertionVerifier(origin,'carbon-registry',[{...h.assertionKey,key:h.assertionPublicKey}],{isCurrent:async()=>true,consume:async()=>true});const registryAssertion=await registryVerifier.verify(registryExchanged.token,{scope:scope,permission:'metadata.read',...registryBound,principalKinds:['service_account']});expect(registryAssertion.aud).toBe('carbon-registry');expect(registryAssertion.principal).toEqual(assertion.principal);expect(registryAssertion.roles).toEqual([]);expect(await liveAuthority.isCurrent(registryAssertion)).toBe(true);
    await expect(assertionVerifier.verify(registryExchanged.token,{scope:scope,permission:'metadata.read',...registryBound,principalKinds:['service_account']})).rejects.toThrow('Invalid service assertion');await expect(registryVerifier.verify(exchanged.token,{scope:scope,permission:'metadata.read',...boundRequest,principalKinds:['service_account']})).rejects.toThrow('Invalid service assertion');expect(await liveAuthority.isCurrent({...registryAssertion,aud:'carbon-database'})).toBe(false);expect(await liveAuthority.isCurrent({...assertion,aud:'carbon-registry'})).toBe(false);expect(await liveAuthority.isCurrent({...registryAssertion,request:{...registryBound,path:registryRequestPath(scope,binding.id,'namespace.get')}})).toBe(false);expect(await liveAuthority.isCurrent({...assertion,request:{...boundRequest,path:dataRequestPath(scope,registryBinding.id,'tables.list')}})).toBe(false);
    const disabled=parseComponent('ServiceAccountReceipt',await (await h.call(`/platform/v1/orgs/${orgId}/service-accounts/${created.serviceAccount.id}`,'POST',{kind:'disable'},{'if-match':created.serviceAccount.revision,'x-csrf-token':csrf()})).json());expect(disabled.serviceAccount.status).toBe('disabled');expect(await liveAuthority.isCurrent(assertion)).toBe(false);expect(await liveAuthority.isCurrent(registryAssertion)).toBe(false);expect((await h.call('/platform/v1/service-registry-assertions','POST',registryExchange,bearer)).status).toBe(401);await credentialRejection(verifier.verify(rotated.token,scope,'metadata.read'),'invalid');expect((await h.call('/platform/v1/service-assertions','POST',exchangeInput,{authorization:`Bearer ${rotated.token}`})).status).toBe(401);const enabled=parseComponent('ServiceAccountReceipt',await (await h.call(`/platform/v1/orgs/${orgId}/service-accounts/${created.serviceAccount.id}`,'POST',{kind:'enable'},{'if-match':disabled.serviceAccount.revision,'x-csrf-token':csrf()})).json());expect(enabled.serviceAccount.status).toBe('active');await credentialRejection(verifier.verify(rotated.token,scope,'metadata.read'),'invalid');
    const refreshed=parseComponent('ServiceAccountCredentialIssue',await (await h.call(`/platform/v1/orgs/${orgId}/service-accounts/${created.serviceAccount.id}/credentials/${issued.credential.id}`,'POST',{kind:'rotate',expiresAt,overlapSeconds:60},{'if-match':rotated.credential.revision,'x-csrf-token':csrf()})).json());expect((await verifier.verify(refreshed.token,scope,'metadata.read')).permissionRevision).toBe(enabled.serviceAccount.permissionRevision);h.restart();const credentials=parseComponent('ServiceAccountCredentialPage',await (await h.call(`/platform/v1/orgs/${orgId}/service-accounts/${created.serviceAccount.id}/credentials`)).json());expect(credentials.items).toHaveLength(1);expect(JSON.stringify(credentials)).not.toContain(refreshed.token);
    const revokeHeaders={'if-match':refreshed.credential.revision,'idempotency-key':crypto.randomUUID(),'x-csrf-token':csrf()};const revoked=parseComponent('ServiceAccountCredentialReceipt',await (await h.call(`/platform/v1/orgs/${orgId}/service-accounts/${created.serviceAccount.id}/credentials/${issued.credential.id}`,'POST',{kind:'revoke'},revokeHeaders)).json());expect(revoked.credential.status).toBe('revoked');expect(parseComponent('ServiceAccountCredentialReceipt',await (await h.call(`/platform/v1/orgs/${orgId}/service-accounts/${created.serviceAccount.id}/credentials/${issued.credential.id}`,'POST',{kind:'revoke'},revokeHeaders)).json())).toEqual(revoked);await credentialRejection(verifier.verify(refreshed.token,scope,'metadata.read'),'invalid');const durable=JSON.stringify({events:await h.sql`SELECT * FROM service_account_events WHERE service_account_id=${created.serviceAccount.id}`,commands:await h.sql`SELECT * FROM service_account_commands WHERE scope_key LIKE ${`service-account%${created.serviceAccount.id}%`}`});expect(durable).not.toContain(refreshed.token);expect(durable).not.toContain(tokenDigest(refreshed.token));
  });

  test('personal credentials disclose once, store only a hash, stay inside exact delegated authority, rotate and revoke', async () => {
    const h = await harness(); await h.challenge(); await h.deliver(); await h.complete();
    const orgId = (await organizationResponse(h.createOrganization('Personal team', 'personal-team'))).receipt.id;
    const project = parseComponent('CatalogReceipt', (await (await h.createProject(orgId)).json() as { receipt: unknown }).receipt);
    const scope = parseComponent('EnvironmentScope', project.scope);
    const csrf = () => h.cookies.get('__Host-carbon-csrf')!; const path = '/platform/v1/account/personal-credentials';
    const expiresAt = new Date(Date.now() + 30 * 86400_000).toISOString();
    const input = { name: 'Laptop', scope, permissions: ['data.read', 'metadata.read'], expiresAt };
    const create = (value: unknown, overrides: Record<string, string> = {}) => h.call(path, 'POST', value, { 'x-csrf-token': csrf(), ...overrides });

    expect((await h.call(path, 'POST', input)).status).toBe(403);
    expect((await create({ ...input, expiresAt: new Date(Date.now() + 91 * 86400_000).toISOString() })).status).toBe(400);
    expect((await create({ ...input, expiresAt: new Date(Date.now() - 1000).toISOString() })).status).toBe(400);
    expect((await create({ ...input, permissions: ['organization.manage'] })).status).toBe(400);
    expect((await create({ ...input, scope: { orgId, projectId: crypto.randomUUID() } })).status).toBe(404);
    expect(await h.sql`SELECT id FROM personal_credentials`).toHaveLength(0);

    const key = crypto.randomUUID(); const createdResponse = await create(input, { 'idempotency-key': key }); expect(createdResponse.status).toBe(201);
    const issued = parseComponent('PersonalCredentialIssue', await createdResponse.json());
    expect(issued.token).toMatch(/^pt_[A-Za-z0-9_-]{43}$/); expect(issued.credential.prefix).toBe(issued.token.slice(0, 11)); expect(issued.credential.scope).toEqual(scope);
    // A retry never discloses the token again, and an active name is unique per account.
    expect((await create(input, { 'idempotency-key': key })).status).toBe(409);
    expect((await create(input)).status).toBe(409);
    const stored = (await h.sql`SELECT token_hash, token_prefix FROM personal_credentials WHERE id = ${issued.credential.id}`)[0];
    expect(stored.token_hash).toBe(tokenDigest(issued.token)); expect(JSON.stringify(stored)).not.toContain(issued.token);
    let page = parseComponent('PersonalCredentialPage', await (await h.call(path)).json());
    expect(page.items).toHaveLength(1); expect(JSON.stringify(page)).not.toContain(issued.token); expect(JSON.stringify(page)).not.toContain(stored.token_hash);

    const verifier = new PersonalCredentialAuthentication(h.sql);
    const principal = await verifier.verify(issued.token, scope, 'data.read'); expect(principal.credentialId).toBe(issued.credential.id);
    await credentialRejection(verifier.verify(issued.token, scope, 'data.write'), 'invalid');
    await credentialRejection(verifier.verify(issued.token, { orgId, projectId: scope.projectId }, 'data.read'), 'invalid');
    await credentialRejection(verifier.verify(issued.token, { ...scope, environmentId: crypto.randomUUID() }, 'data.read'), 'invalid');
    await credentialRejection(verifier.verify(issued.token.slice(0, -1) + (issued.token.endsWith('A') ? 'B' : 'A'), scope, 'data.read'), 'invalid');
    // Any change to the owner's permissions suspends the credential until it is rotated under current authority.
    await h.sql`UPDATE accounts SET permission_revision = permission_revision + 1 WHERE id = ${principal.accountId}`;
    await credentialRejection(verifier.verify(issued.token, scope, 'data.read'), 'invalid');
    await h.sql`UPDATE accounts SET permission_revision = permission_revision - 1 WHERE id = ${principal.accountId}`;
    await h.sql`UPDATE personal_credentials SET expires_at = now() - interval '1 second' WHERE id = ${issued.credential.id}`;
    await credentialRejection(verifier.verify(issued.token, scope, 'data.read'), 'invalid');
    page = parseComponent('PersonalCredentialPage', await (await h.call(path)).json()); expect(page.items[0]!.status).toBe('expired');

    const rotateHeaders = { 'if-match': issued.credential.revision, 'x-csrf-token': csrf(), 'idempotency-key': crypto.randomUUID() };
    expect((await h.call(`${path}/${issued.credential.id}`, 'POST', { kind: 'rotate', expiresAt }, { ...rotateHeaders, 'if-match': '99', 'idempotency-key': crypto.randomUUID() })).status).toBe(409);
    const rotatedResponse = await h.call(`${path}/${issued.credential.id}`, 'POST', { kind: 'rotate', expiresAt }, rotateHeaders); expect(rotatedResponse.status).toBe(200);
    const rotated = parseComponent('PersonalCredentialIssue', await rotatedResponse.json());
    expect(rotated.token).not.toBe(issued.token); expect(rotated.credential.id).toBe(issued.credential.id); expect(rotated.credential.status).toBe('active');
    expect((await h.call(`${path}/${issued.credential.id}`, 'POST', { kind: 'rotate', expiresAt }, rotateHeaders)).status).toBe(409);
    await credentialRejection(verifier.verify(issued.token, scope, 'data.read'), 'invalid');
    expect((await verifier.verify(rotated.token, scope, 'metadata.read')).credentialId).toBe(issued.credential.id);

    h.restart();
    const revokeHeaders = { 'if-match': rotated.credential.revision, 'x-csrf-token': csrf(), 'idempotency-key': crypto.randomUUID() };
    const revoked = parseComponent('PersonalCredentialReceipt', await (await h.call(`${path}/${issued.credential.id}`, 'POST', { kind: 'revoke' }, revokeHeaders)).json());
    expect(revoked.credential.status).toBe('revoked');
    expect(parseComponent('PersonalCredentialReceipt', await (await h.call(`${path}/${issued.credential.id}`, 'POST', { kind: 'revoke' }, revokeHeaders)).json())).toEqual(revoked);
    expect((await h.sql`SELECT token_hash FROM personal_credentials WHERE id = ${issued.credential.id}`)[0].token_hash).toBeNull();
    await credentialRejection(verifier.verify(rotated.token, scope, 'metadata.read'), 'invalid');
    expect((await h.call(`${path}/${issued.credential.id}`, 'POST', { kind: 'rotate', expiresAt }, { 'if-match': revoked.credential.revision, 'x-csrf-token': csrf() })).status).toBe(409);
    // The name is free again once the credential is revoked.
    expect((await create(input)).status).toBe(201);
    const durable = JSON.stringify({ events: await h.sql`SELECT * FROM personal_credential_events`, commands: await h.sql`SELECT * FROM personal_credential_commands` });
    for (const secret of [issued.token, rotated.token, tokenDigest(issued.token), tokenDigest(rotated.token)]) expect(durable).not.toContain(secret);
    expect((await h.sql`SELECT action FROM personal_credential_events WHERE credential_id = ${issued.credential.id} ORDER BY sequence`).map((row: { action: string }) => row.action)).toEqual(['personal.created', 'personal.rotated', 'personal.revoked']);
  });

  test('personal credentials are invisible to other accounts and cannot exceed or outlive the access their owner holds', async () => {
    const h = await harness(); await h.challenge('owner@example.test'); await h.deliver(); await h.complete();
    const orgId = (await organizationResponse(h.createOrganization('Tenant one', 'tenant-one'))).receipt.id;
    const project = parseComponent('CatalogReceipt', (await (await h.createProject(orgId)).json() as { receipt: unknown }).receipt);
    const scope = parseComponent('EnvironmentScope', project.scope);
    const csrf = () => h.cookies.get('__Host-carbon-csrf')!; const path = '/platform/v1/account/personal-credentials';
    const expiresAt = new Date(Date.now() + 86400_000).toISOString();
    const create = (value: unknown) => h.call(path, 'POST', value, { 'x-csrf-token': csrf() });
    const issued = parseComponent('PersonalCredentialIssue', await (await create({ name: 'Owner laptop', scope, permissions: ['data.write'], expiresAt })).json());
    const ownerCookies = new Map(h.cookies);

    h.cookies.clear(); await h.challenge('other@example.test'); await h.deliver(); await h.complete();
    const otherOrg = (await organizationResponse(h.createOrganization('Tenant two', 'tenant-two'))).receipt.id;
    expect(parseComponent('PersonalCredentialPage', await (await h.call(path)).json()).items).toHaveLength(0);
    for (const command of [{ kind: 'revoke' }, { kind: 'rotate', expiresAt }]) {
      expect((await h.call(`${path}/${issued.credential.id}`, 'POST', command, { 'if-match': issued.credential.revision, 'x-csrf-token': csrf() })).status).toBe(404);
    }
    // Another tenant's scope is not discoverable, and a foreign project cannot be attached to your own organization.
    expect((await create({ name: 'Foreign', scope, permissions: ['metadata.read'], expiresAt })).status).toBe(404);
    expect((await create({ name: 'Mixed', scope: { orgId: otherOrg, projectId: scope.projectId }, permissions: ['metadata.read'], expiresAt })).status).toBe(404);
    expect(await h.sql`SELECT id FROM personal_credentials WHERE id <> ${issued.credential.id}`).toHaveLength(0);

    // As a Viewer of tenant one, the second account can delegate only what a Viewer holds.
    const other = (await h.sql`SELECT id FROM accounts WHERE primary_email = 'other@example.test'`)[0].id;
    await h.sql`INSERT INTO memberships (id, account_id, org_id, role, state) VALUES (${crypto.randomUUID()}, ${other}, ${orgId}, 'Viewer', 'active')`;
    await h.sql`UPDATE accounts SET permission_revision = permission_revision + 1 WHERE id = ${other}`;
    expect((await create({ name: 'Viewer write', scope: { orgId }, permissions: ['data.write'], expiresAt })).status).toBe(403);
    const viewerResponse = await create({ name: 'Viewer read', scope: { orgId }, permissions: ['metadata.read'], expiresAt }); expect(viewerResponse.status).toBe(201);
    const viewer = parseComponent('PersonalCredentialIssue', await viewerResponse.json());
    const verifier = new PersonalCredentialAuthentication(h.sql);
    expect((await verifier.verify(viewer.token, { orgId }, 'metadata.read')).accountId).toBe(other);
    await credentialRejection(verifier.verify(viewer.token, { orgId: otherOrg }, 'metadata.read'), 'invalid');
    await credentialRejection(verifier.verify(viewer.token, scope, 'metadata.read'), 'invalid');
    // Losing the membership ends the credential, and rotation cannot carry the lost access forward.
    await h.sql`UPDATE memberships SET state = 'revoked' WHERE account_id = ${other} AND org_id = ${orgId}`;
    await h.sql`UPDATE accounts SET permission_revision = permission_revision + 1 WHERE id = ${other}`;
    await credentialRejection(verifier.verify(viewer.token, { orgId }, 'metadata.read'), 'invalid');
    expect((await h.call(`${path}/${viewer.credential.id}`, 'POST', { kind: 'rotate', expiresAt }, { 'if-match': viewer.credential.revision, 'x-csrf-token': csrf() })).status).toBe(404);
    expect((await h.call(`${path}/${viewer.credential.id}`, 'POST', { kind: 'revoke' }, { 'if-match': viewer.credential.revision, 'x-csrf-token': csrf() })).status).toBe(200);

    h.restoreCookies(ownerCookies);
    expect((await verifier.verify(issued.token, scope, 'data.write')).credentialId).toBe(issued.credential.id);
    expect(parseComponent('PersonalCredentialPage', await (await h.call(path)).json()).items.map(item => item.id)).toEqual([issued.credential.id]);
    await h.sql`UPDATE organizations SET state = 'suspended' WHERE id = ${orgId}`;
    await credentialRejection(verifier.verify(issued.token, scope, 'data.write'), 'invalid');
  });

  test('legacy cc_ organizations are claimed by token possession only, then reviewed, retired and restored without losing the token', async () => {
    const h = await harness(); const identity = new PostgresIdentityRepository(h.sql); const verify = new VerifyTokenUseCase(identity);
    const legacy = await new CreateOrganizationUseCase(identity).execute('Legacy Co'); const worker = await new IssueWorkerTokenUseCase(identity).execute(legacy.orgId);
    const untouched = await new CreateOrganizationUseCase(identity).execute('Unclaimed Co');
    await h.challenge('owner@example.test'); await h.deliver(); await h.complete();
    const csrf = () => h.cookies.get('__Host-carbon-csrf')!; const tokens = `/platform/v1/orgs/${legacy.orgId}/legacy-tokens`;
    const claim = (credential: string, slug: string, overrides: Record<string, string> = {}) => h.call('/platform/v1/account/legacy-claims', 'POST', { credential, slug }, { 'x-csrf-token': csrf(), ...overrides });

    // Nothing is inferred before the claim: the organization has no members and is invisible.
    expect((await h.call(tokens)).status).toBe(404);
    expect((await h.call('/platform/v1/account/legacy-claims', 'POST', { credential: legacy.apiToken, slug: 'legacy-co' })).status).toBe(403);
    expect((await claim('cc_' + 'f'.repeat(32), 'legacy-co')).status).toBe(404);
    expect((await claim(worker.workerToken, 'legacy-co')).status).toBe(400);
    expect(await h.sql`SELECT id FROM memberships WHERE org_id = ${legacy.orgId}`).toHaveLength(0);

    const key = crypto.randomUUID(); const claimedResponse = await claim(legacy.apiToken, 'legacy-co', { 'idempotency-key': key }); expect(claimedResponse.status).toBe(200);
    const claimed = parseComponent('LegacyOrganizationClaimReceipt', await claimedResponse.json()); expect(claimed.organizationId).toBe(legacy.orgId);
    expect(parseComponent('LegacyOrganizationClaimReceipt', await (await claim(legacy.apiToken, 'legacy-co', { 'idempotency-key': key })).json())).toEqual(claimed);
    expect((await claim(legacy.apiToken, 'legacy-co-again')).status).toBe(409);
    expect((await h.sql`SELECT slug, human_managed FROM organizations WHERE id = ${legacy.orgId}`)[0]).toEqual({ slug: 'legacy-co', human_managed: true });
    expect((await h.sql`SELECT role, state FROM memberships WHERE org_id = ${legacy.orgId}`) as unknown[]).toEqual([{ role: 'Owner', state: 'active' }]);
    expect((await h.sql`SELECT human_managed FROM organizations WHERE id = ${untouched.orgId}`)[0].human_managed).toBe(false);
    const ownerCookies = new Map(h.cookies);

    // A second account holding the same token cannot take the organization or see its tokens.
    h.cookies.clear(); await h.challenge('other@example.test'); await h.deliver(); await h.complete();
    expect((await claim(legacy.apiToken, 'stolen-co')).status).toBe(409);
    expect((await h.call(tokens)).status).toBe(404);
    h.restoreCookies(ownerCookies);

    expect(await verify.execute(legacy.apiToken)).toEqual({ orgId: legacy.orgId, scope: 'org' });
    let page = parseComponent('LegacyTokenPage', await (await h.call(tokens)).json());
    expect(page.policy).toBe('accept'); expect(page.items.map(item => item.kind).sort()).toEqual(['org', 'worker']);
    const orgToken = page.items.find(item => item.kind === 'org')!; expect(orgToken.status).toBe('active'); expect(orgToken.lastUsedAt).not.toBeNull();
    expect(page.items.find(item => item.kind === 'worker')!.lastUsedAt).toBeNull();
    const hash = (await h.sql`SELECT token_hash FROM api_tokens WHERE id = ${orgToken.id}`)[0].token_hash;
    expect(JSON.stringify(page)).not.toContain(hash); expect(JSON.stringify(page)).not.toContain(legacy.apiToken);

    const command = (id: string, value: unknown, revision: string, overrides: Record<string, string> = {}) => h.call(`${tokens}/${id}`, 'POST', value, { 'if-match': revision, 'x-csrf-token': csrf(), ...overrides });
    expect((await command(orgToken.id, { kind: 'retire', replacedByServiceAccountId: crypto.randomUUID() }, orgToken.revision)).status).toBe(400);
    expect((await command(orgToken.id, { kind: 'retire' }, '99')).status).toBe(409);
    expect((await command(orgToken.id, { kind: 'restore' }, orgToken.revision)).status).toBe(409);
    const unclaimedToken = (await h.sql`SELECT id FROM api_tokens WHERE org_id = ${untouched.orgId}`)[0].id;
    expect((await command(unclaimedToken, { kind: 'retire' }, '1')).status).toBe(404);
    const retireKey = crypto.randomUUID(); const retiredResponse = await command(orgToken.id, { kind: 'retire' }, orgToken.revision, { 'idempotency-key': retireKey }); expect(retiredResponse.status).toBe(200);
    const retired = parseComponent('LegacyTokenReceipt', await retiredResponse.json()); expect(retired.legacyToken.status).toBe('retired'); expect(retired.legacyToken.retiredAt).not.toBeNull();
    expect(parseComponent('LegacyTokenReceipt', await (await command(orgToken.id, { kind: 'retire' }, orgToken.revision, { 'idempotency-key': retireKey })).json())).toEqual(retired);
    // Retirement stops authentication but keeps the hash, so the stage can be rolled back.
    expect(await verify.execute(legacy.apiToken)).toBeNull();
    expect(await verify.execute(worker.workerToken)).toEqual({ orgId: legacy.orgId, scope: 'worker' });
    expect(await verify.execute(untouched.apiToken)).toEqual({ orgId: untouched.orgId, scope: 'org' });
    expect((await h.sql`SELECT token_hash FROM api_tokens WHERE id = ${orgToken.id}`)[0].token_hash).toBe(hash);

    h.restart();
    const restored = parseComponent('LegacyTokenReceipt', await (await command(orgToken.id, { kind: 'restore' }, retired.legacyToken.revision)).json());
    expect(restored.legacyToken.status).toBe('active'); expect(restored.legacyToken.retiredAt).toBeNull();
    expect(await verify.execute(legacy.apiToken)).toEqual({ orgId: legacy.orgId, scope: 'org' });
    const durable = JSON.stringify({ events: await h.sql`SELECT * FROM legacy_token_events`, commands: await h.sql`SELECT * FROM legacy_token_commands` });
    expect(durable).not.toContain(legacy.apiToken); expect(durable).not.toContain(hash);
    expect((await h.sql`SELECT action FROM legacy_token_events ORDER BY sequence`).map((row: { action: string }) => row.action)).toEqual(['legacy.claimed', 'legacy.retired', 'legacy.restored']);
  });

  test('workers enroll once, are confined to their organization, and receive only their leased secrets exactly once', async () => {
    const h = await harness(); await h.challenge('owner@example.test'); await h.deliver(); await h.complete();
    const orgId = (await organizationResponse(h.createOrganization('Build team', 'build-team'))).receipt.id;
    const scope = parseComponent('EnvironmentScope', parseComponent('CatalogReceipt', (await (await h.createProject(orgId)).json() as { receipt: unknown }).receipt).scope);
    const csrf = () => h.cookies.get('__Host-carbon-csrf')!;
    const environmentPath = `/platform/v1/orgs/${scope.orgId}/projects/${scope.projectId}/environments/${scope.environmentId}`;
    const values = { DATABASE_URL: 'postgres://service:leased-password@example.test/db', API_KEY: 'unleased-api-key-value' };
    for (const [name, value] of Object.entries(values)) {
      const revision = parseComponent('CatalogEnvironmentDetails', await (await h.call(environmentPath)).json()).environment.revision;
      expect((await h.call(`${environmentPath}/secrets`, 'POST', { name, value }, { 'if-match': revision, 'x-csrf-token': csrf() })).status).toBe(201);
    }

    // Enrollment: a manager issues a one-time code; nothing but its hash is stored.
    const workersPath = `/platform/v1/orgs/${orgId}/workers`; const enrollment = { name: 'win-01', purposes: ['build'] };
    expect((await h.call(workersPath, 'POST', enrollment)).status).toBe(403);
    expect((await h.call(workersPath, 'POST', { ...enrollment, purposes: ['deploy'] }, { 'x-csrf-token': csrf() })).status).toBe(400);
    const key = crypto.randomUUID(); const issuedResponse = await h.call(workersPath, 'POST', enrollment, { 'x-csrf-token': csrf(), 'idempotency-key': key }); expect(issuedResponse.status).toBe(201);
    const issued = parseComponent('WorkerEnrollmentIssue', await issuedResponse.json()); expect(issued.worker.status).toBe('pending'); expect(issued.code).toMatch(/^we_[A-Za-z0-9_-]{43}$/);
    expect((await h.call(workersPath, 'POST', enrollment, { 'x-csrf-token': csrf(), 'idempotency-key': key })).status).toBe(409);
    expect((await h.call(workersPath, 'POST', enrollment, { 'x-csrf-token': csrf() })).status).toBe(409);
    const pending = (await h.sql`SELECT enrollment_hash, token_hash FROM workers WHERE id = ${issued.worker.id}`)[0];
    expect(pending).toEqual({ enrollment_hash: tokenDigest(issued.code), token_hash: null });
    let page = parseComponent('WorkerPage', await (await h.call(workersPath)).json()); expect(page.items).toHaveLength(1); expect(JSON.stringify(page)).not.toContain(issued.code);

    // The worker API takes worker credentials only: no browser, no session, no other credential type.
    const capabilities = { platform: 'windows' as const, arch: 'x64' as const, toolchains: ['bun@1.3.10'] };
    expect((await h.workerApi('/worker/v1/enroll', { code: issued.code, capabilities }, { origin })).status).toBe(403);
    expect((await h.workerApi('/worker/v1/enroll', { code: 'we_' + 'A'.repeat(43), capabilities })).status).toBe(401);
    expect((await h.workerApi('/worker/v1/leases/claim', undefined, { cookie: [...h.cookies].map(([name, value]) => `${name}=${value}`).join('; ') })).status).toBe(401);
    for (const prefix of ['dc', 'cs', 'pt', 'ce', 'wl']) expect((await h.workerApi('/worker/v1/leases/claim', undefined, { authorization: `Bearer ${prefix}_${'A'.repeat(43)}` })).status).toBe(401);
    const enrolledResponse = await h.workerApi('/worker/v1/enroll', { code: issued.code, capabilities }); expect(enrolledResponse.status).toBe(201);
    const enrolled = parseComponent('WorkerCredentialIssue', await enrolledResponse.json());
    expect(enrolled.token).toMatch(/^wc_[A-Za-z0-9_-]{43}$/); expect(enrolled.worker.status).toBe('active'); expect(enrolled.worker.capabilities).toEqual(capabilities);
    expect((await h.workerApi('/worker/v1/enroll', { code: issued.code, capabilities })).status).toBe(401);
    expect((await h.sql`SELECT enrollment_hash, token_hash FROM workers WHERE id = ${issued.worker.id}`)[0]).toEqual({ enrollment_hash: null, token_hash: tokenDigest(enrolled.token) });
    const bearer = { authorization: `Bearer ${enrolled.token}` };
    expect(parseComponent('WorkerLeaseOffer', await (await h.workerApi('/worker/v1/leases/claim', undefined, bearer)).json())).toEqual({ state: 'none' });

    // A second tenant's worker.
    const ownerCookies = new Map(h.cookies); h.cookies.clear(); await h.challenge('other@example.test'); await h.deliver(); await h.complete();
    const otherOrg = (await organizationResponse(h.createOrganization('Other team', 'other-team'))).receipt.id;
    expect((await h.call(workersPath)).status).toBe(404);
    expect((await h.call(`${workersPath}/${issued.worker.id}`, 'POST', { kind: 'revoke' }, { 'if-match': enrolled.worker.revision, 'x-csrf-token': csrf() })).status).toBe(404);
    const otherIssue = parseComponent('WorkerEnrollmentIssue', await (await h.call(`/platform/v1/orgs/${otherOrg}/workers`, 'POST', { name: 'foreign-01', purposes: ['build', 'function'] }, { 'x-csrf-token': csrf() })).json());
    const foreign = { authorization: `Bearer ${parseComponent('WorkerCredentialIssue', await (await h.workerApi('/worker/v1/enroll', { code: otherIssue.code, capabilities })).json()).token}` };
    h.restoreCookies(ownerCookies);

    // Leases come only from Cloud's own orchestration, and name exactly what a worker may read.
    await credentialRejection(h.leases.grant({ scope, purpose: 'build', subjectId: crypto.randomUUID(), secretNames: ['MISSING_SECRET'] }, crypto.randomUUID()), 'missing or disabled');
    await credentialRejection(h.leases.grant({ scope: { ...scope, environmentId: crypto.randomUUID() }, purpose: 'build', subjectId: crypto.randomUUID(), secretNames: [] }, crypto.randomUUID()), 'Environment not found');
    const subjectId = crypto.randomUUID(); const granted = await h.leases.grant({ scope, purpose: 'build', subjectId, secretNames: ['DATABASE_URL'] }, crypto.randomUUID());
    expect(granted.state).toBe('granted'); expect(granted.workerId).toBeNull();
    await credentialRejection(h.leases.grant({ scope, purpose: 'build', subjectId, secretNames: ['DATABASE_URL'] }, crypto.randomUUID()), 'already has a lease');
    const functionLease = await h.leases.grant({ scope, purpose: 'function', subjectId: crypto.randomUUID(), secretNames: ['API_KEY'] }, crypto.randomUUID());
    expect(parseComponent('WorkerLeaseOffer', await (await h.workerApi('/worker/v1/leases/claim', undefined, foreign)).json())).toEqual({ state: 'none' });
    const offer = parseComponent('WorkerLeaseOffer', await (await h.workerApi('/worker/v1/leases/claim', undefined, bearer)).json());
    if (offer.state !== 'leased') throw new Error('expected a lease');
    expect(offer.lease.id).toBe(granted.id); expect(offer.lease.state).toBe('claimed'); expect(offer.lease.workerId).toBe(issued.worker.id); expect(offer.lease.secretNames).toEqual(['DATABASE_URL']);
    expect(offer.leaseToken).toMatch(/^wl_[A-Za-z0-9_-]{43}$/);
    // The build-only worker is never offered the function lease.
    expect(parseComponent('WorkerLeaseOffer', await (await h.workerApi('/worker/v1/leases/claim', undefined, bearer)).json())).toEqual({ state: 'none' });
    expect((await h.sql`SELECT state FROM worker_leases WHERE id = ${functionLease.id}`)[0].state).toBe('granted');

    const secretsPath = `/worker/v1/leases/${granted.id}/secrets`; const leased = { ...bearer, 'x-carbon-lease-token': offer.leaseToken };
    expect((await h.workerApi(secretsPath, undefined, bearer)).status).toBe(401);
    expect((await h.workerApi(secretsPath, undefined, { ...bearer, 'x-carbon-lease-token': 'wl_' + 'A'.repeat(43) })).status).toBe(409);
    expect((await h.workerApi(secretsPath, undefined, { ...foreign, 'x-carbon-lease-token': offer.leaseToken })).status).toBe(404);
    expect((await h.workerApi(secretsPath, undefined, { 'x-carbon-lease-token': offer.leaseToken })).status).toBe(401);
    expect((await h.sql`SELECT materialized_at FROM worker_leases WHERE id = ${granted.id}`)[0].materialized_at).toBeNull();
    const deliveredResponse = await h.workerApi(secretsPath, undefined, leased); expect(deliveredResponse.status).toBe(200); expect(deliveredResponse.headers.get('cache-control')).toBe('no-store');
    const delivered = parseComponent('WorkerSecretBindings', await deliveredResponse.json());
    expect(delivered.bindings).toEqual([{ name: 'DATABASE_URL', version: 1, value: values.DATABASE_URL }]); expect(JSON.stringify(delivered)).not.toContain(values.API_KEY);
    // Delivery is single use.
    expect((await h.workerApi(secretsPath, undefined, leased)).status).toBe(409);

    const beat = parseComponent('WorkerLeaseReceipt', await (await h.workerApi(`/worker/v1/leases/${granted.id}`, { kind: 'heartbeat' }, leased)).json()); expect(beat.cancelled).toBe(false);
    expect((await h.workerApi(`/worker/v1/leases/${granted.id}`, { kind: 'heartbeat' }, { ...foreign, 'x-carbon-lease-token': offer.leaseToken })).status).toBe(404);
    const done = parseComponent('WorkerLeaseReceipt', await (await h.workerApi(`/worker/v1/leases/${granted.id}`, { kind: 'complete' }, leased)).json()); expect(done.lease.state).toBe('completed');
    for (const attempt of [h.workerApi(secretsPath, undefined, leased), h.workerApi(`/worker/v1/leases/${granted.id}`, { kind: 'heartbeat' }, leased), h.workerApi(`/worker/v1/leases/${granted.id}`, { kind: 'complete' }, leased)]) expect((await attempt).status).toBe(409);
    expect((await h.sql`SELECT lease_token_hash FROM worker_leases WHERE id = ${granted.id}`)[0].lease_token_hash).toBeNull();

    // No account route returns a value, and durable records hold names and versions only.
    const account = JSON.stringify([await (await h.call(`${environmentPath}/secrets`)).json(), await (await h.call(workersPath)).json()]);
    const durable = JSON.stringify({ events: await h.sql`SELECT * FROM worker_events`, leases: await h.sql`SELECT * FROM worker_leases`, workers: await h.sql`SELECT * FROM workers`, commands: await h.sql`SELECT * FROM worker_commands` });
    for (const secret of [values.DATABASE_URL, values.API_KEY, enrolled.token, issued.code, offer.leaseToken]) { expect(account).not.toContain(secret); expect(durable).not.toContain(secret); }
    expect((await h.sql`SELECT metadata FROM worker_events WHERE action = 'lease.secrets_materialized'`).map((row: { metadata: unknown }) => row.metadata)).toEqual([{ secrets: [{ name: 'DATABASE_URL', version: 1 }] }]);
  });

  test('leases fail closed on cancellation, expiry, worker loss, secret changes, custody failure, rotation and revocation', async () => {
    const h = await harness(); await h.challenge(); await h.deliver(); await h.complete();
    const orgId = (await organizationResponse(h.createOrganization('Lease team', 'lease-team'))).receipt.id;
    const scope = parseComponent('EnvironmentScope', parseComponent('CatalogReceipt', (await (await h.createProject(orgId)).json() as { receipt: unknown }).receipt).scope);
    const csrf = () => h.cookies.get('__Host-carbon-csrf')!;
    const environmentPath = `/platform/v1/orgs/${scope.orgId}/projects/${scope.projectId}/environments/${scope.environmentId}`;
    const revision = parseComponent('CatalogEnvironmentDetails', await (await h.call(environmentPath)).json()).environment.revision;
    const secret = parseComponent('EnvironmentSecretReceipt', await (await h.call(`${environmentPath}/secrets`, 'POST', { name: 'SIGNING_KEY', value: 'first-signing-value' }, { 'if-match': revision, 'x-csrf-token': csrf() })).json()).secret;
    const workersPath = `/platform/v1/orgs/${orgId}/workers`; const capabilities = { platform: 'windows', arch: 'x64', toolchains: [] };
    const enrollment = parseComponent('WorkerEnrollmentIssue', await (await h.call(workersPath, 'POST', { name: 'win-01', purposes: ['build'] }, { 'x-csrf-token': csrf() })).json());
    let credential = parseComponent('WorkerCredentialIssue', await (await h.workerApi('/worker/v1/enroll', { code: enrollment.code, capabilities })).json());
    const bearer = () => ({ authorization: `Bearer ${credential.token}` });
    const grant = (overrides: Record<string, unknown> = {}) => h.leases.grant({ scope, purpose: 'build', subjectId: crypto.randomUUID(), secretNames: ['SIGNING_KEY'], ...overrides }, crypto.randomUUID());
    const claim = async () => { const offer = parseComponent('WorkerLeaseOffer', await (await h.workerApi('/worker/v1/leases/claim', undefined, bearer())).json()); if (offer.state !== 'leased') throw new Error('expected a lease'); return offer; };
    const held = (offer: { leaseToken: string }) => ({ ...bearer(), 'x-carbon-lease-token': offer.leaseToken });
    const state = async (id: string) => (await h.sql`SELECT state FROM worker_leases WHERE id = ${id}`)[0].state;

    // Platform requirements are honored.
    const linuxOnly = await grant({ requiredPlatform: 'linux' });
    expect(parseComponent('WorkerLeaseOffer', await (await h.workerApi('/worker/v1/leases/claim', undefined, bearer())).json())).toEqual({ state: 'none' });
    await h.leases.cancel(linuxOnly.subjectId, crypto.randomUUID());

    // Cancellation: the worker is told, and the lease can neither deliver secrets nor succeed.
    const cancelled = await grant(); let offer = await claim(); expect(offer.lease.id).toBe(cancelled.id);
    expect((await h.leases.cancel(cancelled.subjectId, crypto.randomUUID())).map(item => item.state)).toEqual(['cancelled']);
    expect(parseComponent('WorkerLeaseReceipt', await (await h.workerApi(`/worker/v1/leases/${cancelled.id}`, { kind: 'heartbeat' }, held(offer))).json()).cancelled).toBe(true);
    expect((await h.workerApi(`/worker/v1/leases/${cancelled.id}/secrets`, undefined, held(offer))).status).toBe(409);
    expect((await h.workerApi(`/worker/v1/leases/${cancelled.id}`, { kind: 'complete' }, held(offer))).status).toBe(409);
    expect(await state(cancelled.id)).toBe('cancelled');

    // Worker loss: an overdue lease is dead even to its own token, and the work is re-offered as a new attempt.
    const lost = await grant(); offer = await claim(); expect(offer.lease.attempt).toBe(1);
    await h.sql`UPDATE worker_leases SET expires_at = now() - interval '1 second' WHERE id = ${lost.id}`;
    expect((await h.workerApi(`/worker/v1/leases/${lost.id}/secrets`, undefined, held(offer))).status).toBe(409);
    expect(await state(lost.id)).toBe('expired');
    expect((await h.workerApi(`/worker/v1/leases/${lost.id}`, { kind: 'heartbeat' }, held(offer))).status).toBe(409);
    const second = await claim(); expect(second.lease.subjectId).toBe(lost.subjectId); expect(second.lease.attempt).toBe(2); expect(second.lease.id).not.toBe(lost.id); expect(second.leaseToken).not.toBe(offer.leaseToken);
    expect((await h.workerApi(`/worker/v1/leases/${second.lease.id}/secrets`, undefined, { ...bearer(), 'x-carbon-lease-token': offer.leaseToken })).status).toBe(409);
    // The sweeper does the same for a worker that simply went silent, up to the attempt limit.
    await h.sql`UPDATE worker_leases SET expires_at = now() - interval '1 second' WHERE id = ${second.lease.id}`;
    const successors = await h.leases.reclaim(crypto.randomUUID()); expect(successors.map(item => [item.subjectId, item.attempt, item.state])).toEqual([[lost.subjectId, 3, 'granted']]);
    const third = await claim(); expect(third.lease.attempt).toBe(3);
    await h.sql`UPDATE worker_leases SET expires_at = now() - interval '1 second' WHERE id = ${third.lease.id}`;
    expect(await h.leases.reclaim(crypto.randomUUID())).toEqual([]); expect(await state(third.lease.id)).toBe('expired');
    expect(await h.sql`SELECT id FROM worker_leases WHERE subject_id = ${lost.subjectId}`).toHaveLength(3);
    // An offer nobody claimed lapses without a retry.
    const unclaimed = await grant({ claimSeconds: 1 }); await h.sql`UPDATE worker_leases SET expires_at = now() - interval '1 second' WHERE id = ${unclaimed.id}`;
    expect(await h.leases.reclaim(crypto.randomUUID())).toEqual([]); expect(await state(unclaimed.id)).toBe('expired');
    expect(parseComponent('WorkerLeaseOffer', await (await h.workerApi('/worker/v1/leases/claim', undefined, bearer())).json())).toEqual({ state: 'none' });

    // Custody failure delivers nothing and leaves the lease deliverable once custody recovers.
    const guarded = await grant(); offer = await claim(); const path = `/worker/v1/leases/${guarded.id}/secrets`;
    const wrongCustody = createWorkerRoutes(new WorkerProtocol(new PostgresWorkerRepository(h.sql, new EnvelopeSecretProtector(new LocalAesSecretKeyCustodian('secret-test-key', { 'secret-test-key': randomBytes(32).toString('base64') })))), origin);
    const refused = await wrongCustody(new Request(origin + path, { method: 'POST', headers: held(offer) })); expect(refused.status).toBe(503); expect(await refused.text()).not.toContain('first-signing-value');
    expect((await h.sql`SELECT materialized_at FROM worker_leases WHERE id = ${guarded.id}`)[0].materialized_at).toBeNull();
    // A secret disabled after the grant is not delivered; the current version is delivered after rotation.
    const disabled = parseComponent('EnvironmentSecretReceipt', await (await h.call(`${environmentPath}/secrets/${secret.id}`, 'POST', { kind: 'disable', disabled: true }, { 'if-match': secret.revision, 'x-csrf-token': csrf() })).json()).secret;
    expect((await h.workerApi(path, undefined, held(offer))).status).toBe(409);
    const enabled = parseComponent('EnvironmentSecretReceipt', await (await h.call(`${environmentPath}/secrets/${secret.id}`, 'POST', { kind: 'disable', disabled: false }, { 'if-match': disabled.revision, 'x-csrf-token': csrf() })).json()).secret;
    expect((await h.call(`${environmentPath}/secrets/${secret.id}`, 'POST', { kind: 'rotate', value: 'second-signing-value' }, { 'if-match': enabled.revision, 'x-csrf-token': csrf() })).status).toBe(200);

    // Worker credential rotation: the old credential stops at once, the lease stays with the worker.
    const previous = credential.token; credential = parseComponent('WorkerCredentialIssue', await (await h.workerApi('/worker/v1/credential', undefined, bearer())).json());
    expect(credential.token).not.toBe(previous);
    expect((await h.workerApi(path, undefined, { authorization: `Bearer ${previous}`, 'x-carbon-lease-token': offer.leaseToken })).status).toBe(401);
    const delivered = parseComponent('WorkerSecretBindings', await (await h.workerApi(path, undefined, held(offer))).json());
    expect(delivered.bindings).toEqual([{ name: 'SIGNING_KEY', version: 2, value: 'second-signing-value' }]);

    // Disabling a worker takes its lease away and re-offers the work; enabling does not give the lease back.
    const current = parseComponent('WorkerPage', await (await h.call(workersPath)).json()).items[0]!;
    const disabledWorker = parseComponent('WorkerReceipt', await (await h.call(`${workersPath}/${current.id}`, 'POST', { kind: 'disable' }, { 'if-match': current.revision, 'x-csrf-token': csrf() })).json()).worker;
    expect(disabledWorker.status).toBe('disabled'); expect(await state(guarded.id)).toBe('expired');
    expect((await h.workerApi('/worker/v1/leases/claim', undefined, bearer())).status).toBe(401);
    const enabledWorker = parseComponent('WorkerReceipt', await (await h.call(`${workersPath}/${current.id}`, 'POST', { kind: 'enable' }, { 'if-match': disabledWorker.revision, 'x-csrf-token': csrf() })).json()).worker;
    expect((await h.workerApi(`/worker/v1/leases/${guarded.id}`, { kind: 'complete' }, held(offer))).status).toBe(409);
    const retry = await claim(); expect(retry.lease.subjectId).toBe(guarded.subjectId); expect(retry.lease.attempt).toBe(2);

    // An expired credential, a suspended organization and a revoked worker are all refused.
    await h.sql`UPDATE workers SET credential_expires_at = now() - interval '1 second' WHERE id = ${current.id}`;
    expect((await h.workerApi(`/worker/v1/leases/${retry.lease.id}/secrets`, undefined, held(retry))).status).toBe(401);
    await h.sql`UPDATE workers SET credential_expires_at = now() + interval '1 day' WHERE id = ${current.id}`;
    await h.sql`UPDATE organizations SET state = 'suspended' WHERE id = ${orgId}`;
    expect((await h.workerApi(`/worker/v1/leases/${retry.lease.id}/secrets`, undefined, held(retry))).status).toBe(401);
    await h.sql`UPDATE organizations SET state = 'active' WHERE id = ${orgId}`;
    const revokeHeaders = { 'if-match': enabledWorker.revision, 'x-csrf-token': csrf(), 'idempotency-key': crypto.randomUUID() };
    const revoked = parseComponent('WorkerReceipt', await (await h.call(`${workersPath}/${current.id}`, 'POST', { kind: 'revoke' }, revokeHeaders)).json());
    expect(revoked.worker.status).toBe('revoked'); expect(parseComponent('WorkerReceipt', await (await h.call(`${workersPath}/${current.id}`, 'POST', { kind: 'revoke' }, revokeHeaders)).json())).toEqual(revoked);
    expect((await h.sql`SELECT token_hash FROM workers WHERE id = ${current.id}`)[0].token_hash).toBeNull();
    for (const attempt of [h.workerApi('/worker/v1/leases/claim', undefined, bearer()), h.workerApi('/worker/v1/credential', undefined, bearer()), h.workerApi(`/worker/v1/leases/${retry.lease.id}/secrets`, undefined, held(retry))]) expect((await attempt).status).toBe(401);
    expect((await h.call(`${workersPath}/${current.id}`, 'POST', { kind: 'enable' }, { 'if-match': revoked.worker.revision, 'x-csrf-token': csrf() })).status).toBe(409);
    expect(await state(retry.lease.id)).toBe('expired');
    const durable = JSON.stringify(await h.sql`SELECT * FROM worker_events`); for (const value of ['first-signing-value', 'second-signing-value', previous, credential.token]) expect(durable).not.toContain(value);
  });

  test('projects, environments and organizations move through scheduled deletion, recovery and final deletion in order', async () => {
    const h = await harness(); await h.challenge('owner@example.test'); await h.deliver(); await h.complete();
    const org = (await organizationResponse(h.createOrganization('Lifecycle team', 'lifecycle-team'))).receipt.id;
    const created = parseComponent('CatalogReceipt', (await (await h.createProject(org)).json() as { receipt: unknown }).receipt);
    const scope = parseComponent('EnvironmentScope', created.scope); const csrf = () => h.cookies.get('__Host-carbon-csrf')!;
    const base = `/platform/v1/orgs/${org}/projects/${scope.projectId}`; const envPath = `${base}/environments/${scope.environmentId}`;
    const provider = { apply: async (work: ProvisioningWork) => ({ scope: work.scope, remoteResourceId: `${work.owner}-${work.scope.environmentId}`, state: work.action === 'pause' ? 'paused' as const : 'active' as const }) };
    const provisioning = new ProvisionEnvironment(new PostgresProvisioningRepository(h.sql), { database: provider, registry: provider });
    const drain = async () => { while (await provisioning.execute()) { /* until idle */ } };
    await drain();
    const environment = async () => parseComponent('CatalogEnvironmentDetails', await (await h.call(envPath)).json()).environment;
    const project = async () => parseComponent('CatalogProject', await (await h.call(base)).json());
    const environmentDelete = async (deleted: boolean, confirmation = 'app') => h.catalogCommand(envPath, { kind: 'delete', deleted, confirmation }, (await environment()).revision);
    const projectDelete = async (deleted: boolean, confirmation = 'app') => h.catalogCommand(base, { kind: 'delete', deleted, confirmation }, (await project()).revision);

    // Environment: active -> paused -> deletion_pending -> deleted, with recovery back to paused.
    expect((await environmentDelete(true)).status).toBe(409);
    expect((await h.catalogCommand(envPath, { kind: 'pause', paused: true }, (await environment()).revision)).status).toBe(202);
    expect((await environmentDelete(true)).status).toBe(409);
    await drain();
    expect((await environmentDelete(true, 'wrong-name')).status).toBe(400);
    expect((await environmentDelete(false)).status).toBe(403);
    expect((await environmentDelete(true)).status).toBe(200);
    let pending = await environment(); expect(pending.state).toBe('deletion_pending');
    const days = (new Date(pending.deletionScheduledAt!).getTime() - Date.now()) / 86400_000; expect(days).toBeGreaterThan(6.9); expect(days).toBeLessThanOrEqual(7);
    // Scheduled for deletion means read-only: no writes, no pause changes, no second deletion.
    expect((await h.call(`${envPath}/secrets`, 'POST', { name: 'LATE_SECRET', value: 'x' }, { 'if-match': pending.revision, 'x-csrf-token': csrf() })).status).toBe(403);
    expect((await h.catalogCommand(envPath, { kind: 'rename', name: 'Renamed' }, pending.revision)).status).toBe(403);
    expect((await h.catalogCommand(envPath, { kind: 'pause', paused: false }, pending.revision)).status).toBe(403);
    expect((await environmentDelete(true)).status).toBe(403);
    expect(await h.catalogLifecycle.finalizeDeletions(crypto.randomUUID())).toEqual([]);
    expect((await environmentDelete(false)).status).toBe(200);
    const recovered = await environment(); expect(recovered.state).toBe('paused'); expect(recovered.deletionScheduledAt).toBeUndefined();
    expect((await environmentDelete(false)).status).toBe(403);
    expect((await environmentDelete(true)).status).toBe(200);
    await h.sql`UPDATE environments SET deletion_scheduled_at = now() - interval '1 second' WHERE id = ${scope.environmentId}`;
    expect(await h.catalogLifecycle.finalizeDeletions(crypto.randomUUID())).toEqual([scope]);
    expect(await h.catalogLifecycle.finalizeDeletions(crypto.randomUUID())).toEqual([]);
    expect((await h.call(envPath)).status).toBe(404);
    expect((await h.catalogCommand(envPath, { kind: 'delete', deleted: false, confirmation: 'app' }, '1')).status).toBe(404);
    expect((await h.sql`SELECT state FROM environments WHERE id = ${scope.environmentId}`)[0].state).toBe('deleted');

    // Project: active -> archived -> deletion_pending -> deleted, with recovery back to archived.
    const second = parseComponent('CatalogReceipt', (await (await h.catalogCommand(`${base}/environments`, { name: 'Staging', kind: 'staging', services: ['database'] }, (await project()).revision)).json() as { receipt: unknown }).receipt);
    await drain();
    expect((await projectDelete(true)).status).toBe(409);
    expect((await h.catalogCommand(base, { kind: 'archive', archived: true, confirmation: 'app' }, (await project()).revision)).status).toBe(200);
    expect((await projectDelete(true, 'wrong-name')).status).toBe(400);
    expect((await projectDelete(true)).status).toBe(200);
    let doomed = await project(); expect(doomed.state).toBe('deletion_pending'); expect(doomed.deletionScheduledAt).toBeDefined();
    expect((await h.catalogCommand(`${base}/environments`, { name: 'Late', kind: 'development', services: ['database'] }, doomed.revision)).status).toBe(403);
    expect((await h.catalogCommand(base, { kind: 'archive', archived: false, confirmation: 'app' }, doomed.revision)).status).toBe(403);
    expect((await projectDelete(false)).status).toBe(200);
    expect((await project()).state).toBe('archived');
    expect((await projectDelete(true)).status).toBe(200);
    await h.sql`UPDATE projects SET deletion_scheduled_at = now() - interval '1 second' WHERE id = ${scope.projectId}`;
    // Deleting a project takes its remaining environments with it.
    expect(await h.catalogLifecycle.finalizeDeletions(crypto.randomUUID())).toEqual([{ orgId: org, projectId: scope.projectId, environmentId: second.scope.environmentId! }, { orgId: org, projectId: scope.projectId }]);
    expect((await h.call(base)).status).toBe(404);
    expect((await h.sql`SELECT state FROM environments WHERE project_id = ${scope.projectId} ORDER BY state`).map((row: { state: string }) => row.state)).toEqual(['deleted', 'deleted']);
    // A deleted project's namespace is not handed to a new project.
    expect((await h.createProject(org)).status).toBe(409);

    // Organization: active -> deletion_pending -> deleted, with cancellation back to active.
    const settings = `/platform/v1/orgs/${org}/settings`;
    const organization = async () => (await (await h.call(`/platform/v1/orgs/${org}`)).json() as { organization: { revision: string; state: string } }).organization;
    const orgCommand = async (command: unknown) => h.call(settings, 'POST', command, { 'if-match': (await organization()).revision, 'x-csrf-token': csrf() });
    expect((await orgCommand({ kind: 'delete-cancel' })).status).toBe(409);
    expect((await orgCommand({ kind: 'delete', confirmation: 'wrong-name' })).status).toBe(400);
    expect((await orgCommand({ kind: 'delete', confirmation: 'lifecycle-team' })).status).toBe(200);
    expect((await organization()).state).toBe('deletion_pending');
    expect((await h.createProject(org, 'Other', 'other')).status).toBe(403);
    expect((await orgCommand({ kind: 'update', name: 'Renamed', slug: 'lifecycle-team' })).status).toBe(403);
    expect((await orgCommand({ kind: 'delete-cancel' })).status).toBe(200);
    expect((await organization()).state).toBe('active');
    expect((await h.createProject(org, 'Other', 'other')).status).toBe(202);
    expect((await orgCommand({ kind: 'delete', confirmation: 'lifecycle-team' })).status).toBe(200);
    expect(await h.organizationLifecycle.finalizeDeletions(crypto.randomUUID())).toEqual([]);
    await h.sql`UPDATE organizations SET deletion_scheduled_at = now() - interval '1 second' WHERE id = ${org}`;
    expect(await h.organizationLifecycle.finalizeDeletions(crypto.randomUUID())).toEqual([org]);
    expect((await h.call(`/platform/v1/orgs/${org}`)).status).toBe(404);
    expect((await orgCommand({ kind: 'delete-cancel' }).catch(() => ({ status: 404 }))).status).toBe(404);

    const actions = (await h.sql`SELECT action FROM platform_events WHERE org_id = ${org} ORDER BY transaction_id, sequence`).map((row: { action: string }) => row.action);
    for (const action of ['catalog.environment-command.delete', 'catalog.environment.deleted', 'catalog.project-command.delete', 'catalog.project.deleted', 'organization.delete', 'organization.delete-cancel', 'organization.deleted']) expect(actions).toContain(action);
  });

  test('suspension, archive and scheduled deletion stop every credential type, and recovery restores them', async () => {
    const h = await harness(); await h.challenge('owner@example.test'); await h.deliver(); await h.complete();
    const org = (await organizationResponse(h.createOrganization('Credential matrix', 'credential-matrix'))).receipt.id;
    const scope = parseComponent('EnvironmentScope', parseComponent('CatalogReceipt', (await (await h.createProject(org)).json() as { receipt: unknown }).receipt).scope);
    const csrf = () => h.cookies.get('__Host-carbon-csrf')!; const base = `/platform/v1/orgs/${org}/projects/${scope.projectId}`; const envPath = `${base}/environments/${scope.environmentId}`;
    const provider = { apply: async (work: ProvisioningWork) => ({ scope: work.scope, remoteResourceId: `${work.owner}-${work.scope.environmentId}`, state: work.action === 'pause' ? 'paused' as const : 'active' as const }) };
    const provisioning = new ProvisionEnvironment(new PostgresProvisioningRepository(h.sql), { database: provider, registry: provider });
    const drain = async () => { while (await provisioning.execute()) { /* until idle */ } };
    await drain();
    const environment = async () => parseComponent('CatalogEnvironmentDetails', await (await h.call(envPath)).json()).environment;
    const project = async () => parseComponent('CatalogProject', await (await h.call(base)).json());
    const expiresAt = new Date(Date.now() + 86400_000).toISOString(); const post = (path: string, body: unknown, revision?: string) => h.call(path, 'POST', body, { 'x-csrf-token': csrf(), ...(revision ? { 'if-match': revision } : {}) });

    // One credential of every type, all for the same environment.
    expect((await post(`${envPath}/secrets`, { name: 'TOKEN', value: 'matrix-secret-value' }, (await environment()).revision)).status).toBe(201);
    const personal = parseComponent('PersonalCredentialIssue', await (await post('/platform/v1/account/personal-credentials', { name: 'Laptop', scope, permissions: ['metadata.read'], expiresAt })).json());
    const environmentCredential = parseComponent('EnvironmentCredentialIssue', await (await post(`${envPath}/credentials`, { name: 'CI', permissions: ['metadata.read'], expiresAt }, (await environment()).revision)).json());
    const serviceAccount = parseComponent('ServiceAccountReceipt', await (await post(`/platform/v1/orgs/${org}/service-accounts`, { name: 'Automation', scope, permissions: ['metadata.read'] }, (await environment()).revision)).json()).serviceAccount;
    const service = parseComponent('ServiceAccountCredentialIssue', await (await post(`/platform/v1/orgs/${org}/service-accounts/${serviceAccount.id}/credentials`, { name: 'CI', expiresAt }, serviceAccount.revision)).json());
    const challenge = parseComponent('DeviceAuthorizationChallenge', await (await h.call('/platform/v1/device/authorizations', 'POST', { clientName: 'Carbon CLI', deviceName: 'Workstation', scope, permissions: ['metadata.read'] })).json());
    const review = parseComponent('DeviceAuthorizationReview', await (await h.call('/platform/v1/account/device-authorizations/review', 'POST', { userCode: challenge.userCode })).json());
    expect((await post('/platform/v1/account/device-authorizations', { kind: 'approve', userCode: challenge.userCode }, review.revision)).status).toBe(200);
    const device = parseComponent('DeviceTokenResponse', await (await h.call('/platform/v1/device/token', 'POST', { deviceCode: challenge.deviceCode })).json()); if (device.state !== 'authorized') throw new Error('expected a device token');
    const enrollment = parseComponent('WorkerEnrollmentIssue', await (await post(`/platform/v1/orgs/${org}/workers`, { name: 'win-01', purposes: ['build'] })).json());
    const worker = parseComponent('WorkerCredentialIssue', await (await h.workerApi('/worker/v1/enroll', { code: enrollment.code, capabilities: { platform: 'windows', arch: 'x64', toolchains: [] } })).json());

    const works = (attempt: Promise<unknown>) => attempt.then(() => true, () => false);
    const probes: Record<string, () => Promise<boolean>> = {
      'pt_': () => works(new PersonalCredentialAuthentication(h.sql).verify(personal.token, scope, 'metadata.read')),
      'ce_': () => works(new EnvironmentCredentialAuthentication(new PostgresEnvironmentCredentialRepository(h.sql)).verify(environmentCredential.token, scope, 'metadata.read')),
      'cs_': () => works(new ServiceAccountAuthentication(new PostgresServiceAccountRepository(h.sql)).verify(service.token, scope, 'metadata.read')),
      'dc_': () => works(new DeviceCredentialAuthentication(h.sql).verify(device.token, scope, 'metadata.read')),
      // A worker is useful only through a lease: granting, claiming and reading its secrets must all succeed.
      'wc_ lease': async () => {
        const granted = await h.leases.grant({ scope, purpose: 'build', subjectId: crypto.randomUUID(), secretNames: ['TOKEN'] }, crypto.randomUUID()).catch(() => undefined);
        if (!granted) return false;
        const bearer = { authorization: `Bearer ${worker.token}` }; const claimed = await h.workerApi('/worker/v1/leases/claim', undefined, bearer);
        const offer = claimed.status === 200 ? parseComponent('WorkerLeaseOffer', await claimed.json()) : { state: 'none' as const };
        const delivered = offer.state === 'leased' && (await h.workerApi(`/worker/v1/leases/${offer.lease.id}/secrets`, undefined, { ...bearer, 'x-carbon-lease-token': offer.leaseToken })).status === 200;
        await h.leases.cancel(granted.subjectId, crypto.randomUUID());
        return delivered;
      },
    };
    const snapshot = async () => Object.fromEntries(await Promise.all(Object.entries(probes).map(async ([name, probe]) => [name, await probe()] as const)));
    const all = (value: boolean) => Object.fromEntries(Object.keys(probes).map(name => [name, value]));
    expect(await snapshot()).toEqual(all(true));

    // Operator suspension, and reinstatement.
    await h.organizationLifecycle.suspend(org, 'billing.overdue', crypto.randomUUID());
    await credentialRejection(h.organizationLifecycle.suspend(org, 'billing.overdue', crypto.randomUUID()), 'Only an active organization');
    expect(await snapshot()).toEqual(all(false));
    expect((await h.call(`/platform/v1/orgs/${org}`)).status).toBe(200);
    expect((await h.createProject(org, 'Blocked', 'blocked')).status).toBe(403);
    await h.organizationLifecycle.reinstate(org, crypto.randomUUID());
    expect(await snapshot()).toEqual(all(true));

    // Project archive, and restore.
    expect((await h.catalogCommand(base, { kind: 'archive', archived: true, confirmation: 'app' }, (await project()).revision)).status).toBe(200);
    expect(await snapshot()).toEqual(all(false));
    expect((await h.catalogCommand(base, { kind: 'archive', archived: false, confirmation: 'app' }, (await project()).revision)).status).toBe(200);
    expect(await snapshot()).toEqual(all(true));

    // Environment scheduled for deletion, recovered, and finally deleted.
    expect((await h.catalogCommand(envPath, { kind: 'pause', paused: true }, (await environment()).revision)).status).toBe(202); await drain();
    // Paused: personal and device credentials and worker leases stop; automation credentials are left to the owning service's paused binding.
    expect(await snapshot()).toEqual({ 'pt_': false, 'ce_': true, 'cs_': true, 'dc_': false, 'wc_ lease': false });
    expect((await h.catalogCommand(envPath, { kind: 'delete', deleted: true, confirmation: 'app' }, (await environment()).revision)).status).toBe(200);
    expect(await snapshot()).toEqual(all(false));
    expect((await h.catalogCommand(envPath, { kind: 'delete', deleted: false, confirmation: 'app' }, (await environment()).revision)).status).toBe(200);
    expect((await h.catalogCommand(envPath, { kind: 'pause', paused: false }, (await environment()).revision)).status).toBe(202); await drain();
    expect((await environment()).state).toBe('active');
    expect(await snapshot()).toEqual(all(true));
    // A lease that is open when the environment is finally deleted is cancelled with it.
    const open = await h.leases.grant({ scope, purpose: 'build', subjectId: crypto.randomUUID(), secretNames: ['TOKEN'] }, crypto.randomUUID());
    expect((await h.catalogCommand(envPath, { kind: 'pause', paused: true }, (await environment()).revision)).status).toBe(202); await drain();
    expect((await h.catalogCommand(envPath, { kind: 'delete', deleted: true, confirmation: 'app' }, (await environment()).revision)).status).toBe(200);
    await h.sql`UPDATE environments SET deletion_scheduled_at = now() - interval '1 second' WHERE id = ${scope.environmentId}`;
    expect(await h.catalogLifecycle.finalizeDeletions(crypto.randomUUID())).toEqual([scope]);
    expect((await h.sql`SELECT state FROM worker_leases WHERE id = ${open.id}`)[0].state).toBe('cancelled');
    expect(await snapshot()).toEqual(all(false));
  });

  test('audit events are browsable in order and streamed live, and both stop the moment access changes', async () => {
    const h = await harness(); await h.challenge('owner@example.test'); await h.deliver(); await h.complete();
    const org = (await organizationResponse(h.createOrganization('Audit team', 'audit-team'))).receipt.id;
    const scope = parseComponent('EnvironmentScope', parseComponent('CatalogReceipt', (await (await h.createProject(org)).json() as { receipt: unknown }).receipt).scope);
    const csrf = () => h.cookies.get('__Host-carbon-csrf')!; const envPath = `/platform/v1/orgs/${org}/projects/${scope.projectId}/environments/${scope.environmentId}`;
    const owner = (await h.sql`SELECT id FROM accounts WHERE primary_email = 'owner@example.test'`)[0].id;
    const secret = async (name: string) => { const revision = parseComponent('CatalogEnvironmentDetails', await (await h.call(envPath)).json()).environment.revision;
      const response = await h.call(`${envPath}/secrets`, 'POST', { name, value: `value-of-${name}` }, { 'if-match': revision, 'x-csrf-token': csrf() }); expect(response.status).toBe(201); return parseComponent('EnvironmentSecretReceipt', await response.json()).secret; };
    const first = await secret('FIRST'); await secret('SECOND');
    const second = parseComponent('CatalogReceipt', (await (await h.createProject(org, 'Second', 'second')).json() as { receipt: unknown }).receipt);

    // Browsing: newest first, safe fields only, stable pagination, scope filters.
    const auditPath = `/platform/v1/orgs/${org}/audit`;
    const everything = parseComponent('AuditPage', await (await h.call(auditPath)).json());
    expect(everything.items.map(item => item.action)).toEqual(['catalog.project-create', 'secret.created', 'secret.created', 'catalog.project-create', 'organization.create']);
    expect(everything.items[2]).toMatchObject({ scope, resource: { owner: 'cloud', kind: 'environment_secret', id: first.id }, actor: { kind: 'account', id: owner }, revision: '1' });
    expect(JSON.stringify(everything)).not.toContain('value-of-');
    const collected: string[] = []; let cursor: string | null = null; let pages = 0;
    do { const page: { items: readonly { id: string }[]; nextCursor: string | null } = parseComponent('AuditPage', await (await h.call(`${auditPath}?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)).json());
      expect(page.items.length).toBeLessThanOrEqual(2); collected.push(...page.items.map(item => item.id)); cursor = page.nextCursor; pages++; } while (cursor);
    expect(pages).toBe(3); expect(collected).toEqual(everything.items.map(item => item.id));
    const projectOnly = parseComponent('AuditPage', await (await h.call(`${auditPath}?projectId=${second.scope.projectId}`)).json());
    expect(projectOnly.items.map(item => item.action)).toEqual(['catalog.project-create']);
    expect(parseComponent('AuditPage', await (await h.call(`${auditPath}?projectId=${scope.projectId}&environmentId=${scope.environmentId}`)).json()).items).toHaveLength(3);
    for (const query of ['?sort=id', '?limit=0', '?unknown=1', `?environmentId=${scope.environmentId}`, '?cursor=not-a-cursor']) expect((await h.call(auditPath + query)).status).toBe(400);
    const firstPage = parseComponent('AuditPage', await (await h.call(`${auditPath}?limit=2`)).json());

    // Another tenant, and a member without audit access.
    const ownerCookies = new Map(h.cookies); h.cookies.clear(); await h.challenge('other@example.test'); await h.deliver(); await h.complete();
    const otherOrg = (await organizationResponse(h.createOrganization('Other audit', 'other-audit'))).receipt.id;
    expect((await h.call(auditPath)).status).toBe(404);
    expect((await h.call(`${auditPath.replace(org, otherOrg)}?projectId=${scope.projectId}`)).status).toBe(404);
    expect((await h.call(`/platform/v1/orgs/${org}/events/stream`)).status).toBe(404);
    expect(parseComponent('AuditPage', await (await h.call(auditPath.replace(org, otherOrg))).json()).items.map(item => item.action)).toEqual(['organization.create']);
    const other = (await h.sql`SELECT id FROM accounts WHERE primary_email = 'other@example.test'`)[0].id;
    await h.sql`INSERT INTO memberships (id, account_id, org_id, role, state) VALUES (${crypto.randomUUID()}, ${other}, ${org}, 'Viewer', 'active')`;
    await h.sql`UPDATE accounts SET permission_revision = permission_revision + 1 WHERE id = ${other}`;
    expect((await h.call(auditPath)).status).toBe(403);
    expect((await h.call(`/platform/v1/orgs/${org}/events/stream`)).status).toBe(403);
    // A cursor belongs to the session that got it; presenting it elsewhere is just an invalid cursor.
    expect((await h.call(`${auditPath}?limit=2&cursor=${encodeURIComponent(firstPage.nextCursor!)}`)).status).toBe(400);
    await h.sql`UPDATE memberships SET role = 'Developer' WHERE account_id = ${other} AND org_id = ${org}`;
    await h.sql`UPDATE accounts SET permission_revision = permission_revision + 1 WHERE id = ${other}`;
    expect((await h.call(`${auditPath}?limit=2&cursor=${encodeURIComponent(firstPage.nextCursor!)}`)).status).toBe(400);
    // A Developer is assigned projects only: the organization log and unassigned projects stay closed to them.
    expect((await h.call(`${auditPath}?projectId=${scope.projectId}`)).status).toBe(404);
    h.restoreCookies(ownerCookies);

    // Streaming.
    const decoder = new TextDecoder();
    const open = async (query = '', headers: Record<string, string> = {}) => {
      const response = await h.call(`/platform/v1/orgs/${org}/events/stream${query}`, 'GET', undefined, headers);
      expect(response.status).toBe(200); expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8'); expect(response.headers.get('cache-control')).toBe('no-store');
      const reader = response.body!.getReader(); let buffer = '';
      const next = async () => { while (!buffer.includes('\n\n')) { const { value, done } = await reader.read(); if (done) return undefined; buffer += decoder.decode(value, { stream: true }); }
        const index = buffer.indexOf('\n\n'); const frame = buffer.slice(0, index); buffer = buffer.slice(index + 2);
        return { id: /^id: (.+)$/m.exec(frame)?.[1], message: parseComponent('SubscriptionMessage', JSON.parse(/^data: (.+)$/m.exec(frame)![1]!)) }; };
      return { next, close: () => reader.cancel() };
    };
    let stream = await open(); let frame = await stream.next();
    expect(frame!.message).toMatchObject({ state: 'connected', events: [] }); expect(frame!.id).toBe(frame!.message.cursor);
    // Only what happens after connecting is delivered, in order, once.
    const third = await secret('THIRD'); await secret('FOURTH');
    const seen: { action: string; resource: { id: string } }[] = []; let resume = '';
    while (seen.length < 2) { frame = await stream.next(); seen.push(...frame!.message.events); if (frame!.message.events.length) resume = frame!.message.cursor; }
    expect(seen.map(item => item.action)).toEqual(['secret.created', 'secret.created']); expect(seen[0]!.resource.id).toBe(third.id);
    frame = await stream.next(); expect(frame!.message).toMatchObject({ state: 'heartbeat', events: [] });
    await stream.close();
    // Reconnecting with the last cursor resumes without loss or repeats; events of another organization never appear.
    const fifth = await secret('FIFTH');
    await h.sql`INSERT INTO platform_events (id, source, org_id, actor_kind, action, resource_kind, resource_id, request_id) VALUES (${crypto.randomUUID()}, 'system', ${otherOrg}, 'system', 'organization.suspended', 'organization', ${otherOrg}, ${crypto.randomUUID()})`;
    stream = await open('', { 'last-event-id': resume }); frame = await stream.next(); expect(frame!.message.events).toEqual([]);
    frame = await stream.next(); expect(frame!.message.events.map(item => item.resource.id)).toEqual([fifth.id]);
    // The stream ends itself after its maximum lifetime so clients reconnect under current authorization.
    let last = frame; while ((frame = await stream.next())) last = frame; expect(last!.message.state).toBe('closed');

    // Losing access ends the stream with one terminal frame, and the old cursor stops working.
    stream = await open(); frame = await stream.next(); const stale = frame!.message.cursor;
    await h.sql`UPDATE accounts SET permission_revision = permission_revision + 1 WHERE id = ${owner}`;
    last = frame; while ((frame = await stream.next())) last = frame;
    expect(last!.message).toEqual({ state: 'authorization_revoked', cursor: '', events: [] });
    expect((await h.call(`/platform/v1/orgs/${org}/events/stream?cursor=${encodeURIComponent(stale)}`)).status).toBe(400);
    expect((await h.call(`/platform/v1/orgs/${org}/events/stream?cursor=${encodeURIComponent(resume)}`)).status).toBe(400);
    expect((await h.call(`/platform/v1/orgs/${org}/events/stream?limit=5`)).status).toBe(400);
  });

  test('two-tenant denial matrix: another organization cannot read, change or learn about any resource', async () => {
    const h = await harness(); await h.challenge('tenant-a@example.test'); await h.deliver(); await h.complete();
    const csrf = () => h.cookies.get('__Host-carbon-csrf')!; const expiresAt = new Date(Date.now() + 86400_000).toISOString();
    const post = (path: string, body: unknown, revision?: string) => h.call(path, 'POST', body, { 'x-csrf-token': csrf(), ...(revision ? { 'if-match': revision } : {}) });
    // Tenant A owns one of everything.
    const a = (await organizationResponse(h.createOrganization('Tenant A private', 'tenant-a-private'))).receipt.id;
    const created = parseComponent('CatalogReceipt', (await (await h.createProject(a, 'Tenant A project', 'tenant-a-project')).json() as { receipt: unknown }).receipt);
    const scope = parseComponent('EnvironmentScope', created.scope); const project = `/platform/v1/orgs/${a}/projects/${scope.projectId}`; const environment = `${project}/environments/${scope.environmentId}`;
    const revision = async () => parseComponent('CatalogEnvironmentDetails', await (await h.call(environment)).json()).environment.revision;
    const secret = parseComponent('EnvironmentSecretReceipt', await (await post(`${environment}/secrets`, { name: 'TENANT_A_SECRET', value: 'tenant-a-secret-value' }, await revision())).json()).secret;
    const credential = parseComponent('EnvironmentCredentialIssue', await (await post(`${environment}/credentials`, { name: 'Tenant A CI', permissions: ['metadata.read'], expiresAt }, await revision())).json());
    const serviceAccount = parseComponent('ServiceAccountReceipt', await (await post(`/platform/v1/orgs/${a}/service-accounts`, { name: 'Tenant A automation', scope, permissions: ['metadata.read'] }, await revision())).json()).serviceAccount;
    const serviceCredential = parseComponent('ServiceAccountCredentialIssue', await (await post(`/platform/v1/orgs/${a}/service-accounts/${serviceAccount.id}/credentials`, { name: 'Tenant A key', expiresAt }, serviceAccount.revision)).json());
    const personal = parseComponent('PersonalCredentialIssue', await (await post('/platform/v1/account/personal-credentials', { name: 'Tenant A laptop', scope, permissions: ['metadata.read'], expiresAt })).json());
    const worker = parseComponent('WorkerEnrollmentIssue', await (await post(`/platform/v1/orgs/${a}/workers`, { name: 'tenant-a-worker', purposes: ['build'] })).json()).worker;
    const device = parseComponent('DeviceAuthorizationChallenge', await (await h.call('/platform/v1/device/authorizations', 'POST', { clientName: 'Tenant A CLI', deviceName: 'Tenant A machine', scope, permissions: ['metadata.read'] })).json());
    const operation = (await h.sql`SELECT id FROM operations WHERE org_id = ${a}`)[0].id; const membership = (await h.sql`SELECT id FROM memberships WHERE org_id = ${a}`)[0].id;
    const fingerprint = async () => JSON.stringify({
      organizations: await h.sql`SELECT id, name, slug, state, revision::text FROM organizations WHERE id = ${a}`, memberships: await h.sql`SELECT account_id, role, state FROM memberships WHERE org_id = ${a}`,
      projects: await h.sql`SELECT id, name, state, revision::text FROM projects WHERE org_id = ${a}`, environments: await h.sql`SELECT id, name, state, revision::text FROM environments WHERE org_id = ${a}`,
      secrets: await h.sql`SELECT id, state, current_version, revision::text FROM environment_secrets WHERE org_id = ${a}`, credentials: await h.sql`SELECT id, status, revision::text FROM environment_credentials WHERE org_id = ${a}`,
      serviceAccounts: await h.sql`SELECT id, status, revision::text FROM service_accounts WHERE org_id = ${a}`, serviceCredentials: await h.sql`SELECT id, status FROM service_account_credentials WHERE service_account_id = ${serviceAccount.id}`,
      personal: await h.sql`SELECT id, status, revision::text FROM personal_credentials WHERE org_id = ${a}`, workers: await h.sql`SELECT id, status, revision::text FROM workers WHERE org_id = ${a}`,
      devices: await h.sql`SELECT id, state FROM device_authorizations WHERE org_id = ${a}`, operations: await h.sql`SELECT id, state, revision::text FROM operations WHERE org_id = ${a}`,
      events: (await h.sql`SELECT count(*)::integer AS count FROM platform_events WHERE org_id = ${a}`)[0].count });
    const before = await fingerprint();

    // Tenant B is a different account with its own organization.
    h.cookies.clear(); await h.challenge('tenant-b@example.test'); await h.deliver(); await h.complete();
    const b = (await organizationResponse(h.createOrganization('Tenant B', 'tenant-b'))).receipt.id;
    const own = parseComponent('EnvironmentScope', parseComponent('CatalogReceipt', (await (await h.createProject(b)).json() as { receipt: unknown }).receipt).scope);
    const ownEnvironment = `/platform/v1/orgs/${b}/projects/${own.projectId}/environments/${own.environmentId}`;
    const mixedProject = `/platform/v1/orgs/${b}/projects/${scope.projectId}`; const mixedEnvironment = `${mixedProject}/environments/${scope.environmentId}`;
    const attempts: [string, string, unknown?][] = [
      // Reads of tenant A.
      ['GET', `/platform/v1/orgs/${a}`], ['GET', `/platform/v1/orgs/${a}/members`], ['GET', `/platform/v1/orgs/${a}/access`], ['GET', `/platform/v1/orgs/${a}/invitations`],
      ['GET', `/platform/v1/orgs/${a}/projects`], ['GET', project], ['GET', `${project}/environments`], ['GET', environment], ['GET', `${environment}/operations/${operation}`],
      ['GET', `${environment}/secrets`], ['GET', `${environment}/credentials`], ['GET', `/platform/v1/orgs/${a}/service-accounts`], ['GET', `/platform/v1/orgs/${a}/service-accounts/${serviceAccount.id}/credentials`],
      ['GET', `/platform/v1/orgs/${a}/workers`], ['GET', `/platform/v1/orgs/${a}/legacy-tokens`], ['GET', `/platform/v1/orgs/${a}/audit`], ['GET', `/platform/v1/orgs/${a}/audit?projectId=${scope.projectId}`],
      ['GET', `/platform/v1/orgs/${a}/events/stream`],
      // Changes to tenant A.
      ['POST', `/platform/v1/orgs/${a}/settings`, { kind: 'update', name: 'Taken over', slug: 'taken-over' }], ['POST', `/platform/v1/orgs/${a}/settings`, { kind: 'policy', requireMfa: true }],
      ['POST', `/platform/v1/orgs/${a}/settings`, { kind: 'delete', confirmation: 'tenant-a-private' }], ['POST', `/platform/v1/orgs/${a}/settings`, { kind: 'delete-cancel' }],
      ['POST', `/platform/v1/orgs/${a}/members`, { kind: 'leave' }], ['POST', `/platform/v1/orgs/${a}/members`, { kind: 'member-revoke', membershipId: membership }],
      ['POST', `/platform/v1/orgs/${a}/members`, { kind: 'member-role', membershipId: membership, role: 'Viewer' }],
      ['POST', `/platform/v1/orgs/${a}/projects`, { name: 'Injected', slug: 'injected', services: ['database'] }],
      ['POST', project, { kind: 'update', name: 'Renamed', slug: 'renamed' }], ['POST', project, { kind: 'archive', archived: true, confirmation: 'tenant-a-project' }],
      ['POST', project, { kind: 'delete', deleted: true, confirmation: 'tenant-a-project' }], ['POST', project, { kind: 'production-policy', allowed: true, confirmation: 'tenant-a-project' }],
      ['POST', `${project}/environments`, { name: 'Injected', kind: 'development', services: ['database'] }],
      ['POST', environment, { kind: 'rename', name: 'Renamed' }], ['POST', environment, { kind: 'pause', paused: true }], ['POST', environment, { kind: 'delete', deleted: true, confirmation: 'tenant-a-project' }],
      ['POST', `${environment}/operations/${operation}`, { kind: 'cancel' }], ['POST', `${environment}/operations/${operation}`, { kind: 'retry' }],
      ['POST', `${environment}/secrets`, { name: 'INJECTED', value: 'x' }], ['POST', `${environment}/secrets/${secret.id}`, { kind: 'rotate', value: 'overwritten' }],
      ['POST', `${environment}/secrets/${secret.id}`, { kind: 'disable', disabled: true }],
      ['POST', `${environment}/credentials`, { name: 'Injected', permissions: ['data.write'], expiresAt }], ['POST', `${environment}/credentials/${credential.credential.id}`, { kind: 'revoke' }],
      ['POST', `/platform/v1/orgs/${a}/service-accounts`, { name: 'Injected', scope, permissions: ['data.write'] }], ['POST', `/platform/v1/orgs/${a}/service-accounts/${serviceAccount.id}`, { kind: 'disable' }],
      ['POST', `/platform/v1/orgs/${a}/service-accounts/${serviceAccount.id}/credentials`, { name: 'Injected', expiresAt }],
      ['POST', `/platform/v1/orgs/${a}/service-accounts/${serviceAccount.id}/credentials/${serviceCredential.credential.id}`, { kind: 'revoke' }],
      ['POST', `/platform/v1/orgs/${a}/workers`, { name: 'injected', purposes: ['build'] }], ['POST', `/platform/v1/orgs/${a}/workers/${worker.id}`, { kind: 'revoke' }],
      ['POST', `/platform/v1/orgs/${a}/legacy-tokens/${crypto.randomUUID()}`, { kind: 'retire' }],
      // Tenant A's identifiers under tenant B's own organization, where B does hold authority.
      ['GET', mixedProject], ['GET', `${mixedProject}/environments`], ['GET', mixedEnvironment], ['GET', `${mixedEnvironment}/secrets`], ['GET', `${mixedEnvironment}/credentials`],
      ['GET', `${ownEnvironment}/operations/${operation}`], ['GET', `/platform/v1/orgs/${b}/service-accounts/${serviceAccount.id}/credentials`], ['GET', `/platform/v1/orgs/${b}/audit?projectId=${scope.projectId}`],
      ['POST', mixedProject, { kind: 'archive', archived: true, confirmation: 'tenant-a-project' }], ['POST', mixedEnvironment, { kind: 'pause', paused: true }],
      ['POST', `${mixedEnvironment}/secrets`, { name: 'INJECTED', value: 'x' }], ['POST', `${ownEnvironment}/secrets/${secret.id}`, { kind: 'rotate', value: 'overwritten' }],
      ['POST', `${ownEnvironment}/credentials/${credential.credential.id}`, { kind: 'revoke' }], ['POST', `${ownEnvironment}/operations/${operation}`, { kind: 'cancel' }],
      ['POST', `/platform/v1/orgs/${b}/service-accounts/${serviceAccount.id}`, { kind: 'disable' }],
      ['POST', `/platform/v1/orgs/${b}/workers/${worker.id}`, { kind: 'revoke' }],
      // Account-level routes aimed at tenant A's resources.
      ['POST', '/platform/v1/account/personal-credentials', { name: 'Injected', scope, permissions: ['metadata.read'], expiresAt }],
      ['POST', `/platform/v1/account/personal-credentials/${personal.credential.id}`, { kind: 'revoke' }], ['POST', `/platform/v1/account/personal-credentials/${personal.credential.id}`, { kind: 'rotate', expiresAt }],
      ['POST', '/platform/v1/account/device-authorizations/review', { userCode: device.userCode }], ['POST', '/platform/v1/account/device-authorizations', { kind: 'approve', userCode: device.userCode }],
    ];
    const private_ = ['Tenant A', 'tenant-a', 'TENANT_A_SECRET', 'tenant-a-secret-value', credential.token, serviceCredential.token, personal.token, secret.id, serviceAccount.id, worker.id];
    const failures: string[] = [];
    for (const [method, path, body] of attempts) {
      const response = await h.call(path, method, body, method === 'POST' ? { 'x-csrf-token': csrf(), 'if-match': '1' } : {});
      const text = await response.text(); const label = `${method} ${path.replaceAll(a, '{A}').replaceAll(b, '{B}')}${body ? ' ' + JSON.stringify((body as { kind?: string }).kind ?? 'create') : ''}`;
      // Denied, and denied the same way whether or not the resource exists: never a success, a conflict or a validation hint.
      if (![403, 404].includes(response.status)) failures.push(`${label} -> ${response.status}`);
      const leaked = private_.find(value => text.includes(value)); if (leaked) failures.push(`${label} leaked ${leaked.slice(0, 12)}`);
    }
    expect(failures).toEqual([]);
    // A body naming another organization than the path is malformed for any organization, existing or not.
    expect((await post(`/platform/v1/orgs/${b}/service-accounts`, { name: 'Injected', scope, permissions: ['metadata.read'] }, '1')).status).toBe(400);
    expect((await post(`/platform/v1/orgs/${b}/service-accounts`, { name: 'Injected', scope: { ...scope, orgId: crypto.randomUUID() }, permissions: ['metadata.read'] }, '1')).status).toBe(400);
    expect(attempts.length).toBeGreaterThanOrEqual(60);
    // Nothing of tenant A changed, and nothing was recorded against it.
    expect(await fingerprint()).toBe(before);
    // Tenant B's own lists contain only tenant B.
    for (const path of [`/platform/v1/orgs`, `/platform/v1/orgs/${b}/projects`, `/platform/v1/orgs/${b}/audit`, `/platform/v1/orgs/${b}/service-accounts`, `/platform/v1/orgs/${b}/workers`, '/platform/v1/account/personal-credentials', '/platform/v1/account/devices']) {
      const response = await h.call(path); expect(response.status).toBe(200); const text = await response.text(); for (const value of private_) expect(text).not.toContain(value);
    }
  });

  test('app authentication: realm policy, generic magic links, single-use sign-in, sessions, rotation, revocation and user management', async () => {
    const h = await harness(); await h.challenge('developer@example.test'); await h.deliver(); await h.complete();
    const org = (await organizationResponse(h.createOrganization('App team', 'app-team'))).receipt.id;
    const scope = parseComponent('EnvironmentScope', parseComponent('CatalogReceipt', (await (await h.createProject(org)).json() as { receipt: unknown }).receipt).scope);
    const csrf = () => h.cookies.get('__Host-carbon-csrf')!; const realmPath = `/platform/v1/orgs/${org}/projects/${scope.projectId}/environments/${scope.environmentId}/realm`;
    const redirectUri = 'https://app.example.test/callback'; const settings = { kind: 'configure', signupEnabled: false, magicLinkEnabled: true, sessionTtlSeconds: 3600, redirectAllowlist: [redirectUri] };
    const admin = (body: unknown, revision?: string, overrides: Record<string, string> = {}) => h.call(realmPath, 'POST', body, { 'x-csrf-token': csrf(), ...(revision ? { 'if-match': revision } : {}), ...overrides });
    const current = async () => parseComponent('Realm', await (await h.call(realmPath)).json());

    // Realm configuration.
    expect((await h.call(realmPath)).status).toBe(404);
    expect((await admin({ kind: 'state', disabled: true })).status).toBe(404);
    expect((await h.call(realmPath, 'POST', settings)).status).toBe(403);
    for (const bad of ['https://app.example.test/*', 'http://app.example.test/callback', 'https://app.example.test/callback#fragment', 'javascript:alert(1)', 'https://user:pass@app.example.test/callback']) {
      expect((await admin({ ...settings, redirectAllowlist: [bad] })).status).toBe(400);
    }
    const key = crypto.randomUUID(); const createdResponse = await admin(settings, undefined, { 'idempotency-key': key }); expect(createdResponse.status).toBe(200);
    const created = parseComponent('RealmReceipt', await createdResponse.json()); const realmId = created.realm.id;
    expect(created.realm).toMatchObject({ scope, state: 'active', signupEnabled: false, providers: [], claimsRevision: '1', revision: '1' });
    expect(parseComponent('RealmReceipt', await (await admin(settings, undefined, { 'idempotency-key': key })).json())).toEqual(created);
    expect((await admin({ ...settings, signupEnabled: true }, '99')).status).toBe(409);
    const base = `/app/v1/realms/${realmId}`;
    expect(parseComponent('AppRealmConfiguration', await (await h.app(`${base}/configuration`)).json())).toEqual({ realmId, signupEnabled: false, magicLinkEnabled: true, providers: [] });
    expect((await h.app(`/app/v1/realms/${crypto.randomUUID()}/configuration`)).status).toBe(404);

    // Magic links: one answer for every address, whatever happens behind it.
    const ask = (email: string, peer?: string, uri = redirectUri) => h.app(`${base}/challenges`, 'POST', { email, redirectUri: uri }, {}, peer);
    const linkToken = () => /#token=(am_[A-Za-z0-9_-]{43})/.exec(h.mail.at(-1)!.text)![1]!;
    expect((await ask('customer@example.test', undefined, 'https://evil.example.test/callback')).status).toBe(400);
    const closed = await ask('customer@example.test'); expect(closed.status).toBe(202); const generic = await closed.text();
    expect(await h.deliverApp()).toBe(false); expect(await h.sql`SELECT id FROM app_challenges`).toHaveLength(0);
    expect((await admin({ ...settings, signupEnabled: true }, (await current()).revision)).status).toBe(200);
    const opened = await ask('Customer@Example.test'); expect(opened.status).toBe(202); expect(await opened.text()).toBe(generic);
    expect(await h.deliverApp()).toBe(true); expect(h.mail.at(-1)!.to).toBe('customer@example.test');
    const token = linkToken(); expect(h.mail.at(-1)!.text).toContain(`${redirectUri}#token=${token}`);
    const stored = JSON.stringify({ challenges: await h.sql`SELECT * FROM app_challenges`, outbox: await h.sql`SELECT * FROM app_email_outbox` });
    expect(stored).not.toContain(token); expect(stored).toContain(tokenDigest(token));

    // Sign-in: single use, hash-only session.
    expect((await h.app(`${base}/sessions`, 'POST', { token: 'am_' + 'A'.repeat(43) })).status).toBe(401);
    expect((await h.app(`/app/v1/realms/${crypto.randomUUID()}/sessions`, 'POST', { token })).status).toBe(404);
    const signedInResponse = await h.app(`${base}/sessions`, 'POST', { token }); expect(signedInResponse.status).toBe(201);
    const signedIn = parseComponent('AppSessionIssue', await signedInResponse.json()); expect(signedIn.user.email).toBe('customer@example.test');
    expect((await h.app(`${base}/sessions`, 'POST', { token })).status).toBe(401);
    expect((await h.sql`SELECT token_hash FROM app_sessions`)[0].token_hash).toBe(tokenDigest(signedIn.token));
    const lifetime = (new Date(signedIn.expiresAt).getTime() - Date.now()) / 1000; expect(lifetime).toBeGreaterThan(3590); expect(lifetime).toBeLessThanOrEqual(3600);
    const bearer = (value: string) => ({ authorization: `Bearer ${value}` });
    expect(parseComponent('AppSessionView', await (await h.app(`${base}/session`, 'GET', undefined, bearer(signedIn.token))).json()).user).toEqual(signedIn.user);
    expect((await h.app(`${base}/session`)).status).toBe(401);
    // A developer's browser session is not an app session, and other credential types are not accepted.
    expect((await h.app(`${base}/session`, 'GET', undefined, { cookie: [...h.cookies].map(([name, value]) => `${name}=${value}`).join('; ') })).status).toBe(401);
    for (const prefix of ['pt', 'dc', 'cs', 'wc', 'am']) expect((await h.app(`${base}/session`, 'GET', undefined, bearer(`${prefix}_${'A'.repeat(43)}`))).status).toBe(401);

    // Rotation replaces the token without extending the session.
    const rotated = parseComponent('AppSessionIssue', await (await h.app(`${base}/session/rotate`, 'POST', undefined, bearer(signedIn.token))).json());
    expect(rotated.token).not.toBe(signedIn.token); expect(rotated.expiresAt).toBe(signedIn.expiresAt);
    expect((await h.app(`${base}/session`, 'GET', undefined, bearer(signedIn.token))).status).toBe(401);
    expect((await h.app(`${base}/session`, 'GET', undefined, bearer(rotated.token))).status).toBe(200);

    // A known and an unknown address get byte-identical answers; with signup closed only the known one gets mail.
    expect((await admin({ ...settings, signupEnabled: false }, (await current()).revision)).status).toBe(200);
    const known = await ask('customer@example.test'); const unknown = await ask('stranger@example.test');
    expect([known.status, await known.text()]).toEqual([unknown.status, await unknown.text()]);
    expect(await h.deliverApp()).toBe(true); expect(await h.deliverApp()).toBe(false); expect(h.mail.at(-1)!.to).toBe('customer@example.test');
    // Per-address limit: still the same answer, no more mail. Per-caller limit: refused.
    for (let i = 0; i < 6; i++) expect((await ask('customer@example.test', `198.51.100.${i}`)).status).toBe(202);
    // Three requests for this address were already counted above, so two of these six are sent before the limit of five.
    let sent = 0; while (await h.deliverApp()) sent++; expect(sent).toBe(2);
    const statuses: number[] = []; for (let i = 0; i < 22; i++) statuses.push((await ask(`flood-${i}@example.test`, '192.0.2.77')).status);
    expect(statuses.slice(0, 20).every(status => status === 202)).toBe(true); expect(statuses.slice(20)).toEqual([429, 429]);
    expect(JSON.stringify(await h.sql`SELECT * FROM app_auth_rate_limits`)).not.toContain('192.0.2.77');

    // User management by the developer.
    const usersPath = `${realmPath}/users`; let users = parseComponent('AppUserPage', await (await h.call(usersPath)).json());
    expect(users.items.map(user => [user.email, user.state, user.identities.map(identity => identity.provider)])).toEqual([['customer@example.test', 'active', ['email']]]);
    const user = users.items[0]!; const userCommand = (kind: string, revision: string) => h.call(`${usersPath}/${user.id}`, 'POST', { kind }, { 'if-match': revision, 'x-csrf-token': csrf() });
    expect((await userCommand('restore', user.revision)).status).toBe(409);
    const suspended = parseComponent('AppUserReceipt', await (await userCommand('suspend', user.revision)).json()).user; expect(suspended.state).toBe('suspended');
    expect((await h.app(`${base}/session`, 'GET', undefined, bearer(rotated.token))).status).toBe(401);
    while (await h.deliverApp()) { /* drain */ }
    expect((await ask('customer@example.test', '203.0.113.50')).status).toBe(202); expect(await h.deliverApp()).toBe(false);
    const restored = parseComponent('AppUserReceipt', await (await userCommand('restore', suspended.revision)).json()).user;
    // Restoring a user does not bring their old session back.
    expect((await h.app(`${base}/session`, 'GET', undefined, bearer(rotated.token))).status).toBe(401);
    await h.sql`DELETE FROM app_auth_rate_limits`;
    const signIn = async (email: string) => { expect((await ask(email)).status).toBe(202); expect(await h.deliverApp()).toBe(true); const response = await h.app(`${base}/sessions`, 'POST', { token: linkToken() }); expect(response.status).toBe(201); return parseComponent('AppSessionIssue', await response.json()); };
    let session = await signIn('customer@example.test'); expect(session.user.id).toBe(user.id);

    // Ending sessions: sign-out, realm-wide invalidation, expiry, disabling the realm.
    expect((await h.app(`${base}/session`, 'DELETE', undefined, bearer(session.token))).status).toBe(204);
    expect((await h.app(`${base}/session`, 'GET', undefined, bearer(session.token))).status).toBe(401);
    session = await signIn('customer@example.test'); expect((await ask('customer@example.test')).status).toBe(202); expect(await h.deliverApp()).toBe(true); const pending = linkToken();
    const invalidated = parseComponent('RealmReceipt', await (await admin({ kind: 'invalidate-sessions' }, (await current()).revision)).json()); expect(invalidated.realm.claimsRevision).toBe('2');
    expect((await h.app(`${base}/session`, 'GET', undefined, bearer(session.token))).status).toBe(401);
    expect((await h.app(`${base}/sessions`, 'POST', { token: pending })).status).toBe(401);
    session = await signIn('customer@example.test');
    await h.sql`UPDATE app_sessions SET expires_at = now() - interval '1 second' WHERE token_hash = ${tokenDigest(session.token)}`;
    expect((await h.app(`${base}/session`, 'GET', undefined, bearer(session.token))).status).toBe(401);
    session = await signIn('customer@example.test');
    expect((await admin({ kind: 'state', disabled: true }, (await current()).revision)).status).toBe(200);
    expect((await h.app(`${base}/configuration`)).status).toBe(404); expect((await h.app(`${base}/session`, 'GET', undefined, bearer(session.token))).status).toBe(401); expect((await ask('customer@example.test')).status).toBe(404);
    expect((await admin({ kind: 'state', disabled: false }, (await current()).revision)).status).toBe(200);
    expect((await h.app(`${base}/session`, 'GET', undefined, bearer(session.token))).status).toBe(200);

    // Deleting a user ends them; the address can sign up again as a different user.
    const deleted = parseComponent('AppUserReceipt', await (await userCommand('delete', (parseComponent('AppUserPage', await (await h.call(usersPath)).json()).items[0]!).revision)).json()).user; expect(deleted.state).toBe('deleted');
    expect((await h.app(`${base}/session`, 'GET', undefined, bearer(session.token))).status).toBe(401);
    expect(parseComponent('AppUserPage', await (await h.call(usersPath)).json()).items).toEqual([]);
    expect((await h.call(`${usersPath}/${user.id}`, 'POST', { kind: 'restore' }, { 'if-match': deleted.revision, 'x-csrf-token': csrf() })).status).toBe(404);
    expect((await admin({ ...settings, signupEnabled: true }, (await current()).revision)).status).toBe(200);
    await h.sql`DELETE FROM app_auth_rate_limits`; // this address has used its five links for the window
    const reborn = await signIn('customer@example.test'); expect(reborn.user.id).not.toBe(user.id); expect(restored.id).toBe(user.id);

    // Another developer's realm: neither its administration nor its sessions cross over.
    const developerCookies = new Map(h.cookies); h.cookies.clear(); await h.challenge('other-developer@example.test'); await h.deliver(); await h.complete();
    const otherOrg = (await organizationResponse(h.createOrganization('Other app', 'other-app'))).receipt.id;
    const otherScope = parseComponent('EnvironmentScope', parseComponent('CatalogReceipt', (await (await h.createProject(otherOrg)).json() as { receipt: unknown }).receipt).scope);
    const otherRealmPath = `/platform/v1/orgs/${otherOrg}/projects/${otherScope.projectId}/environments/${otherScope.environmentId}/realm`;
    for (const attempt of [h.call(realmPath), h.call(usersPath), h.call(realmPath, 'POST', { kind: 'invalidate-sessions' }, { 'x-csrf-token': csrf(), 'if-match': '1' }),
      h.call(`${usersPath}/${reborn.user.id}`, 'POST', { kind: 'delete' }, { 'x-csrf-token': csrf(), 'if-match': '1' })]) expect((await attempt).status).toBe(404);
    const otherRealm = parseComponent('RealmReceipt', await (await h.call(otherRealmPath, 'POST', { ...settings, signupEnabled: true }, { 'x-csrf-token': csrf() })).json()).realm;
    expect((await h.app(`/app/v1/realms/${otherRealm.id}/session`, 'GET', undefined, bearer(reborn.token))).status).toBe(401);
    expect((await ask('customer@example.test')).status).toBe(202); expect(await h.deliverApp()).toBe(true);
    expect((await h.app(`/app/v1/realms/${otherRealm.id}/sessions`, 'POST', { token: linkToken() })).status).toBe(401);
    expect(parseComponent('AppUserPage', await (await h.call(`${otherRealmPath}/users`)).json()).items).toEqual([]);
    h.restoreCookies(developerCookies);

    const audit = (await h.sql`SELECT action FROM platform_events WHERE org_id = ${org} AND source = 'app_auth_events'`).map((row: { action: string }) => row.action);
    for (const action of ['realm.created', 'realm.configure', 'realm.invalidate-sessions', 'realm.state', 'app_user.signed_up', 'app_user.signed_in', 'app_user.session_rotated', 'app_user.signed_out', 'app_user.suspend', 'app_user.restore', 'app_user.delete']) expect(audit).toContain(action);
    const durable = JSON.stringify({ events: await h.sql`SELECT * FROM app_auth_events`, sessions: await h.sql`SELECT * FROM app_sessions`, commands: await h.sql`SELECT * FROM realm_commands` });
    for (const secret of [token, signedIn.token, rotated.token, reborn.token]) expect(durable).not.toContain(secret);
  });

  test('app authentication: an OIDC provider signs users in only with a verified ID token, PKCE, a single-use state and an allowed redirect', async () => {
    const h = await harness(); await h.challenge('developer@example.test'); await h.deliver(); await h.complete();
    const org = (await organizationResponse(h.createOrganization('OIDC team', 'oidc-team'))).receipt.id;
    const scope = parseComponent('EnvironmentScope', parseComponent('CatalogReceipt', (await (await h.createProject(org)).json() as { receipt: unknown }).receipt).scope);
    const csrf = () => h.cookies.get('__Host-carbon-csrf')!; const envPath = `/platform/v1/orgs/${org}/projects/${scope.projectId}/environments/${scope.environmentId}`; const realmPath = `${envPath}/realm`;
    const redirectUri = 'https://app.example.test/callback'; const settings = { kind: 'configure', signupEnabled: true, magicLinkEnabled: true, sessionTtlSeconds: 3600, redirectAllowlist: [redirectUri] };
    const admin = async (body: unknown) => { const existing = await h.call(realmPath); const revision = existing.status === 200 ? parseComponent('Realm', await existing.json()).revision : undefined;
      return h.call(realmPath, 'POST', body, { 'x-csrf-token': csrf(), ...(revision ? { 'if-match': revision } : {}) }); };
    const realmId = parseComponent('RealmReceipt', await (await admin(settings)).json()).realm.id; const base = `/app/v1/realms/${realmId}`;
    const provider = { kind: 'provider-set', name: 'acme-sso', issuer: h.idp.issuer, clientId: 'carbon-client', clientSecretName: 'OIDC_CLIENT_SECRET', scopes: ['openid', 'email', 'profile'] };
    // The client secret must be an existing secret of this environment; it is referenced by name, never stored in the realm.
    expect((await admin(provider)).status).toBe(400);
    const environmentRevision = parseComponent('CatalogEnvironmentDetails', await (await h.call(envPath)).json()).environment.revision;
    expect((await h.call(`${envPath}/secrets`, 'POST', { name: 'OIDC_CLIENT_SECRET', value: 'oidc-client-secret-value' }, { 'if-match': environmentRevision, 'x-csrf-token': csrf() })).status).toBe(201);
    const configured = parseComponent('RealmReceipt', await (await admin(provider)).json()).realm;
    expect(configured.providers).toEqual([{ name: 'acme-sso', issuer: h.idp.issuer, clientId: 'carbon-client', clientSecretName: 'OIDC_CLIENT_SECRET', scopes: ['openid', 'email', 'profile'] }]);
    const publicConfiguration = await (await h.app(`${base}/configuration`)).text();
    expect(JSON.parse(publicConfiguration).providers).toEqual([{ name: 'acme-sso' }]); for (const hidden of ['carbon-client', 'OIDC_CLIENT_SECRET', 'oidc-client-secret-value', h.idp.issuer]) expect(publicConfiguration).not.toContain(hidden);

    const start = async (providerName = 'acme-sso', uri = redirectUri) => h.app(`${base}/oidc/start`, 'POST', { provider: providerName, redirectUri: uri });
    const begin = async () => { const response = await start(); expect(response.status).toBe(200); return new URL(parseComponent('AppOidcStartResponse', await response.json()).authorizationUrl); };
    expect((await start('unknown-sso')).status).toBe(404); expect((await start('acme-sso', 'https://evil.example.test/callback')).status).toBe(400);
    let url = await begin();
    expect(url.origin + url.pathname).toBe(`${h.idp.issuer}/authorize`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ response_type: 'code', client_id: 'carbon-client', redirect_uri: redirectUri, code_challenge_method: 'S256', scope: 'openid email profile' });
    expect(url.searchParams.get('state')).toMatch(/^ao_[A-Za-z0-9_-]{43}$/); expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const stored = JSON.stringify(await h.sql`SELECT * FROM app_challenges WHERE kind = 'oidc'`); expect(stored).not.toContain(url.searchParams.get('state')!);
    const complete = (state: string, code = 'good-code') => h.app(`${base}/oidc/complete`, 'POST', { state, code });

    // A wrong state, then every way the provider's answer can be untrustworthy. Each attempt spends its state.
    expect((await complete('ao_' + 'A'.repeat(43))).status).toBe(401);
    const untrusted: [string, Partial<typeof h.idp.next>][] = [['unverified email', { emailVerified: false }], ['wrong nonce', { nonce: 'attacker-nonce' }], ['wrong audience', { audience: 'another-client' }],
      ['wrong issuer', { issuer: 'https://attacker.example.test' }], ['forged signature', { forged: true }], ['expired token', { expired: true }], ['provider refuses the code', { refuse: true }]];
    for (const [, fault] of untrusted) {
      url = await begin(); h.idp.arm(url, { subject: 'idp-user-1', email: 'customer@example.test', ...fault });
      const state = url.searchParams.get('state')!; expect((await complete(state)).status).toBe(401); expect((await complete(state)).status).toBe(401);
    }
    expect(await h.sql`SELECT id FROM app_users`).toHaveLength(0); expect(await h.sql`SELECT id FROM app_sessions`).toHaveLength(0);

    // A verified sign-in. The provider saw the PKCE verifier matching the challenge and the stored client secret.
    url = await begin(); h.idp.arm(url, { subject: 'idp-user-1', email: 'Customer@Example.test' });
    const signedInResponse = await complete(url.searchParams.get('state')!); expect(signedInResponse.status).toBe(201);
    const signedIn = parseComponent('AppSessionIssue', await signedInResponse.json()); expect(signedIn.user.email).toBe('customer@example.test');
    expect(h.idp.last).toMatchObject({ pkce: true, clientSecret: 'oidc-client-secret-value', redirectUri, clientId: 'carbon-client' });
    expect((await complete(url.searchParams.get('state')!)).status).toBe(401);
    expect((await h.app(`${base}/session`, 'GET', undefined, { authorization: `Bearer ${signedIn.token}` })).status).toBe(200);
    // The same provider subject is the same user even after their address changes; a verified address links to an existing user.
    url = await begin(); h.idp.arm(url, { subject: 'idp-user-1', email: 'renamed@example.test' });
    expect(parseComponent('AppSessionIssue', await (await complete(url.searchParams.get('state')!)).json()).user.id).toBe(signedIn.user.id);
    expect((await h.app(`${base}/challenges`, 'POST', { email: 'customer@example.test', redirectUri })).status).toBe(202); expect(await h.deliverApp()).toBe(true);
    const viaEmail = parseComponent('AppSessionIssue', await (await h.app(`${base}/sessions`, 'POST', { token: /#token=(am_[A-Za-z0-9_-]{43})/.exec(h.mail.at(-1)!.text)![1]! })).json());
    expect(viaEmail.user.id).toBe(signedIn.user.id);
    const users = parseComponent('AppUserPage', await (await h.call(`${realmPath}/users`)).json());
    expect(users.items).toHaveLength(1); expect(users.items[0]!.identities.map(identity => identity.provider).sort()).toEqual(['acme-sso', 'email']);

    // With signup closed a new provider identity is refused; removing the provider ends the flow.
    expect((await admin({ ...settings, signupEnabled: false })).status).toBe(200);
    url = await begin(); h.idp.arm(url, { subject: 'idp-user-2', email: 'newcomer@example.test' }); expect((await complete(url.searchParams.get('state')!)).status).toBe(401);
    url = await begin(); h.idp.arm(url, { subject: 'idp-user-1', email: 'customer@example.test' });
    expect((await admin({ kind: 'provider-remove', name: 'acme-sso' })).status).toBe(200);
    expect((await complete(url.searchParams.get('state')!)).status).toBe(401); expect((await start()).status).toBe(404);
    expect(await h.sql`SELECT id FROM app_users`).toHaveLength(1);
    const durable = JSON.stringify({ events: await h.sql`SELECT * FROM app_auth_events`, challenges: await h.sql`SELECT * FROM app_challenges`, providers: await h.sql`SELECT * FROM realm_providers` });
    for (const secret of ['oidc-client-secret-value', signedIn.token, viaEmail.token]) expect(durable).not.toContain(secret);
  });

  test('device authorization approves bounded CLI access, discloses once, rate-limits polling, and revokes durably', async()=>{
    const h=await harness();await h.challenge();await h.deliver();await h.complete();const orgId=(await organizationResponse(h.createOrganization('Device team','device-team'))).receipt.id;const project=parseComponent('CatalogReceipt',(await (await h.createProject(orgId)).json() as {receipt:unknown}).receipt);const environmentResponse=await h.catalogCommand(`/platform/v1/orgs/${orgId}/projects/${project.scope.projectId}/environments`,{name:'CLI',kind:'development',services:['database','registry']},project.revision);const environment=parseComponent('CatalogReceipt',(await environmentResponse.json() as {receipt:unknown}).receipt);
    const deviceScope:EnvironmentScope={orgId,projectId:project.scope.projectId!,environmentId:environment.scope.environmentId!};const requested:DeviceAuthorizationCreate={clientName:'Carbon CLI',deviceName:'Workstation',scope:deviceScope,permissions:['metadata.read','data.read']};const started=await h.call('/platform/v1/device/authorizations','POST',requested);expect(started.status).toBe(201);const challenge=parseComponent('DeviceAuthorizationChallenge',await started.json());expect(challenge.deviceCode).toMatch(/^dv_/);expect(challenge.userCode).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    const pending=parseComponent('DeviceTokenResponse',await (await h.call('/platform/v1/device/token','POST',{deviceCode:challenge.deviceCode})).json());expect(pending.state).toBe('pending');expect((await h.call('/platform/v1/device/token','POST',{deviceCode:challenge.deviceCode})).status).toBe(429);
    expect((await h.call('/platform/v1/account/device-authorizations/review','POST',{userCode:'AAAA-AAAA'})).status).toBe(404);const review=parseComponent('DeviceAuthorizationReview',await (await h.call('/platform/v1/account/device-authorizations/review','POST',{userCode:challenge.userCode})).json());expect(review.scope).toEqual(requested.scope);expect(review.permissions).toEqual(requested.permissions);
    const key=crypto.randomUUID();const decisionHeaders={'if-match':review.revision,'idempotency-key':key,'x-csrf-token':h.cookies.get('__Host-carbon-csrf')!};const approvedResponse=await h.call('/platform/v1/account/device-authorizations','POST',{kind:'approve',userCode:challenge.userCode},decisionHeaders);expect(approvedResponse.status).toBe(200);const approved=parseComponent('DeviceAuthorizationReceipt',await approvedResponse.json());expect(approved.state).toBe('approved');
    await h.sql`UPDATE device_authorizations SET next_poll_at=now() WHERE id=${review.id}`;const issued=parseComponent('DeviceTokenResponse',await (await h.call('/platform/v1/device/token','POST',{deviceCode:challenge.deviceCode})).json());expect(issued.state).toBe('authorized');if(issued.state!=='authorized')throw new Error('expected token');expect(issued.token).toMatch(/^dc_[A-Za-z0-9_-]{43}$/);expect(issued.grant.permissions).toEqual(requested.permissions);
    const stored=(await h.sql`SELECT device_code_hash,user_code_hash,g.token_hash,g.token_prefix FROM device_authorizations a JOIN device_grants g ON g.authorization_id=a.id WHERE a.id=${review.id}`)[0];expect(stored.device_code_hash).toBe(tokenDigest(challenge.deviceCode));expect(stored.user_code_hash).toBe(tokenDigest(challenge.userCode));expect(stored.token_hash).toBe(tokenDigest(issued.token));expect(JSON.stringify(stored)).not.toContain(issued.token);
    const verifier=new DeviceCredentialAuthentication(h.sql);const principal=await verifier.verify(issued.token,deviceScope,'metadata.read');expect(principal.credentialId).toBe(issued.grant.id);await credentialRejection(verifier.verify(issued.token,{...deviceScope,projectId:crypto.randomUUID()},'metadata.read'),'invalid');await credentialRejection(verifier.verify(issued.token,deviceScope,'data.write'),'invalid');await h.sql`UPDATE accounts SET permission_revision=permission_revision+1 WHERE id=${principal.accountId}`;await credentialRejection(verifier.verify(issued.token,deviceScope,'metadata.read'),'invalid');await h.sql`UPDATE accounts SET permission_revision=permission_revision-1 WHERE id=${principal.accountId}`;
    const binding=(await h.sql`UPDATE service_bindings SET state='ready',remote_resource_id='device-cli-test' WHERE environment_id=${deviceScope.environmentId} AND owner='database' RETURNING id`)[0];const dataBody=JSON.stringify({scope:deviceScope,bindingId:binding.id,command:{kind:'tables.list',limit:25}});const boundRequest={method:'POST' as const,path:dataRequestPath(deviceScope,binding.id,'tables.list'),bodyDigest:bodyDigest(dataBody)};const exchangeInput={audience:'carbon-database' as const,scope:deviceScope,permission:'metadata.read' as const,request:boundRequest};expect((await h.call('/platform/v1/device/assertions','POST',exchangeInput)).status).toBe(401);expect((await h.call('/platform/v1/device/assertions','POST',exchangeInput,{authorization:`Bearer ${issued.token}`,origin:'https://attacker.test'})).status).toBe(403);const exchangeResponse=await h.call('/platform/v1/device/assertions','POST',exchangeInput,{authorization:`Bearer ${issued.token}`});expect(exchangeResponse.status).toBe(200);const exchanged=parseComponent('DeviceAssertionResponse',await exchangeResponse.json());const assertionVerifier=new ServiceAssertionVerifier(origin,'carbon-database',[{...h.assertionKey,key:h.assertionPublicKey}],{isCurrent:async()=>true,consume:async()=>true});const assertion=await assertionVerifier.verify(exchanged.token,{scope:deviceScope,permission:'metadata.read',...boundRequest,principalKinds:['account']});expect(assertion.principal).toEqual({id:principal.accountId,kind:'account',audience:'cli',credentialId:issued.grant.id,permissionRevision:principal.permissionRevision});expect(assertion.roles).toEqual([]);const liveAuthority=new PostgresServiceAuthority(h.sql);expect(await liveAuthority.isCurrent(assertion)).toBe(true);
    // Registry exchange is a separate contract and audience; neither exchange can mint the other's assertion.
    const registryBinding=(await h.sql`UPDATE service_bindings SET state='ready',remote_resource_id='device-cli-registry-test' WHERE environment_id=${deviceScope.environmentId} AND owner='registry' RETURNING id`)[0];const registryBound={method:'POST' as const,path:registryRequestPath(deviceScope,registryBinding.id,'namespace.get'),bodyDigest:bodyDigest(canonicalRegistryRequest({scope:deviceScope,bindingId:registryBinding.id,command:{kind:'namespace.get'}}))};const registryExchange={audience:'carbon-registry' as const,scope:deviceScope,permission:'metadata.read' as const,request:registryBound};const bearer={authorization:`Bearer ${issued.token}`};
    expect((await h.call('/platform/v1/device/assertions','POST',registryExchange,bearer)).status).toBe(400);expect((await h.call('/platform/v1/device/registry-assertions','POST',exchangeInput,bearer)).status).toBe(400);expect((await h.call('/platform/v1/device/registry-assertions','POST',{...registryExchange,request:boundRequest},bearer)).status).toBe(400);expect((await h.call('/platform/v1/device/assertions','POST',{...exchangeInput,request:registryBound},bearer)).status).toBe(400);expect((await h.call('/platform/v1/device/registry-assertions','POST',registryExchange)).status).toBe(401);expect((await h.call('/platform/v1/device/registry-assertions','POST',registryExchange,{...bearer,origin:'https://attacker.test'})).status).toBe(403);
    const registryExchanged=parseComponent('DeviceAssertionResponse',await (await h.call('/platform/v1/device/registry-assertions','POST',registryExchange,bearer)).json());const registryVerifier=new ServiceAssertionVerifier(origin,'carbon-registry',[{...h.assertionKey,key:h.assertionPublicKey}],{isCurrent:async()=>true,consume:async()=>true});const registryAssertion=await registryVerifier.verify(registryExchanged.token,{scope:deviceScope,permission:'metadata.read',...registryBound,principalKinds:['account']});expect(registryAssertion.aud).toBe('carbon-registry');expect(registryAssertion.principal).toEqual(assertion.principal);expect(registryAssertion.roles).toEqual([]);expect(await liveAuthority.isCurrent(registryAssertion)).toBe(true);
    await expect(assertionVerifier.verify(registryExchanged.token,{scope:deviceScope,permission:'metadata.read',...registryBound,principalKinds:['account']})).rejects.toThrow('Invalid service assertion');await expect(registryVerifier.verify(exchanged.token,{scope:deviceScope,permission:'metadata.read',...boundRequest,principalKinds:['account']})).rejects.toThrow('Invalid service assertion');expect(await liveAuthority.isCurrent({...registryAssertion,aud:'carbon-database'})).toBe(false);expect(await liveAuthority.isCurrent({...assertion,aud:'carbon-registry'})).toBe(false);expect(await liveAuthority.isCurrent({...registryAssertion,request:{...registryBound,path:registryRequestPath(deviceScope,binding.id,'namespace.get')}})).toBe(false);expect(await liveAuthority.isCurrent({...assertion,request:{...boundRequest,path:dataRequestPath(deviceScope,registryBinding.id,'tables.list')}})).toBe(false);
    expect(parseComponent('DeviceTokenResponse',await (await h.call('/platform/v1/device/token','POST',{deviceCode:challenge.deviceCode})).json()).state).toBe('consumed');const retry=parseComponent('DeviceAuthorizationReceipt',await (await h.call('/platform/v1/account/device-authorizations','POST',{kind:'approve',userCode:challenge.userCode},decisionHeaders)).json());expect(retry).toEqual(approved);
    h.restart();const page=parseComponent('DeviceGrantPage',await (await h.call('/platform/v1/account/devices')).json());expect(page.items).toHaveLength(1);expect(JSON.stringify(page)).not.toContain(issued.token);const revokedResponse=await h.call(`/platform/v1/account/devices/${issued.grant.id}`,'POST',{kind:'revoke'},{'if-match':issued.grant.revision,'x-csrf-token':h.cookies.get('__Host-carbon-csrf')!});expect(revokedResponse.status).toBe(200);const revoked=parseComponent('DeviceGrantReceipt',await revokedResponse.json());expect(revoked.grant.status).toBe('revoked');expect(await liveAuthority.isCurrent(assertion)).toBe(false);expect((await h.call('/platform/v1/device/assertions','POST',exchangeInput,{authorization:`Bearer ${issued.token}`})).status).toBe(401);expect(await liveAuthority.isCurrent(registryAssertion)).toBe(false);expect((await h.call('/platform/v1/device/registry-assertions','POST',registryExchange,bearer)).status).toBe(401);expect((await h.sql`SELECT token_hash FROM device_grants WHERE id=${issued.grant.id}`)[0].token_hash).toBeNull();expect(JSON.stringify(await h.sql`SELECT * FROM device_authorization_events WHERE authorization_id=${review.id}`)).not.toContain(issued.token);
    await credentialRejection(verifier.verify(issued.token,deviceScope,'metadata.read'),'invalid');
    const deniedChallenge=parseComponent('DeviceAuthorizationChallenge',await (await h.call('/platform/v1/device/authorizations','POST',requested)).json());const deniedReview=parseComponent('DeviceAuthorizationReview',await (await h.call('/platform/v1/account/device-authorizations/review','POST',{userCode:deniedChallenge.userCode})).json());const deniedResponse=await h.call('/platform/v1/account/device-authorizations','POST',{kind:'deny',userCode:deniedChallenge.userCode},{'if-match':deniedReview.revision,'idempotency-key':crypto.randomUUID(),'x-csrf-token':h.cookies.get('__Host-carbon-csrf')!});expect(parseComponent('DeviceAuthorizationReceipt',await deniedResponse.json()).state).toBe('denied');expect(parseComponent('DeviceTokenResponse',await (await h.call('/platform/v1/device/token','POST',{deviceCode:deniedChallenge.deviceCode})).json()).state).toBe('denied');
    const expiredChallenge=parseComponent('DeviceAuthorizationChallenge',await (await h.call('/platform/v1/device/authorizations','POST',requested)).json());await h.sql`UPDATE device_authorizations SET expires_at=now()-interval '1 second' WHERE device_code_hash=${tokenDigest(expiredChallenge.deviceCode)}`;expect(parseComponent('DeviceTokenResponse',await (await h.call('/platform/v1/device/token','POST',{deviceCode:expiredChallenge.deviceCode})).json()).state).toBe('expired');
    expect((await h.call('/platform/v1/device/authorizations','POST',{...requested,scope:{orgId:crypto.randomUUID()}})).status).toBe(400);
  });

  test('GitHub App repositories persist identifiers only, resolve immutable commits, and deduplicate signed webhooks', async () => {
    const h = await harness(); await h.challenge(); await h.deliver(); await h.complete();
    const orgId = (await organizationResponse(h.createOrganization('Repository team', 'repository-team'))).receipt.id;
    const project = parseComponent('CatalogReceipt', (await (await h.createProject(orgId)).json() as { receipt: unknown }).receipt);
    const org = (await (await h.call(`/platform/v1/orgs/${orgId}`)).json() as { organization: { revision: string } }).organization;
    const installationsPath = `/platform/v1/orgs/${orgId}/repository-installations`; const connectKey=crypto.randomUUID();
    const connectedResponse=await h.call(installationsPath,'POST',{installationId:'42'},{'if-match':org.revision,'idempotency-key':connectKey,'x-csrf-token':h.cookies.get('__Host-carbon-csrf')!});
    expect(connectedResponse.status).toBe(201); const connected=parseComponent('RepositoryInstallationReceipt',(await connectedResponse.json() as {receipt:unknown}).receipt);
    expect(connected.installation.repositories).toHaveLength(1); const selected=connected.installation.repositories[0]!;
    h.restart(); const connectRetry=await h.call(installationsPath,'POST',{installationId:'42'},{'if-match':org.revision,'idempotency-key':connectKey,'x-csrf-token':h.cookies.get('__Host-carbon-csrf')!});
    expect(connectRetry.status).toBe(201); expect((await connectRetry.json() as {receipt:unknown}).receipt).toEqual(connected);
    expect(parseComponent('RepositoryInstallationPage',await (await h.call(installationsPath)).json()).items[0]!.providerInstallationId).toBe('42');
    const projectPath=`/platform/v1/orgs/${orgId}/projects/${project.scope.projectId}/repository`;
    const empty=parseComponent('ProjectRepositoryConfiguration',await (await h.call(projectPath)).json()); expect(empty.state).toBe('unconfigured');
    const configuredResponse=await h.call(projectPath,'POST',{kind:'save',installationId:connected.installation.id,repositoryId:selected.id,branch:'main',rootDirectory:'.',pushTrigger:true,pullRequestTrigger:true},{'if-match':empty.projectRevision,'x-csrf-token':h.cookies.get('__Host-carbon-csrf')!});
    expect(configuredResponse.status).toBe(200); const configured=parseComponent('ProjectRepositoryReceipt',(await configuredResponse.json() as {receipt:unknown}).receipt); expect(configured.configuration.state).toBe('ready');
    const resolved=parseComponent('ResolvedRepositoryCommit',await (await h.call(`${projectPath}/resolve`,'POST',{ref:'release/v1'},{'x-csrf-token':h.cookies.get('__Host-carbon-csrf')!})).json());
    expect(resolved.sha).toBe('b'.repeat(40)); expect(resolved.repositoryId).toBe(selected.id);
    expect((await h.sql`SELECT requested_ref,commit_sha FROM repository_commit_resolutions WHERE project_id=${project.scope.projectId}`)[0]).toEqual({requested_ref:'release/v1',commit_sha:'b'.repeat(40)});
    expect((await h.sql`SELECT count(*)::integer AS count FROM information_schema.columns WHERE table_name IN ('repository_installations','repositories','project_repository_configs') AND column_name ~ '(token|secret|private_key)'`)[0].count).toBe(0);
    expect(JSON.stringify(await h.sql`SELECT * FROM repository_commands`)).not.toContain('repository-webhook-secret');
    const proposalKey=crypto.randomUUID();const proposalInput={path:'carbon/app.json',content:'{"name":"desktop"}',title:'Update Carbon app',message:'Update Carbon app configuration'};
    const proposalResponse=await h.call(`${projectPath}/proposal`,'POST',proposalInput,{'if-match':configured.configuration.revision,'idempotency-key':proposalKey,'x-csrf-token':h.cookies.get('__Host-carbon-csrf')!});expect(proposalResponse.status).toBe(201);const proposal=parseComponent('RepositoryProposalReceipt',await proposalResponse.json());expect(proposal.pullRequestNumber).toBe(12);expect(proposal.branch).toMatch(/^carbon\/proposal-[a-f0-9]{32}$/);
    h.restart();const proposalRetry=parseComponent('RepositoryProposalReceipt',await (await h.call(`${projectPath}/proposal`,'POST',proposalInput,{'if-match':configured.configuration.revision,'idempotency-key':proposalKey,'x-csrf-token':h.cookies.get('__Host-carbon-csrf')!})).json());expect(proposalRetry).toEqual(proposal);expect(JSON.stringify(await h.sql`SELECT * FROM repository_commands`)).not.toContain(proposalInput.content);
    h.setRepositoryAvailable(false); const payload={installation:{id:42}}; const raw=JSON.stringify(payload); const signature='sha256='+createHmac('sha256','repository-webhook-secret').update(raw).digest('hex'); const delivery=crypto.randomUUID();
    const webhookHeaders={'x-hub-signature-256':signature,'x-github-delivery':delivery,'x-github-event':'installation_repositories',origin:'https://github.com','sec-fetch-site':'cross-site'};
    const first=parseComponent('RepositoryWebhookReceipt',await (await h.call('/platform/v1/webhooks/github','POST',payload,webhookHeaders)).json()); expect(first).toEqual({accepted:true,duplicate:false});
    const duplicate=parseComponent('RepositoryWebhookReceipt',await (await h.call('/platform/v1/webhooks/github','POST',payload,webhookHeaders)).json()); expect(duplicate).toEqual({accepted:true,duplicate:true});
    const changedPayload={installation:{id:42},action:'changed'}; const changedRaw=JSON.stringify(changedPayload); const changedSignature='sha256='+createHmac('sha256','repository-webhook-secret').update(changedRaw).digest('hex');
    expect((await h.call('/platform/v1/webhooks/github','POST',changedPayload,{...webhookHeaders,'x-hub-signature-256':changedSignature})).status).toBe(409);
    const deletedPayload={installation:{id:42},action:'deleted'};const deletedRaw=JSON.stringify(deletedPayload);const deletedSignature='sha256='+createHmac('sha256','repository-webhook-secret').update(deletedRaw).digest('hex');
    expect((await h.call('/platform/v1/webhooks/github','POST',deletedPayload,{...webhookHeaders,'x-github-delivery':crypto.randomUUID(),'x-github-event':'installation','x-hub-signature-256':deletedSignature})).status).toBe(202);
    expect(parseComponent('ProjectRepositoryConfiguration',await (await h.call(projectPath)).json()).state).toBe('disconnected');
    expect((await h.sql`SELECT count(*)::integer AS count FROM repository_webhook_deliveries WHERE delivery_id=${delivery}`)[0].count).toBe(1);
    expect((await h.sql`SELECT state FROM repository_installations WHERE id=${connected.installation.id}`)[0].state).toBe('suspended');
    expect(h.repositoryStats()).toEqual({refreshes:7,resolutions:1,proposals:1});
  });

  test('environment credentials disclose once, persist only hashes, enforce scope, overlap rotation, and revoke live access', async () => {
    const h = await harness(); await h.challenge(); await h.deliver(); await h.complete();
    const orgId = (await organizationResponse(h.createOrganization('Credential team', 'credential-team'))).receipt.id;
    const catalog = parseComponent('CatalogReceipt', (await (await h.createProject(orgId)).json() as { receipt: unknown }).receipt);
    const scope = parseComponent('EnvironmentScope', catalog.scope);
    const path = `/platform/v1/orgs/${scope.orgId}/projects/${scope.projectId}/environments/${scope.environmentId}/credentials`;
    const expiresAt = new Date(Date.now() + 3600000).toISOString(); const createKey = crypto.randomUUID();
    const createdResponse = await h.call(path, 'POST', { name: 'CI reader', permissions: ['data.read', 'metadata.read'], expiresAt }, {
      'if-match': '"1"', 'idempotency-key': createKey, 'x-csrf-token': h.cookies.get('__Host-carbon-csrf')!,
    });
    expect(createdResponse.status).toBe(201);
    const created = parseComponent('EnvironmentCredentialIssue', await createdResponse.json());
    expect(created.token).toMatch(/^ce_[A-Za-z0-9_-]{43}$/); expect(created.credential.prefix).toBe(created.token.slice(0, 11));
    expect(created.credential.permissions).toEqual(['data.read', 'metadata.read']);

    const stored = (await h.sql`SELECT c.created_by, token_hash, token_prefix, permissions, result FROM environment_credentials c
      JOIN environment_credential_commands command ON command.credential_id = c.id WHERE c.id = ${created.credential.id}`)[0];
    expect(stored.token_hash).toBe(createHash('sha256').update(created.token).digest('hex'));
    expect(stored.token_prefix).toBe(created.token.slice(0, 11));
    expect(JSON.stringify(stored)).not.toContain(created.token);
    expect(JSON.stringify(await h.sql`SELECT * FROM environment_credential_events WHERE credential_id = ${created.credential.id}`)).not.toContain(created.token);
    const verifier = new EnvironmentCredentialAuthentication(new PostgresEnvironmentCredentialRepository(h.sql));
    expect((await verifier.verify(created.token, scope, 'data.read')).credentialId).toBe(created.credential.id);
    await credentialRejection(verifier.verify(created.token, { ...scope, environmentId: crypto.randomUUID() }, 'data.read'), 'invalid');
    await credentialRejection(verifier.verify(created.token, scope, 'data.write'), 'invalid');

    const page = parseComponent('EnvironmentCredentialPage', await (await h.call(path)).json());
    expect(page.items).toEqual([{ ...created.credential, lastUsedAt: expect.any(String) }]);
    expect(JSON.stringify(page)).not.toContain(created.token);
    h.restart();
    const duplicate = await h.call(path, 'POST', { name: 'CI reader', permissions: ['data.read', 'metadata.read'], expiresAt }, {
      'if-match': '"1"', 'idempotency-key': createKey, 'x-csrf-token': h.cookies.get('__Host-carbon-csrf')!,
    });
    expect(duplicate.status).toBe(409); expect(JSON.stringify(await duplicate.json())).not.toContain(created.token);
    const backupOwner = crypto.randomUUID();
    await h.sql.begin(async tx => {
      await tx`INSERT INTO accounts (id, primary_email, name, verified_at, terms_version) VALUES (${backupOwner}, ${`${backupOwner}@example.test`}, 'Backup owner', now(), 'fixture')`;
      await tx`INSERT INTO memberships (id, account_id, org_id, role, state) VALUES (${crypto.randomUUID()}, ${backupOwner}, ${scope.orgId}, 'Owner', 'active')`;
      await tx`UPDATE memberships SET role = 'Developer' WHERE org_id = ${scope.orgId} AND account_id = ${stored.created_by}`;
    });
    const excessive = await h.call(path, 'POST', { name: 'Writer', permissions: ['data.write'], expiresAt }, {
      'if-match': '"1"', 'x-csrf-token': h.cookies.get('__Host-carbon-csrf')!,
    });
    expect(excessive.status).toBe(403);
    expect((await h.sql`SELECT count(*)::integer AS count FROM environment_credentials WHERE environment_id = ${scope.environmentId}`)[0].count).toBe(1);

    const rotateKey = crypto.randomUUID();
    const rotatedResponse = await h.call(`${path}/${created.credential.id}`, 'POST', { kind: 'rotate', expiresAt, overlapSeconds: 60 }, {
      'if-match': `"${created.credential.revision}"`, 'idempotency-key': rotateKey, 'x-csrf-token': h.cookies.get('__Host-carbon-csrf')!,
    });
    expect(rotatedResponse.status).toBe(200);
    const rotated = parseComponent('EnvironmentCredentialIssue', await rotatedResponse.json());
    expect(rotated.token).not.toBe(created.token); expect(rotated.credential.revision).toBe('2'); expect(rotated.credential.overlapEndsAt).not.toBeNull();
    expect((await verifier.verify(created.token, scope, 'data.read')).credentialId).toBe(created.credential.id);
    expect((await verifier.verify(rotated.token, scope, 'data.read')).credentialId).toBe(created.credential.id);
    await h.sql`UPDATE environment_credential_overlaps SET valid_until = now() - interval '1 second' WHERE credential_id = ${created.credential.id}`;
    await credentialRejection(verifier.verify(created.token, scope, 'data.read'), 'invalid');
    const rotateRetry = await h.call(`${path}/${created.credential.id}`, 'POST', { kind: 'rotate', expiresAt, overlapSeconds: 60 }, {
      'if-match': `"${created.credential.revision}"`, 'idempotency-key': rotateKey, 'x-csrf-token': h.cookies.get('__Host-carbon-csrf')!,
    });
    expect(rotateRetry.status).toBe(409); expect(JSON.stringify(await rotateRetry.json())).not.toContain(rotated.token);

    const revokeKey = crypto.randomUUID();
    const revokedResponse = await h.call(`${path}/${created.credential.id}`, 'POST', { kind: 'revoke' }, {
      'if-match': `"${rotated.credential.revision}"`, 'idempotency-key': revokeKey, 'x-csrf-token': h.cookies.get('__Host-carbon-csrf')!,
    });
    expect(revokedResponse.status).toBe(200);
    const revoked = parseComponent('EnvironmentCredentialReceipt', await revokedResponse.json());
    expect(revoked.credential.status).toBe('revoked'); expect(revoked.credential.revision).toBe('3');
    await credentialRejection(verifier.verify(rotated.token, scope, 'data.read'), 'revoked');
    const revokeRetry = await h.call(`${path}/${created.credential.id}`, 'POST', { kind: 'revoke' }, {
      'if-match': `"${rotated.credential.revision}"`, 'idempotency-key': revokeKey, 'x-csrf-token': h.cookies.get('__Host-carbon-csrf')!,
    });
    expect(revokeRetry.status).toBe(200); expect(await revokeRetry.json()).toEqual(revoked);
    expect((await h.sql`SELECT count(*)::integer AS count FROM environment_credential_events WHERE credential_id = ${created.credential.id}`)[0].count).toBe(3);
  });

  test('environment secrets keep versioned envelopes and expose metadata only across create, rotate, disable, and retries', async () => {
    const h = await harness(); await h.challenge(); await h.deliver(); await h.complete();
    const orgId = (await organizationResponse(h.createOrganization('Secret team', 'secret-team'))).receipt.id;
    const catalog = parseComponent('CatalogReceipt', (await (await h.createProject(orgId)).json() as { receipt: unknown }).receipt);
    const scope = parseComponent('EnvironmentScope', catalog.scope);
    const path = `/platform/v1/orgs/${scope.orgId}/projects/${scope.projectId}/environments/${scope.environmentId}/secrets`;
    const firstValue = 'postgres://service:first-password@example.test/db'; const createKey = crypto.randomUUID();
    const createdResponse = await h.call(path, 'POST', { name: 'DATABASE_URL', value: firstValue }, {
      'if-match': '"1"', 'idempotency-key': createKey, 'x-csrf-token': h.cookies.get('__Host-carbon-csrf')!,
    });
    expect(createdResponse.status).toBe(201);
    const created = parseComponent('EnvironmentSecretReceipt', await createdResponse.json());
    expect(created.secret.currentVersion).toBe(1); expect(JSON.stringify(created)).not.toContain(firstValue);
    const first = (await h.sql`SELECT id, wrapping_key_id, envelope FROM environment_secret_versions WHERE secret_id = ${created.secret.id} AND version = 1`)[0];
    expect(first.wrapping_key_id).toBe('secret-test-key'); expect(first.envelope).not.toContain(firstValue);
    expect(await h.secretProtector.open({ wrappingKeyId: first.wrapping_key_id, envelope: first.envelope }, `environment-secret:${created.secret.id}:version:${first.id}`)).toBe(firstValue);
    await credentialRejection(h.secretProtector.open({ wrappingKeyId: first.wrapping_key_id, envelope: first.envelope }, `environment-secret:${created.secret.id}:version:${crypto.randomUUID()}`), 'Cannot decrypt');
    expect(JSON.stringify(await h.sql`SELECT * FROM environment_secret_commands WHERE secret_id = ${created.secret.id}`)).not.toContain(firstValue);
    expect(JSON.stringify(await h.sql`SELECT * FROM environment_secret_events WHERE secret_id = ${created.secret.id}`)).not.toContain(firstValue);
    expect((await h.call(path, 'POST', { name: 'TOO_LARGE', value: '💣'.repeat(17000) }, {
      'if-match': '"1"', 'x-csrf-token': h.cookies.get('__Host-carbon-csrf')!,
    })).status).toBe(400);

    const page = parseComponent('EnvironmentSecretPage', await (await h.call(path)).json());
    expect(page.items).toEqual([created.secret]); expect(JSON.stringify(page)).not.toContain('envelope');
    expect((await h.call(path.replace(scope.environmentId, crypto.randomUUID()))).status).toBe(404);
    h.restart();
    const retry = await h.call(path, 'POST', { name: 'DATABASE_URL', value: firstValue }, {
      'if-match': '"1"', 'idempotency-key': createKey, 'x-csrf-token': h.cookies.get('__Host-carbon-csrf')!,
    });
    expect(retry.status).toBe(201); expect(await retry.json()).toEqual(created);
    expect((await h.sql`SELECT count(*)::integer AS count FROM environment_secret_versions WHERE secret_id = ${created.secret.id}`)[0].count).toBe(1);

    const secondValue = 'postgres://service:replacement-password@example.test/db'; const rotateKey = crypto.randomUUID();
    const rotatedResponse = await h.call(`${path}/${created.secret.id}`, 'POST', { kind: 'rotate', value: secondValue }, {
      'if-match': `"${created.secret.revision}"`, 'idempotency-key': rotateKey, 'x-csrf-token': h.cookies.get('__Host-carbon-csrf')!,
    });
    expect(rotatedResponse.status).toBe(200);
    const rotated = parseComponent('EnvironmentSecretReceipt', await rotatedResponse.json());
    expect(rotated.secret.currentVersion).toBe(2); expect(rotated.secret.revision).toBe('2'); expect(JSON.stringify(rotated)).not.toContain(secondValue);
    const versions = await h.sql`SELECT id, version, wrapping_key_id, envelope FROM environment_secret_versions WHERE secret_id = ${created.secret.id} ORDER BY version`;
    expect(versions).toHaveLength(2);
    expect(await h.secretProtector.open({ wrappingKeyId: versions[1].wrapping_key_id, envelope: versions[1].envelope }, `environment-secret:${created.secret.id}:version:${versions[1].id}`)).toBe(secondValue);
    const conflictValue = 'must-never-appear-in-errors';
    const nameConflict = await h.call(path, 'POST', { name: 'DATABASE_URL', value: conflictValue }, {
      'if-match': '"1"', 'x-csrf-token': h.cookies.get('__Host-carbon-csrf')!,
    });
    expect(nameConflict.status).toBe(409); expect(JSON.stringify(await nameConflict.json())).not.toContain(conflictValue);

    const disabledResponse = await h.call(`${path}/${created.secret.id}`, 'POST', { kind: 'disable', disabled: true }, {
      'if-match': `"${rotated.secret.revision}"`, 'x-csrf-token': h.cookies.get('__Host-carbon-csrf')!,
    });
    expect(disabledResponse.status).toBe(200);
    const disabled = parseComponent('EnvironmentSecretReceipt', await disabledResponse.json());
    expect(disabled.secret.state).toBe('disabled'); expect(disabled.secret.currentVersion).toBe(2); expect(disabled.secret.revision).toBe('3');
    const denied = await h.call(`${path}/${created.secret.id}`, 'POST', { kind: 'disable', disabled: false }, { 'if-match': '"3"' });
    expect(denied.status).toBe(403);
    expect((await h.sql`SELECT count(*)::integer AS count FROM environment_secret_events WHERE secret_id = ${created.secret.id}`)[0].count).toBe(3);
  });

  test('sibling catalog progress does not invalidate provisioning, while configuration changes require review without losing remote success', async () => {
    const h = await harness(); await h.challenge(); await h.deliver(); await h.complete();
    const org = (await organizationResponse(h.createOrganization('Sibling team', 'sibling-team'))).receipt.id;
    const created = parseComponent('CatalogReceipt', (await (await h.createProject(org)).json() as { receipt: unknown }).receipt);
    const base = `/platform/v1/orgs/${org}/projects/${created.scope.projectId}`;
    const envPath = `${base}/environments/${created.scope.environmentId}`;
    expect((await h.catalogCommand(`${base}/environments`, { name: 'Staging', kind: 'staging', services: ['database'] }, '1')).status).toBe(202);
    expect((await h.createProject(org, 'Other', 'other')).status).toBe(202);
    let calls = 0; const provider = { apply: async (work: ProvisioningWork) => {
      calls++; return { scope: work.scope, remoteResourceId: `${work.owner}-${work.scope.environmentId}`, state: work.action === 'pause' ? 'paused' as const : 'active' as const };
    } };
    const repo = new PostgresProvisioningRepository(h.sql); const worker = new ProvisionEnvironment(repo, { database: provider, registry: provider });
    for (let i = 0; i < 5; i++) expect(await worker.execute()).toBe(true);
    expect(await worker.execute()).toBe(false); expect(calls).toBe(5);
    expect((await h.sql`SELECT id FROM operations WHERE state = 'succeeded'`)).toHaveLength(3);
    let detail = parseComponent('CatalogEnvironmentDetails', await (await h.call(envPath)).json());
    expect((await h.catalogCommand(envPath, { kind: 'pause', paused: true }, detail.environment.revision)).status).toBe(202);
    await worker.execute(); await worker.execute();
    detail = parseComponent('CatalogEnvironmentDetails', await (await h.call(envPath)).json());
    const resumed = await h.catalogCommand(envPath, { kind: 'pause', paused: false }, detail.environment.revision); expect(resumed.status).toBe(202);
    const receipt = parseComponent('CatalogReceipt', (await resumed.json() as { receipt: unknown }).receipt);
    const operationPath = `${envPath}/operations/${receipt.operationId}`;
    await worker.execute(); const inFlight = await repo.claim() as ProvisioningWork;
    const p = parseComponent('CatalogProject', await (await h.call(base)).json());
    expect((await h.catalogCommand(base, { kind: 'update', name: 'Reviewed', slug: 'reviewed' }, p.revision)).status).toBe(200);
    expect(await repo.complete(inFlight, { value: { scope: inFlight.scope, remoteResourceId: inFlight.remoteResourceId!, state: 'active' } })).toBe(true);
    const interrupted = parseComponent('Operation', await (await h.call(operationPath)).json());
    expect(interrupted.state).toBe('partially_succeeded'); expect(interrupted.progress).toBe(100);
    detail = parseComponent('CatalogEnvironmentDetails', await (await h.call(envPath)).json());
    expect(detail.environment.state).toBe('paused'); expect(detail.environment.provisioning).toBe('degraded');
    expect(detail.bindings.every(binding => binding.state === 'ready')).toBe(true);
    expect((await h.catalogCommand(operationPath, { kind: 'retry' }, interrupted.revision)).status).toBe(202);
    const before = calls; expect(await worker.execute()).toBe(true); expect(calls).toBe(before);
    detail = parseComponent('CatalogEnvironmentDetails', await (await h.call(envPath)).json());
    expect(detail.environment.state).toBe('active'); expect(detail.environment.provisioning).toBe('ready');
  });

  test('provisioning preserves completed services across failure and restart, retries only incomplete work, and reconciles pause/resume', async () => {
    const h = await harness(); await h.challenge(); await h.deliver(); await h.complete();
    const org = (await organizationResponse(h.createOrganization('Provision team', 'provision-team'))).receipt.id;
    const created = parseComponent('CatalogReceipt', (await (await h.createProject(org)).json() as { receipt: unknown }).receipt);
    const base = `/platform/v1/orgs/${org}/projects/${created.scope.projectId}`;
    const envPath = `${base}/environments/${created.scope.environmentId}`; const operationPath = `${envPath}/operations/${created.operationId}`;
    const calls: ProvisioningWork[] = []; let registryFails = true;
    const provider = { apply: async (work: ProvisioningWork) => {
      calls.push(work); if (work.owner === 'registry' && registryFails) throw new Error('Provider secret must never escape');
      return { scope: work.scope, remoteResourceId: `${work.owner}-${work.scope.environmentId}`, state: work.action === 'pause' ? 'paused' as const : 'active' as const };
    } };
    const worker = () => new ProvisionEnvironment(new PostgresProvisioningRepository(h.sql), { database: provider, registry: provider });
    expect(await worker().execute()).toBe(true); expect(await worker().execute()).toBe(true); expect(await worker().execute()).toBe(false);
    let operation = parseComponent('Operation', await (await h.call(operationPath)).json());
    expect(operation.state).toBe('partially_succeeded'); expect(operation.progress).toBe(50); expect(operation.results).toHaveLength(1);
    expect(JSON.stringify(operation)).not.toContain('Provider secret');
    let details = parseComponent('CatalogEnvironmentDetails', await (await h.call(envPath)).json());
    expect(details.environment.provisioning).toBe('degraded');
    expect(details.bindings.map(b => b.state)).toEqual(['ready', 'failed']);
    h.restart(); registryFails = false;
    const retryKey = crypto.randomUUID(); const retryRev = operation.revision;
    expect((await h.catalogCommand(operationPath, { kind: 'retry' }, retryRev, { 'idempotency-key': retryKey })).status).toBe(202);
    expect((await h.catalogCommand(operationPath, { kind: 'retry' }, retryRev, { 'idempotency-key': retryKey })).status).toBe(202);
    expect(await worker().execute()).toBe(true); expect(await worker().execute()).toBe(false);
    expect(calls.map(call => call.owner)).toEqual(['database', 'registry', 'registry']);
    expect(calls[1]!.stepId).toBe(calls[2]!.stepId);
    operation = parseComponent('Operation', await (await h.call(operationPath)).json());
    expect(operation.state).toBe('succeeded'); expect(operation.steps.map(s => s.attempt)).toEqual([1, 2]);
    expect(operation.progress).toBe(100); expect(operation.results).toHaveLength(2);
    details = parseComponent('CatalogEnvironmentDetails', await (await h.call(envPath)).json()); expect(details.environment.provisioning).toBe('ready');
    expect((await h.catalogCommand(operationPath, { kind: 'retry' }, operation.revision)).status).toBe(409);
    const pause = await h.catalogCommand(envPath, { kind: 'pause', paused: true }, details.environment.revision); expect(pause.status).toBe(202);
    expect(parseComponent('CatalogEnvironmentDetails', await (await h.call(envPath)).json()).environment.state).toBe('paused');
    expect(await worker().execute()).toBe(true); expect(await worker().execute()).toBe(true);
    details = parseComponent('CatalogEnvironmentDetails', await (await h.call(envPath)).json());
    expect(details.bindings.every(b => b.state === 'paused')).toBe(true); expect(details.environment.provisioning).toBe('ready');
    const resume = await h.catalogCommand(envPath, { kind: 'pause', paused: false }, details.environment.revision); expect(resume.status).toBe(202);
    expect(parseComponent('CatalogEnvironmentDetails', await (await h.call(envPath)).json()).environment.state).toBe('paused');
    expect(await worker().execute()).toBe(true); expect(await worker().execute()).toBe(true);
    details = parseComponent('CatalogEnvironmentDetails', await (await h.call(envPath)).json());
    expect(details.environment.state).toBe('active'); expect(details.environment.provisioning).toBe('ready');
    expect(details.bindings.map(b => b.remoteResourceId)).toEqual([`database-${created.scope.environmentId}`, `registry-${created.scope.environmentId}`]);
    expect(await h.sql`SELECT id FROM operation_attempts WHERE outcome = 'succeeded'`).toHaveLength(6);
  });

  test('provisioning fences expired leases, retains completed in-flight work on cancellation and refuses foreign provider bindings', async () => {
    const h = await harness(); await h.challenge(); await h.deliver(); await h.complete();
    const org = (await organizationResponse(h.createOrganization('Lease team', 'lease-team'))).receipt.id;
    const created = parseComponent('CatalogReceipt', (await (await h.createProject(org)).json() as { receipt: unknown }).receipt);
    const envPath = `/platform/v1/orgs/${org}/projects/${created.scope.projectId}/environments/${created.scope.environmentId}`;
    const operationPath = `${envPath}/operations/${created.operationId}`; const repo = new PostgresProvisioningRepository(h.sql);
    const claims = await Promise.all([repo.claim(), repo.claim(), repo.claim()]);
    const first = claims.find(claim => claim && claim !== 'settled') as ProvisioningWork;
    expect(claims.filter(Boolean)).toHaveLength(1);
    await h.sql`UPDATE operations SET lease_expires_at = now() - interval '1 second' WHERE id = ${created.operationId!}`;
    const second = await repo.claim() as ProvisioningWork;
    expect(first.stepId).toBe(second.stepId); expect(first.leaseId).not.toBe(second.leaseId);
    const result = { scope: second.scope, remoteResourceId: `database-${second.scope.environmentId}`, state: 'active' as const };
    expect(await repo.complete(first, { value: result })).toBe(false);
    const operation = parseComponent('Operation', await (await h.call(operationPath)).json());
    expect((await h.catalogCommand(operationPath, { kind: 'cancel' }, operation.revision)).status).toBe(202);
    expect(await repo.complete(second, { value: result })).toBe(true);
    const cancelled = parseComponent('Operation', await (await h.call(operationPath)).json());
    expect(cancelled.state).toBe('partially_succeeded'); expect(cancelled.cancellationRequested).toBe(true);
    expect(cancelled.steps.map(step => step.state)).toEqual(['succeeded', 'cancelled']);
    expect(await repo.claim()).toBeNull();
    expect((await h.sql`SELECT outcome FROM operation_attempts ORDER BY attempt`).map((r: { outcome: string }) => r.outcome)).toEqual(['interrupted', 'succeeded']);
    expect((await h.catalogCommand(operationPath, { kind: 'retry' }, cancelled.revision)).status).toBe(202);
    const corrupt = new ProvisionEnvironment(repo, { registry: { apply: async work => ({ scope: { ...work.scope, orgId: crypto.randomUUID() }, remoteResourceId: 'foreign-resource', state: 'active' }) } });
    expect(await corrupt.execute()).toBe(true);
    const details = parseComponent('CatalogEnvironmentDetails', await (await h.call(envPath)).json());
    expect(details.bindings.map(b => b.state)).toEqual(['ready', 'failed']);
    expect(details.bindings[1]!.remoteResourceId).toBeNull();
  });

  test('provisioning rechecks account authority between steps and leaves missing services explicitly unavailable', async () => {
    const h = await harness(); await h.challenge(); await h.deliver(); await h.complete();
    const org = (await organizationResponse(h.createOrganization('Authority team', 'authority-team'))).receipt.id;
    const created = parseComponent('CatalogReceipt', (await (await h.createProject(org)).json() as { receipt: unknown }).receipt);
    const base = `/platform/v1/orgs/${org}/projects/${created.scope.projectId}`;
    const envPath = `${base}/environments/${created.scope.environmentId}`; const operationPath = `${envPath}/operations/${created.operationId}`;
    let calls = 0; const repo = new PostgresProvisioningRepository(h.sql);
    const provider = { apply: async (work: ProvisioningWork) => { calls++; return { scope: work.scope, remoteResourceId: `${work.owner}-${work.scope.environmentId}`, state: 'active' as const }; } };
    const worker = new ProvisionEnvironment(repo, { database: provider, registry: provider });
    expect(await worker.execute()).toBe(true);
    // Account security rotation revokes the originating session without deleting committed work.
    expect((await h.security({ kind: 'session-rotate' })).status).toBe(200);
    expect(await worker.execute()).toBe(true); expect(calls).toBe(1);
    let operation = parseComponent('Operation', await (await h.call(operationPath)).json());
    expect(operation.state).toBe('partially_succeeded'); expect(operation.error).toBeDefined();
    expect((await h.catalogCommand(operationPath, { kind: 'retry' }, operation.revision)).status).toBe(202);
    const unconfigured = new ProvisionEnvironment(new PostgresProvisioningRepository(h.sql), {});
    expect(await unconfigured.execute()).toBe(true);
    operation = parseComponent('Operation', await (await h.call(operationPath)).json());
    expect(operation.error?.code).toBe('capability'); expect(operation.state).toBe('partially_succeeded');
    expect(parseComponent('CatalogEnvironmentDetails', await (await h.call(envPath)).json()).bindings[0]!.state).toBe('ready');
    expect((await h.catalogCommand(operationPath, { kind: 'retry' }, operation.revision)).status).toBe(202);
    expect(await worker.execute()).toBe(true); expect(calls).toBe(2);
    expect(parseComponent('Operation', await (await h.call(operationPath)).json()).state).toBe('succeeded');
  });

  test('canonical project creation commits identity and provisioning intents once and scopes catalog pages and operations', async () => {
    const h = await harness(); await h.challenge(); await h.deliver(); await h.complete();
    const org = (await organizationResponse(h.createOrganization('Catalog team', 'catalog-team'))).receipt.id;
    const key = crypto.randomUUID();
    const responses = await Promise.all([h.createProject(org, 'App', 'app', { 'idempotency-key': key }), h.createProject(org, 'App', 'app', { 'idempotency-key': key })]);
    expect(responses.map(r => r.status)).toEqual([202, 202]);
    const body = await responses[0]!.json() as { receipt: unknown }; const created = parseComponent('CatalogReceipt', body.receipt);
    expect(await responses[1]!.json()).toEqual(body);
    expect(created.scope.projectId).toBeString(); expect(created.scope.environmentId).toBeString(); expect(created.operationId).toBeString();
    const base = `/platform/v1/orgs/${org}/projects/${created.scope.projectId}`; const envPath = `${base}/environments/${created.scope.environmentId}`;
    const operationPath = `${envPath}/operations/${created.operationId}`;
    expect(responses[0]!.headers.get('location')).toBe(operationPath);
    h.restart(); const detail = parseComponent('CatalogProject', await (await h.call(base)).json());
    expect(detail).toMatchObject({ id: created.scope.projectId!, orgId: org, name: 'App', state: 'active', productionMutationsAllowed: false });
    const environment = parseComponent('CatalogEnvironmentDetails', await (await h.call(envPath)).json());
    expect(environment.environment.provisioning).toBe('pending'); expect(environment.bindings).toHaveLength(2);
    expect(environment.bindings.every(binding => binding.state === 'pending' && binding.remoteResourceId === null)).toBe(true);
    const operation = parseComponent('Operation', await (await h.call(operationPath)).json());
    expect(operation.state).toBe('queued'); expect(operation.progress).toBe(0); expect(operation.steps.map(s => s.kind)).toEqual(['database.ensure', 'registry.ensure']);
    expect(await h.sql`SELECT id FROM projects`).toHaveLength(1); expect(await h.sql`SELECT id FROM environments`).toHaveLength(1);
    expect(await h.sql`SELECT id FROM operations`).toHaveLength(1); expect(await h.sql`SELECT id FROM catalog_events`).toHaveLength(1);
    const live = parseComponent('AccessSnapshot', await (await h.call(`/platform/v1/orgs/${org}/access?projectId=${created.scope.projectId}`)).json());
    expect(operation.actor.permissionRevision).toBe(live.permissionRevision);
    const oldRevision = '1';
    expect((await h.catalogCommand(`/platform/v1/orgs/${org}/projects`, { name: 'Different', slug: 'different', services: ['database', 'registry'] }, oldRevision, { 'idempotency-key': key })).status).toBe(409);
    expect((await h.createProject(org, 'Duplicate', 'app')).status).toBe(409);
    expect(await h.sql`SELECT id FROM projects`).toHaveLength(1);
    const second = await h.createProject(org, 'Second', 'second'); expect(second.status).toBe(202);
    const page = parseComponent('CatalogProjectPage', await (await h.call(`/platform/v1/orgs/${org}/projects?limit=1`)).json());
    expect(page.items).toHaveLength(1); expect(page.nextCursor).toBeString();
    const next = parseComponent('CatalogProjectPage', await (await h.call(`/platform/v1/orgs/${org}/projects?limit=1&cursor=${encodeURIComponent(page.nextCursor!)}`)).json());
    expect(next.items).toHaveLength(1); expect(next.items[0]!.id).not.toBe(page.items[0]!.id);
    const changed = await h.catalogCommand(base, { kind: 'update', name: 'Renamed', slug: 'renamed' }, detail.revision); expect(changed.status).toBe(200);
    expect((await h.call(`/platform/v1/orgs/${org}/projects?limit=1&cursor=${encodeURIComponent(page.nextCursor!)}`)).status).toBe(409);
    const foreign = (await organizationResponse(h.createOrganization('Foreign', 'foreign'))).receipt.id;
    expect((await h.call(base.replace(org, foreign))).status).toBe(404);
    expect((await h.call(operationPath.replace(org, foreign))).status).toBe(404);
    expect((await h.call(operationPath.replace(created.scope.environmentId!, crypto.randomUUID()))).status).toBe(404);
    expect((await h.call(`${base}?unexpected=true`)).status).toBe(400);
    expect((await h.call(`/platform/v1/orgs/${org}/projects?limit=1&limit=2`)).status).toBe(400);
    expect((await h.catalogCommand(envPath, { kind: 'pause', paused: true }, '1')).status).toBe(409);
    const archive = await h.catalogCommand(base, { kind: 'archive', archived: true, confirmation: 'renamed' }, '2'); expect(archive.status).toBe(200);
    expect((await h.catalogCommand(`${base}/environments`, { name: 'Staging', kind: 'staging', services: ['database'] }, '3')).status).toBe(403);
    // Safety cancellation remains available when project writes have stopped.
    expect((await h.catalogCommand(operationPath, { kind: 'cancel' }, '1')).status).toBe(202);
    expect(parseComponent('Operation', await (await h.call(operationPath)).json()).state).toBe('cancel_requested');
    const archived = parseComponent('CatalogProject', await (await h.call(base)).json());
    expect((await h.catalogCommand(base, { kind: 'archive', archived: false, confirmation: 'renamed' }, archived.revision)).status).toBe(200);
  });

  test('catalog creation honors explicit Developer grants, production confirmation and live membership removal', async () => {
    const h = await harness(); await h.challenge('catalog-owner@example.test'); await h.deliver(); await h.complete();
    const org = (await organizationResponse(h.createOrganization('Developer team', 'developer-team'))).receipt.id;
    const existing = parseComponent('CatalogReceipt', (await (await h.createProject(org)).json() as { receipt: unknown }).receipt);
    const owner = new Map(h.cookies);
    await h.invitation(org, { kind: 'create', email: 'developer@example.test', role: 'Developer' }); await h.deliver(); const proof = h.invitationToken();
    await h.challenge('developer@example.test'); await h.deliver(); await h.complete(); expect((await h.invitationProof(proof)).status).toBe(200);
    const developer = new Map(h.cookies); const member = (await h.sql`SELECT id FROM memberships WHERE org_id = ${org} AND role = 'Developer'`)[0].id;
    expect(parseComponent('CatalogProjectPage', await (await h.call(`/platform/v1/orgs/${org}/projects`)).json()).items).toHaveLength(0);
    expect((await h.createProject(org, 'Denied', 'denied')).status).toBe(403);
    h.restoreCookies(owner);
    expect((await h.organizationCommand(org, { kind: 'member-access', membershipId: member, projectAccess: 'assigned', projectIds: [], grants: [{ permission: 'projects.create', scope: { orgId: org } }] })).status).toBe(200);
    h.restoreCookies(developer); const createdResponse = await h.createProject(org, 'Developer app', 'developer-app'); expect(createdResponse.status).toBe(202);
    const created = parseComponent('CatalogReceipt', (await createdResponse.json() as { receipt: unknown }).receipt);
    const base = `/platform/v1/orgs/${org}/projects/${created.scope.projectId}`;
    expect(parseComponent('CatalogProjectPage', await (await h.call(`/platform/v1/orgs/${org}/projects`)).json()).items.map(p => p.id)).toEqual([created.scope.projectId!]);
    expect((await h.call(`/platform/v1/orgs/${org}/projects/${existing.scope.projectId}`)).status).toBe(404);
    const production = { name: 'Production', kind: 'production', services: ['database'], productionConfirmation: 'developer-app' };
    expect((await h.catalogCommand(`${base}/environments`, production, '1')).status).toBe(403);
    expect((await h.catalogCommand(base, { kind: 'production-policy', allowed: true, confirmation: 'developer-app' }, '1')).status).toBe(403);
    h.restoreCookies(owner); expect((await h.catalogCommand(base, { kind: 'production-policy', allowed: true, confirmation: 'wrong' }, '1')).status).toBe(400);
    expect((await h.catalogCommand(base, { kind: 'production-policy', allowed: true, confirmation: 'developer-app' }, '1')).status).toBe(200);
    h.restoreCookies(developer); expect((await h.catalogCommand(`${base}/environments`, production, '2')).status).toBe(403);
    h.restoreCookies(owner); expect((await h.organizationCommand(org, { kind: 'member-access', membershipId: member, projectAccess: 'assigned', projectIds: [created.scope.projectId], grants: [{ permission: 'resources.configure', scope: { orgId: org, projectId: created.scope.projectId } }] })).status).toBe(200);
    h.restoreCookies(developer);
    expect((await h.catalogCommand(`${base}/environments`, { ...production, productionConfirmation: 'wrong' }, '2')).status).toBe(400);
    expect((await h.catalogCommand(`${base}/environments`, production, '2', { 'x-csrf-token': 'wrong' })).status).toBe(403);
    expect((await h.catalogCommand(`${base}/environments`, production, '1')).status).toBe(409);
    const accepted = await h.catalogCommand(`${base}/environments`, production, '2'); expect(accepted.status).toBe(202);
    const prod = parseComponent('CatalogReceipt', (await accepted.json() as { receipt: unknown }).receipt);
    expect(prod.parentRevision).toBe('3');
    expect((await h.catalogCommand(`${base}/environments`, { ...production, name: 'production' }, '3')).status).toBe(409);
    expect(parseComponent('CatalogEnvironmentPage', await (await h.call(`${base}/environments`)).json()).items).toHaveLength(2);
    h.restoreCookies(owner); await h.organizationCommand(org, { kind: 'member-revoke', membershipId: member });
    h.restoreCookies(developer); h.restart();
    expect((await h.call(base)).status).toBe(404);
    expect((await h.call(`${base}/environments/${prod.scope.environmentId}/operations/${prod.operationId}`)).status).toBe(404);
    expect((await h.call('/platform/v1/account/session')).status).toBe(200);
  });

  test("member access commands persist scoped grants, enforce delegation duration and reject indirect project escalation", async () => {
    const h = await harness(); await h.challenge('access-owner@example.test'); await h.deliver(); await h.complete();
    const org = (await organizationResponse(h.createOrganization('Grant team', 'grant-team'))).receipt.id;
    const foreign = (await organizationResponse(h.createOrganization('Foreign team', 'foreign-team'))).receipt.id;
    const owner = new Map(h.cookies);
    const project = crypto.randomUUID(); const other = crypto.randomUUID(); const foreignProject = crypto.randomUUID();
    await h.sql`INSERT INTO projects (id, org_id, name, slug) VALUES (${project}, ${org}, 'App', 'app'), (${other}, ${org}, 'Other', 'other'), (${foreignProject}, ${foreign}, 'Foreign', 'foreign')`;
    const enroll = async (email: string) => {
      h.restoreCookies(owner); expect((await h.invitation(org, { kind: 'create', email, role: 'Admin' })).status).toBe(200);
      await h.deliver(); const proof = h.invitationToken(); await h.challenge(email); await h.deliver(); await h.complete();
      expect((await h.invitationProof(proof)).status).toBe(200);
      const member = (await h.sql`SELECT m.id FROM memberships m JOIN accounts a ON a.id = m.account_id WHERE m.org_id = ${org} AND a.primary_email = ${email}`)[0].id as string;
      return { member, cookies: new Map(h.cookies) };
    };
    const admin = await enroll('access-admin@example.test'); const recipient = await enroll('access-recipient@example.test'); h.restoreCookies(owner);
    const command = (membershipId: string, grants: unknown[] = [], projectIds = [project], projectAccess = 'assigned') => ({ kind: 'member-access', membershipId, projectAccess, projectIds, grants });
    const read = async (membershipId: string) => {
      const response = await h.call(`/platform/v1/orgs/${org}/members/${membershipId}/access`); expect(response.status).toBe(200);
      return parseComponent('MemberAccess', await response.json());
    };
    const until = new Date(Date.now() + 3600000).toISOString();
    const signing = { permission: 'signing.manage', scope: { orgId: org, projectId: project }, expiresAt: until } as const;
    expect((await h.organizationCommand(org, command(admin.member, [signing]), { 'x-csrf-token': 'wrong' })).status).toBe(403);
    expect((await h.organizationCommand(org, command(admin.member, [signing]), { 'if-match': '999' })).status).toBe(409);
    expect((await h.organizationCommand(org, command(admin.member, [signing], [foreignProject]))).status).toBe(404);
    expect((await h.organizationCommand(org, command(admin.member, [{ ...signing, scope: { orgId: foreign, projectId: foreignProject } }]))).status).toBe(400);
    expect((await h.organizationCommand(org, command(admin.member, [signing, { ...signing, expiresAt: new Date(Date.now() + 7200000).toISOString() }]))).status).toBe(400);
    const key = crypto.randomUUID(); const current = await read(admin.member);
    const saved = await h.organizationCommand(org, command(admin.member, [signing]), { 'idempotency-key': key, 'if-match': current.organizationRevision });
    expect(saved.status).toBe(200); const receipt = await saved.json(); h.restart();
    const retry = await h.organizationCommand(org, command(admin.member, [signing]), { 'idempotency-key': key, 'if-match': current.organizationRevision });
    expect(retry.status).toBe(200); expect(await retry.json()).toEqual(receipt);
    expect((await read(admin.member)).grants).toEqual([signing]);
    expect((await h.organizationCommand(org, command(admin.member), { 'idempotency-key': key, 'if-match': current.organizationRevision })).status).toBe(409);
    expect((await h.organizationCommand(org, command(recipient.member))).status).toBe(200);
    h.restoreCookies(admin.cookies);
    expect((await h.organizationCommand(org, command(admin.member))).status).toBe(400);
    expect((await h.organizationCommand(org, command(recipient.member, [], [], 'all'))).status).toBe(403);
    expect((await h.organizationCommand(org, command(recipient.member, [], [other]))).status).toBe(404);
    expect((await h.organizationCommand(org, command(recipient.member, [{ permission: 'data.read', scope: { orgId: org } }]))).status).toBe(403);
    expect((await h.organizationCommand(org, command(recipient.member, [{ ...signing, expiresAt: new Date(Date.now() + 7200000).toISOString() }]))).status).toBe(403);
    expect((await h.organizationCommand(org, command(recipient.member, [{ permission: signing.permission, scope: signing.scope }]))).status).toBe(403);
    const shorter = { ...signing, expiresAt: new Date(Date.now() + 1800000).toISOString() };
    expect((await h.organizationCommand(org, command(recipient.member, [shorter]))).status).toBe(200);
    expect((await read(recipient.member)).grants).toEqual([shorter]);
    expect((await h.invitation(org, { kind: 'create', email: 'escalated@example.test', role: 'Admin' })).status).toBe(403);
    const ownerMember = (await h.sql`SELECT id FROM memberships WHERE org_id = ${org} AND role = 'Owner'`)[0].id;
    expect((await h.organizationCommand(org, command(ownerMember))).status).toBe(403);
    h.restoreCookies(owner);
    expect((await h.organizationCommand(org, { kind: 'member-role', membershipId: recipient.member, role: 'Viewer' })).status).toBe(200);
    expect((await read(recipient.member)).grants).toHaveLength(0);
    expect((await h.organizationCommand(org, command(recipient.member, [signing]))).status).toBe(403);
    expect((await h.organizationCommand(org, command(recipient.member, [], [other]))).status).toBe(200);
    h.restoreCookies(admin.cookies);
    expect((await h.organizationCommand(org, { kind: 'member-role', membershipId: recipient.member, role: 'Developer' })).status).toBe(403);
    expect((await h.organizationCommand(org, { kind: 'member-role', membershipId: recipient.member, role: 'Admin' })).status).toBe(403);
    h.restoreCookies(recipient.cookies);
    expect((await h.call(`/platform/v1/orgs/${org}/members/${admin.member}/access`)).status).toBe(403);
    const targetAccess = await h.call(`/platform/v1/orgs/${org}/access?projectId=${other}`);
    expect(parseComponent('AccessSnapshot', await targetAccess.json()).permissions).toEqual(['metadata.read']);
    expect((await h.sql`SELECT id FROM organization_security_events WHERE org_id = ${org} AND action = 'organization.member-access'`)).toHaveLength(4);
  });

  test("live scope access isolates catalog parents, assignments and expiring grants across accounts and restarts", async () => {
    const h = await harness(); const unknown = crypto.randomUUID();
    expect((await h.call(`/platform/v1/orgs/${unknown}/access`)).status).toBe(401);
    await h.challenge('catalog-owner@example.test'); await h.deliver(); await h.complete();
    const org = (await organizationResponse(h.createOrganization('Catalog team', 'catalog-team'))).receipt.id;
    const foreign = (await organizationResponse(h.createOrganization('Foreign team', 'foreign-team'))).receipt.id;
    const owner = new Map(h.cookies);
    const project = crypto.randomUUID(); const otherProject = crypto.randomUUID(); const foreignProject = crypto.randomUUID();
    const development = crypto.randomUUID(); const production = crypto.randomUUID(); const otherEnvironment = crypto.randomUUID();
    // Catalog fixtures exercise authority independently of provisioning adapters.
    await h.sql`INSERT INTO projects (id, org_id, name, slug) VALUES (${project}, ${org}, 'App', 'app'), (${otherProject}, ${org}, 'Other', 'other'), (${foreignProject}, ${foreign}, 'Foreign', 'foreign')`;
    await h.sql`INSERT INTO environments (id, org_id, project_id, name, kind) VALUES (${development}, ${org}, ${project}, 'Development', 'development'), (${production}, ${org}, ${project}, 'Production', 'production'), (${otherEnvironment}, ${org}, ${otherProject}, 'Other', 'development')`;
    const access = (projectId = project, environmentId?: string, orgId = org) => h.call(`/platform/v1/orgs/${orgId}/access?projectId=${projectId}${environmentId ? '&environmentId=' + environmentId : ''}`);
    const snapshot = async (projectId = project, environmentId?: string) => {
      const response = await access(projectId, environmentId); expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store'); return parseComponent('AccessSnapshot', await response.json());
    };
    expect((await snapshot()).permissions).toContain('data.write');
    expect((await snapshot(project, production)).permissions).not.toContain('data.write');
    expect((await access(foreignProject)).status).toBe(404);
    expect((await access(project, otherEnvironment)).status).toBe(404);
    expect((await h.call(`/platform/v1/orgs/${org}/access?environmentId=${development}`)).status).toBe(400);
    expect((await h.call(`/platform/v1/orgs/${org}/access?projectId=${project}&projectId=${otherProject}`)).status).toBe(400);
    expect((await h.call(`/platform/v1/orgs/${org}/access?permission=data.write`)).status).toBe(400);
    expect((await h.call(`/platform/v1/orgs/${org}/access?projectId=${project}&environmentId=${development}&realmId=${unknown}`)).status).toBe(501);
    await h.invitation(org, { kind: 'create', email: 'catalog-viewer@example.test', role: 'Viewer' }); await h.deliver(); const proof = h.invitationToken();
    await h.challenge('catalog-viewer@example.test'); await h.deliver(); await h.complete();
    expect((await h.invitationProof(proof)).status).toBe(200);
    const own = (await organizationResponse(h.createOrganization('Viewer team', 'viewer-team'))).receipt.id;
    const viewer = new Map(h.cookies); const member = (await h.sql`SELECT id FROM memberships WHERE org_id = ${org} AND role = 'Viewer'`)[0].id;
    expect((await access()).status).toBe(404);
    expect((await access(foreignProject, undefined, foreign)).status).toBe(404);
    await h.sql`INSERT INTO project_assignments (membership_id, org_id, project_id) VALUES (${member}, ${org}, ${project})`;
    expect((await snapshot(project, development)).permissions).toEqual(['metadata.read']);
    await h.sql`INSERT INTO membership_grants (id, membership_id, org_id, project_id, environment_id, permission) VALUES
      (${crypto.randomUUID()}, ${member}, ${org}, ${project}, ${development}, 'data.read'), (${crypto.randomUUID()}, ${member}, ${org}, ${project}, ${development}, 'data.write')`;
    h.restart(); expect((await snapshot(project, development)).permissions).toEqual(['metadata.read', 'data.read']);
    expect((await snapshot(project, production)).permissions).toEqual(['metadata.read']);
    expect((await access(otherProject)).status).toBe(404);
    await h.sql`UPDATE membership_grants SET expires_at = now() - interval '1 second' WHERE permission = 'data.read'`;
    expect((await snapshot(project, development)).permissions).toEqual(['metadata.read']);
    await h.sql`UPDATE membership_grants SET expires_at = NULL WHERE permission = 'data.read'`;
    h.restoreCookies(owner); expect((await h.organizationCommand(org, { kind: 'member-role', membershipId: member, role: 'Developer' })).status).toBe(200);
    h.restoreCookies(viewer); expect((await snapshot(project, development)).permissions).toContain('data.write');
    expect((await snapshot(project, production)).permissions).not.toContain('resources.configure');
    await h.sql`INSERT INTO membership_grants (id, membership_id, org_id, project_id, environment_id, permission) VALUES (${crypto.randomUUID()}, ${member}, ${org}, ${project}, ${production}, 'resources.configure')`;
    expect((await snapshot(project, production)).permissions).not.toContain('resources.configure');
    await h.sql`UPDATE projects SET production_mutations_allowed = true WHERE id = ${project}`;
    expect((await snapshot(project, production)).permissions).toContain('resources.configure');
    const before = (await snapshot()).permissionRevision;
    h.restoreCookies(owner); expect((await h.organizationCommand(org, { kind: 'member-role', membershipId: member, role: 'Viewer' })).status).toBe(200);
    expect((await h.sql<{ permission: string }[]>`SELECT permission FROM membership_grants WHERE membership_id = ${member}`).map(r => r.permission)).toEqual(['data.read']);
    expect((await h.organizationCommand(org, { kind: 'member-role', membershipId: member, role: 'Developer' })).status).toBe(200);
    h.restoreCookies(viewer); expect((await snapshot(project, development)).permissions).not.toContain('data.write');
    expect((await snapshot()).permissionRevision).not.toBe(before);
    h.restoreCookies(owner); expect((await h.organizationCommand(org, { kind: 'member-revoke', membershipId: member })).status).toBe(200);
    expect(await h.sql`SELECT id FROM membership_grants WHERE membership_id = ${member}`).toHaveLength(0);
    expect(await h.sql`SELECT project_id FROM project_assignments WHERE membership_id = ${member}`).toHaveLength(0);
    h.restoreCookies(viewer); expect((await access()).status).toBe(404);
    expect((await h.call(`/platform/v1/orgs/${own}/access`)).status).toBe(200);
  });

  test("live access applies owner project restrictions and resource lifecycle before returning mutation permissions", async () => {
    const h = await harness(); await h.challenge(); await h.deliver(); await h.complete();
    const org = (await organizationResponse(h.createOrganization('Lifecycle team', 'lifecycle-team'))).receipt.id;
    const project = crypto.randomUUID(); const env = crypto.randomUUID();
    await h.sql`INSERT INTO projects (id, org_id, name, slug, production_mutations_allowed) VALUES (${project}, ${org}, 'App', 'app', true)`;
    await h.sql`INSERT INTO environments (id, org_id, project_id, name, kind) VALUES (${env}, ${org}, ${project}, 'Production', 'production')`;
    const access = () => h.call(`/platform/v1/orgs/${org}/access?projectId=${project}&environmentId=${env}`);
    const permissions = async () => parseComponent('AccessSnapshot', await (await access()).json()).permissions;
    expect(await permissions()).toContain('data.write');
    await h.sql`UPDATE memberships SET project_access = 'assigned' WHERE org_id = ${org}`;
    expect((await access()).status).toBe(404);
    await h.sql`INSERT INTO project_assignments (membership_id, org_id, project_id) SELECT id, org_id, ${project} FROM memberships WHERE org_id = ${org}`;
    expect(await permissions()).toContain('data.write');
    await h.sql`UPDATE environments SET state = 'paused' WHERE id = ${env}`;
    expect(await permissions()).toContain('data.read'); expect(await permissions()).not.toContain('data.write');
    await h.sql`UPDATE environments SET state = 'active' WHERE id = ${env}`;
    await h.sql`UPDATE projects SET state = 'archived' WHERE id = ${project}`;
    expect(await permissions()).toContain('metadata.read'); expect(await permissions()).not.toContain('resources.configure');
    await h.sql`UPDATE projects SET state = 'active' WHERE id = ${project}`;
    await h.sql`UPDATE organizations SET state = 'suspended' WHERE id = ${org}`;
    expect(await permissions()).toContain('data.read'); expect(await permissions()).not.toContain('release.publish');
    await h.sql`UPDATE organizations SET state = 'active', owner_policy = '{"requireMfa":true}'::jsonb WHERE id = ${org}`;
    expect((await access()).status).toBe(403);
    await h.sql`UPDATE organizations SET owner_policy = '{}'::jsonb WHERE id = ${org}`;
    await h.sql`UPDATE environments SET state = 'deleted' WHERE id = ${env}`; expect((await access()).status).toBe(404);
  });

  test("GitHub identity listing and unlinking enforce ownership, a final verified method, fresh revision and session revocation", async () => {
    const h = await harness(); const initial = await h.githubBegin(); await h.githubComplete(initial);
    const owner = new Map(h.cookies); const listed = parseComponent('AccountIdentities', await (await h.call('/platform/v1/account/identities')).json());
    const github = listed.items.find(i => i.provider === 'github')!; const email = listed.items.find(i => i.provider === 'email')!;
    expect(github.canUnlink).toBe(true); expect(email.canUnlink).toBe(false);
    expect((await h.security({ kind: 'identity-unlink', identityId: email.id })).status).toBe(400);
    await h.challenge('outsider@example.test'); await h.deliver(); await h.complete();
    expect((await h.security({ kind: 'identity-unlink', identityId: github.id })).status).toBe(404);
    expect(parseComponent('AccountIdentities', await (await h.call('/platform/v1/account/identities')).json()).items).toHaveLength(1);
    h.restoreCookies(owner);
    const saved = (await h.sql`DELETE FROM account_identities WHERE id = ${email.id} RETURNING *`)[0];
    expect((await h.security({ kind: 'identity-unlink', identityId: github.id })).status).toBe(409);
    expect(parseComponent('AccountIdentities', await (await h.call('/platform/v1/account/identities')).json()).items[0]!.canUnlink).toBe(false);
    await h.sql`INSERT INTO account_identities (id, account_id, provider, provider_subject, verified_at) VALUES (${saved.id}, ${saved.account_id}, ${saved.provider}, ${saved.provider_subject}, ${saved.verified_at})`;
    await h.sql`UPDATE account_sessions SET fresh_until = now() - interval '1 second' WHERE token_hash = ${tokenDigest(h.cookies.get('__Host-carbon-session')!)}`;
    expect((await h.security({ kind: 'identity-unlink', identityId: github.id })).status).toBe(403);
    await h.freshRequest(); await h.deliver(); await h.freshComplete();
    expect((await h.security({ kind: 'identity-unlink', identityId: github.id }, { 'if-match': listed.revision })).status).toBe(409);
    const oldSession = h.cookies.get('__Host-carbon-session')!; const pending = await h.githubBegin('login');
    expect((await h.security({ kind: 'identity-unlink', identityId: github.id })).status).toBe(200);
    expect(h.cookies.get('__Host-carbon-session')).not.toBe(oldSession);
    expect((await h.githubComplete(pending)).status).toBe(401);
    expect(parseComponent('AccountIdentities', await (await h.call('/platform/v1/account/identities')).json()).items).toHaveLength(1);
    h.cookies.clear(); const login = await h.githubBegin('login'); expect((await h.githubComplete(login)).status).toBe(401);
    await h.challenge('github@example.test', 'login'); await h.deliver(); expect((await h.complete()).status).toBe(200);
    expect((await h.sql`SELECT action FROM account_security_events WHERE action = 'account.identity-unlink'`)).toHaveLength(1);
  });

  test("GitHub linking rejects stale bound sessions and state start limits survive restart without charging exact retries", async () => {
    const h = await harness(); await h.challenge('github@example.test'); await h.deliver(); await h.complete();
    await h.sql`UPDATE account_sessions SET fresh_until = now() - interval '1 second'`;
    expect((await h.githubStart('link')).status).toBe(403);
    await h.freshRequest(); await h.deliver(); await h.freshComplete();
    const linked = parseComponent('GithubAuthStartResponse', await (await h.githubStart('link')).json()); const state = new URL(linked.authorizationUrl).searchParams.get('state')!;
    await h.call('/platform/v1/auth/signout', 'POST', undefined, { 'x-csrf-token': h.cookies.get('__Host-carbon-csrf')! });
    expect((await h.githubCallback(state)).status).toBe(401); expect(h.githubCalls).toHaveLength(0);
    h.cookies.clear(); const key = crypto.randomUUID();
    const first = parseComponent('GithubAuthStartResponse', await (await h.githubStart('login', { 'idempotency-key': key })).json());
    // The earlier committed link start shares this ingress peer's quota.
    for (let i = 0; i < 18; i++) expect((await h.githubStart('login')).status).toBe(200);
    h.restart(); expect((await h.githubStart('login')).status).toBe(429);
    expect(await (await h.githubStart('login', { 'idempotency-key': key })).json()).toEqual(first);
    await h.sql`UPDATE account_external_flows SET expires_at = now() - interval '1 second' WHERE state = 'pending'`;
    expect((await h.githubCallback(new URL(first.authorizationUrl).searchParams.get('state')!)).status).toBe(401);
    await h.sql`UPDATE account_auth_rate_limits SET window_start = now() - interval '1 hour'`;
    expect((await h.githubStart('login')).status).toBe(200);
    expect((await h.sql`SELECT id FROM account_external_flows WHERE state = 'expired' AND protected_start IS NOT NULL`)).toHaveLength(0);
    expect((await h.call('/platform/v1/auth/github/callback?state=a&state=b&code=c', 'GET', undefined, { origin: 'https://github.com', 'sec-fetch-site': 'cross-site' })).status).toBe(400);
  }, 15000);

  test("GitHub registration persists encrypted state, consumes callback once and issues one browser-bound account session after restart", async () => {
    const h = await harness(); const key = crypto.randomUUID();
    const first = await h.githubStart('registration', { 'idempotency-key': key }, { returnTo: '/organizations' }); expect(first.status).toBe(200);
    const start = parseComponent('GithubAuthStartResponse', await first.json());
    expect(await (await h.githubStart('registration', { 'idempotency-key': key }, { returnTo: '/organizations' })).json()).toEqual(start);
    expect((await h.githubStart('login', { 'idempotency-key': key })).status).toBe(409);
    const url = new URL(start.authorizationUrl); const state = url.searchParams.get('state')!;
    const flow = (await h.sql`SELECT * FROM account_external_flows`)[0]; expect(flow.protected_start).not.toContain(state); expect(flow.state_hash).toBe(tokenDigest(state));
    const browser = h.cookies.get('__Host-carbon-browser')!;
    expect((await h.githubCallback(state, 'code', { cookie: '__Host-carbon-browser=browser_' + 'z'.repeat(43) })).status).toBe(401);
    expect(h.githubCalls).toHaveLength(0); h.restart();
    const callbacks = await Promise.all([h.githubCallback(state), h.githubCallback(state)]); expect(callbacks.map(r => r.status).sort()).toEqual([303, 401]);
    expect(h.githubCalls).toHaveLength(3);
    const exchange = new URLSearchParams(String(h.githubCalls[0]!.init.body));
    expect(createHash('sha256').update(exchange.get('code_verifier')!).digest('base64url')).toBe(url.searchParams.get('code_challenge')!);
    const proof = callbacks.find(r => r.status === 303)!.headers.get('location')!.split('#token=')[1]!;
    const ready = (await h.sql`SELECT protected_start, protected_identity, completion_hash FROM account_external_flows`)[0];
    expect(ready.protected_start).toBeNull(); expect(ready.protected_identity).not.toContain('github@example.test'); expect(ready.completion_hash).toBe(tokenDigest(proof));
    expect((await h.sql`SELECT id FROM accounts`)).toHaveLength(0);
    expect((await h.githubComplete(proof, undefined, { cookie: '__Host-carbon-browser=browser_' + 'z'.repeat(43) })).status).toBe(401);
    h.restart();
    const responses = await Promise.all([h.githubComplete(proof), h.githubComplete(proof)]); expect(responses.map(r => r.status).sort()).toEqual([200, 401]);
    expect(await responses.find(r => r.status === 200)!.json()).toEqual({ returnTo: '/organizations', linked: false });
    expect((await h.sql`SELECT id FROM accounts`)).toHaveLength(1); expect((await h.sql`SELECT id FROM account_sessions`)).toHaveLength(1);
    expect((await h.sql<{ provider: string; provider_subject: string }[]>`SELECT provider, provider_subject FROM account_identities ORDER BY provider`)).toEqual([{ provider: 'email', provider_subject: 'github@example.test' }, { provider: 'github', provider_subject: '123456' }]);
    expect(await (await h.call('/platform/v1/account/session')).json()).toHaveProperty('session.account.email', 'github@example.test');
    expect((await h.sql`SELECT state, protected_identity FROM account_external_flows`)[0]).toMatchObject({ state: 'consumed', protected_identity: null });
    h.cookies.set('__Host-carbon-browser', browser); expect((await h.githubComplete(proof)).status).toBe(401);
  });

  test("GitHub never implicitly merges an email account; explicit fresh linking rotates sessions and later login follows immutable subject", async () => {
    const h = await harness(); await h.challenge('github@example.test'); await h.deliver(); await h.complete();
    const owner = new Map(h.cookies); const original = (await h.sql`SELECT id, expires_at FROM account_sessions`)[0]; const account = (await h.sql`SELECT id FROM accounts`)[0].id;
    h.cookies.clear(); const registration = await h.githubBegin();
    expect((await h.githubComplete(registration)).status).toBe(409);
    expect((await h.sql`SELECT id FROM accounts`)).toHaveLength(1); expect((await h.sql`SELECT id FROM account_identities WHERE provider = 'github'`)).toHaveLength(0);
    h.restoreCookies(owner);
    expect((await h.githubStart('link', { 'x-csrf-token': 'wrong' })).status).toBe(403);
    const proof = await h.githubBegin('link'); const browser = h.cookies.get('__Host-carbon-browser')!;
    expect((await h.githubComplete(proof, undefined, { 'x-csrf-token': 'wrong' })).status).toBe(403);
    const linked = await h.githubComplete(proof); expect(linked.status).toBe(200); expect(await linked.json()).toHaveProperty('linked', true);
    const session = (await h.sql`SELECT account_id, expires_at FROM account_sessions WHERE revoked_at IS NULL`)[0]; expect(session.account_id).toBe(account); expect(session.expires_at.toISOString()).toBe(original.expires_at.toISOString());
    expect((await h.sql`SELECT revoked_at FROM account_sessions WHERE id = ${original.id}`)[0].revoked_at).not.toBeNull();
    expect(h.cookies.get('__Host-carbon-session')).not.toBe(owner.get('__Host-carbon-session'));
    h.cookies.clear(); h.setGithubAccount(123456, 'changed-on-github@example.test');
    const login = await h.githubBegin('login'); expect((await h.githubComplete(login)).status).toBe(200);
    expect(await (await h.call('/platform/v1/account/session')).json()).toHaveProperty('session.account.email', 'github@example.test');
    expect((await h.sql`SELECT id FROM accounts`)).toHaveLength(1);
  });

  test("GitHub linking enforces matching verified email, one provider subject per account and separation between accounts", async () => {
    const h = await harness(); const registered = await h.githubBegin(); expect((await h.githubComplete(registered)).status).toBe(200);
    const linkedAccount = new Map(h.cookies);
    await h.challenge('second@example.test'); await h.deliver(); await h.complete(); const second = new Map(h.cookies);
    const mismatch = await h.githubBegin('link'); expect((await h.githubComplete(mismatch)).status).toBe(409); // Subject already belongs to the first account.
    h.setGithubAccount(999, 'unrelated@example.test'); const emailMismatch = await h.githubBegin('link'); expect((await h.githubComplete(emailMismatch)).status).toBe(403);
    h.setGithubAccount(999, 'second@example.test'); const newLink = await h.githubBegin('link'); expect((await h.githubComplete(newLink)).status).toBe(200);
    h.setGithubAccount(1000, 'second@example.test'); const otherSubject = await h.githubBegin('link'); expect((await h.githubComplete(otherSubject)).status).toBe(409);
    expect((await h.sql<{ provider_subject: string }[]>`SELECT provider_subject FROM account_identities WHERE provider = 'github' ORDER BY provider_subject`)).toEqual([{ provider_subject: '123456' }, { provider_subject: '999' }]);
    const proof = await h.githubBegin('link'); const browser = h.cookies.get('__Host-carbon-browser')!;
    h.restoreCookies(linkedAccount); h.cookies.set('__Host-carbon-browser', browser); expect((await h.githubComplete(proof)).status).toBe(401);
  });

  test("GitHub linking and login require Carbon MFA and persist failed verification without linking early", async () => {
    const h = await harness(); await h.challenge('github@example.test'); await h.deliver(); await h.complete();
    const start = await securityResponse(h.security({ kind: 'mfa-start' }));
    const confirmed = await securityResponse(h.security({ kind: 'mfa-confirm', factorId: start.enrollment!.factorId, code: h.code(start.enrollment!.secret) }));
    const proof = await h.githubBegin('link');
    expect((await h.githubComplete(proof)).status).toBe(401);
    for (let i = 0; i < 5; i++) expect((await h.githubComplete(proof, '000000')).status).toBe(401);
    expect((await h.githubComplete(proof, '000000')).status).toBe(429);
    expect((await h.sql`SELECT id FROM account_identities WHERE provider = 'github'`)).toHaveLength(0);
    expect((await h.sql`SELECT mfa_failed_attempts FROM accounts`)[0].mfa_failed_attempts).toBe(5);
    await h.sql`UPDATE accounts SET mfa_locked_until = now() - interval '1 second'`; h.advance(30);
    expect((await h.githubComplete(proof, h.code(start.enrollment!.secret))).status).toBe(200);
    h.cookies.clear(); const login = await h.githubBegin('login');
    expect((await h.githubComplete(login, h.code(start.enrollment!.secret))).status).toBe(401);
    expect((await h.githubComplete(login, confirmed.recoveryCodes![0])).status).toBe(200);
    expect((await h.sql`SELECT id FROM recovery_codes WHERE consumed_at IS NOT NULL`)).toHaveLength(1);
    const identities = parseComponent('AccountIdentities', await (await h.call('/platform/v1/account/identities')).json());
    const githubId = identities.items.find(i => i.provider === 'github')!.id;
    expect((await h.security({ kind: 'identity-unlink', identityId: githubId })).status).toBe(401);
    h.advance(30); expect((await h.security({ kind: 'identity-unlink', identityId: githubId, code: h.code(start.enrollment!.secret) })).status).toBe(200);
    expect((await h.sql`SELECT id FROM mfa_factors WHERE state = 'active'`)).toHaveLength(1);
  });

  test("GitHub rejects expired, cancelled, failed and stale security flows without re-exchanging a consumed code", async () => {
    const h = await harness();
    expect((await h.githubStart('registration', {}, { termsAccepted: false })).status).toBe(400);
    expect((await h.githubStart('login', {}, { returnTo: '//attacker.example' })).status).toBe(400);
    expect((await h.githubStart('link')).status).toBe(401);
    const start = parseComponent('GithubAuthStartResponse', await (await h.githubStart()).json()); const state = new URL(start.authorizationUrl).searchParams.get('state')!;
    expect((await h.githubCallback(state, null)).status).toBe(401); expect(h.githubCalls).toHaveLength(0);
    expect((await h.githubCallback(state)).status).toBe(401);
    const next = parseComponent('GithubAuthStartResponse', await (await h.githubStart()).json()); const failing = new URL(next.authorizationUrl).searchParams.get('state')!;
    h.failGithub(true); const failed = await h.githubCallback(failing); expect(failed.status).toBe(503); expect(await failed.text()).not.toContain('fixture provider secret');
    h.restart(); h.failGithub(false); expect((await h.githubCallback(failing)).status).toBe(401); expect(h.githubCalls).toHaveLength(1);
    const proof = await h.githubBegin(); await h.sql`UPDATE account_external_flows SET expires_at = now() - interval '1 second' WHERE state = 'ready'`;
    expect((await h.githubComplete(proof)).status).toBe(401);
    await h.expireGithub(); expect((await h.sql`SELECT id FROM account_external_flows WHERE state = 'expired' AND protected_identity IS NOT NULL`)).toHaveLength(0);
    const valid = await h.githubBegin(); expect((await h.githubComplete(valid)).status).toBe(200);
    const pending = await h.githubBegin('login'); await h.sql`UPDATE accounts SET security_revision = security_revision + 1`;
    expect((await h.githubComplete(pending)).status).toBe(401);
    expect((await h.sql`SELECT id FROM account_sessions`)).toHaveLength(1);
  });

  test("invitation cancellation racing acceptance commits one outcome and a fresh invitation can restore a revoked member", async () => {
    const h = await harness(); await h.challenge("owner@example.test"); await h.deliver(); await h.complete();
    const org = (await organizationResponse(h.createOrganization("Invite team", "invite-team"))).receipt.id;
    const owner = new Map(h.cookies);
    const created = await invitationResponse(h.invitation(org, { kind: "create", email: "recipient@example.test", role: "Viewer" }));
    await h.deliver(); const proof = h.invitationToken();
    await h.challenge("recipient@example.test"); await h.deliver(); await h.complete(); const recipient = new Map(h.cookies);
    const headers = (cookies: ReadonlyMap<string, string>) => ({ cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; "), "x-csrf-token": cookies.get("__Host-carbon-csrf")! });
    const outcomes = await Promise.all([
      h.call(`/platform/v1/orgs/${org}/invitations`, "POST", { kind: "cancel", invitationId: created.receipt.id }, { ...headers(owner), "if-match": created.receipt.revision }),
      h.invitationProof(proof, "accept", headers(recipient)),
    ]);
    expect(outcomes.filter(r => r.status === 200)).toHaveLength(1);
    const invitation = (await h.sql`SELECT state FROM invitations WHERE id = ${created.receipt.id}`)[0];
    expect(invitation.state).toBe(outcomes[0]!.status === 200 ? "cancelled" : "accepted");
    if (invitation.state === "cancelled") {
      h.restoreCookies(owner); await h.invitation(org, { kind: "create", email: "recipient@example.test", role: "Viewer" }); await h.deliver();
      const replacement = h.invitationToken(); h.restoreCookies(recipient); expect((await h.invitationProof(replacement)).status).toBe(200);
    }
    const member = (await h.sql`SELECT id, revision::text FROM memberships WHERE org_id = ${org} AND role = 'Viewer'`)[0];
    const project = crypto.randomUUID();
    await h.sql`INSERT INTO projects (id, org_id, name, slug) VALUES (${project}, ${org}, 'Former access', 'former-access')`;
    await h.sql`UPDATE memberships SET project_access = 'all' WHERE id = ${member.id}`;
    await h.sql`INSERT INTO project_assignments (membership_id, org_id, project_id) VALUES (${member.id}, ${org}, ${project})`;
    await h.sql`INSERT INTO membership_grants (id, membership_id, org_id, project_id, permission) VALUES (${crypto.randomUUID()}, ${member.id}, ${org}, ${project}, 'data.read')`;
    h.restoreCookies(owner); await h.organizationCommand(org, { kind: "member-revoke", membershipId: member.id });
    await h.invitation(org, { kind: "create", email: "recipient@example.test", role: "Developer" }); await h.deliver(); const restoredProof = h.invitationToken();
    h.restoreCookies(recipient); expect((await h.invitationProof(restoredProof)).status).toBe(200);
    expect((await h.sql`SELECT id, role, state, revision::text FROM memberships WHERE id = ${member.id}`)[0]).toMatchObject({ id: member.id, role: "Developer", state: "active", revision: "3" });
    expect((await h.sql`SELECT project_access FROM memberships WHERE id = ${member.id}`)[0].project_access).toBe('role');
    expect(await h.sql`SELECT id FROM membership_grants WHERE membership_id = ${member.id}`).toHaveLength(0);
    expect(await h.sql`SELECT project_id FROM project_assignments WHERE membership_id = ${member.id}`).toHaveLength(0);
    expect((await h.call(`/platform/v1/orgs/${org}/access?projectId=${project}`)).status).toBe(404);
  });

  test("invitation delivery rate limits are durable, exact retries do not spend quota, and conflicting retries cannot replace queued proofs", async () => {
    const h = await harness(); await h.challenge("owner@example.test"); await h.deliver(); await h.complete();
    const org = (await organizationResponse(h.createOrganization("Invite team", "invite-team"))).receipt.id;
    const key = crypto.randomUUID(); const command = { kind: "create", email: "recipient@example.test", role: "Viewer" };
    const first = await invitationResponse(h.invitation(org, command, { "idempotency-key": key }));
    const proofHash = (await h.sql`SELECT token_hash FROM invitations WHERE id = ${first.receipt.id}`)[0].token_hash;
    expect((await h.invitation(org, { ...command, role: "Admin" }, { "idempotency-key": key, "if-match": "1" })).status).toBe(409);
    for (let i = 1; i < 20; i++) expect((await h.invitation(org, { kind: "create", email: `invite-${i}@example.test`, role: "Viewer" })).status).toBe(200);
    h.restart(); expect((await h.invitation(org, { kind: "create", email: "limited@example.test", role: "Viewer" })).status).toBe(429);
    expect((await h.invitation(org, command, { "idempotency-key": key, "if-match": "1" })).status).toBe(200);
    expect((await h.sql`SELECT token_hash FROM invitations WHERE id = ${first.receipt.id}`)[0].token_hash).toBe(proofHash);
    expect((await h.sql`SELECT id FROM account_email_outbox WHERE invitation_id IS NOT NULL`)).toHaveLength(20);
    await h.sql`UPDATE account_auth_rate_limits SET window_start = now() - interval '2 hours'`;
    expect((await h.invitation(org, { kind: "create", email: "limited@example.test", role: "Viewer" })).status).toBe(200);
  }, 15000);

  test("invitation delivery survives restart and provider retry; verified recipient accepts once with a durable receipt", async () => {
    const h = await harness(); await h.challenge("owner@example.test"); await h.deliver(); await h.complete();
    const org = (await organizationResponse(h.createOrganization("Invite team", "invite-team"))).receipt.id;
    const ownerCookies = new Map(h.cookies); const key = crypto.randomUUID();
    const created = await h.invitation(org, { kind: "create", email: "Recipient@example.test", role: "Developer" }, { "idempotency-key": key });
    expect(created.status).toBe(200); const first = await invitationResponse(created);
    expect((await h.invitation(org, { kind: "create", email: "recipient@example.test", role: "Developer" }, { "idempotency-key": key, "if-match": "1" })).status).toBe(200);
    expect((await h.sql`SELECT id FROM invitations`)).toHaveLength(1);
    const queued = (await h.sql`SELECT protected_message, invitation_id FROM account_email_outbox WHERE invitation_id IS NOT NULL`)[0];
    expect(queued.invitation_id).toBe(first.receipt.id); expect(queued.protected_message).not.toContain("recipient@example.test");
    expect(JSON.stringify(first)).not.toContain("token");
    h.failProvider(true); await h.deliver(); h.restart(); h.failProvider(false);
    await h.sql`UPDATE account_email_outbox SET ready_at = now() WHERE invitation_id IS NOT NULL`;
    await h.deliver(); const proof = h.invitationToken();
    expect((await h.invitationProof(proof, "preview")).status).toBe(404);
    await h.challenge("recipient@example.test"); await h.deliver(); await h.complete();
    expect(await (await h.invitationProof(proof, "preview")).json()).toMatchObject({ orgId: org, role: "Developer", organizationName: "Invite team" });
    expect((await h.invitationProof(proof, "accept", { "x-csrf-token": "wrong" })).status).toBe(403);
    expect((await h.call("/platform/v1/auth/complete", "POST", { token: proof })).status).toBe(400);
    const acceptKey = crypto.randomUUID();
    const results = await Promise.all([h.invitationProof(proof, "accept", { "idempotency-key": acceptKey }), h.invitationProof(proof, "accept", { "idempotency-key": acceptKey })]);
    expect(results.map(r => r.status)).toEqual([200, 200]); expect(await results[0]!.json()).toEqual(await results[1]!.json());
    expect((await h.invitationProof(proof)).status).toBe(404);
    expect((await h.sql`SELECT id FROM memberships WHERE org_id = ${org}`)).toHaveLength(2);
    expect((await h.sql`SELECT permission_revision::text FROM accounts WHERE primary_email = 'recipient@example.test'`)[0].permission_revision).toBe("2");
    expect((await h.call(`/platform/v1/orgs/${org}`)).status).toBe(200);
    expect((await h.call(`/platform/v1/orgs/${org}/invitations`)).status).toBe(403);
    const recipient = new Map(h.cookies); h.restoreCookies(ownerCookies);
    const list = await invitationPage(h.call(`/platform/v1/orgs/${org}/invitations`));
    expect(list.items[0]).toMatchObject({ state: "accepted", email: "recipient@example.test" }); expect(JSON.stringify(list)).not.toContain("token");
    const member = (await h.sql`SELECT id FROM memberships WHERE org_id = ${org} AND role = 'Developer'`)[0].id;
    await h.organizationCommand(org, { kind: "member-revoke", membershipId: member }); h.restoreCookies(recipient);
    expect((await h.invitationProof(proof, "accept", { "idempotency-key": acceptKey })).status).toBe(404);
    expect((await h.call(`/platform/v1/orgs/${org}`)).status).toBe(404);
  });

  test("invitation resend, cancellation, supersession and expiry invalidate proofs and pending mail across tenants", async () => {
    const h = await harness(); await h.challenge("owner@example.test"); await h.deliver(); await h.complete();
    const org = (await organizationResponse(h.createOrganization("Invite team", "invite-team"))).receipt.id;
    const other = (await organizationResponse(h.createOrganization("Other team", "other-team"))).receipt.id;
    const owner = new Map(h.cookies);
    const first = await invitationResponse(h.invitation(org, { kind: "create", email: "recipient@example.test", role: "Viewer" }));
    await h.deliver(); const oldProof = h.invitationToken();
    expect((await h.invitation(other, { kind: "resend", invitationId: first.receipt.id })).status).toBe(404);
    expect((await h.invitation(org, { kind: "resend", invitationId: first.receipt.id })).status).toBe(200);
    await h.deliver(); const resent = h.invitationToken(); expect(resent).not.toBe(oldProof);
    const page = await invitationPage(h.call(`/platform/v1/orgs/${org}/invitations?limit=1`)); expect(page.items).toHaveLength(1);
    await h.challenge("recipient@example.test"); await h.deliver(); await h.complete(); const recipient = new Map(h.cookies);
    expect((await h.invitationProof(oldProof)).status).toBe(404); expect((await h.invitationProof(resent, "preview")).status).toBe(200);
    h.restoreCookies(owner); await h.invitation(org, { kind: "cancel", invitationId: first.receipt.id }); h.restoreCookies(recipient);
    expect((await h.invitationProof(resent)).status).toBe(404);
    h.restoreCookies(owner); await h.invitation(org, { kind: "create", email: "recipient@example.test", role: "Viewer" });
    await h.deliver(); const superseded = h.invitationToken();
    await h.invitation(org, { kind: "create", email: "recipient@example.test", role: "Developer" });
    await h.deliver(); const latest = h.invitationToken();
    const cursor = (await invitationPage(h.call(`/platform/v1/orgs/${org}/invitations?limit=1`))).nextCursor; expect(cursor).toBeString();
    const pending = (await h.sql`SELECT id FROM invitations WHERE state = 'pending'`)[0].id;
    h.restoreCookies(recipient); expect((await h.invitationProof(superseded)).status).toBe(404);
    await h.sql`UPDATE invitations SET expires_at = now() - interval '1 second' WHERE id = ${pending}`;
    expect((await h.invitationProof(latest)).status).toBe(404);
    h.restoreCookies(owner); await h.invitation(org, { kind: "resend", invitationId: pending });
    expect((await h.call(`/platform/v1/orgs/${org}/invitations?limit=1&cursor=${encodeURIComponent(cursor!)}`)).status).toBe(400);
    expect((await h.sql`SELECT id FROM account_email_outbox WHERE invitation_id = ${pending} AND state = 'pending'`)).toHaveLength(1);
    await h.invitation(org, { kind: "cancel", invitationId: pending });
    expect((await h.sql`SELECT id FROM account_email_outbox WHERE invitation_id = ${pending} AND protected_message IS NOT NULL`)).toHaveLength(0);
  });

  test("invitation acceptance enforces live inviter permissions, recipient freshness, required MFA and scoped assignment capability", async () => {
    const h = await harness(); await h.challenge("owner@example.test"); await h.deliver(); await h.complete();
    const org = (await organizationResponse(h.createOrganization("Invite team", "invite-team"))).receipt.id;
    const started = await securityResponse(h.security({ kind: "mfa-start" })); await h.security({ kind: "mfa-confirm", factorId: started.enrollment!.factorId, code: h.code(started.enrollment!.secret) });
    const owner = new Map(h.cookies); await h.invitation(org, { kind: "create", email: "admin@example.test", role: "Admin" }); await h.deliver(); const adminProof = h.invitationToken();
    await h.challenge("admin@example.test"); await h.deliver(); await h.complete(); expect((await h.invitationProof(adminProof)).status).toBe(200);
    const admin = new Map(h.cookies); const adminMember = (await h.sql`SELECT id FROM memberships WHERE org_id = ${org} AND role = 'Admin'`)[0].id;
    expect((await h.invitation(org, { kind: "create", email: "billing@example.test", role: "Billing" })).status).toBe(403);
    await h.invitation(org, { kind: "create", email: "recipient@example.test", role: "Developer" }); await h.deliver(); const proof = h.invitationToken();
    await h.challenge("recipient@example.test"); await h.deliver(); await h.complete(); const recipient = new Map(h.cookies);
    await h.sql`UPDATE account_sessions SET fresh_until = now() - interval '1 second' WHERE token_hash = ${tokenDigest(h.cookies.get('__Host-carbon-session')!)}`;
    expect((await h.invitationProof(proof)).status).toBe(403);
    await h.freshRequest(); await h.deliver(); await h.freshComplete(); const freshRecipient = new Map(h.cookies);
    h.restoreCookies(owner); await h.organizationCommand(org, { kind: "member-role", membershipId: adminMember, role: "Viewer" });
    h.restoreCookies(freshRecipient); expect((await h.invitationProof(proof)).status).toBe(404);
    h.restoreCookies(owner); await h.organizationCommand(org, { kind: "member-role", membershipId: adminMember, role: "Admin" });
    await h.organizationCommand(org, { kind: "policy", requireMfa: true });
    h.restoreCookies(freshRecipient); expect((await h.invitationProof(proof)).status).toBe(404); // Inviter no longer meets MFA policy.
    h.restoreCookies(owner); const renewed = await invitationResponse(h.invitation(org, { kind: "create", email: "recipient@example.test", role: "Developer" })); await h.deliver(); const ownerProof = h.invitationToken();
    h.restoreCookies(freshRecipient); expect(await (await h.invitationProof(ownerProof, "preview")).json()).toHaveProperty("requireMfa", true);
    expect((await h.invitationProof(ownerProof)).status).toBe(403);
    const enrollment = await securityResponse(h.security({ kind: "mfa-start" })); await h.security({ kind: "mfa-confirm", factorId: enrollment.enrollment!.factorId, code: h.code(enrollment.enrollment!.secret) });
    await h.sql`UPDATE invitations SET assignments = '[{"projectId":"unsupported"}]'::jsonb WHERE id = ${renewed.receipt.id}`;
    expect((await h.invitationProof(ownerProof)).status).toBe(501);
    await h.sql`UPDATE invitations SET assignments = '[]'::jsonb WHERE id = ${renewed.receipt.id}`;
    expect((await h.invitationProof(ownerProof)).status).toBe(200);
    const events = await h.sql<{ action: string; invitation_id: string }[]>`SELECT action, invitation_id FROM organization_security_events WHERE action = 'invitation.accept'`;
    expect(events).toHaveLength(2); expect(events.some(event => event.invitation_id === renewed.receipt.id)).toBe(true);
  });

  test("organization creation is durable and idempotent, namespaces are unique and legacy organizations remain unclaimed", async () => {
    const h = await harness(); expect((await h.call("/platform/v1/orgs")).status).toBe(401);
    await h.challenge(); await h.deliver(); await h.complete();
    const key = crypto.randomUUID();
    const created = await Promise.all([h.createOrganization("Carbon team", "carbon-team", { "idempotency-key": key }), h.createOrganization("Carbon team", "carbon-team", { "idempotency-key": key })]);
    expect(created.map(r => r.status).sort()).toEqual([201, 201]);
    const first = await created[0]!.json() as { receipt: { id: string; revision: string } };
    expect(await created[1]!.json()).toEqual(first);
    expect((await h.sql`SELECT id FROM organizations`)).toHaveLength(1);
    expect((await h.sql`SELECT id FROM api_tokens`)).toHaveLength(0);
    expect((await h.createOrganization("Changed", "changed-team", { "idempotency-key": key })).status).toBe(409);
    expect((await h.createOrganization("Other", "carbon-team")).status).toBe(409);
    expect((await h.createOrganization("Other", "Bad Namespace")).status).toBe(400);
    expect((await h.createOrganization("Other", "other-team", { "x-csrf-token": "wrong" })).status).toBe(403);
    await h.sql`INSERT INTO organizations (id, name, slug) VALUES (${crypto.randomUUID()}, 'Legacy', 'legacy-team')`;
    expect((await h.createOrganization("Legacy claim", "legacy-team")).status).toBe(409);
    h.restart();
    const listed = await (await h.call("/platform/v1/orgs")).json() as { items: { id: string; role: string }[] };
    expect(listed.items).toHaveLength(1); expect(listed.items[0]).toMatchObject({ id: first.receipt.id, role: "Owner" });
    expect((await h.organizationCommand(first.receipt.id, { kind: "leave" })).status).toBe(409);
    const commandHeaders = { "if-match": first.receipt.revision, "x-csrf-token": h.cookies.get("__Host-carbon-csrf")! };
    expect((await h.call(`/platform/v1/orgs/${first.receipt.id}/members`, "POST", { kind: "policy", requireMfa: false }, commandHeaders)).status).toBe(400);
    expect((await h.call(`/platform/v1/orgs/${first.receipt.id}/settings`, "POST", { kind: "leave" }, commandHeaders)).status).toBe(400);
    let failure: unknown;
    try { await h.sql`DELETE FROM memberships WHERE org_id = ${first.receipt.id}`; } catch (error) { failure = error; }
    expect((failure as { constraint?: string }).constraint).toBe("organization_active_owner");
    expect((await h.sql`SELECT id FROM memberships WHERE org_id = ${first.receipt.id}`)).toHaveLength(1);
    expect((await h.sql`SELECT permission_revision::text FROM accounts`)[0].permission_revision).toBe("2");
    expect((await h.sql`SELECT action, published_at FROM organization_security_events`)[0]).toMatchObject({ action: "organization.create", published_at: null });
  });

  test("organization membership roles, revocation and cursors recheck account authority without signing out unrelated organizations", async () => {
    const h = await harness(); await h.challenge(); await h.deliver(); await h.complete();
    const org = (await (await h.createOrganization("Owner team", "owner-team")).json() as { receipt: { id: string } }).receipt.id;
    await h.createOrganization("Other team", "other-team");
    const ownerCookies = new Map(h.cookies);
    const ownerMember = (await h.sql`SELECT id FROM memberships WHERE org_id = ${org}`)[0].id;
    const page = await (await h.call("/platform/v1/orgs?limit=1")).json() as { nextCursor: string };
    expect(page.nextCursor).toBeString();
    await h.challenge("admin@example.test"); await h.deliver(); await h.complete(); const adminCookies = new Map(h.cookies);
    const adminId = (await h.sql`SELECT id FROM accounts WHERE primary_email = 'admin@example.test'`)[0].id;
    // Direct member fixtures isolate role/cursor checks; invitation scenarios
    // above separately exercise the real acceptance API.
    await h.sql`INSERT INTO memberships (id, account_id, org_id, role, state) VALUES (${crypto.randomUUID()}, ${adminId}, ${org}, 'Admin', 'active')`;
    expect((await h.call("/platform/v1/orgs?limit=1&cursor=" + encodeURIComponent(page.nextCursor))).status).toBe(400);
    await h.challenge("member2@example.test"); await h.deliver(); await h.complete();
    const memberOrg = (await (await h.createOrganization("Member's team", "member-team")).json() as { receipt: { id: string } }).receipt.id;
    const memberCookies = new Map(h.cookies); const memberId = (await h.sql`SELECT id FROM accounts WHERE primary_email = 'member2@example.test'`)[0].id;
    const membershipId = crypto.randomUUID();
    await h.sql`INSERT INTO memberships (id, account_id, org_id, role, state) VALUES (${membershipId}, ${memberId}, ${org}, 'Viewer', 'active')`;
    expect((await h.call(`/platform/v1/orgs/${org}/members`)).status).toBe(403);
    h.restoreCookies(adminCookies);
    const membersPage = await (await h.call(`/platform/v1/orgs/${org}/members?limit=1`)).json() as { nextCursor: string };
    expect((await h.organizationCommand(org, { kind: "update", name: "Admin rename", slug: "admin-team" })).status).toBe(200);
    expect((await h.organizationCommand(org, { kind: "policy", requireMfa: true })).status).toBe(403);
    expect((await h.organizationCommand(org, { kind: "member-role", membershipId, role: "Billing" })).status).toBe(403);
    expect((await h.organizationCommand(org, { kind: "member-role", membershipId: ownerMember, role: "Viewer" })).status).toBe(409);
    expect((await h.organizationCommand(org, { kind: "member-role", membershipId, role: "Developer" })).status).toBe(200);
    expect((await h.call(`/platform/v1/orgs/${org}/members?limit=1&cursor=` + encodeURIComponent(membersPage.nextCursor))).status).toBe(400);
    h.restoreCookies(memberCookies);
    const memberSession = await (await h.call("/platform/v1/account/session")).json() as { session: { account: { permissionRevision: string } } };
    expect(memberSession.session.account.permissionRevision).toBe("3");
    h.restoreCookies(ownerCookies);
    const foreignMember = (await h.sql`SELECT id FROM memberships WHERE org_id = ${memberOrg}`)[0].id;
    expect((await h.organizationCommand(org, { kind: "member-revoke", membershipId: foreignMember })).status).toBe(404);
    expect((await h.organizationCommand(org, { kind: "member-revoke", membershipId })).status).toBe(200);
    h.restart(); h.restoreCookies(memberCookies);
    expect((await h.call(`/platform/v1/orgs/${org}`)).status).toBe(404);
    expect((await h.call(`/platform/v1/orgs/${memberOrg}`)).status).toBe(200);
    expect(await (await h.call("/platform/v1/account/session")).json()).not.toEqual({ session: null });
    expect((await h.sql`SELECT permission_revision::text FROM accounts WHERE id = ${memberId}`)[0].permission_revision).toBe("4");
  });

  test("organization MFA policy requires an enrolled owner and immediately gates other members", async () => {
    const h = await harness(); await h.challenge(); await h.deliver(); await h.complete();
    const org = (await (await h.createOrganization("Secure team", "secure-team")).json() as { receipt: { id: string } }).receipt.id;
    expect((await h.organizationCommand(org, { kind: "policy", requireMfa: true })).status).toBe(403);
    const enrollment = await (await h.security({ kind: "mfa-start" })).json() as { enrollment: { factorId: string; secret: string } };
    const recovery = await (await h.security({ kind: "mfa-confirm", factorId: enrollment.enrollment.factorId, code: h.code(enrollment.enrollment.secret) })).json() as { recoveryCodes: string[] };
    const ownerCookies = new Map(h.cookies);
    await h.challenge("admin@example.test"); await h.deliver(); await h.complete(); const memberCookies = new Map(h.cookies);
    const id = (await h.sql`SELECT id FROM accounts WHERE primary_email = 'admin@example.test'`)[0].id;
    await h.sql`INSERT INTO memberships (id, account_id, org_id, role, state) VALUES (${crypto.randomUUID()}, ${id}, ${org}, 'Admin', 'active')`;
    expect((await h.call(`/platform/v1/orgs/${org}/members`)).status).toBe(200);
    h.restoreCookies(ownerCookies);
    expect((await h.organizationCommand(org, { kind: "policy", requireMfa: true }, { "if-match": "999" })).status).toBe(409);
    expect((await h.organizationCommand(org, { kind: "policy", requireMfa: true })).status).toBe(200);
    expect((await h.security({ kind: "mfa-disable", code: recovery.recoveryCodes[0]! })).status).toBe(403);
    h.restoreCookies(memberCookies);
    expect((await h.call(`/platform/v1/orgs/${org}/members`)).status).toBe(403);
    expect(await (await h.call(`/platform/v1/orgs/${org}`)).json()).toHaveProperty("organization.requireMfa", true);
    h.restoreCookies(ownerCookies);
    expect((await h.organizationCommand(org, { kind: "policy", requireMfa: false })).status).toBe(200);
    h.restoreCookies(memberCookies); expect((await h.call(`/platform/v1/orgs/${org}/members`)).status).toBe(200);
  });

  test("ownership transfer requires the named recipient's fresh acceptance and keeps one owner under concurrent completion", async () => {
    const h = await harness(); await h.challenge(); await h.deliver(); await h.complete();
    const org = (await (await h.createOrganization("Transfer team", "transfer-team")).json() as { receipt: { id: string } }).receipt.id;
    const ownerCookies = new Map(h.cookies); const ownerId = (await h.sql`SELECT id FROM accounts`)[0].id;
    await h.challenge("recipient@example.test"); await h.deliver(); await h.complete(); const recipientCookies = new Map(h.cookies);
    const recipientId = (await h.sql`SELECT id FROM accounts WHERE primary_email = 'recipient@example.test'`)[0].id;
    const membershipId = crypto.randomUUID();
    await h.sql`INSERT INTO memberships (id, account_id, org_id, role, state) VALUES (${membershipId}, ${recipientId}, ${org}, 'Viewer', 'active')`;
    h.restoreCookies(ownerCookies);
    const expired = await (await h.organizationCommand(org, { kind: "ownership-propose", membershipId, previousRole: "Admin" })).json() as { receipt: { transferId: string } };
    await h.sql`UPDATE organization_ownership_transfers SET expires_at = now() - interval '1 second' WHERE id = ${expired.receipt.transferId}`;
    h.restoreCookies(recipientCookies); expect((await h.organizationCommand(org, { kind: "ownership-accept", transferId: expired.receipt.transferId })).status).toBe(404);
    h.restoreCookies(ownerCookies);
    const cancelled = await (await h.organizationCommand(org, { kind: "ownership-propose", membershipId, previousRole: "Admin" })).json() as typeof expired;
    expect((await h.organizationCommand(org, { kind: "ownership-cancel" })).status).toBe(200);
    h.restoreCookies(recipientCookies); expect((await h.organizationCommand(org, { kind: "ownership-accept", transferId: cancelled.receipt.transferId })).status).toBe(404);
    h.restoreCookies(ownerCookies);
    const proposed = await (await h.organizationCommand(org, { kind: "ownership-propose", membershipId, previousRole: "Admin" })).json() as { receipt: { transferId: string; revision: string } };
    expect((await h.organizationCommand(org, { kind: "ownership-accept", transferId: proposed.receipt.transferId })).status).toBe(404);
    expect((await h.sql`SELECT role FROM memberships WHERE account_id = ${ownerId}`)[0].role).toBe("Owner");
    h.restoreCookies(recipientCookies);
    expect(await (await h.call(`/platform/v1/orgs/${org}`)).json()).toHaveProperty("transfer.id", proposed.receipt.transferId);
    await h.sql`UPDATE account_sessions SET fresh_until = now() - interval '1 second' WHERE account_id = ${recipientId}`;
    expect((await h.organizationCommand(org, { kind: "ownership-accept", transferId: proposed.receipt.transferId })).status).toBe(403);
    await h.freshRequest(); await h.deliver(); await h.freshComplete();
    const key = crypto.randomUUID(); const secondKey = crypto.randomUUID(); const command = { kind: "ownership-accept", transferId: proposed.receipt.transferId };
    const responses = await Promise.all([h.organizationCommand(org, command, { "idempotency-key": key, "if-match": proposed.receipt.revision }),
      h.organizationCommand(org, command, { "idempotency-key": secondKey, "if-match": proposed.receipt.revision })]);
    expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
    // Which concurrent request won is immaterial; replay the persisted winner.
    const winnerKey = responses[0]!.status === 200 ? key : secondKey;
    expect((await h.organizationCommand(org, command, { "idempotency-key": winnerKey, "if-match": proposed.receipt.revision })).status).toBe(200);
    const receipt = (await h.sql`SELECT result, key_digest FROM organization_commands WHERE scope_key = ${org} ORDER BY created_at DESC LIMIT 1`)[0];
    expect(receipt.result.transferId).toBe(proposed.receipt.transferId);
    expect((await h.sql`SELECT role FROM memberships WHERE account_id = ${recipientId}`)[0].role).toBe("Owner");
    expect((await h.sql`SELECT role FROM memberships WHERE account_id = ${ownerId}`)[0].role).toBe("Admin");
    expect((await h.sql`SELECT id FROM memberships WHERE org_id = ${org} AND role = 'Owner' AND state = 'active'`)).toHaveLength(1);
    expect((await h.organizationCommand(org, { kind: "leave" })).status).toBe(409);
    h.restoreCookies(ownerCookies); h.restart();
    expect((await h.organizationCommand(org, { kind: "policy", requireMfa: true })).status).toBe(403);
    expect((await h.organizationCommand(org, { kind: "leave" })).status).toBe(200);
    expect((await h.call(`/platform/v1/orgs/${org}`)).status).toBe(404);
  });

  test("two concurrent owner departures cannot leave a managed organization without an owner", async () => {
    const h = await harness(); await h.challenge(); await h.deliver(); await h.complete();
    const created = await (await h.createOrganization("Multiple owners", "multiple-owners")).json() as { receipt: { id: string; revision: string } };
    const first = new Map(h.cookies);
    await h.challenge("second-owner@example.test"); await h.deliver(); await h.complete(); const second = new Map(h.cookies);
    const secondId = (await h.sql`SELECT id FROM accounts WHERE primary_email = 'second-owner@example.test'`)[0].id;
    await h.sql`INSERT INTO memberships (id, account_id, org_id, role, state) VALUES (${crypto.randomUUID()}, ${secondId}, ${created.receipt.id}, 'Owner', 'active')`;
    const responses = await Promise.all([first, second].map(cookies => h.call(`/platform/v1/orgs/${created.receipt.id}/members`, "POST", { kind: "leave" }, {
      cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join("; "), "x-csrf-token": cookies.get("__Host-carbon-csrf")!, "if-match": created.receipt.revision,
    })));
    expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
    const owners = await h.sql`SELECT account_id FROM memberships WHERE org_id = ${created.receipt.id} AND role = 'Owner' AND state = 'active'`;
    expect(owners).toHaveLength(1);
    h.restoreCookies(owners[0].account_id === secondId ? second : first);
    expect((await h.organizationCommand(created.receipt.id, { kind: "leave" })).status).toBe(409);
  });

  test("account profile saves name/local avatar with revision, CSRF and idempotency guards without requiring new authentication", async () => {
    const h = await harness(); await h.challenge(); await h.deliver(); await h.complete();
    await h.sql`UPDATE account_sessions SET fresh_until = now() - interval '1 second'`;
    const before = await (await h.call("/platform/v1/account/profile")).json() as { account: { revision: string } };
    const key = crypto.randomUUID(); const command = { kind: "update", name: " New Name ", avatar: "🌿" };
    expect((await h.profile(command, { "x-csrf-token": "wrong" })).status).toBe(403);
    expect((await h.profile(command, { "if-match": "1" })).status).toBe(409);
    expect((await h.profile({ ...command, name: "  " })).status).toBe(400);
    expect((await h.profile({ ...command, avatar: "https://avatar.example/a" })).status).toBe(400);
    expect((await h.profile({ ...command, role: "Owner" })).status).toBe(400);
    expect((await h.profile(command, { "idempotency-key": key })).status).toBe(200);
    h.restart();
    expect(await (await h.call("/platform/v1/account/profile")).json()).toMatchObject({ account: { name: "New Name", avatar: "🌿", email: "member@example.test" }, pendingEmailChange: null });
    expect((await h.profile(command, { "idempotency-key": key, "if-match": before.account.revision })).status).toBe(200);
    expect((await h.sql`SELECT action FROM account_security_events WHERE action = 'account.profile.update'`)).toHaveLength(1);
    expect((await h.profile({ kind: "email-change", email: "new@example.test" })).status).toBe(403);
    expect((await h.profile({ kind: "update", name: "🌿".repeat(100), avatar: "🌿" })).status).toBe(200);
    expect((await h.freshRequest()).status).toBe(202);
  });

  test("verified email replacement preserves identity, revokes old sessions/proofs, and durably notifies the previous address", async () => {
    const h = await harness(); await h.challenge(); await h.deliver(); await h.complete();
    const firstSession = h.cookies.get("__Host-carbon-session")!;
    await h.challenge("member@example.test", "login"); await h.deliver(); await h.complete();
    const originalSession = h.cookies.get("__Host-carbon-session")!;
    const original = (await h.sql`SELECT a.id, a.security_revision, s.expires_at FROM accounts a JOIN account_sessions s ON s.account_id = a.id WHERE s.token_hash = ${tokenDigest(originalSession)}`)[0];
    const key = crypto.randomUUID(); const before = (await h.sql`SELECT revision::text FROM accounts`)[0].revision;
    expect((await h.profile({ kind: "email-change", email: " New@Example.Test " }, { "idempotency-key": key })).status).toBe(202);
    expect((await h.profile({ kind: "email-change", email: "new@example.test" }, { "idempotency-key": key, "if-match": before })).status).toBe(202);
    expect((await h.sql`SELECT id FROM account_email_changes`)).toHaveLength(1);
    expect(await (await h.call("/platform/v1/account/profile")).json()).toMatchObject({ account: { email: "member@example.test" }, pendingEmailChange: { email: "new@example.test" } });
    h.failProvider(true); expect(await h.deliver()).toBe(true);
    expect((await h.sql`SELECT state FROM account_email_outbox WHERE email_change_id IS NOT NULL`)[0].state).toBe("pending");
    await h.sql`UPDATE account_email_outbox SET ready_at = now() - interval '1 second' WHERE state = 'pending'`;
    h.restart(); h.failProvider(false); expect(await h.deliver()).toBe(true);
    const proof = h.emailToken(); expect(JSON.stringify(await h.sql`SELECT * FROM account_email_changes`)).not.toContain(proof);
    expect((await h.call("/platform/v1/auth/complete", "POST", { token: proof })).status).toBe(400);
    expect((await h.emailComplete(undefined, { "x-csrf-token": "wrong" })).status).toBe(403);
    expect((await h.emailComplete()).status).toBe(200);
    expect(h.cookies.get("__Host-carbon-session")).not.toBe(originalSession);
    const current = await (await h.call("/platform/v1/account/profile")).json() as { account: { id: string; email: string; securityRevision: string } };
    expect(current.account.id).toBe(original.id); expect(current.account.email).toBe("new@example.test");
    expect(current.account.securityRevision).toBe(String(BigInt(original.security_revision) + 1n));
    const active = (await h.sql`SELECT expires_at FROM account_sessions WHERE revoked_at IS NULL`);
    expect(active).toHaveLength(1); expect(active[0].expires_at).toEqual(original.expires_at);
    for (const token of [firstSession, originalSession]) expect(await (await h.call("/platform/v1/account/session", "GET", undefined, { cookie: `__Host-carbon-session=${token}` })).json()).toEqual({ session: null });
    expect((await h.sql`SELECT provider_subject FROM account_identities WHERE provider = 'email'`)[0].provider_subject).toBe("new@example.test");
    const notice = (await h.sql`SELECT protected_message FROM account_email_outbox WHERE account_id = ${original.id}`)[0];
    expect(notice.protected_message).not.toContain("member@example.test");
    h.restart(); expect(await h.deliver()).toBe(true); expect(h.mail.at(-1)!.to).toBe("member@example.test");
    expect(h.mail.at(-1)!.subject).toBe("Your Carbon sign-in email changed");
    expect((await h.sql`SELECT protected_message FROM account_email_outbox WHERE account_id = ${original.id}`)[0].protected_message).toBeNull();
    await h.challenge("member@example.test", "login"); await h.deliver(); expect((await h.complete()).status).toBe(401);
    await h.challenge("new@example.test", "login"); await h.deliver(); expect((await h.complete()).status).toBe(200);
  });

  test("email verification conflicts never merge accounts; supersession and cancellation erase queued links", async () => {
    const h = await harness(); await h.challenge("taken@example.test"); await h.deliver(); await h.complete();
    await h.challenge(); await h.deliver(); await h.complete();
    expect((await h.profile({ kind: "email-change", email: "taken@example.test" })).status).toBe(202);
    await h.deliver(); expect((await h.emailComplete()).status).toBe(409);
    expect((await h.sql`SELECT id FROM accounts`)).toHaveLength(2);
    const takenProof = h.emailToken();
    expect((await h.profile({ kind: "email-change", email: "unused@example.test" })).status).toBe(202);
    const pendingId = (await h.sql`SELECT id FROM account_email_changes WHERE state = 'pending'`)[0].id;
    expect((await h.profile({ kind: "email-change", email: "replacement@example.test" })).status).toBe(202);
    expect((await h.sql`SELECT state, protected_message FROM account_email_outbox WHERE id = ${pendingId}`)[0]).toMatchObject({ state: "expired", protected_message: null });
    expect((await h.call("/platform/v1/account/email/complete", "POST", { token: takenProof }, { "x-csrf-token": h.cookies.get("__Host-carbon-csrf")! })).status).toBe(401);
    expect((await h.profile({ kind: "email-cancel" })).status).toBe(200);
    expect((await h.sql`SELECT id FROM account_email_changes WHERE state = 'pending'`)).toHaveLength(0);
    expect(await h.deliver()).toBe(false);
    expect(await (await h.call("/platform/v1/account/profile")).json()).toHaveProperty("pendingEmailChange", null);
  });

  test("email replacement requires active MFA and binds account, session, browser, revision and expiry", async () => {
    const h = await harness(); await h.challenge(); await h.deliver(); await h.complete();
    const factor = await (await h.security({ kind: "mfa-start" })).json() as { enrollment: { factorId: string; secret: string } };
    const enrolled = await (await h.security({ kind: "mfa-confirm", factorId: factor.enrollment.factorId, code: h.code(factor.enrollment.secret) })).json() as { recoveryCodes: string[] };
    await h.profile({ kind: "email-change", email: "verified@example.test" }); await h.deliver();
    const originalCookies = new Map(h.cookies); const proof = h.emailToken();
    h.cookies.set("__Host-carbon-browser", "browser_" + "x".repeat(43)); expect((await h.emailComplete()).status).toBe(401);
    h.cookies.set("__Host-carbon-browser", originalCookies.get("__Host-carbon-browser")!);
    const missing = await h.emailComplete(); expect(missing.status).toBe(401); expect(await missing.json()).toMatchObject({ error: { fieldErrors: { code: "mfa_required" } } });
    expect((await h.emailComplete(h.code(factor.enrollment.secret))).status).toBe(401);
    expect((await h.sql`SELECT mfa_failed_attempts FROM accounts`)[0].mfa_failed_attempts).toBe(1);
    await h.challenge("outsider@example.test"); await h.deliver(); await h.complete();
    h.cookies.set("__Host-carbon-browser", originalCookies.get("__Host-carbon-browser")!);
    expect((await h.emailComplete(enrolled.recoveryCodes[0]!)).status).toBe(401);
    h.cookies.clear(); for (const [key, value] of originalCookies) h.cookies.set(key, value);
    h.restart();
    const responses = await Promise.all([h.emailComplete(enrolled.recoveryCodes[0]!), h.emailComplete(enrolled.recoveryCodes[0]!)]);
    expect(responses.map(r => r.status).sort()).toEqual([200, 401]);
    expect((await h.sql`SELECT state FROM account_email_changes WHERE token_hash = ${tokenDigest(proof)}`)[0].state).toBe("verified");
    expect((await h.sql`SELECT count(*)::integer AS n FROM recovery_codes WHERE consumed_at IS NULL`)[0].n).toBe(9);
    // Delivery of the old-address notice must not be confused with the next proof.
    await h.deliver();
    await h.profile({ kind: "email-change", email: "next@example.test" }); await h.deliver();
    await h.sql`UPDATE account_email_changes SET expires_at = now() - interval '1 second' WHERE state = 'pending'`;
    expect((await h.emailComplete(enrolled.recoveryCodes[1]!)).status).toBe(401);
    await h.profile({ kind: "email-change", email: "next@example.test" }); await h.deliver();
    await h.sql`UPDATE accounts SET security_revision = security_revision + 1 WHERE primary_email = 'verified@example.test'`;
    await h.sql`UPDATE account_sessions SET security_revision = security_revision + 1 WHERE account_id = (SELECT id FROM accounts WHERE primary_email = 'verified@example.test')`;
    expect((await h.emailComplete(enrolled.recoveryCodes[1]!)).status).toBe(401);
    await h.profile({ kind: "email-change", email: "next@example.test" }); await h.deliver();
    expect((await h.security({ kind: "session-rotate" })).status).toBe(200);
    expect((await h.emailComplete(enrolled.recoveryCodes[1]!)).status).toBe(401);
  });

  test("fresh authentication commits a bound email proof, restores freshness and rotates only its session without extending expiry", async () => {
    const h = await harness(); await h.challenge(); await h.deliver(); await h.complete();
    const other = h.cookies.get("__Host-carbon-session")!;
    await h.challenge("member@example.test", "login"); await h.deliver(); await h.complete();
    const oldToken = h.cookies.get("__Host-carbon-session")!; const oldCsrf = h.cookies.get("__Host-carbon-csrf")!;
    await h.sql`UPDATE account_sessions SET fresh_until = now() - interval '1 second'`;
    expect((await h.security({ kind: "mfa-start" })).status).toBe(403);
    const key = crypto.randomUUID();
    const request = await h.freshRequest({ returnTo: "/account/security" }, { "idempotency-key": key }); expect(request.status).toBe(202);
    expect(await request.json()).toEqual({ message: "If this address can be used, an email with the next step will arrive shortly." });
    expect((await h.freshRequest({ returnTo: "/account/security" }, { "idempotency-key": key })).status).toBe(202);
    expect((await h.freshRequest({ returnTo: "/other" }, { "idempotency-key": key })).status).toBe(409);
    expect((await h.freshRequest({ email: "attacker@example.test" })).status).toBe(400);
    expect((await h.freshRequest({}, { "x-csrf-token": "wrong" })).status).toBe(403);
    expect((await h.freshRequest({ returnTo: "https://attacker.example/" })).status).toBe(400);
    const stored = (await h.sql`SELECT c.bound_session_id, c.bound_security_revision, s.expires_at FROM account_challenges c
      JOIN account_sessions s ON s.id = c.bound_session_id WHERE c.purpose = 'fresh_auth'`);
    expect(stored).toHaveLength(1);
    h.restart(); expect(await h.deliver()).toBe(true); expect(h.mail.at(-1)!.text).toContain("/auth/fresh#token=");
    expect((await h.complete()).status).toBe(401);
    expect((await h.freshComplete(undefined, { "x-csrf-token": "wrong" })).status).toBe(403);
    const refreshed = await h.freshComplete(); expect(refreshed.status).toBe(200);
    expect(await refreshed.json()).toEqual({ returnTo: "/account/security" });
    expect(h.cookies.get("__Host-carbon-session")).not.toBe(oldToken); expect(h.cookies.get("__Host-carbon-csrf")).not.toBe(oldCsrf);
    const active = (await h.sql`SELECT expires_at, fresh_until FROM account_sessions WHERE token_hash = ${tokenDigest(h.cookies.get("__Host-carbon-session")!)}`)[0];
    expect(active.expires_at).toEqual(stored[0].expires_at); expect(active.fresh_until.getTime()).toBeGreaterThan(Date.now());
    expect((await h.sql`SELECT count(*)::integer AS n FROM account_sessions WHERE revoked_at IS NULL`)[0].n).toBe(2);
    expect(await (await h.call("/platform/v1/account/session", "GET", undefined, { cookie: `__Host-carbon-session=${oldToken}` })).json()).toEqual({ session: null });
    expect(await (await h.call("/platform/v1/account/session", "GET", undefined, { cookie: `__Host-carbon-session=${other}` })).json()).not.toEqual({ session: null });
    expect((await h.sql`SELECT action FROM account_security_events WHERE action = 'session.refreshed'`)).toHaveLength(1);
    expect((await h.security({ kind: "mfa-start" })).status).toBe(200);
    expect((await h.freshComplete()).status).toBe(401);
  });

  test("fresh proofs reject other sessions, other accounts, wrong browsers and normal-login proof substitution", async () => {
    const h = await harness(); await h.challenge(); await h.deliver(); await h.complete();
    await h.freshRequest(); await h.deliver(); const proof = h.token(); const original = new Map(h.cookies);
    const tryProof = () => h.call("/platform/v1/account/fresh-auth/complete", "POST", { token: proof }, { "x-csrf-token": h.cookies.get("__Host-carbon-csrf")! });
    h.cookies.set("__Host-carbon-browser", "browser_" + "z".repeat(43)); expect((await tryProof()).status).toBe(401);
    h.cookies.set("__Host-carbon-browser", original.get("__Host-carbon-browser")!);
    await h.challenge("member@example.test", "login"); await h.deliver();
    expect((await h.freshComplete()).status).toBe(401);
    expect((await h.complete()).status).toBe(200);
    h.cookies.set("__Host-carbon-browser", original.get("__Host-carbon-browser")!);
    expect((await tryProof()).status).toBe(401);
    await h.challenge("outsider@example.test"); await h.deliver(); await h.complete();
    h.cookies.set("__Host-carbon-browser", original.get("__Host-carbon-browser")!);
    expect((await tryProof()).status).toBe(401);
    h.cookies.clear(); for (const [key, value] of original) h.cookies.set(key, value);
    expect((await tryProof()).status).toBe(200);
    expect((await h.sql`SELECT consumed_at FROM account_challenges WHERE token_hash = ${tokenDigest(proof)}`)[0].consumed_at).not.toBeNull();
  });

  test("fresh authentication requires a new MFA proof, persists failed attempts and consumes concurrent completion once", async () => {
    const h = await harness(); await h.challenge(); await h.deliver(); await h.complete();
    const start = await (await h.security({ kind: "mfa-start" })).json() as { enrollment: { factorId: string; secret: string } };
    await h.security({ kind: "mfa-confirm", factorId: start.enrollment.factorId, code: h.code(start.enrollment.secret) });
    await h.sql`UPDATE account_sessions SET fresh_until = now() - interval '1 second'`;
    await h.freshRequest(); await h.deliver();
    const missing = await h.freshComplete(); expect(missing.status).toBe(401);
    expect(await missing.json()).toMatchObject({ error: { fieldErrors: { code: "mfa_required" } } });
    expect((await h.freshComplete(h.code(start.enrollment.secret))).status).toBe(401);
    expect((await h.sql`SELECT mfa_failed_attempts FROM accounts`)[0].mfa_failed_attempts).toBe(1);
    h.restart(); h.advance(30);
    const responses = await Promise.all([h.freshComplete(h.code(start.enrollment.secret)), h.freshComplete(h.code(start.enrollment.secret))]);
    expect(responses.map(r => r.status).sort()).toEqual([200, 401]);
    expect((await h.sql`SELECT count(*)::integer AS n FROM account_sessions WHERE revoked_at IS NULL`)[0].n).toBe(1);
    expect((await h.sql`SELECT mfa_failed_attempts FROM accounts`)[0].mfa_failed_attempts).toBe(0);
  });

  test("fresh authentication fails closed after session expiry, revocation, security revision changes and challenge expiry", async () => {
    const h = await harness(); await h.challenge(); await h.deliver(); await h.complete();
    expect((await h.freshRequest({}, { cookie: "" })).status).toBe(401);
    await h.sql`UPDATE account_sessions SET expires_at = now() + interval '4 minutes'`;
    await h.freshRequest(); await h.deliver();
    const dates = (await h.sql`SELECT c.expires_at AS challenge_expiry, s.expires_at AS session_expiry FROM account_challenges c JOIN account_sessions s ON s.id = c.bound_session_id`)[0];
    expect(dates.challenge_expiry.getTime()).toBeLessThanOrEqual(dates.session_expiry.getTime());
    await h.sql`UPDATE account_challenges SET expires_at = now() - interval '1 second' WHERE purpose = 'fresh_auth'`;
    expect((await h.freshComplete()).status).toBe(401);
    await h.freshRequest(); await h.deliver();
    // Keep the actor valid at a new revision to exercise the challenge's own binding.
    await h.sql`UPDATE accounts SET security_revision = security_revision + 1`;
    await h.sql`UPDATE account_sessions SET security_revision = security_revision + 1`;
    expect((await h.freshComplete()).status).toBe(401);
    await h.freshRequest(); await h.deliver();
    await h.sql`UPDATE account_sessions SET expires_at = now() - interval '1 second'`;
    expect((await h.freshComplete()).status).toBe(401);
    await h.challenge("member@example.test", "login"); await h.deliver(); await h.complete();
    await h.freshRequest(); await h.deliver();
    await h.sql`UPDATE account_sessions SET revoked_at = now() WHERE revoked_at IS NULL`;
    expect((await h.freshComplete()).status).toBe(401);
    expect((await h.sql`SELECT count(*)::integer AS n FROM account_security_events WHERE action = 'session.refreshed'`)[0].n).toBe(0);
  });

  test("registration commits durable identity/session, never exposes challenge secrets, and signs out with CSRF", async () => {
    const h = await harness();
    const bootstrap = await h.call("/platform/v1/auth/bootstrap");
    expect(bootstrap.headers.getSetCookie()[0]).toContain("HttpOnly; Secure");
    const response = await h.challenge(); expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ message: "If this address can be used, an email with the next step will arrive shortly." });
    expect((await h.sql`SELECT count(*)::integer AS n FROM accounts`)[0].n).toBe(0);
    h.restart(); expect(await h.deliver()).toBe(true); expect(h.mail).toHaveLength(1);
    const token = h.token();
    expect(JSON.stringify(await h.sql`SELECT * FROM account_challenges`)).not.toContain(token);
    expect((await h.sql`SELECT protected_message FROM account_email_outbox`)[0].protected_message).toBeNull();
    const completed = await h.complete(); expect(completed.status).toBe(200);
    expect(await completed.json()).toEqual({ returnTo: "/organizations" });
    const sessionCookie = completed.headers.getSetCookie().find(c => c.startsWith("__Host-carbon-session="))!;
    expect(sessionCookie).toContain("HttpOnly; Secure"); expect(sessionCookie).toContain("SameSite=Lax");
    const sessionToken = h.cookies.get("__Host-carbon-session")!;
    expect(JSON.stringify(await h.sql`SELECT * FROM account_sessions`)).not.toContain(sessionToken);
    h.restart();
    const current = await (await h.call("/platform/v1/account/session")).json();
    expect(current).toHaveProperty("session.account.email", "member@example.test");
    expect(JSON.stringify(current)).not.toContain("csrfHash");
    expect((await h.call("/platform/v1/auth/signout", "POST", {})).status).toBe(403);
    const csrf = h.cookies.get("__Host-carbon-csrf")!;
    expect((await h.call("/platform/v1/auth/signout", "POST", {}, { "x-csrf-token": csrf })).status).toBe(200);
    const revoked = await h.call("/platform/v1/account/session", "GET", undefined, { cookie: `__Host-carbon-session=${sessionToken}` });
    expect(await revoked.json()).toEqual({ session: null });
    expect((await h.sql`SELECT count(*)::integer AS n FROM account_security_events WHERE action = 'session.revoked'`)[0].n).toBe(1);
  });

  test("binds challenges to the requesting browser and consumes them once under concurrency", async () => {
    const h = await harness(); await h.challenge(); await h.deliver();
    const invalid = await h.call("/platform/v1/auth/complete", "POST", { token: h.token() }, { cookie: "" });
    expect(invalid.status).toBe(401);
    const results = await Promise.all([h.complete(), h.complete()]);
    expect(results.map(r => r.status).sort()).toEqual([200, 401]);
    expect((await h.sql`SELECT count(*)::integer AS n FROM account_sessions`)[0].n).toBe(1);
    expect((await h.sql`SELECT count(*)::integer AS n FROM accounts`)[0].n).toBe(1);
  });

  test("persists idempotency and encrypted email across provider failure and worker restart", async () => {
    const h = await harness(); const key = crypto.randomUUID();
    expect((await h.challenge("retry@example.test", "registration", key)).status).toBe(202);
    const stored = (await h.sql`SELECT protected_message FROM account_email_outbox`)[0].protected_message;
    expect(stored).not.toContain("retry@example.test"); expect(stored).not.toContain("Continue to Carbon");
    expect((await h.challenge("retry@example.test", "registration", key)).status).toBe(202);
    expect((await h.sql`SELECT count(*)::integer AS n FROM account_email_outbox`)[0].n).toBe(1);
    h.failProvider(true); await h.deliver(); expect(h.mail).toHaveLength(0);
    h.restart(); h.failProvider(false); await h.sql`UPDATE account_email_outbox SET ready_at = now()`;
    await h.deliver(); expect(h.mail).toHaveLength(1); expect((await h.complete()).status).toBe(200);
  });

  test("reclaims an abandoned delivery lease and rejects stale acknowledgements", async () => {
    const h = await harness(); await h.challenge();
    const queue = new PostgresAccountMailQueue(h.sql); const first = await queue.claim(); expect(first).not.toBeNull();
    expect(await queue.claim()).toBeNull();
    await h.sql`UPDATE account_email_outbox SET lease_expires_at = now() - interval '1 second'`;
    const second = await queue.claim(); expect(second?.leaseId).not.toBe(first?.leaseId);
    await queue.delivered(first!);
    expect((await h.sql`SELECT state FROM account_email_outbox`)[0].state).toBe("sending");
    await queue.delivered(second!);
    expect((await h.sql`SELECT state, protected_message FROM account_email_outbox`)[0]).toMatchObject({ state: "delivered", protected_message: null });
  });

  test("unknown/registered emails receive identical public receipts and recovery revokes old sessions", async () => {
    const h = await harness(); const unknown = await (await h.challenge("unknown@example.test", "login")).json();
    await h.deliver(); expect((await h.complete()).status).toBe(401);
    expect((await h.sql`SELECT count(*)::integer AS n FROM accounts`)[0].n).toBe(0);
    const registration = await (await h.challenge()).json(); expect(registration).toEqual(unknown);
    await h.deliver(); await h.complete(); const old = h.cookies.get("__Host-carbon-session")!;
    expect(await (await h.challenge("member@example.test", "recovery")).json()).toEqual(unknown);
    await h.deliver(); expect((await h.complete()).status).toBe(200);
    const oldSession = await h.call("/platform/v1/account/session", "GET", undefined, { cookie: `__Host-carbon-session=${old}` });
    expect(await oldSession.json()).toEqual({ session: null });
    expect((await h.sql`SELECT security_revision::text AS revision FROM accounts`)[0].revision).toBe("2");
  });

  test("expires challenges, sessions and queued messages; active MFA never silently bypasses verification", async () => {
    const h = await harness(); await h.challenge();
    await h.sql`UPDATE account_email_outbox SET expires_at = now() - interval '1 second'`;
    expect(await h.deliver()).toBe(false); expect(h.mail).toHaveLength(0);
    expect((await h.sql`SELECT protected_message FROM account_email_outbox`)[0].protected_message).toBeNull();
    await h.challenge(); await h.deliver();
    await h.sql`UPDATE account_challenges SET expires_at = now() - interval '1 second'`;
    expect((await h.complete()).status).toBe(401);
    await h.challenge(); await h.deliver(); await h.complete();
    await h.sql`UPDATE account_sessions SET expires_at = now() - interval '1 second'`;
    expect(await (await h.call("/platform/v1/account/session")).json()).toEqual({ session: null });
    const account = (await h.sql`SELECT id FROM accounts`)[0];
    await h.sql`INSERT INTO mfa_factors (id, account_id, kind, encrypted_secret_reference, state) VALUES (${crypto.randomUUID()}, ${account.id}, 'totp', 'fixture-reference', 'active')`;
    await h.challenge("member@example.test", "login"); await h.deliver();
    expect((await h.complete()).status).toBe(401);
  });

  test("denies cross-origin mutations, invalid redirects, extra secret fields and oversized bodies", async () => {
    const h = await harness(); await h.call("/platform/v1/auth/bootstrap");
    expect((await h.call("/platform/v1/auth/challenges", "POST", {}, { origin: "https://attacker.test" })).status).toBe(403);
    expect((await h.call("/platform/v1/auth/challenges", "POST", { email: "valid@example.test", purpose: "registration", termsAccepted: true, termsVersion: "old-terms" })).status).toBe(400);
    for (const returnTo of ["https://attacker.test", "//attacker.test", "/\\attacker.test", "/\n/attacker.test"]) {
      expect((await h.call("/platform/v1/auth/challenges", "POST", { email: "valid@example.test", purpose: "login", returnTo })).status).toBe(400);
    }
    expect((await h.call("/platform/v1/auth/challenges", "POST", { email: "valid@example.test", purpose: "login", injectedSecret: "hidden" })).status).toBe(400);
    const huge = await h.call("/platform/v1/auth/challenges", "POST", { email: "x".repeat(9000), purpose: "login" });
    expect(huge.status).toBe(400); expect(await huge.text()).not.toContain("x".repeat(100));
    expect((await h.sql`SELECT count(*)::integer AS n FROM account_challenges`)[0].n).toBe(0);
  });

  test("rate limits new requests durably while allowing an exact retry", async () => {
    const h = await harness(); const key = crypto.randomUUID();
    expect((await h.challenge("limited@example.test", "login", key)).status).toBe(202);
    for (let i = 0; i < 19; i++) expect((await h.challenge("limited@example.test", "login")).status).toBe(202);
    h.restart(); const limited = await h.challenge("limited@example.test", "login");
    expect(limited.status).toBe(429); expect(limited.headers.get("retry-after")).toBe("900");
    expect((await h.challenge("limited@example.test", "login", key)).status).toBe(202);
    expect((await h.sql`SELECT count(*)::integer AS n FROM account_challenges`)[0].n).toBe(20);
  });

  test("MFA enrollment discloses once, rotates cookies, revokes other sessions and enforces TOTP replay", async () => {
    const h = await harness(); await h.challenge(); await h.deliver(); await h.complete();
    const original = h.cookies.get("__Host-carbon-session")!;
    await h.challenge("member@example.test", "login"); await h.deliver(); await h.complete();
    const second = h.cookies.get("__Host-carbon-session")!;
    const key = crypto.randomUUID();
    const first = await h.security({ kind: "mfa-start" }, { "idempotency-key": key }); expect(first.status).toBe(200);
    const enrollment = await first.json() as { enrollment: { factorId: string; secret: string; uri: string }; receipt: { revision: string } };
    expect(enrollment.enrollment.secret).toMatch(/^[A-Z2-7]{32}$/); expect(enrollment.enrollment.uri).toStartWith("otpauth://totp/");
    const commands = await h.sql`SELECT result FROM account_security_commands`;
    expect(commands[0].result).toHaveProperty("revision", enrollment.receipt.revision);
    expect(JSON.stringify(commands)).not.toContain(enrollment.enrollment.secret);
    const originalRevision = String(BigInt(enrollment.receipt.revision) - 1n);
    const replay = await h.security({ kind: "mfa-start" }, { "idempotency-key": key, "if-match": originalRevision });
    expect({ status: replay.status, body: await replay.json() }).toMatchObject({ status: 200, body: { receipt: { oneTimeValuesUnavailable: true } } });
    expect((await h.sql`SELECT count(*)::integer AS n FROM mfa_factors WHERE state = 'pending'`)[0].n).toBe(1);
    const confirmed = await h.security({ kind: "mfa-confirm", factorId: enrollment.enrollment.factorId, code: h.code(enrollment.enrollment.secret) });
    expect(confirmed.status).toBe(200);
    const confirmedBody = await confirmed.json() as { recoveryCodes: string[] };
    expect(confirmedBody.recoveryCodes).toHaveLength(10); expect(new Set(confirmedBody.recoveryCodes).size).toBe(10);
    expect(h.cookies.get("__Host-carbon-session")).not.toBe(second);
    for (const old of [original, second]) expect(await (await h.call("/platform/v1/account/session", "GET", undefined, { cookie: `__Host-carbon-session=${old}` })).json()).toEqual({ session: null });
    expect(JSON.stringify(await h.sql`SELECT * FROM recovery_codes`)).not.toContain(confirmedBody.recoveryCodes[0]!);
    expect(JSON.stringify(await h.sql`SELECT result FROM account_security_commands`)).not.toContain(confirmedBody.recoveryCodes[0]!);
    h.restart(); await h.challenge("member@example.test", "login"); await h.deliver();
    const required = await h.complete(); expect(required.status).toBe(401); expect(await required.json()).toMatchObject({ error: { fieldErrors: { code: "mfa_required" } } });
    expect((await h.complete(h.code(enrollment.enrollment.secret))).status).toBe(401);
    h.advance(30); const valid = h.code(enrollment.enrollment.secret);
    expect((await h.complete(valid)).status).toBe(200);
    expect(await (await h.call("/platform/v1/account/session")).json()).toHaveProperty("session.account.mfa", true);
    await h.challenge("member@example.test", "login"); await h.deliver();
    expect((await h.complete(valid)).status).toBe(401);
    expect((await h.complete(confirmedBody.recoveryCodes[0]!)).status).toBe(200);
    expect((await h.sql`SELECT count(*)::integer AS n FROM recovery_codes WHERE consumed_at IS NULL`)[0].n).toBe(9);
    await h.challenge("member@example.test", "login"); await h.deliver();
    expect((await h.complete(confirmedBody.recoveryCodes[0]!)).status).toBe(401);
  });

  test("MFA failures persist across attempts and lock the account across challenges and repository reconstruction", async () => {
    const h = await harness(); await h.challenge(); await h.deliver(); await h.complete();
    const start = await (await h.security({ kind: "mfa-start" })).json() as { enrollment: { factorId: string; secret: string } };
    for (let i = 0; i < 5; i++) expect((await h.security({ kind: "mfa-confirm", factorId: start.enrollment.factorId, code: "invalid-proof" })).status).toBe(401);
    expect((await h.sql`SELECT mfa_failed_attempts FROM accounts`)[0].mfa_failed_attempts).toBe(5);
    h.restart();
    expect((await h.security({ kind: "mfa-confirm", factorId: start.enrollment.factorId, code: h.code(start.enrollment.secret) })).status).toBe(429);
    await h.sql`UPDATE accounts SET mfa_locked_until = now() - interval '1 second'`;
    expect((await h.security({ kind: "mfa-confirm", factorId: start.enrollment.factorId, code: h.code(start.enrollment.secret) })).status).toBe(200);
    expect((await h.sql`SELECT mfa_failed_attempts FROM accounts`)[0].mfa_failed_attempts).toBe(0);
    for (let i = 0; i < 5; i++) {
      await h.challenge("member@example.test", "login"); await h.deliver();
      expect((await h.complete("invalid-proof")).status).toBe(401);
    }
    h.restart(); h.advance(30);
    expect((await h.complete(h.code(start.enrollment.secret))).status).toBe(429);
    expect((await h.sql`SELECT count(*)::integer AS n FROM account_sessions WHERE revoked_at IS NULL`)[0].n).toBe(1);
  });

  test("recovery replacement invalidates old codes and organization policy prevents disabling MFA", async () => {
    const h = await harness(); await h.challenge(); await h.deliver(); await h.complete();
    const start = await (await h.security({ kind: "mfa-start" })).json() as { enrollment: { factorId: string; secret: string } };
    const enrolled = await (await h.security({ kind: "mfa-confirm", factorId: start.enrollment.factorId, code: h.code(start.enrollment.secret) })).json() as { recoveryCodes: string[] };
    const reset = await h.security({ kind: "recovery-reset", code: enrolled.recoveryCodes[0]! }); expect(reset.status).toBe(200);
    const replacement = await reset.json() as { recoveryCodes: string[] }; expect(replacement.recoveryCodes).toHaveLength(10);
    expect((await h.security({ kind: "mfa-disable", code: enrolled.recoveryCodes[1]! })).status).toBe(401);
    const account = (await h.sql`SELECT id FROM accounts`)[0]; const orgId = crypto.randomUUID();
    await h.sql`INSERT INTO organizations (id, name, owner_policy) VALUES (${orgId}, 'MFA organization', '{"requireMfa":true}')`;
    await h.sql`INSERT INTO memberships (id, account_id, org_id, role, state) VALUES (${crypto.randomUUID()}, ${account.id}, ${orgId}, 'Owner', 'active')`;
    expect((await h.security({ kind: "mfa-disable", code: replacement.recoveryCodes[0]! })).status).toBe(403);
    expect((await h.sql`SELECT count(*)::integer AS n FROM recovery_codes WHERE consumed_at IS NULL`)[0].n).toBe(10);
    await h.sql`UPDATE organizations SET owner_policy = '{"requireMfa":false}' WHERE id = ${orgId}`;
    expect((await h.security({ kind: "mfa-disable", code: replacement.recoveryCodes[0]! })).status).toBe(200);
    expect((await h.sql`SELECT encrypted_secret_reference, state FROM mfa_factors`)[0]).toMatchObject({ encrypted_secret_reference: "", state: "disabled" });
    expect((await h.sql`SELECT count(*)::integer AS n FROM recovery_codes WHERE consumed_at IS NULL`)[0].n).toBe(0);
    await h.challenge("member@example.test", "login"); await h.deliver(); expect((await h.complete()).status).toBe(200);
  });

  test("security commands require CSRF, fresh authentication and current revisions; rotation never extends lifetime", async () => {
    const h = await harness(); await h.challenge(); await h.deliver(); await h.complete();
    expect((await h.security({ kind: "mfa-start" }, { "x-csrf-token": "wrong" })).status).toBe(403);
    expect((await h.security({ kind: "mfa-start" }, { "if-match": "1" })).status).toBe(409);
    await h.sql`UPDATE account_sessions SET fresh_until = now() - interval '1 second'`;
    expect((await h.security({ kind: "mfa-start" })).status).toBe(403);
    const previous = (await h.sql`SELECT expires_at, fresh_until FROM account_sessions WHERE revoked_at IS NULL`)[0];
    const old = h.cookies.get("__Host-carbon-session")!;
    expect((await h.security({ kind: "session-rotate" })).status).toBe(200);
    expect(h.cookies.get("__Host-carbon-session")).not.toBe(old);
    const rotated = (await h.sql`SELECT expires_at, fresh_until FROM account_sessions WHERE revoked_at IS NULL`)[0];
    expect(rotated.expires_at).toEqual(previous.expires_at); expect(rotated.fresh_until).toEqual(previous.fresh_until);
    expect(await (await h.call("/platform/v1/account/session", "GET", undefined, { cookie: `__Host-carbon-session=${old}` })).json()).toEqual({ session: null });
  });

  test("session pages are bounded, redacted, ordered and bound to account/session/revision; revocation is scoped", async () => {
    const h = await harness(); await h.challenge(); await h.deliver(); await h.complete();
    const firstCookie = `__Host-carbon-session=${h.cookies.get("__Host-carbon-session")}`;
    const firstCsrf = h.cookies.get("__Host-carbon-csrf")!;
    await h.challenge("member@example.test", "login"); await h.deliver(); await h.complete();
    await h.challenge("member@example.test", "login"); await h.deliver(); await h.complete();
    const mainCookies = new Map(h.cookies);
    const page = await (await h.call("/platform/v1/account/sessions?limit=1")).json() as { items: { id: string; current: boolean }[]; nextCursor: string; revision: string };
    expect(page.items).toHaveLength(1); expect(page.nextCursor).toBeString();
    expect(JSON.stringify(page)).not.toContain("csrf"); expect(JSON.stringify(page)).not.toContain("token_hash");
    const nextUrl = "/platform/v1/account/sessions?limit=1&cursor=" + encodeURIComponent(page.nextCursor);
    expect((await h.call(nextUrl + "tampered")).status).toBe(400);
    const actor = await (await h.call("/platform/v1/account/session")).json() as { session: { id: string } };
    const expired = await h.protector.seal(JSON.stringify({ afterId: page.items[0]!.id, expiresAt: Date.now() - 1000 }), `account-sessions:${actor.session.id}:${page.revision}:1`);
    expect((await h.call("/platform/v1/account/sessions?limit=1&cursor=" + encodeURIComponent(expired))).status).toBe(400);
    h.restart();
    const second = await (await h.call(nextUrl)).json() as typeof page;
    const third = await (await h.call("/platform/v1/account/sessions?limit=1&cursor=" + encodeURIComponent(second.nextCursor))).json() as typeof page;
    expect([page.items[0]!.id, second.items[0]!.id, third.items[0]!.id]).toEqual([page.items[0]!.id, second.items[0]!.id, third.items[0]!.id].sort());
    expect(third.nextCursor).toBeNull();
    expect((await h.call(nextUrl, "GET", undefined, { cookie: firstCookie })).status).toBe(400);
    expect((await h.call(nextUrl.replace("limit=1", "limit=2"))).status).toBe(400);
    expect((await h.call("/platform/v1/account/sessions?limit=101")).status).toBe(400);
    expect((await h.call("/platform/v1/account/sessions?limit=1&limit=2")).status).toBe(400);
    expect((await h.call("/platform/v1/account/sessions?sort=name")).status).toBe(400);
    await h.challenge("outsider@example.test"); await h.deliver(); await h.complete();
    const outsider = await (await h.call("/platform/v1/account/session")).json() as { session: { id: string } };
    expect((await h.call(nextUrl)).status).toBe(400);
    const outsiderPage = await (await h.call("/platform/v1/account/sessions")).json() as typeof page;
    expect(outsiderPage.items).toHaveLength(1); expect(outsiderPage.items[0]!.id).toBe(outsider.session.id);
    expect((await h.security({ kind: "session-revoke", sessionId: page.items[0]!.id })).status).toBe(404);
    h.cookies.clear(); for (const [key, value] of mainCookies) h.cookies.set(key, value);
    expect((await h.security({ kind: "session-revoke", sessionId: outsider.session.id })).status).toBe(404);
    expect((await h.call("/platform/v1/auth/signout", "POST", undefined, { cookie: firstCookie, "x-csrf-token": firstCsrf })).status).toBe(200);
    // Restore the current browser cookie after another browser's logout response.
    for (const [key, value] of mainCookies) h.cookies.set(key, value);
    expect((await h.call(nextUrl)).status).toBe(400);
    const all = await (await h.call("/platform/v1/account/sessions")).json() as typeof page;
    expect(all.items).toHaveLength(2); expect(all.items.filter(s => s.current)).toHaveLength(1);
    const target = all.items.find(s => !s.current)!;
    const key = crypto.randomUUID();
    expect((await h.security({ kind: "session-revoke", sessionId: target.id }, { "idempotency-key": key })).status).toBe(200);
    expect((await h.security({ kind: "session-revoke", sessionId: target.id }, { "idempotency-key": key, "if-match": all.revision })).status).toBe(200);
    expect((await h.security({ kind: "sessions-revoke-others" }, { "idempotency-key": key, "if-match": all.revision })).status).toBe(409);
    expect((await h.security({ kind: "session-revoke", sessionId: all.items.find(s => s.current)!.id })).status).toBe(400);
    await h.challenge("member@example.test", "login"); await h.deliver(); await h.complete();
    expect((await h.security({ kind: "sessions-revoke-others" })).status).toBe(200);
    const remaining = await (await h.call("/platform/v1/account/sessions")).json() as typeof page;
    expect(remaining.items).toHaveLength(1); expect(remaining.items[0]!.current).toBe(true);
    expect((await h.sql`SELECT revoked_at FROM account_sessions WHERE id = ${outsider.session.id}`)[0].revoked_at).toBeNull();
  });

  test("MFA enrollment expires and replaces pending secrets; concurrent login challenges cannot reuse a counter", async () => {
    const h = await harness(); await h.challenge(); await h.deliver(); await h.complete();
    const old = await (await h.security({ kind: "mfa-start" })).json() as { enrollment: { factorId: string; secret: string } };
    await h.sql`UPDATE mfa_factors SET expires_at = now() - interval '1 second'`;
    expect((await h.security({ kind: "mfa-confirm", factorId: old.enrollment.factorId, code: h.code(old.enrollment.secret) })).status).toBe(404);
    const current = await (await h.security({ kind: "mfa-start" })).json() as typeof old;
    expect((await h.sql`SELECT state, encrypted_secret_reference FROM mfa_factors WHERE id = ${old.enrollment.factorId}`)[0]).toMatchObject({ state: "disabled", encrypted_secret_reference: "" });
    expect((await h.security({ kind: "mfa-confirm", factorId: old.enrollment.factorId, code: h.code(old.enrollment.secret) })).status).toBe(404);
    expect((await h.security({ kind: "mfa-confirm", factorId: current.enrollment.factorId, code: h.code(current.enrollment.secret) })).status).toBe(200);
    await h.challenge("member@example.test", "login"); await h.deliver(); const first = h.token();
    await h.challenge("member@example.test", "login"); await h.deliver(); const second = h.token();
    h.advance(30); const code = h.code(current.enrollment.secret);
    const responses = await Promise.all([first, second].map(token => h.call("/platform/v1/auth/complete", "POST", { token, code })));
    expect(responses.map(r => r.status).sort()).toEqual([200, 401]);
    expect((await h.sql`SELECT count(*)::integer AS n FROM account_challenges WHERE consumed_at IS NULL`)[0].n).toBe(1);
  });
});

test("account encryption binds message context, supports rotation and rejects tampering", async () => {
  const oldKey = randomBytes(32).toString("base64"); const newKey = randomBytes(32).toString("base64");
  const old = new EnvelopeMessageProtector("old", { old: oldKey }); const message = await old.seal("secret link", "challenge-id");
  const rotated = new EnvelopeMessageProtector("new", { old: oldKey, new: newKey });
  expect(await rotated.open(message, "challenge-id")).toBe("secret link");
  await expect(rotated.open(message, "another-id")).rejects.toThrow("Cannot decrypt account notification");
  const damaged = JSON.parse(message); damaged.payload = damaged.payload.slice(0, -4) + "AAAA";
  await expect(rotated.open(JSON.stringify(damaged), "challenge-id")).rejects.toThrow("Cannot decrypt account notification");
  await expect(new EnvelopeMessageProtector("new", { new: newKey }).open(message, "challenge-id")).rejects.toThrow("Cannot decrypt account notification");
  expect(tokenDigest("as_credential")).not.toContain("credential");
});

test('secret envelopes use independent data keys, bind version context, and support wrapping-key rotation', async () => {
  const oldKey = randomBytes(32).toString('base64'); const newKey = randomBytes(32).toString('base64');
  const old = new EnvelopeSecretProtector(new LocalAesSecretKeyCustodian('old', { old: oldKey }));
  const first = await old.seal('first secret value', 'secret:first:version:1');
  expect(first.wrappingKeyId).toBe('old'); expect(first.envelope).not.toContain('first secret value');
  const rotated = new EnvelopeSecretProtector(new LocalAesSecretKeyCustodian('new', { old: oldKey, new: newKey }));
  expect(await rotated.open(first, 'secret:first:version:1')).toBe('first secret value');
  const second = await rotated.seal('second secret value', 'secret:first:version:2');
  expect(second.wrappingKeyId).toBe('new'); expect(second.envelope).not.toBe(first.envelope);
  await credentialRejection(rotated.open(first, 'secret:first:version:2'), 'Cannot decrypt');
  const newOnly = new EnvelopeSecretProtector(new LocalAesSecretKeyCustodian('new', { new: newKey }));
  await credentialRejection(newOnly.open(first, 'secret:first:version:1'), 'Cannot decrypt');
});

test("production configuration never selects the development inbox implicitly", () => {
  expect(accountPlatformConfigFromEnv({})).toBeUndefined();
  expect(() => accountPlatformConfigFromEnv({ CARBON_ACCOUNT_AUTH: "enabled", CARBON_ACCOUNT_EMAIL_PROVIDER: "development-inbox", NODE_ENV: "production" })).toThrow("Configure Resend");
  expect(() => accountPlatformConfigFromEnv({ CARBON_ACCOUNT_AUTH: "enabled", CARBON_ACCOUNT_EMAIL_PROVIDER: "resend" })).toThrow("RESEND_API_KEY");
});

test('secret custody and worker configuration is explicit, complete and never falls back', () => {
  const base = { CARBON_ACCOUNT_AUTH: 'enabled', CARBON_ACCOUNT_EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_fixture', CARBON_ACCOUNT_EMAIL_FROM: 'Carbon <auth@example.test>',
    CARBON_ACCOUNT_ENCRYPTION_KEYS: JSON.stringify({ k: randomBytes(32).toString('base64') }), CARBON_ACCOUNT_ACTIVE_KEY_ID: 'k', CARBON_ACCOUNT_RATE_KEY: randomBytes(32).toString('base64'),
    CARBON_PUBLIC_ORIGIN: 'https://cloud.example.test', CARBON_TERMS_VERSION: '2026-09-12' };
  const local = { ...base, CARBON_SECRETS: 'enabled', CARBON_SECRET_ACTIVE_KEY_ID: 's', CARBON_SECRET_ENCRYPTION_KEYS: JSON.stringify({ s: randomBytes(32).toString('base64') }) };
  expect(accountPlatformConfigFromEnv(base)).toMatchObject({ secrets: undefined, workers: false });
  expect(accountPlatformConfigFromEnv(local)!.secrets).toMatchObject({ custody: 'local', activeKeyId: 's' });
  expect(() => accountPlatformConfigFromEnv({ ...local, CARBON_SECRET_CUSTODY: 'vault' })).toThrow('CARBON_SECRET_CUSTODY must be local or aws-kms');
  const key = 'arn:aws:kms:eu-west-1:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab';
  const kms = { ...base, CARBON_SECRETS: 'enabled', CARBON_SECRET_CUSTODY: 'aws-kms', CARBON_SECRET_ACTIVE_KEY_ID: 'k1', CARBON_SECRET_KMS_KEYS: JSON.stringify({ k1: key }),
    CARBON_SECRET_KMS_REGION: 'eu-west-1', AWS_ACCESS_KEY_ID: 'AKIDEXAMPLE', AWS_SECRET_ACCESS_KEY: 'fixture-secret' };
  expect(accountPlatformConfigFromEnv(kms)!.secrets).toEqual({ custody: 'aws-kms', region: 'eu-west-1', activeKeyId: 'k1', keys: { k1: key }, credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'fixture-secret', sessionToken: undefined } });
  // Selecting KMS never silently uses a local keyring that happens to be present.
  for (const missing of ['CARBON_SECRET_KMS_REGION', 'CARBON_SECRET_KMS_KEYS', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']) {
    expect(() => accountPlatformConfigFromEnv({ ...kms, CARBON_SECRET_ENCRYPTION_KEYS: local.CARBON_SECRET_ENCRYPTION_KEYS, [missing]: '' })).toThrow(missing);
  }
  expect(() => accountPlatformConfigFromEnv({ ...base, CARBON_WORKERS: 'enabled' })).toThrow('CARBON_WORKERS requires CARBON_SECRETS=enabled');
  expect(() => accountPlatformConfigFromEnv({ ...local, CARBON_WORKERS: 'yes' })).toThrow('CARBON_WORKERS must be enabled or disabled');
  expect(accountPlatformConfigFromEnv({ ...local, CARBON_WORKERS: 'enabled' })!.workers).toBe(true);
});

test('catalog transport configuration requires explicit service origins and an active Ed25519 signing key', () => {
  expect(catalogProvisionersFromEnv({})).toEqual({});
  expect(() => catalogProvisionersFromEnv({ CARBON_PROVISIONING_DATABASE_ORIGIN: 'https://database.example.test' })).toThrow('CARBON_ASSERTION_KEY_ID');
  const now = Date.now(); const { privateKey } = generateKeyPairSync('ed25519');
  const env = { CARBON_PROVISIONING_DATABASE_ORIGIN: 'https://database.example.test', CARBON_PUBLIC_ORIGIN: 'https://cloud.example.test', CARBON_ASSERTION_KEY_ID: 'fixture',
    CARBON_ASSERTION_KEY_NOT_BEFORE: new Date(now - 60000).toISOString(), CARBON_ASSERTION_KEY_NOT_AFTER: new Date(now + 3600000).toISOString(),
    CARBON_ASSERTION_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
  expect(Object.keys(catalogProvisionersFromEnv(env))).toEqual(['database']);
  expect(() => catalogProvisionersFromEnv({ ...env, CARBON_ASSERTION_KEY_NOT_AFTER: new Date(now).toISOString() })).toThrow('active');
  expect(() => catalogProvisionersFromEnv({ ...env, CARBON_ASSERTION_PRIVATE_KEY: 'private fixture secret' })).toThrow('Invalid service assertion signing configuration');
  expect(() => catalogProvisionersFromEnv({ ...env, CARBON_PROVISIONING_DATABASE_ORIGIN: 'http://remote.example.test' })).toThrow('HTTPS');
  expect(dataClientFromEnv({})).toBeUndefined();
  expect(importClientFromEnv({})).toBeUndefined();
  expect(importClientFromEnv({ CARBON_DATA_IMPORTS: 'disabled' })).toBeUndefined();
  expect(() => importClientFromEnv({ CARBON_DATA_IMPORTS: 'yes' })).toThrow('enabled or disabled');
  expect(() => importClientFromEnv({ CARBON_DATA_IMPORTS: 'enabled' })).toThrow('CARBON_DATA_DATABASE_ORIGIN');
  expect(importClientFromEnv({ ...env, CARBON_DATA_IMPORTS: 'enabled', CARBON_DATA_DATABASE_ORIGIN: 'https://database.example.test' })).toBeDefined();
  expect(() => dataClientFromEnv({ CARBON_DATA_DATABASE_ORIGIN: 'https://database.example.test' })).toThrow('CARBON_ASSERTION_KEY_ID');
  expect(dataClientFromEnv({ ...env, CARBON_DATA_DATABASE_ORIGIN: 'https://database.example.test' })).toBeDefined();
  expect(() => dataClientFromEnv({ ...env, CARBON_DATA_DATABASE_ORIGIN: 'http://remote.example.test' })).toThrow('HTTPS');
  expect(() => dataClientFromEnv({ ...env, CARBON_DATA_DATABASE_ORIGIN: 'https://database.example.test', CARBON_ASSERTION_PRIVATE_KEY: 'private fixture secret' })).toThrow('Invalid service assertion signing configuration');
});


test("GitHub configuration requires explicit enablement and complete separate OAuth client credentials", () => {
  const env = { CARBON_ACCOUNT_AUTH: "enabled", CARBON_ACCOUNT_EMAIL_PROVIDER: "resend", RESEND_API_KEY: "fixture", CARBON_ACCOUNT_EMAIL_FROM: "auth@example.test",
    CARBON_PUBLIC_ORIGIN: "https://cloud.example.test", CARBON_ACCOUNT_RATE_KEY: randomBytes(32).toString("base64"), CARBON_ACCOUNT_ACTIVE_KEY_ID: "fixture",
    CARBON_ACCOUNT_ENCRYPTION_KEYS: JSON.stringify({ fixture: randomBytes(32).toString("base64") }), CARBON_TERMS_VERSION: "fixture" };
  expect(accountPlatformConfigFromEnv(env)!.github).toBeUndefined();
  expect(accountPlatformConfigFromEnv(env)!.serviceAccountAssertions).toBeUndefined();
  expect(accountPlatformConfigFromEnv(env)!.deviceAssertions).toBeUndefined();
  expect(() => accountPlatformConfigFromEnv({ ...env, CARBON_SERVICE_ACCOUNT_ASSERTIONS: 'yes' })).toThrow('enabled or disabled');
  expect(() => accountPlatformConfigFromEnv({ ...env, CARBON_SERVICE_ACCOUNT_ASSERTIONS: 'enabled' })).toThrow('CARBON_ASSERTION_KEY_ID');
  expect(() => accountPlatformConfigFromEnv({ ...env, CARBON_DEVICE_ASSERTIONS: 'yes' })).toThrow('enabled or disabled');
  expect(() => accountPlatformConfigFromEnv({ ...env, CARBON_DEVICE_ASSERTIONS: 'enabled' })).toThrow('CARBON_ASSERTION_KEY_ID');
  expect(() => accountPlatformConfigFromEnv({ ...env, CARBON_ACCOUNT_GITHUB: "yes" })).toThrow("CARBON_ACCOUNT_GITHUB");
  expect(() => accountPlatformConfigFromEnv({ ...env, CARBON_ACCOUNT_GITHUB: "enabled" })).toThrow("GITHUB_ACCOUNT_CLIENT_ID");
  expect(() => accountPlatformConfigFromEnv({ ...env, CARBON_ACCOUNT_GITHUB: "enabled", GITHUB_ACCOUNT_CLIENT_ID: "fixture" })).toThrow("GITHUB_ACCOUNT_CLIENT_SECRET");
  expect(accountPlatformConfigFromEnv({ ...env, CARBON_ACCOUNT_GITHUB: "enabled", GITHUB_ACCOUNT_CLIENT_ID: "fixture", GITHUB_ACCOUNT_CLIENT_SECRET: "secret" })!.github).toEqual({ clientId: "fixture", clientSecret: "secret" });
  expect(accountPlatformConfigFromEnv(env)!.githubRepositories).toBeUndefined();
  expect(() => accountPlatformConfigFromEnv({ ...env, CARBON_GITHUB_REPOSITORIES: 'yes' })).toThrow('CARBON_GITHUB_REPOSITORIES');
  expect(() => accountPlatformConfigFromEnv({ ...env, CARBON_GITHUB_REPOSITORIES: 'enabled' })).toThrow('GITHUB_APP_ID');
  expect(() => accountPlatformConfigFromEnv({ ...env, CARBON_GITHUB_REPOSITORIES: 'enabled', GITHUB_APP_ID: '42', GITHUB_APP_PRIVATE_KEY: 'key' })).toThrow('GITHUB_APP_WEBHOOK_SECRET');
  expect(accountPlatformConfigFromEnv({ ...env, CARBON_GITHUB_REPOSITORIES: 'enabled', GITHUB_APP_ID: '42', GITHUB_APP_PRIVATE_KEY: 'line1\\nline2', GITHUB_APP_WEBHOOK_SECRET: 'hook' })!.githubRepositories).toEqual({ appId: '42', privateKey: 'line1\nline2', webhookSecret: 'hook' });
  expect(accountPlatformConfigFromEnv(env)!.secrets).toBeUndefined();
  expect(() => accountPlatformConfigFromEnv({ ...env, CARBON_SECRETS: 'yes' })).toThrow('CARBON_SECRETS');
  expect(() => accountPlatformConfigFromEnv({ ...env, CARBON_SECRETS: 'enabled' })).toThrow('CARBON_SECRET_ENCRYPTION_KEYS');
  const secretKey = randomBytes(32).toString('base64');
  expect(accountPlatformConfigFromEnv({ ...env, CARBON_SECRETS: 'enabled', CARBON_SECRET_ACTIVE_KEY_ID: 'fixture',
    CARBON_SECRET_ENCRYPTION_KEYS: JSON.stringify({ fixture: secretKey }) })!.secrets).toEqual({ custody: 'local', activeKeyId: 'fixture', encryptionKeys: { fixture: secretKey } });
});

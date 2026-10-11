import { afterEach, describe, expect, test } from 'bun:test';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { AccountAuthentication, PostgresAccountIdentityRepository, EnvelopeMessageProtector, PostgresMfaVerification, Rfc6238Totp,
  OrganizationAccess, PostgresOrganizationRepository, AccountServiceAccounts, PostgresServiceAccountRepository, ServiceAssertionIssuer, opaqueToken, tokenDigest, bodyDigest, type AssertionTrust } from '@carbon/identity';
import { AccountRegistry, HttpRegistryClient, PostgresAccountRegistryAuthority, RegistryTrustError, libraryFile, manifestDigest, manifestFile, packArchive, publicKeyHex, signTrustBundle, verifyRegistryPackage, type RegistryArchiveStore } from '@carbon/catalog';
import { AccountCatalog, PostgresCatalogRepository, PostgresProvisioningRepository, ProvisionEnvironment, HttpEnvironmentProvisioner,
  PostgresServiceLifecycleRepository, PostgresDatabaseEnvironmentDriver, databaseEnvironmentIdentifiers, type ProvisioningWork } from '@carbon/catalog';
import { parseComponent, serviceLifecycleBody, dataPermission, dataRequestPath, canonicalRegistryRequest, registryRequestPath } from '@carbon/contracts/platform';
import { AppAuthentication, PostgresAppAuthRepository } from '@carbon/auth';
import { AccountBlobs, AccountEngine, HttpBlobClient, HttpEngineClient, type BlobStore } from '@carbon/data';
import { HttpDataClient, AccountData, PostgresAccountDataAuthority, AccountImports, PostgresImportJobs, HttpImportClient, RunImportJobs, AccountExports, ExportDownloads, PostgresExportJobs, RunExportJobs,
  type ExportJobs, type ExportStore } from '@carbon/data';
import { createExportRoutes } from '../../../products/carbon-cloud/infrastructure/http/export-routes.ts';
import { migrate as migrateCloud } from '../../../products/carbon-cloud/infrastructure/persistence/Database.ts';
import { migrate as migrateDatabase } from '../../../products/carbon-database/infrastructure/persistence/Database.ts';
import { migrate as migrateRegistry } from '../../../products/carbon-registry/infrastructure/persistence/Database.ts';
import { createAccountRoutes } from '../../../products/carbon-cloud/infrastructure/http/account-routes.ts';
import { composeServiceAuthority } from '../../../products/carbon-cloud/composition/service-authority.ts';
import { composeLifecyclePlatform as composeDatabase } from '../../../products/carbon-database/composition/lifecycle-platform.ts';
import { composeLifecyclePlatform as composeRegistry } from '../../../products/carbon-registry/composition/lifecycle-platform.ts';

const databaseUrl = process.env.CARBON_SERVICE_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) { await cleanups.at(-1)!(); cleanups.pop(); } }, 30000);

async function harness() {
  const url = new URL(databaseUrl!); if (url.pathname !== '/carbon_service_test') throw new Error('Requires dedicated carbon_service_test database');
  const admin = new Bun.SQL(url.href, { max: 1 }); const id = crypto.randomUUID().replaceAll('-', '');
  const stores: { name: string; sql: Bun.SQL; owner: string }[] = []; const servers: ReturnType<typeof Bun.serve>[] = [];
  cleanups.push(async () => {
    for (const server of servers) await server.stop(true);
    for (const store of stores) {
      const exists = await store.sql`SELECT to_regclass('public.platform_environments') AS name`;
      const roles: string[] = store.owner === 'database' && exists[0].name ? (await store.sql<{ environment_id: string }[]>`SELECT environment_id FROM platform_environments`).map(row => databaseEnvironmentIdentifiers(row.environment_id).role) : [];
      await store.sql.close();
      if (!new RegExp(`^carbon_service_test_${id}_(cloud|database|registry)$`).test(store.name)) throw new Error('Unsafe test database cleanup');
      await admin.unsafe(`DROP DATABASE "${store.name}"`);
      for (const role of roles) { if (!/^ce_[a-f0-9]{32}$/.test(role)) throw new Error('Unsafe role cleanup'); await admin.unsafe(`DROP ROLE "${role}"`); }
    }
    await admin.close();
  });
  for (const owner of ['cloud', 'database', 'registry']) {
    const name = `carbon_service_test_${id}_${owner}`; await admin.unsafe(`CREATE DATABASE "${name}"`);
    const target = new URL(url); target.pathname = '/' + name; stores.push({ owner, name, sql: new Bun.SQL(target.href, { max: 3 }) });
  }
  const [cloud, database, registry] = stores.map(store => store.sql) as [Bun.SQL, Bun.SQL, Bun.SQL];
  await migrateCloud(cloud); await migrateDatabase(database); await migrateRegistry(registry);
  const origin = 'https://cloud.example.test'; const { privateKey, publicKey } = generateKeyPairSync('ed25519'); const now = Date.now() / 1000;
  const key = { id: 'test-key', notBefore: now - 60, notAfter: now + 3600 }; const trust: AssertionTrust = { issuer: origin, keys: [{ ...key, key: publicKey }] };
  const issuer = new ServiceAssertionIssuer(origin, { ...key, key: privateKey });
  let authorityCalls = 0; let beforeAuthority: ((call: number) => Promise<void>) | undefined;
  let authority = composeServiceAuthority(cloud, trust);
  const cloudServer = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => { authorityCalls++; await beforeAuthority?.(authorityCalls); return authority(request); } }); servers.push(cloudServer);
  // Stands in for the private blob bucket. A test can make the next writes fail, as a storage outage would.
  const blobObjects = new Map<string, Uint8Array>(); let failBlobWrites = 0; let duringBlobWrite: (() => Promise<void>) | undefined;
  const blobStore: BlobStore = { async put(key, bytes) { const during = duringBlobWrite; duringBlobWrite = undefined; await during?.(); if (failBlobWrites > 0) { failBlobWrites--; throw new Error('storage unavailable'); } blobObjects.set(key, bytes); },
    async get(key) { return blobObjects.get(key) ?? null; }, async delete(key) { blobObjects.delete(key); } };
  let databaseHandler: ReturnType<typeof composeDatabase>;
  let registryHandler: ReturnType<typeof composeRegistry>;
  const databaseServer = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: request => databaseHandler(request) }); servers.push(databaseServer);
  const databaseConfig = () => ({ trust, authorityOrigin: cloudServer.url.origin, blobs: { store: blobStore, origin: databaseServer.url.origin } });
  databaseHandler = composeDatabase(database, databaseConfig());
  const registryServer = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: request => registryHandler(request) }); servers.push(registryServer);
  // Stands in for Registry's private archive bucket, and for the offline root that signs its trust bundle.
  const registryObjects = new Map<string, Uint8Array>();
  const registryStore: RegistryArchiveStore = { async put(key, bytes) { registryObjects.set(key, bytes); }, async get(key) { return registryObjects.get(key) ?? null; }, async delete(key) { registryObjects.delete(key); } };
  const registryRootSeed = randomBytes(32).toString('hex'); const registrySigningSeed = randomBytes(32).toString('hex');
  const registryBundle = signTrustBundle(registryRootSeed, { sequence: 1, issuedAt: new Date().toISOString(), keys: [{ id: 'registry-test', publicKey: publicKeyHex(registrySigningSeed), state: 'active' }] });
  const registryConfig = () => ({ trust, authorityOrigin: cloudServer.url.origin, publishing: { store: registryStore, origin: registryServer.url.origin, rootPublicKey: publicKeyHex(registryRootSeed), trustBundle: registryBundle,
    signingKeyId: 'registry-test', signingSeed: registrySigningSeed, limits: { publishersPerOrganization: 2, pendingPerPublisher: 2, uploadSeconds: 900 } } });
  registryHandler = composeRegistry(registry, registryConfig());
  const repo = new PostgresProvisioningRepository(cloud);
  const databaseProvider = new HttpEnvironmentProvisioner('database', databaseServer.url.origin, issuer);
  const registryProvider = new HttpEnvironmentProvisioner('registry', registryServer.url.origin, issuer);
  const worker = new ProvisionEnvironment(repo, { database: databaseProvider, registry: registryProvider });
  const protector = new EnvelopeMessageProtector('test', { test: randomBytes(32).toString('base64') });
  const config = { origin, termsVersion: 'fixture', rateLimitKey: randomBytes(32).toString('base64') };
  const mfa = new PostgresMfaVerification(protector, new Rfc6238Totp());
  const auth = new AccountAuthentication(new PostgresAccountIdentityRepository(cloud, mfa), protector, config);
  const importJobs = new PostgresImportJobs(cloud, protector); const importClient = new HttpImportClient(databaseServer.url.origin, issuer);
  const importWorker = new RunImportJobs(importJobs, importClient);
  // Stands in for the private export bucket. A test can make the next writes fail, as a storage outage would.
  const exportObjects = new Map<string, Uint8Array>(); const exportWrites: string[] = []; let failWrites = 0;
  const exportStore: ExportStore = {
    async put(key, bytes) { if (failWrites > 0) { failWrites--; throw new Error('storage unavailable'); } exportWrites.push(key); exportObjects.set(key, bytes); },
    async get(key) { return exportObjects.get(key) ?? null; }, async delete(key) { exportObjects.delete(key); } };
  const exportJobs = new PostgresExportJobs(cloud);
  const account = crypto.randomUUID(); const session = crypto.randomUUID(); const token = opaqueToken('as'); const csrf = opaqueToken('csrf');
  // Verified account/session fixture; all catalog and remote identities are created through the real APIs below.
  await cloud`INSERT INTO accounts (id, primary_email, name, verified_at, terms_version) VALUES (${account}, 'owner@example.test', 'Owner', now(), 'fixture')`;
  await cloud`INSERT INTO account_sessions (id, account_id, token_hash, csrf_hash, security_revision, device_name, expires_at, fresh_until)
    VALUES (${session}, ${account}, ${tokenDigest(token)}, ${tokenDigest(csrf)}, 1, 'Fixture', now() + interval '8 hours', now() + interval '10 minutes')`;
  const apiHandler = createAccountRoutes(auth, origin, undefined, undefined, new OrganizationAccess(auth, new PostgresOrganizationRepository(cloud), protector), undefined, undefined, undefined,
    new AccountCatalog(auth, new PostgresCatalogRepository(cloud), protector), new AccountData(auth, new PostgresAccountDataAuthority(cloud), new HttpDataClient(databaseServer.url.origin, issuer), protector, { pollMs: 25, heartbeatMs: 150, maxMs: 6000 }), new AccountImports(auth, importJobs),
    undefined, undefined, undefined, undefined, new AccountServiceAccounts(auth, new PostgresServiceAccountRepository(cloud), protector, issuer),
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, new AccountExports(auth, exportJobs, origin),
    new AccountBlobs(auth, new PostgresAccountDataAuthority(cloud), new HttpBlobClient(databaseServer.url.origin, issuer)),
    new AccountEngine('vectors', auth, new PostgresAccountDataAuthority(cloud), new HttpEngineClient('vectors', databaseServer.url.origin, issuer)),
    new AccountEngine('graph', auth, new PostgresAccountDataAuthority(cloud), new HttpEngineClient('graph', databaseServer.url.origin, issuer)), undefined,
    new AccountRegistry(auth, new PostgresAccountRegistryAuthority(cloud), new HttpRegistryClient(registryServer.url.origin, issuer)));
  const downloadHandler = createExportRoutes(new ExportDownloads(exportJobs, exportStore));
  const api = (path: string, input?: unknown, revision?: string, overrides?: Record<string, string>) => apiHandler(new Request(origin + path, { method: input === undefined ? 'GET' : 'POST',
    headers: { origin, cookie: `__Host-carbon-session=${token}`, 'x-csrf-token': csrf, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID(), ...(revision ? { 'if-match': revision } : {}), ...Object.fromEntries(new Headers(overrides)) },
    body: input === undefined ? undefined : JSON.stringify(input) }), '127.0.0.1');
  const organization = parseComponent('OrganizationReceipt', (await (await api('/platform/v1/orgs', { name: 'Integration', slug: 'integration' })).json() as { receipt: unknown }).receipt);
  const create = async (slug = 'app', services = ['database', 'registry']) => {
    const current = await (await api(`/platform/v1/orgs/${organization.id}`)).json() as { organization: { revision: string } };
    const response = await api(`/platform/v1/orgs/${organization.id}/projects`, { name: slug, slug, services }, current.organization.revision);
    expect(response.status).toBe(202); return parseComponent('CatalogReceipt', (await response.json() as { receipt: unknown }).receipt);
  };
  const signed = async (work: ProvisioningWork) => {
    const body = serviceLifecycleBody({ scope: parseComponent('EnvironmentScope', work.scope), bindingId: work.bindingId, operationId: work.operationId, stepId: work.stepId, leaseId: work.leaseId, action: work.action, remoteResourceId: work.remoteResourceId });
    const path = `/internal/platform/v1/environments/${work.scope.environmentId}/lifecycle`;
    const proof = await issuer.issue({ aud: work.owner === 'database' ? 'carbon-database' : 'carbon-registry', principal: work.principal, scope: work.scope, roles: [work.role],
      grants: work.grants.filter(g => g.permission === 'resources.configure'), requestId: work.requestId, request: { method: 'POST', path, bodyDigest: bodyDigest(body) } });
    return { url: (work.owner === 'database' ? databaseServer.url.origin : registryServer.url.origin) + path,
      init: { method: 'POST', body, headers: { authorization: `Bearer ${proof}`, 'content-type': 'application/json', 'idempotency-key': work.stepId, 'x-request-id': work.requestId } } };
  };
  const signedData = async (input: unknown, audience: 'carbon-database' | 'carbon-registry' = 'carbon-database') => {
    const request = parseComponent('DataRequest', input); const body = JSON.stringify(request); const requestId = crypto.randomUUID();
    const current = (await cloud`SELECT permission_revision::text FROM accounts WHERE id = ${account}`)[0];
    const principal = { id: account, kind: 'account' as const, audience: 'dashboard' as const, credentialId: session, permissionRevision: current.permission_revision };
    const path = dataRequestPath(request.scope, request.bindingId, request.command.kind);
    const proof = await issuer.issue({ aud: audience, principal, scope: request.scope, roles: ['Owner'], grants: [{ permission: dataPermission(request.command.kind), scope: request.scope }], requestId,
      request: { method: 'POST', path, bodyDigest: bodyDigest(body) } });
    return { url: databaseServer.url.origin + path, init: { method: 'POST', body, headers: { authorization: `Bearer ${proof}`, 'content-type': 'application/json', 'x-request-id': requestId,
      ...('commandId' in request.command ? { 'idempotency-key': request.command.commandId } : {}) } } };
  };
  const dataClient = new HttpDataClient(databaseServer.url.origin, issuer);
  const clientData = async (input: unknown) => dataClient.execute(parseComponent('DataRequest', input), {
    principal: { id: account, kind: 'account', audience: 'dashboard', credentialId: session, permissionRevision: (await cloud`SELECT permission_revision::text FROM accounts WHERE id = ${account}`)[0].permission_revision },
    role: 'Owner', requestId: crypto.randomUUID(),
  });
  // A fresh worker over the same database and storage, as after a process restart. `jobs` lets a test break one step.
  const exportWorker = (jobs: ExportJobs = new PostgresExportJobs(cloud)) => new RunExportJobs(jobs, dataClient, exportStore);
  const download = (url: string, method = 'GET') => downloadHandler(new Request(url, { method }));
  return { blobObjects, failBlobWrites: (count: number) => { failBlobWrites = count; }, duringBlobWrite: (work: () => Promise<void>) => { duringBlobWrite = work; }, sweepBlobs: () => databaseHandler.blobStorage!.sweep(), apiHandler, token, csrf, origin,
    exportJobs, restartExports: (): ExportJobs => new PostgresExportJobs(cloud), exportWorker, exportObjects, exportWrites, failExportWrites: (count: number) => { failWrites = count; }, download, session,
    registryObjects, registryRoot: publicKeyHex(registryRootSeed), get registryReview() { return registryHandler.review!; },
    cloud, database, registry, issuer, protector, worker, repo, api, create, signed, signedData, clientData, account, organization, databaseProvider, registryProvider, databaseServer, registryServer,
    importJobs, importClient, importWorker, restartImports: () => new PostgresImportJobs(cloud, protector),
    interceptAuthority: (callback?: (call: number) => Promise<void>) => { authorityCalls = 0; beforeAuthority = callback; },
    restart: () => { authority = composeServiceAuthority(cloud, trust); databaseHandler = composeDatabase(database, databaseConfig()); registryHandler = composeRegistry(registry, registryConfig()); },
  };
}

suite('Cloud-to-owning-service lifecycle over real HTTP and PostgreSQL', () => {
  test('durable import API stages encrypted input, enforces browser authority, and commits partial results once', async () => {
    const h = await harness(); const created = await h.create('import-api', ['database']); expect(await h.worker.execute()).toBe(true);
    const scope = parseComponent('EnvironmentScope', created.scope);
    const envPath = `/platform/v1/orgs/${scope.orgId}/projects/${scope.projectId}/environments/${scope.environmentId}`;
    const path = envPath + '/data'; const imports = path + '/imports'; const tableId = crypto.randomUUID();
    const env = parseComponent('CatalogEnvironmentDetails', await (await h.api(envPath)).json());
    const create = { kind: 'table.create', commandId: crypto.randomUUID(), tableId, definition: { name: 'imported', columns: [{ name: 'owner', type: 'uuid', nullable: false, default: { kind: 'literal', value: h.account } }, { name: 'body', type: 'text', nullable: false }], policies: { enabled: true, rules: [{ id: crypto.randomUUID(), name: 'Owner', kind: 'owner', ownerColumn: 'owner', operations: ['select', 'insert', 'update', 'delete'] }] } } };
    expect((await h.api(path, create, env.environment.revision, { 'idempotency-key': create.commandId })).status).toBe(200);
    const command = { kind: 'import.enqueue', commandId: crypto.randomUUID(), tableId, revision: '1', access: { mode: 'policy-preview', userId: h.account },
      input: { format: 'json', text: '[{"body":"private staged source"},{}]', mapping: {}, conflict: 'error', atomic: false } };
    const headers = { 'idempotency-key': command.commandId };
    expect((await h.api(imports, command, '1', { ...headers, cookie: '' })).status).toBe(401);
    expect((await h.api(imports, command, '1', { ...headers, 'x-csrf-token': 'bad' })).status).toBe(403);
    expect((await h.api(imports, command, '1', { ...headers, origin: 'https://foreign.example.test' })).status).toBe(403);
    expect((await h.api(imports, command, '2', headers)).status).toBe(400);
    const queued = await Promise.all([h.api(imports, command, '1', headers), h.api(imports, command, '1', headers)]);
    expect(queued.map(response => response.status)).toEqual([202, 202]);
    const receipt = parseComponent('DataImportJobReceipt', (await queued[0]!.json() as { receipt: unknown }).receipt);
    expect((await queued[1]!.json() as { receipt: unknown }).receipt).toEqual(receipt);
    expect((await h.api(imports, { ...command, input: { ...command.input, text: '[]' } }, '1', headers)).status).toBe(409);
    const stored = (await h.cloud`SELECT * FROM data_import_jobs WHERE id = ${receipt.operationId}`)[0];
    expect(stored.sealed_execution.length).toBeGreaterThan(100); expect(JSON.stringify(stored)).not.toContain('private staged source');
    const statusPath = `${imports}/${receipt.operationId}/status`;
    const before = parseComponent('DataImportJobView', await (await h.api(statusPath, {})).json());
    expect(before.operation.state).toBe('queued'); expect(before.result).toBeNull(); expect(JSON.stringify(before)).not.toContain('authority_actor');
    expect((await h.api(statusPath, {}, undefined, { 'x-csrf-token': '' })).status).toBe(403);
    expect((await h.api(statusPath + '?orgId=' + scope.orgId, {})).status).toBe(400);
    expect(await h.importWorker.execute()).toBe(true);
    const after = parseComponent('DataImportJobView', await (await h.api(statusPath, {})).json());
    expect(after.operation.state).toBe('partially_succeeded'); expect(after.outcomeUnknown).toBe(false);
    expect(after.result).toMatchObject({ total: 2, inserted: 1, updated: 0, skipped: 0, failed: 1 });
    expect((await h.cloud`SELECT sealed_execution FROM data_import_jobs WHERE id = ${receipt.operationId}`)[0].sealed_execution).toBe('');
    expect(JSON.stringify(await h.cloud`SELECT detail FROM data_import_job_events WHERE operation_id = ${receipt.operationId}`)).not.toContain('private staged source');
    expect(await h.importWorker.execute()).toBe(false);
    expect((await h.database`SELECT count(*)::int AS count FROM canonical_data_commands WHERE command_id = ${command.commandId}`)[0].count).toBe(1);
    const cancelled = { ...command, commandId: crypto.randomUUID() };
    const cancelReceipt = parseComponent('DataImportJobReceipt', (await (await h.api(imports, cancelled, '1', { 'idempotency-key': cancelled.commandId })).json() as { receipt: unknown }).receipt);
    const cancel = { commandId: crypto.randomUUID(), revision: cancelReceipt.revision }; const cancelPath = `${imports}/${cancelReceipt.operationId}/cancel`;
    const cancelResponse = await h.api(cancelPath, cancel, cancel.revision, { 'idempotency-key': cancel.commandId }); expect(cancelResponse.status).toBe(202);
    expect(await (await h.api(cancelPath, cancel, cancel.revision, { 'idempotency-key': cancel.commandId })).json()).toEqual(await cancelResponse.json());
    expect(parseComponent('DataImportJobView', await (await h.api(`${imports}/${cancelReceipt.operationId}/status`, {})).json()).operation.state).toBe('cancelled');
    expect(await h.importWorker.execute()).toBe(false);
  }, 30000);
  test('import workers reconcile lost replies and expired leases before cancellation or re-execution', async () => {
    const h = await harness(); const created = await h.create('import-recovery', ['database']); expect(await h.worker.execute()).toBe(true);
    const scope = parseComponent('EnvironmentScope', created.scope); const envPath = `/platform/v1/orgs/${scope.orgId}/projects/${scope.projectId}/environments/${scope.environmentId}`;
    const path = envPath + '/data'; const imports = path + '/imports'; const tableId = crypto.randomUUID();
    const env = parseComponent('CatalogEnvironmentDetails', await (await h.api(envPath)).json());
    const create = { kind: 'table.create', commandId: crypto.randomUUID(), tableId, definition: { name: 'recovered', columns: [{ name: 'owner', type: 'uuid', nullable: false, default: { kind: 'literal', value: h.account } }, { name: 'body', type: 'text', nullable: false }], policies: { enabled: true, rules: [{ id: crypto.randomUUID(), name: 'Owner', kind: 'owner', ownerColumn: 'owner', operations: ['select', 'insert', 'update', 'delete'] }] } } };
    expect((await h.api(path, create, env.environment.revision, { 'idempotency-key': create.commandId })).status).toBe(200);
    const enqueue = async () => {
      const command = { kind: 'import.enqueue', commandId: crypto.randomUUID(), tableId, revision: '1', access: { mode: 'policy-preview', userId: h.account }, input: { format: 'json', text: '[{"body":"recover"}]', mapping: {}, conflict: 'error', atomic: true } };
      return parseComponent('DataImportJobReceipt', (await (await h.api(imports, command, '1', { 'idempotency-key': command.commandId })).json() as { receipt: unknown }).receipt);
    };
    const status = async (id: string) => parseComponent('DataImportJobView', await (await h.api(`${imports}/${id}/status`, {})).json());
    const receipt = await enqueue();
    const lost = new RunImportJobs(h.importJobs, { status: work => h.importClient.status(work), execute: async work => { await h.importClient.execute(work); throw new Error('response lost'); } });
    expect(await lost.execute()).toBe(true);
    const interrupted = await status(receipt.operationId); expect(interrupted.operation.state).toBe('running'); expect(interrupted.result).toBeNull();
    const cancel = { commandId: crypto.randomUUID(), revision: interrupted.operation.revision };
    expect((await h.api(`${imports}/${receipt.operationId}/cancel`, cancel, cancel.revision, { 'idempotency-key': cancel.commandId })).status).toBe(202);
    await h.cloud`UPDATE data_import_jobs SET next_attempt_at = now() WHERE id = ${receipt.operationId}`;
    expect(await new RunImportJobs(h.restartImports(), h.importClient).execute()).toBe(true);
    const recovered = await status(receipt.operationId); expect(recovered.operation.state).toBe('succeeded'); expect(recovered.operation.cancellationRequested).toBe(true);
    expect(recovered.result?.inserted).toBe(1); expect(recovered.outcomeUnknown).toBe(false);
    const second = await enqueue(); const old = await h.importJobs.claim(); if (!old || old === 'settled') throw new Error('Missing initial lease');
    await h.cloud`UPDATE data_import_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = ${second.operationId}`;
    const replacement = await h.restartImports().claim(); if (!replacement || replacement === 'settled') throw new Error('Missing recovery lease');
    expect(replacement.phase).toBe('reconcile'); expect(replacement.request.leaseId).not.toBe(old.request.leaseId);
    let rejected: unknown; try { await h.importClient.execute(old); } catch (error) { rejected = error; } expect(rejected).toBeDefined();
    expect(await h.importClient.status(replacement)).toBeNull();
    const approved = await h.importJobs.allowExecution(replacement); if (!approved) throw new Error('Missing execution approval');
    const secondResult = await h.importClient.execute(approved);
    expect(await h.importJobs.finish(approved, secondResult)).toBe(true);
    expect(await h.importJobs.finish(old, secondResult)).toBe(false);
    expect((await status(second.operationId)).operation.state).toBe('succeeded');
    expect((await h.database`SELECT count(*)::int AS count FROM canonical_data_commands WHERE table_id = ${tableId} AND result ? 'inserted'`)[0].count).toBe(2);
    // A revoked session cannot inspect the receipt: retain an explicit unknown outcome.
    const unknown = await enqueue(); expect(await lost.execute()).toBe(true);
    await h.cloud`UPDATE account_sessions SET revoked_at = now() WHERE account_id = ${h.account}`;
    await h.cloud`UPDATE data_import_jobs SET next_attempt_at = now() WHERE id = ${unknown.operationId}`;
    expect(await new RunImportJobs(h.restartImports(), h.importClient).execute()).toBe(true);
    const review = (await h.cloud`SELECT state, outcome_unknown, result, sealed_execution FROM data_import_jobs WHERE id = ${unknown.operationId}`)[0];
    expect(review).toMatchObject({ state: 'failed', outcome_unknown: true, result: null }); expect(review.sealed_execution.length).toBeGreaterThan(100);
    expect((await h.database`SELECT count(*)::int AS count FROM canonical_data_commands WHERE command_id = ${unknown.commandId}`)[0].count).toBe(1);
  }, 30000);
  test('import cancellation and permission revocation roll back in-flight writes and reconcile without write access', async () => {
    const h = await harness(); const created = await h.create('import-revoked', ['database']); expect(await h.worker.execute()).toBe(true);
    const scope = parseComponent('EnvironmentScope', created.scope); const envPath = `/platform/v1/orgs/${scope.orgId}/projects/${scope.projectId}/environments/${scope.environmentId}`;
    const path = envPath + '/data'; const imports = path + '/imports'; const tableId = crypto.randomUUID();
    const env = parseComponent('CatalogEnvironmentDetails', await (await h.api(envPath)).json());
    const create = { kind: 'table.create', commandId: crypto.randomUUID(), tableId, definition: { name: 'revoked_import',
      columns: [{ name: 'owner', type: 'uuid', nullable: false, default: { kind: 'literal', value: h.account } }, { name: 'body', type: 'text', nullable: false }],
      policies: { enabled: true, rules: [{ id: crypto.randomUUID(), name: 'Owner', kind: 'owner', ownerColumn: 'owner', operations: ['select', 'insert'] }] } } };
    expect((await h.api(path, create, env.environment.revision, { 'idempotency-key': create.commandId })).status).toBe(200);
    const enqueue = async (revision = '1') => {
      const command = { kind: 'import.enqueue', commandId: crypto.randomUUID(), tableId, revision, access: { mode: 'policy-preview', userId: h.account }, input: { format: 'json', text: '[{"body":"must roll back"}]', mapping: {}, conflict: 'error', atomic: true } };
      return parseComponent('DataImportJobReceipt', (await (await h.api(imports, command, revision, { 'idempotency-key': command.commandId })).json() as { receipt: unknown }).receipt);
    };
    const status = async (id: string) => parseComponent('DataImportJobView', await (await h.api(`${imports}/${id}/status`, {})).json());
    const cancelReceipt = await enqueue(); let checks = 0;
    h.interceptAuthority(async call => {
      checks = call;
      if (call === 4) {
        const current = await status(cancelReceipt.operationId); const cancel = { commandId: crypto.randomUUID(), revision: current.operation.revision };
        expect((await h.api(`${imports}/${cancelReceipt.operationId}/cancel`, cancel, cancel.revision, { 'idempotency-key': cancel.commandId })).status).toBe(202);
      }
    });
    expect(await h.importWorker.execute()).toBe(true); expect(checks).toBe(4); h.interceptAuthority();
    expect((await status(cancelReceipt.operationId)).operation.state).toBe('cancel_requested');
    await h.cloud`UPDATE data_import_jobs SET next_attempt_at = now() WHERE id = ${cancelReceipt.operationId}`;
    expect(await h.importWorker.execute()).toBe(true);
    expect(await status(cancelReceipt.operationId)).toMatchObject({ operation: { state: 'cancelled' }, outcomeUnknown: false, result: null });
    expect((await h.database`SELECT count(*)::int AS count FROM canonical_data_commands WHERE command_id = ${cancelReceipt.commandId}`)[0].count).toBe(0);
    const stale = await enqueue('999'); expect(await h.importWorker.execute()).toBe(true);
    await h.cloud`UPDATE data_import_jobs SET next_attempt_at = now() WHERE id = ${stale.operationId}`;
    expect(await h.importWorker.execute()).toBe(true);
    expect(await status(stale.operationId)).toMatchObject({ operation: { state: 'failed' }, outcomeUnknown: false, result: null });
    const revoked = await enqueue();
    const owner = crypto.randomUUID();
    await h.cloud`INSERT INTO accounts (id, primary_email, name, verified_at, terms_version) VALUES (${owner}, 'import-owner@example.test', 'Owner', now(), 'fixture')`;
    await h.cloud`INSERT INTO memberships (id, account_id, org_id, role, state) VALUES (${crypto.randomUUID()}, ${owner}, ${scope.orgId}, 'Owner', 'active')`;
    h.interceptAuthority(async call => {
      if (call === 4) {
        await h.cloud`UPDATE memberships SET role = 'Viewer', revision = revision + 1 WHERE account_id = ${h.account} AND org_id = ${scope.orgId}`;
        await h.cloud`UPDATE accounts SET permission_revision = permission_revision + 1 WHERE id = ${h.account}`;
      }
    });
    expect(await h.importWorker.execute()).toBe(true); h.interceptAuthority();
    await h.cloud`UPDATE data_import_jobs SET next_attempt_at = now() WHERE id = ${revoked.operationId}`;
    expect(await new RunImportJobs(h.restartImports(), h.importClient).execute()).toBe(true);
    expect(await status(revoked.operationId)).toMatchObject({ operation: { state: 'failed' }, outcomeUnknown: false, result: null });
    expect((await h.database`SELECT count(*)::int AS count FROM canonical_data_commands WHERE command_id = ${revoked.commandId}`)[0].count).toBe(0);
  }, 30000);
  test('private exports are durable jobs: authorized at every step, resumable after outages and crashes, cancellable, and downloadable once', async () => {
    const h = await harness(); const created = await h.create('export-api', ['database']); expect(await h.worker.execute()).toBe(true);
    const scope = parseComponent('EnvironmentScope', created.scope);
    const envPath = `/platform/v1/orgs/${scope.orgId}/projects/${scope.projectId}/environments/${scope.environmentId}`; const dataPath = envPath + '/data'; const exportsPath = dataPath + '/exports';
    const env = parseComponent('CatalogEnvironmentDetails', await (await h.api(envPath)).json()); const tableId = crypto.randomUUID(); const stranger = crypto.randomUUID();
    const create = { kind: 'table.create', commandId: crypto.randomUUID(), tableId, definition: { name: 'ledger', columns: [{ name: 'owner', type: 'uuid', nullable: false }, { name: 'body', type: 'text', nullable: false },
      { name: 'amount', type: 'decimal', nullable: false }, { name: 'tags', type: 'text[]', nullable: true }], policies: { enabled: true, rules: [{ id: crypto.randomUUID(), name: 'Owner', kind: 'owner', ownerColumn: 'owner', operations: ['select', 'insert', 'update', 'delete'] }] } } };
    expect((await h.api(dataPath, create, env.environment.revision, { 'idempotency-key': create.commandId })).status).toBe(200);
    // 10,203 rows the account owns, a few awkward ones, and 7 that belong to someone else. Written straight into the native table.
    const names = databaseEnvironmentIdentifiers(scope.environmentId); const target = `"${names.schema}"."ct_${tableId.replaceAll('-', '')}"`; const OWNED = 10203;
    await h.database.unsafe(`INSERT INTO ${target} (owner, body, amount) SELECT $1::uuid, 'row ' || g, (g::numeric / 100) FROM generate_series(1, ${OWNED - 3}) g`, [h.account]);
    await h.database.unsafe(`INSERT INTO ${target} (owner, body, amount, tags) VALUES ($1::uuid, '=SUM(A1:A9)', 9007199254740993.123456789, ARRAY['a,b', 'c"d']), ($1::uuid, E'two\nlines, "quoted"', -0.50, NULL), ($1::uuid, ' padded ', 0, ARRAY[]::text[])`, [h.account]);
    await h.database.unsafe(`INSERT INTO ${target} (owner, body, amount) SELECT $1::uuid, 'not yours ' || g, 1 FROM generate_series(1, 7) g`, [stranger]);
    const command = (overrides: Record<string, unknown> = {}) => ({ kind: 'export.enqueue', commandId: crypto.randomUUID(), tableId, format: 'jsonl', access: { mode: 'policy-preview', userId: h.account }, ...overrides });
    const enqueue = async (input: Record<string, unknown>, overrides: Record<string, string> = {}) => h.api(exportsPath, input, undefined, { 'idempotency-key': input.commandId as string, ...overrides });
    const queued = async (input: Record<string, unknown>) => { const response = await enqueue(input); expect(response.status).toBe(202); return parseComponent('DataExportReceipt', await response.json()).job; };
    const status = async (id: string) => parseComponent('DataExportJob', (await (await h.api(`${exportsPath}/${id}/status`, {})).json() as { job: unknown }).job);
    const row = async (id: string) => (await h.cloud`SELECT state, attempt, part_count, row_count::integer AS row_count, after_row_id, lease_id, error_code FROM data_export_jobs WHERE id = ${id}`)[0];
    const due = async (id: string) => { await h.cloud`UPDATE data_export_jobs SET next_attempt_at = now() - interval '1 second' WHERE id = ${id}`; };
    const drain = async () => { for (let turn = 0; turn < 20 && await h.exportWorker().execute(); turn++); };
    const link = async (id: string) => { const response = await h.api(`${exportsPath}/${id}/download`, {}); expect(response.status).toBe(201); return parseComponent('DataExportDownload', await response.json()); };

    // Starting an export: session, CSRF, origin, a matching command identity, and a recently authenticated session.
    const first = command();
    expect((await enqueue(first, { cookie: '' })).status).toBe(401); expect((await enqueue(first, { 'x-csrf-token': 'bad' })).status).toBe(403);
    expect((await enqueue(first, { origin: 'https://foreign.example.test' })).status).toBe(403); expect((await enqueue(first, { 'idempotency-key': crypto.randomUUID() })).status).toBe(400);
    expect((await enqueue({ ...first, format: 'xlsx' })).status).toBe(400); expect((await enqueue({ ...first, access: { mode: 'application' } })).status).toBe(400);
    await h.cloud`UPDATE account_sessions SET fresh_until = now() - interval '1 second' WHERE id = ${h.session}`; expect((await enqueue(first)).status).toBe(403);
    await h.cloud`UPDATE account_sessions SET fresh_until = now() + interval '10 minutes' WHERE id = ${h.session}`;
    expect(await h.cloud`SELECT id FROM data_export_jobs`).toHaveLength(0);
    const both = await Promise.all([enqueue(first), enqueue(first)]); expect(both.map(response => response.status)).toEqual([202, 202]);
    const job = parseComponent('DataExportReceipt', await both[0]!.json()).job; expect(parseComponent('DataExportReceipt', await both[1]!.json()).job.id).toBe(job.id);
    expect(job).toMatchObject({ scope, tableId, format: 'jsonl', state: 'queued', rows: 0, bytes: 0, errorCode: null, createdBy: h.account, completedAt: null, expiresAt: null });
    expect((await enqueue({ ...first, format: 'csv' })).status).toBe(409); expect(await h.cloud`SELECT id FROM data_export_jobs`).toHaveLength(1);
    // Nothing can be downloaded before the export is ready.
    expect((await h.api(`${exportsPath}/${job.id}/download`, {})).status).toBe(409);

    // A large export takes several claims. The first reads its 20 pages and hands the job back.
    expect(await h.exportWorker().execute()).toBe(true);
    expect(await row(job.id)).toMatchObject({ state: 'running', attempt: 1, part_count: 20, row_count: 10000, lease_id: null });
    // Storage goes down: the part that could not be stored is not counted, and the job waits rather than failing.
    h.failExportWrites(1); expect(await h.exportWorker().execute()).toBe(true);
    expect(await row(job.id)).toMatchObject({ state: 'running', attempt: 2, part_count: 20, row_count: 10000, lease_id: null });
    expect(await h.exportWorker().execute()).toBe(false); await due(job.id);
    // The worker dies after storing a part but before recording it. Its lease runs out; nothing else is lost.
    const written = h.exportWrites.length;
    // The real repository with some steps replaced. Everything else runs unchanged against the real database.
    const replacing = (overrides: Partial<ExportJobs>): ExportJobs => new Proxy(h.restartExports(), { get: (target, key) => {
      const replaced = (overrides as Record<string | symbol, unknown>)[key]; if (replaced) return replaced;
      const value = (target as unknown as Record<string | symbol, unknown>)[key]; return typeof value === 'function' ? value.bind(target) : value; } });
    const dying = replacing({ checkpoint: async () => { throw new Error('process killed'); }, release: async () => { throw new Error('process killed'); } });
    expect(String(await h.exportWorker(dying).execute().then(() => 'finished', error => error))).toContain('process killed');
    expect(h.exportWrites.length).toBe(written + 1); const orphan = h.exportWrites.at(-1)!;
    const stuck = await row(job.id); expect(stuck).toMatchObject({ state: 'running', attempt: 3, part_count: 20, row_count: 10000 }); expect(stuck.lease_id).not.toBeNull();
    // While that lease is live nobody else can take the job.
    expect(await h.exportWorker().execute()).toBe(false);
    await h.cloud`UPDATE data_export_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = ${job.id}`;
    // A new worker resumes from the checkpoint and writes the same part to the same key.
    expect(await h.exportWorker().execute()).toBe(true);
    expect(h.exportWrites.filter(key => key === orphan)).toHaveLength(2);
    const ready = await status(job.id); expect(ready).toMatchObject({ state: 'ready', rows: OWNED, errorCode: null }); expect(ready.expiresAt).not.toBeNull();
    expect(await row(job.id)).toMatchObject({ attempt: 4, part_count: 21, row_count: OWNED, lease_id: null });
    expect(parseComponent('DataExportList', await (await h.api(`${exportsPath}/list`, {})).json()).items.map(item => item.id)).toEqual([job.id]);

    // Download: one address, one use, exactly the rows the creator may see, each once.
    const address = await link(job.id); expect(address.url).toMatch(/^https:\/\/cloud\.example\.test\/platform\/v1\/exports\/download\/ex_[A-Za-z0-9_-]{43}$/);
    expect(new Date(address.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(60_000);
    expect((await h.download(address.url, 'POST')).status).toBe(405); expect((await h.download(address.url + '?x=1')).status).toBe(404);
    const response = await h.download(address.url); expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/x-ndjson'); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-disposition')).toBe(`attachment; filename="export-${job.id}.jsonl"`);
    const text = await response.text(); expect(Buffer.byteLength(text)).toBe(ready.bytes); expect(response.headers.get('content-length')).toBe(String(ready.bytes));
    const lines = text.trimEnd().split('\n').map(line => JSON.parse(line) as { id: string; values: Record<string, unknown> });
    expect(lines).toHaveLength(OWNED); expect(new Set(lines.map(line => line.id)).size).toBe(OWNED);
    expect(lines.every(line => line.values.owner === h.account)).toBe(true); expect(text).not.toContain('not yours');
    // Rows come out in ID order, and values are exactly what the data API returns.
    expect(lines.map(line => line.id)).toEqual([...lines.map(line => line.id)].sort());
    expect(lines.find(line => line.values.body === '=SUM(A1:A9)')!.values).toEqual({ owner: h.account, body: '=SUM(A1:A9)', amount: '9007199254740993.123456789', tags: ['a,b', 'c"d'] });
    expect(new Set(lines.map(line => line.values.body)).size).toBe(OWNED);
    expect((await h.download(address.url)).status).toBe(404);
    const unused = await link(job.id); await h.cloud`UPDATE data_export_downloads SET expires_at = now() - interval '1 second' WHERE used_at IS NULL`; expect((await h.download(unused.url)).status).toBe(404);
    expect((await h.download(`https://cloud.example.test/platform/v1/exports/download/ex_${'A'.repeat(43)}`)).status).toBe(404);
    expect(JSON.stringify(await h.cloud`SELECT * FROM data_export_downloads`)).not.toContain(address.url.split('/').at(-1)!);

    // CSV with a projection and a filter: a header, exact numbers, quoted awkward text, and no cell a spreadsheet would run.
    const csv = await queued(command({ format: 'csv', selection: { columns: ['body', 'amount', 'tags'], filters: [{ column: 'amount', operator: 'lt', value: '0.04' }] } })); await drain();
    expect(await status(csv.id)).toMatchObject({ state: 'ready', rows: 5 });
    const sheet = (await (await h.download((await link(csv.id)).url)).text()).split('\r\n'); expect(sheet[0]).toBe('_id,body,amount,tags'); expect(sheet.at(-1)).toBe('');
    const cells = sheet.slice(1, -1).map(line => line.slice(37)).sort();
    expect(cells).toEqual(['" padded ",0,[]', '"two\nlines, ""quoted""",-0.50,', 'row 1,0.01000000000000000000,', 'row 2,0.02000000000000000000,', 'row 3,0.03000000000000000000,'].sort());
    const guarded = await queued(command({ format: 'csv', selection: { columns: ['body', 'tags'], filters: [{ column: 'body', operator: 'eq', value: '=SUM(A1:A9)' }] } })); await drain();
    expect((await (await h.download((await link(guarded.id)).url)).text()).split('\r\n')[1]!.slice(37)).toBe(`'=SUM(A1:A9),"[""a,b"",""c\\""d""]"`);
    // An export that matches nothing is still a valid file.
    const empty = await queued(command({ format: 'csv', selection: { filters: [{ column: 'body', operator: 'eq', value: 'no such row' }] } })); await drain();
    expect(await status(empty.id)).toMatchObject({ state: 'ready', rows: 0 }); expect(await (await h.download((await link(empty.id)).url)).text()).toBe('_id,owner,body,amount,tags\r\n');
    const nothing = await queued(command({ access: { mode: 'policy-preview' } })); await drain();
    expect(await status(nothing.id)).toMatchObject({ state: 'ready', rows: 0, bytes: 0 }); expect(await (await h.download((await link(nothing.id)).url)).text()).toBe('');

    // Cancellation. Before any worker has it, it ends at once.
    const idle = await queued(command()); const cancel = (id: string, revision: string, commandId = crypto.randomUUID()) => h.api(`${exportsPath}/${id}/cancel`, { commandId, revision }, revision, { 'idempotency-key': commandId });
    expect((await cancel(idle.id, '9')).status).toBe(409);
    const cancelId = crypto.randomUUID(); const cancelled = await cancel(idle.id, idle.revision, cancelId); expect(cancelled.status).toBe(202);
    const receipt = parseComponent('DataExportReceipt', await cancelled.json()); expect(receipt.job).toMatchObject({ state: 'cancelled', errorCode: 'cancelled' });
    expect(parseComponent('DataExportReceipt', await (await cancel(idle.id, idle.revision, cancelId)).json())).toEqual(receipt);
    expect((await cancel(idle.id, receipt.job.revision)).status).toBe(409); expect(await h.exportWorker().execute()).toBe(false);
    // While a worker holds it, the worker is told at its next checkpoint and stops; what it stored is removed.
    const busy = await queued(command()); let asked = false;
    const interrupted = replacing({ checkpoint: async (lease, part) => {
      if (part.number === 3 && !asked) { asked = true; const current = await status(busy.id); expect(parseComponent('DataExportReceipt', await (await cancel(busy.id, current.revision)).json()).job.state).toBe('running'); }
      return h.exportJobs.checkpoint(lease, part); } });
    expect(await h.exportWorker(interrupted).execute()).toBe(true);
    expect(await row(busy.id)).toMatchObject({ state: 'cancelled', part_count: 2, error_code: 'cancelled', lease_id: null });
    expect((await h.api(`${exportsPath}/${busy.id}/download`, {})).status).toBe(409);
    const stored = () => [...h.exportObjects.keys()].filter(key => key.includes(busy.id));
    expect(stored()).toHaveLength(3); expect(await h.exportWorker().sweep()).toBe(2);
    // The part that was stored but never recorded is the one thing a sweep cannot find.
    expect(stored()).toEqual([expect.stringMatching(/000003$/)]); expect(await h.cloud`SELECT 1 FROM data_export_parts WHERE job_id = ${busy.id}`).toHaveLength(0);

    // A schema change part-way through ends the export instead of mixing two shapes of row.
    const reshaped = await queued(command()); expect(await h.exportWorker().execute()).toBe(true); expect(await row(reshaped.id)).toMatchObject({ state: 'running', part_count: 20 });
    const alter = { kind: 'table.alter', commandId: crypto.randomUUID(), tableId, revision: '1', change: { kind: 'column.add', column: { name: 'note', type: 'text', nullable: true } } };
    expect((await h.api(dataPath, alter, '1', { 'idempotency-key': alter.commandId })).status).toBe(200);
    expect(await h.exportWorker().execute()).toBe(true); expect(await status(reshaped.id)).toMatchObject({ state: 'failed', errorCode: 'schema_changed', expiresAt: null });
    expect((await h.api(`${exportsPath}/${reshaped.id}/download`, {})).status).toBe(409);

    // Authority is live. A job whose creator can no longer read the data stops at its next claim, and an issued address stops working.
    const revoked = await queued(command()); expect(await h.exportWorker().execute()).toBe(true); const pending = await link(job.id);
    await h.cloud`UPDATE account_sessions SET expires_at = now() - interval '1 second' WHERE id = ${h.session}`;
    // Cloud itself ends the job at the claim: Database is never asked.
    let contacted = 0; h.interceptAuthority(async () => { contacted++; });
    expect(await h.exportWorker().execute()).toBe(true); h.interceptAuthority(); expect(contacted).toBe(0); expect(await row(revoked.id)).toMatchObject({ state: 'failed', error_code: 'access_revoked' });
    expect((await h.download(pending.url)).status).toBe(404);
    await h.cloud`UPDATE account_sessions SET expires_at = now() + interval '8 hours' WHERE id = ${h.session}`;
    // The refused attempt spent the address.
    expect((await h.download(pending.url)).status).toBe(404);
    // Database also refuses a job's requests once Cloud says the principal is no longer current.
    const refused = await queued(command()); h.interceptAuthority(async () => { await h.cloud`UPDATE accounts SET permission_revision = permission_revision + 1 WHERE id = ${h.account}`; });
    expect(await h.exportWorker().execute()).toBe(true); h.interceptAuthority(); expect(await row(refused.id)).toMatchObject({ state: 'failed', error_code: 'access_revoked', part_count: 0 });

    // Other members. One who may see metadata but not data can do nothing with exports; one with full access can follow
    // someone else's export but cannot take its data, because it was read under the creator's access.
    const member = async (role: string, email: string) => {
      const id = crypto.randomUUID(); const memberToken = opaqueToken('as'); const memberCsrf = opaqueToken('csrf');
      await h.cloud`INSERT INTO accounts (id, primary_email, name, verified_at, terms_version) VALUES (${id}, ${email}, ${role}, now(), 'fixture')`;
      await h.cloud`INSERT INTO account_sessions (id, account_id, token_hash, csrf_hash, security_revision, device_name, expires_at, fresh_until)
        VALUES (${crypto.randomUUID()}, ${id}, ${tokenDigest(memberToken)}, ${tokenDigest(memberCsrf)}, 1, 'Fixture', now() + interval '8 hours', now() + interval '10 minutes')`;
      await h.cloud`INSERT INTO memberships (id, account_id, org_id, role, state, project_access) VALUES (${crypto.randomUUID()}, ${id}, ${scope.orgId}, ${role}, 'active', 'all')`;
      return { cookie: `__Host-carbon-session=${memberToken}`, 'x-csrf-token': memberCsrf };
    };
    const viewer = await member('Viewer', 'viewer@example.test'); const colleague = await member('Owner', 'colleague@example.test'); const attempt = command();
    for (const [path, body] of [[exportsPath, attempt], [`${exportsPath}/list`, {}], [`${exportsPath}/${csv.id}/status`, {}], [`${exportsPath}/${csv.id}/download`, {}], [`${exportsPath}/${csv.id}/cancel`, { commandId: attempt.commandId, revision: '1' }]] as const)
      expect((await h.api(path, body, path.endsWith('/cancel') ? '1' : undefined, { ...viewer, 'idempotency-key': attempt.commandId })).status).toBe(403);
    expect((await h.api(`${exportsPath}/${csv.id}/status`, {}, undefined, colleague)).status).toBe(200);
    expect((await h.api(`${exportsPath}/${csv.id}/download`, {}, undefined, colleague)).status).toBe(403);
    expect(await h.cloud`SELECT 1 FROM data_export_jobs WHERE command_id = ${attempt.commandId}`).toHaveLength(0);

    // At most five exports in progress per environment.
    const open: string[] = []; for (let index = 0; index < 5; index++) open.push((await queued(command())).id);
    expect((await enqueue(command())).status).toBe(429);
    for (const id of open) expect((await cancel(id, '1')).status).toBe(202);

    // Expiry: the export stops being downloadable and its objects are deleted.
    await h.cloud`UPDATE data_export_jobs SET expires_at = now() - interval '1 second' WHERE id = ${job.id}`;
    const late = await h.api(`${exportsPath}/${job.id}/download`, {}); expect(late.status).toBe(409);
    expect([...h.exportObjects.keys()].filter(key => key.includes(job.id))).toHaveLength(21);
    expect(await h.exportWorker().sweep(1000)).toBeGreaterThanOrEqual(21);
    expect(await status(job.id)).toMatchObject({ state: 'expired', rows: OWNED }); expect([...h.exportObjects.keys()].filter(key => key.includes(job.id))).toEqual([]);
    expect(await h.cloud`SELECT 1 FROM data_export_parts p JOIN data_export_jobs j ON j.id = p.job_id WHERE j.state <> 'ready'`).toHaveLength(0);

    // The audit trail of the first export, and no token or row content in anything durable.
    const actions = (await h.cloud`SELECT action, actor_kind FROM platform_events WHERE resource_kind = 'data_export' AND resource_id = ${job.id} ORDER BY transaction_id, sequence`).map((event: { action: string; actor_kind: string }) => `${event.action}:${event.actor_kind}`);
    expect(actions).toEqual(['export.queued:account', 'export.started:system', 'export.ready:system', 'export.download_issued:account', 'export.downloaded:account', 'export.download_issued:account', 'export.download_issued:account',
      'export.download_refused:account', 'export.expired:system']);
    const durable = JSON.stringify({ jobs: await h.cloud`SELECT request, error_code, state FROM data_export_jobs`, events: await h.cloud`SELECT * FROM data_export_events` });
    expect(durable).not.toContain('row 1'); expect(durable).not.toContain('ex_');
  }, 240000);

  test('blob storage keeps exact bytes behind single-use transfers: two environments stay apart, broken and abandoned uploads leave nothing, quota and retention hold, and cleanup removes what is left', async () => {
    const h = await harness(); const first = await h.create('blob-a', ['database']); expect(await h.worker.execute()).toBe(true);
    const second = await h.create('blob-b', ['database']); expect(await h.worker.execute()).toBe(true);
    const A = parseComponent('EnvironmentScope', first.scope); const B = parseComponent('EnvironmentScope', second.scope);
    const path = (scope: typeof A) => `/platform/v1/orgs/${scope.orgId}/projects/${scope.projectId}/environments/${scope.environmentId}/blobs`;
    const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
    // One command to Cloud's account API. Commands that change something carry their own ID as the idempotency key.
    const send = (scope: typeof A, command: Record<string, unknown>, overrides: Record<string, string> = {}) => h.api(path(scope), command, command.revision as string | undefined,
      { ...(command.commandId ? { 'idempotency-key': command.commandId as string } : {}), ...overrides });
    const ok = async <T extends Parameters<typeof parseComponent>[0]>(component: T, scope: typeof A, command: Record<string, unknown>) => {
      const response = await send(scope, command); if (response.status !== 200) throw new Error(`${command.kind} answered ${response.status}`);
      return parseComponent(component, (await response.json() as { result: unknown }).result);
    };
    const status = async (scope: typeof A, command: Record<string, unknown>, overrides?: Record<string, string>) => (await send(scope, command, overrides)).status;
    const id = () => crypto.randomUUID();
    const definition = (overrides: Record<string, unknown> = {}) => ({ name: 'files', visibility: 'private', maxObjectBytes: 2000, allowedContentTypes: ['text/plain', 'image/png'], versioning: true, retentionDays: 7, quotaBytes: 3000, ...overrides });
    const bucket = id();
    const ticket = (scope: typeof A, bucketId: string, key: string, bytes: Uint8Array, contentType = 'text/plain', overrides: Record<string, unknown> = {}) =>
      ({ kind: 'object.upload', commandId: id(), bucketId, key, sizeBytes: bytes.byteLength, sha256: digest(bytes), contentType, ...overrides });
    // The bytes themselves go straight to the storage service over real HTTP, with nothing but the address.
    const put = (url: string, bytes: Uint8Array, contentType = 'text/plain') => fetch(url, { method: 'PUT', body: bytes, headers: { 'content-type': contentType } });
    const upload = async (scope: typeof A, bucketId: string, key: string, bytes: Uint8Array, contentType = 'text/plain') => {
      const transfer = await ok('BlobTransfer', scope, ticket(scope, bucketId, key, bytes, contentType)); expect((await put(transfer.url, bytes, contentType)).status).toBe(204); return transfer;
    };
    const download = async (scope: typeof A, bucketId: string, key: string, versionId?: string) => fetch((await ok('BlobTransfer', scope, { kind: 'object.download', bucketId, key, ...(versionId ? { versionId } : {}) })).url);
    const info = async (scope: typeof A, bucketId: string) => { const found = await ok('BlobBucket', scope, { kind: 'bucket.get', bucketId }); return { used: found.usedBytes, objects: found.objectCount, revision: found.revision }; };
    const keys = async (scope: typeof A, bucketId: string, extra: Record<string, unknown> = {}) => (await ok('BlobObjectList', scope, { kind: 'objects.list', bucketId, ...extra })).objects.map(object => object.key);
    const text = (value: string) => new TextEncoder().encode(value);
    const stored = (bucketId: string) => [...h.blobObjects.keys()].filter(key => key.includes(bucketId));

    // Buckets.
    expect(await status(A, { kind: 'bucket.create', commandId: id(), bucketId: bucket, definition: definition({ name: 'Files' }) })).toBe(400);
    expect(await status(A, { kind: 'bucket.create', commandId: id(), bucketId: bucket, definition: definition({ maxObjectBytes: 0 }) })).toBe(400);
    const creating = { kind: 'bucket.create', commandId: id(), bucketId: bucket, definition: definition() };
    expect(await status(A, creating, { cookie: '' })).toBe(401); expect(await status(A, creating, { 'x-csrf-token': 'bad' })).toBe(403); expect(await status(A, creating, { 'idempotency-key': id() })).toBe(400);
    const created = await ok('BlobReceipt', A, creating); expect(created).toEqual({ commandId: creating.commandId, bucketId: bucket, revision: '1' });
    expect(await ok('BlobReceipt', A, creating)).toEqual(created); expect(await status(A, { ...creating, definition: definition({ quotaBytes: 9 }) })).toBe(409);
    expect(await status(A, { kind: 'bucket.create', commandId: id(), bucketId: id(), definition: definition() })).toBe(409);
    expect((await ok('BlobBucketList', A, { kind: 'buckets.list' })).buckets.map(item => [item.id, item.definition.name, item.usedBytes, item.objectCount])).toEqual([[bucket, 'files', 0, 0]]);

    // An upload is authorized for one exact object: this key, this size, this digest, this type.
    const hello = text('hello, exact bytes');
    for (const refused of [ticket(A, bucket, '../escape', hello), ticket(A, bucket, '/leading', hello), ticket(A, bucket, 'a//b', hello), ticket(A, bucket, 'a/./b', hello), ticket(A, bucket, 'ok', hello, 'text/html'),
      ticket(A, bucket, 'ok', hello, 'text/plain', { sizeBytes: 2001 }), ticket(A, bucket, 'ok', hello, 'text/plain', { sha256: 'nope' })]) expect(await status(A, refused)).toBe(400);
    expect(await h.database`SELECT 1 FROM blob_transfers`).toHaveLength(0);
    const request = ticket(A, bucket, 'docs/hello.txt', hello); const transfer = await ok('BlobTransfer', A, request);
    expect(transfer).toMatchObject({ method: 'PUT', headers: { 'content-type': 'text/plain', 'content-length': String(hello.byteLength) } });
    expect(transfer.url.startsWith(`${h.databaseServer.url.origin}/storage/v1/transfers/bt_`)).toBe(true); expect(new Date(transfer.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(300_000);
    // An address is not replayable through the command either: it was returned once.
    expect(await status(A, request)).toBe(409);
    expect((await fetch(transfer.url, { method: 'POST', body: hello })).status).toBe(405); expect((await fetch(transfer.url)).status).toBe(404);
    expect((await put(transfer.url, hello)).status).toBe(204);
    // One use. The same address accepts nothing more and serves nothing.
    expect((await put(transfer.url, hello)).status).toBe(404); expect((await fetch(transfer.url)).status).toBe(404);
    expect(await keys(A, bucket)).toEqual(['docs/hello.txt']); expect(await info(A, bucket)).toMatchObject({ used: hello.byteLength, objects: 1 });
    // Every byte value survives: nothing is transcoded on the way in or out.
    const binary = new Uint8Array(700); for (let index = 0; index < binary.length; index++) binary[index] = index % 256;
    await upload(A, bucket, 'images/all bytes.png'.replace(' ', '-'), binary, 'image/png');
    const fetched = await download(A, bucket, 'images/all-bytes.png'); expect(fetched.status).toBe(200);
    expect(Buffer.from(await fetched.arrayBuffer()).equals(Buffer.from(binary))).toBe(true);
    expect(Object.fromEntries(['content-type', 'content-length', 'content-disposition', 'cache-control', 'etag', 'x-content-type-options', 'content-security-policy'].map(name => [name, fetched.headers.get(name)]))).toEqual({
      'content-type': 'image/png', 'content-length': '700', 'content-disposition': 'attachment; filename="all-bytes.png"', 'cache-control': 'no-store', etag: `"${digest(binary)}"`, 'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox" });
    const once = await ok('BlobTransfer', A, { kind: 'object.download', bucketId: bucket, key: 'docs/hello.txt' });
    expect(await (await fetch(once.url)).text()).toBe('hello, exact bytes'); expect((await fetch(once.url)).status).toBe(404); expect((await put(once.url, hello)).status).toBe(404);
    expect(await status(A, { kind: 'object.download', bucketId: bucket, key: 'docs/missing.txt' })).toBe(404);
    expect(await keys(A, bucket, { prefix: 'docs/' })).toEqual(['docs/hello.txt']); expect(await keys(A, bucket, { limit: 1 })).toEqual(['docs/hello.txt']);
    expect((await ok('BlobObjectList', A, { kind: 'objects.list', bucketId: bucket, limit: 1 })).nextAfterKey).toBe('docs/hello.txt'); expect(await keys(A, bucket, { afterKey: 'docs/hello.txt' })).toEqual(['images/all-bytes.png']);

    // Broken transfers. Whatever arrives that is not exactly what was authorized is refused, stores nothing, and spends the address.
    const before = stored(bucket).length; const used = (await info(A, bucket)).used; const note = text('a note of thirty-two bytes long.');
    const broken = async (send: (url: string) => Promise<Response>, expected: number) => {
      const issued = await ok('BlobTransfer', A, ticket(A, bucket, 'docs/note.txt', note)); expect((await send(issued.url)).status).toBe(expected); expect((await put(issued.url, note)).status).toBe(404);
    };
    await broken(url => put(url, text('a note of thirty-two bytes LONG.')), 400);
    await broken(url => put(url, note.slice(0, 10)), 400);
    await broken(url => put(url, new Uint8Array([...note, ...note])), 400);
    await broken(url => put(url, note, 'image/png'), 400);
    await broken(url => fetch(url, { method: 'PUT', headers: { 'content-type': 'text/plain' } }), 400);
    // Storage is down: the upload fails cleanly and can be asked for again.
    h.failBlobWrites(1); await broken(url => put(url, note), 503);
    expect(stored(bucket)).toHaveLength(before); expect(await info(A, bucket)).toMatchObject({ used, objects: 2 }); expect(await keys(A, bucket)).toEqual(['docs/hello.txt', 'images/all-bytes.png']);
    expect((await h.database`SELECT state FROM blob_transfers WHERE kind = 'upload' AND key = 'docs/note.txt'`).map((row: { state: string }) => row.state)).toEqual(Array(6).fill('failed'));

    // Expiry: an address that was never used stops working, and cleanup closes it.
    const lapsed = await ok('BlobTransfer', A, ticket(A, bucket, 'docs/note.txt', note));
    await h.database`UPDATE blob_transfers SET expires_at = now() - interval '1 second' WHERE state = 'issued'`;
    expect((await put(lapsed.url, note)).status).toBe(404); expect(await h.sweepBlobs()).toEqual({ expired: 1, interrupted: 0, purged: 0 });
    const late = await ok('BlobTransfer', A, { kind: 'object.download', bucketId: bucket, key: 'docs/hello.txt' });
    await h.database`UPDATE blob_transfers SET expires_at = now() - interval '1 second' WHERE state = 'issued'`; expect((await fetch(late.url)).status).toBe(404);

    // Interrupted: the service died after the bytes reached storage and before the object was recorded. Cleanup removes them.
    const abandoned = await ok('BlobTransfer', A, ticket(A, bucket, 'docs/abandoned.txt', note));
    const orphan = (await h.database`SELECT storage_key FROM blob_transfers WHERE key = 'docs/abandoned.txt'`)[0].storage_key as string;
    await h.database`UPDATE blob_transfers SET state = 'receiving', used_at = now() - interval '20 minutes' WHERE key = 'docs/abandoned.txt'`; h.blobObjects.set(orphan, note);
    // While it looks in progress it still holds its share of the quota, and it is too recent to give up on until it is not.
    expect((await put(abandoned.url, note)).status).toBe(404); expect(stored(bucket)).toHaveLength(before + 1);
    expect(await h.sweepBlobs()).toEqual({ expired: 1, interrupted: 1, purged: 0 });
    expect(h.blobObjects.has(orphan)).toBe(false); expect(stored(bucket)).toHaveLength(before); expect(await keys(A, bucket)).toEqual(['docs/hello.txt', 'images/all-bytes.png']);
    expect(await h.sweepBlobs()).toEqual({ expired: 0, interrupted: 0, purged: 0 });

    // Quota counts what is stored and what may still arrive. 718 bytes are stored of 3000.
    const big = new Uint8Array(1000).fill(65);
    const held = await ok('BlobTransfer', A, ticket(A, bucket, 'q/one', big));
    const racing = await Promise.all([send(A, ticket(A, bucket, 'q/two', big)), send(A, ticket(A, bucket, 'q/three', big))]);
    expect(racing.map(response => response.status).sort()).toEqual([200, 429]);
    expect(await status(A, ticket(A, bucket, 'q/four', new Uint8Array(283).fill(66)))).toBe(429); expect(await status(A, ticket(A, bucket, 'q/four', new Uint8Array(282).fill(66)))).toBe(200);
    // Reservations that lapse give the room back.
    await h.database`UPDATE blob_transfers SET expires_at = now() - interval '1 second' WHERE state = 'issued' AND key <> 'q/one'`; expect((await h.sweepBlobs()).expired).toBe(2);
    expect((await put(held.url, big)).status).toBe(204); expect(await info(A, bucket)).toMatchObject({ used: 1718, objects: 3 });
    expect(await status(A, ticket(A, bucket, 'q/five', new Uint8Array(1283).fill(67)))).toBe(429);

    // Versions: replacing keeps the old bytes restorable for the bucket's retention.
    const original = (await ok('BlobObjectList', A, { kind: 'object.versions', bucketId: bucket, key: 'docs/hello.txt' })).objects[0]!;
    const revised = text('hello, revised'); await upload(A, bucket, 'docs/hello.txt', revised);
    const versions = (await ok('BlobObjectList', A, { kind: 'object.versions', bucketId: bucket, key: 'docs/hello.txt' })).objects;
    expect(versions.map(version => [version.state, version.sizeBytes])).toEqual([['current', revised.byteLength], ['replaced', hello.byteLength]]); expect(versions[1]!.versionId).toBe(original.versionId);
    expect(Math.round((new Date(versions[1]!.purgeAfter!).getTime() - Date.now()) / 86_400_000)).toBe(7); expect(await info(A, bucket)).toMatchObject({ used: 1718 + revised.byteLength, objects: 3 });
    expect(await (await download(A, bucket, 'docs/hello.txt')).text()).toBe('hello, revised'); expect(await (await download(A, bucket, 'docs/hello.txt', original.versionId)).text()).toBe('hello, exact bytes');
    // Deleting hides the object; restoring a version brings exactly that version back.
    const removal = { kind: 'object.delete', commandId: id(), bucketId: bucket, key: 'docs/hello.txt' }; const removed = await ok('BlobReceipt', A, removal); expect(await ok('BlobReceipt', A, removal)).toEqual(removed);
    expect(await keys(A, bucket, { prefix: 'docs/' })).toEqual([]); expect(await status(A, { kind: 'object.download', bucketId: bucket, key: 'docs/hello.txt' })).toBe(404); expect((await info(A, bucket)).objects).toBe(2);
    expect(await status(A, { kind: 'object.delete', commandId: id(), bucketId: bucket, key: 'docs/hello.txt' })).toBe(404);
    await ok('BlobReceipt', A, { kind: 'object.restore', commandId: id(), bucketId: bucket, key: 'docs/hello.txt', versionId: original.versionId });
    expect(await (await download(A, bucket, 'docs/hello.txt')).text()).toBe('hello, exact bytes'); expect((await info(A, bucket)).objects).toBe(3);
    expect(await status(A, { kind: 'object.restore', commandId: id(), bucketId: bucket, key: 'docs/hello.txt', versionId: original.versionId })).toBe(409);
    // Naming a version deletes it for good. Its bytes go at the next cleanup, and so does its share of the quota.
    await ok('BlobReceipt', A, { kind: 'object.delete', commandId: id(), bucketId: bucket, key: 'docs/hello.txt', versionId: removed.versionId });
    const count = stored(bucket).length; expect(await h.sweepBlobs()).toEqual({ expired: 0, interrupted: 0, purged: 1 });
    expect(stored(bucket)).toHaveLength(count - 1); expect(await info(A, bucket)).toMatchObject({ used: 1718, objects: 3 });
    expect(await status(A, { kind: 'object.restore', commandId: id(), bucketId: bucket, key: 'docs/hello.txt', versionId: removed.versionId })).toBe(404);
    // Retention: a replaced version past its time is removed, and can no longer be restored or downloaded.
    await upload(A, bucket, 'docs/hello.txt', revised);
    // Inside its retention a replaced version survives cleanup and can still be read.
    expect((await h.sweepBlobs()).purged).toBe(0); expect(await (await download(A, bucket, 'docs/hello.txt', original.versionId)).text()).toBe('hello, exact bytes');
    await h.database`UPDATE blob_objects SET purge_after = now() - interval '1 second' WHERE id = ${original.versionId}`;
    expect((await h.sweepBlobs()).purged).toBe(1); expect(await status(A, { kind: 'object.download', bucketId: bucket, key: 'docs/hello.txt', versionId: original.versionId })).toBe(404);
    expect(await status(A, { kind: 'object.restore', commandId: id(), bucketId: bucket, key: 'docs/hello.txt', versionId: original.versionId })).toBe(404);
    expect(await (await download(A, bucket, 'docs/hello.txt')).text()).toBe('hello, revised');

    // Two environments. B cannot see, read, write, restore or delete anything of A's, by ID or by name, and may reuse the names.
    const other = id(); await ok('BlobReceipt', B, { kind: 'bucket.create', commandId: id(), bucketId: other, definition: definition() });
    await upload(B, other, 'docs/hello.txt', text('from the other environment'));
    for (const command of [{ kind: 'bucket.get', bucketId: bucket }, { kind: 'objects.list', bucketId: bucket }, { kind: 'object.versions', bucketId: bucket, key: 'docs/hello.txt' }, { kind: 'object.download', bucketId: bucket, key: 'docs/hello.txt' },
      ticket(B, bucket, 'docs/intruder.txt', note), { kind: 'object.delete', commandId: id(), bucketId: bucket, key: 'docs/hello.txt' }, { kind: 'object.restore', commandId: id(), bucketId: bucket, key: 'docs/hello.txt', versionId: removed.versionId },
      { kind: 'bucket.update', commandId: id(), bucketId: bucket, revision: '1', definition: definition({ visibility: 'public' }) }, { kind: 'bucket.delete', commandId: id(), bucketId: bucket, revision: '1', confirmation: 'files' }]) expect(await status(B, command)).toBe(404);
    expect((await ok('BlobBucketList', B, { kind: 'buckets.list' })).buckets.map(item => item.id)).toEqual([other]);
    expect(await (await download(A, bucket, 'docs/hello.txt')).text()).toBe('hello, revised'); expect(await (await download(B, other, 'docs/hello.txt')).text()).toBe('from the other environment');
    expect(stored(bucket).every(key => key.includes(A.environmentId)) && stored(other).every(key => key.includes(B.environmentId))).toBe(true);

    // Public download follows the bucket as it is now, not as it was.
    const open = (scope: typeof A, name: string, key: string) => fetch(`${h.databaseServer.url.origin}/storage/v1/public/${scope.environmentId}/${name}/${key}`);
    expect((await open(A, 'files', 'docs/hello.txt')).status).toBe(404);
    const current = await info(A, bucket); expect(await status(A, { kind: 'bucket.update', commandId: id(), bucketId: bucket, revision: '99', definition: definition({ visibility: 'public' }) })).toBe(409);
    const published = await ok('BlobReceipt', A, { kind: 'bucket.update', commandId: id(), bucketId: bucket, revision: current.revision, definition: definition({ visibility: 'public' }) });
    const served = await open(A, 'files', 'docs/hello.txt'); expect(served.status).toBe(200); expect(await served.text()).toBe('hello, revised'); expect(served.headers.get('cache-control')).toBe('public, max-age=60');
    // The other environment's bucket has the same name and the same key and is still private; a deleted object is not served either.
    // A deleted object stops being served, even though its bytes are kept for the retention period.
    await upload(A, bucket, 'docs/gone.txt', note); expect((await open(A, 'files', 'docs/gone.txt')).status).toBe(200);
    await ok('BlobReceipt', A, { kind: 'object.delete', commandId: id(), bucketId: bucket, key: 'docs/gone.txt' }); expect((await open(A, 'files', 'docs/gone.txt')).status).toBe(404);
    expect((await open(B, 'files', 'docs/hello.txt')).status).toBe(404); expect((await open(A, 'files', 'docs/missing.txt')).status).toBe(404); expect((await open(A, 'files', '..%2Fescape')).status).toBe(404);
    expect((await fetch(`${h.databaseServer.url.origin}/storage/v1/public/${A.environmentId}/files/docs/hello.txt`, { method: 'POST' })).status).toBe(405);
    await h.database`UPDATE platform_environments SET state = 'paused' WHERE environment_id = ${A.environmentId}`; expect((await open(A, 'files', 'docs/hello.txt')).status).toBe(404);
    await h.database`UPDATE platform_environments SET state = 'active' WHERE environment_id = ${A.environmentId}`; expect((await open(A, 'files', 'docs/hello.txt')).status).toBe(200);
    await ok('BlobReceipt', A, { kind: 'bucket.update', commandId: id(), bucketId: bucket, revision: published.revision!, definition: definition() }); expect((await open(A, 'files', 'docs/hello.txt')).status).toBe(404);

    // Authority is live at the storage service too: a principal that stops being current mid-request changes nothing.
    const transfers = (await h.database`SELECT count(*)::integer AS count FROM blob_transfers`)[0].count;
    h.interceptAuthority(async () => { await h.cloud`UPDATE accounts SET permission_revision = permission_revision + 1 WHERE id = ${h.account}`; });
    expect([401, 403]).toContain(await status(A, ticket(A, bucket, 'docs/late.txt', note))); h.interceptAuthority();
    expect((await h.database`SELECT count(*)::integer AS count FROM blob_transfers`)[0].count).toBe(transfers);
    // A member who may see metadata but not data can list and nothing else; a stranger to the organization sees nothing.
    const member = async (email: string, role?: string) => {
      const accountId = id(); const memberToken = opaqueToken('as'); const memberCsrf = opaqueToken('csrf');
      await h.cloud`INSERT INTO accounts (id, primary_email, name, verified_at, terms_version) VALUES (${accountId}, ${email}, 'Member', now(), 'fixture')`;
      await h.cloud`INSERT INTO account_sessions (id, account_id, token_hash, csrf_hash, security_revision, device_name, expires_at, fresh_until)
        VALUES (${id()}, ${accountId}, ${tokenDigest(memberToken)}, ${tokenDigest(memberCsrf)}, 1, 'Fixture', now() + interval '8 hours', now() + interval '10 minutes')`;
      if (role) await h.cloud`INSERT INTO memberships (id, account_id, org_id, role, state, project_access) VALUES (${id()}, ${accountId}, ${A.orgId}, ${role}, 'active', 'all')`;
      return { cookie: `__Host-carbon-session=${memberToken}`, 'x-csrf-token': memberCsrf };
    };
    const viewer = await member('viewer@example.test', 'Viewer'); const stranger = await member('stranger@example.test');
    expect(await status(A, { kind: 'objects.list', bucketId: bucket }, viewer)).toBe(200);
    for (const command of [{ kind: 'object.download', bucketId: bucket, key: 'docs/hello.txt' }, ticket(A, bucket, 'docs/viewer.txt', note), { kind: 'object.delete', commandId: id(), bucketId: bucket, key: 'docs/hello.txt' },
      { kind: 'bucket.create', commandId: id(), bucketId: id(), definition: definition({ name: 'viewer' }) }]) expect(await status(A, command, viewer)).toBe(403);
    for (const command of [{ kind: 'buckets.list' }, { kind: 'objects.list', bucketId: bucket }, { kind: 'object.download', bucketId: bucket, key: 'docs/hello.txt' }, ticket(A, bucket, 'docs/stranger.txt', note)]) expect([403, 404]).toContain(await status(A, command, stranger));

    // Metering: each stored version, each completed download and each removal is counted exactly once.
    const usage = async (bucketId: string) => Object.fromEntries((await h.database`SELECT kind, count(*)::integer AS count, sum(bytes)::integer AS bytes FROM blob_usage WHERE bucket_id = ${bucketId} GROUP BY kind`).map((row: { kind: string; count: number; bytes: number }) => [row.kind, [row.count, row.bytes]]));
    const metered = await usage(bucket); expect(metered.stored).toEqual([6, hello.byteLength + 700 + 1000 + revised.byteLength * 2 + note.byteLength]); expect(metered.removed).toEqual([2, revised.byteLength + hello.byteLength]);
    // Eight downloads through addresses and three public ones.
    expect(metered.egress![0]).toBe(11); expect((await h.database`SELECT 1 FROM blob_usage GROUP BY kind, source_id HAVING count(*) > 1`).length).toBe(0);

    // Deleting a bucket: its name must be confirmed; then nothing in it is reachable, addresses stop, and cleanup removes every byte.
    const pending = await ok('BlobTransfer', A, ticket(A, bucket, 'docs/pending.txt', note)); const final = await info(A, bucket);
    expect(await status(A, { kind: 'bucket.delete', commandId: id(), bucketId: bucket, revision: final.revision, confirmation: 'wrong' })).toBe(400);
    // The bucket is deleted while an upload's bytes are arriving: the upload is refused and its bytes do not stay.
    const arriving = await ok('BlobTransfer', A, ticket(A, bucket, 'docs/arriving.txt', note)); const beforeDelete = stored(bucket).length;
    h.duringBlobWrite(async () => { await ok('BlobReceipt', A, { kind: 'bucket.delete', commandId: id(), bucketId: bucket, revision: final.revision, confirmation: 'files' }); });
    expect((await put(arriving.url, note)).status).toBe(409); expect(stored(bucket)).toHaveLength(beforeDelete);
    expect(await h.database`SELECT 1 FROM blob_objects WHERE key = 'docs/arriving.txt'`).toHaveLength(0);
    expect((await ok('BlobBucketList', A, { kind: 'buckets.list' })).buckets).toEqual([]); expect(await status(A, { kind: 'bucket.get', bucketId: bucket })).toBe(404);
    expect(await status(A, { kind: 'object.download', bucketId: bucket, key: 'docs/hello.txt' })).toBe(404); expect((await put(pending.url, note)).status).toBe(404);
    expect(stored(bucket).length).toBeGreaterThan(0); expect((await h.sweepBlobs()).purged).toBe(4); expect(stored(bucket)).toEqual([]);
    expect((await h.database`SELECT used_bytes::integer AS used, object_count::integer AS objects, state FROM blob_buckets WHERE id = ${bucket}`) as unknown[]).toEqual([{ used: 0, objects: 0, state: 'deleting' }]);
    // The name is free again, and the other environment was never touched.
    await ok('BlobReceipt', A, { kind: 'bucket.create', commandId: id(), bucketId: id(), definition: definition() });
    expect(await (await download(B, other, 'docs/hello.txt')).text()).toBe('from the other environment'); expect(stored(other)).toHaveLength(1);
    // Nothing durable holds an address.
    expect(JSON.stringify(await h.database`SELECT * FROM blob_transfers`)).not.toContain('bt_'); expect(JSON.stringify(await h.database`SELECT * FROM blob_events`)).not.toContain('bt_');
  }, 240000);

  test('the change stream delivers ordered notifications, resumes exactly after a reconnect, replays from a cursor, resets on schema change and closes when access ends', async () => {
    const h = await harness(); const created = await h.create('stream-api', ['database']); expect(await h.worker.execute()).toBe(true);
    const scope = parseComponent('EnvironmentScope', created.scope);
    const envPath = `/platform/v1/orgs/${scope.orgId}/projects/${scope.projectId}/environments/${scope.environmentId}`; const dataPath = envPath + '/data';
    const env = parseComponent('CatalogEnvironmentDetails', await (await h.api(envPath)).json()); const tableId = crypto.randomUUID(); const access = { mode: 'policy-preview', userId: h.account };
    const create = { kind: 'table.create', commandId: crypto.randomUUID(), tableId, definition: { name: 'feed', columns: [{ name: 'owner', type: 'uuid', nullable: false }, { name: 'body', type: 'text', nullable: false }],
      policies: { enabled: true, rules: [{ id: crypto.randomUUID(), name: 'Owner', kind: 'owner', ownerColumn: 'owner', operations: ['select', 'insert', 'update', 'delete'] }] } } };
    expect((await h.api(dataPath, create, env.environment.revision, { 'idempotency-key': create.commandId })).status).toBe(200);
    let revision = '1';
    const mutate = async (command: Record<string, unknown>) => { const response = await h.api(dataPath, command, command.revision as string, { 'idempotency-key': command.commandId as string }); expect(response.status).toBe(200); return (await response.json() as { receipt: { rowId: string; revision: string } }).receipt; };
    const insert = (body: string, owner = h.account) => mutate({ kind: 'row.insert', commandId: crypto.randomUUID(), tableId, revision, access, values: { owner, body } });
    // An EventSource as a browser would use it: frames in order, each with the id to resume from.
    const open = async (query = `tableId=${tableId}&userId=${h.account}`, headers: Record<string, string> = {}) => {
      const response = await h.api(`${dataPath}/changes?${query}`, undefined, undefined, headers);
      if (response.status !== 200) return { status: response.status, next: async () => undefined, seen: async () => [] as unknown[][], close: async () => {} };
      expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
      const reader = response.body!.getReader(); const decoder = new TextDecoder(); let buffer = '';
      const next = async () => {
        while (!buffer.includes('\n\n')) { const { done, value } = await reader.read(); if (done) return undefined; buffer += decoder.decode(value); }
        const index = buffer.indexOf('\n\n'); const frame = buffer.slice(0, index); buffer = buffer.slice(index + 2);
        return { id: /^id: (.+)$/m.exec(frame)?.[1], message: parseComponent('DataChangeMessage', JSON.parse(/^data: (.+)$/m.exec(frame)![1]!)) };
      };
      // The next frame that carries events, skipping heartbeats.
      const seen = async () => { for (;;) { const frame = await next(); if (!frame) throw new Error('stream ended'); if (frame.message.events.length) return frame.message.events.map(event => [event.operation, event.rowId, event.revision]); } };
      return { status: 200, next, seen, close: () => reader.cancel() };
    };

    // Who may open a stream.
    expect((await open(undefined, { cookie: '' })).status).toBe(401); expect((await open(`tableId=${crypto.randomUUID()}&userId=${h.account}`)).status).toBe(404);
    expect((await open(`tableId=${tableId}&cursor=nonsense`)).status).toBe(400); expect((await open(`tableId=${tableId}&extra=1`)).status).toBe(400); expect((await open('userId=' + h.account)).status).toBe(400);
    const viewerToken = opaqueToken('as'); const viewerCsrf = opaqueToken('csrf'); const viewerId = crypto.randomUUID();
    await h.cloud`INSERT INTO accounts (id, primary_email, name, verified_at, terms_version) VALUES (${viewerId}, 'viewer@example.test', 'Viewer', now(), 'fixture')`;
    await h.cloud`INSERT INTO account_sessions (id, account_id, token_hash, csrf_hash, security_revision, device_name, expires_at, fresh_until)
      VALUES (${crypto.randomUUID()}, ${viewerId}, ${tokenDigest(viewerToken)}, ${tokenDigest(viewerCsrf)}, 1, 'Fixture', now() + interval '8 hours', now() + interval '10 minutes')`;
    await h.cloud`INSERT INTO memberships (id, account_id, org_id, role, state, project_access) VALUES (${crypto.randomUUID()}, ${viewerId}, ${scope.orgId}, 'Viewer', 'active', 'all')`;
    expect((await open(undefined, { cookie: `__Host-carbon-session=${viewerToken}`, 'x-csrf-token': viewerCsrf })).status).toBe(403);

    // A stream starts from now.
    const stream = await open(); const hello = (await stream.next())!; expect(hello.message).toMatchObject({ state: 'connected', events: [] }); expect(hello.id).toBe(hello.message.cursor); const origin = hello.id!;
    const first = await insert('one'); expect(await stream.seen()).toEqual([['insert', first.rowId, '1']]);
    // Someone else's row is not this reader's business.
    const stranger = crypto.randomUUID(); const names = databaseEnvironmentIdentifiers(scope.environmentId);
    await h.database.unsafe(`INSERT INTO "${names.schema}"."ct_${tableId.replaceAll('-', '')}" (owner, body) VALUES ($1::uuid, 'not yours')`, [stranger]);
    const second = await insert('two'); const frame = (await stream.next())!;
    expect(frame.message.events.map(event => [event.operation, event.rowId])).toEqual([['insert', second.rowId]]); const resume = frame.id!;
    // Quiet periods carry heartbeats, so the client can tell a silent stream from a dead one.
    let beat; do { beat = (await stream.next())!; } while (beat.message.state !== 'heartbeat'); expect(beat.message.events).toEqual([]); expect(beat.id).toBe(resume);
    await stream.close();

    // While disconnected, things happen. Reconnecting with the last id delivers exactly those, once, in order.
    const edited = await mutate({ kind: 'row.update', commandId: crypto.randomUUID(), tableId, access, rowId: first.rowId, revision: '1', values: { body: 'one, edited' } });
    const third = await insert('three'); await mutate({ kind: 'row.delete', commandId: crypto.randomUUID(), tableId, access, rowId: second.rowId, revision: '1' });
    const missed = [['update', first.rowId, edited.revision], ['insert', third.rowId, '1'], ['delete', second.rowId, null]];
    const again = await open(undefined, { 'last-event-id': resume }); expect(await again.seen()).toEqual(missed); await again.close();
    // The cursor can also be given explicitly, and an older one replays from there.
    const replay = await open(`tableId=${tableId}&userId=${h.account}&cursor=${origin}`);
    expect(await replay.seen()).toEqual([['insert', first.rowId, '1'], ['insert', second.rowId, '1'], ...missed]);
    // Previewing as someone else shows their rows only; previewing as nobody shows none.
    const theirs = await open(`tableId=${tableId}&userId=${stranger}&cursor=${origin}`); expect((await theirs.seen()).map(event => event[0])).toEqual(['insert']); await theirs.close();
    const nobody = await open(`tableId=${tableId}&cursor=${origin}`); expect((await nobody.next())!.message).toMatchObject({ state: 'connected', events: [] }); await nobody.close();

    // A schema change resets the stream: the client reloads the table and continues from the new cursor.
    const alter = { kind: 'table.alter', commandId: crypto.randomUUID(), tableId, revision: '1', change: { kind: 'column.add', column: { name: 'note', type: 'text', nullable: true } } };
    expect((await h.api(dataPath, alter, '1', { 'idempotency-key': alter.commandId })).status).toBe(200); revision = '2';
    let reset; do { reset = (await replay.next())!; } while (reset.message.state !== 'reset'); expect(reset.message.events).toEqual([]); expect(reset.id!.startsWith('2.')).toBe(true);
    const fourth = await insert('four'); expect(await replay.seen()).toEqual([['insert', fourth.rowId, '1']]);
    // A stale cursor given at connect time is answered the same way, before anything else.
    const stale = await open(`tableId=${tableId}&userId=${h.account}&cursor=${origin}`); expect((await stale.next())!.message.state).toBe('reset'); await stale.close();

    // Access ends: the stream says so and stops. Nothing further is delivered.
    await h.cloud`UPDATE account_sessions SET expires_at = now() - interval '1 second' WHERE id = ${h.session}`;
    let last; do { last = (await replay.next())!; } while (last.message.state === 'heartbeat' || last.message.state === 'connected');
    expect(last.message).toEqual({ state: 'authorization_revoked', cursor: '', events: [] }); expect(last.id).toBeUndefined(); expect(await replay.next()).toBeUndefined();
    await h.cloud`UPDATE account_sessions SET expires_at = now() + interval '8 hours' WHERE id = ${h.session}`;
    // A stream does not live forever: it closes cleanly and the client reconnects with its cursor.
    const bounded = await open(); let end; do { end = (await bounded.next())!; } while (end.message.state !== 'closed'); expect(end.id).toBeDefined(); expect(await bounded.next()).toBeUndefined();
  }, 120000);

  test('vector and graph commands reach Database only as signed requests for one exact environment, under live authority and separate permissions', async () => {
    const h = await harness(); const first = await h.create('engine-a', ['database']); expect(await h.worker.execute()).toBe(true);
    const second = await h.create('engine-b', ['database']); expect(await h.worker.execute()).toBe(true);
    const A = parseComponent('EnvironmentScope', first.scope); const B = parseComponent('EnvironmentScope', second.scope); const id = () => crypto.randomUUID();
    const send = (family: 'vectors' | 'graph', scope: typeof A, command: Record<string, unknown>, overrides: Record<string, string> = {}) =>
      h.api(`/platform/v1/orgs/${scope.orgId}/projects/${scope.projectId}/environments/${scope.environmentId}/${family}`, command, command.revision as string | undefined, { ...(command.commandId ? { 'idempotency-key': command.commandId as string } : {}), ...overrides });
    const ok = async (family: 'vectors' | 'graph', scope: typeof A, command: Record<string, unknown>) => { const response = await send(family, scope, command); if (response.status !== 200) throw new Error(`${command.kind} answered ${response.status}`); return (await response.json() as { result: Record<string, any> }).result; };
    const status = async (family: 'vectors' | 'graph', scope: typeof A, command: Record<string, unknown>, overrides?: Record<string, string>) => (await send(family, scope, command, overrides)).status;

    // Vectors.
    const collection = id(); const [near, far] = [id(), id()]; const creating = { kind: 'collection.create', commandId: id(), collectionId: collection, definition: { name: 'articles', dimension: 2, metric: 'l2' } };
    expect(await status('vectors', A, creating, { cookie: '' })).toBe(401); expect(await status('vectors', A, creating, { 'x-csrf-token': 'bad' })).toBe(403); expect(await status('vectors', A, creating, { 'idempotency-key': id() })).toBe(400);
    expect(await status('vectors', A, { kind: 'collection.drop', commandId: id(), collectionId: collection })).toBe(400); expect(await status('vectors', A, { kind: 'node.get', nodeId: id() })).toBe(400);
    const created = await ok('vectors', A, creating); expect(created).toEqual({ commandId: creating.commandId, collectionId: collection, revision: '1' }); expect(await ok('vectors', A, creating)).toEqual(created);
    await ok('vectors', A, { kind: 'points.upsert', commandId: id(), collectionId: collection, points: [{ id: near, vector: [1, 1], metadata: { lang: 'en' } }, { id: far, vector: [9, 9], metadata: { lang: 'nl' } }] });
    expect((await ok('vectors', A, { kind: 'points.query', collectionId: collection, vector: [0, 0] })).matches.map((match: { id: string }) => match.id)).toEqual([near, far]);
    expect((await ok('vectors', A, { kind: 'points.query', collectionId: collection, vector: [0, 0], filter: { lang: 'nl' } })).matches.map((match: { id: string }) => match.id)).toEqual([far]);
    expect(await status('vectors', A, { kind: 'points.query', collectionId: collection, vector: [0, 0, 0] })).toBe(400);
    // Graph.
    const [ada, bob, eve] = [id(), id(), id()]; for (const [node, name] of [[ada, 'Ada'], [bob, 'Bob'], [eve, 'Eve']] as const) await ok('graph', A, { kind: 'node.put', commandId: id(), node: { id: node, label: 'Person', properties: { name } } });
    const knows = id(); await ok('graph', A, { kind: 'edge.put', commandId: id(), edge: { id: knows, source: ada, target: bob, label: 'KNOWS', properties: {} } });
    await ok('graph', A, { kind: 'edge.put', commandId: id(), edge: { id: id(), source: bob, target: eve, label: 'KNOWS', properties: {} } });
    expect(await status('graph', A, { kind: 'edge.put', commandId: id(), edge: { id: id(), source: ada, target: id(), label: 'KNOWS', properties: {} } })).toBe(409);
    expect((await ok('graph', A, { kind: 'traverse', nodeId: ada, direction: 'out', maxDepth: 3 })).reached.map((item: { node: { properties: { name: string } }; depth: number }) => [item.node.properties.name, item.depth])).toEqual([['Ada', 0], ['Bob', 1], ['Eve', 2]]);
    expect(await ok('graph', A, { kind: 'path', from: ada, to: eve, direction: 'out', maxDepth: 4 })).toMatchObject({ found: true, nodes: [ada, bob, eve] });
    expect(await status('graph', A, { kind: 'node.delete', commandId: id(), nodeId: bob })).toBe(409); expect(await status('graph', A, { kind: 'traverse', nodeId: ada, direction: 'out', maxDepth: 9 })).toBe(400);

    // The second environment: nothing of the first is there, by any ID.
    for (const command of [{ kind: 'points.query', collectionId: collection, vector: [0, 0] }, { kind: 'points.upsert', commandId: id(), collectionId: collection, points: [{ id: id(), vector: [1, 1], metadata: {} }] },
      { kind: 'collection.delete', commandId: id(), collectionId: collection, revision: '2', confirmation: 'articles' }]) expect(await status('vectors', B, command)).toBe(404);
    expect((await ok('vectors', B, { kind: 'collections.list' })).collections).toEqual([]);
    for (const command of [{ kind: 'node.get', nodeId: ada }, { kind: 'traverse', nodeId: ada, direction: 'both', maxDepth: 6 }, { kind: 'node.delete', commandId: id(), nodeId: ada, detach: true }, { kind: 'edge.delete', commandId: id(), edgeId: knows }]) expect(await status('graph', B, command)).toBe(404);
    expect(await status('graph', B, { kind: 'edge.put', commandId: id(), edge: { id: id(), source: ada, target: bob, label: 'KNOWS', properties: {} } })).toBe(409);

    // Permissions are separate. A member with metadata access can list collections and nothing else.
    const viewerToken = opaqueToken('as'); const viewerCsrf = opaqueToken('csrf'); const viewerId = id();
    await h.cloud`INSERT INTO accounts (id, primary_email, name, verified_at, terms_version) VALUES (${viewerId}, 'viewer@example.test', 'Viewer', now(), 'fixture')`;
    await h.cloud`INSERT INTO account_sessions (id, account_id, token_hash, csrf_hash, security_revision, device_name, expires_at, fresh_until)
      VALUES (${id()}, ${viewerId}, ${tokenDigest(viewerToken)}, ${tokenDigest(viewerCsrf)}, 1, 'Fixture', now() + interval '8 hours', now() + interval '10 minutes')`;
    await h.cloud`INSERT INTO memberships (id, account_id, org_id, role, state, project_access) VALUES (${id()}, ${viewerId}, ${A.orgId}, 'Viewer', 'active', 'all')`;
    const viewer = { cookie: `__Host-carbon-session=${viewerToken}`, 'x-csrf-token': viewerCsrf };
    expect(await status('vectors', A, { kind: 'collections.list' }, viewer)).toBe(200);
    for (const command of [{ kind: 'points.query', collectionId: collection, vector: [0, 0] }, { kind: 'points.get', collectionId: collection, ids: [near] }, { kind: 'points.upsert', commandId: id(), collectionId: collection, points: [{ id: id(), vector: [1, 1], metadata: {} }] },
      { kind: 'collection.create', commandId: id(), collectionId: id(), definition: { name: 'viewer', dimension: 2, metric: 'l2' } }]) expect(await status('vectors', A, command, viewer)).toBe(403);
    for (const command of [{ kind: 'node.get', nodeId: ada }, { kind: 'traverse', nodeId: ada, direction: 'out', maxDepth: 2 }, { kind: 'node.put', commandId: id(), node: { id: id(), label: 'Person', properties: {} } }]) expect(await status('graph', A, command, viewer)).toBe(403);

    // Authority is live at Database too: a principal that stops being current mid-request changes nothing.
    const points = (await h.database`SELECT count(*)::integer AS count FROM canonical_vector_points`)[0].count; const nodes = (await h.database`SELECT count(*)::integer AS count FROM canonical_graph_nodes`)[0].count;
    h.interceptAuthority(async () => { await h.cloud`UPDATE accounts SET permission_revision = permission_revision + 1 WHERE id = ${h.account}`; });
    expect([401, 403]).toContain(await status('vectors', A, { kind: 'points.upsert', commandId: id(), collectionId: collection, points: [{ id: id(), vector: [5, 5], metadata: {} }] }));
    expect([401, 403]).toContain(await status('graph', A, { kind: 'node.put', commandId: id(), node: { id: id(), label: 'Person', properties: {} } })); h.interceptAuthority();
    expect((await h.database`SELECT count(*)::integer AS count FROM canonical_vector_points`)[0].count).toBe(points); expect((await h.database`SELECT count(*)::integer AS count FROM canonical_graph_nodes`)[0].count).toBe(nodes);
    // An assertion for one family is not accepted on another family's route, and a tampered path is refused.
    const proof = await h.signedData({ scope: A, bindingId: (await h.cloud`SELECT id FROM service_bindings WHERE environment_id = ${A.environmentId} AND owner = 'database'`)[0].id, command: { kind: 'tables.list' } });
    for (const route of ['/vectors/collections.list', '/graph/node.get']) expect([400, 401]).toContain((await fetch(proof.url.replace('/data/tables.list', route), proof.init)).status);
    // Both environments are intact.
    expect((await ok('vectors', A, { kind: 'collections.list' })).collections.map((item: { pointCount: number }) => item.pointCount)).toEqual([2]); expect((await ok('graph', A, { kind: 'node.get', nodeId: eve })).node.properties.name).toBe('Eve');
  }, 120000);

  test('table catalog is paginated, scoped and available to metadata-only accounts with current schema policies', async () => {
    const h = await harness(); const created = await h.create('catalog-data', ['database']); expect(await h.worker.execute()).toBe(true);
    const scope = parseComponent('EnvironmentScope', created.scope);
    const envPath = `/platform/v1/orgs/${scope.orgId}/projects/${scope.projectId}/environments/${scope.environmentId}`;
    const path = envPath + '/data'; const env = parseComponent('CatalogEnvironmentDetails', await (await h.api(envPath)).json());
    const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()].sort();
    const definition = { name: 'notes', columns: [{ name: 'body', type: 'text', nullable: false }], policies: { enabled: true, rules: [] } };
    for (const [index, id] of ids.entries()) {
      const command = { kind: 'table.create', commandId: crypto.randomUUID(), tableId: id, definition: { ...definition, name: 'notes_' + index } };
      expect((await h.api(path, command, env.environment.revision, { 'idempotency-key': command.commandId })).status).toBe(200);
    }
    const first = parseComponent('AccountDataTablesPage', await (await h.api(path, { kind: 'tables.list', limit: 2 })).json());
    expect(first.tables.map(table => table.id)).toEqual(ids.slice(0, 2)); expect(first.nextCursor).not.toBeNull();
    expect(first.tables[0]).toEqual({ id: ids[0], revision: '1', name: 'notes_0', columnCount: 1, policiesEnabled: true });
    const last = parseComponent('AccountDataTablesPage', await (await h.api(path, { kind: 'tables.list', limit: 2, cursor: first.nextCursor })).json());
    expect(last.tables.map(table => table.id)).toEqual(ids.slice(2)); expect(last.nextCursor).toBeNull();
    const namedQuery = { kind: 'tables.list', sort: '-name', name: 'NOTES_', limit: 2 };
    const named = parseComponent('AccountDataTablesPage', await (await h.api(path, namedQuery)).json());
    expect(named.tables.map(table => table.name)).toEqual(['notes_2', 'notes_1']);
    const namedLast = parseComponent('AccountDataTablesPage', await (await h.api(path, { ...namedQuery, name: 'notes_', cursor: named.nextCursor })).json());
    expect(namedLast.tables.map(table => table.name)).toEqual(['notes_0']); expect(namedLast.nextCursor).toBeNull();
    expect((await h.api(path, { ...namedQuery, sort: 'name', cursor: named.nextCursor })).status).toBe(400);
    expect((await h.api(path, { ...namedQuery, name: 'notes_1', cursor: named.nextCursor })).status).toBe(400);
    expect((await h.api(path, { kind: 'tables.list', limit: 1, cursor: first.nextCursor })).status).toBe(400);
    expect((await h.api(path, { kind: 'rows.query', tableId: ids[0], access: { mode: 'policy-preview' }, limit: 2, cursor: first.nextCursor })).status).toBe(400);
    const policies = { kind: 'table.policies', commandId: crypto.randomUUID(), tableId: ids[0], revision: '1', policies: { enabled: false, rules: [] } };
    expect((await h.api(path, policies, '1', { 'idempotency-key': policies.commandId })).status).toBe(200);
    const details = parseComponent('AccountDataTableDetails', await (await h.api(path, { kind: 'table.get', tableId: ids[0] })).json());
    expect(details.table.revision).toBe('2'); expect(details.table.definition.policies.enabled).toBe(false);
    const typesQuery = { kind: 'table.types', tableId: ids[0], revision: '2' };
    const typesResponse = await h.api(path, typesQuery); expect(typesResponse.status).toBe(200);
    expect(typesResponse.headers.get('cache-control')).toBe('no-store');
    const types = parseComponent('AccountDataGeneratedTypes', await typesResponse.json());
    expect(types.scope).toEqual(scope); expect(types.artifact.tableId).toBe(ids[0]); expect(types.artifact.revision).toBe('2');
    expect(types.artifact.filename).toBe('notes_0-2.ts'); expect(types.artifact.text).toContain('"body": string;');
    const importQuery = { kind: 'rows.import-preview', tableId: ids[0], revision: '2', input: { format: 'json', text: '[{"body":"review only"},{}]', mapping: {}, conflict: 'error', atomic: true } };
    const beforeImportReview = await h.database`SELECT (SELECT count(*)::text FROM canonical_data_events WHERE table_id = ${ids[0]!}) AS events,
      (SELECT count(*)::text FROM canonical_data_commands WHERE table_id = ${ids[0]!}) AS commands`;
    const importResponse = await h.api(path, importQuery); expect(importResponse.status).toBe(200);
    expect(importResponse.headers.get('cache-control')).toBe('no-store');
    const importReview = parseComponent('AccountDataImportPreview', await importResponse.json());
    expect(importReview.scope).toEqual(scope); expect(importReview.preview).toMatchObject({ tableId: ids[0], revision: '2', validation: 'structure', total: 2, valid: 1, invalid: 1 });
    expect(importReview.preview.samples).toEqual([{ row: 1, values: { body: 'review only' } }]);
    expect(importReview.preview.errors[0]).toMatchObject({ row: 2, code: 'missing_column', column: 'body' });
    expect(await h.database`SELECT (SELECT count(*)::text FROM canonical_data_events WHERE table_id = ${ids[0]!}) AS events,
      (SELECT count(*)::text FROM canonical_data_commands WHERE table_id = ${ids[0]!}) AS commands`).toEqual(beforeImportReview);
    expect((await h.api(path, { ...importQuery, input: { ...importQuery.input, text: '[{"body":"a","body":"b"}]' } })).status).toBe(400);
    expect((await h.api(path, { ...typesQuery, revision: '1' })).status).toBe(409);
    expect((await h.api(path, { ...typesQuery, revision: '0' })).status).toBe(400);
    const change = { kind: 'column.add', column: { name: 'extra', type: 'text', nullable: true } };
    const previewResponse = await h.api(path, { kind: 'table.preview', tableId: ids[0], change }); expect(previewResponse.status).toBe(200);
    const preview = parseComponent('AccountDataSchemaPreview', await previewResponse.json()); expect(preview.preview.revision).toBe('2'); expect(preview.preview.destructive).toBe(false);
    const alteration = { kind: 'table.alter', tableId: ids[0], commandId: crypto.randomUUID(), revision: '2', change };
    expect((await h.api(path, alteration, '2', { 'idempotency-key': alteration.commandId })).status).toBe(200);
    expect((await h.api(path, alteration, '2', { 'idempotency-key': alteration.commandId })).status).toBe(200);
    expect((await h.api(path, typesQuery)).status).toBe(409);
    expect((await h.api(path, importQuery)).status).toBe(409);
    const changedTypes = parseComponent('AccountDataGeneratedTypes', await (await h.api(path, { ...typesQuery, revision: '3' })).json());
    expect(changedTypes.artifact.revision).toBe('3'); expect(changedTypes.artifact.text).toContain('"extra"?: string | null;');
    const uuidColumn = { ...alteration, commandId: crypto.randomUUID(), revision: '3', confirmation: 'notes_0', change: { kind: 'column.edit', original: 'extra', column: { name: 'extra', type: 'uuid', nullable: true } } };
    expect((await h.api(path, uuidColumn, '3', { 'idempotency-key': uuidColumn.commandId })).status).toBe(200);
    const invalidCast = { ...uuidColumn, commandId: crypto.randomUUID(), revision: '4', change: { ...uuidColumn.change, column: { name: 'extra', type: 'boolean', nullable: true } } };
    expect((await h.api(path, invalidCast, '4', { 'idempotency-key': invalidCast.commandId })).status).toBe(400);
    expect(parseComponent('AccountDataTableDetails', await (await h.api(path, { kind: 'table.get', tableId: ids[0] })).json()).table.revision).toBe('4');
    const keyChange = { kind: 'primary-key', column: 'extra' };
    const keyPreview = parseComponent('AccountDataSchemaPreview', await (await h.api(path, { kind: 'table.preview', tableId: ids[0], change: keyChange })).json());
    expect(keyPreview.preview.definition.primaryKey).toBe('extra'); expect(keyPreview.preview.destructive).toBe(false);
    const keyCommand = { ...alteration, commandId: crypto.randomUUID(), revision: '4', change: keyChange };
    expect((await h.api(path, keyCommand, '4', { 'idempotency-key': keyCommand.commandId })).status).toBe(200);
    const clearKey = { ...keyCommand, commandId: crypto.randomUUID(), revision: '5', change: { kind: 'primary-key', column: null } };
    expect((await h.api(path, clearKey, '5', { 'idempotency-key': clearKey.commandId })).status).toBe(400);
    expect((await h.api(path, { ...clearKey, confirmation: 'notes_0' }, '5', { 'idempotency-key': clearKey.commandId })).status).toBe(200);
    const index = { id: crypto.randomUUID(), name: 'extra_index', kind: 'index', columns: ['extra'] };
    const indexCommand = { ...alteration, commandId: crypto.randomUUID(), revision: '6', change: { kind: 'constraint.set', constraint: index } };
    expect((await h.api(path, { kind: 'table.preview', tableId: ids[0], change: indexCommand.change })).status).toBe(200);
    expect((await h.api(path, indexCommand, '6', { 'idempotency-key': indexCommand.commandId })).status).toBe(200);
    expect((await h.api(path, indexCommand, '6', { 'idempotency-key': indexCommand.commandId })).status).toBe(200);
    const removeIndex = { ...alteration, commandId: crypto.randomUUID(), revision: '7', change: { kind: 'constraint.delete', constraintId: index.id } };
    expect((await h.api(path, removeIndex, '7', { 'idempotency-key': removeIndex.commandId })).status).toBe(200);
    const other = await h.create('other-catalog', ['database']); expect(await h.worker.execute()).toBe(true);
    const otherPath = `/platform/v1/orgs/${scope.orgId}/projects/${other.scope.projectId}/environments/${other.scope.environmentId}/data`;
    expect((await h.api(otherPath, { kind: 'table.get', tableId: ids[0] })).status).toBe(404);
    expect((await h.api(otherPath, { kind: 'table.types', tableId: ids[0] })).status).toBe(404);
    expect((await h.api(otherPath, { ...importQuery, revision: undefined })).status).toBe(404);
    expect(parseComponent('AccountDataTablesPage', await (await h.api(otherPath, { kind: 'tables.list' })).json()).tables).toHaveLength(0);
    // Fixture permission change leaves only metadata access. No fresh proof is needed for these reads.
    const remainingOwner = crypto.randomUUID();
    await h.cloud`INSERT INTO accounts (id, primary_email, name, verified_at, terms_version) VALUES (${remainingOwner}, 'remaining-owner@example.test', 'Remaining owner', now(), 'fixture')`;
    await h.cloud`INSERT INTO memberships (id, account_id, org_id, role, state) VALUES (${crypto.randomUUID()}, ${remainingOwner}, ${scope.orgId}, 'Owner', 'active')`;
    await h.cloud`UPDATE memberships SET role = 'Viewer', project_access = 'all', revision = revision + 1 WHERE org_id = ${scope.orgId} AND account_id = ${h.account}`;
    await h.cloud`UPDATE accounts SET permission_revision = permission_revision + 1 WHERE id = ${h.account}`;
    await h.cloud`UPDATE account_sessions SET fresh_until = now() - interval '1 second' WHERE account_id = ${h.account}`;
    expect((await h.api(path, { kind: 'tables.list', limit: 2, cursor: first.nextCursor })).status).toBe(400);
    expect((await h.api(path, { kind: 'table.get', tableId: ids[0] })).status).toBe(200);
    expect((await h.api(path, { kind: 'table.types', tableId: ids[0] })).status).toBe(200);
    expect((await h.api(path, { ...importQuery, revision: undefined })).status).toBe(200);
    expect((await h.api(path, { kind: 'table.preview', tableId: ids[0], change: { kind: 'rename', name: 'preview_only' } })).status).toBe(200);
    expect((await h.api(path, { kind: 'tables.list' })).status).toBe(200);
    expect((await h.api(path, { kind: 'rows.query', tableId: ids[0], access: { mode: 'policy-preview' } })).status).toBe(403);
    h.interceptAuthority(async call => { if (call === 3) await h.cloud`UPDATE accounts SET permission_revision = permission_revision + 1 WHERE id = ${h.account}`; });
    expect((await h.api(path, { kind: 'table.get', tableId: ids[0] })).status).toBe(403);
    h.interceptAuthority();
    h.interceptAuthority(async call => { if (call === 3) await h.cloud`UPDATE accounts SET permission_revision = permission_revision + 1 WHERE id = ${h.account}`; });
    expect((await h.api(path, { kind: 'table.types', tableId: ids[0] })).status).toBe(403);
    h.interceptAuthority();
    h.interceptAuthority(async call => { if (call === 3) await h.cloud`UPDATE accounts SET permission_revision = permission_revision + 1 WHERE id = ${h.account}`; });
    expect((await h.api(path, { ...importQuery, revision: undefined })).status).toBe(403);
    h.interceptAuthority();
  }, 30000);
  test('Cloud account data forwarding requires session, CSRF, current revisions and fresh mutations, and binds encrypted cursors', async () => {
    const h = await harness(); const created = await h.create('browser-data', ['database']); expect(await h.worker.execute()).toBe(true);
    const scope = parseComponent('EnvironmentScope', created.scope);
    const envPath = `/platform/v1/orgs/${scope.orgId}/projects/${scope.projectId}/environments/${scope.environmentId}`; const path = envPath + '/data';
    const env = parseComponent('CatalogEnvironmentDetails', await (await h.api(envPath)).json());
    const tableId = crypto.randomUUID(); const creation = { kind: 'table.create', commandId: crypto.randomUUID(), tableId,
      definition: { name: 'notes', columns: [{ name: 'owner', type: 'uuid', nullable: false }, { name: 'body', type: 'text', nullable: false }],
        policies: { enabled: true, rules: [{ id: crypto.randomUUID(), name: 'Owned', kind: 'owner', ownerColumn: 'owner', operations: ['select','insert','update','delete'] }] } } };
    const headers = { 'idempotency-key': creation.commandId };
    expect((await h.api(path, creation, env.environment.revision, { ...headers, cookie: '' })).status).toBe(401);
    expect((await h.api(path, creation, env.environment.revision, { ...headers, 'x-csrf-token': 'invalid' })).status).toBe(403);
    expect((await h.api(path, creation, env.environment.revision, { ...headers, origin: 'https://foreign.example.test' })).status).toBe(403);
    expect((await h.api(path, creation, '999', headers)).status).toBe(409);
    const response = await h.api(path, creation, env.environment.revision, headers); expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const access = { mode: 'policy-preview', userId: h.account };
    for (const body of ['first', 'second']) {
      const command = { kind: 'row.insert', commandId: crypto.randomUUID(), tableId, revision: '1', access, values: { owner: h.account, body } };
      expect((await h.api(path, command, '1', { 'idempotency-key': command.commandId })).status).toBe(200);
      expect((await h.api(path, command, '2', { 'idempotency-key': command.commandId })).status).toBe(400);
    }
    const query = { kind: 'rows.query', tableId, access, limit: 1 };
    const firstResponse = await h.api(path, query); expect(firstResponse.status).toBe(200); const first = parseComponent('AccountDataPage', await firstResponse.json());
    expect(first.rows).toHaveLength(1); expect(first.nextCursor).not.toBeNull(); expect(first.nextCursor).not.toContain(first.rows[0]!.id);
    const next = await h.api(path, { ...query, cursor: first.nextCursor }); expect(next.status).toBe(200); const second = parseComponent('AccountDataPage', await next.json());
    expect(second.rows).toHaveLength(1); expect(second.rows[0]!.id).not.toBe(first.rows[0]!.id);
    const sortedQuery = { ...query, sort: { column: 'body', direction: 'desc' }, columns: [] };
    const sortedResponse = await h.api(path, sortedQuery); expect(sortedResponse.status).toBe(200);
    const sorted = parseComponent('AccountDataPage', await sortedResponse.json()); expect(sorted.rows[0]!.values).toEqual({});
    expect(JSON.stringify(sorted)).not.toContain('second');
    const sortedLast = parseComponent('AccountDataPage', await (await h.api(path, { ...sortedQuery, cursor: sorted.nextCursor })).json());
    expect(sortedLast.rows[0]!.id).not.toBe(sorted.rows[0]!.id); expect(sortedLast.nextCursor).toBeNull();
    expect((await h.api(path, { ...sortedQuery, sort: { column: 'body', direction: 'asc' }, cursor: sorted.nextCursor })).status).toBe(400);
    const selected = await h.api(path, { ...query, columns: ['body'], selectedIds: [first.rows[0]!.id], filters: [{ column: 'body', operator: 'eq', value: first.rows[0]!.values.body }] });
    expect(selected.status).toBe(200);
    expect(parseComponent('AccountDataPage', await selected.json()).rows).toEqual([{ ...first.rows[0]!, values: { body: first.rows[0]!.values.body } }]);
    for (const changed of [{ columns: ['body'] }, { selectedIds: [first.rows[0]!.id] }, { filters: [{ column: 'body', operator: 'contains', value: 'first' }] }])
      expect((await h.api(path, { ...query, ...changed, cursor: first.nextCursor })).status).toBe(400);
    expect((await h.api(path, { ...query, limit: 2, cursor: first.nextCursor })).status).toBe(400);
    expect((await h.api(path, { ...query, access: { ...access, userId: crypto.randomUUID() }, cursor: first.nextCursor })).status).toBe(400);
    expect((await h.api(path, { ...query, access: { mode: 'application' } })).status).toBe(403);
    const large = { kind: 'row.insert', commandId: crypto.randomUUID(), tableId, revision: '1', access, values: { owner: h.account, body: 'z'.repeat(16000) } };
    expect((await h.api(path, large, '1', { 'idempotency-key': large.commandId })).status).toBe(200);
    const largePage = parseComponent('AccountDataPage', await (await h.api(path, sortedQuery)).json());
    expect(largePage.nextCursor!.length).toBeGreaterThan(4096); expect(largePage.rows[0]!.values).toEqual({});
    expect((await h.api(path, { ...sortedQuery, cursor: largePage.nextCursor })).status).toBe(200);
    const staleInsert = { kind: 'row.insert', commandId: crypto.randomUUID(), tableId, revision: '2', access, values: { owner: h.account, body: 'stale schema' } };
    expect((await h.api(path, staleInsert, '2', { 'idempotency-key': staleInsert.commandId })).status).toBe(409);
    expect(await h.database`SELECT command_id FROM canonical_data_commands WHERE command_id = ${staleInsert.commandId}`).toHaveLength(0);
    const expiring = { ...creation, commandId: crypto.randomUUID(), tableId: crypto.randomUUID(), definition: { ...creation.definition, name: 'expired_create' } };
    h.interceptAuthority(async call => { if (call === 4) await h.cloud`UPDATE account_sessions SET fresh_until = now() - interval '1 second' WHERE account_id = ${h.account}`; });
    expect((await h.api(path, expiring, env.environment.revision, { 'idempotency-key': expiring.commandId })).status).toBe(403);
    expect(await h.database`SELECT id FROM canonical_data_tables WHERE id = ${expiring.tableId}`).toHaveLength(0);
    expect(await h.database`SELECT command_id FROM canonical_data_commands WHERE command_id = ${expiring.commandId}`).toHaveLength(0);
    h.interceptAuthority();
    await h.cloud`UPDATE account_sessions SET fresh_until = now() + interval '10 minutes' WHERE account_id = ${h.account}`;
    await h.cloud`UPDATE accounts SET permission_revision = permission_revision + 1 WHERE id = ${h.account}`;
    expect((await h.api(path, { ...query, cursor: first.nextCursor })).status).toBe(400);
    await h.cloud`UPDATE account_sessions SET fresh_until = now() - interval '1 second' WHERE account_id = ${h.account}`;
    const denied = { kind: 'row.insert', commandId: crypto.randomUUID(), tableId, revision: '1', access, values: { owner: h.account, body: 'no fresh proof' } };
    expect((await h.api(path, denied, '1', { 'idempotency-key': denied.commandId })).status).toBe(403);
    expect(await h.database`SELECT command_id FROM canonical_data_commands WHERE command_id = ${denied.commandId}`).toHaveLength(0);
    expect((await h.api(path, query)).status).toBe(200);
    expect((await h.api(`/platform/v1/orgs/${crypto.randomUUID()}/projects/${scope.projectId}/environments/${scope.environmentId}/data`, query)).status).toBe(404);
  }, 30000);

  test('signed data requests enforce live scope and native row policies while receipts survive lost responses and concurrent retries', async () => {
    const h = await harness(); const created = await h.create('data', ['database']); expect(await h.worker.execute()).toBe(true);
    const scope = parseComponent('EnvironmentScope', created.scope);
    const bindingId = (await h.cloud`SELECT id FROM service_bindings WHERE environment_id = ${scope.environmentId} AND owner = 'database'`)[0].id;
    const tableId = crypto.randomUUID();
    const send = async (command: unknown) => { const call = await h.signedData({ scope, bindingId, command }); return fetch(call.url, call.init); };
    const result = async (response: Response) => parseComponent('DataResponse', await response.json()).result;
    const definition = { name: 'notes', columns: [{ name: 'owner', type: 'uuid', nullable: false }, { name: 'body', type: 'text', nullable: false }],
      policies: { enabled: true, rules: [{ id: crypto.randomUUID(), name: 'Owner', kind: 'owner', ownerColumn: 'owner', operations: ['select', 'insert', 'update', 'delete'] }] } };
    const createCommand = { kind: 'table.create', commandId: crypto.randomUUID(), tableId, definition };
    const createResponse = await send(createCommand); expect(createResponse.status).toBe(200); expect(createResponse.headers.get('cache-control')).toBe('no-store');
    const createdTable = parseComponent('DataCommandReceipt', await result(createResponse)); expect(createdTable.revision).toBe('1');
    const access = { mode: 'policy-preview', userId: h.account };
    const insert = { kind: 'row.insert', commandId: crypto.randomUUID(), tableId, revision: '1', access, values: { owner: h.account, body: 'sensitive-row-value' } };
    const firstCall = await h.signedData({ scope, bindingId, command: insert });
    const first = await fetch(firstCall.url, firstCall.init); expect(first.status).toBe(200);
    const receipt = parseComponent('DataCommandReceipt', await result(first)); expect(JSON.stringify(receipt)).not.toContain('sensitive-row-value');
    expect((await fetch(firstCall.url, firstCall.init)).status).toBe(401);
    h.restart();
    const retried = await Promise.all([send(insert), send(insert)]);
    for (const response of retried) { expect(response.status).toBe(200); expect(await result(response)).toEqual(receipt); }
    expect((await h.clientData({ scope, bindingId, command: insert })).result).toEqual(receipt);
    const stored = await h.database`SELECT result FROM canonical_data_commands WHERE command_id = ${insert.commandId}`;
    expect(stored).toHaveLength(1); expect(JSON.stringify(stored)).not.toContain('sensitive-row-value');
    const events = await h.database`SELECT id FROM canonical_data_events WHERE table_id = ${tableId} AND action = 'rows.write'`;
    expect(events).toHaveLength(1);
    expect((await send({ ...insert, values: { ...insert.values, body: 'different' } })).status).toBe(409);
    const query = { kind: 'rows.query', tableId, access, limit: 10 };
    const read = await send(query); expect(read.status).toBe(200); const rows = parseComponent('DataQueryResult', await result(read));
    expect(rows.rows).toHaveLength(1); expect(rows.rows[0]!.values.body).toBe('sensitive-row-value');
    expect(parseComponent('DataQueryResult', (await h.clientData({ scope, bindingId, command: query })).result).rows).toHaveLength(1);
    const hidden = await send({ ...query, access: { ...access, userId: crypto.randomUUID() } }); expect(hidden.status).toBe(200); expect(parseComponent('DataQueryResult', await result(hidden)).rows).toHaveLength(0);
    const transfer = await send({ kind: 'row.update', commandId: crypto.randomUUID(), tableId, access, rowId: receipt.rowId, revision: receipt.revision, values: { owner: crypto.randomUUID() } });
    expect(transfer.status).toBe(403); expect(await transfer.text()).not.toContain('sensitive-row-value');
    const wrongAudience = await h.signedData({ scope, bindingId, command: query }, 'carbon-registry'); expect((await fetch(wrongAudience.url, wrongAudience.init)).status).toBe(401);
    const tampered = await h.signedData({ scope, bindingId, command: insert });
    expect((await fetch(tampered.url, { ...tampered.init, body: JSON.stringify({ scope, bindingId, command: { ...insert, values: { ...insert.values, body: 'tampered' } } }) })).status).toBe(401);
    const stale = await h.signedData({ scope, bindingId, command: query }); await h.cloud`UPDATE accounts SET permission_revision = permission_revision + 1 WHERE id = ${h.account}`;
    expect((await fetch(stale.url, stale.init)).status).toBe(401);
    const remove = await send({ kind: 'row.delete', commandId: crypto.randomUUID(), tableId, access, rowId: receipt.rowId, revision: receipt.revision }); expect(remove.status).toBe(200);
    expect(parseComponent('DataQueryResult', await result(await send(query))).rows).toHaveLength(0);
  }, 30000);

  test('signed data command authority loss before commit rolls back resources and receipts and permits a fresh retry', async () => {
    const h = await harness(); const created = await h.create('data-revocation', ['database']); expect(await h.worker.execute()).toBe(true);
    const scope = parseComponent('EnvironmentScope', created.scope); const bindingId = (await h.cloud`SELECT id FROM service_bindings WHERE environment_id = ${scope.environmentId}`)[0].id;
    const command = { kind: 'table.create', commandId: crypto.randomUUID(), tableId: crypto.randomUUID(), definition: { name: 'notes', columns: [{ name: 'body', type: 'text', nullable: false }], policies: { enabled: true, rules: [] } } };
    // Verification, outer transaction, inner native transaction, then pre-commit check.
    h.interceptAuthority(async call => { if (call === 4) await h.cloud`UPDATE accounts SET permission_revision = permission_revision + 1 WHERE id = ${h.account}`; });
    const call = await h.signedData({ scope, bindingId, command }); const response = await fetch(call.url, call.init); expect(response.status).toBe(403);
    expect(await h.database`SELECT id FROM canonical_data_tables WHERE id = ${command.tableId}`).toHaveLength(0);
    expect(await h.database`SELECT command_id FROM canonical_data_commands WHERE command_id = ${command.commandId}`).toHaveLength(0);
    h.interceptAuthority(); const retry = await h.signedData({ scope, bindingId, command }); expect((await fetch(retry.url, retry.init)).status).toBe(200);
    expect(await h.database`SELECT id FROM canonical_data_tables WHERE id = ${command.tableId}`).toHaveLength(1);
  }, 30000);

  test('Registry assertion exchange reaches only Registry: audiences cannot cross, replay is refused, and revocation is live', async () => {
    const h = await harness(); const created = await h.create(); const scope = parseComponent('EnvironmentScope', created.scope);
    expect(await h.worker.execute()).toBe(true); expect(await h.worker.execute()).toBe(true);
    const details = parseComponent('CatalogEnvironmentDetails', await (await h.api(`/platform/v1/orgs/${scope.orgId}/projects/${scope.projectId}/environments/${scope.environmentId}`)).json());
    const databaseBinding = details.bindings.find(b => b.owner === 'database')!.id; const registryBinding = details.bindings.find(b => b.owner === 'registry')!.id;
    const accounts = `/platform/v1/orgs/${scope.orgId}/service-accounts`;
    const accountResponse = await h.api(accounts, { name: 'Registry automation', scope, permissions: ['metadata.read'] }, details.environment.revision); expect(accountResponse.status).toBe(201);
    const serviceAccount = parseComponent('ServiceAccountReceipt', await accountResponse.json()).serviceAccount;
    const issued = parseComponent('ServiceAccountCredentialIssue', await (await h.api(`${accounts}/${serviceAccount.id}/credentials`, { name: 'CI', expiresAt: new Date(Date.now() + 86400_000).toISOString() }, serviceAccount.revision)).json());
    const body = canonicalRegistryRequest({ scope, bindingId: registryBinding, command: { kind: 'namespace.get' } }); const path = registryRequestPath(scope, registryBinding, 'namespace.get');
    const bound = { method: 'POST' as const, path, bodyDigest: bodyDigest(body) }; const registryExchange = { audience: 'carbon-registry' as const, scope, permission: 'metadata.read' as const, request: bound };
    const exchange = async (route: string, input: unknown) => { const requestId = crypto.randomUUID();
      const response = await h.api(route, input, undefined, { authorization: `Bearer ${issued.token}`, 'x-request-id': requestId }); return { response, requestId }; };
    const assertion = async (route = '/platform/v1/service-registry-assertions', input: unknown = registryExchange) => { const { response, requestId } = await exchange(route, input); expect(response.status).toBe(200);
      return { token: parseComponent('ServiceAccountAssertionResponse', await response.json()).token, requestId }; };
    const send = (origin: string, proof: { token: string; requestId: string }, target = path, payload = body) => fetch(origin + target, { method: 'POST', body: payload,
      headers: { authorization: `Bearer ${proof.token}`, 'content-type': 'application/json', 'x-request-id': proof.requestId } });

    const first = await assertion(); const accepted = await send(h.registryServer.url.origin, first); expect(accepted.status).toBe(200);
    const namespace = parseComponent('RegistryResponse', await accepted.json()); expect(namespace.scope).toEqual(scope); expect(namespace.bindingId).toBe(registryBinding);
    expect(namespace.result).toEqual({ id: (await h.registry`SELECT id FROM registry_environment_namespaces`)[0].id, state: 'active', revision: (namespace.result as { revision: string }).revision });
    expect((await send(h.registryServer.url.origin, first)).status).toBe(401);
    expect((await send(h.registryServer.url.origin, { ...(await assertion()), requestId: crypto.randomUUID() })).status).toBe(400);
    expect((await send(h.registryServer.url.origin, await assertion(), path, JSON.stringify({ ...JSON.parse(body), extra: true }))).status).toBe(400);

    // Each exchange names exactly one audience and path family.
    expect((await exchange('/platform/v1/service-assertions', registryExchange)).response.status).toBe(400);
    const dataPath = dataRequestPath(scope, databaseBinding, 'tables.list'); const dataBody = JSON.stringify({ scope, bindingId: databaseBinding, command: { kind: 'tables.list', limit: 25 } });
    const dataBound = { method: 'POST' as const, path: dataPath, bodyDigest: bodyDigest(dataBody) };
    expect((await exchange('/platform/v1/service-registry-assertions', { ...registryExchange, request: dataBound })).response.status).toBe(400);
    expect((await exchange('/platform/v1/service-registry-assertions', { ...registryExchange, audience: 'carbon-database' })).response.status).toBe(400);

    // A Database assertion cannot reach Registry, even when it is bound to the exact Registry request.
    const databaseForRegistryPath = await assertion('/platform/v1/service-assertions', { ...registryExchange, audience: 'carbon-database' });
    expect((await send(h.registryServer.url.origin, databaseForRegistryPath)).status).toBe(401);
    const databaseProof = await assertion('/platform/v1/service-assertions', { ...registryExchange, audience: 'carbon-database', request: dataBound });
    expect((await send(h.registryServer.url.origin, databaseProof)).status).toBe(401);
    expect((await send(h.databaseServer.url.origin, databaseProof, dataPath, dataBody)).status).toBe(200);
    // A Registry assertion cannot reach Database, on Registry's path or on a data path.
    expect((await send(h.databaseServer.url.origin, await assertion())).status).not.toBe(200);
    expect((await send(h.databaseServer.url.origin, await assertion(), dataPath, dataBody)).status).toBe(401);
    // A Registry assertion naming the Database binding has no live authority.
    const foreignPath = registryRequestPath(scope, databaseBinding, 'namespace.get'); const foreignBody = canonicalRegistryRequest({ scope, bindingId: databaseBinding, command: { kind: 'namespace.get' } });
    const foreign = await assertion('/platform/v1/service-registry-assertions', { ...registryExchange, request: { method: 'POST', path: foreignPath, bodyDigest: bodyDigest(foreignBody) } });
    expect((await send(h.registryServer.url.origin, foreign, foreignPath, foreignBody)).status).toBe(401);

    // Revocation is live at consumption and at exchange.
    const outstanding = await assertion();
    const disabled = await h.api(`${accounts}/${serviceAccount.id}`, { kind: 'disable' }, serviceAccount.revision); expect(disabled.status).toBe(200);
    expect((await send(h.registryServer.url.origin, outstanding)).status).toBe(401);
    expect((await exchange('/platform/v1/service-registry-assertions', registryExchange)).response.status).toBe(401);
    expect(JSON.stringify(await h.registry`SELECT * FROM internal_assertion_replays`)).not.toContain(issued.token);
  }, 30000);

  test('packages are published only through an owned name, an exact upload and an operator review, and installed only against the pinned root; yanking, revocation and other tenants behave as documented', async () => {
    const h = await harness(); const first = await h.create('pub-a', ['registry']); expect(await h.worker.execute()).toBe(true);
    const A = parseComponent('EnvironmentScope', first.scope); const id = () => crypto.randomUUID(); const origin = h.registryServer.url.origin;
    // A second organization of the same account: another tenant as far as Registry is concerned.
    const rival = parseComponent('OrganizationReceipt', (await (await h.api('/platform/v1/orgs', { name: 'Rival', slug: 'rival' })).json() as { receipt: unknown }).receipt);
    const rivalRevision = (await (await h.api(`/platform/v1/orgs/${rival.id}`)).json() as { organization: { revision: string } }).organization.revision;
    const second = await h.api(`/platform/v1/orgs/${rival.id}/projects`, { name: 'rival-app', slug: 'rival-app', services: ['registry'] }, rivalRevision); expect(second.status).toBe(202);
    const B = parseComponent('EnvironmentScope', parseComponent('CatalogReceipt', (await second.json() as { receipt: unknown }).receipt).scope); expect(await h.worker.execute()).toBe(true);
    const send = (scope: typeof A, command: Record<string, unknown>, overrides: Record<string, string> = {}) =>
      h.api(`/platform/v1/orgs/${scope.orgId}/projects/${scope.projectId}/environments/${scope.environmentId}/registry`, command, command.revision as string | undefined, { ...(command.commandId ? { 'idempotency-key': command.commandId as string } : {}), ...overrides });
    const ok = async (scope: typeof A, command: Record<string, unknown>) => { const response = await send(scope, command); if (response.status !== 200) throw new Error(`${command.kind} answered ${response.status}`); return (await response.json() as { result: Record<string, any> }).result; };
    const status = async (scope: typeof A, command: Record<string, unknown>, overrides?: Record<string, string>) => (await send(scope, command, overrides)).status;
    const target = 'x86_64-pc-windows-msvc' as const; const manifest = { abiMajor: 1, abiMinor: 4, description: 'Clipboard access', requiredCapabilities: ['clipboard.read'], optionalCapabilities: [] };
    const dll = () => { const bytes = Buffer.alloc(256); bytes.write('MZ', 0); bytes.writeUInt32LE(64, 60); bytes.write('PE\0\0', 64); bytes.writeUInt16LE(0x8664, 68); return new Uint8Array(bytes); };
    const archive = (version: string, extra: { path: string; bytes: Uint8Array }[] = [], name = 'clipboard') => packArchive([{ path: 'carbon-plugin.json', bytes: new TextEncoder().encode(manifestFile({ publisher: 'acme', name, version, target }, manifest)) },
      { path: libraryFile(name, target), bytes: dll() }, { path: 'README.md', bytes: new TextEncoder().encode(`# ${name} ${version}\n`) }, ...extra]);
    const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
    const submission = (version: string, bytes: Uint8Array, name = 'clipboard') => ({ kind: 'version.submit', commandId: id(), publisher: 'acme', name, version, target, sizeBytes: bytes.length, sha256: digest(bytes), manifest });
    const put = (url: string, bytes: Uint8Array) => fetch(url, { method: 'PUT', body: Buffer.from(bytes) });
    const decision = (versionId: string, reason = 'Reviewed source and archive') => ({ versionId, operator: 'reviewer@carbon.example', reason, requestId: id() });
    const review = h.registryReview; const stored = () => [...h.registryObjects.keys()].sort();
    const rejected = (promise: Promise<unknown>) => promise.then(() => 'finished', error => String((error as Error).message));
    const fault = (promise: Promise<unknown>) => promise.then(() => 'finished', error => (error as { code?: string }).code ?? String(error));

    // Cloud forwards one command at a time, for a signed-in account, with CSRF and a matching idempotency key.
    expect(await ok(A, { kind: 'namespace.get' })).toMatchObject({ state: 'active' });
    const claim = { kind: 'publisher.claim', commandId: id(), slug: 'acme' };
    expect(await status(A, claim, { cookie: '' })).toBe(401); expect(await status(A, claim, { 'x-csrf-token': 'bad' })).toBe(403); expect(await status(A, claim, { 'idempotency-key': id() })).toBe(400);
    expect(await status(A, { kind: 'publisher.seize', commandId: id(), slug: 'acme' })).toBe(400); expect(await status(A, { ...claim, slug: 'Acme' })).toBe(400);

    // Namespace authority: a publisher name belongs to the organization that claimed it, and to nobody else.
    const claimed = await ok(A, claim); expect(claimed.publisher).toMatchObject({ slug: 'acme', state: 'active' }); expect(await ok(A, claim)).toEqual(claimed);
    expect(await status(A, { ...claim, slug: 'other-name' })).toBe(409);
    expect(await status(B, { kind: 'publisher.claim', commandId: id(), slug: 'acme' })).toBe(409); expect(await status(A, { kind: 'publisher.claim', commandId: id(), slug: 'acme' })).toBe(409);
    for (const reserved of ['carbon', 'official', 'registry']) expect(await status(B, { kind: 'publisher.claim', commandId: id(), slug: reserved })).toBe(409);
    expect((await ok(A, { kind: 'publishers.list' })).publishers.map((item: { slug: string }) => item.slug)).toEqual(['acme']); expect((await ok(B, { kind: 'publishers.list' })).publishers).toEqual([]);
    expect((await h.registry`SELECT org_id FROM registry_publishers WHERE slug = 'acme'`)[0].org_id).toBe(A.orgId);

    // Submitting reserves the version and discloses a single upload address, once.
    const bytes = archive('1.2.0'); const submit = submission('1.2.0', bytes);
    expect(await status(B, submission('1.2.0', bytes))).toBe(404); expect(await status(A, { ...submission('1.2.0', bytes), publisher: 'unclaimed' })).toBe(404);
    const reserved = await ok(A, submit); const versionId = reserved.version.id as string;
    expect(reserved.version).toMatchObject({ publisher: 'acme', name: 'clipboard', version: '1.2.0', target, state: 'awaiting_upload', yanked: false, signed: null, publishedAt: null, sha256: digest(bytes) });
    expect(reserved.upload.url.startsWith(`${origin}/registry/v1/uploads/ru_`)).toBe(true);
    const replay = await ok(A, submit); expect(replay.version.id).toBe(versionId); expect(replay.upload).toBeNull();
    expect(JSON.stringify(await h.registry`SELECT * FROM registry_versions`)).not.toContain(reserved.upload.url.split('/').at(-1));
    expect(await status(A, submission('1.2.0', bytes))).toBe(409);

    // The upload: exactly the declared bytes, once. Nothing else is stored, and a wrong upload does not use the reservation up.
    expect((await put(reserved.upload.url, archive('1.2.0', [{ path: 'extra.txt', bytes: new Uint8Array(3) }]))).status).toBe(400);
    expect((await put(reserved.upload.url, bytes.subarray(0, bytes.length - 1))).status).toBe(400);
    expect((await put(`${origin}/registry/v1/uploads/ru_${'A'.repeat(43)}`, bytes)).status).toBe(404); expect((await fetch(reserved.upload.url)).status).toBe(404);
    expect(stored()).toEqual([]); expect((await ok(A, { kind: 'version.get', versionId })).version.state).toBe('awaiting_upload');
    const uploaded = await put(reserved.upload.url, bytes); expect(uploaded.status).toBe(200);
    expect(parseComponent('RegistryVersion', (await uploaded.json() as { version: unknown }).version)).toMatchObject({ id: versionId, state: 'submitted', signed: null });
    expect((await put(reserved.upload.url, bytes)).status).toBe(404); expect(stored()).toEqual([`quarantine/${versionId}.tar.zst`]);
    // Submitted is not published: nobody can list or download it.
    expect((await fetch(`${origin}/registry/v1/packages/acme/clipboard`)).status).toBe(404); expect((await fetch(`${origin}/registry/v1/packages/acme/clipboard/1.2.0/${target}`)).status).toBe(404);

    // An archive that fails inspection is refused at upload: no reviewer sees it, nothing is kept, and the number is free again.
    const hostile = archive('1.2.1', [{ path: 'tools/helper.exe', bytes: dll() }]); const hostileReserved = await ok(A, submission('1.2.1', hostile));
    const refused = parseComponent('RegistryVersion', (await (await put(hostileReserved.upload.url, hostile)).json() as { version: unknown }).version);
    expect(refused).toMatchObject({ state: 'rejected', reason: 'archive.unexpected_executable' }); expect(stored()).toEqual([`quarantine/${versionId}.tar.zst`]);
    expect((await review.pending(10)).map(item => item.id)).toEqual([versionId]);

    // Review. An operator decides only on what a publisher submitted, with a name and a reason, and the record is permanent.
    expect(await fault(review.approve(decision(id())))).toBe('not_found'); expect(await fault(review.approve(decision(refused.id)))).toBe('conflict');
    expect(await fault(review.approve({ ...decision(versionId), operator: '' }))).toBe('validation'); expect(await fault(review.approve({ ...decision(versionId), reason: '' }))).toBe('validation');
    expect(await fault(review.revoke(decision(versionId)))).toBe('conflict');
    // Quarantined bytes that changed since submission are not signed.
    const quarantined = h.registryObjects.get(`quarantine/${versionId}.tar.zst`)!; h.registryObjects.set(`quarantine/${versionId}.tar.zst`, archive('1.2.0', [{ path: 'swapped.txt', bytes: new Uint8Array(1) }]));
    expect(await fault(review.approve(decision(versionId)))).toBe('conflict'); h.registryObjects.set(`quarantine/${versionId}.tar.zst`, quarantined);
    const approved = await review.approve(decision(versionId));
    expect(approved).toMatchObject({ state: 'published', yanked: false, reason: null }); expect(approved.publishedAt).not.toBeNull();
    expect(approved.signed!.statement).toEqual({ publisher: 'acme', name: 'clipboard', version: '1.2.0', target, sha256: digest(bytes), sizeBytes: bytes.length, manifestDigest: manifestDigest(manifest), publishedAt: approved.publishedAt! });
    expect(approved.signed!.keyId).toBe('registry-test');
    expect(stored()).toEqual([`packages/acme/clipboard/1.2.0/${target}.tar.zst`]);
    expect(await fault(review.approve(decision(versionId)))).toBe('conflict'); expect(await fault(review.reject(decision(versionId)))).toBe('conflict'); expect(await review.pending(10)).toEqual([]);
    // Provenance: who approved, why, and exactly what they approved.
    const records = await review.reviews(versionId);
    expect(records.map(record => [record.decision, record.operator, record.reason])).toEqual([['approved', 'reviewer@carbon.example', 'Reviewed source and archive']]);
    expect(records[0]!.evidence).toMatchObject({ sha256: digest(bytes), sizeBytes: bytes.length, keyId: 'registry-test', files: [{ path: 'README.md' }, { path: 'carbon-plugin.json' }, { path: 'clipboard.dll' }] });
    expect((await ok(A, { kind: 'version.get', versionId })).version).toEqual(approved);

    // Install: an anonymous client fetches the bundle, the listing and the bytes, and trusts none of it until it checks out against the root it pinned.
    const install = async (version: string, pinnedRoot = h.registryRoot, minimumSequence = 0) => {
      const trust = parseComponent('RegistryTrustBundle', await (await fetch(`${origin}/registry/v1/trust`)).json());
      const listing = parseComponent('RegistryPublicPackage', await (await fetch(`${origin}/registry/v1/packages/acme/clipboard`)).json());
      const entry = listing.versions.find(item => item.version === version && item.target === target)!;
      const download = await fetch(`${origin}/registry/v1/packages/acme/clipboard/${version}/${target}`);
      const body = download.status === 200 ? new Uint8Array(await download.arrayBuffer()) : new Uint8Array();
      try { return { status: download.status, statement: verifyRegistryPackage({ rootPublicKey: pinnedRoot, trust, minimumSequence, expected: { publisher: 'acme', name: 'clipboard', version, target }, version: entry, bytes: body }), entry }; }
      catch (error) { if (error instanceof RegistryTrustError) return { status: download.status, refused: error.category, entry }; throw error; }
    };
    const installed = await install('1.2.0'); expect(installed.status).toBe(200); expect(installed.statement).toEqual(approved.signed!.statement);
    // The same answers checked against any other root are worth nothing, and an installer that has seen a newer bundle refuses this one.
    expect((await install('1.2.0', publicKeyHex(randomBytes(32).toString('hex')))).refused).toBe('bundle_signature'); expect((await install('1.2.0', h.registryRoot, 2)).refused).toBe('bundle_rollback');
    // Stored bytes that no longer match the signed digest are never served.
    const publishedKey = `packages/acme/clipboard/1.2.0/${target}.tar.zst`; const original = h.registryObjects.get(publishedKey)!; const corrupted = new Uint8Array(original); corrupted[10]! ^= 1;
    h.registryObjects.set(publishedKey, corrupted); expect((await fetch(`${origin}/registry/v1/packages/acme/clipboard/1.2.0/${target}`)).status).toBe(503); h.registryObjects.set(publishedKey, original);
    for (const path of ['/registry/v1/packages/acme/missing', '/registry/v1/packages/nobody/clipboard', `/registry/v1/packages/acme/clipboard/9.9.9/${target}`, '/registry/v1/packages/acme/clipboard/1.2.0/sparc-sun-solaris', '/registry/v1/packages/Acme/clipboard']) expect((await fetch(origin + path)).status).toBe(404);
    expect((await fetch(`${origin}/registry/v1/packages/acme/clipboard`, { method: 'POST' })).status).toBe(404); expect((await fetch(`${origin}/registry/v1/trust?x=1`)).status).toBe(400);

    // Tenant isolation: the other organization can read, change or learn nothing about these versions through its own environment.
    for (const command of [{ kind: 'version.get', versionId }, { kind: 'versions.list', publisher: 'acme', name: 'clipboard' }, { kind: 'version.yank', commandId: id(), versionId, revision: approved.revision, yanked: true, reason: 'not yours' },
      { kind: 'version.withdraw', commandId: id(), versionId, revision: approved.revision }]) expect(await status(B, command)).toBe(404);
    expect((await ok(A, { kind: 'versions.list', publisher: 'acme', name: 'clipboard' })).versions.map((item: { version: string; state: string }) => [item.version, item.state]).sort()).toEqual([['1.2.0', 'published'], ['1.2.1', 'rejected']]);
    // A member who can only read metadata sees publishers and versions, and can claim, submit, yank or withdraw nothing.
    const viewerToken = opaqueToken('as'); const viewerCsrf = opaqueToken('csrf'); const viewerId = id();
    await h.cloud`INSERT INTO accounts (id, primary_email, name, verified_at, terms_version) VALUES (${viewerId}, 'viewer@example.test', 'Viewer', now(), 'fixture')`;
    await h.cloud`INSERT INTO account_sessions (id, account_id, token_hash, csrf_hash, security_revision, device_name, expires_at, fresh_until)
      VALUES (${id()}, ${viewerId}, ${tokenDigest(viewerToken)}, ${tokenDigest(viewerCsrf)}, 1, 'Fixture', now() + interval '8 hours', now() + interval '10 minutes')`;
    await h.cloud`INSERT INTO memberships (id, account_id, org_id, role, state, project_access) VALUES (${id()}, ${viewerId}, ${A.orgId}, 'Viewer', 'active', 'all')`;
    const viewer = { cookie: `__Host-carbon-session=${viewerToken}`, 'x-csrf-token': viewerCsrf };
    for (const command of [{ kind: 'publishers.list' }, { kind: 'version.get', versionId }]) expect(await status(A, command, viewer)).toBe(200);
    for (const command of [{ kind: 'publisher.claim', commandId: id(), slug: 'viewer-name' }, submission('3.0.0', archive('3.0.0')), { kind: 'version.yank', commandId: id(), versionId, revision: approved.revision, yanked: true, reason: 'no' }]) expect(await status(A, command, viewer)).toBe(403);
    expect(await status(B, { kind: 'publishers.list' }, viewer)).toBe(404);
    // A signed request cannot be replayed, moved to another command, or sent under a permission that does not fit the command.
    const binding = (await h.cloud`SELECT id FROM service_bindings WHERE environment_id = ${A.environmentId} AND owner = 'registry'`)[0].id as string;
    const signedRegistry = async (command: Record<string, unknown>, permission: string, path = registryRequestPath(A, binding, command.kind as string)) => {
      const body = canonicalRegistryRequest({ scope: A, bindingId: binding, command } as never); const requestId = id();
      const principal = { id: h.account, kind: 'account' as const, audience: 'dashboard' as const, credentialId: h.session, permissionRevision: (await h.cloud`SELECT permission_revision::text FROM accounts WHERE id = ${h.account}`)[0].permission_revision };
      const proof = await h.issuer.issue({ aud: 'carbon-registry', principal, scope: A, roles: ['Owner'], grants: [{ permission: permission as never, scope: A }], requestId, request: { method: 'POST', path, bodyDigest: bodyDigest(body) } });
      return () => fetch(origin + path, { method: 'POST', body, headers: { authorization: `Bearer ${proof}`, 'content-type': 'application/json', 'x-request-id': requestId, ...(command.commandId ? { 'idempotency-key': command.commandId as string } : {}) } });
    };
    const once = await signedRegistry({ kind: 'publishers.list' }, 'metadata.read'); expect((await once()).status).toBe(200); expect((await once()).status).toBe(401);
    expect((await (await signedRegistry({ kind: 'publisher.claim', commandId: id(), slug: 'sneaky' }, 'metadata.read'))()).status).toBe(401);
    expect((await (await signedRegistry({ kind: 'publishers.list' }, 'metadata.read', registryRequestPath(A, binding, 'publisher.claim')))()).status).toBe(400);
    expect((await h.registry`SELECT count(*)::integer AS n FROM registry_publishers`)[0].n).toBe(1);

    // Yanking is the publisher's: the version stays downloadable by exact version and is marked, and can be restored.
    expect(await status(A, { kind: 'version.yank', commandId: id(), versionId, revision: '99', yanked: true, reason: 'superseded' })).toBe(409);
    const yanked = (await ok(A, { kind: 'version.yank', commandId: id(), versionId, revision: approved.revision, yanked: true, reason: 'superseded by 1.2.1' })).version;
    expect(yanked).toMatchObject({ state: 'published', yanked: true, reason: 'superseded by 1.2.1' }); expect(yanked.signed).toEqual(approved.signed);
    expect(await status(A, { kind: 'version.yank', commandId: id(), versionId, revision: yanked.revision, yanked: true, reason: 'again' })).toBe(409);
    const afterYank = await install('1.2.0'); expect(afterYank.entry).toMatchObject({ yanked: true, state: 'published' }); expect(afterYank.statement).toEqual(approved.signed!.statement);
    const restored = (await ok(A, { kind: 'version.yank', commandId: id(), versionId, revision: yanked.revision, yanked: false, reason: 'yanked by mistake' })).version; expect(restored).toMatchObject({ yanked: false, reason: null });

    // A second version, so that revoking the first leaves something installable.
    const next = archive('1.2.1'); const nextReserved = await ok(A, submission('1.2.1', next)); expect((await put(nextReserved.upload.url, next)).status).toBe(200);
    const nextPublished = await review.approve(decision(nextReserved.version.id)); expect(nextPublished.state).toBe('published');

    // Withdrawing a submission before review closes it and removes its quarantined bytes.
    const draft = archive('1.3.0'); const draftReserved = await ok(A, submission('1.3.0', draft)); expect((await put(draftReserved.upload.url, draft)).status).toBe(200);
    expect(stored()).toContain(`quarantine/${draftReserved.version.id}.tar.zst`);
    const submitted = (await ok(A, { kind: 'version.get', versionId: draftReserved.version.id })).version;
    expect((await ok(A, { kind: 'version.withdraw', commandId: id(), versionId: submitted.id, revision: submitted.revision })).version).toMatchObject({ state: 'rejected', reason: 'withdrawn' });
    expect(stored()).not.toContain(`quarantine/${draftReserved.version.id}.tar.zst`); expect(await fault(review.approve(decision(submitted.id)))).toBe('conflict'); expect(await review.pending(10)).toEqual([]);
    expect(await status(A, { kind: 'version.withdraw', commandId: id(), versionId, revision: restored.revision })).toBe(409);

    // Limits, and a reservation nobody used.
    const [two, three] = [archive('2.0.0'), archive('2.0.1')]; const stale = await ok(A, submission('2.0.0', two)); const waiting = await ok(A, submission('2.0.1', three));
    expect(await status(A, submission('2.0.2', archive('2.0.2')))).toBe(429);
    await h.registry`UPDATE registry_versions SET upload_expires_at = now() - interval '1 second' WHERE id = ${stale.version.id}`;
    expect((await put(stale.upload.url, two)).status).toBe(404); expect(stored().filter(key => key.startsWith('quarantine/'))).toEqual([]);
    const again = await ok(A, submission('2.0.0', two)); expect(again.version.id).not.toBe(stale.version.id); expect((await ok(A, { kind: 'version.get', versionId: stale.version.id })).version).toMatchObject({ state: 'rejected', reason: 'upload.expired' });
    // An operator's rejection carries its reason back to the publisher and removes the quarantined bytes.
    expect((await put(waiting.upload.url, three)).status).toBe(200);
    expect(await review.reject(decision(waiting.version.id, 'Bundles an unlicensed dependency'))).toMatchObject({ state: 'rejected', reason: 'Bundles an unlicensed dependency' });
    expect((await ok(A, { kind: 'version.get', versionId: waiting.version.id })).version.reason).toBe('Bundles an unlicensed dependency'); expect(stored().filter(key => key.startsWith('quarantine/'))).toEqual([]);
    expect(await status(A, { kind: 'publisher.claim', commandId: id(), slug: 'acme-labs' })).toBe(200); expect(await status(A, { kind: 'publisher.claim', commandId: id(), slug: 'acme-three' })).toBe(429);

    // Authority is live at Registry: a principal that stops being current mid-request changes nothing.
    const before = (await h.registry`SELECT count(*)::integer AS n FROM registry_versions`)[0].n;
    h.interceptAuthority(async () => { await h.cloud`UPDATE accounts SET permission_revision = permission_revision + 1 WHERE id = ${h.account}`; });
    expect([401, 403]).toContain(await status(A, submission('4.0.0', archive('4.0.0')))); h.interceptAuthority();
    expect((await h.registry`SELECT count(*)::integer AS n FROM registry_versions`)[0].n).toBe(before);
    // Lost after the request was accepted and the work was done, but before it was committed: still nothing.
    let authorityChecks = 0; const commandsBefore = (await h.registry`SELECT count(*)::integer AS n FROM registry_commands`)[0].n;
    h.interceptAuthority(async call => { authorityChecks = call; if (call === 2) await h.cloud`UPDATE accounts SET permission_revision = permission_revision + 1 WHERE id = ${h.account}`; });
    expect(await status(A, submission('4.0.1', archive('4.0.1')))).toBe(403); h.interceptAuthority(); expect(authorityChecks).toBe(2);
    expect((await h.registry`SELECT count(*)::integer AS n FROM registry_versions`)[0].n).toBe(before); expect((await h.registry`SELECT count(*)::integer AS n FROM registry_commands`)[0].n).toBe(commandsBefore);

    // Security revocation: the version is no longer served to anyone, its number is never reused, and its history stays.
    const revoked = await review.revoke(decision(versionId, 'Credential exfiltration in clipboard.dll'));
    expect(revoked).toMatchObject({ state: 'revoked', yanked: false, reason: 'Credential exfiltration in clipboard.dll' }); expect(revoked.signed).toEqual(approved.signed);
    const afterRevoke = await install('1.2.0'); expect(afterRevoke.status).toBe(404); expect(afterRevoke.refused).toBe('revoked');
    expect(afterRevoke.entry).toMatchObject({ state: 'revoked', reason: 'Credential exfiltration in clipboard.dll', signed: approved.signed });
    // An installer that already holds the bytes learns the same thing from the listing alone.
    try { verifyRegistryPackage({ rootPublicKey: h.registryRoot, trust: parseComponent('RegistryTrustBundle', await (await fetch(`${origin}/registry/v1/trust`)).json()), expected: { publisher: 'acme', name: 'clipboard', version: '1.2.0', target }, version: afterRevoke.entry, bytes }); throw new Error('accepted'); }
    catch (error) { expect((error as RegistryTrustError).category).toBe('revoked'); }
    expect((await install('1.2.1')).statement).toEqual(nextPublished.signed!.statement);
    expect(await status(A, submission('1.2.0', bytes))).toBe(409); expect(await status(A, { kind: 'version.yank', commandId: id(), versionId, revision: revoked.revision, yanked: true, reason: 'too late' })).toBe(409);
    expect(await fault(review.revoke(decision(versionId)))).toBe('conflict');
    expect((await review.reviews(versionId)).map(record => record.decision)).toEqual(['approved', 'revoked']);
    expect(h.registryObjects.has(publishedKey)).toBe(true);

    // The database itself keeps a version's identity, a published statement and the review history as they were.
    expect(await rejected(h.registry`UPDATE registry_versions SET sha256 = ${'f'.repeat(64)} WHERE id = ${nextReserved.version.id}`)).toContain('A submitted version cannot be changed');
    expect(await rejected(h.registry`UPDATE registry_versions SET version = '9.9.9' WHERE id = ${nextReserved.version.id}`)).toContain('A submitted version cannot be changed');
    expect(await rejected(h.registry`UPDATE registry_versions SET signature = 'x' WHERE id = ${nextReserved.version.id}`)).toContain('A published version is immutable');
    expect(await rejected(h.registry`UPDATE registry_versions SET object_key = 'packages/elsewhere' WHERE id = ${nextReserved.version.id}`)).toContain('A published version is immutable');
    expect(await rejected(h.registry`UPDATE registry_versions SET state = 'submitted' WHERE id = ${nextReserved.version.id}`)).toContain('This version cannot move to that state');
    expect(await rejected(h.registry`UPDATE registry_versions SET state = 'published' WHERE id = ${versionId}`)).toContain('This version cannot move to that state');
    expect(await rejected(h.registry`UPDATE registry_versions SET reason = 'never mind' WHERE id = ${versionId}`)).toContain('A closed version cannot change');
    expect(await rejected(h.registry`DELETE FROM registry_versions WHERE id = ${refused.id}`)).toContain('A registry version is never deleted');
    expect(await rejected(h.registry`UPDATE registry_review_records SET reason = 'edited' WHERE version_id = ${versionId}`)).toContain('A review record is permanent');
    expect(await rejected(h.registry`DELETE FROM registry_review_records WHERE version_id = ${versionId}`)).toContain('A review record is permanent');

    // After a restart with the same trust material, everything published still installs.
    h.restart(); expect((await install('1.2.1')).statement).toEqual(nextPublished.signed!.statement);
    expect((await h.registry`SELECT action FROM registry_package_events WHERE version_id = ${versionId} ORDER BY sequence`).map((row: { action: string }) => row.action))
      .toEqual(['version.reserved', 'version.submitted', 'version.approved', 'version.yanked', 'version.restored', 'version.revoked']);
  }, 120000);

  test('an app user reads and writes only their own rows through a request-bound assertion, and loses access with their session', async () => {
    const h = await harness(); const created = await h.create('appdata', ['database']); expect(await h.worker.execute()).toBe(true);
    const scope = parseComponent('EnvironmentScope', created.scope);
    const bindingId = (await h.cloud`SELECT id FROM service_bindings WHERE environment_id = ${scope.environmentId} AND owner = 'database'`)[0].id;
    // The developer creates a table whose rows belong to the app user in the "owner" column.
    const tableId = crypto.randomUUID(); const definition = { name: 'notes', columns: [{ name: 'owner', type: 'uuid', nullable: false }, { name: 'body', type: 'text', nullable: false }],
      policies: { enabled: true, rules: [{ id: crypto.randomUUID(), name: 'Owner', kind: 'owner', ownerColumn: 'owner', operations: ['select', 'insert', 'update', 'delete'] }] } };
    const setup = await h.signedData({ scope, bindingId, command: { kind: 'table.create', commandId: crypto.randomUUID(), tableId, definition } }); expect((await fetch(setup.url, setup.init)).status).toBe(200);

    // A realm for the environment, and two end users who sign in with real magic links.
    const realmId = crypto.randomUUID(); const redirectUri = 'https://app.example.test/callback';
    await h.cloud`INSERT INTO realms (id, org_id, project_id, environment_id, signup_enabled, redirect_allowlist, created_by) VALUES (${realmId}, ${scope.orgId}, ${scope.projectId}, ${scope.environmentId}, true, ${`{"${redirectUri}"}`}::text[], ${h.account})`;
    const app = new AppAuthentication(new PostgresAppAuthRepository(h.cloud), h.protector, { rateLimitKey: randomBytes(32).toString('base64') }, undefined, undefined, h.issuer);
    const signIn = async (email: string) => {
      await app.challenge(realmId, { email, redirectUri }, '203.0.113.9', crypto.randomUUID());
      const job = (await h.cloud`SELECT o.id, o.protected_message FROM app_email_outbox o JOIN app_challenges c ON c.id = o.id WHERE c.email = ${email} ORDER BY o.created_at DESC LIMIT 1`)[0];
      const token = /#token=(am_[A-Za-z0-9_-]{43})/.exec(JSON.parse(await h.protector.open(job.protected_message, job.id)).text)![1]!;
      return app.signIn(realmId, { token }, crypto.randomUUID());
    };
    const alice = await signIn('alice@example.test'); const bob = await signIn('bob@example.test');
    const access = { mode: 'application' };
    const call = async (session: { token: string }, command: { kind: string; commandId?: string; [key: string]: unknown }, options: { permission?: string; tamper?: (body: string) => string; origin?: string } = {}) => {
      const request = parseComponent('DataRequest', { scope, bindingId, command }); const body = JSON.stringify(request); const requestId = crypto.randomUUID();
      const path = dataRequestPath(scope, bindingId, request.command.kind);
      const proof = await app.exchange(realmId, `Bearer ${session.token}`, { audience: 'carbon-database', scope, permission: (options.permission ?? dataPermission(request.command.kind)) as 'data.read',
        request: { method: 'POST', path, bodyDigest: bodyDigest(body) } }, requestId);
      const init = { method: 'POST', body: options.tamper ? options.tamper(body) : body, headers: { authorization: `Bearer ${proof.token}`, 'content-type': 'application/json', 'x-request-id': requestId,
        ...(command.commandId ? { 'idempotency-key': command.commandId } : {}) } };
      return { send: () => fetch((options.origin ?? h.databaseServer.url.origin) + path, init) };
    };
    const send = async (session: { token: string }, command: { kind: string; commandId?: string; [key: string]: unknown }) => (await call(session, command)).send();
    const rows = async (response: Response) => parseComponent('DataQueryResult', parseComponent('DataResponse', await response.json()).result).rows;

    // Each user writes and sees only rows they own.
    const insert = (owner: string, body: string) => ({ kind: 'row.insert', commandId: crypto.randomUUID(), tableId, revision: '1', access, values: { owner, body } });
    const written = await send(alice, insert(alice.user.id, 'alice-private-note')); expect(written.status).toBe(200);
    const receipt = parseComponent('DataCommandReceipt', parseComponent('DataResponse', await written.json()).result);
    expect((await send(bob, insert(bob.user.id, 'bob-private-note'))).status).toBe(200);
    expect((await send(alice, insert(bob.user.id, 'planted-for-bob'))).status).toBe(403);
    const query = { kind: 'rows.query', tableId, access, limit: 10 };
    expect((await rows(await send(alice, query))).map(row => row.values.body)).toEqual(['alice-private-note']);
    expect((await rows(await send(bob, query))).map(row => row.values.body)).toEqual(['bob-private-note']);
    const stolen = await send(bob, { kind: 'row.update', commandId: crypto.randomUUID(), tableId, access, rowId: receipt.rowId, revision: receipt.revision, values: { body: 'overwritten' } });
    expect(stolen.status).not.toBe(200); expect(await stolen.text()).not.toContain('alice-private-note');
    const removed = await send(bob, { kind: 'row.delete', commandId: crypto.randomUUID(), tableId, access, rowId: receipt.rowId, revision: receipt.revision }); expect(removed.status).not.toBe(200);
    expect((await rows(await send(alice, query))).map(row => row.values.body)).toEqual(['alice-private-note']);

    // An app user is never a developer: no schema or metadata, no policy preview as someone else, no permission beyond rows.
    expect((await (await call(alice, { kind: 'tables.list' }, { permission: 'data.read' })).send()).status).toBe(403);
    expect((await (await call(alice, { kind: 'table.get', tableId } as { kind: string }, { permission: 'data.read' })).send()).status).toBe(403);
    expect((await send(alice, { ...query, access: { mode: 'policy-preview', userId: bob.user.id } } as { kind: string })).status).toBe(403);
    await expect(app.exchange(realmId, `Bearer ${alice.token}`, { audience: 'carbon-database', scope, permission: 'resources.configure' as 'data.read',
      request: { method: 'POST', path: dataRequestPath(scope, bindingId, 'table.create'), bodyDigest: bodyDigest('{}') } }, crypto.randomUUID())).rejects.toThrow('Invalid platform AppAssertionExchange');
    const elsewhere = { ...scope, environmentId: crypto.randomUUID() };
    await expect(app.exchange(realmId, `Bearer ${alice.token}`, { audience: 'carbon-database', scope: elsewhere, permission: 'data.read',
      request: { method: 'POST', path: dataRequestPath(elsewhere, bindingId, 'rows.query'), bodyDigest: bodyDigest('{}') } }, crypto.randomUUID())).rejects.toThrow('outside this app');

    // The assertion is bound to one request: it cannot be replayed, altered, or presented to another service.
    const once = await call(alice, query); expect((await once.send()).status).toBe(200); expect((await once.send()).status).toBe(401);
    expect((await (await call(alice, query, { tamper: body => body.replace('"limit":10', '"limit":50') })).send()).status).toBe(401);
    expect((await (await call(alice, query, { origin: h.registryServer.url.origin })).send()).status).not.toBe(200);

    // Losing the session, the user or the realm's claims revision ends access, even for an assertion already issued.
    const outstanding = await call(bob, query); await app.signOut(realmId, `Bearer ${bob.token}`, crypto.randomUUID());
    expect((await outstanding.send()).status).toBe(401);
    await expect(app.exchange(realmId, `Bearer ${bob.token}`, { audience: 'carbon-database', scope, permission: 'data.read', request: { method: 'POST', path: dataRequestPath(scope, bindingId, 'rows.query'), bodyDigest: bodyDigest('{}') } }, crypto.randomUUID())).rejects.toThrow('invalid or expired');
    let pending = await call(alice, query); await h.cloud`UPDATE app_users SET state = 'suspended' WHERE id = ${alice.user.id}`; expect((await pending.send()).status).toBe(401);
    await h.cloud`UPDATE app_users SET state = 'active' WHERE id = ${alice.user.id}`; expect((await send(alice, query)).status).toBe(200);
    pending = await call(alice, query); await h.cloud`UPDATE realms SET claims_revision = claims_revision + 1 WHERE id = ${realmId}`; expect((await pending.send()).status).toBe(401);
    await expect(app.view(realmId, `Bearer ${alice.token}`)).rejects.toThrow('invalid or expired');
    // A developer session cannot pose as an app user: the application access mode needs a verified app assertion.
    const developer = await h.signedData({ scope, bindingId, command: query }); expect((await fetch(developer.url, developer.init)).status).toBe(403);
    expect(JSON.stringify(await h.database`SELECT * FROM canonical_data_commands`)).not.toContain('private-note');
  }, 30000);

  test('ensure, pause and resume provision real native resources and preserve cross-environment PostgreSQL privilege boundaries', async () => {
    const h = await harness(); const created = await h.create(); const scope = created.scope;
    const base = `/platform/v1/orgs/${scope.orgId}/projects/${scope.projectId}`; const envPath = `${base}/environments/${scope.environmentId}`;
    expect(await h.worker.execute()).toBe(true); expect(await h.worker.execute()).toBe(true);
    let details = parseComponent('CatalogEnvironmentDetails', await (await h.api(envPath)).json()); expect(details.environment.provisioning).toBe('ready');
    expect(await h.database`SELECT id FROM platform_environments`).toHaveLength(1); expect(await h.registry`SELECT id FROM registry_environment_namespaces`).toHaveLength(1);
    const p = parseComponent('CatalogProject', await (await h.api(base)).json());
    const second = parseComponent('CatalogReceipt', (await (await h.api(`${base}/environments`, { name: 'Other', kind: 'development', services: ['database'] }, p.revision)).json() as { receipt: unknown }).receipt);
    expect(await h.worker.execute()).toBe(true);
    const firstNames = databaseEnvironmentIdentifiers(scope.environmentId!); const secondNames = databaseEnvironmentIdentifiers(second.scope.environmentId!);
    await h.database.unsafe(`CREATE TABLE "${firstNames.schema}".records (id integer PRIMARY KEY, value text)`);
    await h.database.unsafe(`CREATE TABLE "${secondNames.schema}".records (id integer PRIMARY KEY, value text)`);
    const query = (statement: string) => h.database.begin(async tx => { await tx.unsafe(`SET LOCAL ROLE "${firstNames.role}"`); return tx.unsafe(statement); });
    await query(`INSERT INTO "${firstNames.schema}".records VALUES (1, 'own data')`);
    expect(await query(`SELECT value FROM "${firstNames.schema}".records`)).toHaveLength(1);
    const denied = async (statement: string) => { let failure: unknown; try { await query(statement); } catch (error) { failure = error; } expect((failure as { errno?: string }).errno).toBe('42501'); };
    await denied(`SELECT * FROM "${secondNames.schema}".records`); await denied(`CREATE TABLE "${firstNames.schema}".forbidden (id int)`);
    const role = (await h.database`SELECT rolsuper, rolcreatedb, rolcreaterole, rolcanlogin, rolbypassrls FROM pg_roles WHERE rolname = ${firstNames.role}`)[0];
    expect(Object.values(role).every(value => value === false)).toBe(true);
    details = parseComponent('CatalogEnvironmentDetails', await (await h.api(envPath)).json());
    expect((await h.api(envPath, { kind: 'pause', paused: true }, details.environment.revision)).status).toBe(202);
    expect(await h.worker.execute()).toBe(true); expect(await h.worker.execute()).toBe(true);
    await denied(`INSERT INTO "${firstNames.schema}".records VALUES (2, 'paused')`);
    expect(await query(`SELECT * FROM "${firstNames.schema}".records`)).toHaveLength(1);
    expect((await h.registry`SELECT state FROM registry_environment_namespaces`)[0].state).toBe('paused');
    h.restart(); details = parseComponent('CatalogEnvironmentDetails', await (await h.api(envPath)).json());
    expect((await h.api(envPath, { kind: 'pause', paused: false }, details.environment.revision)).status).toBe(202);
    expect(await h.worker.execute()).toBe(true); expect(await h.worker.execute()).toBe(true);
    await query(`INSERT INTO "${firstNames.schema}".records VALUES (2, 'resumed')`);
    expect(await query(`SELECT * FROM "${firstNames.schema}".records`)).toHaveLength(2);
    expect(parseComponent('CatalogEnvironmentDetails', await (await h.api(envPath)).json()).environment.state).toBe('active');
    expect((await h.registry`SELECT state FROM registry_environment_namespaces`)[0].state).toBe('active');
  }, 30000);

  test('receivers reject replay, wrong audience, tampered scope and stale leases while preserving durable idempotency after response loss', async () => {
    const h = await harness(); await h.create('replay', ['database']);
    const work = await h.repo.claim() as ProvisioningWork; const request = await h.signed(work);
    const first = await fetch(request.url, request.init); expect(first.status).toBe(200); const status = parseComponent('ServiceLifecycleStatus', await first.json());
    expect((await fetch(request.url, request.init)).status).toBe(401);
    expect((await fetch(request.url.replace(h.databaseServer.url.origin, h.registryServer.url.origin), request.init)).status).toBe(401);
    const tampered = { ...request.init, body: request.init.body.replace(work.scope.orgId, crypto.randomUUID()) };
    expect((await fetch(request.url, tampered)).status).toBe(401);
    h.restart(); await h.cloud`UPDATE operations SET lease_expires_at = now() - interval '1 second' WHERE id = ${work.operationId}`;
    const next = await h.repo.claim() as ProvisioningWork; expect(next.stepId).toBe(work.stepId); expect(next.leaseId).not.toBe(work.leaseId);
    const stale = await h.signed(work); expect((await fetch(stale.url, stale.init)).status).toBe(401);
    const retried = await h.databaseProvider.apply(next, new AbortController().signal); expect(retried.remoteResourceId).toBe(status.remoteResourceId);
    expect(await h.database`SELECT id FROM platform_environments`).toHaveLength(1); expect(await h.database`SELECT id FROM platform_security_events`).toHaveLength(1);
    expect(await h.repo.complete(work, { value: retried })).toBe(false); expect(await h.repo.complete(next, { value: retried })).toBe(true);
    const read = await h.databaseProvider.status(next, new AbortController().signal);
    expect(read.remoteResourceId).toBe(status.remoteResourceId); expect(read.state).toBe('active');
    await h.cloud`UPDATE accounts SET permission_revision = permission_revision + 1 WHERE id = ${h.account}`;
    let staleRead: unknown; try { await h.databaseProvider.status(next, new AbortController().signal); } catch (error) { staleRead = error; }
    expect(staleRead).toHaveProperty('code', 'unavailable');
    const ended = await h.signed(next); expect((await fetch(ended.url, ended.init)).status).toBe(401);
    const native = new PostgresServiceLifecycleRepository(h.database, new PostgresDatabaseEnvironmentDriver());
    let conflict: unknown;
    try { await native.execute({ scope: { ...parseComponent('EnvironmentScope', work.scope), orgId: crypto.randomUUID() }, bindingId: work.bindingId, operationId: work.operationId,
      stepId: crypto.randomUUID(), leaseId: crypto.randomUUID(), action: 'ensure', remoteResourceId: status.remoteResourceId }, work.principal, work.requestId, async () => true); } catch (error) { conflict = error; }
    expect(conflict).toHaveProperty('code', 'conflict');
  }, 30000);

  test('a live authority change before receiver commit rolls back native DDL and grants, then a reviewed retry succeeds', async () => {
    const h = await harness(); const created = await h.create('recheck', ['database']);
    h.interceptAuthority(async call => { if (call === 2) await h.cloud`UPDATE accounts SET permission_revision = permission_revision + 1 WHERE id = ${h.account}`; });
    expect(await h.worker.execute()).toBe(true);
    expect(await h.database`SELECT id FROM platform_environments`).toHaveLength(0);
    const names = databaseEnvironmentIdentifiers(created.scope.environmentId!);
    expect(await h.database`SELECT rolname FROM pg_roles WHERE rolname = ${names.role}`).toHaveLength(0);
    expect(await h.database`SELECT nspname FROM pg_namespace WHERE nspname = ${names.schema}`).toHaveLength(0);
    const envPath = `/platform/v1/orgs/${created.scope.orgId}/projects/${created.scope.projectId}/environments/${created.scope.environmentId}`;
    const opPath = `${envPath}/operations/${created.operationId}`;
    const operation = parseComponent('Operation', await (await h.api(opPath)).json()); expect(operation.state).toBe('failed');
    h.interceptAuthority(); expect((await h.api(opPath, { kind: 'retry' }, operation.revision)).status).toBe(202);
    expect(await h.worker.execute()).toBe(true);
    expect(parseComponent('CatalogEnvironmentDetails', await (await h.api(envPath)).json()).environment.provisioning).toBe('ready');
  }, 30000);
});

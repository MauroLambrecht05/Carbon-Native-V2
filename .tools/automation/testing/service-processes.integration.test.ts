// The three services as real processes: each `main.ts` and each `migrate`
// script is started the way a deployment starts it, against a database of its
// own, and spoken to over a real socket. Everything else in the test suite
// calls a composed handler in the test's own process; this is the check that
// the wiring around those handlers is what the documents say it is.

import { afterAll, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { createServer } from 'node:net';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ADMIN = process.env.CARBON_SERVICE_TEST_DATABASE_URL;
const ROOT = join(import.meta.dir, '../../..');
const SCRAPE = 'scrape-token-for-the-process-test-0123456789';
const describeProcesses = ADMIN && process.env.CARBON_OBJECT_STORE_TEST_ENDPOINT ? describe : describe.skip;

const freePort = () => new Promise<number>((resolve, reject) => {
  const probe = createServer(); probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => { const address = probe.address(); probe.close(() => typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port'))); });
});

interface Service { readonly name: string; readonly product: string; readonly migrations: number; readonly env: (port: number) => Record<string, string> }
// Registry writes its built-in packages to the bucket when it starts, so the processes are given the test object store.
const STORE = process.env.CARBON_OBJECT_STORE_TEST_ENDPOINT;
const objectStore = { OBJECT_STORE_ENDPOINT: STORE ?? 'http://127.0.0.1:9', OBJECT_STORE_ACCESS_KEY_ID: process.env.CARBON_OBJECT_STORE_TEST_ACCESS_KEY_ID ?? 'unused', OBJECT_STORE_SECRET_ACCESS_KEY: process.env.CARBON_OBJECT_STORE_TEST_SECRET_ACCESS_KEY ?? 'unused-secret', OBJECT_STORE_BUCKET: process.env.CARBON_OBJECT_STORE_TEST_BUCKET ?? 'unused' };
const count = (product: string) => readdirSync(join(ROOT, 'products', product, 'infrastructure/persistence/migrations')).filter(file => file.endsWith('.sql')).length;
const SERVICES: readonly Service[] = [
  { name: 'cloud', product: 'carbon-cloud', migrations: count('carbon-cloud'), env: port => ({ ...objectStore, OBJECT_STORE_PUBLIC_BASE_URL: 'http://127.0.0.1:9/unused', PORT: String(port) }) },
  { name: 'database', product: 'carbon-database', migrations: count('carbon-database'), env: port => ({ ...objectStore, CONTROL_PLANE_URL: 'http://127.0.0.1:9', PORT: String(port) }) },
  { name: 'registry', product: 'carbon-registry', migrations: count('carbon-registry'), env: port => ({ ...objectStore, CONTROL_PLANE_URL: 'http://127.0.0.1:9', PORT: String(port) }) },
];

describeProcesses('services as processes', () => {
  const admin = new SQL(ADMIN!, { max: 1 });
  const created: string[] = []; const running = new Set<ReturnType<typeof Bun.spawn>>();
  afterAll(async () => {
    for (const child of running) { child.kill(); await child.exited; }
    for (const name of created) await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.close();
  });

  const database = async (label: string) => {
    const name = `carbon_proc_${label}_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await admin.unsafe(`CREATE DATABASE ${name}`); created.push(name);
    const url = new URL(ADMIN!); url.pathname = `/${name}`; return url.toString();
  };
  // The child gets a small, explicit environment: nothing the developer's shell happens to hold decides what it does.
  const base = () => Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []));
  const run = async (service: Service, script: string, args: string[], env: Record<string, string>) => {
    const child = Bun.spawn([process.execPath, join('products', service.product, 'composition', script), ...args], { cwd: ROOT, env: { ...base(), ...env }, stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { code, stdout, stderr };
  };
  const start = (service: Service, env: Record<string, string>) => {
    const child = Bun.spawn([process.execPath, join('products', service.product, 'main.ts')], { cwd: ROOT, env: { ...base(), ...env }, stdout: 'pipe', stderr: 'pipe' });
    running.add(child); child.exited.then(() => running.delete(child));
    const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]).then(([out, error]) => out + error);
    return { child, output, stop: async () => { child.kill(); await child.exited; return output; } };
  };
  const answer = async (port: number, path: string, headers: Record<string, string> = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers, signal: AbortSignal.timeout(10_000) });
    const text = await response.text(); let body: unknown = text; try { body = JSON.parse(text); } catch { /* not JSON */ }
    return { status: response.status, body, text };
  };
  const listening = async (port: number, child: ReturnType<typeof Bun.spawn>) => {
    for (let attempt = 0; attempt < 240; attempt++) {
      if (child.exitCode !== null) return false;
      try { if ((await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1000) })).status === 200) return true; } catch { /* not yet */ }
      await Bun.sleep(250);
    }
    return false;
  };

  test('cloud: the account platform, provider events, the operator API and the console through the real server', async () => {
    const service = SERVICES[0]!; const url = await database('cloud_full'); const port = await freePort();
    const scratch = mkdtempSync(join(tmpdir(), 'carbon-proc-')); const consoleDirectory = join(scratch, 'console'); mkdirSync(join(consoleDirectory, 'assets'), { recursive: true }); mkdirSync(join(scratch, 'inbox'));
    writeFileSync(join(consoleDirectory, 'index.html'), '<!doctype html><title>console</title><div id="root"></div>'); writeFileSync(join(consoleDirectory, 'assets', 'app.js'), 'console.log(1)');
    const webhookSecret = `whsec_${randomBytes(24).toString('hex')}`; const previousSecret = `whsec_${randomBytes(24).toString('hex')}`;
    const env = {
      ...service.env(port), DATABASE_URL: url, CARBON_METRICS_TOKEN: SCRAPE, NODE_ENV: 'development',
      CARBON_ACCOUNT_AUTH: 'enabled', CARBON_ACCOUNT_EMAIL_PROVIDER: 'development-inbox', CARBON_ACCOUNT_INBOX_DIRECTORY: join(scratch, 'inbox'),
      CARBON_ACCOUNT_ENCRYPTION_KEYS: JSON.stringify({ k1: randomBytes(32).toString('base64') }), CARBON_ACCOUNT_ACTIVE_KEY_ID: 'k1', CARBON_ACCOUNT_RATE_KEY: randomBytes(32).toString('base64'),
      CARBON_TERMS_VERSION: '2026-10', CARBON_PUBLIC_ORIGIN: `http://127.0.0.1:${port}`, CARBON_CONSOLE_DIR: consoleDirectory, CARBON_OPERATORS: 'enabled',
      // The provider key is never used here: no checkout is started. It only has to be present for billing to be on.
      CARBON_BILLING: 'enabled', STRIPE_SECRET_KEY: ['sk', 'test', 'processtest'].join('_'), STRIPE_PRICE_ID_PRO: 'price_process_test', STRIPE_WEBHOOK_SECRET: webhookSecret, STRIPE_WEBHOOK_SECRET_PREVIOUS: previousSecret,
    };
    const live = start(service, env);
    try {
      expect([await listening(port, live.child), live.child.exitCode === null ? '' : await live.output]).toEqual([true, '']);
      const origin = `http://127.0.0.1:${port}`;
      const send = async (path: string, init: RequestInit = {}) => { const response = await fetch(`${origin}${path}`, { ...init, signal: AbortSignal.timeout(10_000) }); const text = await response.text(); let body: any = text; try { body = JSON.parse(text); } catch { /* not JSON */ } return { status: response.status, body, headers: response.headers }; };

      // The account API is reachable and tells an anonymous caller there is no session.
      expect(await send('/platform/v1/account/session')).toMatchObject({ status: 200, body: { session: null } });

      // Provider events: only the exact path, only with a signature made with a current or previous secret.
      const event = { id: 'evt_process_1', type: 'customer.subscription.updated', created: Math.floor(Date.now() / 1000) - 5, data: { object: { id: 'sub_unknown', customer: 'cus_unknown', status: 'active', items: { data: [] } } } };
      const deliver = (secret: string, body = JSON.stringify(event)) => { const at = Math.floor(Date.now() / 1000); return send('/billing/v1/webhooks/stripe', { method: 'POST', body, headers: { 'content-type': 'application/json', 'stripe-signature': `t=${at},v1=${createHmac('sha256', secret).update(`${at}.${body}`).digest('hex')}` } }); };
      expect((await deliver(`whsec_${randomBytes(24).toString('hex')}`)).status).toBe(401);
      expect((await send('/billing/v1/webhooks/other', { method: 'POST', body: '{}' })).status).toBe(404);
      const accepted = await deliver(webhookSecret); expect(accepted.status).toBe(200);
      // During a rotation the previous secret still works, and a redelivery is not applied twice.
      expect((await deliver(previousSecret)).status).toBe(200);
      const inspect = new SQL(url, { max: 1 });
      try { expect(Number((await inspect`SELECT count(*)::int AS events FROM billing_webhook_events`)[0].events)).toBe(1); } finally { await inspect.close(); }

      // The operator API: no browser, no anonymous caller, and a credential made by the administration tool as its own process.
      const organization = crypto.randomUUID();
      expect((await send(`/operator/v1/orgs/${organization}`)).status).toBe(401);
      expect((await send(`/operator/v1/orgs/${organization}`, { headers: { origin } })).status).toBe(403);
      const made = await run(service, 'operator-admin.ts', ['create', 'operator@example.test', 'Process Operator', 'support'], { DATABASE_URL: url });
      expect([made.code, made.stderr]).toEqual([0, '']); const operatorId = JSON.parse(made.stdout).operatorId as string;
      const issued = await run(service, 'operator-admin.ts', ['credential', operatorId, '1'], { DATABASE_URL: url });
      expect(issued.code).toBe(0); const credential = JSON.parse(issued.stdout).credential as string; expect(credential.startsWith('op_')).toBe(true);
      // Authenticated, it gets the API's own answer about an organization that does not exist.
      expect(await send(`/operator/v1/orgs/${organization}`, { headers: { authorization: `Bearer ${credential}` } })).toMatchObject({ status: 404, body: { error: { code: 'not_found' } } });
      expect((await run(service, 'operator-admin.ts', ['disable', operatorId], { DATABASE_URL: url })).code).toBe(0);
      expect((await send(`/operator/v1/orgs/${organization}`, { headers: { authorization: `Bearer ${credential}` } })).status).toBe(401);
      expect((await run(service, 'operator-admin.ts', ['nonsense'], { DATABASE_URL: url })).code).toBe(2);

      // The console: its page at the root and at a client route, its assets, and never a file outside its directory.
      const page = await send('/'); expect(page.status).toBe(200); expect(page.body).toContain('<title>console</title>'); expect(page.headers.get('content-security-policy')).toContain("default-src 'self'");
      expect((await send('/orgs/acme/projects')).body).toContain('<title>console</title>');
      expect((await send('/assets/app.js')).body).toBe('console.log(1)');
      expect((await send('/assets/..%2f..%2finbox')).body).not.toContain('inbox');

      // The provider event nobody could place is on the metrics page, and the credential and secrets are in no log line.
      const metrics = await send('/metrics', { headers: { authorization: `Bearer ${SCRAPE}` } });
      expect(metrics.body).toContain('carbon_billing_events_unmatched 1');
      expect(metrics.body).toContain('route="/operator/v1/orgs/:id"');
      const log = await live.stop();
      for (const secret of [credential, webhookSecret, previousSecret, SCRAPE, organization]) expect(log).not.toContain(secret);
    } finally { await live.stop(); rmSync(scratch, { recursive: true, force: true }); }
  }, 240_000);

  for (const service of SERVICES) {
    test(`${service.name}: migrations are a release step, and the process says so`, async () => {
      const url = await database(service.name); const port = await freePort();
      const env = { ...service.env(port), DATABASE_URL: url, CARBON_METRICS_TOKEN: SCRAPE };

      // An empty database: everything is pending, the report says so, exits non-zero, and creates nothing.
      const empty = await run(service, 'migrate.ts', ['status'], env);
      expect(empty.code).toBe(1); expect(JSON.parse(empty.stdout)).toMatchObject({ applied: [], drift: null, ahead: [], current: false });
      expect(JSON.parse(empty.stdout).pending).toHaveLength(service.migrations);
      const inspect = new SQL(url, { max: 1 });
      try {
        expect(Number((await inspect`SELECT count(*)::int AS tables FROM information_schema.tables WHERE table_schema = 'public'`)[0].tables)).toBe(0);

        // Told not to migrate, the service refuses to start on a schema it cannot serve, and says what it found.
        const refused = start(service, { ...env, CARBON_MIGRATE_ON_START: 'disabled' });
        expect(await refused.child.exited).not.toBe(0);
        expect(await refused.output).toContain(`${service.migrations} migration(s) are pending`);
        expect(Number((await inspect`SELECT count(*)::int AS tables FROM information_schema.tables WHERE table_schema = 'public'`)[0].tables)).toBe(0);
        // A setting that is not one of the two words is an error, not a silent default.
        const typo = start(service, { ...env, CARBON_MIGRATE_ON_START: 'off' });
        expect(await typo.child.exited).not.toBe(0); expect(await typo.output).toContain('CARBON_MIGRATE_ON_START must be enabled or disabled');

        // The release step applies them, and a second run changes nothing.
        const applied = await run(service, 'migrate.ts', [], env); expect([applied.code, applied.stderr]).toEqual([0, '']);
        const ledger = async () => JSON.stringify(await inspect.unsafe(`SELECT version, checksum, applied_at FROM ${service.name}_schema_migrations ORDER BY version`));
        const first = await ledger(); expect(JSON.parse(first)).toHaveLength(service.migrations);
        expect((await run(service, 'migrate.ts', [], env)).code).toBe(0); expect(await ledger()).toBe(first);
        const current = await run(service, 'migrate.ts', ['status'], env);
        expect(current.code).toBe(0); expect(JSON.parse(current.stdout)).toMatchObject({ pending: [], drift: null, ahead: [], current: true });

        // Now it starts without migrating, and answers the three operational endpoints through its real server.
        const live = start(service, { ...env, CARBON_MIGRATE_ON_START: 'disabled' });
        try {
          expect([await listening(port, live.child), live.child.exitCode === null ? '' : await live.output]).toEqual([true, '']);
          expect(await ledger()).toBe(first);
          expect(await answer(port, '/healthz')).toMatchObject({ status: 200, text: 'ok' });
          expect(await answer(port, '/readyz')).toMatchObject({ status: 200, body: { ready: true, checks: { database: 'ok', migrations: 'ok' } } });
          expect((await answer(port, '/metrics')).status).toBe(404);
          expect((await answer(port, '/metrics', { authorization: 'Bearer wrong-token-of-the-right-length-000000000' })).status).toBe(404);
          const metrics = await answer(port, '/metrics', { authorization: `Bearer ${SCRAPE}` });
          expect(metrics.status).toBe(200); expect(metrics.text).toContain(`route="/healthz",service="carbon-${service.name}",status="200"`);
          expect(metrics.text).toContain('route="/readyz"');

          // A newer release's migration appears while this version runs: it stops being ready, and stays alive.
          await inspect.unsafe(`INSERT INTO ${service.name}_schema_migrations (version, checksum) VALUES ('9999_from_a_newer_release.sql', $1)`, ['a'.repeat(64)]);
          expect(await answer(port, '/readyz')).toMatchObject({ status: 503, body: { ready: false, checks: { database: 'ok', migrations: 'failed' } } });
          expect((await answer(port, '/healthz')).status).toBe(200);
        } finally { await live.stop(); }
        const log = await live.output;
        // One structured line per request, with the route and never the token that was presented.
        const lines = log.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line)).filter(line => line.event === 'http.request');
        expect(lines.some(line => line.route === '/metrics' && line.status === 200 && line.service === `carbon-${service.name}`)).toBe(true);
        expect(log).not.toContain(SCRAPE);

        // Rolling back: the older version starts against the newer schema only when told it may, and never migrates then.
        const ahead = start(service, { ...env, CARBON_MIGRATE_ON_START: 'disabled' });
        expect(await ahead.child.exited).not.toBe(0); expect(await ahead.output).toContain('it is ahead by 1 migration(s)');
        const both = start(service, { ...env, CARBON_NEWER_SCHEMA: 'allowed' });
        expect(await both.child.exited).not.toBe(0); expect(await both.output).toContain('CARBON_NEWER_SCHEMA=allowed requires CARBON_MIGRATE_ON_START=disabled');
        const rollback = start(service, { ...env, CARBON_MIGRATE_ON_START: 'disabled', CARBON_NEWER_SCHEMA: 'allowed' });
        try {
          expect(await listening(port, rollback.child)).toBe(true);
          expect((await answer(port, '/readyz')).status).toBe(200);
        } finally { await rollback.stop(); }
      } finally { await inspect.close(); }
    }, 240_000);
  }
});

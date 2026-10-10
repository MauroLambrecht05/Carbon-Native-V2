import { afterEach, describe, expect, test } from 'bun:test';
import { migrate } from '../infrastructure/persistence/Database.ts';
import { RlsPolicyEngine, InvalidRlsPolicyError } from '../infrastructure/services/RlsPolicyEngine.ts';
import { DatabaseEngine } from '../infrastructure/services/DatabaseEngine.ts';
import { RealtimeEngine } from '../infrastructure/services/RealtimeEngine.ts';
import { buildDatabaseRoutes, type DatabaseRouteDeps } from '../infrastructure/http/routes.ts';
import type { VerifiedToken } from '@carbon/identity';

const testUrl = process.env.CARBON_SERVICE_TEST_DATABASE_URL;
const suite = testUrl ? describe : describe.skip;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) { await cleanups.at(-1)!(); cleanups.pop(); } }, 30000);
const owner = { orgId: 'org-a', role: 'authenticated' };
const foreign = { orgId: 'org-b', role: 'authenticated' };
const anonymous = { orgId: 'anon', role: 'anon' };
async function rejection(work: Promise<unknown>) { try { await work; } catch (error) { return error; } throw new Error('Expected rejection'); }

async function harness() {
  const config = new URL(testUrl!); if (config.pathname !== '/carbon_service_test') throw new Error('Requires dedicated carbon_service_test database');
  const admin = new Bun.SQL(config.href, { max: 1 });
  const name = `carbon_service_test_${crypto.randomUUID().replaceAll('-', '')}_rls`;
  await admin.unsafe(`CREATE DATABASE "${name}"`); config.pathname = '/' + name;
  const sql = new Bun.SQL(config.href, { max: 5 });
  cleanups.push(async () => { await sql.close(); if (!/^carbon_service_test_[a-f0-9]{32}_rls$/.test(name)) throw new Error('Unsafe cleanup'); await admin.unsafe(`DROP DATABASE "${name}"`); await admin.close(); });
  await migrate(sql);
  await sql`INSERT INTO projects (id, org_id, name) VALUES ('one', 'org-a', 'One'), ('two', 'org-b', 'Two')`;
  const rls = new RlsPolicyEngine(sql); const realtime = new RealtimeEngine(); const events: string[] = [];
  const socket = { id: 'test', send: (value: string) => { if (JSON.parse(value).type === 'broadcast') events.push(value); } };
  realtime.handleConnect(socket); realtime.subscribe(socket, '*');
  const engine = new DatabaseEngine(sql, realtime, rls);
  for (const project of ['one', 'two']) await engine.createTable(project, 'notes', [
    { name: 'id', type: 'string', primaryKey: true }, { name: 'orgId', type: 'string' },
    { name: 'is_public', type: 'boolean' }, { name: 'body', type: 'string' },
  ]);
  return { sql, rls, realtime, events, engine };
}

suite('legacy Database policy safety on real PostgreSQL', () => {
  test('unsupported policies never persist or grant; disabled/default/unknown stored policies deny public access across instances', async () => {
    const h = await harness();
    await h.engine.insertRow('one', 'notes', { id: 'a', orgId: 'org-a', is_public: true });
    expect((await h.engine.queryRows('one', 'notes', {}, anonymous)).rows).toHaveLength(0);
    expect(await rejection(h.rls.addPolicy('one', 'notes', { id: 'bad', name: 'Bad', action: 'ALL', ruleExpression: 'unsupported()' }))).toBeInstanceOf(InvalidRlsPolicyError);
    expect(await h.sql`SELECT id FROM rls_policies`).toHaveLength(0);
    await h.rls.setRlsEnabled('one', 'notes', true);
    expect((await h.engine.queryRows('one', 'notes', {}, owner)).rows).toHaveLength(0);
    const second = new RlsPolicyEngine(h.sql);
    await second.addPolicy('one', 'notes', { id: 'public', name: 'Public', action: 'SELECT', ruleExpression: 'record.is_public == true' });
    expect((await h.engine.queryRows('one', 'notes', {}, anonymous)).rows).toHaveLength(1);
    expect(await second.removePolicy('two', 'notes', 'public')).toBe(false);
    await h.sql`INSERT INTO rls_policies (id, project_id, table_name, name, action, rule_expression) VALUES ('old', 'one', 'notes', 'Old unsupported', 'ALL', NULL)`;
    expect((await h.engine.queryRows('one', 'notes', {}, anonymous)).rows).toHaveLength(0);
    expect(await second.removePolicy('one', 'notes', 'old')).toBe(true);
    expect((await h.engine.queryRows('one', 'notes', {}, anonymous)).rows).toHaveLength(1);
    expect(await second.removePolicy('one', 'notes', 'public')).toBe(true);
    expect((await h.engine.queryRows('one', 'notes', {}, anonymous)).rows).toHaveLength(0);
  });

  test('old and actual proposed rows are checked atomically; failed writes emit no realtime events', async () => {
    const h = await harness();
    await h.rls.setRlsEnabled('one', 'notes', true);
    await h.rls.addPolicy('one', 'notes', { id: 'owned', name: 'Owned', action: 'ALL', ruleExpression: 'auth.orgId == record.orgId' });
    await h.engine.insertRow('one', 'notes', { id: 'a', orgId: 'org-a', body: 'original' }, owner);
    await h.engine.insertRow('one', 'notes', { id: 'b', orgId: 'org-b', body: 'foreign' });
    h.events.length = 0;
    expect((await h.engine.queryRows('one', 'notes', {}, owner)).rows.map(row => row.id)).toEqual(['a']);
    expect((await h.engine.queryRows('one', 'notes', {}, foreign)).rows.map(row => row.id)).toEqual(['b']);
    expect(await h.engine.updateRows('one', 'notes', { id: 'b' }, { body: 'attack' }, owner)).toBe(0);
    expect(await rejection(h.engine.updateRows('one', 'notes', { id: 'a' }, { orgId: 'org-b' }, owner))).toBeInstanceOf(Error);
    expect(await rejection(h.engine.insertRow('one', 'notes', { id: 'c', orgId: 'org-b' }, owner))).toBeInstanceOf(Error);
    expect(h.events).toHaveLength(0);
    expect((await h.engine.queryRows('one', 'notes', {}, owner)).rows[0]!.orgId).toBe('org-a');
    // A real trigger changes a proposed row: checking only the submitted patch is insufficient.
    await h.sql.unsafe(`CREATE FUNCTION public.test_change_owner() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.body = 'trigger' THEN NEW."orgId" := 'org-b'; END IF; RETURN NEW; END $$`);
    await h.sql.unsafe(`CREATE TRIGGER change_owner BEFORE INSERT OR UPDATE ON proj_one.notes FOR EACH ROW EXECUTE FUNCTION public.test_change_owner()`);
    expect(await rejection(h.engine.updateRows('one', 'notes', { id: 'a' }, { body: 'trigger' }, owner))).toBeInstanceOf(Error);
    expect(await rejection(h.engine.insertRow('one', 'notes', { id: 'd', orgId: 'org-a', body: 'trigger' }, owner))).toBeInstanceOf(Error);
    expect(h.events).toHaveLength(0);
    expect(await h.engine.updateRows('one', 'notes', { id: 'a' }, { body: 'changed' }, owner)).toBe(1);
    expect(h.events).toHaveLength(1);
    expect(await h.engine.deleteRows('one', 'notes', { id: 'b' }, owner)).toBe(0);
    expect(await h.engine.deleteRows('one', 'notes', { id: 'a' }, owner)).toBe(1);
    expect(h.events).toHaveLength(2);
  });

  test('bulk inserts and multi-row updates roll back every row on a later policy failure', async () => {
    const h = await harness();
    await h.rls.setRlsEnabled('one', 'notes', true);
    await h.rls.addPolicy('one', 'notes', { id: 'owned', name: 'Owned', action: 'ALL', ruleExpression: 'auth.orgId == record.orgId' });
    expect(await rejection(h.engine.insertRows('one', 'notes', [{ id: 'a', orgId: 'org-a' }, { id: 'b', orgId: 'org-b' }], owner))).toBeInstanceOf(Error);
    expect((await h.engine.queryRows('one', 'notes')).rows).toHaveLength(0);
    expect(h.events).toHaveLength(0);
    await h.engine.insertRows('one', 'notes', [{ id: 'a', orgId: 'org-a', body: 'original' }, { id: 'z', orgId: 'org-a', body: 'original' }], owner);
    h.events.length = 0;
    await h.sql.unsafe(`CREATE FUNCTION public.test_later_owner() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = 'z' THEN NEW."orgId" := 'org-b'; END IF; RETURN NEW; END $$`);
    await h.sql.unsafe(`CREATE TRIGGER later_owner BEFORE UPDATE ON proj_one.notes FOR EACH ROW EXECUTE FUNCTION public.test_later_owner()`);
    expect(await rejection(h.engine.updateRows('one', 'notes', {}, { body: 'changed' }, owner))).toBeInstanceOf(Error);
    expect((await h.engine.queryRows('one', 'notes')).rows.map(row => row.body)).toEqual(['original', 'original']);
    expect(h.events).toHaveLength(0);
  });

  test('table replacement cannot inherit old public policies and failed drops preserve policy state', async () => {
    const h = await harness();
    await h.rls.setRlsEnabled('one', 'notes', true);
    await h.rls.addPolicy('one', 'notes', { id: 'public', name: 'Public', action: 'SELECT', ruleExpression: 'true' });
    await h.engine.insertRow('one', 'notes', { id: 'old', orgId: 'org-a' });
    await h.sql.unsafe('CREATE VIEW public.keep_notes AS SELECT id FROM proj_one.notes');
    expect(await rejection(h.engine.dropTable('one', 'notes'))).toBeInstanceOf(Error);
    expect((await h.engine.queryRows('one', 'notes', {}, anonymous)).rows).toHaveLength(1);
    expect(await h.rls.isRlsEnabled('one', 'notes')).toBe(true);
    await h.sql.unsafe('DROP VIEW public.keep_notes');
    expect(await h.engine.dropTable('one', 'notes')).toBe(true);
    await h.engine.createTable('one', 'notes', [{ name: 'id', type: 'string', primaryKey: true }]);
    await h.engine.insertRow('one', 'notes', { id: 'new' });
    expect(await h.rls.listPolicies('one', 'notes')).toHaveLength(0);
    expect(await h.rls.isRlsEnabled('one', 'notes')).toBe(false);
    expect((await h.engine.queryRows('one', 'notes', {}, anonymous)).rows).toHaveLength(0);
  });

  test('policy changes serialize after a row transaction and are visible to an existing second instance', async () => {
    const h = await harness();
    await h.rls.setRlsEnabled('one', 'notes', true);
    await h.rls.addPolicy('one', 'notes', { id: 'p', name: 'Public', action: 'SELECT', ruleExpression: 'true' });
    let release!: () => void; let locked!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { locked = resolve; });
    const holding = h.sql.begin(async tx => { await h.rls.snapshot(tx, 'one', 'notes'); locked(); await barrier; });
    await ready;
    const second = new RlsPolicyEngine(h.sql);
    let removed = false; const removing = second.removePolicy('one', 'notes', 'p').then(result => { removed = result; });
    try {
      let waiting = false;
      for (let attempt = 0; attempt < 200; attempt++) {
        const locks = await h.sql`SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND classid = 1128354373 AND NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`;
        if (locks.length) { waiting = true; break; }
        await Bun.sleep(10);
      }
      expect(waiting).toBe(true); expect(removed).toBe(false);
    } finally { release(); await holding; await removing; }
    expect(removed).toBe(true); expect((await h.rls.listPolicies('one', 'notes'))).toHaveLength(0);
  });

  test('all legacy project routes reject foreign scope before touching an engine; invalid tokens do not become anonymous', async () => {
    const h = await harness();
    const token: VerifiedToken = { orgId: 'org-a', scope: 'org' };
    const handler = buildDatabaseRoutes({ sql: h.sql, controlPlaneUrl: 'http://localhost', verifyToken: { execute: async value => value === 'good' ? token : value === 'worker' ? { ...token, scope: 'worker' } : null }, databaseEngine: h.engine, rlsEngine: h.rls } as DatabaseRouteDeps);
    for (const tail of ['tables', 'tables/notes/rows', 'tables/notes/rls', 'tables/notes/policies', 'sql', 'export', 'import', 'migrations', 'vectors', 'graph/nodes', 'functions', 'storage', 'billing']) {
      const response = await handler(new Request(`http://localhost/api/projects/two/${tail}`, { headers: { authorization: 'Bearer good' } }));
      expect(response.status).toBe(404); expect(await response.json()).toEqual({ error: 'Project not found' });
    }
    const foreignRead = await handler(new Request('http://localhost/rest/v1/notes?projectId=two', { headers: { authorization: 'Bearer good' } }));
    expect(foreignRead.status).toBe(404);
    await h.rls.setRlsEnabled('one', 'notes', true); await h.rls.addPolicy('one', 'notes', { id: 'p', name: 'Public', action: 'SELECT', ruleExpression: 'true' });
    await h.engine.insertRow('one', 'notes', { id: 'a', orgId: 'org-a' });
    const invalid = await handler(new Request('http://localhost/rest/v1/notes?projectId=one', { headers: { authorization: 'Bearer invalid' } }));
    expect(invalid.status).not.toBe(200);
    expect((await handler(new Request('http://localhost/api/projects/one/tables', { headers: { authorization: 'Bearer worker' } }))).status).toBe(401);
    for (const method of ['PATCH', 'DELETE']) {
      const response = await handler(new Request('http://localhost/rest/v1/notes?projectId=one&id=gt.a', { method, headers: { authorization: 'Bearer good', 'content-type': 'application/json' }, ...(method === 'PATCH' ? { body: JSON.stringify({ body: 'changed' }) } : {}) }));
      expect(response.status).toBe(400);
    }
    const publicRead = await handler(new Request('http://localhost/rest/v1/notes?projectId=one'));
    expect(publicRead.status).toBe(200);
  });
});

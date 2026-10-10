import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate as migrateDatabase } from '../../../products/carbon-database/infrastructure/persistence/Database.ts';
import { migrate as migrateRegistry } from '../../../products/carbon-registry/infrastructure/persistence/Database.ts';

const url = process.env.CARBON_SERVICE_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) { await cleanups.at(-1)!(); cleanups.pop(); } }, 30000);

suite('owning-service migration ledgers', () => {
  for (const owner of ['database', 'registry'] as const) test(`${owner} adopts legacy records once, serializes deployers and rejects drift and partial migrations`, async () => {
    const config = new URL(url!); if (config.pathname !== '/carbon_service_test') throw new Error('Requires dedicated carbon_service_test database');
    const admin = new Bun.SQL(config.href, { max: 1 }); const name = `carbon_service_test_${crypto.randomUUID().replaceAll('-', '')}_${owner}`;
    await admin.unsafe(`CREATE DATABASE "${name}"`); config.pathname = '/' + name;
    const sql = new Bun.SQL(config.href, { max: 3 }); const fixture = mkdtempSync(join(tmpdir(), 'carbon-service-migrations-'));
    cleanups.push(async () => {
      await sql.close(); if (!/^carbon_service_test_[a-f0-9]{32}_(database|registry)$/.test(name)) throw new Error('Unsafe test database cleanup');
      await admin.unsafe(`DROP DATABASE "${name}"`); await admin.close();
      const resolved = realpathSync(fixture);
      if (dirname(resolved).toLowerCase() !== realpathSync(tmpdir()).toLowerCase() || !/^carbon-service-migrations-[A-Za-z0-9]+$/.test(basename(resolved))) throw new Error('Unsafe migration fixture cleanup');
      rmSync(resolved, { recursive: true });
    });
    const source = fileURLToPath(new URL(`../../../products/carbon-${owner}/infrastructure/persistence/migrations/`, import.meta.url));
    const files = readdirSync(source).filter(file => file.endsWith('.sql')).sort();
    for (const file of files) { const bytes = readFileSync(join(source, file)); writeFileSync(join(fixture, file), bytes); if (Number(file.slice(0, 4)) <= (owner === 'database' ? 1 : 2)) await sql.unsafe(bytes.toString()); }
    if (owner === 'database') await sql`INSERT INTO projects (id, org_id, name) VALUES ('legacy-project', 'legacy-org', 'Preserved')`;
    else await sql`INSERT INTO plugins (name, category, description, author_org_id, author_name, latest_version) VALUES ('preserved', 'test', 'Legacy', 'legacy-org', 'Author', '1.0.0')`;
    const migrate = owner === 'database' ? migrateDatabase : migrateRegistry;
    await Promise.all([migrate(sql, fixture), migrate(sql, fixture), migrate(sql, fixture)]);
    expect(await sql.unsafe(`SELECT version FROM ${owner}_schema_migrations`)).toHaveLength(files.length);
    expect(await sql`SELECT id FROM platform_environments`).toHaveLength(0);
    expect(owner === 'database' ? (await sql`SELECT name FROM projects WHERE id = 'legacy-project'`)[0].name : (await sql`SELECT name FROM plugins WHERE name = 'preserved'`)[0].name).toBe(owner === 'database' ? 'Preserved' : 'preserved');
    const rejected = async (message?: string) => { let failure: unknown; try { await migrate(sql, fixture); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(Error); if (message) expect(String(failure)).toContain(message); };
    const first = files[0]!; writeFileSync(join(fixture, first), readFileSync(join(source, first), 'utf8') + '\n-- changed history\n');
    await rejected('history drift'); writeFileSync(join(fixture, first), readFileSync(join(source, first)));
    writeFileSync(join(fixture, '0099_atomic_failure.sql'), 'CREATE TABLE should_rollback (id int); SELECT 1 / 0;');
    await rejected(); expect((await sql`SELECT to_regclass('public.should_rollback') AS name`)[0].name).toBeNull();
    expect(await sql.unsafe(`SELECT version FROM ${owner}_schema_migrations`)).toHaveLength(files.length);
    writeFileSync(join(fixture, '0099_atomic_failure.sql'), 'CREATE TABLE should_rollback (id int);');
    await migrate(sql, fixture); expect((await sql`SELECT to_regclass('public.should_rollback') AS name`)[0].name).toBe('should_rollback');
  }, 30000);
});

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "../../infrastructure/persistence/Database.ts";
import { PostgresAssertionSecurityStore } from "@carbon/identity";

const url = process.env.CARBON_PLATFORM_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
const migrationsDir = fileURLToPath(new URL("../../infrastructure/persistence/migrations/", import.meta.url));
const databases: string[] = [];
const tempDirs: string[] = [];
const connections: Bun.SQL[] = [];
let admin: Bun.SQL | undefined;

async function database(): Promise<Bun.SQL> {
  const config = new URL(url!);
  if (config.pathname !== "/carbon_platform_test") throw new Error("Integration tests require the dedicated carbon_platform_test database");
  admin ??= new Bun.SQL(url!, { max: 1 });
  const name = `carbon_platform_test_${crypto.randomUUID().replaceAll("-", "")}`;
  await admin.unsafe(`CREATE DATABASE "${name}"`);
  databases.push(name);
  config.pathname = `/${name}`;
  const sql = new Bun.SQL(config.href, { max: 3 });
  connections.push(sql);
  return sql;
}

function fixtureDirectory(beforeVersion?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "carbon-platform-migrations-")); tempDirs.push(dir);
  for (const file of readdirSync(migrationsDir).filter(file => !beforeVersion || file < beforeVersion)) writeFileSync(join(dir, file), readFileSync(join(migrationsDir, file)));
  return dir;
}

async function expectMigrationFailure(sql: Bun.SQL, dir: string, message?: string): Promise<void> {
  // Await the transaction rejection directly. Bun 1.3.10's rejects.toThrow
  // matcher stalls repeated SQL rollbacks with this three-connection pool.
  let failure: unknown;
  try { await migrate(sql, dir); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  if (message) expect((failure as Error).message).toContain(message);
}

afterAll(async () => {
  for (const sql of connections) await sql.close();
  if (admin) {
    for (const name of databases) {
      if (!/^carbon_platform_test_[a-f0-9]{32}$/.test(name)) throw new Error("Unsafe test database cleanup");
      await admin.unsafe(`DROP DATABASE "${name}"`);
    }
    await admin.close();
  }
  for (const dir of tempDirs) {
    const resolved = realpathSync(dir);
    if (dirname(resolved).toLowerCase() !== realpathSync(tmpdir()).toLowerCase()
      || !/^carbon-platform-migrations-[A-Za-z0-9]+$/.test(basename(resolved))) throw new Error("Unsafe migration fixture cleanup");
    rmSync(resolved, { recursive: true });
  }
}, 30000);

suite("Cloud migrations against real Postgres", () => {
  test('provisioning migration preserves catalog records and prevents cross-scope binding, step and remote-resource reuse', async () => {
    const sql = await database(); await migrate(sql, fixtureDirectory('0014'));
    const org = crypto.randomUUID(); const foreign = crypto.randomUUID(); const project = crypto.randomUUID(); const other = crypto.randomUUID();
    const env = crypto.randomUUID(); const otherEnv = crypto.randomUUID(); const operation = crypto.randomUUID(); const otherOperation = crypto.randomUUID(); const binding = crypto.randomUUID();
    await sql`INSERT INTO organizations (id, name) VALUES (${org}, 'Legacy'), (${foreign}, 'Foreign')`;
    await sql`INSERT INTO projects (id, org_id, name, slug) VALUES (${project}, ${org}, 'App', 'app'), (${other}, ${foreign}, 'Other', 'other')`;
    await sql`INSERT INTO environments (id, org_id, project_id, name, kind) VALUES (${env}, ${org}, ${project}, 'Development', 'development'), (${otherEnv}, ${foreign}, ${other}, 'Development', 'development')`;
    await migrate(sql);
    expect((await sql`SELECT name, authority_revision::text FROM projects WHERE id = ${project}`)[0]).toMatchObject({ name: 'App', authority_revision: '1' });
    expect(await sql`SELECT id FROM operations`).toHaveLength(0); expect(await sql`SELECT id FROM service_bindings`).toHaveLength(0);
    const rejected = async (action: () => Promise<unknown>, code: string) => {
      let failure: unknown; try { await action(); } catch (error) { failure = error; } expect((failure as { errno?: string }).errno).toBe(code);
    };
    const digest = 'a'.repeat(64); const request = crypto.randomUUID();
    await sql`INSERT INTO operations (id, org_id, project_id, environment_id, kind, actor, idempotency_digest, request_id) VALUES
      (${operation}, ${org}, ${project}, ${env}, 'environment.ensure', '{}'::jsonb, ${digest}, ${request}),
      (${otherOperation}, ${foreign}, ${other}, ${otherEnv}, 'environment.ensure', '{}'::jsonb, ${digest}, ${request})`;
    await rejected(() => sql`INSERT INTO operations (id, org_id, project_id, environment_id, kind, actor, idempotency_digest, request_id)
      VALUES (${crypto.randomUUID()}, ${org}, ${project}, ${env}, 'environment.ensure', '{}'::jsonb, ${digest}, ${request})`, '23505');
    await rejected(() => sql`INSERT INTO service_bindings (id, org_id, project_id, environment_id, owner, operation_id)
      VALUES (${crypto.randomUUID()}, ${org}, ${project}, ${env}, 'database', ${otherOperation})`, '23503');
    await rejected(() => sql`INSERT INTO service_bindings (id, org_id, project_id, environment_id, owner, operation_id, state)
      VALUES (${crypto.randomUUID()}, ${org}, ${project}, ${env}, 'database', ${operation}, 'ready')`, '23514');
    await sql`INSERT INTO service_bindings (id, org_id, project_id, environment_id, owner, operation_id, remote_resource_id)
      VALUES (${binding}, ${org}, ${project}, ${env}, 'database', ${operation}, 'remote-one')`;
    await rejected(() => sql`INSERT INTO service_bindings (id, org_id, project_id, environment_id, owner, operation_id, remote_resource_id)
      VALUES (${crypto.randomUUID()}, ${foreign}, ${other}, ${otherEnv}, 'database', ${otherOperation}, 'remote-one')`, '23505');
    await rejected(() => sql`INSERT INTO operation_steps (id, operation_id, binding_id, org_id, project_id, environment_id, kind)
      VALUES (${crypto.randomUUID()}, ${otherOperation}, ${binding}, ${foreign}, ${other}, ${otherEnv}, 'ensure')`, '23503');
  });

  test("canonical catalog upgrade preserves legacy ownership and rejects cross-tenant relationships", async () => {
    const sql = await database(); await migrate(sql, fixtureDirectory('0013'));
    const org = crypto.randomUUID(); const foreign = crypto.randomUUID(); const account = crypto.randomUUID(); const member = crypto.randomUUID();
    await sql`INSERT INTO organizations (id, name) VALUES (${org}, 'Legacy'), (${foreign}, 'Foreign')`;
    await sql`INSERT INTO accounts (id, primary_email, name, verified_at, terms_version) VALUES (${account}, 'catalog@example.test', 'Catalog', now(), 'fixture')`;
    await sql`INSERT INTO memberships (id, account_id, org_id, role, state) VALUES (${member}, ${account}, ${org}, 'Viewer', 'active')`;
    await migrate(sql);
    expect((await sql`SELECT project_access FROM memberships WHERE id = ${member}`)[0].project_access).toBe('role');
    expect(await sql`SELECT id FROM projects`).toHaveLength(0);
    expect((await sql`SELECT human_managed FROM organizations WHERE id = ${org}`)[0].human_managed).toBe(false);
    const project = crypto.randomUUID(); const foreignProject = crypto.randomUUID(); const env = crypto.randomUUID();
    await sql`INSERT INTO projects (id, org_id, name, slug) VALUES (${project}, ${org}, 'App', 'app'), (${foreignProject}, ${foreign}, 'App', 'app')`;
    await sql`INSERT INTO environments (id, org_id, project_id, name, kind) VALUES (${env}, ${foreign}, ${foreignProject}, 'Development', 'development')`;
    const rejected = async (action: () => Promise<unknown>, code: string) => {
      let failure: unknown; try { await action(); } catch (error) { failure = error; }
      expect((failure as { errno?: string }).errno).toBe(code);
    };
    await rejected(() => sql`INSERT INTO environments (id, org_id, project_id, name, kind) VALUES (${crypto.randomUUID()}, ${org}, ${foreignProject}, 'Wrong', 'development')`, '23503');
    await rejected(() => sql`INSERT INTO project_assignments (membership_id, org_id, project_id) VALUES (${member}, ${org}, ${foreignProject})`, '23503');
    await rejected(() => sql`INSERT INTO project_assignments (membership_id, org_id, project_id) VALUES (${member}, ${foreign}, ${foreignProject})`, '23503');
    await rejected(() => sql`INSERT INTO membership_grants (id, membership_id, org_id, project_id, environment_id, permission) VALUES (${crypto.randomUUID()}, ${member}, ${org}, ${project}, ${env}, 'data.read')`, '23503');
    await rejected(() => sql`INSERT INTO membership_grants (id, membership_id, org_id, environment_id, permission) VALUES (${crypto.randomUUID()}, ${member}, ${org}, ${env}, 'data.read')`, '23514');
    await sql`INSERT INTO membership_grants (id, membership_id, org_id, permission) VALUES (${crypto.randomUUID()}, ${member}, ${org}, 'data.read')`;
    await rejected(() => sql`INSERT INTO membership_grants (id, membership_id, org_id, permission) VALUES (${crypto.randomUUID()}, ${member}, ${org}, 'data.read')`, '23505');
    expect((await sql`SELECT production_mutations_allowed FROM projects WHERE id = ${project}`)[0].production_mutations_allowed).toBe(false);
  });

  test("GitHub upgrade preserves verified subjects and restricts each account to one GitHub identity", async () => {
    const sql = await database(); await migrate(sql, fixtureDirectory('0012'));
    const account = crypto.randomUUID(); const identity = crypto.randomUUID();
    await sql`INSERT INTO accounts (id, primary_email, name, verified_at, terms_version) VALUES (${account}, 'github@example.test', 'GitHub', now(), 'fixture')`;
    await sql`INSERT INTO account_identities (id, account_id, provider, provider_subject, verified_at) VALUES (${identity}, ${account}, 'github', '123456', now())`;
    await migrate(sql);
    expect((await sql`SELECT id, provider_subject FROM account_identities WHERE account_id = ${account}`)[0]).toMatchObject({ id: identity, provider_subject: '123456' });
    let failure: unknown;
    try { await sql`INSERT INTO account_identities (id, account_id, provider, provider_subject, verified_at) VALUES (${crypto.randomUUID()}, ${account}, 'github', 'another-subject', now())`; } catch (error) { failure = error; }
    expect((failure as { constraint?: string }).constraint).toBe('account_identities_github_account_idx');
    expect((await sql`SELECT id FROM account_external_flows`)).toHaveLength(0);
  });

  test("invitation upgrade invalidates historical unbound proofs without inventing membership authority", async () => {
    const sql = await database(); await migrate(sql, fixtureDirectory("0011"));
    const account = crypto.randomUUID(); const org = crypto.randomUUID(); const invitation = crypto.randomUUID();
    await sql`INSERT INTO accounts (id, primary_email, name, verified_at, terms_version) VALUES (${account}, 'legacy@example.test', 'Legacy', now(), 'fixture')`;
    await sql`INSERT INTO organizations (id, name, slug) VALUES (${org}, 'Legacy organization', 'legacy-org')`;
    await sql`INSERT INTO invitations (id, org_id, email, role, token_hash, state, invited_by, expires_at)
      VALUES (${invitation}, ${org}, 'recipient@example.test', 'Viewer', 'legacy-invitation-hash', 'pending', ${account}, now() + interval '7 days')`;
    await migrate(sql);
    expect((await sql`SELECT state, revision::text, inviter_membership_id FROM invitations WHERE id = ${invitation}`)[0]).toMatchObject({ state: 'superseded', revision: '2', inviter_membership_id: null });
    expect((await sql`SELECT id FROM memberships`)).toHaveLength(0);
    expect((await sql`SELECT human_managed FROM organizations WHERE id = ${org}`)[0].human_managed).toBe(false);
    let failure: unknown;
    try { await sql`UPDATE invitations SET state = 'pending' WHERE id = ${invitation}`; } catch (error) { failure = error; }
    expect((failure as { constraint?: string }).constraint).toBe('invitations_pending_authority');
  });

  test("profile upgrade preserves queued mail and accepts the previous authentication writer with a verified owner reference", async () => {
    const sql = await database(); await migrate(sql, fixtureDirectory("0009"));
    const ids = [crypto.randomUUID(), crypto.randomUUID()];
    for (const id of ids) await sql`INSERT INTO account_challenges (id, email, name, purpose, token_hash, terms_version, redirect_path, expires_at)
      VALUES (${id}, 'upgrade@example.test', 'Upgrade', 'login', ${id}, 'fixture', '/', now() + interval '15 minutes')`;
    await sql`INSERT INTO account_email_outbox (id, protected_message, expires_at) VALUES (${ids[0]!}, 'encrypted-fixture', now() + interval '15 minutes')`;
    await migrate(sql);
    // Deliberately use the old writer's column list after the upgrade.
    await sql`INSERT INTO account_email_outbox (id, protected_message, expires_at) VALUES (${ids[1]!}, 'encrypted-fixture-2', now() + interval '15 minutes')`;
    const jobs = await sql`SELECT id, challenge_id, email_change_id, account_id, protected_message FROM account_email_outbox ORDER BY created_at`;
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({ id: ids[0], challenge_id: ids[0], email_change_id: null, account_id: null, protected_message: 'encrypted-fixture' });
    expect(jobs[1]).toMatchObject({ id: ids[1], challenge_id: ids[1], email_change_id: null, account_id: null });
    let failure: unknown;
    try { await sql`INSERT INTO account_email_outbox (id, protected_message, expires_at) VALUES (${crypto.randomUUID()}, 'orphan', now() + interval '15 minutes')`; }
    catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as { constraint?: string }).constraint).toBe("account_email_outbox_challenge_id_fkey");
  });

  test("fresh-auth upgrade invalidates legacy unbound proofs and rejects new unbound challenges", async () => {
    const sql = await database(); const dir = fixtureDirectory("0008");
    // Exercise the actual forward upgrade, not a fresh final-schema install.
    await migrate(sql, dir);
    for (const purpose of ["login", "fresh_auth"]) await sql`INSERT INTO account_challenges
      (id, email, name, purpose, token_hash, terms_version, redirect_path, expires_at)
      VALUES (${crypto.randomUUID()}, 'upgrade@example.test', 'Upgrade', ${purpose}, ${purpose}, 'fixture', '/', now() + interval '15 minutes')`;
    await migrate(sql);
    const rows = await sql`SELECT purpose, consumed_at IS NOT NULL AS consumed FROM account_challenges ORDER BY purpose`;
    expect(rows).toEqual([{ purpose: "fresh_auth", consumed: true }, { purpose: "login", consumed: false }]);
    let failure: unknown;
    try {
      await sql`INSERT INTO account_challenges (id, email, name, purpose, token_hash, terms_version, redirect_path, expires_at)
        VALUES (${crypto.randomUUID()}, 'upgrade@example.test', 'Upgrade', 'fresh_auth', 'unbound-new', 'fixture', '/', now() + interval '15 minutes')`;
    } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as { constraint?: string }).constraint).toBe("account_challenges_fresh_binding");
    expect((await sql`SELECT count(*)::integer AS n FROM account_challenges`)[0].n).toBe(2);
  });

  test("assertion replay protection is atomic across instances and survives adapter replacement", async () => {
    const sql = await database(); await migrate(sql);
    const first = new PostgresAssertionSecurityStore(sql, async () => true);
    const second = new PostgresAssertionSecurityStore(sql, async () => true);
    const jti = crypto.randomUUID(); const expires = new Date(Date.now() + 120000);
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? first : second).consume("https://issuer.test", "carbon-database", jti, expires)));
    expect(results.filter(Boolean)).toHaveLength(1);
    const replacement = new PostgresAssertionSecurityStore(sql, async () => true);
    expect(await replacement.consume("https://issuer.test", "carbon-database", jti, expires)).toBe(false);
    expect(await replacement.pruneExpired()).toBe(0);
    await first.consume("https://issuer.test", "carbon-database", crypto.randomUUID(), new Date(Date.now() - 1000));
    expect(await replacement.pruneExpired()).toBe(1);
    expect(await replacement.consume("https://issuer.test", "carbon-database", jti, expires)).toBe(false);
  });
  test("fresh schema and concurrent deployers apply each version exactly once", async () => {
    const sql = await database();
    await Promise.all([migrate(sql), migrate(sql), migrate(sql)]);
    const rows = await sql`SELECT version FROM cloud_schema_migrations ORDER BY version`;
    expect(rows.map((r: any) => r.version)).toEqual(readdirSync(migrationsDir).filter(f => f.endsWith(".sql")).sort());
    expect((await sql`SELECT count(*)::integer AS count FROM accounts`)[0].count).toBe(0);
    await migrate(sql);
    expect((await sql`SELECT count(*)::integer AS count FROM cloud_schema_migrations`)[0].count).toBe(rows.length);
  });

  test("adopts the real baseline without inventing an owner or changing legacy tokens", async () => {
    const sql = await database();
    for (const file of readdirSync(migrationsDir).filter(f => /^000[1-4]_/.test(f)).sort()) await sql.unsafe(readFileSync(join(migrationsDir, file), "utf8"));
    const org = crypto.randomUUID(); const token = crypto.randomUUID();
    await sql`INSERT INTO organizations (id, name) VALUES (${org}, 'Legacy organization')`;
    await sql`INSERT INTO api_tokens (id, org_id, scope, token_hash) VALUES (${token}, ${org}, 'org', 'legacy-hash')`;
    await migrate(sql);
    expect((await sql`SELECT name, slug FROM organizations WHERE id = ${org}`)[0]).toMatchObject({ name: "Legacy organization", slug: null });
    expect((await sql`SELECT token_hash FROM api_tokens WHERE id = ${token}`)[0].token_hash).toBe("legacy-hash");
    expect((await sql`SELECT status, retired_at, last_used_at, revision::text FROM api_tokens WHERE id = ${token}`)[0]).toEqual({ status: "active", retired_at: null, last_used_at: null, revision: "1" });
    expect((await sql`SELECT count(*)::integer AS count FROM memberships`)[0].count).toBe(0);
    expect((await sql`SELECT count(*)::integer AS count FROM accounts`)[0].count).toBe(0);
  });

  test("detects changed, missing and out-of-order migration history before new work", async () => {
    const sql = await database(); const dir = fixtureDirectory();
    await migrate(sql, dir);
    const file = readdirSync(dir).sort()[0]!;
    const original = readFileSync(join(dir, file), "utf8");
    writeFileSync(join(dir, file), original + "\n-- changed\n");
    await expectMigrationFailure(sql, dir, "migration history drift");
    writeFileSync(join(dir, file), original);
    writeFileSync(join(dir, "0000_before_history.sql"), "SELECT 1;");
    await expectMigrationFailure(sql, dir, "migration history drift");
    rmSync(join(dir, "0000_before_history.sql")); rmSync(join(dir, file));
    await expectMigrationFailure(sql, dir, "migration history drift");
  });

  test("rolls back schema and ledger on migration failure and supports retry", async () => {
    const sql = await database(); const dir = fixtureDirectory();
    await migrate(sql, dir);
    writeFileSync(join(dir, "9999_failure.sql"), "CREATE TABLE failure_probe (id integer); SELECT * FROM absent_table;");
    await expectMigrationFailure(sql, dir);
    expect((await sql`SELECT to_regclass('failure_probe') AS name`)[0].name).toBeNull();
    expect((await sql`SELECT count(*)::integer AS count FROM cloud_schema_migrations WHERE version = '9999_failure.sql'`)[0].count).toBe(0);
    writeFileSync(join(dir, "9999_failure.sql"), "CREATE TABLE failure_probe (id integer);");
    await migrate(sql, dir);
    expect((await sql`SELECT to_regclass('failure_probe') AS name`)[0].name).toBe("failure_probe");
  });
});

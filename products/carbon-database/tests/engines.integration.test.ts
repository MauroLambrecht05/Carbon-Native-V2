// Canonical vector collections and the canonical graph against real PostgreSQL
// and pgvector, through the repositories the signed routes call.

import { afterEach, describe, expect, test } from 'bun:test';
import { PostgresGraphStore, PostgresVectorStore, type NativeDataAuthority } from '@carbon/data';
import { PostgresServiceLifecycleRepository, PostgresDatabaseEnvironmentDriver, databaseEnvironmentIdentifiers } from '@carbon/catalog';
import type { GraphCommand, GraphResult, Principal, VectorCommand, VectorResult } from '@carbon/contracts/platform';
import { migrate } from '../infrastructure/persistence/Database.ts';

const testUrl = process.env.CARBON_SERVICE_TEST_DATABASE_URL;
const suite = testUrl ? describe : describe.skip;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) { await cleanups.at(-1)!(); cleanups.pop(); } }, 30000);
const uuid = () => crypto.randomUUID();
const principal: Principal = { id: uuid(), kind: 'account', audience: 'dashboard', credentialId: uuid(), permissionRevision: '1' };
// The kind of refusal: a platform fault's code, or the database's own error number.
async function refused(work: Promise<unknown>): Promise<string> {
  try { await work; } catch (error) { const fault = error as { code?: string; errno?: string; name?: string }; return fault.name === 'ContractError' ? 'validation' : fault.errno ?? fault.code ?? String(error); }
  return 'accepted';
}

async function harness() {
  const url = new URL(testUrl!); if (url.pathname !== '/carbon_service_test') throw new Error('Requires dedicated test database');
  const admin = new Bun.SQL(url.href, { max: 1 }); const name = `carbon_service_test_${uuid().replaceAll('-', '')}_engines`;
  await admin.unsafe(`CREATE DATABASE "${name}"`); url.pathname = '/' + name;
  const sql = new Bun.SQL(url.href, { max: 4 }); const roles: string[] = [];
  cleanups.push(async () => {
    await sql.close(); if (!/^carbon_service_test_[a-f0-9]{32}_engines$/.test(name)) throw new Error('Unsafe cleanup');
    await admin.unsafe(`DROP DATABASE "${name}"`);
    for (const role of roles) { if (!/^ce_[a-f0-9]{32}$/.test(role)) throw new Error('Unsafe role cleanup'); await admin.unsafe(`DROP ROLE "${role}"`); }
    await admin.close();
  });
  await migrate(sql);
  const lifecycle = new PostgresServiceLifecycleRepository(sql, new PostgresDatabaseEnvironmentDriver()); const environments: NativeDataAuthority[] = [];
  for (let index = 0; index < 2; index++) {
    const scope = { orgId: uuid(), projectId: uuid(), environmentId: uuid() }; const bindingId = uuid();
    await lifecycle.execute({ scope, bindingId, operationId: uuid(), stepId: uuid(), leaseId: uuid(), action: 'ensure', remoteResourceId: null }, principal, uuid(), async () => true);
    roles.push(databaseEnvironmentIdentifiers(scope.environmentId).role);
    environments.push({ scope, bindingId, principal, requestId: uuid(), permit: async () => true });
  }
  return { sql, environments };
}

suite('canonical vector collections', () => {
  test('collections enforce their dimension, score deterministically, filter on metadata, hold their limits and stay inside their environment', async () => {
    const h = await harness(); const [A, B] = h.environments as [NativeDataAuthority, NativeDataAuthority];
    const store = new PostgresVectorStore(h.sql, { collections: 3, pointsPerCollection: 6 });
    const run = (authority: NativeDataAuthority, command: Record<string, unknown>) => store.execute({ ...authority, requestId: uuid() }, command as VectorCommand) as Promise<VectorResult & Record<string, any>>;
    const collection = uuid(); const [a, b, c, d] = [uuid(), uuid(), uuid(), uuid()].sort() as [string, string, string, string];
    const points = [{ id: a, vector: [1, 0, 0], metadata: { topic: 'x', rank: 1 } }, { id: b, vector: [0, 1, 0], metadata: { topic: 'y', rank: 2 } },
      { id: c, vector: [1, 1, 0], metadata: { topic: 'x', rank: 3 } }, { id: d, vector: [-1, 0, 0], metadata: { topic: 'y', rank: 4 } }];

    for (const definition of [{ name: 'Bad Name', dimension: 3, metric: 'cosine' }, { name: 'docs', dimension: 0, metric: 'cosine' }, { name: 'docs', dimension: 2001, metric: 'cosine' }, { name: 'docs', dimension: 3, metric: 'manhattan' }])
      expect(await refused(run(A, { kind: 'collection.create', commandId: uuid(), collectionId: uuid(), definition }))).toBe('validation');
    const creating = { kind: 'collection.create', commandId: uuid(), collectionId: collection, definition: { name: 'docs', dimension: 3, metric: 'cosine' } };
    const created = await run(A, creating); expect(created).toEqual({ commandId: creating.commandId, collectionId: collection, revision: '1' });
    // The same command again returns the same receipt; the same ID with another body is refused.
    expect(await run(A, creating)).toEqual(created); expect(await refused(run(A, { ...creating, definition: { name: 'other', dimension: 3, metric: 'cosine' } }))).toBe('conflict');
    expect(await refused(run(A, { kind: 'collection.create', commandId: uuid(), collectionId: uuid(), definition: { name: 'docs', dimension: 8, metric: 'l2' } }))).toBe('conflict');

    // Every vector in a collection has exactly its dimension.
    const upsert = (authority: NativeDataAuthority, collectionId: string, batch: unknown[]) => run(authority, { kind: 'points.upsert', commandId: uuid(), collectionId, points: batch });
    expect(await refused(upsert(A, collection, [{ id: uuid(), vector: [1, 0], metadata: {} }]))).toBe('validation'); expect(await refused(upsert(A, collection, [{ id: uuid(), vector: [1, 0, 0, 0], metadata: {} }]))).toBe('validation');
    expect(await refused(upsert(A, collection, [{ id: uuid(), vector: [0, 0, 0], metadata: {} }]))).toBe('validation');
    expect(await refused(upsert(A, collection, [{ id: a, vector: [1, 0, 0], metadata: {} }, { id: a, vector: [0, 1, 0], metadata: {} }]))).toBe('validation');
    expect(await refused(upsert(A, collection, [{ id: uuid(), vector: [1, 0, 0], metadata: { nested: { no: true } } }]))).toBe('validation');
    expect(await refused(upsert(A, collection, []))).toBe('validation'); expect(await refused(upsert(A, uuid(), points))).toBe('not_found');
    expect((await h.sql`SELECT count(*)::integer AS count FROM canonical_vector_points`)[0].count).toBe(0);
    expect(await upsert(A, collection, points)).toMatchObject({ collectionId: collection, revision: '2', affected: 4 });

    // Cosine: lower distance is closer, in a fixed order.
    const query = async (collectionId: string, vector: number[], extra: Record<string, unknown> = {}, authority = A) => (await run(authority, { kind: 'points.query', collectionId, vector, ...extra })).matches as { id: string; distance: number; metadata: Record<string, unknown> }[];
    const nearest = await query(collection, [1, 0, 0]);
    expect(nearest.map(match => match.id)).toEqual([a, c, b, d]);
    expect(nearest.map(match => Number(match.distance.toFixed(4)))).toEqual([0, 0.2929, 1, 2]); expect(nearest[0]!.metadata).toEqual({ topic: 'x', rank: 1 });
    expect(await query(collection, [1, 0, 0])).toEqual(nearest);
    expect((await query(collection, [1, 0, 0], { limit: 2 })).map(match => match.id)).toEqual([a, c]);
    // A metadata filter narrows the candidates before they are ranked.
    expect((await query(collection, [1, 0, 0], { filter: { topic: 'y' } })).map(match => match.id)).toEqual([b, d]);
    expect((await query(collection, [1, 0, 0], { filter: { topic: 'x', rank: 3 } })).map(match => match.id)).toEqual([c]); expect(await query(collection, [1, 0, 0], { filter: { topic: 'none' } })).toEqual([]);
    expect(await refused(query(collection, [1, 0]))).toBe('validation'); expect(await refused(query(collection, [0, 0, 0]))).toBe('validation'); expect(await refused(query(collection, [1, 0, 0], { limit: 101 }))).toBe('validation');
    // The other metrics, with the same points.
    const euclid = uuid(); await run(A, { kind: 'collection.create', commandId: uuid(), collectionId: euclid, definition: { name: 'euclid', dimension: 3, metric: 'l2' } }); await upsert(A, euclid, points);
    const far = await query(euclid, [1, 0, 0]); expect(far.map(match => match.id)).toEqual([a, c, b, d]); expect(far.map(match => Number(match.distance.toFixed(4)))).toEqual([0, 1, 1.4142, 2]);
    const dot = uuid(); await run(A, { kind: 'collection.create', commandId: uuid(), collectionId: dot, definition: { name: 'dot', dimension: 3, metric: 'inner' } }); await upsert(A, dot, points);
    // Two points tie on inner product; the tie is broken by ID, the same way every time.
    const product = await query(dot, [1, 0, 0]); expect(product.map(match => [match.id, match.distance])).toEqual([[a, -1], [c, -1], [b, 0], [d, 1]]);

    // Upserting an existing point replaces it and does not grow the collection.
    expect(await upsert(A, collection, [{ id: b, vector: [1, 0, 0.001], metadata: { topic: 'moved' } }])).toMatchObject({ revision: '3', affected: 1 });
    expect((await query(collection, [1, 0, 0], { limit: 2 })).map(match => match.id)).toEqual([a, b]);
    const fetched = await run(A, { kind: 'points.get', collectionId: collection, ids: [b, a, uuid()] });
    expect(fetched.points).toEqual([{ id: a, vector: [1, 0, 0], metadata: { topic: 'x', rank: 1 } }, { id: b, vector: [1, 0, 0.001], metadata: { topic: 'moved' } }].sort((x, y) => x.id < y.id ? -1 : 1));
    const listed = (await run(A, { kind: 'collections.list' })).collections as { id: string; pointCount: number; definition: { name: string } }[];
    expect(listed.map(item => [item.definition.name, item.pointCount])).toEqual([['docs', 4], ['dot', 4], ['euclid', 4]]);

    // Limits. Six points per collection here: four are stored.
    expect(await refused(upsert(A, collection, [1, 2, 3].map(() => ({ id: uuid(), vector: [1, 1, 1], metadata: {} }))))).toBe('quota');
    const racing = await Promise.all([refused(upsert(A, collection, [1, 2].map(() => ({ id: uuid(), vector: [1, 1, 1], metadata: {} })))), refused(upsert(A, collection, [1, 2].map(() => ({ id: uuid(), vector: [0, 1, 1], metadata: {} }))))]);
    expect(racing.sort()).toEqual(['accepted', 'quota']);
    // Replacing existing points is always possible, even when the collection is full.
    expect(await refused(upsert(A, collection, points))).toBe('accepted'); expect(await refused(upsert(A, collection, [{ id: uuid(), vector: [1, 1, 1], metadata: {} }]))).toBe('quota');
    expect(await refused(run(A, { kind: 'collection.create', commandId: uuid(), collectionId: uuid(), definition: { name: 'fourth', dimension: 3, metric: 'l2' } }))).toBe('quota');
    const removed = await run(A, { kind: 'points.delete', commandId: uuid(), collectionId: collection, ids: [d, uuid()] }); expect(removed.affected).toBe(1);
    expect((await query(collection, [1, 0, 0])).some(match => match.id === d)).toBe(false); expect(await refused(upsert(A, collection, [{ id: uuid(), vector: [1, 1, 1], metadata: {} }]))).toBe('accepted');

    // Another environment sees none of it, by ID or by listing, and may use the same names and point IDs.
    for (const command of [{ kind: 'points.query', collectionId: collection, vector: [1, 0, 0] }, { kind: 'points.get', collectionId: collection, ids: [a] }, { kind: 'points.upsert', commandId: uuid(), collectionId: collection, points },
      { kind: 'points.delete', commandId: uuid(), collectionId: collection, ids: [a] }, { kind: 'collection.delete', commandId: uuid(), collectionId: collection, revision: '1', confirmation: 'docs' }]) expect(await refused(run(B, command))).toBe('not_found');
    expect((await run(B, { kind: 'collections.list' })).collections).toEqual([]);
    const theirs = uuid(); await run(B, { kind: 'collection.create', commandId: uuid(), collectionId: theirs, definition: { name: 'docs', dimension: 3, metric: 'cosine' } }); await upsert(B, theirs, [{ id: a, vector: [0, 0, 1], metadata: { topic: 'theirs' } }]);
    expect((await query(theirs, [0, 0, 1], {}, B)).map(match => match.metadata.topic)).toEqual(['theirs']); expect((await query(collection, [1, 0, 0]))[0]!.metadata.topic).toBe('x');

    // Authority is live and is checked again before the result leaves: a caller who loses it mid-command changes nothing.
    expect(await refused(run({ ...A, permit: async () => false }, { kind: 'collections.list' }))).toBe('forbidden');
    expect(await refused(run({ ...A, principal: { ...principal, kind: 'app_user', audience: 'app' } }, { kind: 'points.query', collectionId: collection, vector: [1, 0, 0] }))).toBe('forbidden');
    const before = (await h.sql`SELECT count(*)::integer AS count FROM canonical_vector_points`)[0].count; let checks = 0;
    expect(await refused(run({ ...A, permit: async () => ++checks < 2 }, { kind: 'points.upsert', commandId: uuid(), collectionId: euclid, points: [{ id: uuid(), vector: [9, 9, 9], metadata: {} }] }))).toBe('forbidden');
    expect((await h.sql`SELECT count(*)::integer AS count FROM canonical_vector_points`)[0].count).toBe(before);
    // A paused environment can still be read, not written.
    await h.sql`UPDATE platform_environments SET state = 'paused' WHERE environment_id = ${A.scope.environmentId}`;
    expect((await query(collection, [1, 0, 0])).length).toBeGreaterThan(0); expect(await refused(upsert(A, collection, points.slice(0, 1)))).toBe('conflict');
    await h.sql`UPDATE platform_environments SET state = 'active' WHERE environment_id = ${A.scope.environmentId}`;

    // Deleting a collection needs its revision and its name, and takes its points with it.
    const current = ((await run(A, { kind: 'collections.list' })).collections as { id: string; revision: string }[]).find(item => item.id === collection)!;
    expect(await refused(run(A, { kind: 'collection.delete', commandId: uuid(), collectionId: collection, revision: current.revision, confirmation: 'wrong' }))).toBe('validation');
    expect(await refused(run(A, { kind: 'collection.delete', commandId: uuid(), collectionId: collection, revision: '1', confirmation: 'docs' }))).toBe('conflict');
    await run(A, { kind: 'collection.delete', commandId: uuid(), collectionId: collection, revision: current.revision, confirmation: 'docs' });
    expect(await h.sql`SELECT 1 FROM canonical_vector_points WHERE collection_id = ${collection}`).toHaveLength(0); expect(await refused(query(collection, [1, 0, 0]))).toBe('not_found');
    expect((await query(theirs, [0, 0, 1], {}, B))).toHaveLength(1);
  });
});

suite('canonical graph', () => {
  test('edges need both ends, walks and paths are bounded and repeatable, limits hold, and each environment has its own graph', async () => {
    const h = await harness(); const [A, B] = h.environments as [NativeDataAuthority, NativeDataAuthority];
    const store = new PostgresGraphStore(h.sql, { nodes: 8, edges: 9 });
    const run = (authority: NativeDataAuthority, command: Record<string, unknown>) => store.execute({ ...authority, requestId: uuid() }, command as GraphCommand) as Promise<GraphResult & Record<string, any>>;
    const [a, b, c, d, x, y, z] = [uuid(), uuid(), uuid(), uuid(), uuid(), uuid(), uuid()].sort() as [string, string, string, string, string, string, string];
    const put = (authority: NativeDataAuthority, id: string, label = 'Thing', properties: Record<string, unknown> = {}) => run(authority, { kind: 'node.put', commandId: uuid(), node: { id, label, properties } });
    const link = (authority: NativeDataAuthority, source: string, target: string, label = 'TO', id: string = uuid(), properties: Record<string, unknown> = {}) => run(authority, { kind: 'edge.put', commandId: uuid(), edge: { id, source, target, label, properties } });

    expect(await refused(put(A, a, 'bad label'))).toBe('validation'); expect(await refused(put(A, a, 'Thing', { nested: [1] }))).toBe('validation');
    const first = { kind: 'node.put', commandId: uuid(), node: { id: a, label: 'Person', properties: { name: 'Ada' } } };
    const receipt = await run(A, first); expect(receipt).toEqual({ commandId: first.commandId, nodeId: a }); expect(await run(A, first)).toEqual(receipt);
    expect(await refused(run(A, { ...first, node: { ...first.node, label: 'Robot' } }))).toBe('conflict');
    expect((await run(A, { kind: 'node.get', nodeId: a })).node).toEqual({ id: a, label: 'Person', properties: { name: 'Ada' } });
    // Putting a node again updates it in place.
    await put(A, a, 'Person', { name: 'Ada', born: 1815 }); expect((await run(A, { kind: 'node.get', nodeId: a.toUpperCase() })).node.properties).toEqual({ name: 'Ada', born: 1815 });
    for (const id of [b, c, d]) await put(A, id);

    // An edge cannot dangle, and it keeps its ends for life.
    expect(await refused(link(A, a, uuid()))).toBe('conflict'); expect(await refused(link(A, uuid(), a))).toBe('conflict'); expect(await h.sql`SELECT 1 FROM canonical_graph_edges`).toHaveLength(0);
    const ab = uuid(); await link(A, a, b, 'TO', ab, { weight: 1 }); await link(A, b, c); await link(A, c, d); const da = uuid(); await link(A, d, a, 'BACK', da);
    expect(await refused(link(A, a, c, 'TO', ab))).toBe('conflict');
    // The same edge again updates its label and properties.
    await link(A, a, b, 'TO', ab, { weight: 2 });
    // The database itself refuses a dangling edge, whatever writes it.
    expect(await refused(h.sql`INSERT INTO canonical_graph_edges (environment_id, id, source_id, target_id, label) VALUES (${A.scope.environmentId}, ${uuid()}, ${a}, ${uuid()}, 'TO')`)).toBe('23503');

    // Neighbours, by direction and label.
    const around = async (direction: string, extra: Record<string, unknown> = {}) => { const result = await run(A, { kind: 'neighbors', nodeId: a, direction, ...extra }); return { ids: (result.neighbors as { node: { id: string } }[]).map(item => item.node.id), truncated: result.truncated }; };
    expect(await around('out')).toEqual({ ids: [b], truncated: false }); expect(await around('in')).toEqual({ ids: [d], truncated: false }); expect((await around('both')).ids).toEqual([b, d].sort());
    expect((await around('both', { label: 'BACK' })).ids).toEqual([d]); expect(await around('both', { limit: 1 })).toEqual({ ids: [[b, d].sort()[0]!], truncated: true });
    expect((await run(A, { kind: 'neighbors', nodeId: a, direction: 'out' })).neighbors[0].edge).toEqual({ id: ab, source: a, target: b, label: 'TO', properties: { weight: 2 } });
    expect(await refused(run(A, { kind: 'neighbors', nodeId: uuid(), direction: 'out' }))).toBe('not_found');

    // A walk is breadth-first and bounded by depth and by size. The graph has a cycle; no node is visited twice.
    const walk = async (direction: string, maxDepth: number, extra: Record<string, unknown> = {}) => { const result = await run(A, { kind: 'traverse', nodeId: a, direction, maxDepth, ...extra }); return { reached: (result.reached as { node: { id: string }; depth: number }[]).map(item => [item.node.id, item.depth]), truncated: result.truncated }; };
    expect(await walk('out', 1)).toEqual({ reached: [[a, 0], [b, 1]], truncated: false });
    expect(await walk('out', 2)).toEqual({ reached: [[a, 0], [b, 1], [c, 2]], truncated: false });
    expect(await walk('out', 6)).toEqual({ reached: [[a, 0], [b, 1], [c, 2], [d, 3]], truncated: false });
    expect((await walk('both', 1)).reached).toEqual([[a, 0], ...[b, d].sort().map(id => [id, 1])]);
    expect((await walk('out', 6, { label: 'BACK' })).reached).toEqual([[a, 0]]);
    expect(await walk('out', 6, { limit: 2 })).toEqual({ reached: [[a, 0], [b, 1]], truncated: true });
    expect(await refused(walk('out', 7))).toBe('validation'); expect(await refused(walk('out', 0))).toBe('validation'); expect(await refused(walk('sideways', 2))).toBe('validation');

    // Shortest paths, within the depth limit.
    const path = (from: string, to: string, direction: string, maxDepth: number, extra: Record<string, unknown> = {}, authority = A) => run(authority, { kind: 'path', from, to, direction, maxDepth, ...extra });
    expect(await path(a, d, 'out', 6)).toMatchObject({ found: true, nodes: [a, b, c, d] }); expect((await path(a, d, 'out', 6)).edges).toHaveLength(3);
    expect(await path(a, d, 'out', 2)).toEqual({ found: false, nodes: [], edges: [] });
    // Following edges either way, the back edge is the short route.
    expect(await path(a, d, 'both', 6)).toEqual({ found: true, nodes: [a, d], edges: [da] }); expect(await path(a, d, 'in', 6)).toEqual({ found: true, nodes: [a, d], edges: [da] });
    expect(await path(a, a, 'out', 1)).toEqual({ found: true, nodes: [a], edges: [] }); expect(await path(a, d, 'out', 6, { label: 'BACK' })).toMatchObject({ found: false });
    expect(await refused(path(a, uuid(), 'out', 3))).toBe('not_found');
    // Two routes of the same length: the answer is the same every time.
    for (const id of [x, y, z]) await put(A, id); const [ax, ay, xz, yz] = [uuid(), uuid(), uuid(), uuid()].sort() as [string, string, string, string];
    await link(A, a, x, 'TO', ax); await link(A, a, y, 'TO', ay); await link(A, x, z, 'TO', xz); await link(A, y, z, 'TO', yz);
    const chosen = await path(a, z, 'out', 3); expect(chosen).toEqual({ found: true, nodes: [a, x, z], edges: [ax, xz] }); for (let repeat = 0; repeat < 3; repeat++) expect(await path(a, z, 'out', 3)).toEqual(chosen);

    // Limits: eight nodes and nine edges here. Seven and eight are in use.
    const eighth = uuid(); await put(A, eighth); expect(await refused(put(A, uuid()))).toBe('quota'); expect(await refused(put(A, a, 'Person', { still: 'updatable' }))).toBe('accepted');
    await link(A, eighth, a); expect(await refused(link(A, eighth, b))).toBe('quota'); expect(await refused(link(A, a, b, 'TO', ab, { weight: 3 }))).toBe('accepted');

    // A node with edges is not deleted by accident.
    expect(await refused(run(A, { kind: 'node.delete', commandId: uuid(), nodeId: z }))).toBe('conflict'); expect((await run(A, { kind: 'node.get', nodeId: z })).node.id).toBe(z);
    expect(await run(A, { kind: 'node.delete', commandId: uuid(), nodeId: z, detach: true })).toMatchObject({ nodeId: z, removedEdges: 2 });
    expect(await refused(run(A, { kind: 'node.get', nodeId: z }))).toBe('not_found'); expect(await path(a, x, 'out', 2)).toMatchObject({ found: true });
    await run(A, { kind: 'edge.delete', commandId: uuid(), edgeId: ax }); expect(await refused(run(A, { kind: 'edge.delete', commandId: uuid(), edgeId: ax }))).toBe('not_found');
    expect(await run(A, { kind: 'node.delete', commandId: uuid(), nodeId: x })).toMatchObject({ removedEdges: 0 });

    // Another environment has its own graph: it cannot read, link to or delete these nodes, and may reuse their IDs.
    for (const command of [{ kind: 'node.get', nodeId: a }, { kind: 'neighbors', nodeId: a, direction: 'both' }, { kind: 'traverse', nodeId: a, direction: 'out', maxDepth: 3 }, { kind: 'path', from: a, to: d, direction: 'out', maxDepth: 6 },
      { kind: 'node.delete', commandId: uuid(), nodeId: a, detach: true }, { kind: 'edge.delete', commandId: uuid(), edgeId: ab }]) expect(await refused(run(B, command))).toBe('not_found');
    expect(await refused(link(B, a, b))).toBe('conflict');
    await put(B, a, 'Other', { owner: 'B' }); await put(B, b); await link(B, a, b, 'TO', ab);
    expect((await run(B, { kind: 'node.get', nodeId: a })).node).toEqual({ id: a, label: 'Other', properties: { owner: 'B' } }); expect((await run(A, { kind: 'node.get', nodeId: a })).node.label).toBe('Person');
    expect((await run(B, { kind: 'traverse', nodeId: a, direction: 'both', maxDepth: 6 })).reached).toHaveLength(2);
    await run(B, { kind: 'node.delete', commandId: uuid(), nodeId: a, detach: true }); expect((await walk('out', 6)).reached.length).toBeGreaterThan(3);

    // Authority is live.
    expect(await refused(run({ ...A, permit: async () => false }, { kind: 'node.get', nodeId: a }))).toBe('forbidden');
    expect(await refused(run({ ...A, principal: { ...principal, kind: 'app_user', audience: 'app' } }, { kind: 'node.get', nodeId: a }))).toBe('forbidden');
    let checks = 0; const nodes = (await h.sql`SELECT count(*)::integer AS count FROM canonical_graph_nodes`)[0].count;
    expect(await refused(run({ ...A, permit: async () => ++checks < 2 }, { kind: 'node.delete', commandId: uuid(), nodeId: eighth, detach: true }))).toBe('forbidden');
    expect((await h.sql`SELECT count(*)::integer AS count FROM canonical_graph_nodes`)[0].count).toBe(nodes);
    await h.sql`UPDATE platform_environments SET state = 'paused' WHERE environment_id = ${A.scope.environmentId}`;
    expect((await walk('out', 2)).reached.length).toBeGreaterThan(1); expect(await refused(put(A, a))).toBe('conflict');
  });
});

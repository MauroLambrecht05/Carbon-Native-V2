import { PlatformFault, canonicalEngineRequest, enginePermission, parseComponent, type EngineFamily, type GraphCommand, type GraphEdge, type GraphNode, type GraphResult, type Permission,
  type VectorCommand, type VectorResult } from '@carbon/contracts/platform';
import { bodyDigest } from '@carbon/identity';
import type { NativeDataAuthority } from '../application/ports/NativeTables.ts';

type Row = Record<string, any>;
type Tx = Bun.TransactionSQL;

export interface VectorLimits { readonly collections: number; readonly pointsPerCollection: number }
export interface GraphLimits { readonly nodes: number; readonly edges: number }

/** What vector and graph storage share: the environment check, live authority, and replay-safe receipts. */
abstract class PostgresEngine {
  constructor(protected readonly sql: Bun.SQL, private readonly family: EngineFamily) {}

  protected transact<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.sql.begin(async tx => { await tx`SET LOCAL lock_timeout = '5s'`; await tx`SET LOCAL statement_timeout = '10s'`; return work(tx); }) as Promise<T>;
  }
  /** The caller's own environment, verified and live. Vector and graph data is for accounts and service accounts; app users have no access yet. */
  protected async environment(tx: Tx, authority: NativeDataAuthority, permission: Permission): Promise<Row> {
    parseComponent('EnvironmentScope', authority.scope); parseComponent('Id', authority.bindingId); parseComponent('Principal', authority.principal); parseComponent('Id', authority.requestId);
    const principal = authority.principal;
    if (!((principal.kind === 'account' && principal.audience === 'dashboard') || (principal.kind === 'service_account' && principal.audience === 'automation')) || !await authority.permit(permission)) {
      throw new PlatformFault('forbidden', 'This operation is not authorized');
    }
    const scope = authority.scope;
    const rows = await tx<Row[]>`SELECT id, state FROM public.platform_environments WHERE org_id = ${scope.orgId} AND project_id = ${scope.projectId} AND environment_id = ${scope.environmentId}
      AND binding_id = ${authority.bindingId} FOR SHARE`;
    if (!rows.length) throw new PlatformFault('not_found', 'Environment resource not found');
    if (permission !== 'data.read' && permission !== 'metadata.read' && rows[0]!.state !== 'active') throw new PlatformFault('conflict', 'Environment is paused');
    return rows[0]!;
  }
  /**
   * Runs one command. A command that changes something is recorded with its receipt in the same transaction, so sending
   * it again returns the same receipt and changes nothing; the same ID with a different body is refused.
   */
  protected run<C extends { kind: string; commandId?: string }, R>(authority: NativeDataAuthority, command: C, digestSource: string, work: (tx: Tx, environment: Row, again: () => Promise<void>) => Promise<R>): Promise<R> {
    const permission = enginePermission(this.family, command.kind); const digest = bodyDigest(digestSource); const actor = authority.principal;
    return this.transact(async tx => {
      const environment = await this.environment(tx, authority, permission);
      const again = async () => { if (!await authority.permit(permission)) throw new PlatformFault('forbidden', 'Authority is no longer current'); };
      if (command.commandId === undefined) { const result = await work(tx, environment, again); await again(); return result; }
      await tx`SELECT pg_advisory_xact_lock(1128354378, hashtext(${JSON.stringify([this.family, actor.kind, actor.id, command.commandId])}))`;
      const existing = (await tx<Row[]>`SELECT request_digest, result FROM public.engine_commands WHERE family = ${this.family} AND principal_kind = ${actor.kind} AND principal_id = ${actor.id} AND command_id = ${command.commandId}`)[0];
      if (existing) { if (existing.request_digest !== digest) throw new PlatformFault('conflict', 'Command ID was used for a different request'); await again(); return existing.result as R; }
      const result = await work(tx, environment, again);
      await tx`INSERT INTO public.engine_commands (family, principal_kind, principal_id, command_id, environment_id, request_digest, result)
        VALUES (${this.family}, ${actor.kind}, ${actor.id}, ${command.commandId}, ${authority.scope.environmentId}, ${digest}, ${JSON.stringify(result)}::text::jsonb)`;
      await again(); return result;
    });
  }
}

const OPERATOR = { cosine: '<=>', l2: '<->', inner: '<#>' } as const;
const literal = (vector: readonly number[]) => `[${vector.join(',')}]`;

/** Vector collections in pgvector. Search is exact: every point of the collection is scored, so results never depend on an index. */
export class PostgresVectorStore extends PostgresEngine {
  constructor(sql: Bun.SQL, private readonly limits: VectorLimits = { collections: 50, pointsPerCollection: 100_000 }) { super(sql, 'vectors'); }

  /** A collection of the caller's own environment. Another environment's collection is simply not found. */
  private async collection(tx: Tx, authority: NativeDataAuthority, id: string, lock = false): Promise<Row> {
    const scope = authority.scope;
    const rows = await tx.unsafe(`SELECT *, revision::text FROM public.canonical_vector_collections WHERE id = $1 AND org_id = $2 AND project_id = $3 AND environment_id = $4${lock ? ' FOR UPDATE' : ' FOR SHARE'}`,
      [id, scope.orgId, scope.projectId, scope.environmentId]);
    if (!rows.length) throw new PlatformFault('not_found', 'Collection not found');
    return rows[0];
  }
  private check(collection: Row, vector: readonly number[]) {
    if (vector.length !== collection.dimension) throw new PlatformFault('validation', `Vectors in this collection have ${collection.dimension} dimensions`);
    if (vector.some(value => !Number.isFinite(value))) throw new PlatformFault('validation', 'Vector components must be finite numbers');
    // Cosine distance is undefined for a vector with no direction.
    if (collection.metric === 'cosine' && vector.every(value => value === 0)) throw new PlatformFault('validation', 'A cosine collection cannot hold or search the zero vector');
  }

  async execute(authority: NativeDataAuthority, input: VectorCommand): Promise<VectorResult> {
    const command = parseComponent('VectorCommand', structuredClone(input)); const scope = authority.scope;
    const source = canonicalEngineRequest('vectors', { scope, bindingId: authority.bindingId, command });
    return this.run<VectorCommand, VectorResult>(authority, command, source, async (tx, environment) => {
      switch (command.kind) {
        case 'collections.list': {
          const rows = await tx<Row[]>`SELECT *, revision::text FROM public.canonical_vector_collections WHERE org_id = ${scope.orgId} AND project_id = ${scope.projectId} AND environment_id = ${scope.environmentId} ORDER BY name LIMIT ${this.limits.collections}`;
          return { collections: rows.map(row => ({ id: row.id, definition: { name: row.name, dimension: row.dimension, metric: row.metric }, pointCount: Number(row.point_count), revision: row.revision, createdAt: row.created_at.toISOString() })) };
        }
        case 'collection.create': {
          await tx`SELECT id FROM public.platform_environments WHERE id = ${environment.id} FOR UPDATE`;
          const existing = await tx<Row[]>`SELECT name FROM public.canonical_vector_collections WHERE environment_id = ${scope.environmentId}`;
          if (existing.length >= this.limits.collections) throw new PlatformFault('quota', 'This environment has reached its collection limit', { quota: 'vector_collections' });
          if (existing.some(row => row.name === command.definition.name)) throw new PlatformFault('conflict', 'A collection with this name already exists');
          await tx`INSERT INTO public.canonical_vector_collections (id, resource_id, org_id, project_id, environment_id, name, dimension, metric)
            VALUES (${command.collectionId}, ${environment.id}, ${scope.orgId}, ${scope.projectId}, ${scope.environmentId}, ${command.definition.name}, ${command.definition.dimension}, ${command.definition.metric})`;
          return { commandId: command.commandId, collectionId: command.collectionId, revision: '1' };
        }
        case 'collection.delete': {
          const row = await this.collection(tx, authority, command.collectionId, true);
          if (row.revision !== command.revision) throw new PlatformFault('conflict', 'Collection revision changed');
          if (command.confirmation !== row.name) throw new PlatformFault('validation', 'Confirm the collection name to delete it');
          // Its points go with it, in the same transaction.
          await tx`DELETE FROM public.canonical_vector_collections WHERE id = ${row.id}`;
          return { commandId: command.commandId, collectionId: row.id, affected: Number(row.point_count) };
        }
        case 'points.upsert': {
          // The collection is locked so two batches cannot both take the last of its room.
          const row = await this.collection(tx, authority, command.collectionId, true);
          if (new Set(command.points.map(point => point.id.toLowerCase())).size !== command.points.length) throw new PlatformFault('validation', 'A batch cannot name the same point twice');
          for (const point of command.points) { this.check(row, point.vector); if (Buffer.byteLength(JSON.stringify(point.metadata)) > 4096) throw new PlatformFault('validation', 'Point metadata exceeds the byte limit'); }
          const known = (await tx<Row[]>`SELECT id FROM public.canonical_vector_points WHERE collection_id = ${row.id} AND id = ANY(${`{${command.points.map(point => point.id).join(',')}}`}::uuid[])`).length;
          const added = command.points.length - known;
          if (Number(row.point_count) + added > this.limits.pointsPerCollection) throw new PlatformFault('quota', 'This collection has no room for these points', { quota: 'vector_points' });
          for (const point of command.points) {
            await tx`INSERT INTO public.canonical_vector_points (collection_id, id, embedding, metadata) VALUES (${row.id}, ${point.id}, ${literal(point.vector)}::vector, ${JSON.stringify(point.metadata)}::text::jsonb)
              ON CONFLICT (collection_id, id) DO UPDATE SET embedding = EXCLUDED.embedding, metadata = EXCLUDED.metadata, updated_at = now()`;
          }
          const updated = (await tx<Row[]>`UPDATE public.canonical_vector_collections SET point_count = point_count + ${added}, revision = revision + 1 WHERE id = ${row.id} RETURNING revision::text`)[0]!;
          return { commandId: command.commandId, collectionId: row.id, revision: updated.revision, affected: command.points.length };
        }
        case 'points.delete': {
          const row = await this.collection(tx, authority, command.collectionId, true);
          const removed = (await tx<Row[]>`DELETE FROM public.canonical_vector_points WHERE collection_id = ${row.id} AND id = ANY(${`{${command.ids.join(',')}}`}::uuid[]) RETURNING id`).length;
          const updated = (await tx<Row[]>`UPDATE public.canonical_vector_collections SET point_count = point_count - ${removed}, revision = revision + 1 WHERE id = ${row.id} RETURNING revision::text`)[0]!;
          return { commandId: command.commandId, collectionId: row.id, revision: updated.revision, affected: removed };
        }
        case 'points.get': {
          const row = await this.collection(tx, authority, command.collectionId);
          const rows = await tx<Row[]>`SELECT id, embedding::text AS embedding, metadata FROM public.canonical_vector_points WHERE collection_id = ${row.id} AND id = ANY(${`{${command.ids.join(',')}}`}::uuid[]) ORDER BY id`;
          return { collectionId: row.id, points: rows.map(point => ({ id: point.id, vector: JSON.parse(point.embedding) as number[], metadata: point.metadata })) };
        }
        case 'points.query': {
          const row = await this.collection(tx, authority, command.collectionId); this.check(row, command.vector);
          // Lower is closer for every metric, and equal distances are ordered by ID, so the same query always answers the same way.
          const rows = await tx.unsafe(`SELECT id, (embedding ${OPERATOR[row.metric as keyof typeof OPERATOR]} $1::vector)::float8 AS distance, metadata FROM public.canonical_vector_points
            WHERE collection_id = $2 AND metadata @> $3::text::jsonb ORDER BY distance, id LIMIT $4`, [literal(command.vector), row.id, JSON.stringify(command.filter ?? {}), command.limit ?? 10]);
          return { collectionId: row.id, matches: rows.map((match: Row) => ({ id: match.id, distance: Number(match.distance) + 0, metadata: match.metadata })) };
        }
      }
    });
  }
}

const node = (row: Row): GraphNode => ({ id: row.id, label: row.label, properties: row.properties });
const edge = (row: Row): GraphEdge => ({ id: row.id, source: row.source_id, target: row.target_id, label: row.label, properties: row.properties });

/** One property graph per environment. Walks are breadth-first, one bounded query per level: no graph is ever loaded into memory. */
export class PostgresGraphStore extends PostgresEngine {
  constructor(sql: Bun.SQL, private readonly limits: GraphLimits = { nodes: 100_000, edges: 500_000 }) { super(sql, 'graph'); }

  /**
   * The edges that leave a set of nodes in the requested direction, as (from, to, edge), in a fixed order. `both`
   * follows an edge either way.
   */
  private step(tx: Tx, environmentId: string, frontier: readonly string[], direction: 'out' | 'in' | 'both', label: string | undefined, exclude: readonly string[], limit: number) {
    const ids = `{${frontier.join(',')}}`; const seen = `{${exclude.join(',')}}`;
    const out = `SELECT e.source_id AS origin, e.target_id AS reached, e.id AS edge_id FROM public.canonical_graph_edges e WHERE e.environment_id = $1 AND e.source_id = ANY($2::uuid[]) AND ($3::text IS NULL OR e.label = $3)`;
    const back = `SELECT e.target_id AS origin, e.source_id AS reached, e.id AS edge_id FROM public.canonical_graph_edges e WHERE e.environment_id = $1 AND e.target_id = ANY($2::uuid[]) AND ($3::text IS NULL OR e.label = $3)`;
    const edges = direction === 'out' ? out : direction === 'in' ? back : `${out} UNION ALL ${back}`;
    // One row per newly reached node: the lowest edge into it, so the walk and any path are the same every time.
    return tx.unsafe(`SELECT DISTINCT ON (reached) reached, origin, edge_id FROM (${edges}) hops WHERE NOT reached = ANY($4::uuid[]) ORDER BY reached, edge_id LIMIT $5`, [environmentId, ids, label ?? null, seen, limit]) as Promise<Row[]>;
  }
  private async nodes(tx: Tx, environmentId: string, ids: readonly string[]): Promise<Map<string, GraphNode>> {
    if (!ids.length) return new Map();
    const rows = await tx<Row[]>`SELECT * FROM public.canonical_graph_nodes WHERE environment_id = ${environmentId} AND id = ANY(${`{${ids.join(',')}}`}::uuid[])`;
    return new Map(rows.map(row => [row.id as string, node(row)]));
  }
  private async require(tx: Tx, environmentId: string, id: string, lock = false): Promise<Row> {
    const rows = await tx.unsafe(`SELECT * FROM public.canonical_graph_nodes WHERE environment_id = $1 AND id = $2${lock ? ' FOR UPDATE' : ''}`, [environmentId, id]);
    if (!rows.length) throw new PlatformFault('not_found', 'Node not found');
    return rows[0];
  }

  async execute(authority: NativeDataAuthority, input: GraphCommand): Promise<GraphResult> {
    // IDs are compared as text below, and the database returns them in lower case.
    const command = parseComponent('GraphCommand', JSON.parse(JSON.stringify(input, (_key, value) => typeof value === 'string' && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value) ? value.toLowerCase() : value))); const environmentId = authority.scope.environmentId;
    const source = canonicalEngineRequest('graph', { scope: authority.scope, bindingId: authority.bindingId, command });
    return this.run<GraphCommand, GraphResult>(authority, command, source, async (tx, environment) => {
      const size = (properties: unknown) => { if (Buffer.byteLength(JSON.stringify(properties)) > 8192) throw new PlatformFault('validation', 'Properties exceed the byte limit'); };
      switch (command.kind) {
        case 'node.put': {
          size(command.node.properties);
          const existing = (await tx<Row[]>`SELECT 1 FROM public.canonical_graph_nodes WHERE environment_id = ${environmentId} AND id = ${command.node.id}`).length;
          if (!existing) {
            // Counting is serialized per environment so the limit holds under concurrent writers.
            await tx`SELECT id FROM public.platform_environments WHERE id = ${environment.id} FOR UPDATE`;
            if (Number((await tx<{ count: string }[]>`SELECT count(*)::text AS count FROM public.canonical_graph_nodes WHERE environment_id = ${environmentId}`)[0]!.count) >= this.limits.nodes) throw new PlatformFault('quota', 'This environment has reached its node limit', { quota: 'graph_nodes' });
          }
          await tx`INSERT INTO public.canonical_graph_nodes (environment_id, id, label, properties) VALUES (${environmentId}, ${command.node.id}, ${command.node.label}, ${JSON.stringify(command.node.properties)}::text::jsonb)
            ON CONFLICT (environment_id, id) DO UPDATE SET label = EXCLUDED.label, properties = EXCLUDED.properties, updated_at = now()`;
          return { commandId: command.commandId, nodeId: command.node.id };
        }
        case 'node.delete': {
          await this.require(tx, environmentId, command.nodeId, true);
          const attached = await tx<Row[]>`SELECT id FROM public.canonical_graph_edges WHERE environment_id = ${environmentId} AND (source_id = ${command.nodeId} OR target_id = ${command.nodeId}) FOR UPDATE`;
          // A node with edges is not removed by accident: the caller says so, and its edges go with it.
          if (attached.length && !command.detach) throw new PlatformFault('conflict', 'This node still has edges; delete them or detach');
          if (attached.length) await tx`DELETE FROM public.canonical_graph_edges WHERE environment_id = ${environmentId} AND (source_id = ${command.nodeId} OR target_id = ${command.nodeId})`;
          await tx`DELETE FROM public.canonical_graph_nodes WHERE environment_id = ${environmentId} AND id = ${command.nodeId}`;
          return { commandId: command.commandId, nodeId: command.nodeId, removedEdges: attached.length };
        }
        case 'edge.put': {
          size(command.edge.properties);
          // Both ends are locked so neither can be deleted while the edge is being attached.
          const ends = await tx<Row[]>`SELECT id FROM public.canonical_graph_nodes WHERE environment_id = ${environmentId} AND id IN (${command.edge.source}, ${command.edge.target}) FOR SHARE`;
          if (ends.length !== new Set([command.edge.source, command.edge.target]).size) throw new PlatformFault('conflict', 'Both ends of an edge must be existing nodes');
          const existing = (await tx<Row[]>`SELECT source_id, target_id FROM public.canonical_graph_edges WHERE environment_id = ${environmentId} AND id = ${command.edge.id}`)[0];
          // An edge keeps its ends for life. Connecting different nodes is a different edge.
          if (existing && (existing.source_id !== command.edge.source || existing.target_id !== command.edge.target)) throw new PlatformFault('conflict', 'An edge cannot be moved to other nodes');
          if (!existing) {
            await tx`SELECT id FROM public.platform_environments WHERE id = ${environment.id} FOR UPDATE`;
            if (Number((await tx<{ count: string }[]>`SELECT count(*)::text AS count FROM public.canonical_graph_edges WHERE environment_id = ${environmentId}`)[0]!.count) >= this.limits.edges) throw new PlatformFault('quota', 'This environment has reached its edge limit', { quota: 'graph_edges' });
          }
          await tx`INSERT INTO public.canonical_graph_edges (environment_id, id, source_id, target_id, label, properties)
            VALUES (${environmentId}, ${command.edge.id}, ${command.edge.source}, ${command.edge.target}, ${command.edge.label}, ${JSON.stringify(command.edge.properties)}::text::jsonb)
            ON CONFLICT (environment_id, id) DO UPDATE SET label = EXCLUDED.label, properties = EXCLUDED.properties, updated_at = now()`;
          return { commandId: command.commandId, edgeId: command.edge.id };
        }
        case 'edge.delete': {
          if (!(await tx`DELETE FROM public.canonical_graph_edges WHERE environment_id = ${environmentId} AND id = ${command.edgeId} RETURNING id`).length) throw new PlatformFault('not_found', 'Edge not found');
          return { commandId: command.commandId, edgeId: command.edgeId };
        }
        case 'node.get': return { node: node(await this.require(tx, environmentId, command.nodeId)) };
        case 'neighbors': {
          await this.require(tx, environmentId, command.nodeId); const limit = command.limit ?? 100;
          const out = `SELECT e.*, e.target_id AS other FROM public.canonical_graph_edges e WHERE e.environment_id = $1 AND e.source_id = $2 AND ($3::text IS NULL OR e.label = $3)`;
          const back = `SELECT e.*, e.source_id AS other FROM public.canonical_graph_edges e WHERE e.environment_id = $1 AND e.target_id = $2 AND ($3::text IS NULL OR e.label = $3)`;
          const rows = await tx.unsafe(`SELECT * FROM (${command.direction === 'out' ? out : command.direction === 'in' ? back : `${out} UNION ALL ${back}`}) hops ORDER BY other, id LIMIT $4`, [environmentId, command.nodeId, command.label ?? null, limit + 1]);
          const found = await this.nodes(tx, environmentId, [...new Set<string>(rows.slice(0, limit).map((row: Row) => row.other as string))]);
          return { neighbors: rows.slice(0, limit).map((row: Row) => ({ node: found.get(row.other)!, edge: edge(row) })), truncated: rows.length > limit };
        }
        case 'traverse': {
          await this.require(tx, environmentId, command.nodeId); const limit = command.limit ?? 100;
          const depths = new Map<string, number>([[command.nodeId, 0]]); let frontier = [command.nodeId]; let truncated = false;
          for (let depth = 1; depth <= command.maxDepth && frontier.length && !truncated; depth++) {
            const room = limit - depths.size;
            const hops = await this.step(tx, environmentId, frontier, command.direction, command.label, [...depths.keys()], room + 1);
            if (hops.length > room) truncated = true;
            frontier = hops.slice(0, room).map(hop => hop.reached as string); for (const reached of frontier) depths.set(reached, depth);
          }
          const found = await this.nodes(tx, environmentId, [...depths.keys()]);
          return { reached: [...depths].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1)).map(([id, depth]) => ({ node: found.get(id)!, depth })), truncated };
        }
        case 'path': {
          await this.require(tx, environmentId, command.from); await this.require(tx, environmentId, command.to);
          if (command.from === command.to) return { found: true, nodes: [command.from], edges: [] };
          // Breadth-first, so the first time the target is reached is by a shortest path. Each level is capped; a graph too wide to search within the cap answers "not found within limits".
          const parent = new Map<string, { from: string; edge: string }>(); const seen = new Set<string>([command.from]); let frontier = [command.from];
          for (let depth = 1; depth <= command.maxDepth && frontier.length; depth++) {
            const hops = await this.step(tx, environmentId, frontier, command.direction, command.label, [...seen], 5000);
            frontier = [];
            for (const hop of hops) { seen.add(hop.reached); parent.set(hop.reached, { from: hop.origin, edge: hop.edge_id }); frontier.push(hop.reached); }
            if (parent.has(command.to)) {
              const nodes = [command.to]; const edges: string[] = [];
              for (let at = command.to; at !== command.from;) { const link = parent.get(at)!; edges.unshift(link.edge); nodes.unshift(link.from); at = link.from; }
              return { found: true, nodes, edges };
            }
          }
          return { found: false, nodes: [], edges: [] };
        }
      }
    });
  }
}

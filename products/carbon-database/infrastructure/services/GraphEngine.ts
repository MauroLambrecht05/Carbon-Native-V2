// Property graph database: real Postgres storage for nodes/edges
// (graph_nodes/graph_edges — see 0001_init.sql). Neighbor exploration and
// shortest-path traversal load a project's whole graph into memory and
// run the SAME Dijkstra/adjacency-list algorithm the original in-memory
// engine used — a legitimate, common real-world choice for a small-to-
// medium per-project graph (many real graph-lite features work this way)
// rather than a fragile hand-rolled weighted-shortest-path recursive CTE.
// Documented here, not hidden: this does NOT scale to a graph too large
// to fit in memory — a materially larger piece of work if that's ever
// needed, not attempted here.

export interface GraphNode {
  readonly id: string;
  readonly label: string;
  readonly properties: Record<string, unknown>;
  readonly createdAt: Date;
}

export interface GraphEdge {
  readonly id: string;
  readonly sourceId: string;
  readonly targetId: string;
  readonly relationship: string;
  readonly weight: number;
  readonly properties: Record<string, unknown>;
  readonly createdAt: Date;
}

export class GraphEngine {
  constructor(private readonly sql: Bun.SQL) {}

  async addNode(
    projectId: string,
    id: string,
    label: string,
    properties: Record<string, unknown> = {},
  ): Promise<GraphNode> {
    const existing = await this.getNode(projectId, id);
    if (existing) throw new Error(`Node with id "${id}" already exists in project "${projectId}"`);
    const createdAt = new Date();
    // NOT JSON.stringify — see DatabaseEngine.createTable's comment on why
    // that double-encodes a jsonb column, verified against real Postgres.
    await this.sql`
      INSERT INTO graph_nodes (project_id, id, label, properties, created_at)
      VALUES (${projectId}, ${id}, ${label}, ${properties}::jsonb, ${createdAt})
    `;
    return { id, label, properties, createdAt };
  }

  async getNode(projectId: string, id: string): Promise<GraphNode | undefined> {
    const rows = await this.sql<Array<{ label: string; properties: Record<string, unknown>; created_at: Date }>>`
      SELECT label, properties, created_at FROM graph_nodes WHERE project_id = ${projectId} AND id = ${id}
    `;
    const row = rows[0];
    if (!row) return undefined;
    return { id, label: row.label, properties: row.properties, createdAt: new Date(row.created_at) };
  }

  async addEdge(
    projectId: string,
    sourceId: string,
    targetId: string,
    relationship: string,
    weight = 1,
    properties: Record<string, unknown> = {},
  ): Promise<GraphEdge> {
    if (!(await this.getNode(projectId, sourceId))) throw new Error(`Source node "${sourceId}" does not exist`);
    if (!(await this.getNode(projectId, targetId))) throw new Error(`Target node "${targetId}" does not exist`);

    const id = `edge_${sourceId}_${relationship}_${targetId}_${Date.now()}`;
    const createdAt = new Date();
    await this.sql`
      INSERT INTO graph_edges (project_id, id, source_id, target_id, relationship, weight, properties, created_at)
      VALUES (${projectId}, ${id}, ${sourceId}, ${targetId}, ${relationship}, ${weight}, ${properties}::jsonb, ${createdAt})
    `;
    return { id, sourceId, targetId, relationship, weight, properties, createdAt };
  }

  async getNeighbors(
    projectId: string,
    nodeId: string,
    relationship?: string,
  ): Promise<{ node: GraphNode; edge: GraphEdge }[]> {
    const edges = await this.listEdges(projectId);
    const nodes = await this.listNodes(projectId);
    const nodesById = new Map(nodes.map((n) => [n.id, n]));

    const neighbors: { node: GraphNode; edge: GraphEdge }[] = [];
    for (const edge of edges) {
      if (edge.sourceId !== nodeId) continue;
      if (relationship && edge.relationship !== relationship) continue;
      const target = nodesById.get(edge.targetId);
      if (target) neighbors.push({ node: target, edge });
    }
    return neighbors;
  }

  async findShortestPath(
    projectId: string,
    sourceId: string,
    targetId: string,
  ): Promise<{ path: GraphNode[]; totalWeight: number } | null> {
    const nodes = await this.listNodes(projectId);
    const nodesById = new Map(nodes.map((n) => [n.id, n]));
    if (!nodesById.has(sourceId) || !nodesById.has(targetId)) return null;
    if (sourceId === targetId) return { path: [nodesById.get(sourceId)!], totalWeight: 0 };

    const edges = await this.listEdges(projectId);
    const adjacency = new Map<string, GraphEdge[]>();
    for (const e of edges) {
      const list = adjacency.get(e.sourceId) ?? [];
      list.push(e);
      adjacency.set(e.sourceId, list);
    }

    // Dijkstra's algorithm — same as the original in-memory version.
    const distances = new Map<string, number>();
    const previous = new Map<string, string>();
    const unvisited = new Set<string>();
    for (const n of nodes) {
      distances.set(n.id, Infinity);
      unvisited.add(n.id);
    }
    distances.set(sourceId, 0);

    while (unvisited.size > 0) {
      let current: string | null = null;
      let lowestDist = Infinity;
      for (const nodeId of unvisited) {
        const dist = distances.get(nodeId)!;
        if (dist < lowestDist) {
          lowestDist = dist;
          current = nodeId;
        }
      }
      if (current === null || lowestDist === Infinity) break;
      if (current === targetId) break;
      unvisited.delete(current);

      for (const edge of adjacency.get(current) ?? []) {
        if (!unvisited.has(edge.targetId)) continue;
        const alt = distances.get(current)! + edge.weight;
        if (alt < distances.get(edge.targetId)!) {
          distances.set(edge.targetId, alt);
          previous.set(edge.targetId, current);
        }
      }
    }

    if (!previous.has(targetId)) return null;
    const pathNodes: GraphNode[] = [];
    let curr: string | undefined = targetId;
    while (curr) {
      pathNodes.unshift(nodesById.get(curr)!);
      curr = previous.get(curr);
    }
    return { path: pathNodes, totalWeight: distances.get(targetId)! };
  }

  async listNodes(projectId: string, label?: string): Promise<GraphNode[]> {
    const rows = label
      ? await this.sql<Array<{ id: string; label: string; properties: Record<string, unknown>; created_at: Date }>>`
          SELECT id, label, properties, created_at FROM graph_nodes WHERE project_id = ${projectId} AND label = ${label}
        `
      : await this.sql<Array<{ id: string; label: string; properties: Record<string, unknown>; created_at: Date }>>`
          SELECT id, label, properties, created_at FROM graph_nodes WHERE project_id = ${projectId}
        `;
    return rows.map((r) => ({ id: r.id, label: r.label, properties: r.properties, createdAt: new Date(r.created_at) }));
  }

  async listEdges(projectId: string): Promise<GraphEdge[]> {
    const rows = await this.sql<
      Array<{
        id: string;
        source_id: string;
        target_id: string;
        relationship: string;
        weight: number;
        properties: Record<string, unknown>;
        created_at: Date;
      }>
    >`SELECT id, source_id, target_id, relationship, weight, properties, created_at FROM graph_edges WHERE project_id = ${projectId}`;
    return rows.map((r) => ({
      id: r.id,
      sourceId: r.source_id,
      targetId: r.target_id,
      relationship: r.relationship,
      weight: Number(r.weight),
      properties: r.properties,
      createdAt: new Date(r.created_at),
    }));
  }
}

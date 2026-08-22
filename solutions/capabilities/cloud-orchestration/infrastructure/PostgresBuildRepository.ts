// The real BuildRepository, over Bun's native Postgres client.
//
// claimNext is one statement — `UPDATE ... WHERE id = (SELECT ... FOR UPDATE
// SKIP LOCKED) RETURNING *` — specifically so two workers polling at the same
// instant cannot both come away with the same build. SKIP LOCKED means a
// worker that loses the race sees the row as absent rather than blocking on
// it, so it just gets null back and polls again next tick instead of queuing
// up behind whoever won.
//
// Takes a `Bun.SQL` instance rather than a connection string: the connection
// itself is products/carbon-cloud/infrastructure/persistence's concern (which
// database, pooling), this only knows the `builds` table.

import { INSTALLER_TARGETS, type TargetPlatform } from "@carbon/contracts/distribution";
import { Build, type BuildArtifact, type BuildProps } from "../domain/entities/Build.ts";
import type { BuildStatus } from "../domain/value-objects/BuildStatus.ts";
import type { BuildRepository } from "../application/ports/BuildRepository.ts";

interface Row {
  id: string;
  org_id: string;
  repo_url: string;
  commit_sha: string;
  // string | already-parsed: verified live against a real Postgres that
  // Bun.SQL returns jsonb columns as the raw text, not auto-parsed —
  // toBuild()'s first version assumed the opposite and every GET after a
  // POST silently double-encoded targets/artifacts as a result.
  targets: string[] | string;
  status: BuildStatus;
  worker_id: string | null;
  artifacts: BuildArtifact[] | string;
  error: string | null;
  created_at: Date;
  updated_at: Date;
}

function parseJsonColumn<T>(value: unknown): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

function toBuild(row: Row): Build {
  const props: BuildProps = {
    id: row.id,
    orgId: row.org_id,
    repoUrl: row.repo_url,
    commitSha: row.commit_sha,
    targets: parseJsonColumn<BuildProps["targets"]>(row.targets),
    status: row.status,
    workerId: row.worker_id,
    artifacts: parseJsonColumn<BuildArtifact[]>(row.artifacts),
    error: row.error,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
  return Build.fromProps(props);
}

export class PostgresBuildRepository implements BuildRepository {
  constructor(private readonly sql: Bun.SQL) {}

  async save(build: Build): Promise<void> {
    const p = build.toProps();
    // The raw array, not JSON.stringify(p.targets) — verified live that
    // Bun.SQL already JSON-encodes a JS value bound against a ::jsonb cast.
    // Pre-stringifying double-encodes: the column ends up holding the
    // jsonb STRING '["deb"]' (jsonb_typeof = "string") instead of the
    // jsonb ARRAY ["deb"] (jsonb_typeof = "array"), and every ?| claim
    // query against it silently matches nothing.
    await this.sql`
      INSERT INTO builds (id, org_id, repo_url, commit_sha, targets, status, worker_id, artifacts, error, created_at, updated_at)
      VALUES (${p.id}, ${p.orgId}, ${p.repoUrl}, ${p.commitSha}, ${p.targets}::jsonb,
              ${p.status}, ${p.workerId}, ${p.artifacts}::jsonb, ${p.error}, ${p.createdAt}, ${p.updatedAt})
      ON CONFLICT (id) DO UPDATE SET
        status = EXCLUDED.status,
        worker_id = EXCLUDED.worker_id,
        artifacts = EXCLUDED.artifacts,
        error = EXCLUDED.error,
        updated_at = EXCLUDED.updated_at
    `;
  }

  async findById(id: string): Promise<Build | null> {
    const rows = await this.sql<Row[]>`SELECT * FROM builds WHERE id = ${id}`;
    return rows[0] ? toBuild(rows[0]) : null;
  }

  async claimNext(platform: TargetPlatform, workerId: string, orgId: string): Promise<Build | null> {
    // Precomputed here, not in SQL: the target -> platform mapping is a TS
    // contract (solutions/contracts/distribution), not something the
    // database should know how to reproduce.
    const platformTargets = INSTALLER_TARGETS.filter((t) => t.platform === platform).map((t) => t.id);
    if (platformTargets.length === 0) return null;

    // sql.array(..., "text") specifically — verified live against a real
    // Postgres. Plain string interpolation with a ::text[] cast sends
    // "a,b" and Postgres rejects it as a malformed array literal.
    // sql.array() with no type arg defaults to json[], which `?|` (a
    // jsonb-vs-text[] operator) doesn't have an overload for at all.
    const rows = await this.sql<Row[]>`
      UPDATE builds
      SET status = 'claimed', worker_id = ${workerId}, updated_at = now()
      WHERE id = (
        SELECT id FROM builds
        WHERE status = 'queued' AND org_id = ${orgId} AND targets ?| ${this.sql.array(platformTargets, "text")}
        ORDER BY created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING *
    `;
    return rows[0] ? toBuild(rows[0]) : null;
  }

  async listByOrg(orgId: string, limit: number): Promise<Build[]> {
    const rows = await this.sql<Row[]>`
      SELECT * FROM builds WHERE org_id = ${orgId} ORDER BY created_at DESC LIMIT ${limit}
    `;
    return rows.map(toBuild);
  }
}

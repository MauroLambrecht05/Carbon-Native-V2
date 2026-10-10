import { randomUUID } from "node:crypto";
import { database } from "./database.ts";

export type AuditOutcome = "allowed" | "denied" | "failed";

export interface AuditEvent {
  readonly guildId?: string | null;
  readonly actorId: string;
  readonly action: string;
  readonly targetId?: string | null;
  readonly outcome: AuditOutcome;
  readonly metadata?: Readonly<Record<string, string | number | boolean | null>>;
}

export function recordAudit(event: AuditEvent): string {
  const id = randomUUID();
  database().query(`
    INSERT INTO audit_events(id, guild_id, actor_id, action, target_id, outcome, metadata_json, created_at)
    VALUES ($id, $guildId, $actorId, $action, $targetId, $outcome, $metadata, $createdAt)
  `).run({
    id,
    guildId: event.guildId ?? "direct-message",
    actorId: event.actorId,
    action: event.action,
    targetId: event.targetId ?? null,
    outcome: event.outcome,
    metadata: JSON.stringify(event.metadata ?? {}),
    createdAt: new Date().toISOString(),
  });
  return id;
}

export interface StoredAuditEvent {
  readonly id: string;
  readonly actorId: string;
  readonly action: string;
  readonly targetId?: string;
  readonly outcome: AuditOutcome;
  readonly createdAt: Date;
}

export function recentAuditEvents(guildId: string, limit = 20): StoredAuditEvent[] {
  const safeLimit = Math.max(1, Math.min(limit, 50));
  const rows = database().query(`
    SELECT id, actor_id, action, target_id, outcome, created_at FROM audit_events
    WHERE guild_id = $guildId ORDER BY created_at DESC LIMIT $limit
  `).all({ guildId, limit: safeLimit }) as Array<{
    id: string; actor_id: string; action: string; target_id: string | null; outcome: AuditOutcome; created_at: string;
  }>;
  return rows.map((row) => ({ id: row.id, actorId: row.actor_id, action: row.action, targetId: row.target_id ?? undefined, outcome: row.outcome, createdAt: new Date(row.created_at) }));
}

export function pruneAuditEvents(retentionDays = 365): number {
  const days = Number.isFinite(retentionDays) ? Math.max(30, Math.min(Math.floor(retentionDays), 2_555)) : 365;
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  return database().query("DELETE FROM audit_events WHERE created_at < $cutoff").run({ cutoff }).changes;
}

import { database } from "./database.ts";

export interface RateLimit {
  readonly limit: number;
  readonly windowMs: number;
}

export function consumeRateLimit(guildId: string, userId: string, action: string, policy: RateLimit): boolean {
  const db = database();
  const now = Date.now();
  const cutoff = now - policy.windowMs;
  const transaction = db.transaction(() => {
    db.query("DELETE FROM action_rate_limits WHERE occurred_at < $cutoff").run({ cutoff });
    const row = db.query(`
      SELECT COUNT(*) AS count FROM action_rate_limits
      WHERE guild_id = $guildId AND user_id = $userId AND action = $action AND occurred_at >= $cutoff
    `).get({ guildId, userId, action, cutoff }) as { count: number };
    if (row.count >= policy.limit) return false;
    db.query(`INSERT INTO action_rate_limits(guild_id, user_id, action, occurred_at)
      VALUES ($guildId, $userId, $action, $occurredAt)`)
      .run({ guildId, userId, action, occurredAt: now });
    return true;
  });
  return transaction();
}

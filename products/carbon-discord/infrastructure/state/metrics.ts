import { database } from "./database.ts";

export interface MetricTotal {
  readonly metric: string;
  readonly count: number;
}

export function incrementMetric(guildId: string | null | undefined, metric: string): void {
  const day = new Date().toISOString().slice(0, 10);
  database().query(`
    INSERT INTO daily_metrics(day, guild_id, metric, count) VALUES ($day, $guildId, $metric, 1)
    ON CONFLICT(day, guild_id, metric) DO UPDATE SET count = count + 1
  `).run({ day, guildId: guildId ?? "direct-message", metric: metric.slice(0, 100) });
}

export function metricTotals(guildId: string, days = 30): MetricTotal[] {
  const boundedDays = Math.max(1, Math.min(Math.floor(days), 365));
  const since = new Date(Date.now() - (boundedDays - 1) * 86_400_000).toISOString().slice(0, 10);
  return database().query(`
    SELECT metric, SUM(count) AS count FROM daily_metrics
    WHERE guild_id = $guildId AND day >= $since GROUP BY metric ORDER BY count DESC, metric LIMIT 25
  `).all({ guildId, since }) as MetricTotal[];
}

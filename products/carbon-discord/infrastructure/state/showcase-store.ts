import { database } from "./database.ts";

export class ShowcaseStore {
  nominate(guildId: string, sourceMessageId: string): boolean {
    return database().query(`
      INSERT OR IGNORE INTO showcase_nominations(source_message_id, guild_id, status, created_at)
      VALUES ($sourceMessageId, $guildId, 'pending', $createdAt)
    `).run({ sourceMessageId, guildId, createdAt: new Date().toISOString() }).changes > 0;
  }

  linkReviewMessage(sourceMessageId: string, reviewMessageId: string): void {
    database().query("UPDATE showcase_nominations SET review_message_id = $reviewMessageId WHERE source_message_id = $sourceMessageId")
      .run({ sourceMessageId, reviewMessageId });
  }

  review(sourceMessageId: string, status: "approved" | "rejected", reviewerId: string): boolean {
    return database().query(`
      UPDATE showcase_nominations SET status = $status, reviewed_by = $reviewerId, reviewed_at = $reviewedAt
      WHERE source_message_id = $sourceMessageId AND status = 'pending'
    `).run({ sourceMessageId, status, reviewerId, reviewedAt: new Date().toISOString() }).changes > 0;
  }

  clear(): void {
    database().exec("DELETE FROM showcase_nominations");
  }
}

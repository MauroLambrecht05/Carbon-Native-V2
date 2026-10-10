import { database } from "../../../infrastructure/state/database.ts";

export type VoteType = "up" | "down";

export class SuggestionVoteStore {
  private static instance: SuggestionVoteStore;

  static getInstance(): SuggestionVoteStore {
    if (!SuggestionVoteStore.instance) {
      SuggestionVoteStore.instance = new SuggestionVoteStore();
    }
    return SuggestionVoteStore.instance;
  }

  recordVote(
    messageId: string,
    userId: string,
    type: VoteType,
    guildId = "unknown",
  ): { upVotes: number; downVotes: number; userVote: VoteType | null } {
    const db = database();
    const row = db.query("SELECT vote FROM suggestion_votes WHERE message_id = $messageId AND user_id = $userId")
      .get({ messageId, userId }) as { vote: VoteType } | null;
    const currentVote = row?.vote;
    let newVote: VoteType | null = null;

    if (currentVote === type) {
      db.query("DELETE FROM suggestion_votes WHERE message_id = $messageId AND user_id = $userId")
        .run({ messageId, userId });
      newVote = null;
    } else {
      db.query(`
        INSERT INTO suggestion_votes(message_id, guild_id, user_id, vote, updated_at)
        VALUES ($messageId, $guildId, $userId, $vote, $updatedAt)
        ON CONFLICT(message_id, user_id) DO UPDATE SET vote = excluded.vote, updated_at = excluded.updated_at
      `).run({ messageId, guildId, userId, vote: type, updatedAt: new Date().toISOString() });
      newVote = type;
    }
    return { ...this.getCounts(messageId), userVote: newVote };
  }

  getCounts(messageId: string): { upVotes: number; downVotes: number } {
    const rows = database().query(`
      SELECT vote, COUNT(*) AS count FROM suggestion_votes WHERE message_id = $messageId GROUP BY vote
    `).all({ messageId }) as Array<{ vote: VoteType; count: number }>;
    return {
      upVotes: rows.find((row) => row.vote === "up")?.count ?? 0,
      downVotes: rows.find((row) => row.vote === "down")?.count ?? 0,
    };
  }

  clear(): void {
    database().exec("DELETE FROM suggestion_votes");
  }
}

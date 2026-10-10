import { database } from "../../../infrastructure/state/database.ts";

export interface CommunityIssue {
  readonly id: string;
  readonly title: string;
  readonly component: string;
  readonly environment: string;
  readonly details: string;
  readonly authorId: string;
  readonly authorTag: string;
  status: "Open" | "Confirmed" | "Needs Info" | "Resolved";
  readonly createdAt: Date;
  readonly guildId?: string;
  readonly channelId?: string;
  readonly messageId?: string;
}

interface IssueRow {
  id: string;
  guild_id: string;
  title: string;
  component: string;
  environment: string;
  details: string;
  author_id: string;
  author_tag: string;
  status: CommunityIssue["status"];
  channel_id: string | null;
  message_id: string | null;
  created_at: string;
}

function mapIssue(row: IssueRow): CommunityIssue {
  return {
    id: row.id,
    guildId: row.guild_id,
    title: row.title,
    component: row.component,
    environment: row.environment,
    details: row.details,
    authorId: row.author_id,
    authorTag: row.author_tag,
    status: row.status,
    channelId: row.channel_id ?? undefined,
    messageId: row.message_id ?? undefined,
    createdAt: new Date(row.created_at),
  };
}

export class IssueStore {
  private static instance: IssueStore;

  static getInstance(): IssueStore {
    if (!IssueStore.instance) {
      IssueStore.instance = new IssueStore();
    }
    return IssueStore.instance;
  }

  addIssue(issue: CommunityIssue): void {
    const now = issue.createdAt.toISOString();
    database().query(`
      INSERT INTO community_issues(
        id, guild_id, title, component, environment, details, author_id, author_tag,
        status, channel_id, message_id, created_at, updated_at
      ) VALUES ($id, $guildId, $title, $component, $environment, $details, $authorId,
        $authorTag, $status, $channelId, $messageId, $createdAt, $updatedAt)
    `).run({
      id: issue.id,
      guildId: issue.guildId ?? "unknown",
      title: issue.title,
      component: issue.component,
      environment: issue.environment,
      details: issue.details,
      authorId: issue.authorId,
      authorTag: issue.authorTag,
      status: issue.status,
      channelId: issue.channelId ?? null,
      messageId: issue.messageId ?? null,
      createdAt: now,
      updatedAt: now,
    });
  }

  getIssue(id: string, guildId?: string | null): CommunityIssue | undefined {
    const row = guildId
      ? database().query("SELECT * FROM community_issues WHERE id = $id AND guild_id = $guildId").get({ id, guildId }) as IssueRow | null
      : database().query("SELECT * FROM community_issues WHERE id = $id").get({ id }) as IssueRow | null;
    return row ? mapIssue(row) : undefined;
  }

  searchIssues(query: string, guildId?: string | null): CommunityIssue[] {
    const term = `%${query.toLowerCase().trim()}%`;
    const rows = guildId ? database().query(`
      SELECT * FROM community_issues
      WHERE guild_id = $guildId AND ($term = '%%' OR lower(title) LIKE $term OR lower(component) LIKE $term OR lower(id) LIKE $term)
      ORDER BY created_at DESC LIMIT 25
    `).all({ term, guildId }) : database().query(`
      SELECT * FROM community_issues
      WHERE $term = '%%' OR lower(title) LIKE $term OR lower(component) LIKE $term OR lower(id) LIKE $term
      ORDER BY created_at DESC LIMIT 25
    `).all({ term });
    return (rows as IssueRow[]).map(mapIssue);
  }

  updateStatus(id: string, status: CommunityIssue["status"]): boolean {
    const result = database().query(`
      UPDATE community_issues SET status = $status, updated_at = $updatedAt WHERE id = $id
    `).run({ id, status, updatedAt: new Date().toISOString() });
    return result.changes > 0;
  }

  clear(): void {
    database().exec("DELETE FROM community_issues");
  }
}

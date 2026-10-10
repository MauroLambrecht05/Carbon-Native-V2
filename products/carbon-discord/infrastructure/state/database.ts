import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const isTestProcess = process.env.NODE_ENV === "test" || process.argv.some((value) => value === "test" || value.endsWith(".test.ts"));

function resolveDatabasePath(): string {
  const configured = process.env.DISCORD_DATA_PATH?.trim();
  if (configured) return configured === ":memory:" ? configured : resolve(configured);
  if (isTestProcess) return ":memory:";
  return resolve(import.meta.dir, "../../data/carbon-discord.sqlite");
}

export class DiscordDatabase {
  private static instance: DiscordDatabase | undefined;
  readonly connection: Database;

  static getInstance(): DiscordDatabase {
    this.instance ??= new DiscordDatabase(resolveDatabasePath());
    return this.instance;
  }

  static replaceForTests(path = ":memory:"): DiscordDatabase {
    this.instance?.connection.close();
    this.instance = new DiscordDatabase(path);
    return this.instance;
  }

  static close(): void {
    const current = this.instance;
    if (!current) return;
    try {
      current.connection.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      current.connection.close();
      this.instance = undefined;
    }
  }

  private constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.connection = new Database(path, { create: true, strict: true });
    this.connection.exec("PRAGMA foreign_keys = ON");
    this.connection.exec("PRAGMA busy_timeout = 5000");
    if (path !== ":memory:") this.connection.exec("PRAGMA journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.connection.exec(`
      CREATE TABLE IF NOT EXISTS community_issues (
        id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        title TEXT NOT NULL,
        component TEXT NOT NULL,
        environment TEXT NOT NULL,
        details TEXT NOT NULL,
        author_id TEXT NOT NULL,
        author_tag TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('Open', 'Confirmed', 'Needs Info', 'Resolved')),
        channel_id TEXT,
        message_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS community_issues_search
        ON community_issues(guild_id, status, created_at DESC);

      CREATE TABLE IF NOT EXISTS suggestion_votes (
        message_id TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        vote TEXT NOT NULL CHECK (vote IN ('up', 'down')),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (message_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS support_tickets (
        thread_id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        opener_id TEXT NOT NULL,
        subject TEXT NOT NULL,
        category TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('open', 'closed')),
        claimed_by TEXT,
        created_at TEXT NOT NULL,
        closed_at TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_open_ticket_per_member
        ON support_tickets(guild_id, opener_id) WHERE status = 'open';

      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        action TEXT NOT NULL,
        target_id TEXT,
        outcome TEXT NOT NULL CHECK (outcome IN ('allowed', 'denied', 'failed')),
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS audit_events_recent
        ON audit_events(guild_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS action_rate_limits (
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        action TEXT NOT NULL,
        occurred_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS action_rate_limits_lookup
        ON action_rate_limits(guild_id, user_id, action, occurred_at DESC);

      CREATE TABLE IF NOT EXISTS showcase_nominations (
        source_message_id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        review_message_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
        created_at TEXT NOT NULL,
        reviewed_by TEXT,
        reviewed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS daily_metrics (
        day TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        metric TEXT NOT NULL,
        count INTEGER NOT NULL,
        PRIMARY KEY (day, guild_id, metric)
      );
    `);
  }
}

export function database(): Database {
  return DiscordDatabase.getInstance().connection;
}

export function closeDatabase(): void {
  DiscordDatabase.close();
}

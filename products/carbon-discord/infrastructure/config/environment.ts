const SNOWFLAKE = /^\d{16,22}$/;

export interface DiscordEnvironment {
  readonly botToken: string;
  readonly applicationId?: string;
  readonly guildId?: string;
}

export interface SingleGuildDiscordEnvironment extends DiscordEnvironment {
  readonly guildId: string;
}

function optionalSnowflake(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  if (!value) return undefined;
  if (!SNOWFLAKE.test(value)) throw new Error(`${name} must be a Discord snowflake ID`);
  return value;
}

export function readDiscordEnvironment(env: NodeJS.ProcessEnv = process.env): DiscordEnvironment {
  const botToken = env.DISCORD_BOT_TOKEN?.trim();
  if (!botToken) throw new Error("missing required env var DISCORD_BOT_TOKEN");
  return {
    botToken,
    applicationId: optionalSnowflake(env, "DISCORD_APPLICATION_ID"),
    guildId: optionalSnowflake(env, "DISCORD_GUILD_ID"),
  };
}

export function readSingleGuildEnvironment(env: NodeJS.ProcessEnv = process.env): SingleGuildDiscordEnvironment {
  const parsed = readDiscordEnvironment(env);
  if (!parsed.guildId) throw new Error("missing required env var DISCORD_GUILD_ID");
  return { ...parsed, guildId: parsed.guildId };
}

export function optionalHttpUrl(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env[name]?.trim();
  if (!value) return undefined;
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["localhost", "127.0.0.1"].includes(parsed.hostname))) {
    throw new Error(`${name} must use HTTPS (HTTP is accepted only for localhost)`);
  }
  return parsed.toString();
}

export function validateOptionalConfiguration(env: NodeJS.ProcessEnv = process.env): void {
  const snowflakeNames = [
    "WELCOME_CHANNEL_ID", "VERIFICATION_CHANNEL_ID", "LOG_CHANNEL_ID", "STARTUP_CHANNEL_ID", "SUGGESTIONS_CHANNEL_ID",
    "ISSUES_CHANNEL_ID", "SHOWCASE_REVIEW_CHANNEL_ID", "SHOWCASE_CHANNEL_ID", "MEMBER_ROLE_ID", "ANNOUNCEMENTS_ROLE_ID",
    "RELEASES_ROLE_ID", "PREVIEW_ROLE_ID", "SECURITY_ROLE_ID", "EVENTS_ROLE_ID",
  ];
  for (const name of snowflakeNames) optionalSnowflake(env, name);
  for (const name of ["DOCS_URL", "SECURITY_URL", "PRIVACY_URL", "SUPPORT_POLICY_URL", "STATUS_URL"]) optionalHttpUrl(name, env);
  for (const name of ["SUPPORT_ROLE_IDS", "MODERATOR_ROLE_IDS", "COMMUNITY_MANAGER_ROLE_IDS", "RELEASE_MANAGER_ROLE_IDS", "HELP_FORUM_CHANNEL_IDS"]) {
    for (const value of (env[name] ?? "").split(",").map((part) => part.trim()).filter(Boolean)) {
      if (!SNOWFLAKE.test(value)) throw new Error(`${name} contains an invalid Discord snowflake ID`);
    }
  }
  for (const [name, minimum, maximum] of [
    ["MIN_ACCOUNT_AGE_HOURS", 0, 720],
    ["SHOWCASE_NOMINATION_THRESHOLD", 1, 100],
    ["AUDIT_RETENTION_DAYS", 30, 2_555],
  ] as const) {
    const value = env[name]?.trim();
    if (!value) continue;
    const number = Number(value);
    if (!Number.isInteger(number) || number < minimum || number > maximum) {
      throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
    }
  }

  const healthPort = env.HEALTH_PORT?.trim();
  if (healthPort) {
    const number = Number(healthPort);
    if (!Number.isInteger(number) || number < 1 || number > 65_535) {
      throw new Error("HEALTH_PORT must be an integer from 1 to 65535");
    }
  }
  const unreadyRestartSeconds = env.DISCORD_UNREADY_RESTART_SECONDS?.trim();
  if (unreadyRestartSeconds) {
    const number = Number(unreadyRestartSeconds);
    if (!Number.isInteger(number) || number < 30 || number > 3_600) {
      throw new Error("DISCORD_UNREADY_RESTART_SECONDS must be an integer from 30 to 3600");
    }
  }
}

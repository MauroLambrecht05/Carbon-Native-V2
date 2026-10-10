import { describe, expect, test } from "bun:test";
import { optionalHttpUrl, readDiscordEnvironment, readSingleGuildEnvironment, validateOptionalConfiguration } from "../../infrastructure/config/environment.ts";

describe("Discord environment", () => {
  test("requires the bot credential and validates Discord IDs", () => {
    expect(() => readDiscordEnvironment({})).toThrow("DISCORD_BOT_TOKEN");
    expect(() => validateOptionalConfiguration({ MEMBER_ROLE_ID: "member-role" })).toThrow("snowflake");
    expect(() => validateOptionalConfiguration({ MEMBER_ROLE_ID: "123456789012345678" })).not.toThrow();
  });

  test("requires one explicit production guild and validates runtime bounds", () => {
    expect(() => readSingleGuildEnvironment({ DISCORD_BOT_TOKEN: "token" })).toThrow("DISCORD_GUILD_ID");
    expect(readSingleGuildEnvironment({
      DISCORD_BOT_TOKEN: "token",
      DISCORD_GUILD_ID: "123456789012345678",
    }).guildId).toBe("123456789012345678");
    expect(() => validateOptionalConfiguration({ HEALTH_PORT: "70000" })).toThrow("HEALTH_PORT");
    expect(() => validateOptionalConfiguration({ DISCORD_UNREADY_RESTART_SECONDS: "10" })).toThrow("DISCORD_UNREADY_RESTART_SECONDS");
  });

  test("accepts HTTPS and rejects insecure remote resource URLs", () => {
    expect(optionalHttpUrl("DOCS_URL", { DOCS_URL: "https://docs.example.com" })).toBe("https://docs.example.com/");
    expect(() => optionalHttpUrl("DOCS_URL", { DOCS_URL: "http://docs.example.com" })).toThrow("HTTPS");
    expect(optionalHttpUrl("DOCS_URL", { DOCS_URL: "http://localhost:3000" })).toBe("http://localhost:3000/");
  });
});

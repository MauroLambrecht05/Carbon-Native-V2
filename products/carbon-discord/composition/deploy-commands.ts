#!/usr/bin/env bun
// One-off script: pushes the registry's command metadata to Discord so each
// one actually shows up in the client's slash-command picker. Logging in
// with the gateway doesn't register anything, Discord only learns about a
// command from this PUT. Run it again whenever composition/commands.ts
// changes.
//
// Global commands (no DISCORD_GUILD_ID) can take up to an hour to propagate;
// set DISCORD_GUILD_ID during development for registration scoped to one
// server, which is near-instant.

import { REST, Routes, SlashCommandBuilder } from "discord.js";
import { buildCommandRegistry } from "./commands.ts";

export interface DeployConfig {
  readonly applicationId: string;
  readonly botToken: string;
  readonly guildId?: string;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): DeployConfig {
  const required = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`missing required env var ${name}`);
    return value;
  };
  return {
    applicationId: required("DISCORD_APPLICATION_ID"),
    botToken: required("DISCORD_BOT_TOKEN"),
    guildId: env.DISCORD_GUILD_ID,
  };
}

export async function deployCommands(config: DeployConfig): Promise<void> {
  const commands = await Promise.all(
    buildCommandRegistry()
      .all()
      .map(async (descriptor) => {
        const command = await descriptor.load();
        const builder = new SlashCommandBuilder()
          .setName(descriptor.meta.name)
          .setDescription(descriptor.meta.description);
        command.configureBuilder?.(builder);
        return builder.toJSON();
      }),
  );

  const rest = new REST().setToken(config.botToken);
  const route = config.guildId
    ? Routes.applicationGuildCommands(config.applicationId, config.guildId)
    : Routes.applicationCommands(config.applicationId);

  const registered = (await rest.put(route, { body: commands })) as unknown[];

  const scope = config.guildId ? `guild ${config.guildId}` : "globally (may take up to an hour to appear)";
  console.log(`registered ${registered.length} command(s): ${commands.map((c) => c.name).join(", ")} (${scope})`);
}

if (import.meta.main) {
  await deployCommands(configFromEnv());
}

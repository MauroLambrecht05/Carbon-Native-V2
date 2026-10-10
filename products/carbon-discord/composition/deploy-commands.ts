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
import { STAFF_COMMANDS } from "./command-access.ts";
import { readSingleGuildEnvironment } from "../infrastructure/config/environment.ts";

export interface DeployConfig {
  readonly applicationId: string;
  readonly botToken: string;
  readonly guildId: string;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): DeployConfig {
  const parsed = readSingleGuildEnvironment(env);
  if (!parsed.applicationId) throw new Error("missing required env var DISCORD_APPLICATION_ID");
  return {
    applicationId: parsed.applicationId,
    botToken: parsed.botToken,
    guildId: parsed.guildId,
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
        if (STAFF_COMMANDS.has(descriptor.meta.name)) builder.setDefaultMemberPermissions(0n);
        command.configureBuilder?.(builder);
        return builder.toJSON();
      }),
  );

  const rest = new REST().setToken(config.botToken);
  const route = Routes.applicationGuildCommands(config.applicationId, config.guildId);

  const registered = (await rest.put(route, { body: commands })) as unknown[];

  console.log(`registered ${registered.length} command(s): ${commands.map((c) => c.name).join(", ")} (guild ${config.guildId})`);
}

if (import.meta.main) {
  await deployCommands(configFromEnv());
}

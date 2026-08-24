// Live, because every number here is read at call time from the actual
// gateway connection, not a cached or hand-maintained value. Deliberately
// scoped to what the bot itself can attest to; it does not claim anything
// about carbon-cloud or a build queue, since no live deployment of either is
// wired up yet. Extend this once one exists, rather than faking it now.

import type { ChatInputCommandInteraction } from "discord.js";
import { EmbedBuilder } from "discord.js";
import { Command, type CommandMeta } from "../../framework/command.ts";

export class StatusCommand extends Command {
  readonly meta: CommandMeta = {
    name: "status",
    description: "Show the bot's live connection status",
  };

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const client = interaction.client;
    const ping = client.ws.ping;

    const embed = new EmbedBuilder()
      .setTitle("carbon-discord: status")
      .setColor(0x2b7a4b)
      .addFields(
        { name: "Gateway ping", value: ping >= 0 ? `${ping}ms` : "calculating…", inline: true },
        { name: "Uptime", value: formatDuration(client.uptime ?? 0), inline: true },
        { name: "Servers", value: String(client.guilds.cache.size), inline: true },
      )
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
  }
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (parts.length === 0) parts.push(`${seconds}s`);
  return parts.join(" ");
}

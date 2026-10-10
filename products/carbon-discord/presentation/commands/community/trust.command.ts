import { EmbedBuilder, type ChatInputCommandInteraction } from "discord.js";
import { optionalHttpUrl } from "../../../infrastructure/config/environment.ts";
import { Command, type CommandMeta } from "../../framework/command.ts";

const RESOURCES = [
  ["Security", "SECURITY_URL"],
  ["Privacy", "PRIVACY_URL"],
  ["Support policy", "SUPPORT_POLICY_URL"],
  ["Service status", "STATUS_URL"],
] as const;

export class TrustCommand extends Command {
  readonly meta: CommandMeta = { name: "trust", description: "View Carbon security, privacy, support, and status resources" };

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const links = RESOURCES.flatMap(([label, variable]) => {
      const url = optionalHttpUrl(variable);
      return url ? [`• [${label}](${url})`] : [];
    });
    const description = links.length > 0
      ? links.join("\n")
      : "Carbon's public trust resources have not been published yet. No placeholder claims are shown.";
    await interaction.reply({ embeds: [new EmbedBuilder().setTitle("Carbon trust resources").setDescription(description).setColor(0x2b7a4b)], ephemeral: true });
  }
}

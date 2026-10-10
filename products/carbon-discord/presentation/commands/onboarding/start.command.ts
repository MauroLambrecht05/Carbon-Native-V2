import { EmbedBuilder, type ChatInputCommandInteraction } from "discord.js";
import { Command, type CommandMeta } from "../../framework/command.ts";

export class StartCommand extends Command {
  readonly meta: CommandMeta = { name: "start", description: "Get oriented and take the next useful Carbon step" };

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const embed = new EmbedBuilder()
      .setTitle("Start with Carbon")
      .setColor(0x00e599)
      .setDescription(
        "**Evaluating Carbon?** Use `/docs` and `/download` for current public resources.\n\n" +
        "**Building with Carbon?** Ask a focused question in the help forum and include your Carbon version, OS, architecture, expected result, and smallest reproduction.\n\n" +
        "**Need private help?** Use `/support`. Never post credentials, private keys, customer data, or confidential logs.\n\n" +
        "**Want product updates?** Choose your notification preferences in Channels & Roles or the server's preference panel.",
      )
      .setFooter({ text: "Carbon staff will never request API tokens through Discord" });
    await interaction.reply({ embeds: [embed], ephemeral: true });
  }
}

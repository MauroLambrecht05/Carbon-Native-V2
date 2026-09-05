import {
  ActionRowBuilder,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ChatInputCommandInteraction,
  type SlashCommandBuilder,
} from "discord.js";
import { Command, type CommandMeta } from "../../framework/command.ts";
import { IssueStore } from "./issue-store.ts";

export class IssueCommand extends Command {
  readonly meta: CommandMeta = {
    name: "issue",
    description: "Report or search community bug reports and issues",
  };

  configureBuilder(builder: SlashCommandBuilder): void {
    builder
      .addSubcommand((sub) =>
        sub.setName("create").setDescription("Report a new bug or unexpected behavior"),
      )
      .addSubcommand((sub) =>
        sub
          .setName("search")
          .setDescription("Search existing community issues")
          .addStringOption((opt) =>
            opt
              .setName("query")
              .setDescription("Issue title or ID")
              .setRequired(true)
              .setAutocomplete(true),
          ),
      );
  }

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const subcommand = interaction.options.getSubcommand(false) || "create";

    if (subcommand === "create") {
      const modal = new ModalBuilder()
        .setCustomId("modal:issue-create")
        .setTitle("Report Community Bug / Issue");

      const titleInput = new TextInputBuilder()
        .setCustomId("issue-title")
        .setLabel("Issue Summary")
        .setStyle(TextInputStyle.Short)
        .setPlaceholder("e.g. Memory leak in Zig dynamic extension loader")
        .setRequired(true)
        .setMinLength(5)
        .setMaxLength(100);

      const componentInput = new TextInputBuilder()
        .setCustomId("issue-component")
        .setLabel("Affected Component")
        .setStyle(TextInputStyle.Short)
        .setPlaceholder("Runtime / CLI / Cloud / Plugins / Other")
        .setRequired(true)
        .setMaxLength(50);

      const envInput = new TextInputBuilder()
        .setCustomId("issue-env")
        .setLabel("OS & Architecture")
        .setStyle(TextInputStyle.Short)
        .setPlaceholder("Windows x64 / macOS arm64 / Linux x64")
        .setRequired(true)
        .setMaxLength(60);

      const detailsInput = new TextInputBuilder()
        .setCustomId("issue-details")
        .setLabel("Reproduction Steps & Logs")
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder("1. Run carbon build\n2. Observe crash backtrace...")
        .setRequired(true)
        .setMinLength(15)
        .setMaxLength(1000);

      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(titleInput),
        new ActionRowBuilder<TextInputBuilder>().addComponents(componentInput),
        new ActionRowBuilder<TextInputBuilder>().addComponents(envInput),
        new ActionRowBuilder<TextInputBuilder>().addComponents(detailsInput),
      );

      await interaction.showModal(modal);
      return;
    }

    if (subcommand === "search") {
      const query = interaction.options.getString("query", true);
      const store = IssueStore.getInstance();
      const issue = store.getIssue(query) || store.searchIssues(query)[0];

      if (!issue) {
        await interaction.reply({
          content: `No issue matching "${query}" found. Use \`/issue create\` to report a new one.`,
          ephemeral: true,
        });
        return;
      }

      const statusEmoji =
        issue.status === "Confirmed"
          ? "🔴"
          : issue.status === "Resolved"
            ? "🟢"
            : issue.status === "Needs Info"
              ? "🟠"
              : "🟡";

      const embed = new EmbedBuilder()
        .setTitle(`🐛 [${issue.id}] ${issue.title}`)
        .setColor(issue.status === "Resolved" ? 0x00e599 : 0xed4245)
        .setDescription(issue.details)
        .addFields(
          { name: "Component", value: issue.component, inline: true },
          { name: "Environment", value: issue.environment, inline: true },
          { name: "Status", value: `${statusEmoji} **${issue.status}**`, inline: true },
          { name: "Reported By", value: `<@${issue.authorId}>`, inline: true },
        )
        .setFooter({ text: "Carbon Community Bug Tracker" })
        .setTimestamp(issue.createdAt);

      await interaction.reply({
        embeds: [embed],
      });
    }
  }
}

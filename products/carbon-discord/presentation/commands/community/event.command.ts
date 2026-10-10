import {
  EmbedBuilder,
  GuildScheduledEventEntityType,
  GuildScheduledEventPrivacyLevel,
  type ChatInputCommandInteraction,
  type SlashCommandBuilder,
} from "discord.js";
import { recordAudit } from "../../../infrastructure/state/audit-log.ts";
import { Command, type CommandMeta } from "../../framework/command.ts";
import { requireStaff } from "../../security/authorization.ts";
import { safeUserText } from "../../security/content.ts";

export class EventCommand extends Command {
  readonly meta: CommandMeta = { name: "event", description: "Create or view official Carbon community events" };

  configureBuilder(builder: SlashCommandBuilder): void {
    builder
      .addSubcommand((sub) => sub
        .setName("create")
        .setDescription("Create a Discord scheduled event")
        .addStringOption((opt) => opt.setName("title").setDescription("Event title").setRequired(true).setMaxLength(100))
        .addStringOption((opt) => opt.setName("description").setDescription("Agenda and intended audience").setRequired(true).setMaxLength(1000))
        .addStringOption((opt) => opt.setName("starts_at").setDescription("ISO 8601 time, for example 2026-10-02T18:00:00Z").setRequired(true))
        .addStringOption((opt) => opt.setName("location").setDescription("Stage, meeting URL, or venue").setRequired(true).setMaxLength(100)))
      .addSubcommand((sub) => sub.setName("list").setDescription("View upcoming Discord scheduled events"));
  }

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const subcommand = interaction.options.getSubcommand(false) || "list";
    if (subcommand === "create") {
      if (!(await requireStaff(interaction, "community", "event.create"))) return;
      if (!interaction.guild) {
        await interaction.reply({ content: "Events must be created inside the Carbon server.", ephemeral: true });
        return;
      }
      const startsAt = new Date(interaction.options.getString("starts_at", true));
      if (!Number.isFinite(startsAt.getTime()) || startsAt.getTime() < Date.now() + 5 * 60_000) {
        await interaction.reply({ content: "`starts_at` must be a valid ISO 8601 time at least five minutes in the future.", ephemeral: true });
        return;
      }
      const title = safeUserText(interaction.options.getString("title", true), 100);
      const description = safeUserText(interaction.options.getString("description", true), 1_000);
      const location = safeUserText(interaction.options.getString("location", true), 100);
      const event = await interaction.guild.scheduledEvents.create({
        name: title,
        description,
        scheduledStartTime: startsAt,
        scheduledEndTime: new Date(startsAt.getTime() + 60 * 60_000),
        privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
        entityType: GuildScheduledEventEntityType.External,
        entityMetadata: { location },
        reason: `Created by ${interaction.user.tag}`,
      });
      recordAudit({ guildId: interaction.guildId, actorId: interaction.user.id, action: "event.create", targetId: event.id, outcome: "allowed", metadata: { title, startsAt: startsAt.toISOString() } });
      await interaction.reply({ content: `Created **${title}** for <t:${Math.floor(startsAt.getTime() / 1000)}:F>. Members can register through Discord's event controls.`, ephemeral: true });
      return;
    }

    if (!interaction.guild) {
      await interaction.reply({ content: "Events are available inside the Carbon server.", ephemeral: true });
      return;
    }
    const events = await interaction.guild.scheduledEvents.fetch();
    const description = events.size === 0
      ? "No upcoming events are scheduled."
      : Array.from(events.values()).sort((a, b) => (a.scheduledStartTimestamp ?? 0) - (b.scheduledStartTimestamp ?? 0)).slice(0, 10)
        .map((event) => `• **${event.name}** — <t:${Math.floor((event.scheduledStartTimestamp ?? 0) / 1000)}:F> ([open](${event.url}))`).join("\n");
    await interaction.reply({ embeds: [new EmbedBuilder().setTitle("Upcoming Carbon events").setDescription(description).setColor(0x5865f2)], ephemeral: true });
  }
}

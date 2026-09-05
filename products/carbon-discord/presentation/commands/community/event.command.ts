import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionsBitField,
  type ChatInputCommandInteraction,
  type SlashCommandBuilder,
} from "discord.js";
import { Command, type CommandMeta } from "../../framework/command.ts";

export class EventCommand extends Command {
  readonly meta: CommandMeta = {
    name: "event",
    description: "Create or view scheduled community events and meetups",
  };

  configureBuilder(builder: SlashCommandBuilder): void {
    builder
      .addSubcommand((sub) =>
        sub
          .setName("create")
          .setDescription("Schedule a community town hall, workshop, or meetup")
          .addStringOption((opt) =>
            opt.setName("title").setDescription("Event headline").setRequired(true),
          )
          .addStringOption((opt) =>
            opt.setName("description").setDescription("Event agenda and topics").setRequired(true),
          )
          .addStringOption((opt) =>
            opt.setName("time").setDescription("Date & time (e.g. Friday 18:00 UTC)").setRequired(true),
          )
          .addStringOption((opt) =>
            opt.setName("location").setDescription("Venue / Voice channel link").setRequired(false),
          ),
      )
      .addSubcommand((sub) =>
        sub.setName("list").setDescription("View upcoming community events"),
      );
  }

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const subcommand = interaction.options.getSubcommand(false) || "list";

    if (subcommand === "create") {
      if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
        await interaction.reply({
          content: "You need Administrator permissions to schedule official community events.",
          ephemeral: true,
        });
        return;
      }

      const title = interaction.options.getString("title", true);
      const description = interaction.options.getString("description", true);
      const time = interaction.options.getString("time", true);
      const location = interaction.options.getString("location") || "Discord Voice / Stage Channel";

      const eventId = `evt-${Date.now().toString().slice(-6)}`;

      const embed = new EmbedBuilder()
        .setTitle(`📅 Community Event: ${title}`)
        .setColor(0x5865f2)
        .setDescription(description)
        .addFields(
          { name: "⏰ Scheduled Time", value: `**${time}**`, inline: true },
          { name: "📍 Location / Stage", value: location, inline: true },
          { name: "👥 Attendees", value: "0 members registered", inline: false },
        )
        .setFooter({ text: "Carbon Community Events • Click RSVP to reserve your spot" })
        .setTimestamp();

      const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`event:rsvp:${eventId}`)
          .setLabel("RSVP (0)")
          .setStyle(ButtonStyle.Primary)
          .setEmoji("🎟️"),
      );

      if (interaction.channel && "send" in interaction.channel) {
        await (interaction.channel as unknown as { send: (options: unknown) => Promise<unknown> }).send({
          embeds: [embed],
          components: [actionRow],
        });
      }

      await interaction.reply({
        content: `Event **${title}** scheduled successfully.`,
        ephemeral: true,
      });
      return;
    }

    if (subcommand === "list") {
      let eventsSummary = "No upcoming events scheduled.";

      if (interaction.guild?.scheduledEvents) {
        try {
          const events = await interaction.guild.scheduledEvents.fetch();
          if (events.size > 0) {
            eventsSummary = Array.from(events.values())
              .map((e) => `• **${e.name}** — ${e.scheduledStartAt ? e.scheduledStartAt.toUTCString() : "TBD"}`)
              .join("\n");
          }
        } catch {
          // ignore error fetching scheduled events
        }
      }

      const embed = new EmbedBuilder()
        .setTitle("📅 Upcoming Carbon Native Events")
        .setColor(0x00e599)
        .setDescription(eventsSummary)
        .setTimestamp();

      await interaction.reply({
        embeds: [embed],
        ephemeral: true,
      });
    }
  }
}

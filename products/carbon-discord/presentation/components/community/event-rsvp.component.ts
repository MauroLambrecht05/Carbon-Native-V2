import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type MessageComponentInteraction,
} from "discord.js";
import { Component, type ComponentMeta } from "../../framework/component.ts";
import { EventRsvpStore } from "./event-rsvp-store.ts";

export class EventRsvpComponent extends Component {
  readonly meta: ComponentMeta = { customId: "event:rsvp:", isPrefix: true };

  async execute(interaction: MessageComponentInteraction): Promise<void> {
    const eventId = interaction.customId.replace("event:rsvp:", "");
    const store = EventRsvpStore.getInstance();
    const { attending, total, attendees } = store.toggleRsvp(eventId, interaction.user.id);

    const originalEmbed = interaction.message.embeds[0];
    if (originalEmbed) {
      const updatedEmbed = EmbedBuilder.from(originalEmbed);
      const fields = (originalEmbed.fields || []).map((f) => {
        if (f.name === "👥 Attendees") {
          const sampleList =
            attendees.length > 0
              ? `${total} members registered (${attendees.slice(0, 5).map((id) => `<@${id}>`).join(", ")}${total > 5 ? ` +${total - 5} more` : ""})`
              : "0 members registered";
          return { name: "👥 Attendees", value: sampleList, inline: false };
        }
        return f;
      });
      updatedEmbed.setFields(fields);

      const updatedRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`event:rsvp:${eventId}`)
          .setLabel(`RSVP (${total})`)
          .setStyle(attending ? ButtonStyle.Success : ButtonStyle.Primary)
          .setEmoji(attending ? "✅" : "🎟️"),
      );

      if (interaction.update) {
        await interaction.update({
          embeds: [updatedEmbed],
          components: [updatedRow],
        });
        return;
      }
    }

    await interaction.reply({
      content: attending
        ? `✅ You have RSVP'd to this event! (${total} attending)`
        : `You have removed your RSVP. (${total} attending)`,
      ephemeral: true,
    });
  }
}

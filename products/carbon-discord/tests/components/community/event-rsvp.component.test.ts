import { describe, expect, mock, test, beforeEach } from "bun:test";
import { EmbedBuilder, type MessageComponentInteraction } from "discord.js";
import { EventRsvpComponent } from "../../../presentation/components/community/event-rsvp.component.ts";
import { EventRsvpStore } from "../../../presentation/components/community/event-rsvp-store.ts";

describe("EventRsvpComponent", () => {
  beforeEach(() => {
    EventRsvpStore.getInstance().clear();
  });

  test("records RSVP and updates message embed", async () => {
    const component = new EventRsvpComponent();
    const sampleEmbed = new EmbedBuilder()
      .setTitle("📅 Sample Event")
      .addFields({ name: "👥 Attendees", value: "0 members registered", inline: false });

    const interaction = {
      customId: "event:rsvp:evt-12345",
      user: { id: "user-100" },
      message: {
        embeds: [sampleEmbed],
      },
      update: mock(() => Promise.resolve()),
      reply: mock(() => Promise.resolve()),
    } as unknown as MessageComponentInteraction;

    await component.execute(interaction);

    expect(interaction.update).toHaveBeenCalledWith(
      expect.objectContaining({
        embeds: expect.any(Array),
        components: expect.any(Array),
      }),
    );

    const attendees = EventRsvpStore.getInstance().getAttendees("evt-12345");
    expect(attendees).toContain("user-100");
  });
});

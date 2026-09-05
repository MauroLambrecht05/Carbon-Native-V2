import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  Events,
  type ThreadChannel,
} from "discord.js";
import { BotEvent, type EventMeta } from "../../framework/event.ts";

export class ThreadCreateEvent extends BotEvent {
  readonly meta: EventMeta = { name: Events.ThreadCreate };

  async handle(...args: unknown[]): Promise<void> {
    const [thread, newlyCreated] = args as [ThreadChannel, boolean | undefined];
    if (!thread || !thread.isThread()) return;

    // Send guidance notice in newly spawned threads
    const embed = new EmbedBuilder()
      .setTitle("💡 Carbon Native Troubleshooting & Help")
      .setColor(0x00e599)
      .setDescription(
        "Welcome to your help thread! To help fellow developers troubleshoot quickly:\n\n" +
          "• Mention your **OS & architecture** (e.g. Windows x64, macOS Apple Silicon)\n" +
          "• Include relevant compiler flags or `.bazelrc` profiles\n" +
          "• Paste minimal reproduction code or error backtraces\n\n" +
          "When your inquiry has been answered, click **Mark as Resolved** below or run `/resolve`.",
      )
      .setFooter({ text: "Carbon Community Help Assistant" });

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("thread:resolve")
        .setLabel("Mark as Resolved")
        .setStyle(ButtonStyle.Success)
        .setEmoji("✅"),
    );

    try {
      await thread.send({
        embeds: [embed],
        components: [row],
      });
    } catch (err) {
      console.warn("Could not post auto-guidance to thread:", err);
    }
  }
}

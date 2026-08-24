// Formalizes what used to be an inline client.once(Events.ClientReady, ...)
// in composition/entrypoint.ts. Fires once, on login: logs the bot's tag to
// the console for whoever is operating this process, and, if
// STARTUP_CHANNEL_ID is configured, separately announces to a real Discord
// channel. The two messages are deliberately different: the console line is
// an operator-facing fact (which account logged in); the channel message is
// a product-facing one (Carbon, not "carbon-discord" or a bot username, is
// online) and says nothing a member of the server has any reason to care
// about, like a Discord tag.

import type { Client } from "discord.js";
import { ChannelType, Events } from "discord.js";
import { BotEvent, type EventMeta } from "../../framework/event.ts";

export class ReadyEvent extends BotEvent {
  readonly meta: EventMeta = { name: Events.ClientReady, once: true };

  async handle(...args: unknown[]): Promise<void> {
    // ClientEvents["clientReady"] is `[client: Client<true>]`.
    const [client] = args as [Client<true>];
    console.log(`carbon-discord logged in as ${client.user.tag}`);
    await this.announce(client);
  }

  private async announce(client: Client<true>): Promise<void> {
    const channelId = process.env.STARTUP_CHANNEL_ID;
    if (!channelId) return; // not configured: a deliberate no-op, not an error

    const channel = await client.channels.fetch(channelId);
    if (!channel || channel.type !== ChannelType.GuildText) {
      console.error(`STARTUP_CHANNEL_ID ${channelId} is not a postable guild text channel`);
      return;
    }

    const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
    await channel.send(`${time} | Carbon is online. Try /help to see what it can do.`);
  }
}

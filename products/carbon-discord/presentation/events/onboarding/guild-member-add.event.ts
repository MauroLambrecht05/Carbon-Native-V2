import { ChannelType, Events, type GuildMember } from "discord.js";
import { BotEvent, type EventMeta } from "../../framework/event.ts";

export const DEFAULT_MIN_ACCOUNT_AGE_HOURS = 72;

export class GuildMemberAddEvent extends BotEvent {
  readonly meta: EventMeta = { name: Events.GuildMemberAdd };

  async handle(...args: unknown[]): Promise<void> {
    const [member] = args as [GuildMember];
    if (!member || !member.user) return;

    const minAgeHours = Number(process.env.MIN_ACCOUNT_AGE_HOURS) || DEFAULT_MIN_ACCOUNT_AGE_HOURS;
    const accountAgeMs = Date.now() - member.user.createdTimestamp;
    const minAgeMs = minAgeHours * 60 * 60 * 1000;

    if (accountAgeMs < minAgeMs) {
      await this.handleSuspiciousJoin(member, Math.floor(accountAgeMs / (1000 * 60 * 60)));
    } else {
      await this.handleRegularJoin(member);
    }
  }

  private async handleSuspiciousJoin(member: GuildMember, hoursOld: number): Promise<void> {
    const logChannelId = process.env.LOG_CHANNEL_ID || process.env.QUARANTINE_CHANNEL_ID;
    if (!logChannelId) return;

    try {
      const channel = await member.guild.channels.fetch(logChannelId);
      if (channel && channel.type === ChannelType.GuildText) {
        await channel.send(
          `🛡️ **Anti-Raid Flag**: User <@${member.id}> (${member.user.tag}) joined with an account created only ${hoursOld} hours ago. ` +
            `Direct access withheld until verification is completed.`,
        );
      }
    } catch (err) {
      console.error("Failed to log suspicious join:", err);
    }
  }

  private async handleRegularJoin(member: GuildMember): Promise<void> {
    const welcomeChannelId = process.env.WELCOME_CHANNEL_ID;
    if (!welcomeChannelId) return;

    try {
      const channel = await member.guild.channels.fetch(welcomeChannelId);
      if (channel && channel.type === ChannelType.GuildText) {
        await channel.send(
          `👋 Welcome <@${member.id}> to **Carbon Native**! Please complete verification in <#${process.env.VERIFICATION_CHANNEL_ID || "verification"}> to unlock all channels.`,
        );
      }
    } catch (err) {
      console.error("Failed to send welcome message:", err);
    }
  }
}

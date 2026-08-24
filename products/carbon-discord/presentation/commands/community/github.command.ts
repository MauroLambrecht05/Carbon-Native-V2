// Reads GITHUB_REPO ("owner/name") rather than hardcoding a URL.
// .config/_identity.json's "homepage" (github.com/carbon-native/carbon)
// 404s: it's aspirational metadata, not a real repository, so this command
// stays unconfigured (and says so) until a real one exists, instead of
// linking somewhere that doesn't resolve.

import type { ChatInputCommandInteraction } from "discord.js";
import { EmbedBuilder } from "discord.js";
import { Command, type CommandMeta } from "../../framework/command.ts";

interface GithubRepo {
  readonly full_name: string;
  readonly html_url: string;
  readonly description: string | null;
  readonly stargazers_count: number;
  readonly open_issues_count: number;
  readonly forks_count: number;
  readonly language: string | null;
}

export class GithubCommand extends Command {
  readonly meta: CommandMeta = {
    name: "github",
    description: "Look up the Carbon Native repository on GitHub",
  };

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const repo = process.env.GITHUB_REPO;
    if (!repo) {
      await interaction.reply("The GitHub repository isn't public yet. Nothing to link to.");
      return;
    }

    // GitHub's API is a real network round trip; defer so Discord doesn't
    // time out the 3-second initial-ack window while it's in flight.
    await interaction.deferReply();

    const response = await fetch(`https://api.github.com/repos/${repo}`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "carbon-discord" },
    });

    if (response.status === 404) {
      await interaction.editReply(`Configured repository \`${repo}\` was not found. Check GITHUB_REPO.`);
      return;
    }
    if (!response.ok) {
      await interaction.editReply(`GitHub API returned ${response.status}. Try again in a moment.`);
      return;
    }

    const data = (await response.json()) as GithubRepo;

    const embed = new EmbedBuilder()
      .setTitle(data.full_name)
      .setURL(data.html_url)
      .setDescription(data.description ?? "No description")
      .setColor(0x24292f)
      .addFields(
        { name: "⭐ Stars", value: String(data.stargazers_count), inline: true },
        { name: "🐛 Open issues", value: String(data.open_issues_count), inline: true },
        { name: "🍴 Forks", value: String(data.forks_count), inline: true },
      );
    if (data.language) {
      embed.addFields({ name: "Language", value: data.language, inline: true });
    }

    await interaction.editReply({ embeds: [embed] });
  }
}

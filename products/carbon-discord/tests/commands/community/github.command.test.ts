import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ChatInputCommandInteraction } from "discord.js";
import type { EmbedBuilder } from "discord.js";
import { GithubCommand } from "../../../presentation/commands/community/github.command.ts";

const originalFetch = globalThis.fetch;
const originalRepo = process.env.GITHUB_REPO;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalRepo === undefined) delete process.env.GITHUB_REPO;
  else process.env.GITHUB_REPO = originalRepo;
});

function fakeInteraction() {
  return {
    deferReply: mock(() => Promise.resolve()),
    editReply: mock(() => Promise.resolve()),
    reply: mock(() => Promise.resolve()),
  } as unknown as ChatInputCommandInteraction & {
    deferReply: ReturnType<typeof mock>;
    editReply: ReturnType<typeof mock>;
    reply: ReturnType<typeof mock>;
  };
}

describe("GithubCommand", () => {
  beforeEach(() => {
    delete process.env.GITHUB_REPO;
  });

  test("replies without a network call when GITHUB_REPO is unset", async () => {
    const interaction = fakeInteraction();

    await new GithubCommand().execute(interaction);

    expect(interaction.deferReply).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith("The GitHub repository isn't public yet. Nothing to link to.");
  });

  test("shows repo stats in an embed on success", async () => {
    process.env.GITHUB_REPO = "carbon-native/carbon";
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            full_name: "carbon-native/carbon",
            html_url: "https://github.com/carbon-native/carbon",
            description: "The runtime",
            stargazers_count: 12,
            open_issues_count: 3,
            forks_count: 1,
            language: "Rust",
          }),
          { status: 200 },
        ),
      ),
    ) as unknown as typeof fetch;

    const interaction = fakeInteraction();
    await new GithubCommand().execute(interaction);

    expect(interaction.deferReply).toHaveBeenCalledTimes(1);
    const [{ embeds }] = interaction.editReply.mock.calls[0] as [{ embeds: EmbedBuilder[] }];
    const data = embeds[0].data;
    expect(data.title).toBe("carbon-native/carbon");
    expect(data.fields).toContainEqual({ name: "⭐ Stars", value: "12", inline: true });
  });

  test("reports a not-found repo without pretending it exists", async () => {
    process.env.GITHUB_REPO = "carbon-native/carbon";
    globalThis.fetch = mock(() => Promise.resolve(new Response("", { status: 404 }))) as unknown as typeof fetch;

    const interaction = fakeInteraction();
    await new GithubCommand().execute(interaction);

    expect(interaction.editReply).toHaveBeenCalledWith(
      "Configured repository `carbon-native/carbon` was not found. Check GITHUB_REPO.",
    );
  });
});

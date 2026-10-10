import { afterEach, describe, expect, mock, test } from "bun:test";
import type { ChatInputCommandInteraction } from "discord.js";
import { DocsCommand } from "../../../presentation/commands/community/docs.command.ts";
import { TrustCommand } from "../../../presentation/commands/community/trust.command.ts";
import { StartCommand } from "../../../presentation/commands/onboarding/start.command.ts";

describe("member resource commands", () => {
  afterEach(() => {
    for (const name of ["DOCS_URL", "SECURITY_URL", "PRIVACY_URL", "SUPPORT_POLICY_URL", "STATUS_URL"]) delete process.env[name];
  });

  test("start gives a focused private orientation", async () => {
    const reply = mock((options: unknown) => Promise.resolve(options));
    await new StartCommand().execute({ reply } as unknown as ChatInputCommandInteraction);
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ embeds: expect.any(Array), ephemeral: true }));
  });

  test("docs refuses to invent an unpublished destination", async () => {
    const reply = mock(() => Promise.resolve());
    await new DocsCommand().execute({ reply } as unknown as ChatInputCommandInteraction);
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("not been published"), ephemeral: true }));
  });

  test("trust lists only configured authoritative resources", async () => {
    process.env.SECURITY_URL = "https://example.com/security";
    const reply = mock((options: unknown) => Promise.resolve(options));
    await new TrustCommand().execute({ reply } as unknown as ChatInputCommandInteraction);
    const options = reply.mock.calls[0]?.[0] as { embeds: Array<{ data: { description?: string } }> };
    expect(options.embeds[0].data.description).toContain("Security");
    expect(options.embeds[0].data.description).not.toContain("Privacy");
  });
});

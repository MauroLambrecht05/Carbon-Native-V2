import { afterEach, describe, expect, mock, test } from "bun:test";
import { formatPrEmbed, formatReleaseEmbed, parsePrBody, postToDiscord } from "./discord-notify.ts";

const TEMPLATE_BODY = (checkedType: string) => `## Type
- [${checkedType === "feat" ? "x" : " "}] feat
- [${checkedType === "fix" ? "x" : " "}] fix
- [ ] refactor
- [ ] docs
- [ ] chore

## Affected
<!-- comment -->
products/carbon-discord

## Explanation
<!-- comment -->
Adds a thing because reasons.

## Verification Checklist
- [ ] something
`;

describe("parsePrBody", () => {
  test("reads the checked type and both sections, stripping HTML comments", () => {
    const parsed = parsePrBody(TEMPLATE_BODY("feat"));

    expect(parsed.type).toBe("feat");
    expect(parsed.affected).toBe("products/carbon-discord");
    expect(parsed.explanation).toBe("Adds a thing because reasons.");
  });

  test("resolves to null type when no box is checked", () => {
    expect(parsePrBody(TEMPLATE_BODY("none")).type).toBeNull();
  });

  test("resolves to null type when more than one box is checked", () => {
    const body = TEMPLATE_BODY("feat").replace("- [ ] fix", "- [x] fix");
    expect(parsePrBody(body).type).toBeNull();
  });

  test("returns empty sections for a body missing them entirely", () => {
    const parsed = parsePrBody("no headings here at all");
    expect(parsed).toEqual({ type: null, affected: "", explanation: "" });
  });
});

describe("formatPrEmbed", () => {
  test("labels and colors a feat PR, and credits the author", () => {
    const embed = formatPrEmbed({
      title: "Add /help command",
      body: TEMPLATE_BODY("feat"),
      url: "https://github.com/x/y/pull/1",
      author: "mauro",
    });

    expect(embed.title).toBe("Feature: Add /help command");
    expect(embed.color).toBe(0x2b7a4b);
    expect(embed.description).toBe("by mauro");
    expect(embed.fields).toEqual([
      { name: "Affected", value: "products/carbon-discord" },
      { name: "Explanation", value: "Adds a thing because reasons." },
    ]);
  });

  test("still announces a PR with an unspecified type, honestly labeled, not guessed", () => {
    const embed = formatPrEmbed({
      title: "Some change",
      body: TEMPLATE_BODY("none"),
      url: "https://github.com/x/y/pull/2",
      author: "mauro",
    });

    expect(embed.title).toBe("Unspecified: Some change");
    expect(embed.color).toBe(0x5865f2);
  });

  test("falls back to a placeholder for missing sections instead of an empty field", () => {
    const embed = formatPrEmbed({ title: "T", body: "", url: "u", author: "a" });

    expect(embed.fields).toEqual([
      { name: "Affected", value: "_not specified_" },
      { name: "Explanation", value: "_not specified_" },
    ]);
  });

  test("truncates a field past Discord's 1024-char limit", () => {
    const longExplanation = "x".repeat(2000);
    const body = TEMPLATE_BODY("chore").replace("Adds a thing because reasons.", longExplanation);
    const embed = formatPrEmbed({ title: "T", body, url: "u", author: "a" });

    const explanationField = embed.fields?.find((f) => f.name === "Explanation");
    expect(explanationField?.value.length).toBe(1024);
    expect(explanationField?.value.endsWith("…")).toBe(true);
  });
});

describe("formatReleaseEmbed", () => {
  test("names the tag, nothing more, since that's all the push-on-tag trigger actually knows", () => {
    const embed = formatReleaseEmbed({ tagName: "v0.3.0", url: "https://github.com/x/y/releases/tag/v0.3.0" });

    expect(embed.title).toBe("Released v0.3.0");
    expect(embed.url).toBe("https://github.com/x/y/releases/tag/v0.3.0");
    expect(embed.color).toBe(0x2b7a4b);
  });
});

describe("postToDiscord", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("sends the embed wrapped in Discord's { embeds: [...] } shape", async () => {
    const fetchMock = mock((_url: string, _init: RequestInit) => Promise.resolve(new Response("", { status: 204 })));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await postToDiscord("https://discord.com/api/webhooks/x/y", { title: "hi" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://discord.com/api/webhooks/x/y");
    expect(JSON.parse(init.body as string)).toEqual({ embeds: [{ title: "hi" }] });
  });

  test("throws instead of silently swallowing a rejected webhook", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("invalid webhook token", { status: 401 })),
    ) as unknown as typeof fetch;

    await expect(postToDiscord("https://discord.com/api/webhooks/x/y", { title: "hi" })).rejects.toThrow(
      /401/,
    );
  });
});

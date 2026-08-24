import { afterEach, describe, expect, mock, test } from "bun:test";
import { formatCommitDigestEmbed, formatPrEmbed, formatReleaseEmbed, parsePrBody, postToDiscord } from "./discord-notify.ts";

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

describe("formatCommitDigestEmbed", () => {
  test("lists each commit as sha, message and author, singular title for one commit", () => {
    const embed = formatCommitDigestEmbed(
      [{ sha: "abcdef1234567", message: "Fix the thing", author: "mauro" }],
      "https://github.com/x/y/commit/abcdef1234567",
    );

    expect(embed.title).toBe("1 commit landed on main");
    expect(embed.description).toBe("`abcdef1` Fix the thing — mauro");
  });

  test("pluralizes the title and joins multiple commits with newlines, oldest first as given", () => {
    const embed = formatCommitDigestEmbed(
      [
        { sha: "1111111aaaa", message: "First fix", author: "mauro" },
        { sha: "2222222bbbb", message: "Second fix", author: "mauro" },
      ],
      "https://github.com/x/y/compare/aaa...bbb",
    );

    expect(embed.title).toBe("2 commits landed on main");
    expect(embed.url).toBe("https://github.com/x/y/compare/aaa...bbb");
    expect(embed.description).toBe("`1111111` First fix — mauro\n`2222222` Second fix — mauro");
  });

  test("truncates past Discord's 4096-char embed description limit", () => {
    const commits = Array.from({ length: 200 }, (_, i) => ({
      sha: `${i}`.padStart(40, "0"),
      message: "x".repeat(50),
      author: "mauro",
    }));

    const embed = formatCommitDigestEmbed(commits, "https://github.com/x/y/compare/a...b");

    expect(embed.description?.length).toBe(4096);
    expect(embed.description?.endsWith("…")).toBe(true);
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

  test("adds content only when given, since that's what actually pings on Discord", async () => {
    const fetchMock = mock((_url: string, _init: RequestInit) => Promise.resolve(new Response("", { status: 204 })));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await postToDiscord("https://discord.com/api/webhooks/x/y", { title: "hi" }, "<@478580096454623235>");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      embeds: [{ title: "hi" }],
      content: "<@478580096454623235>",
    });
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

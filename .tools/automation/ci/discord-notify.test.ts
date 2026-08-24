import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  chunkEmbeds,
  formatCommitEmbed,
  formatPrEmbed,
  formatReleaseEmbed,
  parsePrBody,
  postToDiscord,
} from "./discord-notify.ts";

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

describe("formatCommitEmbed", () => {
  const base = { sha: "abcdef1234567", author: "mauro", url: "https://github.com/x/y/commit/abcdef1234567" };

  test("parses a typed, scoped commit summary the same way CONTRIBUTING.md documents it", () => {
    const embed = formatCommitEmbed({
      ...base,
      summary: "fix(products/carbon): softbuffer surface unavailable on Linux",
      body: "GTK never realizes the window before softbuffer needs its handle.",
    });

    expect(embed.title).toBe("Fix (products/carbon): softbuffer surface unavailable on Linux");
    expect(embed.color).toBe(0xd64545);
    expect(embed.description).toBe("by mauro");
    expect(embed.fields).toEqual([
      { name: "Explanation", value: "GTK never realizes the window before softbuffer needs its handle." },
    ]);
  });

  test("parses an unscoped type the same as formatPrEmbed's own labels", () => {
    const embed = formatCommitEmbed({ ...base, summary: "feat: add /help command", body: "" });

    expect(embed.title).toBe("Feature: add /help command");
    expect(embed.color).toBe(0x2b7a4b);
  });

  test("labels perf and test — types the PR template's checkboxes don't offer at all", () => {
    expect(formatCommitEmbed({ ...base, summary: "perf: cut cold start by 40ms", body: "" }).color).toBe(
      0xf5a623,
    );
    expect(formatCommitEmbed({ ...base, summary: "test: cover the empty-bundle case", body: "" }).color).toBe(
      0x8a8f98,
    );
  });

  test("labels a commit with no recognized prefix Unspecified rather than guessing from its verb", () => {
    const embed = formatCommitEmbed({ ...base, summary: "Force GTK to realize the window", body: "" });

    expect(embed.title).toBe("Unspecified: Force GTK to realize the window");
    expect(embed.color).toBe(0x5865f2);
  });

  test("falls back to a placeholder when the commit has no body", () => {
    const embed = formatCommitEmbed({ ...base, summary: "chore: bump a dependency", body: "" });

    expect(embed.fields).toEqual([{ name: "Explanation", value: "_not specified_" }]);
  });

  test("truncates the Explanation field past Discord's 1024-char limit", () => {
    const embed = formatCommitEmbed({ ...base, summary: "chore: x", body: "x".repeat(2000) });

    const explanationField = embed.fields?.find((f) => f.name === "Explanation");
    expect(explanationField?.value.length).toBe(1024);
    expect(explanationField?.value.endsWith("…")).toBe(true);
  });
});

describe("chunkEmbeds", () => {
  test("passes a short list through as one chunk", () => {
    const embeds = [{ title: "a" }, { title: "b" }];
    expect(chunkEmbeds(embeds)).toEqual([embeds]);
  });

  test("splits at Discord's 10-embeds-per-message limit", () => {
    const embeds = Array.from({ length: 23 }, (_, i) => ({ title: `${i}` }));

    const chunks = chunkEmbeds(embeds);

    expect(chunks.map((c) => c.length)).toEqual([10, 10, 3]);
    expect(chunks.flat()).toEqual(embeds);
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

  test("sends multiple embeds in one payload when given an array", async () => {
    const fetchMock = mock((_url: string, _init: RequestInit) => Promise.resolve(new Response("", { status: 204 })));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await postToDiscord("https://discord.com/api/webhooks/x/y", [{ title: "a" }, { title: "b" }]);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ embeds: [{ title: "a" }, { title: "b" }] });
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

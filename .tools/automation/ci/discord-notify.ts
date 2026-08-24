// Parses the strict sections .github/PULL_REQUEST_TEMPLATE.md asks every PR
// to fill in (Type / Affected / Explanation) and formats them, plus a
// release tag, as Discord embeds. Pure functions here, no I/O — the two
// notify-*.ts scripts are the only things that touch the network or read
// GITHUB_EVENT_PATH, so this module is testable without a GitHub Actions
// runner.

export interface DiscordEmbed {
  readonly title: string;
  readonly url?: string;
  readonly description?: string;
  readonly color?: number;
  readonly fields?: readonly { readonly name: string; readonly value: string }[];
}

const PR_TYPES = ["feat", "fix", "refactor", "docs", "chore"] as const;
export type PrType = (typeof PR_TYPES)[number];

const TYPE_LABEL: Record<PrType, string> = {
  feat: "Feature",
  fix: "Fix",
  refactor: "Refactor",
  docs: "Docs",
  chore: "Chore",
};

// Discord decimal color values. feat/fix/refactor get a color that means
// something at a glance in a fast-moving channel; docs/chore share a neutral
// grey since neither changes runtime behavior.
const TYPE_COLOR: Record<PrType, number> = {
  feat: 0x2b7a4b,
  fix: 0xd64545,
  refactor: 0x3b82c4,
  docs: 0x8a8f98,
  chore: 0x8a8f98,
};

// Discord blurple — used when the PR body didn't check exactly one Type box,
// so the announcement still posts (a malformed template is not a reason to
// go silent) but visibly doesn't claim a type it can't back up.
const UNSPECIFIED_COLOR = 0x5865f2;

export interface ParsedPr {
  readonly type: PrType | null;
  readonly affected: string;
  readonly explanation: string;
}

export function parsePrBody(body: string): ParsedPr {
  return {
    type: parseType(extractRawSection(body, "Type")),
    affected: cleanSection(extractRawSection(body, "Affected")),
    explanation: cleanSection(extractRawSection(body, "Explanation")),
  };
}

function parseType(rawTypeSection: string): PrType | null {
  const checked = PR_TYPES.filter((t) => new RegExp(`-\\s*\\[[xX]\\]\\s*${t}\\b`).test(rawTypeSection));
  // Zero checked (template untouched) or more than one (ambiguous) both
  // resolve to "unspecified" rather than guessing — see UNSPECIFIED_COLOR.
  return checked.length === 1 ? checked[0] : null;
}

function extractRawSection(body: string, heading: string): string {
  const match = body.match(new RegExp(`##\\s*${heading}\\b[^\\n]*\\n([\\s\\S]*?)(?:\\n##\\s|$)`, "i"));
  return match ? match[1] : "";
}

function cleanSection(raw: string): string {
  return raw
    .split("\n")
    .filter((line) => !/^\s*<!--.*-->\s*$/.test(line))
    .join("\n")
    .trim();
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export interface PrInfo {
  readonly title: string;
  readonly body: string;
  readonly url: string;
  readonly author: string;
}

export function formatPrEmbed(pr: PrInfo): DiscordEmbed {
  const parsed = parsePrBody(pr.body);
  const label = parsed.type ? TYPE_LABEL[parsed.type] : "Unspecified";

  return {
    title: truncate(`${label}: ${pr.title}`, 256),
    url: pr.url,
    color: parsed.type ? TYPE_COLOR[parsed.type] : UNSPECIFIED_COLOR,
    description: `by ${pr.author}`,
    fields: [
      { name: "Affected", value: truncate(parsed.affected || "_not specified_", 1024) },
      { name: "Explanation", value: truncate(parsed.explanation || "_not specified_", 1024) },
    ],
  };
}

export interface ReleaseInfo {
  readonly tagName: string;
  readonly url: string;
}

export function formatReleaseEmbed(release: ReleaseInfo): DiscordEmbed {
  return {
    title: truncate(`Released ${release.tagName}`, 256),
    url: release.url,
    color: 0x2b7a4b,
  };
}

export async function postToDiscord(webhookUrl: string, embed: DiscordEmbed): Promise<void> {
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ embeds: [embed] }),
  });

  if (!response.ok) {
    throw new Error(`Discord webhook rejected the message: ${response.status} ${await response.text()}`);
  }
}

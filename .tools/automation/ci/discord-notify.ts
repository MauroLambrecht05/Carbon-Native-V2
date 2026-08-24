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

// The full set CONTRIBUTING.md's "Commits and PRs" section documents for
// commit message prefixes — a superset of PR_TYPES (adds perf: and test:,
// which the PR template's Type checkboxes deliberately don't offer; a PR
// gets a fuller description than a single-word label covers).
const COMMIT_TYPES = ["feat", "fix", "refactor", "perf", "docs", "test", "chore"] as const;
export type CommitType = (typeof COMMIT_TYPES)[number];

const TYPE_LABEL: Record<CommitType, string> = {
  feat: "Feature",
  fix: "Fix",
  refactor: "Refactor",
  perf: "Performance",
  docs: "Docs",
  test: "Test",
  chore: "Chore",
};

// Discord decimal color values. feat/fix/refactor/perf each get a color that
// means something at a glance in a fast-moving channel; docs/test/chore
// share a neutral grey since none changes runtime behavior.
const TYPE_COLOR: Record<CommitType, number> = {
  feat: 0x2b7a4b,
  fix: 0xd64545,
  refactor: 0x3b82c4,
  perf: 0xf5a623,
  docs: 0x8a8f98,
  test: 0x8a8f98,
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

// CONTRIBUTING.md's "Commits and PRs" section documents this exact shape:
// `type: message` or `type(scope): message`. Unlike parseType above (which
// picks among checkboxes a PR body either did or didn't check), a commit
// summary that doesn't match the pattern at all is not ambiguous — it's
// just untyped, the same "Unspecified" fallback formatPrEmbed already uses
// for a PR whose Type section is empty or over-checked.
function parseCommitType(summary: string): { type: CommitType | null; scope: string | null; title: string } {
  const match = summary.match(/^\s*(feat|fix|refactor|perf|docs|test|chore)(?:\(([^)]+)\))?\s*:\s*(.+)$/i);
  if (!match) return { type: null, scope: null, title: summary.trim() };
  return { type: match[1].toLowerCase() as CommitType, scope: match[2] ?? null, title: match[3].trim() };
}

export interface CommitInfo {
  readonly sha: string;
  // First line, as written — may or may not carry a "type: " prefix.
  readonly summary: string;
  // Everything after the summary line (git's %b) — the commit's equivalent
  // of a PR body's Explanation section.
  readonly body: string;
  readonly author: string;
  readonly url: string;
}

// Same structure as formatPrEmbed on purpose: a type-labeled, type-colored
// title, "by {author}", and an Explanation field — just sourced from a
// commit's "type: message" prefix and body instead of a PR template's
// checkboxes and Explanation section. See
// .tools/automation/ci/notify-push-commits.ts for how these get chunked
// into Discord's 10-embeds-per-message limit and posted.
export function formatCommitEmbed(commit: CommitInfo): DiscordEmbed {
  const { type, scope, title } = parseCommitType(commit.summary);
  const label = type ? (scope ? `${TYPE_LABEL[type]} (${scope})` : TYPE_LABEL[type]) : "Unspecified";

  return {
    title: truncate(`${label}: ${title}`, 256),
    url: commit.url,
    color: type ? TYPE_COLOR[type] : UNSPECIFIED_COLOR,
    description: `by ${commit.author}`,
    fields: [{ name: "Explanation", value: truncate(commit.body || "_not specified_", 1024) }],
  };
}

// Discord rejects a webhook payload with more than 10 embeds in one
// message, and a backfill digest can easily cover more commits than that.
export function chunkEmbeds(embeds: readonly DiscordEmbed[], size = 10): DiscordEmbed[][] {
  const chunks: DiscordEmbed[][] = [];
  for (let i = 0; i < embeds.length; i += size) chunks.push(embeds.slice(i, i + size));
  return chunks;
}

export async function postToDiscord(
  webhookUrl: string,
  embeds: DiscordEmbed | readonly DiscordEmbed[],
  content?: string,
): Promise<void> {
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // content, not the embed, is what Discord actually pings on — an
    // @mention inside an embed field renders as text and pings nobody.
    body: JSON.stringify({
      embeds: Array.isArray(embeds) ? embeds : [embeds],
      ...(content ? { content } : {}),
    }),
  });

  if (!response.ok) {
    throw new Error(`Discord webhook rejected the message: ${response.status} ${await response.text()}`);
  }
}

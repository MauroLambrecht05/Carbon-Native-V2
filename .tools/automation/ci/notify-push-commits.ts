#!/usr/bin/env bun
// Posts one Discord embed per commit, same Type/title/Explanation structure
// as formatPrEmbed, for every green CI run on a direct push to main. Run by
// .github/workflows/notify-push.yml, which triggers on workflow_run(CI,
// completed) rather than on push directly — that is what lets this only
// fire once CI has actually passed, catching up on every commit since the
// last successful notification (including ones pushed while CI was red and
// never announced) in one batch instead of leaving them unannounced.
//
// A commit's Type comes from CONTRIBUTING.md's own documented convention
// (`type: message` / `type(scope): message`) rather than the PR template's
// checkboxes, since a raw commit has no template to check boxes in — see
// formatCommitEmbed in discord-notify.ts.
//
// PR merges are handled by notify.yml already (parsed from the strict
// Type/Affected/Explanation template), so this explicitly excludes merge
// commits (git log --no-merges) to avoid a second, differently-formatted
// announcement for the same change. That catches GitHub's default "Merge
// pull request" strategy; squash- and rebase-merged PRs land as ordinary
// single-parent commits and are not distinguishable from a direct push by
// shape alone, so they will still appear here too.
//
// "Last notified" is tracked as a lightweight tag (discord-last-notified)
// moved forward only after every chunk posts successfully, so a failed
// webhook call leaves the marker where it was and the same commits get
// retried on the next green run instead of silently vanishing.

import { spawnSync } from "node:child_process";
import { chunkEmbeds, formatCommitEmbed, postToDiscord, type CommitInfo } from "./discord-notify.ts";

const MARKER_TAG = "discord-last-notified";

const headSha = process.env.HEAD_SHA;
const repo = process.env.GITHUB_REPOSITORY;
const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
const pingUserId = process.env.DISCORD_PING_USER_ID;
if (!headSha) throw new Error("missing HEAD_SHA");
if (!repo) throw new Error("missing GITHUB_REPOSITORY");
if (!webhookUrl) throw new Error("missing DISCORD_WEBHOOK_URL");
if (!pingUserId) throw new Error("missing DISCORD_PING_USER_ID");

function git(args: string[]): string {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function markerSha(): string | null {
  const result = spawnSync("git", ["rev-parse", `refs/tags/${MARKER_TAG}`], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

const marker = markerSha();
// %x1e (record separator) between commits, %x1f (unit separator) between
// fields — bytes no commit message legitimately contains, so a multi-line
// body (%b) can't be confused for a record boundary the way a plain
// newline-per-commit format would.
const RS = "\x1e";
const FS = "\x1f";
const range = marker ? `${marker}..${headSha}` : headSha;
const log = git(["log", "--no-merges", `--format=%H${FS}%s${FS}%an${FS}%b${RS}`, range]);

const commits: CommitInfo[] = log
  .split(RS)
  .map((record) => record.trim())
  .filter((record) => record.length > 0)
  .map((record) => {
    const [sha, summary, author, body] = record.split(FS);
    return { sha, summary, author, body: (body ?? "").trim(), url: `https://github.com/${repo}/commit/${sha}` };
  })
  // git log lists newest first; the announcement should read oldest-first,
  // the order the commits actually landed in.
  .reverse();

if (commits.length === 0) {
  console.log("no new non-merge commits since the last notification — nothing to announce");
} else {
  const chunks = chunkEmbeds(commits.map(formatCommitEmbed));
  for (const [i, chunk] of chunks.entries()) {
    // Ping once for the whole batch, on the first message, not once per
    // chunk — a multi-chunk backfill would otherwise ping repeatedly.
    await postToDiscord(webhookUrl, chunk, i === 0 ? `<@${pingUserId}>` : undefined);
  }
  console.log(`posted ${commits.length} commit(s) to Discord across ${chunks.length} message(s)`);
}

// Move the marker even when there was nothing to announce (e.g. HEAD only
// advanced through merge commits) — otherwise the next run re-walks the
// same already-seen range forever.
git(["tag", "-f", MARKER_TAG, headSha]);
git(["push", "origin", `refs/tags/${MARKER_TAG}`, "--force"]);
console.log(`moved ${MARKER_TAG} to ${headSha}`);

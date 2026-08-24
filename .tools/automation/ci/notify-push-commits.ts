#!/usr/bin/env bun
// Posts one digest to Discord for every green CI run on a direct push to
// main. Run by .github/workflows/notify-push.yml, which triggers on
// workflow_run(CI, completed) rather than on push directly — that is what
// lets this only fire once CI has actually passed, catching up on every
// commit since the last successful notification (including ones pushed
// while CI was red and never announced) in one message instead of one ping
// per commit.
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
// moved forward only after a successful post, so a failed webhook call
// leaves the marker where it was and the same commits get retried on the
// next green run instead of silently vanishing from the announcement.

import { spawnSync } from "node:child_process";
import { formatCommitDigestEmbed, postToDiscord, type CommitInfo } from "./discord-notify.ts";

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
// %x1f (unit separator) between fields, one commit per line — a byte no
// commit message legitimately contains, so it splits unambiguously even
// through a message with embedded pipes or colons.
const range = marker ? `${marker}..${headSha}` : headSha;
const log = git(["log", "--no-merges", "--format=%H%x1f%s%x1f%an", range]);

const commits: CommitInfo[] = log
  .split("\n")
  .filter((line) => line.length > 0)
  .map((line) => {
    const [sha, message, author] = line.split("\x1f");
    return { sha, message, author };
  })
  // git log lists newest first; the digest should read oldest-first, the
  // order the commits actually landed in.
  .reverse();

if (commits.length === 0) {
  console.log("no new non-merge commits since the last notification — nothing to announce");
} else {
  const compareUrl = marker
    ? `https://github.com/${repo}/compare/${marker}...${headSha}`
    : `https://github.com/${repo}/commit/${headSha}`;

  await postToDiscord(webhookUrl, formatCommitDigestEmbed(commits, compareUrl), `<@${pingUserId}>`);
  console.log(`posted a digest of ${commits.length} commit(s) to Discord`);
}

// Move the marker even when there was nothing to announce (e.g. HEAD only
// advanced through merge commits) — otherwise the next run re-walks the
// same already-seen range forever.
git(["tag", "-f", MARKER_TAG, headSha]);
git(["push", "origin", `refs/tags/${MARKER_TAG}`, "--force"]);
console.log(`moved ${MARKER_TAG} to ${headSha}`);

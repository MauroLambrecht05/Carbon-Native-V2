#!/usr/bin/env bun
// Posts a merged PR to Discord. Run by .github/workflows/notify.yml on
// pull_request (closed) — that workflow gates on github.event.pull_request.
// merged == true before this even starts, but it's checked again here so
// running the script directly (or a future caller) can't skip it.

import { readFileSync } from "node:fs";
import { formatPrEmbed, postToDiscord } from "./discord-notify.ts";

const eventPath = process.env.GITHUB_EVENT_PATH;
const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
if (!eventPath) throw new Error("missing GITHUB_EVENT_PATH — this only runs inside a GitHub Actions job");
if (!webhookUrl) throw new Error("missing DISCORD_WEBHOOK_URL");

const event = JSON.parse(readFileSync(eventPath, "utf8"));
const pr = event.pull_request;

if (!pr?.merged) {
  console.log("PR was closed without merging — nothing to announce");
  process.exit(0);
}

await postToDiscord(
  webhookUrl,
  formatPrEmbed({
    title: pr.title,
    body: pr.body ?? "",
    url: pr.html_url,
    author: pr.user?.login ?? "unknown",
  }),
);

console.log(`posted PR #${pr.number} to Discord`);

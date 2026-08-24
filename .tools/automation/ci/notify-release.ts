#!/usr/bin/env bun
// Posts a published release to Discord. Run by .github/workflows/release.yml
// alongside the existing Slack step, on success only — see that workflow for
// why (a failed release must not announce itself as "Released").
//
// release.yml is push-on-tag triggered, not GitHub's `release` webhook
// event, so there is no event.release payload to read the way
// notify-pr-merged.ts reads event.pull_request. This takes plain env vars
// the workflow step sets from the tag ref instead.

import { formatReleaseEmbed, postToDiscord } from "./discord-notify.ts";

const tag = process.env.RELEASE_TAG;
const url = process.env.RELEASE_URL;
const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
if (!tag) throw new Error("missing RELEASE_TAG");
if (!url) throw new Error("missing RELEASE_URL");
if (!webhookUrl) throw new Error("missing DISCORD_WEBHOOK_URL");

await postToDiscord(webhookUrl, formatReleaseEmbed({ tagName: tag, url }));

console.log(`posted release ${tag} to Discord`);

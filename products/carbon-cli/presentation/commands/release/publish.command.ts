// `carbon publish` — sign and ship an already-built installer, and manage
// what's live once it's out there.
//
// Previously every subcommand here was a mock: `app` built a manifest and
// printed "publishing is not wired up: no artifacts were uploaded", `status`
// printed hardcoded fake data, `rollback`/`yank` just echoed back what they
// were asked to do with zero effect. The pieces to make this real already
// existed — S3ArtifactStore's upload/fetch functions, @carbon/signing,
// BuildUpdateManifestUseCase — they just weren't called from here. See
// @carbon/publishing's PublishReleaseUseCase/RollbackReleaseUseCase/
// YankReleaseUseCase for the actual logic; this file is argument parsing and
// printing, same division as every other command.
//
// Modelled as a CommandGroup (see signer.command.ts, which set this
// precedent) rather than the switch-plus-hand-written-help-string the V1 port
// used: each subcommand declares its own flags, so `carbon help publish` and
// `carbon help publish app` list them without a fourth copy of the same
// argument table in a help string.

import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  Command,
  CommandGroup,
  EXIT_OK,
  EXIT_FAILURE,
  EXIT_USAGE,
  type CommandMeta,
  type CommandContext,
  type ExitCode,
} from "@carbon/cli";
import { loadCarbonConfig } from "@carbon/workspace";
import {
  PublishReleaseUseCase,
  RollbackReleaseUseCase,
  YankReleaseUseCase,
  BuildUpdateManifestUseCase,
  fetchManifest,
  fetchStopList,
  listReleases,
  type S3Config,
} from "@carbon/publishing";
import { signBytes } from "@carbon/signing";
import { resolvePassword } from "./resolve-password.ts";

const PASSWORD_FLAG = {
  name: "password",
  placeholder: "<pw>",
  description: "Key password; else $CARBON_SIGNER_PASSWORD, else prompt",
} as const;

const CHANNEL_FLAG = {
  name: "channel",
  placeholder: "<name>",
  description: "Release channel",
  default: "stable",
} as const;

/**
 * Reads the S3-compatible upload target from `carbon.toml`'s `[publish]`
 * section. Not part of contracts/app's modeled schema — it lives in `raw`
 * (sections the toolchain doesn't formally model, passed through untouched)
 * the same way `[plugins]` does, rather than extending CarbonManifest.ts for
 * a section only this one command reads.
 *
 * Credentials are never read from carbon.toml — S3ArtifactStore's client()
 * only ever reads them from AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY (or the
 * R2_ equivalents), so there's nothing secret to accidentally commit here.
 */
function readPublishConfig(raw: Record<string, unknown>): S3Config {
  const pub = raw.publish as Record<string, unknown> | undefined;
  if (!pub) {
    throw new Error(
      `no [publish] section in carbon.toml. Add one:\n\n` +
        `  [publish]\n  type = "s3"        # or "r2"\n  bucket = "my-bucket"\n  prefix = "myapp/"  # optional\n\n` +
        `Credentials come from AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY ` +
        `(R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY for r2) — never from carbon.toml.`,
    );
  }
  const type = pub.type;
  if (type !== "s3" && type !== "r2") {
    throw new Error(`[publish].type must be "s3" or "r2", got ${JSON.stringify(type ?? null)}`);
  }
  const bucket = pub.bucket;
  if (typeof bucket !== "string" || !bucket) {
    throw new Error(`[publish].bucket is required`);
  }
  return {
    type,
    bucket,
    prefix: typeof pub.prefix === "string" ? pub.prefix : "",
    region: typeof pub.region === "string" ? pub.region : undefined,
    endpoint: typeof pub.endpoint === "string" ? pub.endpoint : undefined,
  };
}

class PublishAppCommand extends Command {
  readonly meta: CommandMeta = {
    name: "app",
    summary: "Sign and upload an already-built installer, updating the channel's manifest",
    usage: "publish app --version <v> --platform <triple> --input <file> --key <path> [options]",
    flags: [
      { name: "version", placeholder: "<version>", description: "Version being published (required)" },
      {
        name: "platform",
        placeholder: "<triple>",
        description: 'Manifest key this artifact is published under, e.g. "x86_64-pc-windows-msvc" (required)',
      },
      {
        name: "input",
        placeholder: "<file>",
        description: "Path to the already-built installer for --platform (required — carbon bundle + the " +
          "platform's own packaging tool produce this; publish never invokes those itself)",
      },
      { name: "key", placeholder: "<path>", description: "Private signing key (required)" },
      CHANNEL_FLAG,
      { name: "rollout", placeholder: "<percent>", description: "Percentage of installs offered the update", default: "100" },
      { name: "notes", placeholder: "<text>", description: "Release notes" },
      { name: "min-version", placeholder: "<version>", description: "Oldest version that may update straight to this one" },
      { name: "dry-run", boolean: true, description: "Compute and print without uploading anything" },
      PASSWORD_FLAG,
    ],
    examples: [
      "carbon publish app --version 1.0.1 --platform x86_64-pc-windows-msvc --input dist/installers/myapp-1.0.1.exe --key ~/.carbon/keys/myapp.key",
    ],
  };

  validate(ctx: CommandContext): string | null {
    if (!ctx.flags.get("version")) return "--version is required";
    if (!ctx.flags.get("platform")) return "--platform is required";
    const input = ctx.flags.get("input");
    if (!input) return "--input is required";
    if (!existsSync(input)) return `--input file not found: ${input}`;
    const dryRun = ctx.flags.bool("dry-run");
    if (!dryRun && !ctx.flags.get("key")) return "--key is required (or pass --dry-run)";
    return null;
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const version = ctx.flags.get("version")!;
    const platform = ctx.flags.get("platform")!;
    const input = ctx.flags.get("input")!;
    const channel = ctx.flags.get("channel", "stable")!;
    const rollout = ctx.flags.int("rollout", 100);
    const notes = ctx.flags.get("notes");
    const minVersion = ctx.flags.get("min-version") ?? null;
    const dryRun = ctx.flags.bool("dry-run");

    const config = loadCarbonConfig(ctx.cwd);
    const pubkey = config.updater?.pubkey ?? "";
    if (!pubkey) {
      ctx.io.error(
        "no [updater].pubkey in carbon.toml — the manifest would announce a release nothing can verify. " +
          "Generate one with `carbon signer generate`.",
      );
      return EXIT_FAILURE;
    }

    if (dryRun) {
      // No key required for a preview, and nothing is fetched from the
      // publish target — this shows only what THIS platform's entry would
      // look like, not the merged result of everything already published.
      const bytes = readFileSync(input);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const key = ctx.flags.get("key");
      const signature = key
        ? signBytes(new Uint8Array(bytes), key, await resolvePassword(ctx, "key password"))
        : "(no --key given — pass one to sign for real)";

      const manifest = new BuildUpdateManifestUseCase().execute({
        version, channel, rollout, pubkey, notes: notes ?? "", minVersion,
        platforms: { [platform]: { signature, url: "(not uploaded — dry run)", sha256 } },
      });
      ctx.io.step("Manifest (dry-run, not uploaded):");
      ctx.io.raw(JSON.stringify(manifest, null, 2));
      return EXIT_OK;
    }

    const key = ctx.flags.get("key")!;
    const password = await resolvePassword(ctx, "key password");
    const publishConfig = readPublishConfig(config.raw as Record<string, unknown>);

    const useCase = new PublishReleaseUseCase(publishConfig, ctx.io);
    const result = await useCase.execute({
      version, channel, rollout, platform, artifactPath: input, keyFile: key, password, pubkey,
      notes: notes ?? undefined, minVersion,
    });

    ctx.io.success(`published ${version} to ${channel} for ${platform}`);
    ctx.io.step(`artifact:  ${result.artifactUrl}`);
    ctx.io.step(`sha256:    ${result.sha256}`);
    ctx.io.step(`manifest:  ${result.manifestUrl}`);
    ctx.io.info(
      `${Object.keys(result.manifest.platforms).length} platform(s) now on ${channel}: ` +
        Object.keys(result.manifest.platforms).join(", "),
    );
    return EXIT_OK;
  }
}

class PublishRollbackCommand extends Command {
  readonly meta: CommandMeta = {
    name: "rollback",
    summary: "Point a channel back at a version it already published",
    usage: "publish rollback --to <version> [--channel <name>]",
    flags: [
      { name: "to", placeholder: "<version>", description: "Version to roll back to (required)" },
      CHANNEL_FLAG,
    ],
    examples: ["carbon publish rollback --channel stable --to 0.9.0"],
  };

  validate(ctx: CommandContext): string | null {
    return ctx.flags.get("to") ? null : "--to is required";
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const toVersion = ctx.flags.get("to")!;
    const channel = ctx.flags.get("channel", "stable")!;
    const config = loadCarbonConfig(ctx.cwd);
    const publishConfig = readPublishConfig(config.raw as Record<string, unknown>);

    const result = await new RollbackReleaseUseCase(publishConfig, ctx.io).execute({ channel, toVersion });

    ctx.io.success(`${channel} rolled back to ${toVersion}`);
    ctx.io.step(`manifest: ${result.manifestUrl}`);
    return EXIT_OK;
  }
}

class PublishYankCommand extends Command {
  readonly meta: CommandMeta = {
    name: "yank",
    summary: "Prevent a version from being offered to new installs",
    usage: "publish yank <version> [--channel <name>] [--auto-rollback --to <version>]",
    flags: [
      CHANNEL_FLAG,
      { name: "reason", placeholder: "<text>", description: "Why this version was yanked, recorded in the stop list" },
      { name: "auto-rollback", boolean: true, description: "If the yanked version is currently live, also roll back to --to" },
      { name: "to", placeholder: "<version>", description: "Rollback target — required together with --auto-rollback" },
    ],
    examples: [
      "carbon publish yank 0.8.5",
      "carbon publish yank 0.8.5 --auto-rollback --to 0.8.4",
    ],
  };

  validate(ctx: CommandContext): string | null {
    if (!ctx.first) return "a version is required";
    if (ctx.flags.bool("auto-rollback") && !ctx.flags.get("to")) {
      return "--auto-rollback needs --to <version> — automatic previous-version detection isn't implemented";
    }
    return null;
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const version = ctx.first!;
    const channel = ctx.flags.get("channel", "stable")!;
    const autoRollback = ctx.flags.bool("auto-rollback");
    const rollbackTo = ctx.flags.get("to");
    const reason = ctx.flags.get("reason");
    const config = loadCarbonConfig(ctx.cwd);
    const publishConfig = readPublishConfig(config.raw as Record<string, unknown>);

    const result = await new YankReleaseUseCase(publishConfig, ctx.io).execute({
      channel, version, autoRollback, rollbackTo, reason,
    });

    ctx.io.success(`yanked ${version} from ${channel}`);
    ctx.io.step(`yanked list: ${result.yankedVersions.join(", ")}`);
    if (result.rolledBackTo) {
      ctx.io.step(`auto-rolled back to ${result.rolledBackTo}`);
    }
    return EXIT_OK;
  }
}

class PublishStatusCommand extends Command {
  readonly meta: CommandMeta = {
    name: "status",
    summary: "Show what's actually live on a channel",
    usage: "publish status [--channel <name>]",
    flags: [CHANNEL_FLAG],
    examples: ["carbon publish status --channel beta"],
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const channel = ctx.flags.get("channel", "stable")!;
    const config = loadCarbonConfig(ctx.cwd);
    const publishConfig = readPublishConfig(config.raw as Record<string, unknown>);

    const [current, releases, stopList] = await Promise.all([
      fetchManifest(publishConfig, channel),
      listReleases(publishConfig, channel),
      fetchStopList(publishConfig, channel),
    ]);

    ctx.io.raw("");
    ctx.io.raw(ctx.io.c.bold(`Channel: ${channel}`));
    ctx.io.raw("");
    if (!current) {
      ctx.io.raw("Nothing published to this channel yet.");
    } else {
      ctx.io.raw(`Current version: ${current.manifest.version}`);
      ctx.io.raw(`Released:        ${current.manifest.pub_date}`);
      ctx.io.raw(`Rollout:         ${current.manifest.rollout}%`);
      ctx.io.raw(`Platforms:       ${Object.keys(current.manifest.platforms).join(", ") || "(none)"}`);
      if (current.manifest.notes) ctx.io.raw(`Notes:           ${current.manifest.notes}`);
    }
    ctx.io.raw("");
    ctx.io.raw(`All published versions: ${releases.length ? releases.join(", ") : "(none)"}`);
    if (stopList.yanked.length) {
      ctx.io.raw(
        `Yanked: ${stopList.yanked.map((e) => (e.reason ? `${e.version} (${e.reason})` : e.version)).join(", ")}`,
      );
    }
    ctx.io.raw("");
    return EXIT_OK;
  }
}

export class PublishCommand extends CommandGroup {
  readonly meta: CommandMeta = {
    name: "publish",
    summary: "Manage app releases and updates",
    usage: "publish <app|rollback|yank|status> [options]",
    examples: ["carbon publish app --version 1.0.0 --platform x86_64-pc-windows-msvc --input ... --key ...", "carbon publish status --channel beta"],
  };

  readonly subcommands = [
    new PublishAppCommand(),
    new PublishRollbackCommand(),
    new PublishYankCommand(),
    new PublishStatusCommand(),
  ];
}

export default PublishCommand;
export { EXIT_USAGE };

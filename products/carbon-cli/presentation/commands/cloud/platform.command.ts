// `carbon cloud builds|releases|channels|functions` — one environment's
// builds, releases, channels and functions, through Carbon Cloud's API with
// the device login or a personal credential.
//
// Every subcommand prints Cloud's JSON answer and nothing else on standard
// output, so its output can be piped. Messages go to standard error.

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { log } from "@carbon/logging";
import { DeviceCredentialStore } from "../../../infrastructure/cloud/DeviceCredentialStore.ts";
import { PlatformApiError, PlatformCredentialClient, resolvePlatformCredential, type PlatformCredential, type PlatformRequest } from "../../../infrastructure/cloud/PlatformCredentialClient.ts";

export type PlatformFamily = "builds" | "releases" | "channels" | "functions";

export interface PlatformCommandDependencies {
  readonly credential: () => Promise<PlatformCredential>;
  readonly client: Pick<PlatformCredentialClient, "request">;
  readonly print: (text: string) => void;
  readonly sleep: (ms: number) => Promise<void>;
}

function defaultDependencies(): PlatformCommandDependencies {
  const store = new DeviceCredentialStore();
  return { credential: () => resolvePlatformCredential(store), client: new PlatformCredentialClient(), print: text => log.raw(text), sleep: ms => Bun.sleep(ms) };
}

class UsageError extends Error {}
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Splits arguments into positionals and `--name value` options. An option may be given more than once only if it is in `repeatable`. */
function parse(args: readonly string[], allowed: readonly string[], repeatable: readonly string[] = [], flags: readonly string[] = []) {
  const positionals: string[] = []; const options = new Map<string, string[]>(); const set = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (!arg.startsWith("--")) { positionals.push(arg); continue; }
    const name = arg.slice(2);
    if (flags.includes(name)) { set.add(name); continue; }
    if (!allowed.includes(name)) throw new UsageError(`unknown option --${name}`);
    const value = args[index + 1]; if (value === undefined) throw new UsageError(`--${name} needs a value`);
    index++; const existing = options.get(name) ?? [];
    if (existing.length && !repeatable.includes(name)) throw new UsageError(`--${name} was given more than once`);
    options.set(name, [...existing, value]);
  }
  return { positionals, one: (name: string) => options.get(name)?.[0], many: (name: string) => options.get(name) ?? [], flag: (name: string) => set.has(name) };
}
function identifier(value: string | undefined, what: string): string {
  if (!value || !ID.test(value)) throw new UsageError(`${what} must be an identifier`);
  return value.toLowerCase();
}
function json(text: string, what: string): unknown { try { return JSON.parse(text); } catch { throw new UsageError(`${what} must be valid JSON`); } }
function file(path: string, what: string): string { try { return readFileSync(path, "utf8"); } catch { throw new UsageError(`cannot read ${what} file ${path}`); } }
function integer(value: string | undefined, what: string, min: number, max: number): number {
  const number = Number(value); if (!value || !Number.isInteger(number) || number < min || number > max) throw new UsageError(`${what} must be a whole number from ${min} to ${max}`);
  return number;
}
const exactly = (positionals: readonly string[], count: number, usage: string) => { if (positionals.length !== count) throw new UsageError(`usage: ${usage}`); };

const HELP: Record<PlatformFamily, string> = {
  builds: `carbon cloud builds <subcommand>
  list                                   every build of the environment, newest first
  show <buildId>                         one build
  logs <buildId> [--after <sequence>]    its log segments
  provenance <buildId>                   its signed provenance
  create --repo <url> --commit <sha> --target <name>... --platform <windows|linux|macos> [--secret <NAME>]...
  cancel <buildId>`,
  releases: `carbon cloud releases <subcommand>
  list
  show <releaseId>
  create --file <release.json>           the release as JSON: buildId, version, notes, minVersion, signingProfileId, artifacts
  withdraw <releaseId> --reason <text>`,
  channels: `carbon cloud channels <subcommand>
  list
  show <name>
  publish <name> --release <releaseId> --rollout <0-100>   a channel exists from its first publish
  rollout <name> --rollout <0-100>
  command <name> --command <json>        any other channel command, as JSON`,
  functions: `carbon cloud functions <subcommand>
  list
  show <functionId>
  deploy <name> --file <module.js> [--secret <NAME>]... [--timeout <seconds>]
  invoke <functionId> [--input <json>] [--wait] [--wait-seconds <n>]
  executions <functionId>
  execution <executionId>
  logs <executionId>
  cancel <executionId>
  retry <executionId>
  schedules <functionId>
  schedule <functionId> (--every <seconds> | --cron "<m h dom mon dow>" --zone <IANA zone>) [--input <json>]
  enable|disable <functionId>
  activate <functionId> --revision <number>`,
};

/** Runs one subcommand. Returns the process exit code: 0 done, 1 Cloud refused or could not be reached, 2 wrong usage. */
export async function platformCommand(family: PlatformFamily, args: readonly string[], dependencies: PlatformCommandDependencies = defaultDependencies()): Promise<number> {
  const [subcommand, ...rest] = args;
  if (!subcommand || subcommand === "--help" || subcommand === "-h" || subcommand === "help") { dependencies.print(HELP[family] + "\n"); return subcommand ? 0 : 2; }
  try {
    const credential = await dependencies.credential();
    const call = (request: PlatformRequest) => dependencies.client.request(credential, request);
    const get = (path: string) => call({ method: "GET", path });
    const post = (path: string, body: unknown, revision?: string) => call({ method: "POST", path, body, revision, idempotencyKey: randomUUID() });
    /** A command on something that exists is sent with the revision it has now, so it cannot land on a state the caller never saw. */
    const revisionOf = async (path: string, pick: (value: any) => unknown) => { const revision = pick(await get(path)); if (typeof revision !== "string") throw new Error("Carbon Cloud did not report a revision"); return revision; };
    const result = await run(family, subcommand, rest, { get, post, revisionOf, sleep: dependencies.sleep });
    dependencies.print(JSON.stringify(result, null, 2) + "\n");
    return 0;
  } catch (error) {
    if (error instanceof UsageError) { log.error(error.message); return 2; }
    if (error instanceof PlatformApiError) { log.error(`${error.message} (${error.code})`); return 1; }
    log.error(error instanceof Error ? error.message : "The command failed"); return 1;
  }
}

interface Api {
  get(path: string): Promise<unknown>;
  post(path: string, body: unknown, revision?: string): Promise<unknown>;
  revisionOf(path: string, pick: (value: any) => unknown): Promise<string>;
  sleep(ms: number): Promise<void>;
}

async function run(family: PlatformFamily, subcommand: string, rest: readonly string[], api: Api): Promise<unknown> {
  if (family === "builds") {
    if (subcommand === "list") { exactly(parse(rest, []).positionals, 0, "carbon cloud builds list"); return api.get("/builds"); }
    if (subcommand === "show") { const p = parse(rest, []); exactly(p.positionals, 1, "carbon cloud builds show <buildId>"); return api.get(`/builds/${identifier(p.positionals[0], "buildId")}`); }
    if (subcommand === "provenance") { const p = parse(rest, []); exactly(p.positionals, 1, "carbon cloud builds provenance <buildId>"); return api.get(`/builds/${identifier(p.positionals[0], "buildId")}/provenance`); }
    if (subcommand === "logs") {
      const p = parse(rest, ["after"]); exactly(p.positionals, 1, "carbon cloud builds logs <buildId> [--after <sequence>]");
      const after = p.one("after") === undefined ? "" : `?after=${integer(p.one("after"), "--after", 0, 100000)}`;
      return api.get(`/builds/${identifier(p.positionals[0], "buildId")}/logs${after}`);
    }
    if (subcommand === "create") {
      const p = parse(rest, ["repo", "commit", "target", "platform", "secret"], ["target", "secret"]); exactly(p.positionals, 0, "carbon cloud builds create --repo <url> --commit <sha> --target <name>... --platform <platform>");
      if (!p.one("repo") || !p.one("commit") || !p.many("target").length || !p.one("platform")) throw new UsageError("create needs --repo, --commit, at least one --target, and --platform");
      return api.post("/builds", { repositoryUrl: p.one("repo"), commitSha: p.one("commit"), targets: p.many("target"), secretNames: p.many("secret"), platform: p.one("platform") });
    }
    if (subcommand === "cancel") {
      const p = parse(rest, []); exactly(p.positionals, 1, "carbon cloud builds cancel <buildId>"); const path = `/builds/${identifier(p.positionals[0], "buildId")}`;
      return api.post(path, { kind: "cancel" }, await api.revisionOf(path, value => value?.build?.revision ?? value?.revision));
    }
  }
  if (family === "releases") {
    if (subcommand === "list") { exactly(parse(rest, []).positionals, 0, "carbon cloud releases list"); return api.get("/releases"); }
    if (subcommand === "show") { const p = parse(rest, []); exactly(p.positionals, 1, "carbon cloud releases show <releaseId>"); return api.get(`/releases/${identifier(p.positionals[0], "releaseId")}`); }
    if (subcommand === "create") { const p = parse(rest, ["file"]); exactly(p.positionals, 0, "carbon cloud releases create --file <release.json>"); if (!p.one("file")) throw new UsageError("create needs --file"); return api.post("/releases", json(file(p.one("file")!, "release"), "the release file")); }
    if (subcommand === "withdraw") {
      const p = parse(rest, ["reason"]); exactly(p.positionals, 1, "carbon cloud releases withdraw <releaseId> --reason <text>"); if (!p.one("reason")) throw new UsageError("withdraw needs --reason");
      const path = `/releases/${identifier(p.positionals[0], "releaseId")}`;
      return api.post(path, { kind: "withdraw", reason: p.one("reason") }, await api.revisionOf(path, value => value?.release?.revision ?? value?.revision));
    }
  }
  if (family === "channels") {
    if (subcommand === "list") { exactly(parse(rest, []).positionals, 0, "carbon cloud channels list"); return api.get("/channels"); }
    // A channel is known by its name, not by an identifier.
    const channel = (value: string | undefined) => { if (!value || !/^[a-z0-9][a-z0-9._-]{0,62}$/.test(value)) throw new UsageError("a channel name is lower-case letters, digits, dots, dashes and underscores"); return `/channels/${value}`; };
    if (subcommand === "show") { const p = parse(rest, []); exactly(p.positionals, 1, "carbon cloud channels show <name>"); return api.get(channel(p.positionals[0])); }
    if (["publish", "rollout", "command"].includes(subcommand)) {
      const p = parse(rest, ["release", "rollout", "command"]); exactly(p.positionals, 1, `carbon cloud channels ${subcommand} <name> ...`); const path = channel(p.positionals[0]);
      const body = subcommand === "publish" ? { kind: "publish", releaseId: identifier(p.one("release"), "--release"), rollout: integer(p.one("rollout"), "--rollout", 0, 100) }
        : subcommand === "rollout" ? { kind: "rollout", rollout: integer(p.one("rollout"), "--rollout", 0, 100) }
        : json(p.one("command") ?? (() => { throw new UsageError("command needs --command"); })(), "--command");
      return api.post(path, body, await api.revisionOf(path, value => value?.channel?.revision ?? value?.revision));
    }
  }
  if (family === "functions") {
    const fn = (p: { positionals: readonly string[] }, usage: string) => { exactly(p.positionals, 1, usage); return `/functions/${identifier(p.positionals[0], "functionId")}`; };
    const execution = (p: { positionals: readonly string[] }, usage: string) => { exactly(p.positionals, 1, usage); return `/executions/${identifier(p.positionals[0], "executionId")}`; };
    const functionRevision = (path: string) => api.revisionOf(path, value => value?.function?.revision);
    if (subcommand === "list") { exactly(parse(rest, []).positionals, 0, "carbon cloud functions list"); return api.get("/functions"); }
    if (subcommand === "show") return api.get(fn(parse(rest, []), "carbon cloud functions show <functionId>"));
    if (subcommand === "executions") return api.get(`${fn(parse(rest, []), "carbon cloud functions executions <functionId>")}/executions`);
    if (subcommand === "schedules") return api.get(`${fn(parse(rest, []), "carbon cloud functions schedules <functionId>")}/schedules`);
    if (subcommand === "execution") return api.get(execution(parse(rest, []), "carbon cloud functions execution <executionId>"));
    if (subcommand === "logs") return api.get(`${execution(parse(rest, []), "carbon cloud functions logs <executionId>")}/logs`);
    if (subcommand === "deploy") {
      const p = parse(rest, ["file", "secret", "timeout"], ["secret"]); exactly(p.positionals, 1, "carbon cloud functions deploy <name> --file <module.js>"); if (!p.one("file")) throw new UsageError("deploy needs --file");
      return api.post("/functions", { name: p.positionals[0], code: file(p.one("file")!, "module"), secretNames: p.many("secret"), timeoutSeconds: p.one("timeout") === undefined ? 30 : integer(p.one("timeout"), "--timeout", 1, 300) });
    }
    if (subcommand === "invoke") {
      const p = parse(rest, ["input", "wait-seconds"], [], ["wait"]); const path = fn(p, "carbon cloud functions invoke <functionId> [--input <json>] [--wait]");
      const limit = p.one("wait-seconds") === undefined ? 300 : integer(p.one("wait-seconds"), "--wait-seconds", 1, 3600);
      const receipt = await api.post(`${path}/invoke`, { input: p.one("input") === undefined ? null : json(p.one("input")!, "--input") }) as { execution?: { id?: unknown; state?: unknown } };
      if (!p.flag("wait")) return receipt;
      const executionId = identifier(String(receipt.execution?.id ?? ""), "the execution Cloud returned"); const deadline = Date.now() + limit * 1000;
      // Follows the execution until it is over. Invoking is not repeated: only the reading is.
      for (;;) {
        const current = await api.get(`/executions/${executionId}`) as { state?: unknown };
        if (current.state !== "queued" && current.state !== "running") return current;
        if (Date.now() >= deadline) throw new Error(`the execution was still ${String(current.state)} after ${limit} seconds; follow it with: carbon cloud functions execution ${executionId}`);
        await api.sleep(1000);
      }
    }
    if (subcommand === "cancel" || subcommand === "retry") {
      const path = execution(parse(rest, []), `carbon cloud functions ${subcommand} <executionId>`);
      return api.post(path, { kind: subcommand }, await api.revisionOf(path, value => value?.revision));
    }
    if (subcommand === "enable" || subcommand === "disable") { const path = fn(parse(rest, []), `carbon cloud functions ${subcommand} <functionId>`); return api.post(path, { kind: subcommand }, await functionRevision(path)); }
    if (subcommand === "activate") {
      const p = parse(rest, ["revision"]); const path = fn(p, "carbon cloud functions activate <functionId> --revision <number>");
      return api.post(path, { kind: "activate", revision: integer(p.one("revision"), "--revision", 1, 1000000) }, await functionRevision(path));
    }
    if (subcommand === "schedule") {
      const p = parse(rest, ["every", "cron", "zone", "input"]); const path = fn(p, "carbon cloud functions schedule <functionId> (--every <seconds> | --cron <expression> --zone <zone>)");
      const every = p.one("every"); const cron = p.one("cron"); const zone = p.one("zone");
      if ((every === undefined) === (cron === undefined)) throw new UsageError("schedule needs exactly one of --every or --cron");
      if (cron !== undefined && !zone) throw new UsageError("--cron needs --zone, an IANA time zone such as Europe/Brussels");
      if (every !== undefined && zone) throw new UsageError("--zone goes with --cron");
      const input = p.one("input") === undefined ? {} : { input: json(p.one("input")!, "--input") };
      return api.post(`${path}/schedules`, every !== undefined ? { intervalSeconds: integer(every, "--every", 60, 604800), ...input } : { cron, timeZone: zone, ...input });
    }
  }
  throw new UsageError(`unknown ${family} subcommand "${subcommand}"\n${HELP[family]}`);
}

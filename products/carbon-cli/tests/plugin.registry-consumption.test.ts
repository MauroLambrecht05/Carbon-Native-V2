import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BufferedIo, CommandContext, CommandRegistry, EXIT_FAILURE, EXIT_OK, EXIT_USAGE, HelpRenderer, parseArgv } from "@carbon/cli";
import { DECLARATION_PATH, INSTALL_ROOT, LOCK_PATH, NodePackageCache, NodePluginProject, RegistryPlugins, type PluginHost } from "@carbon/catalog";
import { FakeRegistry } from "../../../solutions/capabilities/cloud/catalog/tests/registry-fixture.ts";
import { hostPluginAbi, hostTarget } from "../composition/registry-plugins.ts";
import { PluginCommand } from "../presentation/commands/plugins/plugin.command.ts";
import { RegistryPluginCommand } from "../presentation/commands/plugins/registry.command.ts";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
const host: PluginHost = { target: "x86_64-pc-windows-msvc", abiMajor: 1, abiMinor: 23 };

/** The command group over a temporary project, a temporary cache and an in-memory Registry. */
function cli(registry = new FakeRegistry()) {
  const root = mkdtempSync(join(tmpdir(), "carbon-cli-registry-")); roots.push(root);
  const command = new RegistryPluginCommand(projectRoot => new RegistryPlugins(new NodePluginProject(projectRoot), registry, new NodePackageCache(join(root, "cache")), host));
  const run = async (...argv: string[]) => {
    const io = new BufferedIo(); const parsed = parseArgv(argv, command.subcommands.flatMap(sub => sub.meta.flags ?? []));
    const code = await command.execute(new CommandContext({ args: parsed.args, flags: parsed.flags, passthrough: parsed.passthrough, cwd: root, io, help: new HelpRenderer(new CommandRegistry(), io, "carbon", "test"), argv }));
    return { code, output: io.lines.join("\n") };
  };
  return { registry, root, run, read: (path: string) => (existsSync(join(root, path)) ? readFileSync(join(root, path), "utf8") : undefined) };
}

describe("carbon plugin registry", () => {
  test("is a subcommand group of `plugin` with every workflow", () => {
    const group = new PluginCommand().subcommands.find(sub => sub.meta.name === "registry")!;
    expect((group as RegistryPluginCommand).subcommands.map(sub => sub.meta.name)).toEqual(["init", "add", "install", "update", "remove", "audit", "list"]);
  });

  test("the host is described from this machine and the SDK header", () => {
    expect(hostPluginAbi().abiMajor).toBe(1); expect(hostPluginAbi().abiMinor).toBeGreaterThan(0);
    expect(hostTarget("win32", "x64")).toBe("x86_64-pc-windows-msvc"); expect(hostTarget("darwin", "arm64")).toBe("aarch64-apple-darwin"); expect(() => hostTarget("sunos", "sparc")).toThrow();
  });

  test("init, add, list, update, audit, install and remove report what they did and exit accordingly", async () => {
    const c = cli(); const key = "acme/clipboard"; c.registry.publish(key, "1.2.0", { required: ["clipboard.read"] });
    // Usage errors are caught before anything runs.
    expect((await c.run("init")).code).toBe(EXIT_USAGE); expect((await c.run("add")).code).toBe(EXIT_USAGE); expect((await c.run("remove")).code).toBe(EXIT_USAGE); expect((await c.run("explode")).code).toBe(EXIT_USAGE);
    // Nothing works before the project says which Registry and root key it trusts.
    const early = await c.run("add", key); expect(early.code).toBe(EXIT_FAILURE); expect(early.output).toContain("carbon plugin registry init");
    expect((await c.run("init", "--registry", c.registry.origin, "--root-key", "nonsense")).code).toBe(EXIT_FAILURE);
    const init = await c.run("init", "--registry", c.registry.origin, "--root-key", c.registry.rootPublicKey); expect(init.code).toBe(EXIT_OK); expect(init.output).toContain(c.registry.origin);

    // A capability nobody approved stops the command, names the capability, and writes nothing.
    const refused = await c.run("add", key); expect(refused.code).toBe(EXIT_FAILURE); expect(refused.output).toContain("clipboard.read"); expect(refused.output).toContain("--approve clipboard.read"); expect(c.read(LOCK_PATH)).toBeUndefined();
    const added = await c.run("add", key, "--approve", "clipboard.read"); expect(added.code).toBe(EXIT_OK); expect(added.output).toContain("1.2.0"); expect(added.output).toContain("verified");
    expect(JSON.parse(c.read(DECLARATION_PATH)!).plugins).toEqual({ [key]: "^1.2.0" }); expect(existsSync(join(c.root, INSTALL_ROOT, key, host.target, "clipboard.dll"))).toBe(true);
    expect((await c.run("list")).output).toContain(`${key}  ^1.2.0  1.2.0  installed`);

    expect((await c.run("update")).output).toContain("Nothing to update");
    c.registry.publish(key, "1.3.0", { required: ["clipboard.read"] }); const updated = await c.run("update", key); expect(updated.code).toBe(EXIT_OK); expect(updated.output).toContain("1.2.0 → 1.3.0");
    expect((await c.run("install")).output).toContain("Up to date");

    // Audit: clean, then a yank (still a success), then a revocation (a failure).
    expect((await c.run("audit")).code).toBe(EXIT_OK);
    c.registry.mark(key, "1.3.0", { yanked: true, reason: "superseded" }); const yanked = await c.run("audit"); expect(yanked.code).toBe(EXIT_OK); expect(yanked.output).toContain("yanked (superseded)");
    c.registry.mark(key, "1.3.0", { state: "revoked", yanked: false, reason: "steals credentials" }); const revoked = await c.run("audit"); expect(revoked.code).toBe(EXIT_FAILURE); expect(revoked.output).toContain("revoked (steals credentials)");

    // Offline with a warm cache works after the files are lost; a trust failure is reported as one.
    rmSync(join(c.root, INSTALL_ROOT), { recursive: true }); c.registry.down = true;
    expect((await c.run("install")).code).toBe(EXIT_FAILURE); const offline = await c.run("install", "--offline"); expect(offline.code).toBe(EXIT_OK); expect(offline.output).toContain("installed");
    c.registry.down = false; rmSync(join(c.root, INSTALL_ROOT), { recursive: true });
    const blocked = await c.run("install"); expect(blocked.code).toBe(EXIT_FAILURE); expect(blocked.output).toContain("was revoked: steals credentials");

    const removed = await c.run("remove", key); expect(removed.code).toBe(EXIT_OK); expect(JSON.parse(c.read(DECLARATION_PATH)!).plugins).toEqual({}); expect(JSON.parse(c.read(LOCK_PATH)!).plugins).toEqual({});
    expect((await c.run("list")).output).toContain("No packages declared"); expect((await c.run("remove", key)).code).toBe(EXIT_FAILURE);
  });
});

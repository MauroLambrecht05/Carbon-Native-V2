// `carbon plugin check` and `carbon run`'s preflight, against a memory
// workspace.
//
// Both use cases exist to move a failure from the runtime's stderr to the
// toolchain, so what they are tested on is: does each one catch the thing the
// runtime would have caught, and does it say which file to edit.

import { describe, expect, test } from "bun:test";

import {
  CheckPluginUseCase,
  hostArchName,
  hostExt,
  hostOsName,
  NoHostAppError,
  NotAPluginDirectoryError,
  parsePluginDeclaration,
  PreflightPluginsUseCase,
  type PluginWorkspace,
} from "../index.ts";

// A minimal in-memory PluginWorkspace: the use cases under test only read.
//
// Keys are normalised to forward slashes, because the use cases build paths
// with node:path `join`, which emits backslashes on Windows. Without that the
// tests pass on CI and fail on a developer machine, which is worse than
// failing everywhere.
class MemoryWorkspace implements PluginWorkspace {
  readonly files = new Map<string, string>();

  private key(path: string): string {
    return path.replaceAll("\\", "/");
  }

  put(path: string, contents = ""): void {
    this.files.set(this.key(path), contents);
  }
  exists(path: string): boolean {
    const k = this.key(path);
    return this.files.has(k) || [...this.files.keys()].some((f) => f.startsWith(`${k}/`));
  }
  readFile(path: string): string {
    const found = this.files.get(this.key(path));
    if (found === undefined) throw new Error(`no such file: ${path}`);
    return found;
  }
  writeFile(path: string, contents: string): void {
    this.files.set(this.key(path), contents);
  }
  createDirectory(): void {}
  copyFile(from: string, to: string): void {
    this.files.set(this.key(to), this.readFile(from));
  }
  listDirectories(path: string): string[] {
    const prefix = `${this.key(path)}/`;
    const names = new Set<string>();
    for (const f of this.files.keys()) {
      if (!f.startsWith(prefix)) continue;
      const rest = f.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash > 0) names.add(rest.slice(0, slash));
    }
    return [...names];
  }
  listFiles(path: string): string[] {
    const prefix = `${this.key(path)}/`;
    const names: string[] = [];
    for (const f of this.files.keys()) {
      if (!f.startsWith(prefix)) continue;
      const rest = f.slice(prefix.length);
      if (!rest.includes("/")) names.push(rest);
    }
    return names;
  }
  isEmptyDirectory(path: string): boolean {
    return !this.exists(path);
  }
  findHostApp(from: string): string | null {
    let dir = this.key(from);
    for (;;) {
      if (this.files.has(`${dir}/carbon.toml`)) return dir;
      const parent = dir.slice(0, dir.lastIndexOf("/"));
      if (!parent || parent === dir) return null;
      dir = parent;
    }
  }
}

const ROOT = "/work/carbon";

describe("parsing what a manifest declares", () => {
  test("reads extension-points and both capability lists", () => {
    const declaration = parsePluginDeclaration(`
name = "x"
extension-points = ["lifecycle.register", "paint.before"]

[capabilities]
required = ["paint.pixmap"]
optional = ["fs.read"]
`);

    expect(declaration.extensionPoints).toEqual(["lifecycle.register", "paint.before"]);
    expect(declaration.requiredCapabilities).toEqual(["paint.pixmap"]);
    expect(declaration.optionalCapabilities).toEqual(["fs.read"]);
  });

  test("still reads the ABI 1.0 spelling, so old manifests keep working", () => {
    const declaration = parsePluginDeclaration(`hooks = ["lifecycle.register"]`);
    expect(declaration.extensionPoints).toEqual(["lifecycle.register"]);
  });

  test("a `required` outside [capabilities] is not mistaken for one inside", () => {
    const declaration = parsePluginDeclaration(`
required = ["not-a-capability"]

[capabilities]
optional = ["fs.read"]
`);
    expect(declaration.requiredCapabilities).toEqual([]);
    expect(declaration.optionalCapabilities).toEqual(["fs.read"]);
  });

  test("a comment after the value is not part of it", () => {
    const declaration = parsePluginDeclaration(`extension-points = ["a.b"]  # note`);
    expect(declaration.extensionPoints).toEqual(["a.b"]);
  });

  test("an absent key reads as empty, not as a failure", () => {
    const declaration = parsePluginDeclaration(`name = "x"`);
    expect(declaration.extensionPoints).toEqual([]);
    expect(declaration.requiredCapabilities).toEqual([]);
  });
});

describe("checking a plugin", () => {
  function plugin(manifest: string) {
    const workspace = new MemoryWorkspace();
    workspace.put(`${ROOT}/p/build.zig`);
    workspace.put(`${ROOT}/p/carbon-plugin.toml`, manifest);
    return { workspace, useCase: new CheckPluginUseCase(workspace) };
  }

  test("a well-formed plugin passes and reports its points", () => {
    const { useCase } = plugin(`
name = "good"
language = "zig"
extension-points = ["lifecycle.register"]

[capabilities]
required = []
`);

    const result = useCase.execute(`${ROOT}/p`);
    expect(result.ok).toBe(true);
    expect(result.name).toBe("good");
    expect(result.points.map((p) => p.id)).toEqual(["lifecycle.register"]);
  });

  test("an unknown point is an error, and the message lists the real ones", () => {
    const { useCase } = plugin(`
name = "typo"
extension-points = ["lifecycle.registerr"]
`);

    const result = useCase.execute(`${ROOT}/p`);
    expect(result.ok).toBe(false);
    const finding = result.findings.find((f) => f.severity === "error")!;
    expect(finding.message).toContain("lifecycle.registerr");
    expect(finding.fix).toContain("lifecycle.register");
  });

  test("a point whose capability is not required is an error naming the fix", () => {
    // paint.before gates on paint.pixmap. The runtime refuses to load this.
    const { useCase } = plugin(`
name = "painter"
extension-points = ["paint.before"]

[capabilities]
required = []
`);

    const result = useCase.execute(`${ROOT}/p`);
    expect(result.ok).toBe(false);
    const finding = result.findings.find((f) => f.severity === "error")!;
    expect(finding.message).toContain("paint.pixmap");
    expect(finding.fix).toContain("carbon-plugin.toml");
  });

  test("declaring the capability makes the same plugin pass", () => {
    const { useCase } = plugin(`
name = "painter"
extension-points = ["paint.before"]

[capabilities]
required = ["paint.pixmap"]
`);
    expect(useCase.execute(`${ROOT}/p`).ok).toBe(true);
  });

  test("an experimental point warns but does not fail", () => {
    const { useCase } = plugin(`
name = "resolver"
extension-points = ["host.resolve_asset"]

[capabilities]
required = ["fs.read"]
`);

    const result = useCase.execute(`${ROOT}/p`);
    expect(result.ok).toBe(true);
    expect(result.findings.some((f) => /experimental/.test(f.message))).toBe(true);
  });

  test("declaring nothing warns that the plugin would do nothing", () => {
    const { useCase } = plugin(`name = "empty"`);
    const result = useCase.execute(`${ROOT}/p`);

    expect(result.ok).toBe(true);
    expect(result.findings.some((f) => /would load and do nothing/.test(f.message))).toBe(true);
  });

  test("a capability no point needs warns rather than failing", () => {
    // The clipboard plugin's real shape: capabilities for its own work.
    const { useCase } = plugin(`
name = "clip"
extension-points = ["lifecycle.register"]

[capabilities]
required = ["clipboard.read"]
`);

    const result = useCase.execute(`${ROOT}/p`);
    expect(result.ok).toBe(true);
    expect(result.findings.some((f) => /no declared extension point needs it/.test(f.message))).toBe(
      true,
    );
  });

  test("a directory that is not a plugin is refused before anything else", () => {
    const workspace = new MemoryWorkspace();
    workspace.put(`${ROOT}/nope/README.md`);
    expect(() => new CheckPluginUseCase(workspace).execute(`${ROOT}/nope`)).toThrow(
      NotAPluginDirectoryError,
    );
  });

  test("a plugin with no manifest is an error, not a crash", () => {
    const workspace = new MemoryWorkspace();
    workspace.put(`${ROOT}/bare/build.zig`);

    const result = new CheckPluginUseCase(workspace).execute(`${ROOT}/bare`);
    expect(result.ok).toBe(false);
    expect(result.findings[0].message).toContain("no carbon-plugin.toml");
  });
});

describe("preflighting an app", () => {
  const GRANTED_NONE = `[app]\nname = "demo"\n`;
  const GRANTED_PIXMAP = `[app]\nname = "demo"\n\n[plugins.clip]\ncapabilities = ["paint.pixmap"]\n`;

  function app(
    options: { granted?: string; declared?: boolean; installed?: boolean; manifest?: string } = {},
  ) {
    const workspace = new MemoryWorkspace();
    workspace.put(`${ROOT}/app/carbon.toml`, options.granted ?? GRANTED_NONE);
    if (options.declared !== false) {
      workspace.put(
        `${ROOT}/app/carbon/manifest.toml`,
        `schema = 1\n\n[plugins.clip]\nsource = "vendor"\nenabled = true\n`,
      );
    }
    if (options.installed !== false) {
      const nativeDir = `${ROOT}/app/carbon/native/${hostOsName()}/${hostArchName()}`;
      workspace.put(`${nativeDir}/clip.${hostExt()}`, "ELF");
    }
    if (options.manifest) {
      workspace.put(`${ROOT}/app/carbon/plugins/vendor/clip/carbon-plugin.toml`, options.manifest);
    }
    return new PreflightPluginsUseCase(workspace);
  }

  test("an app with no plugins is fine and reports nothing", () => {
    const useCase = app({ declared: false, installed: false });
    const result = useCase.execute(`${ROOT}/app`);

    expect(result.ok).toBe(true);
    expect(result.checked).toBe(0);
    expect(result.problems).toEqual([]);
  });

  test("a declared plugin whose library is missing is an error with the build command", () => {
    const useCase = app({ installed: false });
    const result = useCase.execute(`${ROOT}/app`);

    expect(result.ok).toBe(false);
    expect(result.problems[0].plugin).toBe("clip");
    expect(result.problems[0].message).toContain("does not exist");
    expect(result.problems[0].fix).toContain("carbon dev");
  });

  test("a plugin present with no manifest beside it passes — only the library ships", () => {
    const useCase = app();
    const result = useCase.execute(`${ROOT}/app`);

    expect(result.ok).toBe(true);
    expect(result.checked).toBe(1);
  });

  test("an ungranted point capability is an error carrying the carbon.toml to paste", () => {
    const useCase = app({
      manifest: `name = "clip"\nextension-points = ["paint.before"]\n`,
    });

    const result = useCase.execute(`${ROOT}/app`);
    expect(result.ok).toBe(false);
    expect(result.problems[0].message).toContain("paint.pixmap");
    expect(result.problems[0].fix).toContain("[plugins.clip]");
  });

  test("granting it in carbon.toml clears the error", () => {
    const useCase = app({
      granted: GRANTED_PIXMAP,
      manifest: `name = "clip"\nextension-points = ["paint.before"]\n`,
    });

    expect(useCase.execute(`${ROOT}/app`).ok).toBe(true);
  });

  test("a point this runtime does not have warns, because the plugin is newer", () => {
    const useCase = app({
      manifest: `name = "clip"\nextension-points = ["future.point"]\n`,
    });

    const result = useCase.execute(`${ROOT}/app`);
    expect(result.ok).toBe(true);
    expect(result.problems[0].severity).toBe("warning");
    expect(result.problems[0].fix).toContain("newer SDK");
  });

  test("no host app at all is refused rather than reported as clean", () => {
    const workspace = new MemoryWorkspace();
    expect(() => new PreflightPluginsUseCase(workspace).execute("/nowhere")).toThrow(
      NoHostAppError,
    );
  });
});

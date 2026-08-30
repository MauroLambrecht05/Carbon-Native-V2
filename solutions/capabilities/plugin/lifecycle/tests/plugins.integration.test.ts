// Plugin authoring, building and installing, end to end.
//
// Against an in-memory workspace rather than a temp directory, because the
// interesting states are ones a temp directory cannot reach without a
// toolchain: a plugin whose .so has been built, a host app four levels up, a
// carbon.toml with comments and unrelated sections that must survive an edit.
//
// The one thing a fake filesystem cannot check is that NodePluginWorkspace
// implements the port faithfully, so its walk-up search is covered separately
// against the real disk at the bottom of this file.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ProcessOptions, ProcessResult, ProcessRunner } from "@carbon/process";
import {
  AddStandardPluginUseCase,
  ArtifactNotFoundError,
  BuildPluginUseCase,
  CreatePluginUseCase,
  forwardSlashes,
  grantedCapabilities,
  hostArchName,
  hostExt,
  hostOsName,
  InspectPluginsUseCase,
  InstallPluginUseCase,
  NodePluginWorkspace,
  NoHostAppError,
  NotAPluginDirectoryError,
  PluginManifest,
  PluginName,
  PluginNotFoundError,
  readAppManifest,
  setManifestEnabled,
  SyncPluginsUseCase,
  TargetNotEmptyError,
  UnknownLanguageError,
  UnknownStandardPluginError,
  upsertManifestEntry,
  type PluginTemplateFile,
  type PluginTemplateRequest,
  type PluginTemplateSource,
  type PluginWorkspace,
} from "../index.ts";

// ── Fakes ───────────────────────────────────────────────────────────────────

/** A workspace held in a Map, keyed by normalised absolute path. */
class MemoryWorkspace implements PluginWorkspace {
  readonly files = new Map<string, string>();
  readonly directories = new Set<string>();

  private key(path: string): string {
    return path.replaceAll("\\", "/");
  }

  put(path: string, contents = ""): void {
    this.files.set(this.key(path), contents);
  }

  exists(path: string): boolean {
    const k = this.key(path);
    if (this.files.has(k) || this.directories.has(k)) return true;
    // A directory exists implicitly once something is under it.
    return [...this.files.keys()].some((f) => f.startsWith(`${k}/`));
  }

  isEmptyDirectory(path: string): boolean {
    return !this.exists(path);
  }

  readFile(path: string): string {
    const contents = this.files.get(this.key(path));
    if (contents === undefined) throw new Error(`ENOENT: ${path}`);
    return contents;
  }

  writeFile(path: string, contents: string): void {
    this.files.set(this.key(path), contents);
  }

  createDirectory(path: string): void {
    this.directories.add(this.key(path));
  }

  copyFile(from: string, to: string): void {
    this.files.set(this.key(to), this.readFile(from));
  }

  listDirectories(path: string): string[] {
    const prefix = `${this.key(path)}/`;
    const names = new Set<string>();
    const under = (full: string) => {
      if (!full.startsWith(prefix)) return;
      const rest = full.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash > 0) names.add(rest.slice(0, slash));
    };
    for (const f of this.files.keys()) under(f);
    for (const d of this.directories) under(`${d}/.`);
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

  findHostApp(from: string): string | null {
    let current = this.key(from);
    while (true) {
      if (this.files.has(`${current}/carbon.toml`)) return current;
      const parent = current.slice(0, current.lastIndexOf("/"));
      if (!parent || parent === current) return null;
      current = parent;
    }
  }
}

class FakeProcessRunner implements ProcessRunner {
  readonly calls: Array<{ command: string; args: string[]; options?: ProcessOptions }> = [];
  constructor(private readonly code = 0) {}
  async run(command: string, args: string[], options?: ProcessOptions): Promise<ProcessResult> {
    this.calls.push({ command, args, options });
    return { code: this.code, signal: null };
  }
}

/**
 * Stands in for BuildPluginUseCase's real toolchain resolution
 * (ZigToolchain.ts's ensureZig, by default) — hands back `language.
 * buildCommand` verbatim instead. Without this every test with a build.zig
 * marker would spawn a real `zig version` probe (and, on a machine with no
 * Zig, attempt a real network download) just to build a fake plugin against
 * a FakeProcessRunner that never actually runs anything. What these tests
 * verify — language detection, --release becoming the right flag, the
 * spawned args — has nothing to do with how the command string was
 * resolved, so this keeps that concern out of them entirely.
 */
const resolveBareCommand = async (language: { buildCommand: string }) => language.buildCommand;

/** Stands in for the SDK templates, which are not present in V2. */
class FakeTemplateSource implements PluginTemplateSource {
  filesFor(request: PluginTemplateRequest): PluginTemplateFile[] {
    const source = "src/main.zig";
    return [
      { path: "carbon-plugin.toml", contents: `name = "${request.name.slug}"\nlanguage = "${request.language.id}"\n` },
      { path: source, contents: `// crate ${request.name.crate}\n` },
      { path: request.language.marker, contents: `sdk = "${request.sdkPath}"\n` },
    ];
  }

  appCarbonDirFiles(): PluginTemplateFile[] {
    return [
      { path: "build.zig", contents: "// app orchestrator\n" },
      { path: "build.zig.zon", contents: ".{ .name = .carbon_app }\n" },
      { path: "manifest.toml", contents: "schema = 1\n" },
    ];
  }
}

const ROOT = "/work/carbon";

// ── Domain ──────────────────────────────────────────────────────────────────

describe("plugin names", () => {
  test("a slug becomes a legal crate identifier", () => {
    const name = PluginName.from("My Cool Plugin");
    expect(name.slug).toBe("my-cool-plugin");
    // Hyphens are not legal in Rust or Zig identifiers.
    expect(name.crate).toBe("my_cool_plugin");
  });

  test("the library filename follows the platform convention", () => {
    const name = PluginName.from("my-thing");
    expect(name.libraryFilename("win32")).toBe("my_thing.dll");
    expect(name.libraryFilename("darwin")).toBe("libmy_thing.dylib");
    expect(name.libraryFilename("linux")).toBe("libmy_thing.so");
  });
});

describe("the plugin manifest", () => {
  test("reads name and language", () => {
    const manifest = PluginManifest.parse(`name = "audio"\nlanguage = "zig"\n`);
    expect(manifest.name.slug).toBe("audio");
    expect(manifest.language.id).toBe("zig");
  });

  test("defaults to a zig plugin called plugin", () => {
    const manifest = PluginManifest.parse("");
    expect(manifest.name.slug).toBe("plugin");
    expect(manifest.language.id).toBe("zig");
  });

  test("a manifest still saying language = rust falls back rather than failing", () => {
    // Manifests from before the SDK became Zig-only are in the wild. The
    // toolchain reads them, and the build then fails on `zig build` finding no
    // build.zig — which is a better message than refusing to parse the file.
    const manifest = PluginManifest.parse(`name = "old"
language = "zig"
`);
    expect(manifest.language.id).toBe("zig");
  });

  test("trailing comments are not part of the value", () => {
    expect(PluginManifest.parse(`name = "audio"  # the good one`).name.slug).toBe("audio");
  });

  test("keys it does not model are ignored, not rejected", () => {
    const manifest = PluginManifest.parse(`name = "x"\nversion = "9"\nfuture_key = true\n`);
    expect(manifest.name.slug).toBe("x");
  });
});

describe("capability grants (carbon.toml [plugins])", () => {
  test("reads a grant and nothing else", () => {
    const toml = `
[app]
name = "demo"

[plugins.audio]
capabilities = ["audio.output"]

[window]
title = "Demo"
`;
    const granted = grantedCapabilities(toml);
    expect(granted("audio")).toEqual(["audio.output"]);
  });

  test("an undeclared plugin grants nothing, not undefined", () => {
    expect(grantedCapabilities(`[app]\nname = "demo"\n`)("anything")).toEqual([]);
  });

  test("multiple plugins each keep their own grants", () => {
    const toml = `
[plugins.a]
capabilities = ["x"]

[plugins.b]
capabilities = ["y", "z"]
`;
    const granted = grantedCapabilities(toml);
    expect(granted("a")).toEqual(["x"]);
    expect(granted("b")).toEqual(["y", "z"]);
  });
});

describe("the app manifest (carbon/manifest.toml)", () => {
  test("reads declared plugins", () => {
    const toml = `schema = 1\n\n[plugins.audio]\nsource = "local"\nenabled = true\n`;
    const manifest = readAppManifest(toml);
    expect(manifest.plugins.get("audio")).toEqual({ source: "local", enabled: true, version: undefined });
  });

  test("a missing document has no plugins", () => {
    expect(readAppManifest("").plugins.size).toBe(0);
  });

  test("upserting adds an entry without disturbing another", () => {
    const before = upsertManifestEntry("schema = 1\n", "audio", { source: "local", enabled: true });
    const after = upsertManifestEntry(before, "video", { source: "vendor", enabled: true, version: "1.0" });

    const manifest = readAppManifest(after);
    expect(manifest.plugins.get("audio")).toEqual({ source: "local", enabled: true, version: undefined });
    expect(manifest.plugins.get("video")).toEqual({ source: "vendor", enabled: true, version: "1.0" });
  });

  test("upserting the same name replaces it, not duplicates it", () => {
    const before = upsertManifestEntry("schema = 1\n", "audio", { source: "local", enabled: true });
    const after = upsertManifestEntry(before, "audio", { source: "local", enabled: false });

    const manifest = readAppManifest(after);
    expect(manifest.plugins.size).toBe(1);
    expect(manifest.plugins.get("audio")?.enabled).toBe(false);
  });

  test("setManifestEnabled flips an existing entry", () => {
    const before = upsertManifestEntry("schema = 1\n", "audio", { source: "local", enabled: true });
    const after = setManifestEnabled(before, "audio", false);
    expect(readAppManifest(after).plugins.get("audio")?.enabled).toBe(false);
  });

  test("setManifestEnabled on an undeclared name is a no-op", () => {
    const before = "schema = 1\n";
    expect(setManifestEnabled(before, "nope", false)).toBe(before);
  });
});

// ── Use cases ───────────────────────────────────────────────────────────────

describe("creating a plugin", () => {
  function create(workspace = new MemoryWorkspace()) {
    return {
      workspace,
      useCase: new CreatePluginUseCase(workspace, new FakeTemplateSource()),
    };
  }

  test("zig is the language, and the directory is slugified", () => {
    const { workspace, useCase } = create();
    const result = useCase.execute({ name: "My Thing", cwd: ROOT, sdkRoot: `${ROOT}/sdk` });

    expect(result.language).toBe("zig");
    expect(result.name.slug).toBe("my-thing");
    expect(workspace.exists(`${ROOT}/my-thing/build.zig`)).toBe(true);
    expect(workspace.exists(`${ROOT}/my-thing/src/main.zig`)).toBe(true);
    expect(workspace.exists(`${ROOT}/my-thing/carbon-plugin.toml`)).toBe(true);
  });

  test("asking for zig explicitly is the same thing", () => {
    const { workspace, useCase } = create();
    useCase.execute({ name: "zthing", language: "zig", cwd: ROOT, sdkRoot: `${ROOT}/sdk` });

    expect(workspace.exists(`${ROOT}/zthing/build.zig`)).toBe(true);
    expect(workspace.exists(`${ROOT}/zthing/src/main.zig`)).toBe(true);
  });

  test("asking for rust is refused rather than silently scaffolding zig", () => {
    // The flag is gone from the CLI, but a script or a habit may still pass
    // it. Refusing names the situation; quietly producing a Zig plugin would
    // leave someone reading Rust docs at a build.zig.
    const { useCase } = create();
    expect(() =>
      useCase.execute({ name: "x", language: "rust", cwd: ROOT, sdkRoot: `${ROOT}/sdk` }),
    ).toThrow(UnknownLanguageError);
  });

  test("an unknown language is refused, naming the ones that exist", () => {
    const { useCase } = create();
    expect(() =>
      useCase.execute({ name: "x", language: "haskell", cwd: ROOT, sdkRoot: `${ROOT}/sdk` }),
    ).toThrow(UnknownLanguageError);
  });

  test("the SDK path is relative and forward-slashed", () => {
    const { workspace, useCase } = create();
    useCase.execute({ name: "pathy", cwd: `${ROOT}/plugins`, sdkRoot: `${ROOT}/sdk` });

    // Zig does not accept a backslash in a dependency path.
    const build = workspace.readFile(`${ROOT}/plugins/pathy/build.zig`);
    expect(build).not.toContain("\\");
    expect(build).toContain("../../sdk/composition");
  });

  test("the crate name reaches the source file, the slug reaches the manifest", () => {
    const { workspace, useCase } = create();
    useCase.execute({ name: "my-thing", cwd: ROOT, sdkRoot: `${ROOT}/sdk` });

    expect(workspace.readFile(`${ROOT}/my-thing/src/main.zig`)).toContain("my_thing");
    expect(workspace.readFile(`${ROOT}/my-thing/carbon-plugin.toml`)).toContain(`"my-thing"`);
  });

  test("a non-empty target is refused", () => {
    const workspace = new MemoryWorkspace();
    workspace.put(`${ROOT}/taken/something.txt`, "x");
    const { useCase } = create(workspace);

    expect(() => useCase.execute({ name: "taken", cwd: ROOT, sdkRoot: `${ROOT}/sdk` })).toThrow(
      TargetNotEmptyError,
    );
  });

  test("with a host app, scaffolds carbon/build.zig + build.zig.zon + manifest.toml on first use", () => {
    const workspace = new MemoryWorkspace();
    workspace.put(`${ROOT}/app/carbon.toml`, `[app]\nname = "demo"\n`);
    const useCase = new CreatePluginUseCase(workspace, new FakeTemplateSource());

    useCase.execute({
      name: "my-thing",
      cwd: `${ROOT}/app/carbon/plugins/local`,
      sdkRoot: `${ROOT}/sdk`,
      host: `${ROOT}/app`,
    });

    expect(workspace.exists(`${ROOT}/app/carbon/build.zig`)).toBe(true);
    expect(workspace.exists(`${ROOT}/app/carbon/build.zig.zon`)).toBe(true);
    expect(workspace.exists(`${ROOT}/app/carbon/manifest.toml`)).toBe(true);
  });

  test("with a host app, declares the plugin in manifest.toml as local", () => {
    const workspace = new MemoryWorkspace();
    workspace.put(`${ROOT}/app/carbon.toml`, `[app]\nname = "demo"\n`);
    const useCase = new CreatePluginUseCase(workspace, new FakeTemplateSource());

    useCase.execute({
      name: "my-thing",
      cwd: `${ROOT}/app/carbon/plugins/local`,
      sdkRoot: `${ROOT}/sdk`,
      host: `${ROOT}/app`,
    });

    const manifest = readAppManifest(workspace.readFile(`${ROOT}/app/carbon/manifest.toml`));
    expect(manifest.plugins.get("my-thing")).toEqual({ source: "local", enabled: true, version: undefined });
  });

  test("an existing carbon/build.zig is left untouched — no re-scaffold", () => {
    const workspace = new MemoryWorkspace();
    workspace.put(`${ROOT}/app/carbon.toml`, `[app]\nname = "demo"\n`);
    workspace.put(`${ROOT}/app/carbon/build.zig`, "// hand-edited");
    const useCase = new CreatePluginUseCase(workspace, new FakeTemplateSource());

    useCase.execute({
      name: "my-thing",
      cwd: `${ROOT}/app/carbon/plugins/local`,
      sdkRoot: `${ROOT}/sdk`,
      host: `${ROOT}/app`,
    });

    expect(workspace.readFile(`${ROOT}/app/carbon/build.zig`)).toBe("// hand-edited");
  });

  test("with no host app, scaffolds only the plugin — no carbon/ machinery", () => {
    const { workspace, useCase } = create();
    useCase.execute({ name: "my-thing", cwd: ROOT, sdkRoot: `${ROOT}/sdk` });
    expect(workspace.exists(`${ROOT}/carbon/build.zig`)).toBe(false);
  });
});

describe("building a plugin", () => {
  test("a build.zig means zig, and --release becomes its optimise flag", async () => {
    const workspace = new MemoryWorkspace();
    workspace.put(`${ROOT}/p/build.zig`);
    const runner = new FakeProcessRunner();

    const result = await new BuildPluginUseCase(workspace, runner, resolveBareCommand).execute({
      directory: `${ROOT}/p`,
      release: true,
    });

    expect(result.exitCode).toBe(0);
    expect(runner.calls[0].command).toBe("zig");
    expect(runner.calls[0].args).toEqual(["build", "-Drelease=true"]);
    expect(runner.calls[0].options?.cwd).toBe(`${ROOT}/p`);
  });

  test("a debug build omits the optimise flag", async () => {
    const workspace = new MemoryWorkspace();
    workspace.put(`${ROOT}/p/build.zig`);
    const runner = new FakeProcessRunner();

    await new BuildPluginUseCase(workspace, runner, resolveBareCommand).execute({ directory: `${ROOT}/p` });
    expect(runner.calls[0].args).toEqual(["build"]);
  });

  test("a Cargo.toml is not a carbon plugin any more", async () => {
    // The directory that used to build is now refused, and the message says
    // what a plugin is rather than reporting a missing file.
    const workspace = new MemoryWorkspace();
    workspace.put(`${ROOT}/old/Cargo.toml`);

    await expect(
      new BuildPluginUseCase(workspace, new FakeProcessRunner(), resolveBareCommand).execute({
        directory: `${ROOT}/old`,
      }),
    ).rejects.toThrow(NotAPluginDirectoryError);
  });

  test("a non-zero exit is reported, not swallowed", async () => {
    const workspace = new MemoryWorkspace();
    workspace.put(`${ROOT}/p/build.zig`);

    const result = await new BuildPluginUseCase(workspace, new FakeProcessRunner(101), resolveBareCommand).execute({
      directory: `${ROOT}/p`,
    });
    expect(result.exitCode).toBe(101);
  });

  test("a directory with no marker is refused", async () => {
    const workspace = new MemoryWorkspace();
    workspace.put(`${ROOT}/empty/README.md`);

    await expect(
      new BuildPluginUseCase(workspace, new FakeProcessRunner(), resolveBareCommand).execute({
        directory: `${ROOT}/empty`,
      }),
    ).rejects.toThrow(NotAPluginDirectoryError);
  });
});

describe("installing a plugin", () => {
  /** A host app with a built plugin beneath it. */
  function built(options: { manifest?: boolean; where?: "lib" | "bin" } = {}) {
    const workspace = new MemoryWorkspace();
    workspace.put(`${ROOT}/app/carbon.toml`, `[app]\nname = "demo"\n`);
    workspace.put(`${ROOT}/app/my-thing/build.zig`);
    if (options.manifest !== false) {
      workspace.put(`${ROOT}/app/my-thing/carbon-plugin.toml`, `name = "my-thing"\nlanguage = "zig"\n`);
    }
    const where = options.where ?? "lib";
    const lib = PluginName.from("my-thing").libraryFilename();
    workspace.put(`${ROOT}/app/my-thing/zig-out/${where}/${lib}`, "ELF");
    return { workspace, useCase: new InstallPluginUseCase(workspace, new FakeTemplateSource()), lib };
  }

  test("copies the library in and declares it in carbon/manifest.toml", () => {
    const { workspace, useCase, lib } = built();

    const result = useCase.execute({
      directory: `${ROOT}/app/my-thing`,
      from: `${ROOT}/app/my-thing`,
    });

    expect(result.host).toBe(`${ROOT}/app`);
    expect(workspace.exists(`${ROOT}/app/carbon/plugins/vendor/my-thing/${lib}`)).toBe(true);

    const manifest = readAppManifest(workspace.readFile(`${ROOT}/app/carbon/manifest.toml`));
    expect(manifest.plugins.get("my-thing")).toEqual({ source: "vendor", enabled: true, version: undefined });

    // Scaffolds carbon/build.zig too — an app whose ONLY plugin interaction
    // is `carbon plugin add`/`install` (never `carbon plugin new`) still
    // needs the orchestrator, or SyncPluginsUseCase would silently never
    // stage anything.
    expect(workspace.exists(`${ROOT}/app/carbon/build.zig`)).toBe(true);

    // carbon.toml (capability grants) is never touched by install.
    const toml = workspace.readFile(`${ROOT}/app/carbon.toml`);
    expect(toml).toBe(`[app]\nname = "demo"\n`);
  });

  test("copies the manifest and signature alongside the binary", () => {
    const { workspace, useCase, lib } = built();
    workspace.put(`${ROOT}/app/my-thing/zig-out/lib/${lib}.sig`, "SIG");

    useCase.execute({ directory: `${ROOT}/app/my-thing`, from: `${ROOT}/app/my-thing` });

    expect(workspace.exists(`${ROOT}/app/carbon/plugins/vendor/my-thing/carbon-plugin.toml`)).toBe(true);
    expect(workspace.readFile(`${ROOT}/app/carbon/plugins/vendor/my-thing/${lib}.sig`)).toBe("SIG");
  });

  test("zig-out/lib is preferred over zig-out/bin when both exist", () => {
    // `zig build` puts a shared library in lib/ on every platform except
    // Windows, where it lands in bin/ beside the import library. Both are
    // searched, and lib/ wins so a stale bin/ copy cannot shadow a fresh one.
    const { workspace, useCase, lib } = built();
    workspace.put(`${ROOT}/app/my-thing/zig-out/bin/${lib}`, "OLD");

    useCase.execute({ directory: `${ROOT}/app/my-thing`, from: `${ROOT}/app/my-thing` });
    expect(workspace.readFile(`${ROOT}/app/carbon/plugins/vendor/my-thing/${lib}`)).toBe("ELF");
  });

  test("a windows build, which lands in zig-out/bin, still installs", () => {
    const { workspace, useCase, lib } = built({ where: "bin" });
    useCase.execute({ directory: `${ROOT}/app/my-thing`, from: `${ROOT}/app/my-thing` });
    expect(workspace.exists(`${ROOT}/app/carbon/plugins/vendor/my-thing/${lib}`)).toBe(true);
  });

  test("without a manifest, the name falls back to the directory", () => {
    const { useCase } = built({ manifest: false });
    const result = useCase.execute({
      directory: `${ROOT}/app/my-thing`,
      from: `${ROOT}/app/my-thing`,
    });
    expect(result.name.slug).toBe("my-thing");
  });

  test("an unbuilt plugin says what it looked for", () => {
    const workspace = new MemoryWorkspace();
    workspace.put(`${ROOT}/app/carbon.toml`, "");
    workspace.put(`${ROOT}/app/p/build.zig`);

    expect(() =>
      new InstallPluginUseCase(workspace, new FakeTemplateSource()).execute({
        directory: `${ROOT}/app/p`,
        from: `${ROOT}/app/p`,
      }),
    ).toThrow(ArtifactNotFoundError);
  });

  test("no host app anywhere above is refused", () => {
    const workspace = new MemoryWorkspace();
    workspace.put(`${ROOT}/loose/build.zig`);
    const lib = PluginName.from("loose").libraryFilename();
    workspace.put(`${ROOT}/loose/zig-out/lib/${lib}`, "ELF");

    expect(() =>
      new InstallPluginUseCase(workspace, new FakeTemplateSource()).execute({
        directory: `${ROOT}/loose`,
        from: `${ROOT}/loose`,
      }),
    ).toThrow(NoHostAppError);
  });
});

describe("syncing plugins", () => {
  const STANDARD_ROOT = `${ROOT}/standard`;

  /** A host app with carbon/manifest.toml + carbon/build.zig already scaffolded. */
  function withApp(manifestBody = "") {
    const workspace = new MemoryWorkspace();
    workspace.put(`${ROOT}/app/carbon.toml`, `[app]\nname = "demo"\n`);
    workspace.put(`${ROOT}/app/carbon/manifest.toml`, `schema = 1\n\n${manifestBody}`);
    workspace.put(`${ROOT}/app/carbon/build.zig`, "// orchestrator");

    const runner = new FakeProcessRunner();
    const build = new BuildPluginUseCase(workspace, runner, resolveBareCommand);
    const install = new InstallPluginUseCase(workspace, new FakeTemplateSource());
    const fakeSign = async () => {};
    const addStandard = new AddStandardPluginUseCase(workspace, build, install, STANDARD_ROOT, fakeSign);
    const resolveZig = async () => "zig";
    const useCase = new SyncPluginsUseCase(workspace, runner, addStandard, resolveZig);

    return { workspace, runner, useCase };
  }

  /** Seeds STANDARD_ROOT/<name>/ with a buildable source + fake build output,
   *  the same fixture shape `withLocalSource` used before this rewrite. */
  function seedStandardPlugin(workspace: MemoryWorkspace, name: string) {
    workspace.put(`${STANDARD_ROOT}/${name}/build.zig`);
    workspace.put(`${STANDARD_ROOT}/${name}/carbon-plugin.toml`, `name = "${name}"\nlanguage = "zig"\n`);
    const lib = PluginName.from(name).libraryFilename();
    workspace.put(`${STANDARD_ROOT}/${name}/zig-out/lib/${lib}`, "ELF");
  }

  test("no carbon/manifest.toml at all is not an error", async () => {
    const workspace = new MemoryWorkspace();
    workspace.put(`${ROOT}/app/carbon.toml`, "");
    const runner = new FakeProcessRunner();
    const build = new BuildPluginUseCase(workspace, runner, resolveBareCommand);
    const install = new InstallPluginUseCase(workspace, new FakeTemplateSource());
    const addStandard = new AddStandardPluginUseCase(workspace, build, install, STANDARD_ROOT);
    const useCase = new SyncPluginsUseCase(workspace, runner, addStandard, async () => "zig");

    const result = await useCase.execute(`${ROOT}/app`);
    expect(result.staged).toEqual([]);
    expect(runner.calls).toEqual([]);
  });

  test("shells `zig build --prefix .` inside carbon/", async () => {
    const { runner, useCase } = withApp();
    await useCase.execute(`${ROOT}/app`);

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0].command).toBe("zig");
    expect(runner.calls[0].args).toEqual(["build", "--prefix", "."]);
    expect(forwardSlashes(runner.calls[0].options?.cwd ?? "")).toBe(`${ROOT}/app/carbon`);
  });

  test("release: true forwards -Drelease=true — carbon run's mode", async () => {
    const { runner, useCase } = withApp();
    await useCase.execute(`${ROOT}/app`, { release: true });
    expect(runner.calls[0].args).toEqual(["build", "--prefix", ".", "-Drelease=true"]);
  });

  test("no carbon/build.zig means nothing to shell, even with a manifest present", async () => {
    const workspace = new MemoryWorkspace();
    workspace.put(`${ROOT}/app/carbon.toml`, "");
    workspace.put(`${ROOT}/app/carbon/manifest.toml`, "schema = 1\n");
    const runner = new FakeProcessRunner();
    const build = new BuildPluginUseCase(workspace, runner, resolveBareCommand);
    const install = new InstallPluginUseCase(workspace, new FakeTemplateSource());
    const addStandard = new AddStandardPluginUseCase(workspace, build, install, STANDARD_ROOT);
    const useCase = new SyncPluginsUseCase(workspace, runner, addStandard, async () => "zig");

    const result = await useCase.execute(`${ROOT}/app`);
    expect(result.staged).toEqual([]);
    expect(runner.calls).toEqual([]);
  });

  test("reports what landed in carbon/native/<os>/<arch>/ after the build", async () => {
    const { workspace, useCase } = withApp();
    // Standing in for what a real `zig build` would have staged — the fake
    // runner doesn't touch the filesystem, so this simulates its effect.
    const nativeDir = `${ROOT}/app/carbon/native/${hostOsName()}/${hostArchName()}`;
    workspace.put(`${nativeDir}/carbon-pulse.${hostExt()}`, "ELF");

    const result = await useCase.execute(`${ROOT}/app`);
    expect(result.staged).toEqual([`carbon-pulse.${hostExt()}`]);
  });

  test("auto-heals a missing vendor plugin before shelling zig build", async () => {
    const { workspace, runner, useCase } = withApp(
      `[plugins.fonts]\nsource = "vendor"\nenabled = true\n`,
    );
    seedStandardPlugin(workspace, "fonts");

    await useCase.execute(`${ROOT}/app`);

    const lib = PluginName.from("fonts").libraryFilename();
    expect(workspace.exists(`${ROOT}/app/carbon/plugins/vendor/fonts/${lib}`)).toBe(true);
    // Auto-heal's build call happened before the final orchestrating build.
    const cwds = runner.calls.map((c) => forwardSlashes(c.options?.cwd ?? ""));
    expect(cwds).toEqual([`${STANDARD_ROOT}/fonts`, `${ROOT}/app/carbon`]);
  });

  test("an already-present vendor artifact is not re-fetched", async () => {
    const { workspace, runner, useCase } = withApp(
      `[plugins.fonts]\nsource = "vendor"\nenabled = true\n`,
    );
    const lib = PluginName.from("fonts").libraryFilename();
    workspace.put(`${ROOT}/app/carbon/plugins/vendor/fonts/${lib}`, "ALREADY THERE");

    await useCase.execute(`${ROOT}/app`);

    // Only the final orchestrating build ran — no auto-heal build call.
    expect(runner.calls).toHaveLength(1);
    expect(forwardSlashes(runner.calls[0].options?.cwd ?? "")).toBe(`${ROOT}/app/carbon`);
  });

  test("a disabled vendor entry is never auto-healed", async () => {
    const { runner, useCase } = withApp(
      `[plugins.fonts]\nsource = "vendor"\nenabled = false\n`,
    );
    await useCase.execute(`${ROOT}/app`);
    expect(runner.calls).toHaveLength(1); // only the orchestrating build
  });

  test("a local entry is never auto-healed — it's built by the orchestrator, not fetched", async () => {
    const { runner, useCase } = withApp(`[plugins.my-thing]\nsource = "local"\nenabled = true\n`);
    await useCase.execute(`${ROOT}/app`);
    expect(runner.calls).toHaveLength(1);
    expect(forwardSlashes(runner.calls[0].options?.cwd ?? "")).toBe(`${ROOT}/app/carbon`);
  });

  test("an unknown vendor plugin's auto-heal failure is reported, not swallowed", async () => {
    const { useCase } = withApp(`[plugins.nope]\nsource = "vendor"\nenabled = true\n`);
    // STANDARD_ROOT/nope/ was never seeded — nothing to build.
    await expect(useCase.execute(`${ROOT}/app`)).rejects.toThrow(UnknownStandardPluginError);
  });

  test("carbon/build.zig failing to build is reported, not swallowed", async () => {
    const workspace = new MemoryWorkspace();
    workspace.put(`${ROOT}/app/carbon.toml`, "");
    workspace.put(`${ROOT}/app/carbon/manifest.toml`, "schema = 1\n");
    workspace.put(`${ROOT}/app/carbon/build.zig`, "// orchestrator");
    const runner = new FakeProcessRunner(1);
    const build = new BuildPluginUseCase(workspace, runner, resolveBareCommand);
    const install = new InstallPluginUseCase(workspace, new FakeTemplateSource());
    const addStandard = new AddStandardPluginUseCase(workspace, build, install, STANDARD_ROOT);
    const useCase = new SyncPluginsUseCase(workspace, runner, addStandard, async () => "zig");

    await expect(useCase.execute(`${ROOT}/app`)).rejects.toThrow(/carbon\/build\.zig/);
  });
});

describe("listing and describing", () => {
  function app() {
    const workspace = new MemoryWorkspace();
    workspace.put(`${ROOT}/app/carbon.toml`, `[app]\nname = "demo"\n\n[plugins.audio]\ncapabilities = ["audio.output"]\n`);
    workspace.put(
      `${ROOT}/app/carbon/manifest.toml`,
      `schema = 1\n\n[plugins.audio]\nsource = "vendor"\nenabled = true\n\n[plugins.gone]\nsource = "vendor"\nenabled = true\n`,
    );
    const nativeDir = `${ROOT}/app/carbon/native/${hostOsName()}/${hostArchName()}`;
    workspace.put(`${nativeDir}/audio.${hostExt()}`, "ELF");
    // "gone" is declared but never staged.
    return { workspace, useCase: new InspectPluginsUseCase(workspace) };
  }

  test("lists what manifest.toml declares, flagging what is missing", () => {
    const { useCase } = app();
    const { host, plugins } = useCase.list(`${ROOT}/app/deep/nested`);

    expect(host).toBe(`${ROOT}/app`);
    expect(plugins.map((p) => [p.name, p.present])).toEqual([
      ["audio", true],
      ["gone", false],
    ]);
  });

  test("surfaces source, enabled and granted capabilities", () => {
    const { useCase } = app();
    const { plugins } = useCase.list(`${ROOT}/app`);
    const audio = plugins.find((p) => p.name === "audio")!;
    expect(audio.source).toBe("vendor");
    expect(audio.enabled).toBe(true);
    expect(audio.capabilities).toEqual(["audio.output"]);
  });

  test("an app with no plugins lists nothing rather than failing", () => {
    const workspace = new MemoryWorkspace();
    workspace.put(`${ROOT}/bare/carbon.toml`, `[app]\nname = "bare"\n`);
    expect(new InspectPluginsUseCase(workspace).list(`${ROOT}/bare`).plugins).toEqual([]);
  });

  test("listing outside any app is refused", () => {
    expect(() => new InspectPluginsUseCase(new MemoryWorkspace()).list("/nowhere")).toThrow(
      NoHostAppError,
    );
  });

  test("describe prefers the manifest-declared copy", () => {
    const { workspace, useCase } = app();
    workspace.put(`${ROOT}/app/carbon/plugins/vendor/audio/carbon-plugin.toml`, `name = "audio"\n`);

    const details = useCase.describe("audio", `${ROOT}/app`);
    expect(details.origin).toBe("installed");
    expect(details.manifest).toContain(`name = "audio"`);
  });

  test("describe falls back to a source directory in the cwd", () => {
    const workspace = new MemoryWorkspace();
    workspace.put(`${ROOT}/app/carbon.toml`, `[app]\nname = "demo"\n`);
    workspace.put(`${ROOT}/app/src-plugin/carbon-plugin.toml`, `name = "src-plugin"\n`);

    const details = new InspectPluginsUseCase(workspace).describe("src-plugin", `${ROOT}/app`);
    expect(details.origin).toBe("source");
  });

  test("an unknown name is refused", () => {
    const { useCase } = app();
    expect(() => useCase.describe("nope", `${ROOT}/app`)).toThrow(PluginNotFoundError);
  });
});

// ── The real adapter ────────────────────────────────────────────────────────

describe("NodePluginWorkspace", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "carbon-plugins-"));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("finds the host app from several directories down", () => {
    const app = join(root, "app");
    const deep = join(app, "a", "b", "c");
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(app, "carbon.toml"), `[app]\nname = "demo"\n`);

    expect(new NodePluginWorkspace().findHostApp(deep)).toBe(app);
  });

  test("returns null rather than looping at the filesystem root", () => {
    // dirname() is a fixed point at the root; getting this wrong hangs.
    const orphan = join(root, "orphan");
    mkdirSync(orphan, { recursive: true });
    expect(new NodePluginWorkspace().findHostApp(orphan)).toBeNull();
  });

  test("writeFile creates missing parent directories", () => {
    const target = join(root, "made", "up", "path", "file.txt");
    new NodePluginWorkspace().writeFile(target, "hello");

    const workspace = new NodePluginWorkspace();
    expect(workspace.exists(dirname(target))).toBe(true);
    expect(workspace.readFile(target)).toBe("hello");
  });
});

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
  ArtifactNotFoundError,
  BuildPluginUseCase,
  CreatePluginUseCase,
  InspectPluginsUseCase,
  InstallPluginUseCase,
  NodePluginWorkspace,
  NoHostAppError,
  NotAPluginDirectoryError,
  PluginManifest,
  PluginName,
  PluginNotFoundError,
  readPluginEntries,
  TargetNotEmptyError,
  UnknownLanguageError,
  upsertPluginEntry,
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

describe("the [plugins] table", () => {
  test("reads the entries and nothing else", () => {
    const toml = `
[app]
name = "demo"

[plugins]
audio = "./plugins/libaudio.so"
canvas = "./plugins/libcanvas.so"

[window]
title = "Demo"
`;
    expect(readPluginEntries(toml)).toEqual([
      { name: "audio", path: "./plugins/libaudio.so" },
      { name: "canvas", path: "./plugins/libcanvas.so" },
    ]);
  });

  test("a document with no section has no entries", () => {
    expect(readPluginEntries(`[app]\nname = "demo"\n`)).toEqual([]);
  });

  test("adding to an existing section leaves every other line byte-identical", () => {
    const before = `[app]
name = "demo"   # keep this comment

[plugins]
audio = "./plugins/libaudio.so"

[window]
title = "Demo"
`;
    const after = upsertPluginEntry(before, { name: "canvas", path: "./plugins/libcanvas.so" });

    expect(after).toContain("# keep this comment");
    expect(after).toContain(`audio = "./plugins/libaudio.so"`);
    expect(after).toContain(`canvas = "./plugins/libcanvas.so"`);
    // The new entry belongs to [plugins], not to [window].
    expect(after.indexOf("canvas =")).toBeLessThan(after.indexOf("[window]"));
    expect(after).toContain(`title = "Demo"`);
  });

  test("reinstalling replaces the entry instead of duplicating the key", () => {
    const before = `[plugins]\naudio = "./plugins/old.so"\n`;
    const after = upsertPluginEntry(before, { name: "audio", path: "./plugins/new.so" });

    // A duplicate key is a TOML parse error, i.e. a project that will not load.
    expect(after.match(/audio =/g)).toHaveLength(1);
    expect(after).toContain("./plugins/new.so");
    expect(after).not.toContain("old.so");
  });

  test("a document with no section gets one appended", () => {
    const after = upsertPluginEntry(`[app]\nname = "demo"\n`, {
      name: "audio",
      path: "./plugins/libaudio.so",
    });
    expect(after).toContain("[plugins]");
    expect(readPluginEntries(after)).toEqual([{ name: "audio", path: "./plugins/libaudio.so" }]);
  });

  test("an empty document is handled without a leading blank line problem", () => {
    const after = upsertPluginEntry("", { name: "audio", path: "./a.so" });
    expect(readPluginEntries(after)).toEqual([{ name: "audio", path: "./a.so" }]);
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
});

describe("building a plugin", () => {
  test("a build.zig means zig, and --release becomes its optimise flag", async () => {
    const workspace = new MemoryWorkspace();
    workspace.put(`${ROOT}/p/build.zig`);
    const runner = new FakeProcessRunner();

    const result = await new BuildPluginUseCase(workspace, runner).execute({
      directory: `${ROOT}/p`,
      release: true,
    });

    expect(result.exitCode).toBe(0);
    expect(runner.calls[0].command).toBe("zig");
    expect(runner.calls[0].args).toEqual(["build", "-Doptimize=ReleaseFast"]);
    expect(runner.calls[0].options?.cwd).toBe(`${ROOT}/p`);
  });

  test("a debug build omits the optimise flag", async () => {
    const workspace = new MemoryWorkspace();
    workspace.put(`${ROOT}/p/build.zig`);
    const runner = new FakeProcessRunner();

    await new BuildPluginUseCase(workspace, runner).execute({ directory: `${ROOT}/p` });
    expect(runner.calls[0].args).toEqual(["build"]);
  });

  test("a Cargo.toml is not a carbon plugin any more", async () => {
    // The directory that used to build is now refused, and the message says
    // what a plugin is rather than reporting a missing file.
    const workspace = new MemoryWorkspace();
    workspace.put(`${ROOT}/old/Cargo.toml`);

    await expect(
      new BuildPluginUseCase(workspace, new FakeProcessRunner()).execute({
        directory: `${ROOT}/old`,
      }),
    ).rejects.toThrow(NotAPluginDirectoryError);
  });

  test("a non-zero exit is reported, not swallowed", async () => {
    const workspace = new MemoryWorkspace();
    workspace.put(`${ROOT}/p/build.zig`);

    const result = await new BuildPluginUseCase(workspace, new FakeProcessRunner(101)).execute({
      directory: `${ROOT}/p`,
    });
    expect(result.exitCode).toBe(101);
  });

  test("a directory with no marker is refused", async () => {
    const workspace = new MemoryWorkspace();
    workspace.put(`${ROOT}/empty/README.md`);

    await expect(
      new BuildPluginUseCase(workspace, new FakeProcessRunner()).execute({
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
    return { workspace, useCase: new InstallPluginUseCase(workspace), lib };
  }

  test("copies the library in and declares it in carbon.toml", () => {
    const { workspace, useCase, lib } = built();

    const result = useCase.execute({
      directory: `${ROOT}/app/my-thing`,
      from: `${ROOT}/app/my-thing`,
    });

    expect(result.host).toBe(`${ROOT}/app`);
    expect(workspace.exists(`${ROOT}/app/plugins/${lib}`)).toBe(true);
    expect(result.declaredPath).toBe(`./plugins/${lib}`);

    const toml = workspace.readFile(`${ROOT}/app/carbon.toml`);
    expect(readPluginEntries(toml)).toEqual([{ name: "my-thing", path: `./plugins/${lib}` }]);
    // The app section survives the edit.
    expect(toml).toContain(`name = "demo"`);
  });

  test("the declared path is relative, so the project stays portable", () => {
    const { useCase } = built();
    const result = useCase.execute({
      directory: `${ROOT}/app/my-thing`,
      from: `${ROOT}/app/my-thing`,
    });

    expect(result.declaredPath.startsWith("./")).toBe(true);
    expect(result.declaredPath).not.toContain(ROOT);
  });

  test("zig-out/lib is preferred over zig-out/bin when both exist", () => {
    // `zig build` puts a shared library in lib/ on every platform except
    // Windows, where it lands in bin/ beside the import library. Both are
    // searched, and lib/ wins so a stale bin/ copy cannot shadow a fresh one.
    const { workspace, useCase, lib } = built();
    workspace.put(`${ROOT}/app/my-thing/zig-out/bin/${lib}`, "OLD");

    useCase.execute({ directory: `${ROOT}/app/my-thing`, from: `${ROOT}/app/my-thing` });
    expect(workspace.readFile(`${ROOT}/app/plugins/${lib}`)).toBe("ELF");
  });

  test("a windows build, which lands in zig-out/bin, still installs", () => {
    const { workspace, useCase, lib } = built({ where: "bin" });
    useCase.execute({ directory: `${ROOT}/app/my-thing`, from: `${ROOT}/app/my-thing` });
    expect(workspace.exists(`${ROOT}/app/plugins/${lib}`)).toBe(true);
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
      new InstallPluginUseCase(workspace).execute({
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
      new InstallPluginUseCase(workspace).execute({
        directory: `${ROOT}/loose`,
        from: `${ROOT}/loose`,
      }),
    ).toThrow(NoHostAppError);
  });
});

describe("listing and describing", () => {
  function app() {
    const workspace = new MemoryWorkspace();
    workspace.put(
      `${ROOT}/app/carbon.toml`,
      `[app]\nname = "demo"\n\n[plugins]\naudio = "./plugins/libaudio.so"\ngone = "./plugins/libgone.so"\n`,
    );
    workspace.put(`${ROOT}/app/plugins/libaudio.so`, "ELF");
    return { workspace, useCase: new InspectPluginsUseCase(workspace) };
  }

  test("lists what carbon.toml declares, flagging what is missing", () => {
    const { useCase } = app();
    const { host, plugins } = useCase.list(`${ROOT}/app/deep/nested`);

    expect(host).toBe(`${ROOT}/app`);
    expect(plugins.map((p) => [p.name, p.present])).toEqual([
      ["audio", true],
      ["gone", false],
    ]);
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

  test("describe prefers the installed copy", () => {
    const { workspace, useCase } = app();
    workspace.put(`${ROOT}/app/plugins/carbon-plugin.toml`, `name = "audio"\n`);

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

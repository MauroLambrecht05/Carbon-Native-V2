// Generate and check, across the layers, against an in-memory store.
//
// The renderings are asserted on for the properties that matter — the symbol a
// plugin exports, the capability the loader gates on, the id the toolchain
// matches — rather than snapshotted whole. A snapshot of a generated file
// tests the generator against itself: it fails on every wording change and
// passes on a wrong symbol as long as the wrong symbol is stable.

import { describe, expect, test } from "bun:test";

import {
  CheckArtifactsUseCase,
  GenerateArtifactsUseCase,
  RenderRegistryUseCase,
  type ArtifactStore,
} from "../index.ts";

const REGISTRY = `
pub const POINTS = [_]ExtensionPoint{
    .{
        .id = "lifecycle.register",
        .symbol = "carbon_plugin_register",
        .since_minor = 0,
        .stability = .stable,
        .arity = .many,
        .capability = null,
        .params = &.{},
        .returns = .void,
        .dispatch = "Once, at startup.",
        .doc = "Install JS globals.",
    },
    .{
        .id = "paint.before",
        .symbol = "carbon_plugin_before_paint",
        .since_minor = 0,
        .stability = .stable,
        .arity = .many,
        .capability = "paint.pixmap",
        .params = &.{
            .{ .name = "pixmap", .type = .bytes_mut, .doc = "RGBA8 pixels." },
            .{ .name = "width", .type = .u32, .doc = "Pixels." },
        },
        .returns = .void,
        .dispatch = "Every frame.",
        .doc = "Draw into the framebuffer.",
    },
    .{
        .id = "host.resolve_asset",
        .symbol = "carbon_ext_host_resolve_asset",
        .since_minor = 1,
        .stability = .experimental,
        .arity = .exclusive,
        .capability = "fs.read",
        .params = &.{
            .{ .name = "request", .type = .str, .doc = "The specifier." },
        },
        .returns = .i32,
        .dispatch = "On an unresolved asset.",
        .doc = "Answer where an asset lives.",
    },
};
`;

class MemoryStore implements ArtifactStore {
  readonly written = new Map<string, string>();

  constructor(
    private readonly registry: string = REGISTRY,
    seed: Record<string, string> = {},
  ) {
    for (const [path, contents] of Object.entries(seed)) this.written.set(path, contents);
  }

  readRegistry(): string {
    return this.registry;
  }
  readArtifact(path: string): string | null {
    return this.written.get(path) ?? null;
  }
  writeArtifact(path: string, contents: string): void {
    this.written.set(path, contents);
  }
}

function render(store: ArtifactStore = new MemoryStore()) {
  const { renderings } = new RenderRegistryUseCase(store).execute();
  const byName = (needle: string) => renderings.find((r) => r.path.includes(needle))!.contents;
  return {
    c: byName("carbon_extension_points.h"),
    rust: byName("generated.rs"),
    ts: byName("ExtensionPoints.ts"),
  };
}

describe("the C header", () => {
  const { c } = render();

  test("declares one prototype per point, with the implicit app first", () => {
    expect(c).toContain("void carbon_plugin_register(CarbonApp* app);");
    expect(c).toContain(
      "void carbon_plugin_before_paint(CarbonApp* app, uint8_t* pixmap, uint32_t width);",
    );
    expect(c).toContain("int32_t carbon_ext_host_resolve_asset(CarbonApp* app, const char* request);");
  });

  test("is include-guarded and includes the ABI header it depends on", () => {
    expect(c).toContain("#ifndef CARBON_EXTENSION_POINTS_H");
    expect(c).toContain('#include "carbon_plugin.h"');
    expect(c.trimEnd().endsWith("#endif /* CARBON_EXTENSION_POINTS_H */")).toBe(true);
  });

  test("states each point's capability, arity and since-version", () => {
    expect(c).toContain("Requires: paint.pixmap");
    expect(c).toContain("no capability — this point only observes");
    expect(c).toContain("at most one plugin may implement it");
    expect(c).toContain("Since:    ABI 1.1");
  });

  test("marks experimental points as such", () => {
    expect(c).toContain("EXPERIMENTAL:");
  });

  test("carries the implied ABI minor", () => {
    expect(c).toContain("#define CARBON_EXTENSION_POINTS_MINOR 1u");
    expect(c).toContain("#define CARBON_EXTENSION_POINT_COUNT 3");
  });
});

describe("the Rust table", () => {
  const { rust } = render();

  test("emits an id enum that parses and prints manifest strings", () => {
    expect(rust).toContain("pub enum PointId {");
    expect(rust).toContain("LifecycleRegister,");
    expect(rust).toContain('PointId::LifecycleRegister => "lifecycle.register",');
    expect(rust).toContain('"paint.before" => Some(PointId::PaintBefore),');
  });

  test("emits NUL-terminated symbols so dlsym needs no allocation", () => {
    expect(rust).toContain('symbol: b"carbon_plugin_register\\0",');
  });

  test("carries capability, arity and stability per row", () => {
    expect(rust).toContain('capability: Some("paint.pixmap"),');
    expect(rust).toContain("capability: None,");
    expect(rust).toContain("arity: Arity::Exclusive,");
    expect(rust).toContain("stability: Stability::Experimental,");
  });

  test("emits one fn typedef per point, with the right signature", () => {
    expect(rust).toContain(
      'pub type LifecycleRegisterFn = unsafe extern "C" fn(app: *mut CarbonApp);',
    );
    expect(rust).toContain(
      'pub type PaintBeforeFn = unsafe extern "C" fn(app: *mut CarbonApp, pixmap: *mut u8, width: u32);',
    );
    // Over rustfmt's 100-char width as one line, so the generator wraps it
    // after `=` — see RustRenderer.ts's renderFnTypedef. Asserted as two
    // lines rather than joined back into one, so a regression here (the
    // generator's output no longer being rustfmt-clean) fails this test
    // instead of only ever showing up as a `bazel test //:fmt_test` failure
    // on a generated file nobody can hand-fix.
    expect(rust).toContain(
      'pub type HostResolveAssetFn =\n    unsafe extern "C" fn(app: *mut CarbonApp, request: *const c_char) -> i32;',
    );
  });

  test("the table is in enum order, because spec() indexes by it", () => {
    const enumOrder = [...rust.matchAll(/^    (\w+),$/gm)]
      .map((m) => m[1])
      .filter((name) => name !== "Many" && name !== "Exclusive" && name !== "Stable" && name !== "Experimental");
    const rowOrder = [...rust.matchAll(/^        id: PointId::(\w+),$/gm)].map((m) => m[1]);
    expect(rowOrder).toEqual(enumOrder);
  });
});

describe("the TypeScript", () => {
  const { ts } = render();

  test("emits a literal union of the ids", () => {
    expect(ts).toContain('export type ExtensionPointId =');
    expect(ts).toContain('  | "lifecycle.register"');
    expect(ts).toContain('  | "host.resolve_asset";');
  });

  test("carries what the preflight needs: capability per point", () => {
    expect(ts).toContain('capability: "paint.pixmap",');
    expect(ts).toContain("capability: null,");
  });

  test("lists every gating capability once, sorted", () => {
    const block = ts.slice(ts.indexOf("EXTENSION_POINT_CAPABILITIES"));
    expect(block).toContain('"fs.read",');
    expect(block).toContain('"paint.pixmap",');
    expect(block.indexOf('"fs.read"')).toBeLessThan(block.indexOf('"paint.pixmap"'));
  });

  test("escapes docs rather than pasting them into a string literal", () => {
    // A doc containing a quote or a newline must survive as data.
    const store = new MemoryStore(
      REGISTRY.replace('.doc = "Install JS globals.",', '.doc = "Say \\"hi\\".",'),
    );
    const rendered = render(store).ts;
    expect(rendered).toContain('doc: "Say \\"hi\\".",');
  });
});

describe("generate", () => {
  test("writes all three renderings", () => {
    const store = new MemoryStore();
    const result = new GenerateArtifactsUseCase(store).execute();

    expect(result.artifacts).toHaveLength(3);
    expect(result.pointCount).toBe(3);
    expect(result.abiMinor).toBe(1);
    expect(store.written.size).toBe(3);
    for (const artifact of result.artifacts) expect(artifact.changed).toBe(true);
  });

  test("reports changed:false on a second run over the same registry", () => {
    const store = new MemoryStore();
    new GenerateArtifactsUseCase(store).execute();
    const again = new GenerateArtifactsUseCase(store).execute();

    for (const artifact of again.artifacts) expect(artifact.changed).toBe(false);
  });
});

describe("check", () => {
  test("passes right after generate", () => {
    const store = new MemoryStore();
    new GenerateArtifactsUseCase(store).execute();

    const result = new CheckArtifactsUseCase(store).execute();
    expect(result.ok).toBe(true);
    expect(result.outOfDate).toEqual([]);
  });

  test("reports every artifact as missing on a fresh tree", () => {
    const result = new CheckArtifactsUseCase(new MemoryStore()).execute();

    expect(result.ok).toBe(false);
    expect(result.artifacts.map((a) => a.status)).toEqual(["missing", "missing", "missing"]);
  });

  test("catches a hand-edited artifact and points at the line", () => {
    const store = new MemoryStore();
    new GenerateArtifactsUseCase(store).execute();

    const path = [...store.written.keys()].find((p) => p.endsWith("generated.rs"))!;
    const edited = store.written.get(path)!.split("\n");
    edited[20] = "// somebody edited the generated file";
    store.written.set(path, edited.join("\n"));

    const result = new CheckArtifactsUseCase(store).execute();
    expect(result.ok).toBe(false);
    expect(result.outOfDate).toEqual([path]);
    expect(result.artifacts.find((a) => a.path === path)?.firstDifferingLine).toBe(21);
  });

  test("catches a point added to the registry but not regenerated", () => {
    const store = new MemoryStore();
    new GenerateArtifactsUseCase(store).execute();

    const grown = new MemoryStore(
      REGISTRY.replace(
        "};",
        `    .{
        .id = "window.resized",
        .symbol = "carbon_plugin_on_resize",
        .since_minor = 0,
        .stability = .stable,
        .arity = .many,
        .capability = null,
        .params = &.{},
        .returns = .void,
        .dispatch = "On resize.",
        .doc = "Resize swapchains.",
    },
};`,
      ),
      Object.fromEntries(store.written),
    );

    const result = new CheckArtifactsUseCase(grown).execute();
    expect(result.ok).toBe(false);
    expect(result.outOfDate).toHaveLength(3);
  });
});

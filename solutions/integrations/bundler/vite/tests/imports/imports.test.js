// Tests for @carbon/vite/imports.
// Run with: bun test packages/carbon-vite-plugin-imports

import { describe, test, expect } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  carbonImports,
  BUILTIN_MODULES,
  BUILTIN_SPECIFIERS,
  pluginNameOf,
} from "@carbon/vite/imports";

function makePlugin(opts = {}) {
  return carbonImports(opts);
}

function resolveId(plugin, source, importer) {
  const ctx = {
    error(msg) {
      // Mirror Vite/Rollup behavior: this.error() throws.
      const err = new Error(msg);
      err.__capability = true;
      throw err;
    },
  };
  return plugin.resolveId.call(ctx, source, importer);
}

function load(plugin, id) {
  return plugin.load?.(id);
}

/** Drive configResolved with a synthetic project root + write carbon.toml. */
function withProject(opts, fn) {
  const dir = join(tmpdir(), `carbon-imports-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  if (opts.carbonToml !== undefined) {
    writeFileSync(join(dir, "carbon.toml"), opts.carbonToml);
  }
  try {
    return fn(dir);
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

describe("carbonImports plugin", () => {
  test("plugin name + enforce", () => {
    const p = makePlugin();
    expect(p.name).toBe("@carbon/vite/imports");
    expect(p.enforce).toBe("pre");
  });

  describe("BUILTIN_MODULES", () => {
    test("includes expected core specifiers", () => {
      expect(BUILTIN_SPECIFIERS.has("carbon:audio")).toBe(true);
      expect(BUILTIN_SPECIFIERS.has("carbon:image")).toBe(true);
      expect(BUILTIN_SPECIFIERS.has("carbon:canvas")).toBe(true);
      expect(BUILTIN_SPECIFIERS.has("carbon:fs")).toBe(true);
      expect(BUILTIN_SPECIFIERS.has("carbon:notify")).toBe(true);
      expect(BUILTIN_SPECIFIERS.has("carbon:tray")).toBe(true);
    });

    test("audio module lists the canonical Web Audio classes", () => {
      const audio = BUILTIN_MODULES["carbon:audio"];
      const names = audio.map((e) => e.name);
      expect(names).toContain("AudioContext");
      expect(names).toContain("OscillatorNode");
      expect(names).toContain("GainNode");
      expect(names).toContain("AnalyserNode");
    });

    test("image module strips __carbon_ prefix from public names", () => {
      const image = BUILTIN_MODULES["carbon:image"];
      const loadPath = image.find((e) => e.name === "loadPath");
      expect(loadPath?.global).toBe("__carbon_image_load_path");
    });
  });

  describe("pluginNameOf", () => {
    test("extracts plugin name from carbon: specifier", () => {
      expect(pluginNameOf("carbon:audio")).toBe("audio");
      expect(pluginNameOf("carbon:image")).toBe("image");
    });
    test("handles sub-paths", () => {
      expect(pluginNameOf("carbon:audio/extras")).toBe("audio");
    });
    test("rejects non-carbon specifiers", () => {
      expect(pluginNameOf("react")).toBeNull();
      expect(pluginNameOf("./foo")).toBeNull();
      expect(pluginNameOf("")).toBeNull();
    });
  });

  describe("resolveId — virtual module routing", () => {
    test("returns virtual id for known carbon:* specifier when capability granted", () => {
      withProject(
        { carbonToml: '[app]\nname = "x"\nversion = "0"\n[runtime]\nbackend = "mini"\n[plugins]\naudio = true\n' },
        (dir) => {
          const p = makePlugin();
          p.configResolved({ command: "build", root: dir });
          const id = resolveId(p, "carbon:audio");
          expect(id).toMatch(/^\0carbon-imports:carbon:audio$/);
        },
      );
    });

    test("returns null for non-carbon specifiers", () => {
      const p = makePlugin({ skipCapabilityCheck: true });
      p.configResolved({ command: "build", root: process.cwd() });
      expect(resolveId(p, "react")).toBeNull();
      expect(resolveId(p, "./foo.tsx")).toBeNull();
    });

    test("emits build error when plugin not declared in [plugins]", () => {
      withProject(
        { carbonToml: '[app]\nname = "x"\nversion = "0"\n[runtime]\nbackend = "mini"\n[plugins]\nimage = true\n' },
        (dir) => {
          const p = makePlugin();
          p.configResolved({ command: "build", root: dir });
          let threw = null;
          try {
            resolveId(p, "carbon:audio", `${dir}/src/App.tsx`);
          } catch (e) {
            threw = e;
          }
          expect(threw).not.toBeNull();
          expect(threw.message).toContain("audio");
          expect(threw.message).toContain("[plugins]");
        },
      );
    });

    test("allows capability check to pass when [plugins] is empty (no toml)", () => {
      withProject({ /* no carbon.toml */ }, (dir) => {
        const p = makePlugin();
        p.configResolved({ command: "build", root: dir });
        // No grants found → check is a no-op (lets the project run before
        // the user has set up plugins).
        const id = resolveId(p, "carbon:audio");
        expect(id).toMatch(/^\0carbon-imports:/);
      });
    });

    test("skipCapabilityCheck=true bypasses validation", () => {
      withProject(
        { carbonToml: '[app]\nname = "x"\nversion = "0"\n[runtime]\nbackend = "mini"\n[plugins]\nimage = true\n' },
        (dir) => {
          const p = makePlugin({ skipCapabilityCheck: true });
          p.configResolved({ command: "build", root: dir });
          const id = resolveId(p, "carbon:audio");
          expect(id).toMatch(/^\0carbon-imports:/);
        },
      );
    });
  });

  describe("load — synthesized re-export modules", () => {
    test("emits export const for each builtin name", () => {
      const p = makePlugin({ skipCapabilityCheck: true });
      p.configResolved({ command: "build", root: process.cwd() });
      const id = resolveId(p, "carbon:audio");
      const result = load(p, id);
      const code = typeof result === "string" ? result : result.code;
      expect(code).toContain("export const AudioContext = globalThis.AudioContext;");
      expect(code).toContain("export const OscillatorNode = globalThis.OscillatorNode;");
    });

    test("image module wires underscore-prefixed globals", () => {
      const p = makePlugin({ skipCapabilityCheck: true });
      p.configResolved({ command: "build", root: process.cwd() });
      const id = resolveId(p, "carbon:image");
      const result = load(p, id);
      const code = typeof result === "string" ? result : result.code;
      expect(code).toContain("export const loadPath = globalThis.__carbon_image_load_path;");
      expect(code).toContain("export const CarbonImage = globalThis.CarbonImage;");
    });

    test("unknown carbon:* specifier emits stub module", () => {
      const p = makePlugin({ skipCapabilityCheck: true });
      p.configResolved({ command: "build", root: process.cwd() });
      const id = resolveId(p, "carbon:does-not-exist");
      const result = load(p, id);
      const code = typeof result === "string" ? result : result.code;
      expect(code).toContain("unknown virtual module");
      expect(code).toContain("carbon:does-not-exist");
    });

    test("non-virtual id returns null from load", () => {
      const p = makePlugin();
      p.configResolved({ command: "build", root: process.cwd() });
      expect(load(p, "/project/src/app.tsx")).toBeNull();
    });
  });

  describe("extraModules option", () => {
    test("extra module is recognized + emits matching exports", () => {
      const p = makePlugin({
        skipCapabilityCheck: true,
        extraModules: { "carbon:custom": ["foo", "bar"] },
      });
      p.configResolved({ command: "build", root: process.cwd() });
      const id = resolveId(p, "carbon:custom");
      const result = load(p, id);
      const code = typeof result === "string" ? result : result.code;
      expect(code).toContain("export const foo = globalThis.foo;");
      expect(code).toContain("export const bar = globalThis.bar;");
    });
  });
});

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
      expect(BUILTIN_SPECIFIERS.has("carbon:process")).toBe(true);
      expect(BUILTIN_SPECIFIERS.has("carbon:notify")).toBe(true);
      expect(BUILTIN_SPECIFIERS.has("carbon:tray")).toBe(true);
    });

    test("carbon:fs does not exist — no virtual module for raw filesystem access", () => {
      // Per the Fs/Net split: file access is dialog-mediated or the
      // bounds-checked readOwnAsset, never an arbitrary path, for anyone.
      expect(BUILTIN_SPECIFIERS.has("carbon:fs")).toBe(false);
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

  describe("first-party-only specifiers (carbon:process)", () => {
    test("resolves fine when imported from the app's own src/", () => {
      const p = makePlugin({ skipCapabilityCheck: true });
      p.configResolved({ command: "build", root: process.cwd() });
      const id = resolveId(p, "carbon:process", "/project/src/App.tsx");
      expect(id).toMatch(/^\0carbon-imports:carbon:process$/);
    });

    test("refuses when imported from inside node_modules, even with capability checks off", () => {
      const p = makePlugin({ skipCapabilityCheck: true });
      p.configResolved({ command: "build", root: process.cwd() });
      let threw = null;
      try {
        resolveId(p, "carbon:process", "/project/node_modules/some-dep/index.js");
      } catch (e) {
        threw = e;
      }
      expect(threw).not.toBeNull();
      expect(threw.message).toContain("only importable from the app's own source");
    });

    test("Windows-style backslash paths are recognized as node_modules too", () => {
      const p = makePlugin({ skipCapabilityCheck: true });
      p.configResolved({ command: "build", root: process.cwd() });
      expect(() =>
        resolveId(p, "carbon:process", "C:\\project\\node_modules\\some-dep\\index.js"),
      ).toThrow(/only importable from the app's own source/);
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

  describe("local plugin manifests (plugins/<name>/carbon-plugin.toml)", () => {
    // Regression test for a real bug: labs/examples/pulse's App.tsx imported
    // `setActive` from `carbon:carbon-pulse`, and the CI "build examples" job
    // failed with "No matching export" — the manifest declared the export
    // correctly, but discoverLocalManifests (a) never looked in the app's own
    // `plugins/<name>/` directory at all (only a `packages/` workspace root
    // that nothing in this tree uses), and (b) normalizeManifest expected a
    // `[plugin]` wrapper section no real carbon-plugin.toml has ever used.
    // This writes a manifest in the SAME shape as the real Pulse plugins'
    // (top-level name/modules, [exports."carbon:x"]) so a regression on
    // either bug fails here before it reaches a real app's build.
    function writePlugin(projectDir, name, tomlBody) {
      const dir = join(projectDir, "plugins", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "carbon-plugin.toml"), tomlBody);
    }

    test("a local plugin's declared export resolves and loads", () => {
      withProject({}, (dir) => {
        writePlugin(
          dir,
          "carbon-pulse",
          [
            'name = "carbon-pulse"',
            'version = "0.1.0"',
            'language = "zig"',
            'extension-points = ["lifecycle.register", "paint.before"]',
            'modules = ["carbon:carbon-pulse"]',
            "",
            "[abi]",
            "major = 1",
            "minor = 1",
            "",
            "[capabilities]",
            "required = []",
            "optional = []",
            "",
            '[exports."carbon:carbon-pulse"]',
            'names = ["setActive"]',
            'globals = { setActive = "__carbon_pulse_set_active" }',
            "",
          ].join("\n"),
        );

        const p = makePlugin({ skipCapabilityCheck: true });
        p.configResolved({ command: "build", root: dir });
        const id = resolveId(p, "carbon:carbon-pulse");
        const result = load(p, id);
        const code = typeof result === "string" ? result : result.code;
        // A lazy wrapper, not an eager `export const` snapshot — see the note
        // on synthesizeReExports's `lazy` parameter. A plugin's globals
        // install after the bundle evaluates, so an eager binding captured
        // at import time would be `undefined` forever, which is exactly the
        // "not a function" bug this locks in against regressing.
        expect(code).toContain(
          "export function setActive(...args) { return globalThis.__carbon_pulse_set_active(...args); }",
        );
      });
    });

    test("a `modules` line placed after a [section] header is NOT picked up — the documented TOML gotcha", () => {
      // Guards the fix's other half: real plugin manifests once had `modules`
      // sitting right after [capabilities] with no header of its own, which
      // TOML parses as capabilities.modules, not top-level. This pins the
      // (correct) top-level-only behavior so a future edit can't silently
      // reintroduce the misplacement without a test noticing the module
      // stops resolving.
      withProject({}, (dir) => {
        writePlugin(
          dir,
          "carbon-misplaced",
          [
            'name = "carbon-misplaced"',
            "",
            "[capabilities]",
            "required = []",
            'modules = ["carbon:carbon-misplaced"]',
            "",
          ].join("\n"),
        );

        const p = makePlugin({ skipCapabilityCheck: true });
        p.configResolved({ command: "build", root: dir });
        const id = resolveId(p, "carbon:carbon-misplaced");
        const result = load(p, id);
        const code = typeof result === "string" ? result : result.code;
        expect(code).toContain("unknown virtual module");
      });
    });

    test("an app-local plugin manifest overrides a same-named BUILTIN_MODULES entry", () => {
      withProject({}, (dir) => {
        writePlugin(
          dir,
          "audio",
          [
            'name = "audio"',
            'modules = ["carbon:audio"]',
            "",
            '[exports."carbon:audio"]',
            'names = ["CustomThing"]',
            'globals = { CustomThing = "__custom_audio_thing" }',
            "",
          ].join("\n"),
        );

        const p = makePlugin({ skipCapabilityCheck: true });
        p.configResolved({ command: "build", root: dir });
        const id = resolveId(p, "carbon:audio");
        const result = load(p, id);
        const code = typeof result === "string" ? result : result.code;
        // Also lazy — this specifier is manifest-sourced (it overrode the
        // BUILTIN_MODULES "carbon:audio" entry), so it gets the same
        // deferred-resolution codegen a plugin export always does.
        expect(code).toContain(
          "export function CustomThing(...args) { return globalThis.__custom_audio_thing(...args); }",
        );
        expect(code).not.toContain("AudioContext");
      });
    });

    test("behavioral: the export works when the global is installed AFTER import, not before", async () => {
      // Not a string-matching test — this actually imports the generated
      // module and calls the export, in the same order the real runtime
      // produces: bundle (import) evaluates first, plugin registration
      // (which installs globalThis.__test_lazy_target) happens after. If
      // synthesizeReExports ever regresses back to an eager `export const`,
      // this throws "globalThis.__test_lazy_target is not a function" —
      // the exact failure this fix was written for.
      //
      // The generated module is written OUTSIDE withProject's managed
      // directory: withProject's cleanup runs synchronously right after this
      // callback returns, which would race the async `import()` below if the
      // module lived inside the directory it deletes.
      const code = withProject({}, (dir) => {
        writePlugin(
          dir,
          "lazy-check",
          [
            'name = "lazy-check"',
            'modules = ["carbon:lazy-check"]',
            "",
            '[exports."carbon:lazy-check"]',
            'names = ["callIt"]',
            'globals = { callIt = "__test_lazy_target" }',
            "",
          ].join("\n"),
        );

        const p = makePlugin({ skipCapabilityCheck: true });
        p.configResolved({ command: "build", root: dir });
        const id = resolveId(p, "carbon:lazy-check");
        const result = load(p, id);
        return typeof result === "string" ? result : result.code;
      });

      const modPath = join(
        tmpdir(),
        `carbon-imports-lazy-check-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`,
      );
      writeFileSync(modPath, code);
      try {
        const mod = await import(modPath);
        // Import happened; the plugin "hasn't registered" yet.
        expect(typeof mod.callIt).toBe("function");
        expect(globalThis.__test_lazy_target).toBeUndefined();

        // Now the plugin registers, well after import — exactly mini.rs's
        // dispatch_register-runs-after-bundle-eval order.
        globalThis.__test_lazy_target = (x) => x * 2;
        expect(mod.callIt(21)).toBe(42);
      } finally {
        delete globalThis.__test_lazy_target;
        try { rmSync(modPath, { force: true }); } catch {}
      }
    });
  });
});

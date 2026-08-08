// Tests for @carbon/vite/ink-shim.
// Run with: bun test

import { describe, test, expect } from "bun:test";
import { inkShim } from "@carbon/vite/ink-shim";

function makePlugin(opts = {}) {
  return inkShim(opts);
}

// Minimal fake Vite context (we only call plugin hooks manually).
function transform(plugin, code, id = "/project/src/app.tsx") {
  return plugin.transform?.(code, id);
}

function resolveId(plugin, source) {
  return plugin.resolveId?.(source);
}

function load(plugin, id) {
  return plugin.load?.(id);
}

describe("inkShim plugin", () => {
  test("has correct plugin name", () => {
    const p = makePlugin();
    expect(p.name).toBe("@carbon/vite/ink-shim");
  });

  test("enforce is pre", () => {
    const p = makePlugin();
    expect(p.enforce).toBe("pre");
  });

  describe("transform — ink rewrite", () => {
    test("rewrites double-quoted ink import", () => {
      const p = makePlugin();
      const code = `import { Box, Text } from "ink";`;
      const result = transform(p, code);
      expect(result).not.toBeNull();
      expect(result.code).toContain(`from "@carbon/term"`);
      expect(result.code).not.toContain(`from "ink"`);
    });

    test("rewrites single-quoted ink import", () => {
      const p = makePlugin();
      const code = `import { useInput } from 'ink';`;
      const result = transform(p, code);
      expect(result.code).toContain(`from '@carbon/term'`);
    });

    test("rewrites multiple ink imports in same file", () => {
      const p = makePlugin();
      const code = [
        `import { Box } from "ink";`,
        `import { Text } from "ink";`,
      ].join("\n");
      const result = transform(p, code);
      // Both occurrences must be rewritten.
      const count = (result.code.match(/@carbon\/term/g) || []).length;
      expect(count).toBe(2);
    });

    test("does not touch non-ink imports", () => {
      const p = makePlugin();
      const code = `import React from "react";\nimport { Box } from "ink-extra";`;
      const result = transform(p, code);
      // Neither import should be rewritten.
      expect(result).toBeNull();
    });

    test("does not transform node_modules files", () => {
      const p = makePlugin();
      const code = `import { Box } from "ink";`;
      const result = p.transform?.(code, "/project/node_modules/some-lib/index.js");
      expect(result).toBeNull();
    });

    test("does not transform non-JS/TS files", () => {
      const p = makePlugin();
      const code = `from "ink"`;
      const result = p.transform?.(code, "/project/src/style.css");
      expect(result).toBeNull();
    });

    test("handles aliased imports", () => {
      const p = makePlugin();
      const code = `import { Box as B, Text as T } from "ink";`;
      const result = transform(p, code);
      expect(result.code).toContain(`from "@carbon/term"`);
    });
  });

  describe("resolveId — companion stubs", () => {
    test("returns virtual id for ink-spinner", () => {
      const p = makePlugin();
      const vid = resolveId(p, "ink-spinner");
      expect(vid).toMatch(/\0carbon-ink-shim:ink-spinner/);
    });

    test("returns virtual id for ink-select-input", () => {
      const p = makePlugin();
      const vid = resolveId(p, "ink-select-input");
      expect(vid).toMatch(/\0carbon-ink-shim:ink-select-input/);
    });

    test("returns virtual id for ink-text-input", () => {
      const p = makePlugin();
      const vid = resolveId(p, "ink-text-input");
      expect(vid).toMatch(/\0carbon-ink-shim:ink-text-input/);
    });

    test("returns null for unrecognised packages", () => {
      const p = makePlugin();
      expect(resolveId(p, "some-random-package")).toBeNull();
    });

    test("returns null for ink (handled by transform)", () => {
      const p = makePlugin();
      // ink itself is handled via transform, resolveId returns null.
      expect(resolveId(p, "ink")).toBeNull();
    });
  });

  describe("load — virtual stub modules", () => {
    test("ink-spinner stub exports Spinner", () => {
      const p = makePlugin();
      const vid = "\0carbon-ink-shim:ink-spinner";
      const result = load(p, vid);
      expect(result).toContain("export function Spinner");
      expect(result).toContain("export default Spinner");
      expect(result).toContain("console.warn");
    });

    test("ink-select-input stub exports SelectInput", () => {
      const p = makePlugin();
      const vid = "\0carbon-ink-shim:ink-select-input";
      const result = load(p, vid);
      expect(result).toContain("export function SelectInput");
      expect(result).toContain("export default SelectInput");
    });

    test("ink-text-input stub exports TextInput", () => {
      const p = makePlugin();
      const vid = "\0carbon-ink-shim:ink-text-input";
      const result = load(p, vid);
      expect(result).toContain("export function TextInput");
      expect(result).toContain("export default TextInput");
    });

    test("unknown virtual id returns null", () => {
      const p = makePlugin();
      expect(load(p, "\0carbon-ink-shim:not-real")).toBeNull();
    });

    test("non-virtual id returns null", () => {
      const p = makePlugin();
      expect(load(p, "/project/src/app.tsx")).toBeNull();
    });
  });

  describe("debug option", () => {
    test("plugin creates without error when debug=true", () => {
      expect(() => makePlugin({ debug: true })).not.toThrow();
    });
  });

  describe("extraRewrites option", () => {
    test("rewrites extra source package", () => {
      const p = makePlugin({ extraRewrites: ["my-ink-fork", "@carbon/term"] });
      const code = `import { Box } from "my-ink-fork";`;
      const result = transform(p, code, "/project/app.tsx");
      expect(result).not.toBeNull();
      expect(result.code).toContain("@carbon/term");
    });
  });
});

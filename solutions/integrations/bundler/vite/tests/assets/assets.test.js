// Tests for @carbon/vite/assets.
// Run with: bun test packages/carbon-vite-plugin-assets

import { describe, test, expect } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  carbonAssets,
  TEXT_ASSET_EXTENSIONS,
  IMAGE_ASSET_EXTENSIONS,
} from "@carbon/vite/assets";

function makePlugin(opts = {}) {
  return carbonAssets(opts);
}

/** Create a temp file with the given contents, return its absolute path. */
function withFile(name, contents, fn) {
  const dir = join(tmpdir(), `carbon-assets-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, contents);
  try {
    return fn(path);
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

describe("carbonAssets plugin", () => {
  test("plugin name + enforce", () => {
    const p = makePlugin();
    expect(p.name).toBe("@carbon/vite/assets");
    expect(p.enforce).toBe("pre");
  });

  describe("text-format inlining", () => {
    test("inlines .wgsl as default-export string", () => {
      withFile("vert.wgsl", "@vertex fn main() {}", (path) => {
        const p = makePlugin();
        const r = p.load(path);
        const code = typeof r === "string" ? r : r.code;
        expect(code).toContain("export default");
        expect(code).toContain('"@vertex fn main() {}"');
      });
    });

    test("inlines .glsl, .frag, .vert", () => {
      const exts = [".glsl", ".frag", ".vert"];
      for (const ext of exts) {
        withFile(`shader${ext}`, "void main(){}", (path) => {
          const p = makePlugin();
          const r = p.load(path);
          expect(r).not.toBeNull();
          const code = typeof r === "string" ? r : r.code;
          expect(code).toContain('"void main(){}"');
        });
      }
    });

    test("inlines .txt and .md", () => {
      withFile("notes.txt", "hello world", (path) => {
        const p = makePlugin();
        const r = p.load(path);
        const code = typeof r === "string" ? r : r.code;
        expect(code).toContain('"hello world"');
      });
      withFile("README.md", "# Title", (path) => {
        const p = makePlugin();
        const r = p.load(path);
        const code = typeof r === "string" ? r : r.code;
        expect(code).toContain('"# Title"');
      });
    });

    test("escapes special characters via JSON.stringify", () => {
      withFile("tricky.txt", 'he said "hi"\nnewline', (path) => {
        const p = makePlugin();
        const r = p.load(path);
        const code = typeof r === "string" ? r : r.code;
        // Confirm round-trip-able: eval the export literal and compare.
        const match = code.match(/export default ([\s\S]+);/);
        expect(match).not.toBeNull();
        const value = JSON.parse(match[1]);
        expect(value).toBe('he said "hi"\nnewline');
      });
    });

    test("strips ?raw / ?url query suffixes before extension match", () => {
      withFile("vert.wgsl", "x", (path) => {
        const p = makePlugin();
        const r = p.load(`${path}?raw`);
        expect(r).not.toBeNull();
      });
    });
  });

  describe("non-handled extensions", () => {
    test("returns null for .ts source files", () => {
      withFile("foo.ts", "export const x = 1;", (path) => {
        const p = makePlugin();
        expect(p.load(path)).toBeNull();
      });
    });

    test("returns null for .png (passes through to Vite)", () => {
      withFile("logo.png", "fake-png-bytes", (path) => {
        const p = makePlugin();
        expect(p.load(path)).toBeNull();
      });
    });

    test("returns null when file does not exist", () => {
      const p = makePlugin();
      const r = p.load("/this/path/does/not/exist.wgsl");
      expect(r).toBeNull();
    });
  });

  describe("extraTextExtensions option", () => {
    test("custom extension is recognized", () => {
      withFile("script.vsh", "void main() {}", (path) => {
        const p = makePlugin({ extraTextExtensions: [".vsh"] });
        const r = p.load(path);
        expect(r).not.toBeNull();
      });
    });

    test("extension without leading dot is normalized", () => {
      withFile("script.fxs", "fx", (path) => {
        const p = makePlugin({ extraTextExtensions: ["fxs"] });
        const r = p.load(path);
        expect(r).not.toBeNull();
      });
    });
  });

  describe("exported tables", () => {
    test("TEXT_ASSET_EXTENSIONS lists shader formats", () => {
      expect(TEXT_ASSET_EXTENSIONS.has(".wgsl")).toBe(true);
      expect(TEXT_ASSET_EXTENSIONS.has(".glsl")).toBe(true);
      expect(TEXT_ASSET_EXTENSIONS.has(".frag")).toBe(true);
      expect(TEXT_ASSET_EXTENSIONS.has(".vert")).toBe(true);
    });

    test("IMAGE_ASSET_EXTENSIONS lists raster formats", () => {
      expect(IMAGE_ASSET_EXTENSIONS.has(".png")).toBe(true);
      expect(IMAGE_ASSET_EXTENSIONS.has(".jpg")).toBe(true);
      expect(IMAGE_ASSET_EXTENSIONS.has(".webp")).toBe(true);
      expect(IMAGE_ASSET_EXTENSIONS.has(".avif")).toBe(true);
    });
  });
});

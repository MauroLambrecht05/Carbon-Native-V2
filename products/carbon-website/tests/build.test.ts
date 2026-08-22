// Product-level: does the assembled site actually build and serve, not
// whether one component renders in isolation — see products/README.md's
// "tests/ — smoke and end-to-end. Unit tests belong beside the code they
// cover, in solutions/." This product has no solutions/ code of its own to
// unit-test; every line here is presentation, so the real question is
// whether `vite build` produces something a browser can load.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { build } from "vite";

const ROOT = join(import.meta.dirname, "..");
const DIST = join(ROOT, "dist");

describe("production build", () => {
  beforeAll(async () => {
    await build({ root: ROOT, logLevel: "silent" });
  }, 30_000);

  afterAll(() => {
    rmSync(DIST, { recursive: true, force: true });
  });

  test("emits index.html", () => {
    expect(existsSync(join(DIST, "index.html"))).toBe(true);
  });

  test("index.html references a built script, not the raw .tsx source", () => {
    const html = readFileSync(join(DIST, "index.html"), "utf-8");
    expect(html).toContain("<script");
    expect(html).not.toContain("composition/main.tsx");
  });

  test("emits a non-trivial JS bundle", () => {
    const assetsDir = join(DIST, "assets");
    const jsFiles = readdirSync(assetsDir).filter((f) => f.endsWith(".js"));
    expect(jsFiles.length).toBeGreaterThan(0);

    const bundle = readFileSync(join(assetsDir, jsFiles[0]), "utf-8");
    // A handful of real strings this build should contain — catches an
    // empty or broken bundle without asserting on hashed filenames.
    expect(bundle).toContain("Carbon Cloud");
  });

  test("carries the Inter font files it references", () => {
    const assetsDir = join(DIST, "assets");
    const files = readdirSync(assetsDir);
    expect(files.some((f) => f.startsWith("Inter-Regular") && f.endsWith(".woff2"))).toBe(true);
  });
});

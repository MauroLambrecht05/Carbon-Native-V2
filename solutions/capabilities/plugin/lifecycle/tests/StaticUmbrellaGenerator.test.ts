// Regression coverage for the empty-plugins umbrella build.zig — a `carbon
// build --release` with zero enabled plugins used to fail with Zig's "unused
// local constant" on `sdk`, since nothing in the generated file referenced
// it when `pluginModules` was empty. See StaticUmbrellaGenerator.ts's build.zig
// template for the fix (a conditional `_ = sdk;` discard).

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { generateUmbrella } from "../infrastructure/StaticUmbrellaGenerator.ts";

const TARGET = { platform: "win32" as NodeJS.Platform, arch: "x64" };
const UMBRELLA_DIR = join("app", "carbon", ".static-plugins");
const SDK_COMPOSITION = join("carbon-ext", "composition");

describe("generateUmbrella — build.zig with zero enabled plugins", () => {
  test("discards the unused `sdk` local so `zig build` doesn't hard-error", () => {
    const { "build.zig": buildZig } = generateUmbrella(UMBRELLA_DIR, SDK_COMPOSITION, [], TARGET);
    expect(buildZig).toContain("_ = sdk;");
  });

  test("umbrella.zig still emits every registry point as a no-op stub", () => {
    const { "umbrella.zig": umbrellaZig } = generateUmbrella(UMBRELLA_DIR, SDK_COMPOSITION, [], TARGET);
    expect(umbrellaZig).toContain("carbon_plugin_static_count");
    expect(umbrellaZig).toContain("return 0;");
  });
});

describe("generateUmbrella — build.zig with at least one enabled plugin", () => {
  test("does not discard `sdk` — the plugin module import already uses it", () => {
    const { "build.zig": buildZig } = generateUmbrella(
      UMBRELLA_DIR,
      SDK_COMPOSITION,
      [{ name: "demo-plugin", mainZigPath: join("app", "carbon", "plugins", "local", "demo-plugin", "src", "main.zig"), points: [] }],
      TARGET,
    );
    expect(buildZig).not.toContain("_ = sdk;");
    expect(buildZig).toContain('sdk.module("carbon_sdk")');
  });
});

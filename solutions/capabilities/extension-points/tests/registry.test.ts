// The Zig parser and the model, driven against string literals.
//
// Everything here is domain: no filesystem, no Zig toolchain, no workspace.
// That is the point of parsing rather than executing — the rules of the
// registry can be exercised the way any other model is.

import { describe, expect, test } from "bun:test";

import {
  ExtensionPointRegistry,
  ExtensionPoint,
  parseZigRegistry,
  RegistryInvariantError,
  RegistryParseError,
  valueType,
} from "../index.ts";

/** A registry with one point, with `extra` spliced in as more points. */
function registrySource(points: string): string {
  return `
const std = @import("std");

pub const Arity = enum { many, exclusive };

pub const POINTS = [_]ExtensionPoint{
${points}
};
`;
}

const MINIMAL = registrySource(`
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
`);

describe("parseZigRegistry", () => {
  test("reads a point's every field", () => {
    const registry = parseZigRegistry(MINIMAL);
    const point = registry.require("lifecycle.register");

    expect(point.symbol).toBe("carbon_plugin_register");
    expect(point.sinceMinor).toBe(0);
    expect(point.stability).toBe("stable");
    expect(point.arity).toBe("many");
    expect(point.capability).toBeNull();
    expect(point.params).toEqual([]);
    expect(point.returns.c).toBe("void");
    expect(point.doc).toBe("Install JS globals.");
  });

  test("reads typed params in order", () => {
    const registry = parseZigRegistry(
      registrySource(`
    .{
        .id = "paint.before",
        .symbol = "carbon_plugin_before_paint",
        .since_minor = 0,
        .stability = .stable,
        .arity = .many,
        .capability = "paint.pixmap",
        .params = &.{
            .{ .name = "pixmap", .type = .bytes_mut, .doc = "RGBA8." },
            .{ .name = "width", .type = .u32, .doc = "Pixels." },
        },
        .returns = .void,
        .dispatch = "Every frame.",
        .doc = "Draw.",
    },
`),
    );

    const point = registry.require("paint.before");
    expect(point.capability).toBe("paint.pixmap");
    expect(point.params.map((p) => p.name)).toEqual(["pixmap", "width"]);
    expect(point.params[0].type.c).toBe("uint8_t*");
    expect(point.params[1].type.rust).toBe("u32");
  });

  test("joins a Zig multi-line string, keeping the author's breaks", () => {
    const registry = parseZigRegistry(
      registrySource(`
    .{
        .id = "lifecycle.register",
        .symbol = "carbon_plugin_register",
        .since_minor = 0,
        .stability = .stable,
        .arity = .many,
        .capability = null,
        .params = &.{},
        .returns = .void,
        .dispatch = "Once.",
        .doc =
        \\\\First line.
        \\\\
        \\\\Third line.
        ,
    },
`),
    );

    expect(registry.require("lifecycle.register").doc).toBe("First line.\n\nThird line.");
  });

  test("a brace inside a doc string does not end the array", () => {
    const registry = parseZigRegistry(
      registrySource(`
    .{
        .id = "lifecycle.register",
        .symbol = "carbon_plugin_register",
        .since_minor = 0,
        .stability = .stable,
        .arity = .many,
        .capability = null,
        .params = &.{},
        .returns = .void,
        .dispatch = "Once.",
        .doc =
        \\\\Return .{ .ok = true } from your handler.
        ,
    },
`),
    );

    expect(registry.points).toHaveLength(1);
    expect(registry.require("lifecycle.register").doc).toContain(".{ .ok = true }");
  });

  test("skips // comments between points", () => {
    const registry = parseZigRegistry(
      registrySource(`
    // ── lifecycle ───────────────────────────────
    .{
        .id = "lifecycle.register",
        .symbol = "carbon_plugin_register",
        .since_minor = 0,
        .stability = .stable,
        .arity = .many,
        .capability = null,
        .params = &.{},
        .returns = .void,
        .dispatch = "Once.",
        .doc = "Doc.", // trailing note
    },
`),
    );

    expect(registry.points).toHaveLength(1);
  });

  test("refuses a registry it cannot find POINTS in", () => {
    expect(() => parseZigRegistry("pub const NOT_POINTS = .{};")).toThrow(RegistryParseError);
  });

  test("refuses an empty registry", () => {
    expect(() => parseZigRegistry(registrySource(""))).toThrow(/declares no extension points/);
  });

  test("names the missing field", () => {
    expect(() =>
      parseZigRegistry(
        registrySource(`
    .{
        .id = "lifecycle.register",
        .symbol = "carbon_plugin_register",
        .since_minor = 0,
        .stability = .stable,
        .arity = .many,
        .capability = null,
        .params = &.{},
        .returns = .void,
        .doc = "No dispatch field.",
    },
`),
      ),
    ).toThrow(/is missing the field \.dispatch/);
  });

  test("refuses an unknown value type, listing the ones that exist", () => {
    expect(() =>
      parseZigRegistry(
        registrySource(`
    .{
        .id = "a.b",
        .symbol = "s",
        .since_minor = 0,
        .stability = .stable,
        .arity = .many,
        .capability = null,
        .params = &.{},
        .returns = .f64,
        .dispatch = "d",
        .doc = "doc",
    },
`),
      ),
    ).toThrow(/allowed: \.void/);
  });

  test("refuses an unknown arity", () => {
    expect(() =>
      parseZigRegistry(
        registrySource(`
    .{
        .id = "a.b",
        .symbol = "s",
        .since_minor = 0,
        .stability = .stable,
        .arity = .sometimes,
        .capability = null,
        .params = &.{},
        .returns = .void,
        .dispatch = "d",
        .doc = "doc",
    },
`),
      ),
    ).toThrow(/allowed: \.many, \.exclusive/);
  });
});

describe("ExtensionPointRegistry invariants", () => {
  const point = (id: string, symbol: string) =>
    new ExtensionPoint(id, symbol, 0, "stable", "many", null, [], valueType("void"), "d", "doc");

  test("refuses a duplicate id", () => {
    expect(() => new ExtensionPointRegistry([point("a.b", "one"), point("a.b", "two")])).toThrow(
      RegistryInvariantError,
    );
  });

  test("refuses two points sharing one symbol", () => {
    expect(() => new ExtensionPointRegistry([point("a.b", "same"), point("c.d", "same")])).toThrow(
      /would answer for both/,
    );
  });

  test("refuses an id that is not <area>.<verb>", () => {
    expect(() => new ExtensionPointRegistry([point("Lifecycle.Register", "s")])).toThrow(
      /lower_snake_case/,
    );
  });

  test("require() lists the known ids when one is missing", () => {
    const registry = new ExtensionPointRegistry([point("a.b", "s")]);
    expect(() => registry.require("no.such")).toThrow(/known points: a\.b/);
  });
});

describe("derived names", () => {
  const point = new ExtensionPoint(
    "window.theme_changed",
    "carbon_ext_window_theme_changed",
    1,
    "stable",
    "many",
    null,
    [],
    valueType("void"),
    "d",
    "doc",
  );

  test("area, constant, camel and pascal spellings", () => {
    expect(point.area).toBe("window");
    expect(point.constantName).toBe("WINDOW_THEME_CHANGED");
    expect(point.camelName).toBe("windowThemeChanged");
    expect(point.pascalName).toBe("WindowThemeChanged");
  });
});

describe("the real registry", () => {
  test("parses, and every point is reachable and well-formed", async () => {
    const source = await Bun.file(
      new URL("../../../contracts/plugin/registry/extension-points.zig", import.meta.url),
    ).text();

    const registry = parseZigRegistry(source);

    expect(registry.points.length).toBeGreaterThan(0);
    for (const point of registry.points) {
      expect(registry.get(point.id)).toBe(point);
      expect(point.symbol).toMatch(/^carbon_(plugin|ext)_/);
      expect(point.doc.length).toBeGreaterThan(0);
      expect(point.dispatch.length).toBeGreaterThan(0);
    }
  });

  test("the seven pre-registry hooks keep their original symbols", async () => {
    const source = await Bun.file(
      new URL("../../../contracts/plugin/registry/extension-points.zig", import.meta.url),
    ).text();
    const registry = parseZigRegistry(source);

    // Renaming any of these would stop every already-built plugin loading.
    // That is the one cost this contract exists to avoid, so it is a test.
    const frozen: Record<string, string> = {
      "lifecycle.register": "carbon_plugin_register",
      "lifecycle.before_reload": "carbon_plugin_before_reload",
      "lifecycle.after_reload": "carbon_plugin_after_reload",
      "lifecycle.shutdown": "carbon_plugin_on_shutdown",
      "paint.before": "carbon_plugin_before_paint",
      "paint.after": "carbon_plugin_after_paint",
      "window.resized": "carbon_plugin_on_resize",
    };

    for (const [id, symbol] of Object.entries(frozen)) {
      expect(registry.require(id).symbol).toBe(symbol);
    }
  });
});

// Are the checked-in generated artifacts still what the Zig registry says?
//
// This lives in a product test rather than in the capability's, because it is
// about THIS workspace's files. The capability's tests drive an in-memory store
// and prove the generator is correct; this proves someone ran it.
//
// It was in products/carbon-ext/tests while that was a CLI. carbon-ext is the
// SDK now and has no test runner, so the check moved here with the command it
// belongs to — `carbon ext check`.

import { describe, expect, test } from "bun:test";
import { extensionPointUseCases } from "@carbon/registry";
import { CARBON_ROOT } from "@carbon/workspace";

describe("the checked-in artifacts", () => {
  const { check, render } = extensionPointUseCases(CARBON_ROOT);

  test("still match the Zig registry", () => {
    const result = check.execute();

    // Printed rather than only asserted: when this fails in CI the useful
    // output is which file and where, not "expected true to be false".
    if (!result.ok) {
      for (const artifact of result.artifacts) {
        if (artifact.status === "current") continue;
        console.error(
          `  ${artifact.status.toUpperCase()} ${artifact.path}` +
            (artifact.firstDifferingLine ? ` (line ${artifact.firstDifferingLine})` : ""),
        );
      }
      console.error("  regenerate: carbon ext generate");
    }

    expect(result.outOfDate).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test("the registry declares points", () => {
    expect(check.execute().pointCount).toBeGreaterThan(0);
  });

  test("the generated TypeScript agrees with the Zig on ids and capabilities", async () => {
    const { registry } = render.execute();
    const generated = await import(
      "../../../solutions/contracts/plugin/types/ExtensionPoints.ts"
    );

    expect(generated.EXTENSION_POINT_IDS).toEqual(registry.ids);
    expect(generated.EXTENSION_POINT_CAPABILITIES).toEqual(registry.capabilities);

    for (const point of registry.points) {
      const spec = generated.extensionPoint(point.id);
      expect(spec).toBeDefined();
      expect(spec!.symbol).toBe(point.symbol);
      expect(spec!.capability).toBe(point.capability);
      expect(spec!.arity).toBe(point.arity);
    }
  });
});

describe("the SDK the scaffolder points at", () => {
  test("carbon-ext's package root is where build.zig actually is", async () => {
    // `carbon plugin new` writes a build.zig.zon whose dependency path is
    // `<carbon-ext>/composition`. If the SDK's layout moves and that constant
    // does not, every scaffolded plugin gets a dependency on a directory that
    // does not exist — which compiles fine here and fails on the author's
    // first `zig build`.
    const { existsSync } = await import("node:fs");
    const { join } = await import("node:path");

    const packageRoot = join(CARBON_ROOT, "products", "carbon-ext", "composition");
    expect(existsSync(join(packageRoot, "build.zig"))).toBe(true);
    expect(existsSync(join(packageRoot, "build.zig.zon"))).toBe(true);
  });

  test("the templates the scaffolder reads are where it looks for them", async () => {
    const { existsSync } = await import("node:fs");
    const { join } = await import("node:path");

    const templates = join(
      CARBON_ROOT, "products", "carbon-ext", "presentation", "templates", "plugin",
    );
    for (const file of ["build.zig.tmpl", "build.zig.zon.tmpl", "carbon-plugin.toml.tmpl"]) {
      expect(existsSync(join(templates, file))).toBe(true);
    }
    expect(existsSync(join(templates, "src", "main.zig.tmpl"))).toBe(true);
  });

  test("the C ABI header a plugin compiles against ships from the SDK", async () => {
    const { existsSync } = await import("node:fs");
    const { join } = await import("node:path");

    expect(
      existsSync(
        join(CARBON_ROOT, "products", "carbon-ext", "presentation", "include", "carbon_plugin.h"),
      ),
    ).toBe(true);
  });
});

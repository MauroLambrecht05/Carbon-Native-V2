// Guards the one duplication the architecture deliberately accepts.
//
// A command's metadata is declared twice: cheaply in commands/registry.ts so
// help and routing never import an implementation, and again on the class so
// it sits beside the code it describes. That duplication buys the cold-start
// property, and this is the price — a test that loads every command and fails
// if the two copies disagree.

import { describe, expect, test } from "bun:test";
import { isCommandGroup } from "@carbon/cli";
import { buildRegistry } from "../composition/registry.ts";

const registry = buildRegistry();

describe("command registry", () => {
  test("registers every command exactly once", () => {
    const names = registry.all().map((d) => d.meta.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("resolves aliases", () => {
    expect(registry.resolve("new")?.meta.name).toBe("init");
    expect(registry.resolve("init")?.meta.name).toBe("init");
  });

  test("hides commands marked hidden", () => {
    const visible = registry.visible().map((d) => d.meta.name);
    expect(visible).not.toContain("create");
    expect(visible).toContain("build");
  });

  test("suggests a near-miss for a typo", () => {
    expect(registry.suggest("docter")).toContain("doctor");
    expect(registry.suggest("buld")).toContain("build");
  });

  test("suggests nothing for a wild miss", () => {
    expect(registry.suggest("zzzzzzzzzz")).toHaveLength(0);
  });

  // The load() thunks must stay thunks. If a descriptor ever imports its
  // module eagerly, `carbon --help` starts paying for vite and rollup.
  test("descriptors do not load their command to describe it", () => {
    for (const descriptor of registry.all()) {
      expect(typeof descriptor.load).toBe("function");
      expect(descriptor.meta.summary.length).toBeGreaterThan(0);
    }
  });
});

describe("registry metadata matches command classes", () => {
  test("name, aliases, summary, hidden and deprecated agree", async () => {
    for (const descriptor of registry.all()) {
      const command = await descriptor.load();
      const declared = descriptor.meta;
      const actual = command.meta;

      expect(actual.name).toBe(declared.name);
      expect(actual.aliases ?? []).toEqual(declared.aliases ?? []);
      expect(Boolean(actual.hidden)).toBe(Boolean(declared.hidden));
      expect(actual.deprecated ?? null).toBe(declared.deprecated ?? null);
      expect(actual.summary).toBe(declared.summary);
    }
  });

  test("every command group exposes at least one subcommand", async () => {
    for (const descriptor of registry.all()) {
      const command = await descriptor.load();
      if (isCommandGroup(command)) {
        expect(command.subcommands.length).toBeGreaterThan(0);
        for (const sub of command.subcommands) {
          expect(sub.meta.name.length).toBeGreaterThan(0);
          expect(sub.meta.summary.length).toBeGreaterThan(0);
        }
      }
    }
  });
});

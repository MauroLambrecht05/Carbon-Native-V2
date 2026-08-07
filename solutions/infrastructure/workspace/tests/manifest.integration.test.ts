// Loading a carbon.toml off disk, and rejecting the ones that are wrong.
//
// Crosses contracts (the manifest rules and the backend registry) ->
// infrastructure (the TOML reader). The rules themselves are pure and could be
// unit tested against a literal; what this covers is that the reader hands
// them the right thing, and that a bad manifest fails with a message an app
// author can act on rather than a parser stack trace.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TomlManifestRepository } from "../index.ts";

let root: string;
const repository = new TomlManifestRepository();

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "carbon-manifest-"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A project directory containing exactly this carbon.toml. */
function project(name: string, toml: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "carbon.toml"), toml);
  return dir;
}

describe("loading a manifest", () => {
  test("a minimal manifest is valid — [app] alone is common", () => {
    const dir = project("minimal", `[app]\nname = "hello"\nversion = "0.1.0"\n`);

    const config = repository.load(dir);

    expect(config.app.name).toBe("hello");
    expect(config.app.version).toBe("0.1.0");
    // An absent backend means the default, not an error.
    expect(config.runtime.backend).toBe("mini");
    expect(config.runtime.bytecode).toBe(false);
  });

  test("runtime flags are read", () => {
    const dir = project("flags", `
[app]
name = "flags"
version = "1.0.0"

[runtime]
backend = "mini"
bytecode = true
image = true
`);

    const config = repository.load(dir);
    expect(config.runtime.bytecode).toBe(true);
    expect(config.runtime.image).toBe(true);
    expect(config.runtime.audio).toBe(false);
  });

  test("sections the toolchain does not model are passed through untouched", () => {
    const dir = project("passthrough", `
[app]
name = "passthrough"
version = "1.0.0"

[window]
title = "Hello"
width = 800
`);

    // window/capabilities/plugins belong to the runtime; the toolchain must
    // not drop them just because it has no field for them.
    const raw = repository.load(dir).raw as Record<string, any>;
    expect(raw.window.title).toBe("Hello");
    expect(raw.window.width).toBe(800);
  });

  test("the deprecated backend alias still resolves", () => {
    const dir = project("alias", `
[app]
name = "alias"
version = "1.0.0"

[runtime]
backend = "mini-blitz"
`);

    // Manifests in the wild have this written into them.
    expect(repository.load(dir).runtime.backend).toBe("blitz");
  });
});

describe("rejecting a bad manifest", () => {
  test("a missing manifest says how to create one", () => {
    expect(() => repository.load(join(root, "nothing-here"))).toThrow(/carbon init/);
  });

  test("[app] without a name is rejected", () => {
    const dir = project("noname", `[app]\nversion = "1.0.0"\n`);
    expect(() => repository.load(dir)).toThrow(/requires "name" and "version"/);
  });

  test("an unknown backend names the ones that exist", () => {
    const dir = project("badbackend", `
[app]
name = "bad"
version = "1.0.0"

[runtime]
backend = "webgpu"
`);
    expect(() => repository.load(dir)).toThrow(/is not one of/);
  });

  test("an enabled updater without a pubkey is rejected", () => {
    const dir = project("nopubkey", `
[app]
name = "nopubkey"
version = "1.0.0"

[updater]
enabled = true
`);
    // Shipping an updater that trusts nothing is worse than shipping none.
    expect(() => repository.load(dir)).toThrow(/carbon signer generate/);
  });

  test("unparseable TOML reports the file, not a stack trace", () => {
    const dir = project("broken", `[app\nname =`);
    expect(() => repository.load(dir)).toThrow(/parse error/);
  });
});

describe("locating a manifest", () => {
  test("exists() is false without one, true with", () => {
    const empty = join(root, "empty-dir");
    mkdirSync(empty, { recursive: true });
    expect(repository.exists(empty)).toBe(false);

    const dir = project("present", `[app]\nname = "p"\nversion = "1.0.0"\n`);
    expect(repository.exists(dir)).toBe(true);
  });

  test("pathFor names the file whether or not it is there", () => {
    expect(repository.pathFor("/some/project")).toMatch(/carbon\.toml$/);
  });
});

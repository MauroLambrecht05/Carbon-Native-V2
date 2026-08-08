// The schema is the source of truth for carbon.toml. Two parsers implement it:
// the TypeScript loader in shared/logic/ts/src/config.ts and the Rust parser in
// shared/logic/core/src/config.rs. Nothing stops those three from drifting except
// this file.
//
// It checks the things that actually broke before: a default backend that had
// been archived, a backend list the CLI accepted but no directory existed for,
// and defaults that disagreed between the two parsers.

import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { CARBON_ROOT, backendCrateDir } from "@carbon/workspace";
import {
  BACKENDS,
  BACKEND_NAMES,
  DEFAULT_BACKEND,
  normalizeBackend,
} from "@carbon/contracts/app/backend";
import { loadCarbonConfig } from "@carbon/workspace";
import { ConfigError } from "@carbon/contracts/app/errors";
import { projectFixture } from "@carbon/testing";

const schema = JSON.parse(
  readFileSync(new URL("../schema/carbon.schema.json", import.meta.url), "utf8"),
);
// The Rust rendering is a sibling now — this contract holds all three
// (schema/, types/, rust/), which is the whole point of the test: it checks
// they agree.
const rustConfig = readFileSync(
  new URL("../rust/config.rs", import.meta.url),
  "utf8",
);

describe("schema ↔ backend registry", () => {
  test("schema's backend enum matches the registry exactly", () => {
    const fromSchema = schema.properties.runtime.properties.backend.enum;
    expect([...fromSchema].sort()).toEqual([...BACKEND_NAMES].sort());
  });

  test("schema's default backend matches the registry default", () => {
    expect(schema.properties.runtime.properties.backend.default).toBe(DEFAULT_BACKEND);
  });

  test("every registered backend has a native crate on disk", () => {
    // This is the check that would have caught `webview2`, `verso` and `term`
    // still being offered by the CLI after they were archived.
    for (const name of BACKEND_NAMES) {
      const manifest = join(backendCrateDir(name), "Cargo.toml");
      expect(existsSync(manifest)).toBe(true);
    }
  });

  test("each backend's declared crate name matches its Cargo.toml", () => {
    for (const name of BACKEND_NAMES) {
      const manifest = readFileSync(
        join(backendCrateDir(name), "Cargo.toml"),
        "utf8",
      );
      expect(manifest).toMatch(new RegExp(`^name = "${BACKENDS[name].crate}"`, "m"));
    }
  });
});

describe("schema ↔ Rust parser", () => {
  test("Rust's default backend matches the schema", () => {
    const m = rustConfig.match(/fn default_backend\(\) -> String \{\s*"([^"]+)"/);
    expect(m).not.toBeNull();
    expect(m![1]).toBe(DEFAULT_BACKEND);
  });

  test("every [runtime] boolean in the schema exists in the Rust struct", () => {
    const props = schema.properties.runtime.properties;
    for (const [key, def] of Object.entries<any>(props)) {
      if (def.type !== "boolean") continue;
      expect(rustConfig).toContain(`pub ${key}: bool`);
    }
  });

  test("every required [app] field in the schema exists in the Rust struct", () => {
    for (const key of schema.properties.app.required) {
      expect(rustConfig).toMatch(new RegExp(`pub ${key}: String`));
    }
  });
});

describe("TypeScript loader", () => {
  test("an [app]-only manifest is valid and gets the default backend", () => {
    const p = projectFixture();
    try {
      p.file("carbon.toml", `[app]\nname = "x"\nversion = "1.0.0"\n`);
      const cfg = loadCarbonConfig(p.path);
      expect(cfg.runtime.backend).toBe(DEFAULT_BACKEND);
      expect(cfg.runtime.bytecode).toBe(false);
      expect(cfg.runtime.image).toBe(false);
      expect(cfg.runtime.audio).toBe(false);
    } finally {
      p.dispose();
    }
  });

  test("a missing manifest names the file and suggests `carbon init`", () => {
    const p = projectFixture();
    try {
      require("node:fs").rmSync(join(p.path, "carbon.toml"));
      expect(() => loadCarbonConfig(p.path)).toThrow(/carbon\.toml/);
      expect(() => loadCarbonConfig(p.path)).toThrow(/carbon init/);
    } finally {
      p.dispose();
    }
  });

  test("an unknown backend is rejected and lists the valid ones", () => {
    const p = projectFixture({ backend: "webview2" });
    try {
      expect(() => loadCarbonConfig(p.path)).toThrow(ConfigError);
      expect(() => loadCarbonConfig(p.path)).toThrow(/mini/);
    } finally {
      p.dispose();
    }
  });

  test("[app] without a version is rejected", () => {
    const p = projectFixture();
    try {
      p.file("carbon.toml", `[app]\nname = "x"\n`);
      expect(() => loadCarbonConfig(p.path)).toThrow(/version/);
    } finally {
      p.dispose();
    }
  });

  test("an enabled [updater] without a pubkey is rejected", () => {
    // Shipping an app whose updater cannot verify signatures is worse than
    // shipping one with no updater at all, so this fails the build.
    const p = projectFixture({
      extraToml: `\n[updater]\nenabled = true\nurl = "https://example.com/feed"\n`,
    });
    try {
      expect(() => loadCarbonConfig(p.path)).toThrow(/pubkey/);
    } finally {
      p.dispose();
    }
  });

  test("legacy backend name `mini-blitz` still resolves", () => {
    // Manifests in the wild predate the runtime/ move. Breaking them would be
    // a silent failure for anyone upgrading.
    expect(normalizeBackend("mini-blitz")).toBe("blitz");
    const p = projectFixture({ backend: "mini-blitz" });
    try {
      expect(loadCarbonConfig(p.path).runtime.backend).toBe("blitz");
    } finally {
      p.dispose();
    }
  });
});

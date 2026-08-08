// Tests for @carbon/vite/dev.
// Run with: bun test packages/carbon-vite-plugin-dev

import { describe, test, expect } from "bun:test";
import { carbonDev } from "@carbon/vite/dev";

function makePlugin(opts = {}) {
  return carbonDev(opts);
}

const ENTRY = `
import { mount } from '@carbon/mini-solid';
mount(() => null);
`;

const NON_ENTRY = `
export function helper() { return 1; }
`;

function transform(plugin, code, id = "/project/src/app.tsx") {
  return plugin.transform?.(code, id);
}

describe("carbonDev plugin", () => {
  test("plugin name + enforce", () => {
    const p = makePlugin();
    expect(p.name).toBe("@carbon/vite/dev");
    expect(p.enforce).toBe("post");
  });

  describe("mode detection", () => {
    test("vite serve activates injection", () => {
      const p = makePlugin();
      p.configResolved({ command: "serve", root: "/proj" });
      const r = transform(p, ENTRY);
      expect(r).not.toBeNull();
      expect(r.code).toContain("__CARBON_DEV");
    });

    test("vite build with no env is a no-op", () => {
      // Snapshot + clear the env var so this test is deterministic.
      const prev = process.env.CARBON_DEV;
      delete process.env.CARBON_DEV;
      try {
        const p = makePlugin();
        p.configResolved({ command: "build", root: "/proj" });
        const r = transform(p, ENTRY);
        expect(r).toBeNull();
      } finally {
        if (prev !== undefined) process.env.CARBON_DEV = prev;
      }
    });

    test("vite build with CARBON_DEV=1 activates", () => {
      const prev = process.env.CARBON_DEV;
      process.env.CARBON_DEV = "1";
      try {
        const p = makePlugin();
        p.configResolved({ command: "build", root: "/proj" });
        const r = transform(p, ENTRY);
        expect(r).not.toBeNull();
      } finally {
        if (prev === undefined) delete process.env.CARBON_DEV;
        else process.env.CARBON_DEV = prev;
      }
    });

    test("forceMode='dev' overrides build", () => {
      const p = makePlugin({ forceMode: "dev" });
      p.configResolved({ command: "build", root: "/proj" });
      const r = transform(p, ENTRY);
      expect(r).not.toBeNull();
    });

    test("forceMode='prod' overrides serve", () => {
      const p = makePlugin({ forceMode: "prod" });
      p.configResolved({ command: "serve", root: "/proj" });
      const r = transform(p, ENTRY);
      expect(r).toBeNull();
    });
  });

  describe("entry detection", () => {
    test("non-entry files are not injected", () => {
      const p = makePlugin({ forceMode: "dev" });
      p.configResolved({ command: "serve", root: "/proj" });
      const r = transform(p, NON_ENTRY);
      expect(r).toBeNull();
    });

    test("only injects once even if multiple entry-like files", () => {
      const p = makePlugin({ forceMode: "dev" });
      p.configResolved({ command: "serve", root: "/proj" });
      const r1 = transform(p, ENTRY, "/proj/main.tsx");
      const r2 = transform(p, ENTRY, "/proj/other.tsx");
      expect(r1).not.toBeNull();
      expect(r2).toBeNull();
    });
  });

  describe("injected prelude", () => {
    test("includes __CARBON_DEV global", () => {
      const p = makePlugin({ forceMode: "dev" });
      p.configResolved({ command: "serve", root: "/proj" });
      const r = transform(p, ENTRY);
      expect(r.code).toContain("globalThis.__CARBON_DEV = true");
    });

    test("includes error overlay listeners", () => {
      const p = makePlugin({ forceMode: "dev" });
      p.configResolved({ command: "serve", root: "/proj" });
      const r = transform(p, ENTRY);
      expect(r.code).toContain("__carbon_dev_report");
      expect(r.code).toContain("unhandledrejection");
    });

    test("includes HMR helper", () => {
      const p = makePlugin({ forceMode: "dev" });
      p.configResolved({ command: "serve", root: "/proj" });
      const r = transform(p, ENTRY);
      expect(r.code).toContain("__carbon_hmr_register");
      expect(r.code).toContain("__carbon_hmr_dispatch");
    });

    test("can disable individual features", () => {
      const p = makePlugin({ forceMode: "dev", errorOverlay: false, hmr: false });
      p.configResolved({ command: "serve", root: "/proj" });
      const r = transform(p, ENTRY);
      expect(r.code).toContain("__CARBON_DEV");
      expect(r.code).not.toContain("__carbon_hmr_register");
      expect(r.code).not.toContain("__carbon_dev_report");
    });
  });

  describe("safety", () => {
    test("does not transform node_modules files", () => {
      const p = makePlugin({ forceMode: "dev" });
      p.configResolved({ command: "serve", root: "/proj" });
      const r = transform(p, ENTRY, "/proj/node_modules/foo/index.js");
      expect(r).toBeNull();
    });

    test("does not double-inject on second pass", () => {
      const p = makePlugin({ forceMode: "dev" });
      p.configResolved({ command: "serve", root: "/proj" });
      const r1 = transform(p, ENTRY);
      // Feed the injected output back through — should be detected via marker.
      const r2 = transform(p, r1.code, "/proj/main.tsx");
      expect(r2).toBeNull();
    });

    test("does not transform virtual modules", () => {
      const p = makePlugin({ forceMode: "dev" });
      p.configResolved({ command: "serve", root: "/proj" });
      const r = transform(p, ENTRY, "\0virtual:foo");
      expect(r).toBeNull();
    });
  });
});

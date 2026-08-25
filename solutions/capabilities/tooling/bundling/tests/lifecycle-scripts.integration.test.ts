// npm lifecycle-script lockdown, proved against a real `bun install`.
//
// This is deliberately NOT a mocked test. The thing being asserted is a
// property of bun itself — "a dependency's postinstall does not execute" — and
// a fake ProcessRunner can only prove which arguments we chose, never that the
// arguments have the effect we believe they have. So the test builds an actual
// npm package whose postinstall writes a marker file, packs it into an actual
// tarball, installs it with actual `bun install`, and looks for the marker on
// disk. If bun's behaviour ever changes under us, this fails; a mock would go
// on passing.
//
// Everything happens in a fresh temp directory OUTSIDE the workspace. Inside
// it, `file:` dependencies hit EPERM against the node_modules junction at the
// repository root (see scaffolding/infrastructure/templates/package-json.ts),
// and the point here is to test bun, not that junction.
//
// The marker is written to the postinstall's own cwd, which bun sets to the
// installed package's directory — verified, not assumed; the trusted case
// asserts the marker appears at exactly that path.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryLogger } from "@carbon/logging";
import { ensureNodeModules } from "../application/usecases/BuildProjectUseCase.ts";
import { installIsCurrent, installKey, writeInstallStamp } from "../infrastructure/InstallState.ts";

/** Unique per run, so nothing bun cached from a previous run can answer for it. */
const PROBE = `carbon-lifecycle-probe-${Date.now().toString(36)}`;
const MARKER = "carbon-lifecycle-marker.txt";

let root: string;
let tarball: string;

/** Runs a command to completion, returning its exit code and merged output. */
function sh(cmd: string[], cwd: string): { code: number; out: string } {
  const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  return {
    code: p.exitCode,
    out: `${p.stdout.toString()}${p.stderr.toString()}`,
  };
}

/**
 * Writes a host project depending on the probe tarball and installs it.
 * `trusted` is written verbatim as the `trustedDependencies` array.
 */
function installHost(name: string, trusted: string[]): { code: number; out: string; dir: string } {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(
      {
        name,
        version: "1.0.0",
        dependencies: { [PROBE]: `file:${tarball.replace(/\\/g, "/")}` },
        trustedDependencies: trusted,
      },
      null,
      2,
    ),
  );
  return { ...sh(["bun", "install"], dir), dir };
}

/** Where the probe's postinstall would write, if it ran. */
function markerPath(hostDir: string): string {
  return join(hostDir, "node_modules", PROBE, MARKER);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "carbon-lifecycle-"));
  const pkgDir = join(root, "probe-src");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify(
      {
        name: PROBE,
        version: "1.0.0",
        scripts: {
          // Stands in for the real attack: arbitrary code, the developer's own
          // privileges, at install time. Writing a file is the observable,
          // harmless equivalent of reading ~/.aws/credentials.
          postinstall: `node -e "require('fs').writeFileSync('${MARKER}', process.cwd())"`,
        },
      },
      null,
      2,
    ),
  );
  const packed = sh(["bun", "pm", "pack", "--destination", "..", "--quiet"], pkgDir);
  if (packed.code !== 0) throw new Error(`bun pm pack failed: ${packed.out}`);
  tarball = join(root, `${PROBE}-1.0.0.tgz`);
  if (!existsSync(tarball)) throw new Error(`packed tarball missing at ${tarball}: ${packed.out}`);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("dependency lifecycle scripts", () => {
  test(
    "an untrusted dependency's postinstall does not run",
    () => {
      const { code, out, dir } = installHost("untrusted-host", []);
      expect(code).toBe(0);

      // The install itself must have succeeded — otherwise "no marker" would
      // prove nothing, because nothing was installed at all.
      expect(existsSync(join(dir, "node_modules", PROBE, "package.json"))).toBe(true);

      // The actual security property.
      expect(existsSync(markerPath(dir))).toBe(false);

      // bun says so too, which is what a developer sees.
      expect(out).toContain("Blocked 1 postinstall");
    },
    120_000,
  );

  test(
    "the same dependency listed in trustedDependencies does run it",
    () => {
      // The negative case above is only meaningful if the probe's postinstall
      // is capable of running at all. This is that control.
      const { code, dir } = installHost("trusted-host", [PROBE]);
      expect(code).toBe(0);
      expect(existsSync(markerPath(dir))).toBe(true);
      // Written from the package's own directory, confirming where bun runs
      // lifecycle scripts from.
      expect(readFileSync(markerPath(dir), "utf8")).toContain(PROBE);
    },
    120_000,
  );

  test(
    "an empty array is not the same as omitting the field",
    () => {
      // The trap this whole change exists to avoid. bun ships a built-in
      // allowlist (`bun pm default-trusted`) that applies when the field is
      // ABSENT; declaring the field replaces that list rather than extending
      // it. A project that simply never mentions trustedDependencies is
      // therefore NOT locked down.
      // `bun pm` needs a package.json in cwd, so ask from inside a host.
      const { dir } = installHost("default-list-host", []);
      const listed = sh(["bun", "pm", "default-trusted"], dir);
      expect(listed.code).toBe(0);
      expect(listed.out).toContain("esbuild");
      // And the probe is not on it, so the negative test above is testing the
      // default-deny path rather than an accident of naming.
      expect(listed.out).not.toContain(PROBE);
    },
    120_000,
  );
});

describe("frozen lockfile", () => {
  test(
    "a package.json that disagrees with the lockfile is refused, not re-resolved",
    () => {
      const { dir } = installHost("frozen-host", []);
      expect(existsSync(join(dir, "bun.lock"))).toBe(true);

      // Add a dependency the lockfile has never seen. Without the flag bun
      // would happily resolve it — which is the silent-version-drift hole.
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      pkg.dependencies["is-number"] = "^7.0.0";
      writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2));

      const frozen = sh(["bun", "install", "--frozen-lockfile"], dir);
      expect(frozen.code).not.toBe(0);
      expect(frozen.out).toContain("lockfile is frozen");
    },
    120_000,
  );

  test(
    "the flag still works when the project has no lockfile yet",
    () => {
      // A freshly scaffolded project has none. If --frozen-lockfile refused
      // that, `carbon build` would break on every new project.
      const dir = join(root, "nolock-host");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify(
          { name: "nolock-host", version: "1.0.0", dependencies: {}, trustedDependencies: [] },
          null,
          2,
        ),
      );
      const r = sh(["bun", "install", "--frozen-lockfile"], dir);
      expect(r.code).toBe(0);
    },
    120_000,
  );
});

describe("ensureNodeModules, end to end", () => {
  // The production function itself, against a real registry-free project.
  // Everything above proves what bun does; this proves what carbon asks it to.
  function project(name: string, trusted: string[]): string {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify(
        {
          name,
          version: "1.0.0",
          dependencies: { [PROBE]: `file:${tarball.replace(/\\/g, "/")}` },
          trustedDependencies: trusted,
        },
        null,
        2,
      ),
    );
    return dir;
  }

  test(
    "first build installs, writes a lockfile, and runs no dependency script",
    async () => {
      const dir = project("ensure-first", []);
      const logger = new MemoryLogger();
      await ensureNodeModules(dir, logger);

      expect(existsSync(join(dir, "node_modules", PROBE, "package.json"))).toBe(true);
      // Not frozen on the first pass — there was no lockfile to freeze, and
      // refusing to write one would leave the project unpinned forever.
      expect(logger.text).toContain("bun install");
      expect(logger.text).not.toContain("--frozen-lockfile");
      expect(existsSync(join(dir, "bun.lock"))).toBe(true);
      // The lockdown still applies: the scaffolded `trustedDependencies: []`
      // is what stops the probe's postinstall, on the very first install.
      expect(existsSync(markerPath(dir))).toBe(false);
    },
    120_000,
  );

  test(
    "an unchanged project does not spawn bun again",
    async () => {
      const dir = join(root, "ensure-first");
      const logger = new MemoryLogger();
      await ensureNodeModules(dir, logger);
      expect(logger.lines).toEqual([]);
    },
    120_000,
  );

  test(
    "a package.json that drifted from the lockfile fails the build instead of re-resolving",
    async () => {
      // node_modules is present and looks fine. The old "install only if
      // node_modules is missing" rule would have sailed straight past this.
      const dir = join(root, "ensure-first");
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      pkg.dependencies["is-number"] = "^7.0.0";
      writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2));

      expect(ensureNodeModules(dir, new MemoryLogger())).rejects.toThrow(/frozen-lockfile/);
    },
    120_000,
  );
});

describe("install stamp", () => {
  // ensureNodeModules used to skip the install whenever node_modules existed,
  // which meant a changed package.json was never noticed and the lockfile was
  // never re-checked. The stamp is what lets it notice cheaply.
  test("a tree installed from the current package.json reads as current", () => {
    const { dir } = installHost("stamp-host", []);
    const key = installKey(dir);
    expect(installIsCurrent(dir, key)).toBe(false); // nothing stamped it yet
    writeInstallStamp(dir, key);
    expect(installIsCurrent(dir, key)).toBe(true);
  }, 120_000);

  test("editing package.json invalidates it", () => {
    const dir = join(root, "stamp-host");
    writeInstallStamp(dir, installKey(dir));
    const before = installKey(dir);

    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    pkg.dependencies["is-number"] = "^7.0.0";
    writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2));

    expect(installKey(dir)).not.toBe(before);
    expect(installIsCurrent(dir, installKey(dir))).toBe(false);
  });

  test("the lockfile is part of the key, so pulling a colleague's lockfile invalidates it", () => {
    const dir = join(root, "stamp-host");
    const key = installKey(dir);
    writeInstallStamp(dir, key);
    expect(installIsCurrent(dir, key)).toBe(true);

    const lock = join(dir, "bun.lock");
    writeFileSync(lock, `${readFileSync(lock, "utf8")}\n`);
    expect(installIsCurrent(dir, installKey(dir))).toBe(false);
  });
});

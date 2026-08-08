// @carbon/testing — helpers every suite in the repo can rely on.
//
// The point is that a test never hand-rolls a temp directory, a carbon.toml,
// or a CLI invocation. Those three things appear in almost every suite, and
// when each writes its own version they drift: one forgets to clean up, one
// writes a manifest missing a required field, one shells out with the wrong
// working directory and passes for the wrong reason.

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { CARBON_ROOT } from "@carbon/workspace";

const CLI_ENTRY = join(CARBON_ROOT, "tooling", "cli", "src", "main.ts");

/** A throwaway directory that deletes itself when `dispose()` is called. */
export interface TempDir {
  readonly path: string;
  file(relPath: string, contents: string): string;
  dispose(): void;
}

export function tempDir(prefix = "carbon-test-"): TempDir {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return {
    path,
    file(relPath, contents) {
      const p = join(path, relPath);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, contents, "utf8");
      return p;
    },
    dispose() {
      rmSync(path, { recursive: true, force: true });
    },
  };
}

export interface FixtureOptions {
  name?: string;
  version?: string;
  backend?: string;
  /** Extra TOML appended verbatim, for sections a test wants to exercise. */
  extraToml?: string;
  /** Additional files, keyed by path relative to the project root. */
  files?: Record<string, string>;
}

/**
 * A minimal but *valid* carbon project on disk. Valid matters: a fixture
 * missing a required manifest field makes a test fail for a reason unrelated
 * to what it is checking.
 */
export function projectFixture(opts: FixtureOptions = {}): TempDir {
  const {
    name = "test-app",
    version = "0.1.0",
    backend = "mini",
    extraToml = "",
    files = {},
  } = opts;

  const dir = tempDir(`carbon-${name}-`);
  dir.file(
    "carbon.toml",
    `[app]\nname = "${name}"\nversion = "${version}"\n\n[runtime]\nbackend = "${backend}"\n${extraToml}`,
  );
  dir.file("package.json", JSON.stringify({ name, version, type: "module" }, null, 2));
  dir.file(
    "App.tsx",
    `export default function App() {\n  return <view><text>hello</text></view>;\n}\n`,
  );
  for (const [rel, contents] of Object.entries(files)) dir.file(rel, contents);
  return dir;
}

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** stdout + stderr, ANSI stripped — what you usually want to assert on. */
  output: string;
}

/** Run the carbon CLI out of source and capture its output. */
export async function runCli(args: string[], cwd?: string): Promise<CliResult> {
  const proc = Bun.spawn(["bun", CLI_ENTRY, ...args], {
    cwd: cwd ?? CARBON_ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const strip = (s: string) => s.replace(/\[[0-9;]*m/g, "");
  return {
    exitCode,
    stdout: strip(stdout),
    stderr: strip(stderr),
    output: strip(stdout + stderr),
  };
}

/**
 * True when a runtime binary has been built. Suites that launch a backend
 * should skip rather than fail on a checkout that has not run `just build`.
 */
export function hasRuntimeBinary(crate = "carbon-mini"): boolean {
  const exe = process.platform === "win32" ? ".exe" : "";
  return ["dist", "release"].some((profile) =>
    existsSync(join(CARBON_ROOT, "target", profile, `${crate}${exe}`)),
  );
}

export { CARBON_ROOT, CLI_ENTRY };

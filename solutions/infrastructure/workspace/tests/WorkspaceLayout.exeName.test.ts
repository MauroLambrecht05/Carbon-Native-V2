// `sanitizeExeName` + the custom-name path through `distBinaryPath`/
// `resolveBackendBinary` — a real app's [app] name driving the built
// executable's filename, instead of it always staying `carbon-mini`/
// `carbon-blitz` regardless of what was built.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { distBinaryPath, resolveBackendBinary, sanitizeExeName } from "../adapters/WorkspaceLayout.ts";

describe("sanitizeExeName", () => {
  test("a plain identifier-shaped name passes through unchanged", () => {
    expect(sanitizeExeName("my-app")).toBe("my-app");
  });

  test("spaces are kept — Windows executable names allow them", () => {
    expect(sanitizeExeName("My Cool App")).toBe("My Cool App");
  });

  test("characters invalid in a Windows filename become dashes", () => {
    // [app] name isn't validated for filename-safety anywhere else —
    // validateManifest only checks it's present — so a project could
    // reasonably put a display-name-shaped string here.
    expect(sanitizeExeName("My/App:Name*?")).toBe("My-App-Name");
  });

  test("repeated invalid characters collapse to one dash", () => {
    expect(sanitizeExeName("My///App")).toBe("My-App");
  });

  test("leading and trailing dashes are trimmed", () => {
    expect(sanitizeExeName("/MyApp/")).toBe("MyApp");
  });

  test("a name that sanitizes to nothing falls back to \"app\"", () => {
    expect(sanitizeExeName("////")).toBe("app");
    expect(sanitizeExeName("")).toBe("app");
  });
});

describe("distBinaryPath with a custom exe name", () => {
  test("uses the sanitized name instead of the crate name when given", () => {
    const p = distBinaryPath(join("proj"), "mini", "My Cool App");
    expect(p.endsWith(join("dist", process.platform === "win32" ? "My Cool App.exe" : "My Cool App"))).toBe(true);
  });

  test("falls back to the crate name when no exeName is given — unchanged for every existing caller", () => {
    const p = distBinaryPath(join("proj"), "mini");
    expect(p.endsWith(join("dist", process.platform === "win32" ? "carbon-mini.exe" : "carbon-mini"))).toBe(true);
  });
});

describe("resolveBackendBinary with a custom exe name", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "carbon-exename-"));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("finds the app-named binary when it exists", () => {
    const projectDir = join(root, "named");
    mkdirSync(join(projectDir, "dist"), { recursive: true });
    const exe = process.platform === "win32" ? "My App.exe" : "My App";
    writeFileSync(join(projectDir, "dist", exe), "fake binary");

    const found = resolveBackendBinary("mini", projectDir, "My App");
    expect(found).toBe(join(projectDir, "dist", exe));
  });

  test("falls back to the crate-named binary when no app-named one exists — a release build made before this feature existed still resolves", () => {
    const projectDir = join(root, "legacy");
    mkdirSync(join(projectDir, "dist"), { recursive: true });
    const exe = process.platform === "win32" ? "carbon-mini.exe" : "carbon-mini";
    writeFileSync(join(projectDir, "dist", exe), "fake binary");

    const found = resolveBackendBinary("mini", projectDir, "My App");
    expect(found).toBe(join(projectDir, "dist", exe));
  });

  test("prefers the app-named binary over the crate-named one when both exist", () => {
    const projectDir = join(root, "both");
    mkdirSync(join(projectDir, "dist"), { recursive: true });
    const namedExe = process.platform === "win32" ? "My App.exe" : "My App";
    const crateExe = process.platform === "win32" ? "carbon-mini.exe" : "carbon-mini";
    writeFileSync(join(projectDir, "dist", namedExe), "fake binary");
    writeFileSync(join(projectDir, "dist", crateExe), "fake binary");

    const found = resolveBackendBinary("mini", projectDir, "My App");
    expect(found).toBe(join(projectDir, "dist", namedExe));
  });
});

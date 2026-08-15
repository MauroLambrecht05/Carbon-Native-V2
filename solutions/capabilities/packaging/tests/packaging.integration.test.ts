// Generating installer definitions.
//
// The first tests this capability has had. It arrived from V1 as five
// generators nothing called — `carbon bundle` reported what it would do and did
// nothing — so there was no way in to test through.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CarbonConfig } from "@carbon/contracts/app";
import {
  GeneratePackageUseCase,
  NodePackageWriter,
  UnknownTargetError,
  WrongPlatformError,
  type PackageWriter,
} from "../index.ts";

const config: CarbonConfig = {
  app: { name: "demo", version: "1.2.3", display_name: "Demo App" },
  runtime: { backend: "mini", bytecode: false, image: false, audio: false },
  raw: {},
};

/** Records writes without touching a disk. */
class MemoryWriter implements PackageWriter {
  readonly files = new Map<string, string>();
  readonly dirs: string[] = [];
  createDirectory(path: string): void {
    this.dirs.push(path);
  }
  writeFile(path: string, contents: string): void {
    this.files.set(path, contents);
  }
  copyFile(): void {}
  makeExecutable(): void {}
}

function useCase(writer: PackageWriter = new MemoryWriter()) {
  return new GeneratePackageUseCase(writer);
}

describe("every target produces a definition", () => {
  const cases: Array<[string, NodeJS.Platform, string]> = [
    ["nsis", "win32", "installer.nsi"],
    ["wix", "win32", "installer.wxs"],
    ["dmg", "darwin", "create-dmg.sh"],
    ["appimage", "linux", "AppRun"],
    ["deb", "linux", "control"],
  ];

  for (const [target, platform, filename] of cases) {
    test(`${target} writes ${filename}`, async () => {
      const writer = new MemoryWriter();
      const result = await useCase(writer).execute({
        target,
        config,
        binaryPath: "/build/carbon-mini",
        outputDir: "/out",
        platform,
      });

      // The filename is not cosmetic: `makensis installer.nsi` and
      // `dpkg-deb` reading DEBIAN/control both expect these exact names.
      expect(result.path).toBe(`/out/${target}/${filename}`);
      expect(writer.files.has(result.path)).toBe(true);
      expect(result.bytes).toBeGreaterThan(0);
    });

    test(`${target} gets its own directory`, async () => {
      // dmg and appimage emit more than one file in a full setup; a flat
      // output directory would collide.
      const writer = new MemoryWriter();
      await useCase(writer).execute({
        target, config, binaryPath: "/b", outputDir: "/out", platform,
      });
      expect(writer.dirs).toContain(`/out/${target}`);
    });

    test(`${target} carries the app's name and version`, async () => {
      const writer = new MemoryWriter();
      const r = await useCase(writer).execute({
        target, config, binaryPath: "/b", outputDir: "/out", platform,
      });
      const contents = writer.files.get(r.path)!;
      expect(contents).toContain("1.2.3");
      // display_name wins over name where the format has a human-facing field.
      expect(contents.includes("Demo App") || contents.includes("demo")).toBe(true);
    });
  }
});

describe("refusals", () => {
  test("an unknown target is refused", async () => {
    await expect(
      useCase().execute({ target: "snap", config, binaryPath: "/b", outputDir: "/o" }),
    ).rejects.toThrow(UnknownTargetError);
  });

  test("a target cannot be built on the wrong platform", async () => {
    // Cross-building is not supported: each installer needs its own
    // platform's toolchain. This is the check that used to be inline and
    // wrong — it compared a normalised platform name against a raw one, so
    // `--target dmg` was unreachable even on a Mac.
    await expect(
      useCase().execute({
        target: "dmg", config, binaryPath: "/b", outputDir: "/o", platform: "linux",
      }),
    ).rejects.toThrow(WrongPlatformError);
  });

  test("the refusal names both the target's platform and the host's", async () => {
    // `.catch(e => e)` types as `Error | Result` because the promise can also
    // resolve — assert the rejection instead, which is what is meant anyway.
    let message = "";
    try {
      await useCase().execute({
        target: "nsis", config, binaryPath: "/b", outputDir: "/o", platform: "linux",
      });
      throw new Error("expected a WrongPlatformError");
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toContain("win32");
    expect(message).toContain("linux");
  });
});

describe("writing to a real filesystem", () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "carbon-packaging-"));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("the definition lands on disk and is readable", async () => {
    const result = await new GeneratePackageUseCase(new NodePackageWriter()).execute({
      target: "nsis",
      config,
      binaryPath: join(root, "carbon-mini.exe"),
      outputDir: root,
      platform: "win32",
    });

    expect(existsSync(result.path)).toBe(true);
    const written = readFileSync(result.path, "utf8");
    expect(written.length).toBe(result.bytes);
    expect(written).toContain("Demo App");
  });
});

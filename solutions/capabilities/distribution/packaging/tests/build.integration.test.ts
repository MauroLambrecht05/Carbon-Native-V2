// Building a real installer from a generated definition. Every installer
// target has a real builder now: deb/appimage (Linux), nsis/wix (Windows),
// dmg (macOS).

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { CarbonConfig } from "@carbon/contracts/app";
import type { ProcessOptions, ProcessResult, ProcessRunner } from "@carbon/process";
import {
  BuildPackageUseCase,
  UnknownTargetError,
  WrongPlatformError,
  type PackageWriter,
} from "../index.ts";

const config: CarbonConfig = {
  app: { name: "demo", version: "1.2.3", display_name: "Demo App" },
  runtime: { backend: "mini", bytecode: false, image: false, audio: false },
  raw: {},
};

/** Records writes and invocations without touching a disk or a toolchain. */
class MemoryWriter implements PackageWriter {
  readonly files = new Map<string, string>();
  readonly dirs: string[] = [];
  readonly copies: Array<[string, string]> = [];
  readonly executable: string[] = [];
  createDirectory(path: string): void {
    this.dirs.push(path);
  }
  writeFile(path: string, contents: string): void {
    this.files.set(path, contents);
  }
  copyFile(from: string, to: string): void {
    this.copies.push([from, to]);
  }
  makeExecutable(path: string): void {
    this.executable.push(path);
  }
}

class FakeProcessRunner implements ProcessRunner {
  readonly calls: Array<{ command: string; args: string[]; options?: ProcessOptions }> = [];
  constructor(private readonly result: ProcessResult = { code: 0, signal: null }) {}
  async run(command: string, args: string[], options?: ProcessOptions): Promise<ProcessResult> {
    this.calls.push({ command, args, options });
    return this.result;
  }
}

function useCase(writer = new MemoryWriter(), runner = new FakeProcessRunner()) {
  return { useCase: new BuildPackageUseCase(writer, runner), writer, runner };
}

describe("deb", () => {
  test("materializes the package tree and invokes dpkg-deb", async () => {
    const { useCase: uc, writer, runner } = useCase();
    const result = await uc.execute({
      target: "deb",
      config,
      binaryPath: "/build/carbon-mini",
      dir: "/out/deb",
      platform: "linux",
    });

    expect(writer.files.has("/out/deb/pkgroot/DEBIAN/control")).toBe(true);
    expect(writer.executable).toContain("/out/deb/pkgroot/DEBIAN/postinst");
    expect(writer.copies).toContainEqual(["/build/carbon-mini", "/out/deb/pkgroot/usr/lib/carbon/demo"]);
    expect(writer.executable).toContain("/out/deb/pkgroot/usr/lib/carbon/demo");

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]!.command).toBe("dpkg-deb");
    expect(runner.calls[0]!.args).toEqual([
      "--build",
      "--root-owner-group",
      "/out/deb/pkgroot",
      "/out/deb/demo_1.2.3_amd64.deb",
    ]);

    expect(result.outputPath).toBe("/out/deb/demo_1.2.3_amd64.deb");
  });

  test("a nonzero dpkg-deb exit is a refusal, not a silent success", async () => {
    const { useCase: uc } = useCase(new MemoryWriter(), new FakeProcessRunner({ code: 2, signal: null }));
    await expect(
      uc.execute({ target: "deb", config, binaryPath: "/b", dir: "/out/deb", platform: "linux" }),
    ).rejects.toThrow("dpkg-deb exited with code 2");
  });
});

describe("appimage", () => {
  test("materializes the AppDir and invokes appimagetool", async () => {
    const { useCase: uc, writer, runner } = useCase();
    const result = await uc.execute({
      target: "appimage",
      config,
      binaryPath: "/build/carbon-mini",
      dir: "/out/appimage",
      platform: "linux",
    });

    expect(writer.copies).toContainEqual([
      "/build/carbon-mini",
      "/out/appimage/Demo App.AppDir/usr/bin/launcher",
    ]);
    expect(writer.executable).toContain("/out/appimage/Demo App.AppDir/usr/bin/launcher");
    expect(writer.executable).toContain("/out/appimage/Demo App.AppDir/AppRun");
    expect(writer.files.has("/out/appimage/Demo App.AppDir/Demo App.desktop")).toBe(true);

    expect(runner.calls[0]!.command).toBe("appimagetool");
    expect(result.outputPath).toBe("/out/appimage/Demo App-1.2.3.AppImage");
  });
});

describe("nsis", () => {
  test("copies the binary beside the script and invokes makensis", async () => {
    const { useCase: uc, writer, runner } = useCase();
    const result = await uc.execute({
      target: "nsis",
      config,
      binaryPath: "/build/carbon-mini.exe",
      dir: "/out/nsis",
      platform: "win32",
    });

    expect(writer.files.has("/out/nsis/installer.nsi")).toBe(true);
    expect(writer.copies).toContainEqual([
      "/build/carbon-mini.exe",
      join("/out/nsis", "carbon-mini.exe"),
    ]);
    expect(runner.calls[0]!.command).toBe("makensis");
    expect(runner.calls[0]!.args).toEqual(["/out/nsis/installer.nsi"]);
    expect(result.outputPath).toBe("/out/nsis/Demo App-1.2.3-setup.exe");
  });
});

describe("wix", () => {
  test("copies the binary beside the wxs and invokes wix build", async () => {
    const { useCase: uc, writer, runner } = useCase();
    const result = await uc.execute({
      target: "wix",
      config,
      binaryPath: "/build/carbon-mini.exe",
      dir: "/out/wix",
      platform: "win32",
    });

    expect(writer.files.has("/out/wix/installer.wxs")).toBe(true);
    expect(writer.copies).toContainEqual([
      "/build/carbon-mini.exe",
      join("/out/wix", "carbon-mini.exe"),
    ]);
    expect(runner.calls[0]!.command).toBe("wix");
    expect(result.outputPath).toBe("/out/wix/Demo App-1.2.3.msi");
  });
});

describe("dmg", () => {
  test("assembles a real .app bundle around the binary before writing the appdmg spec", async () => {
    const { useCase: uc, writer, runner } = useCase();
    const result = await uc.execute({
      target: "dmg",
      config,
      binaryPath: "/build/carbon-mini",
      dir: "/out/dmg",
      platform: "darwin",
    });

    expect(writer.dirs).toContain("/out/dmg/Demo App.app/Contents/MacOS");
    expect(writer.dirs).toContain("/out/dmg/Demo App.app/Contents/Resources");
    expect(writer.copies).toContainEqual([
      "/build/carbon-mini",
      "/out/dmg/Demo App.app/Contents/MacOS/demo",
    ]);
    expect(writer.executable).toContain("/out/dmg/Demo App.app/Contents/MacOS/demo");

    const plist = writer.files.get("/out/dmg/Demo App.app/Contents/Info.plist");
    expect(plist).toContain("<key>CFBundleExecutable</key>\n\t<string>demo</string>");
    expect(plist).toContain("<key>CFBundleIdentifier</key>\n\t<string>com.carbon.demo</string>");
    expect(plist).toContain("<key>CFBundleVersion</key>\n\t<string>1.2.3</string>");

    // The dmg's spec.json must point at the .app bundle, not the loose
    // binary — that's the whole point of assembling one first.
    const spec = JSON.parse(writer.files.get("/out/dmg/spec.json")!) as {
      contents: Array<{ path: string }>;
    };
    expect(spec.contents[0]!.path).toBe("/out/dmg/Demo App.app");

    expect(runner.calls[0]!.command).toBe("appdmg");
    expect(runner.calls[0]!.args).toEqual(["/out/dmg/spec.json", "/out/dmg/Demo App-1.2.3.dmg"]);
    expect(result.outputPath).toBe("/out/dmg/Demo App-1.2.3.dmg");
  });
});

describe("refusals", () => {
  test("an unknown target is refused", async () => {
    const { useCase: uc } = useCase();
    await expect(
      uc.execute({ target: "snap", config, binaryPath: "/b", dir: "/o" }),
    ).rejects.toThrow(UnknownTargetError);
  });

  test("a target cannot be built on the wrong platform", async () => {
    const { useCase: uc } = useCase();
    await expect(
      uc.execute({ target: "deb", config, binaryPath: "/b", dir: "/o", platform: "win32" }),
    ).rejects.toThrow(WrongPlatformError);
  });
});

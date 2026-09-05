import { describe, expect, test, afterEach } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ScaffolderEngine } from "../infrastructure/services/ScaffolderEngine.ts";

describe("ScaffolderEngine", () => {
  const scaffolder = ScaffolderEngine.getInstance();
  const testDir = join(tmpdir(), `carbon_test_scaffold_${Date.now()}`);

  afterEach(async () => {
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {}
  });

  test("scaffolds tray-daemon template into target directory", async () => {
    const res = await scaffolder.scaffold({
      templateId: "tray-daemon",
      targetDir: testDir,
      appName: "tray-assistant",
    });

    expect(res.templateName).toBe("System Tray Daemon");
    expect(res.createdFiles.length).toBeGreaterThanOrEqual(3);

    // Verify carbon.toml
    const tomlFile = Bun.file(join(testDir, "carbon.toml"));
    expect(await tomlFile.exists()).toBe(true);
    const tomlContent = await tomlFile.text();
    expect(tomlContent).toContain('name = "tray-assistant"');

    // Verify src/main.ctsx
    const ctsxFile = Bun.file(join(testDir, "src", "main.ctsx"));
    expect(await ctsxFile.exists()).toBe(true);
    const ctsxContent = await ctsxFile.text();
    expect(ctsxContent).toContain('title="tray-assistant"');
  });

  test("throws error for non-existent template ID", async () => {
    expect(
      scaffolder.scaffold({
        templateId: "non-existent-template-id",
        targetDir: testDir,
        appName: "bad-app",
      }),
    ).rejects.toThrow("Available templates:");
  });
});

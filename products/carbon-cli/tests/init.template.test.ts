import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { InitCommand } from "../presentation/commands/project/init.command.ts";

describe("InitCommand Templates Integration", () => {
  const initCmd = new InitCommand();
  const testDir = join(tmpdir(), `carbon_test_init_tmpl_${Date.now()}`);

  afterEach(async () => {
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {}
  });

  test("declares template and list-templates flags", () => {
    const flagNames = initCmd.meta.flags?.map((f) => f.name) || [];
    expect(flagNames).toContain("template");
    expect(flagNames).toContain("list-templates");
  });

  test("executes list-templates cleanly", async () => {
    const lines: string[] = [];
    const mockCtx: any = {
      flags: new Map([["list-templates", true]]),
      argv: ["--list-templates"],
      io: {
        raw: (msg: string) => lines.push(msg),
        c: { bold: (s: string) => s, dim: (s: string) => s, green: (s: string) => s },
      },
    };

    const code = await initCmd.execute(mockCtx);
    expect(code).toBe(0);
    const combined = lines.join("\n");
    expect(combined).toContain("tray-daemon");
    expect(combined).toContain("database-studio");
  });

  test("scaffolds database-studio template using --template flag", async () => {
    const lines: string[] = [];
    const mockCtx: any = {
      flags: new Map([["template", "database-studio"]]),
      argv: ["test-studio", "--template=database-studio"],
      first: "test-studio",
      cwd: testDir,
      io: {
        success: (msg: string) => lines.push(msg),
        info: (msg: string) => lines.push(msg),
        raw: (msg: string) => lines.push(msg),
        c: { bold: (s: string) => s, dim: (s: string) => s, green: (s: string) => s },
      },
    };

    const code = await initCmd.execute(mockCtx);
    expect(code).toBe(0);

    const projectDir = join(testDir, "test-studio");
    const tomlFile = Bun.file(join(projectDir, "carbon.toml"));
    expect(await tomlFile.exists()).toBe(true);
    const content = await tomlFile.text();
    expect(content).toContain('name = "test-studio"');
  });
});

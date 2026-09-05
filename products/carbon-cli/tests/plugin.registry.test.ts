import { describe, expect, test } from "bun:test";
import { PluginCommand } from "../presentation/commands/plugins/plugin.command.ts";

describe("PluginCommand Registry Differentiator", () => {
  const pluginCmd = new PluginCommand();

  test("declares all subcommands including search, publish, and add", () => {
    const names = pluginCmd.subcommands.map((s) => s.meta.name);
    expect(names).toContain("add");
    expect(names).toContain("search");
    expect(names).toContain("publish");
    expect(names).toContain("new");
    expect(names).toContain("list");
  });

  test("search subcommand meta and validation", () => {
    const searchSub = pluginCmd.subcommands.find((s) => s.meta.name === "search")!;
    expect(searchSub).toBeDefined();
    expect(searchSub.meta.usage).toBe("plugin search [query]");

    // Validation without query passes (launches interactive TUI search panel)
    const mockCtxNoQuery: any = { first: undefined, args: [] };
    expect(searchSub.validate!(mockCtxNoQuery)).toBeNull();

    // Validation with query passes (direct search)
    const mockCtxWithQuery: any = { first: "audio", args: ["audio"] };
    expect(searchSub.validate!(mockCtxWithQuery)).toBeNull();
  });

  test("add subcommand examples contain @registry/ and @std/ prefixes", () => {
    const addSub = pluginCmd.subcommands.find((s) => s.meta.name === "add")!;
    expect(addSub).toBeDefined();
    const examples = addSub.meta.examples || [];
    expect(examples.some((e) => e.includes("@registry/"))).toBe(true);
    expect(examples.some((e) => e.includes("@std/"))).toBe(true);
  });

  test("search subcommand executes non-interactively without parameter", async () => {
    const searchSub = pluginCmd.subcommands.find((s) => s.meta.name === "search")!;
    const output: string[] = [];
    const mockCtx: any = {
      first: undefined,
      args: [],
      cwd: process.cwd(),
      io: {
        raw: (msg: string) => output.push(msg),
        info: (msg: string) => output.push(msg),
        error: (msg: string) => output.push(msg),
        isInteractive: () => false,
        c: {
          bold: (s: string) => s,
          dim: (s: string) => s,
          green: (s: string) => s,
          cyan: (s: string) => s,
          yellow: (s: string) => s,
        },
      },
    };

    const code = await searchSub.execute(mockCtx);
    expect(code).toBe(0);
    const joined = output.join("\n");
    expect(joined).toContain("Carbon Plugin Registry");
    expect(joined).toContain("@registry/clipboard");
    expect(joined).toContain("@registry/dialog");
  });

  test("search subcommand executes direct query search with parameter", async () => {
    const searchSub = pluginCmd.subcommands.find((s) => s.meta.name === "search")!;
    const output: string[] = [];
    const mockCtx: any = {
      first: "audio",
      args: ["audio"],
      cwd: process.cwd(),
      io: {
        raw: (msg: string) => output.push(msg),
        info: (msg: string) => output.push(msg),
        error: (msg: string) => output.push(msg),
        isInteractive: () => false,
        c: {
          bold: (s: string) => s,
          dim: (s: string) => s,
          green: (s: string) => s,
          cyan: (s: string) => s,
          yellow: (s: string) => s,
        },
      },
    };

    const code = await searchSub.execute(mockCtx);
    expect(code).toBe(0);
    const joined = output.join("\n");
    expect(joined).toContain("@registry/audio-player");
  });
});

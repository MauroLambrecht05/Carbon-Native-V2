import { describe, expect, test } from "bun:test";
import { activate, CarbonExtensionService } from "../src/extension.ts";
import snippetData from "../snippets/carbon.json";

describe("Carbon VS Code Extension", () => {
  const service = CarbonExtensionService.getInstance();

  test("snippets JSON contains required UI components", () => {
    expect(snippetData["Carbon App Boilerplate"]).toBeDefined();
    expect(snippetData["Carbon Window"]).toBeDefined();
    expect(snippetData["Carbon Titlebar"]).toBeDefined();
    expect(snippetData["Carbon VStack"]).toBeDefined();
    expect(snippetData["Carbon Button"]).toBeDefined();

    expect(snippetData["Carbon Window"].body.join(" ")).toContain("<Window");
    expect(snippetData["Carbon Button"].body.join(" ")).toContain("<Button");
  });

  test("extension service resolves default URLs", () => {
    expect(service.getStudioUrl()).toBe("http://localhost:54322");
    expect(service.getRegistryUrl()).toBe("http://localhost:54323");
    expect(service.getDatabaseUrl()).toBe("http://localhost:54321");
  });

  test("formats install command with @registry/ prefix", () => {
    const cmd = service.formatInstallCommand("bluetooth");
    expect(cmd).toBe("carbon plugin add @registry/bluetooth");
  });

  test("activation registers commands properly", () => {
    const { commands } = activate();
    expect(commands["carbon.openStudio"]).toBeDefined();
    expect(commands["carbon.openDatabase"]).toBeDefined();
    expect(commands["carbon.searchPlugins"]).toBeDefined();

    const studioRes = commands["carbon.openStudio"]();
    expect(studioRes.url).toBe("http://localhost:54322");

    const dbRes = commands["carbon.openDatabase"]();
    expect(dbRes.url).toBe("http://localhost:54321");
  });
});

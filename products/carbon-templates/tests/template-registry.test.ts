import { describe, expect, test } from "bun:test";
import { TemplateRegistry } from "../infrastructure/services/TemplateRegistry.ts";

describe("TemplateRegistry", () => {
  const registry = TemplateRegistry.getInstance();

  test("registers default starter templates", () => {
    const list = registry.list();
    expect(list.length).toBeGreaterThanOrEqual(4);

    const ids = list.map((t) => t.id);
    expect(ids).toContain("tray-daemon");
    expect(ids).toContain("database-studio");
    expect(ids).toContain("realtime-chat");
    expect(ids).toContain("audio-station");
  });

  test("each template contains carbon.toml and src/main.ctsx", () => {
    for (const t of registry.list()) {
      expect(t.files["carbon.toml"]).toBeDefined();
      expect(t.files["src/main.ctsx"]).toBeDefined();
      expect(t.files["carbon.toml"]).toContain("{{APP_NAME}}");
    }
  });

  test("retrieves template by ID", () => {
    const t = registry.get("tray-daemon");
    expect(t).toBeDefined();
    expect(t?.name).toBe("System Tray Daemon");
    expect(t?.category).toBe("desktop-utility");
  });
});

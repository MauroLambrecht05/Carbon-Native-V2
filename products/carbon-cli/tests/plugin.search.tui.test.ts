import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PLUGINS,
  fetchRegistryPlugins,
  visibleLength,
  padVisible,
  truncateVisible,
} from "../presentation/commands/plugins/plugin-search-tui.ts";

describe("Plugin Search TUI Engine", () => {
  test("DEFAULT_PLUGINS catalog contains verified standard plugins", () => {
    expect(DEFAULT_PLUGINS.length).toBeGreaterThanOrEqual(10);
    const names = DEFAULT_PLUGINS.map((p) => p.name);
    expect(names).toContain("clipboard");
    expect(names).toContain("dialog");
    expect(names).toContain("notification");
    expect(names).toContain("tray");
    expect(names).toContain("sqlite");
    expect(names).toContain("audio-player");
  });

  test("fetchRegistryPlugins falls back to catalog if offline", async () => {
    const { plugins, isLive } = await fetchRegistryPlugins("http://localhost:59999");
    expect(isLive).toBe(false);
    expect(plugins.length).toBe(DEFAULT_PLUGINS.length);
    expect(plugins.some((p) => p.name === "clipboard")).toBe(true);
  });

  test("ANSI-aware string utilities compute correct visible widths", () => {
    const raw = "\x1b[36m\x1b[1m@registry/clipboard\x1b[22m\x1b[39m";
    expect(visibleLength(raw)).toBe("@registry/clipboard".length);

    const padded = padVisible(raw, 30);
    expect(visibleLength(padded)).toBe(30);

    const truncated = truncateVisible("A very long description that needs to be truncated", 20);
    expect(visibleLength(truncated)).toBe(20);
    expect(truncated.endsWith("…")).toBe(true);
  });

  test("search filtering matches name, description, and tags", () => {
    const q = "audio";
    const matched = DEFAULT_PLUGINS.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q) ||
        p.category.toLowerCase().includes(q) ||
        p.tags.some((t) => t.toLowerCase().includes(q)),
    );
    expect(matched.length).toBeGreaterThan(0);
    expect(matched.some((p) => p.name === "audio-player")).toBe(true);
  });
});

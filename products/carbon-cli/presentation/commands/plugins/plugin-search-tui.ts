// Interactive TUI search panel for browsing, searching, and inspecting
// native plugins on the Carbon Plugin Registry.
//
// Designed with generous spacing, dedicated search box, and modern Unicode styling.

import {
  createInterface,
  emitKeypressEvents,
  cursorTo,
  clearScreenDown,
  type Key,
} from "node:readline";
import pc from "picocolors";
import type { CommandContext, ExitCode } from "@carbon/cli";
import { EXIT_OK } from "@carbon/cli";

export interface PluginInfo {
  name: string;
  category: string;
  description: string;
  latestVersion: string;
  downloads: number;
  verified: boolean;
  tags: string[];
}

/** Rich built-in catalog for instant offline use or when registry daemon is not running */
export const DEFAULT_PLUGINS: PluginInfo[] = [
  {
    name: "clipboard",
    category: "carbon-desktop",
    description: "Native OS clipboard reader and writer for text, HTML, and raster bitmaps.",
    latestVersion: "1.0.0",
    downloads: 840,
    verified: true,
    tags: ["clipboard", "desktop", "os", "text"],
  },
  {
    name: "dialog",
    category: "carbon-desktop",
    description: "Native operating system file picker, save prompts, and message alert dialogs.",
    latestVersion: "1.0.0",
    downloads: 720,
    verified: true,
    tags: ["dialog", "picker", "file", "modal"],
  },
  {
    name: "notification",
    category: "carbon-desktop",
    description: "Native OS toast notifications with action buttons, icons, and reply fields.",
    latestVersion: "1.1.0",
    downloads: 650,
    verified: true,
    tags: ["notifications", "toasts", "os", "desktop"],
  },
  {
    name: "tray",
    category: "carbon-desktop",
    description: "Taskbar and menu bar system tray icon with interactive context menus and background daemon support.",
    latestVersion: "1.0.2",
    downloads: 530,
    verified: true,
    tags: ["tray", "taskbar", "menubar", "daemon"],
  },
  {
    name: "keychain",
    category: "carbon-security",
    description: "Hardware-backed credential and cryptographic token storage (DPAPI, Keychain, Secret Service).",
    latestVersion: "1.0.0",
    downloads: 490,
    verified: true,
    tags: ["security", "keychain", "secrets", "passwords"],
  },
  {
    name: "sqlite",
    category: "carbon-dev",
    description: "High-performance embedded SQLite database engine with prepared statements and vector extensions.",
    latestVersion: "2.1.0",
    downloads: 910,
    verified: true,
    tags: ["database", "sql", "sqlite", "storage"],
  },
  {
    name: "audio-player",
    category: "carbon-media",
    description: "Hardware-accelerated native audio playback, buffer streaming, and waveform telemetry.",
    latestVersion: "1.0.0",
    downloads: 380,
    verified: true,
    tags: ["audio", "media", "playback", "sound"],
  },
  {
    name: "media",
    category: "carbon-media",
    description: "Audio and camera capture, device enumeration, and streaming video muxing.",
    latestVersion: "1.0.0",
    downloads: 420,
    verified: true,
    tags: ["media", "camera", "microphone", "capture"],
  },
  {
    name: "screencapture",
    category: "carbon-desktop",
    description: "Fast display and window screen recording with cursor capture and audio mixing.",
    latestVersion: "1.0.0",
    downloads: 310,
    verified: true,
    tags: ["screen", "recording", "capture", "display"],
  },
  {
    name: "accessibility",
    category: "carbon-desktop",
    description: "Assistive technologies integration, ARIA tree synchronization, and screen reader announcements.",
    latestVersion: "1.0.0",
    downloads: 270,
    verified: true,
    tags: ["accessibility", "a11y", "screen-reader"],
  },
  {
    name: "printing",
    category: "carbon-desktop",
    description: "Native cross-platform print spooler, page setup, and PDF document rendering.",
    latestVersion: "1.0.0",
    downloads: 190,
    verified: true,
    tags: ["print", "pdf", "document", "spooler"],
  },
  {
    name: "theme",
    category: "carbon-desktop",
    description: "Real-time system theme change detection (light/dark) and OS accent color extraction.",
    latestVersion: "1.0.0",
    downloads: 680,
    verified: true,
    tags: ["theme", "dark-mode", "accent-color", "os"],
  },
  {
    name: "logging",
    category: "carbon-dev",
    description: "Zero-allocation structured log multiplexer with file rotation and debug telemetry.",
    latestVersion: "1.0.0",
    downloads: 890,
    verified: true,
    tags: ["logging", "diagnostics", "telemetry", "dev"],
  },
];

export async function fetchRegistryPlugins(registryUrl: string): Promise<{ plugins: PluginInfo[]; isLive: boolean }> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`${registryUrl}/api/v1/plugins`, { signal: controller.signal });
    clearTimeout(timeout);

    if (res.ok) {
      const data = (await res.json()) as { plugins?: any[] };
      if (Array.isArray(data.plugins) && data.plugins.length > 0) {
        return {
          isLive: true,
          plugins: data.plugins.map((p) => ({
            name: p.name,
            category: p.category || "general",
            description: p.description || "",
            latestVersion: p.latestVersion || p.version || "1.0.0",
            downloads: typeof p.downloads === "number" ? p.downloads : 0,
            verified: Boolean(p.verified),
            tags: Array.isArray(p.tags) ? p.tags : [],
          })),
        };
      }
    }
  } catch {
    // Registry offline / unreachable — use default catalog
  }

  return { plugins: DEFAULT_PLUGINS, isLive: false };
}

// ── Text Formatting Utilities ──────────────────────────────────────────────

const ANSI_RE = /\x1b\[[0-9;]*m/g;
export function visibleLength(s: string): number {
  return s.replace(ANSI_RE, "").length;
}

export function padVisible(s: string, width: number): string {
  return s + " ".repeat(Math.max(0, width - visibleLength(s)));
}

export function padBetween(left: string, right: string, width: number): string {
  const space = Math.max(1, width - visibleLength(left) - visibleLength(right));
  return left + " ".repeat(space) + right;
}

export function truncateVisible(s: string, maxLen: number): string {
  if (visibleLength(s) <= maxLen) return s;
  const plain = s.replace(ANSI_RE, "");
  return plain.slice(0, Math.max(0, maxLen - 1)) + "…";
}

// ── Interactive TUI Engine ─────────────────────────────────────────────────

export async function runPluginSearchTui(
  plugins: PluginInfo[],
  isLive: boolean,
  _registryUrl: string,
): Promise<PluginInfo | null> {
  return new Promise((resolve) => {
    let query = "";
    let selectedIndex = 0;
    let scrollOffset = 0;
    let settled = false;

    const getFiltered = (): PluginInfo[] => {
      const q = query.trim().toLowerCase();
      if (!q) return plugins;
      return plugins.filter((p) => {
        return (
          p.name.toLowerCase().includes(q) ||
          p.description.toLowerCase().includes(q) ||
          p.category.toLowerCase().includes(q) ||
          p.tags.some((t) => t.toLowerCase().includes(q))
        );
      });
    };

    const getWidth = (): number => {
      const cols = process.stdout.columns ?? 80;
      return Math.max(60, Math.min(cols - 4, 88));
    };

    // Calculate visible capacity based on terminal height: each plugin gets generous 3 lines
    const getMaxVisibleItems = (): number => {
      const rows = process.stdout.rows ?? 24;
      return Math.max(3, Math.min(6, Math.floor((rows - 10) / 3)));
    };

    // Switch to alternate screen buffer and hide hardware cursor
    process.stdout.write("\x1b[?1049h");
    process.stdout.write("\x1b[?25l");

    const cleanup = () => {
      process.stdout.write("\x1b[?25h");
      process.stdout.write("\x1b[?1049l");
    };

    const finish = (result: PluginInfo | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      process.stdin.off("keypress", onKeypress);
      try {
        process.stdin.setRawMode(false);
      } catch {
        /* not a TTY */
      }
      resolve(result);
    };

    const render = () => {
      const filtered = getFiltered();
      const width = getWidth();
      const maxVisible = getMaxVisibleItems();

      // Clamp selection
      if (selectedIndex >= filtered.length) {
        selectedIndex = Math.max(0, filtered.length - 1);
      }
      if (selectedIndex < 0) {
        selectedIndex = 0;
      }

      // Adjust scroll offset window
      if (selectedIndex < scrollOffset) {
        scrollOffset = selectedIndex;
      } else if (selectedIndex >= scrollOffset + maxVisible) {
        scrollOffset = selectedIndex - maxVisible + 1;
      }
      if (scrollOffset > Math.max(0, filtered.length - maxVisible)) {
        scrollOffset = Math.max(0, filtered.length - maxVisible);
      }

      const visibleItems = filtered.slice(scrollOffset, scrollOffset + maxVisible);

      const lines: string[] = [];
      lines.push(""); // Generous top margin

      // ── 1. ACTUAL DEDICATED SEARCH BOX ─────────────────────────────────
      const searchBoxWidth = width;
      const cursorChar = pc.cyan("█");
      const searchLeft = query.length > 0
        ? `  ${pc.cyan("⌕")}  Search plugins: ${pc.bold(pc.white(query))}${cursorChar}`
        : `  ${pc.cyan("⌕")}  Search plugins: ${cursorChar} ${pc.dim("type to filter...")}`;

      const countBadge = query.trim()
        ? pc.dim(`${filtered.length} matching  `)
        : pc.dim(`${plugins.length} plugins  `);

      const boxContent = padBetween(searchLeft, countBadge, searchBoxWidth);

      lines.push(pc.cyan("  ╭" + "─".repeat(searchBoxWidth) + "╮"));
      lines.push(pc.cyan("  │") + boxContent + pc.cyan("│"));
      lines.push(pc.cyan("  ╰" + "─".repeat(searchBoxWidth) + "╯"));
      lines.push(""); // Generous whitespace below search box

      // ── 2. SECTION HEADER WITH SPECIAL UNICODE ─────────────────────────
      const liveDot = isLive ? pc.green("● connected") : pc.dim("○ local catalog");
      const headerLeft = `  ${pc.bold(pc.white("✦  CARBON PLUGIN REGISTRY"))}  ${pc.dim("·")} ${liveDot}`;
      const headerRight = filtered.length > 0
        ? pc.dim(`[ ${selectedIndex + 1} of ${filtered.length} ]`)
        : pc.dim("[ 0 results ]");

      lines.push(padBetween(headerLeft, headerRight, width + 4));
      lines.push(""); // Breathing room before items

      // ── 3. SPACIOUS PLUGIN LIST UNDER SEARCH BOX ───────────────────────
      if (scrollOffset > 0) {
        lines.push(`     ${pc.dim(`▲ ${scrollOffset} more above (use ↑ to scroll)`)}`);
        lines.push("");
      }

      if (visibleItems.length === 0) {
        lines.push(`     ${pc.yellow(`No plugins matching "${query}"`)}`);
        lines.push(`     ${pc.dim("Try another keyword or press Esc to clear search.")}`);
        lines.push("");
      } else {
        for (let i = 0; i < visibleItems.length; i++) {
          const item = visibleItems[i];
          const globalIdx = scrollOffset + i;
          const isSelected = globalIdx === selectedIndex;

          const verifiedBadge = item.verified ? pc.green("✓ verified") : "";
          const verBadge = pc.dim(`v${item.latestVersion}`);
          const catBadge = isSelected
            ? pc.yellow(`◆ ${item.category}`)
            : pc.dim(`◆ ${item.category}`);
          const dlBadge = pc.dim(`⬇ ${item.downloads}`);

          if (isSelected) {
            // Selected item: Prominent arrow, bright cyan name, badges, description, install hint
            const titleLine = `  ${pc.bold(pc.cyan("❯"))}  ${pc.bold(pc.cyan(`@registry/${item.name}`))}  ${verifiedBadge}  ${verBadge}  ${catBadge}  ${dlBadge}`;
            lines.push(titleLine);

            const descTrunc = truncateVisible(item.description, width - 4);
            lines.push(`     ${pc.white(descTrunc)}`);

            const installCmd = `carbon plugin add @registry/${item.name}`;
            lines.push(`     ${pc.dim("↳")} ${pc.bold(pc.green(installCmd))}`);
            lines.push(""); // Generous empty line after selected item
          } else {
            // Unselected item: Airy indent, clean metadata, and dim description
            const titleLine = `     ${pc.bold(pc.white(`@registry/${item.name}`))}  ${verifiedBadge}  ${verBadge}  ${catBadge}  ${dlBadge}`;
            lines.push(titleLine);

            const descTrunc = truncateVisible(item.description, width - 4);
            lines.push(`     ${pc.dim(descTrunc)}`);
            lines.push(""); // Generous empty line between items
          }
        }
      }

      const remainingBelow = filtered.length - (scrollOffset + maxVisible);
      if (remainingBelow > 0) {
        lines.push(`     ${pc.dim(`▼ ${remainingBelow} more below (use ↓ to scroll)`)}`);
        lines.push("");
      }

      // ── 4. FOOTER CONTROLS ─────────────────────────────────────────────
      lines.push(pc.dim("  " + "─".repeat(width)));
      lines.push(`  ${pc.dim("↑↓")} navigate  ${pc.dim("·")}  ${pc.dim("type")} filter  ${pc.dim("·")}  ${pc.dim("↵")} select & install  ${pc.dim("·")}  ${pc.dim("esc")} quit`);

      // Redraw frame from top of alternate buffer
      cursorTo(process.stdout, 0, 0);
      clearScreenDown(process.stdout);
      process.stdout.write(lines.join("\n") + "\n");
    };

    // Listen for keyboard interactions
    const onKeypress = (str: string, key: Key | undefined) => {
      // Exit on Ctrl+C
      if (key?.ctrl && key.name === "c") {
        finish(null);
        return;
      }

      // Navigation: Down Arrow, Ctrl+N, or j (when not actively typing text)
      if (key?.name === "down" || (key?.ctrl && key.name === "n")) {
        const filtered = getFiltered();
        if (filtered.length > 0) {
          selectedIndex = Math.min(filtered.length - 1, selectedIndex + 1);
          render();
        }
        return;
      }

      // Navigation: Up Arrow, Ctrl+P, or k
      if (key?.name === "up" || (key?.ctrl && key.name === "p")) {
        const filtered = getFiltered();
        if (filtered.length > 0) {
          selectedIndex = Math.max(0, selectedIndex - 1);
          render();
        }
        return;
      }

      // Page Navigation
      if (key?.name === "pagedown") {
        const filtered = getFiltered();
        if (filtered.length > 0) {
          selectedIndex = Math.min(filtered.length - 1, selectedIndex + getMaxVisibleItems());
          render();
        }
        return;
      }

      if (key?.name === "pageup") {
        selectedIndex = Math.max(0, selectedIndex - getMaxVisibleItems());
        render();
        return;
      }

      if (key?.name === "home") {
        selectedIndex = 0;
        render();
        return;
      }

      if (key?.name === "end") {
        const filtered = getFiltered();
        selectedIndex = Math.max(0, filtered.length - 1);
        render();
        return;
      }

      // Confirm selection: Enter / Return
      if (key?.name === "return") {
        const filtered = getFiltered();
        finish(filtered[selectedIndex] ?? null);
        return;
      }

      // Escape: clear query if present, otherwise exit
      if (key?.name === "escape") {
        if (query.length > 0) {
          query = "";
          selectedIndex = 0;
          render();
        } else {
          finish(null);
        }
        return;
      }

      // Backspace
      if (key?.name === "backspace") {
        if (query.length > 0) {
          query = query.slice(0, -1);
          selectedIndex = 0;
          render();
        }
        return;
      }

      // Clear with Ctrl+U
      if (key?.ctrl && key.name === "u") {
        query = "";
        selectedIndex = 0;
        render();
        return;
      }

      // Printable character typing
      if (str && !key?.ctrl && !key?.meta && str.length === 1 && str >= " ") {
        query += str;
        selectedIndex = 0;
        render();
      }
    };

    // Enable raw mode and keypress listeners
    try {
      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: true,
      });
      emitKeypressEvents(process.stdin, rl);
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on("keypress", onKeypress);

      // Handle stream termination
      rl.once("close", () => finish(null));

      // Initial render
      render();
    } catch {
      // Fallback if raw mode fails
      finish(null);
    }
  });
}

/** Entry point for the plugin search command */
export async function executePluginSearchTui(ctx: CommandContext, registryUrl: string): Promise<ExitCode> {
  const { plugins, isLive } = await fetchRegistryPlugins(registryUrl);

  // If running in a non-interactive shell (piped, CI, or raw mode unavailable):
  if (!process.stdin.isTTY || !ctx.io.isInteractive()) {
    ctx.io.raw(`\n✦ Carbon Plugin Registry (${plugins.length} plugins available):\n`);
    for (const p of plugins) {
      const verified = p.verified ? ctx.io.c.green("✓") : "";
      ctx.io.raw(`  ${ctx.io.c.bold(`@registry/${p.name}`)} ${verified} ${ctx.io.c.dim(`(v${p.latestVersion} · ${p.category} · ⬇ ${p.downloads})`)}`);
      ctx.io.raw(`    ${p.description}`);
      ctx.io.raw(`    ${ctx.io.c.dim(`Install: carbon plugin add @registry/${p.name}`)}\n`);
    }
    return EXIT_OK;
  }

  // Interactive TUI
  const selected = await runPluginSearchTui(plugins, isLive, registryUrl);

  if (!selected) {
    ctx.io.info("Plugin search closed.");
    return EXIT_OK;
  }

  // User confirmed a selection!
  ctx.io.raw("\n  " + pc.bold(pc.white("✦ Selected Plugin:")));
  ctx.io.raw(`  ${pc.bold(pc.cyan("❯"))}  ${pc.bold(pc.white(`@registry/${selected.name}`))}  ${selected.verified ? pc.green("✓ verified") : ""}  ${pc.dim(`v${selected.latestVersion}`)}  ${pc.yellow(`◆ ${selected.category}`)}  ${pc.dim(`⬇ ${selected.downloads}`)}`);
  ctx.io.raw(`     ${pc.white(selected.description)}\n`);

  ctx.io.raw("  " + pc.dim("To install this plugin into your project, run:"));
  ctx.io.raw("  " + pc.bold(pc.green(`carbon plugin add @registry/${selected.name}`)) + "\n");

  return EXIT_OK;
}

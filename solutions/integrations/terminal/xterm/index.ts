// Public entry — mirrors `@xterm/xterm`'s default exports. The carbon
// CLI's build pipeline aliases `@xterm/xterm` to this file, so unmodified
// app code that does `import { Terminal } from "@xterm/xterm"` lands here.
//
// ── LAYOUT ──────────────────────────────────────────────────────────────────
//   domain/          what a terminal IS, with no notion of how it is drawn:
//                    the escape-sequence parser, the cell grid it mutates,
//                    the event emitter, and the xterm.js types we implement.
//                    Runs anywhere — the parser tests drive it with no scene.
//   infrastructure/  what makes it appear: the Terminal class that paints
//                    the grid as scene-graph nodes, and the addons.
//
// Same split as integrations/bundler/vite. It was `model/` + `core/` +
// `addons/`, which named three things at two levels — `core/events.ts` (a
// 33-line emitter that touches nothing) sat beside `core/terminal.ts` (the
// entire scene-painting path).

export { Terminal } from "./infrastructure/terminal.ts";
export type {
  ITheme,
  ITerminalOptions,
  ITerminal,
  ITerminalAddon,
  IDisposable,
  IMarker,
  IBufferCell,
  IBufferLine,
  IBuffer,
  IBufferNamespace,
} from "./domain/types.ts";

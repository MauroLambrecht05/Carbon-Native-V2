// Public entry — mirrors `@xterm/xterm`'s default exports. The carbon
// CLI's build pipeline aliases `@xterm/xterm` to this file, so unmodified
// app code that does `import { Terminal } from "@xterm/xterm"` lands here.

export { Terminal } from "./terminal";
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
} from "./types";

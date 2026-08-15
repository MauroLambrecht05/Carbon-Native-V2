// @xterm/addon-webgl replacement. Pure no-op — our shim doesn't use a
// canvas-backed renderer at all, so there's no WebGL accelerator to
// swap in. The addon exposes the same `activate`/`dispose` contract so
// `term.loadAddon(new WebglAddon())` doesn't throw.

import type { ITerminal, ITerminalAddon } from "../../domain/types.ts";

export class WebglAddon implements ITerminalAddon {
  /** xterm-webgl emits this when GL fails (e.g. on iOS); our shim
   *  never fires it. */
  onContextLoss(_cb: (e: Event) => void): { dispose: () => void } {
    return { dispose: () => {} };
  }
  activate(_term: ITerminal): void { /* no-op */ }
  dispose(): void { /* no-op */ }
  /** Force a re-render path — no-op since the shim's renderer auto-
   *  schedules on writes. */
  clearTextureAtlas(): void {}
  /** GL canvases the shim doesn't create — empty list keeps callers
   *  that iterate them from crashing. */
  get textureAtlas(): unknown { return undefined; }
}

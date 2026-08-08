// @carbon/three / mock-executor.ts
//
// A `CommandExecutor` that records everything it's told to draw so tests
// can assert on the structure of the command stream. Two record modes:
//
//   `keepLatest`  — only the most recent frame is retained. Saves memory
//                   when running long benchmarks where we don't care
//                   about history.
//   `keepAll`     — every frame is kept (default). Tests use this.
//
// The recorder also tracks lightweight stats so benchmarks can confirm
// what was emitted without iterating the command list.

import type { CommandExecutor, DrawCommand } from "./types.js";

export type MockMode = "keepLatest" | "keepAll";

export interface MockStats {
  frames: number;
  totalCommands: number;
  meshCommands: number;
  lineCommands: number;
  pointsCommands: number;
  clearCommands: number;
  setCameraCommands: number;
  setLightsCommands: number;
}

export class MockCommandExecutor implements CommandExecutor {
  // History. Each element is the command list for one `render()` call.
  readonly frames: DrawCommand[][] = [];
  readonly mode: MockMode;
  readonly stats: MockStats = {
    frames: 0,
    totalCommands: 0,
    meshCommands: 0,
    lineCommands: 0,
    pointsCommands: 0,
    clearCommands: 0,
    setCameraCommands: 0,
    setLightsCommands: 0,
  };

  constructor(mode: MockMode = "keepAll") {
    this.mode = mode;
  }

  execute(commands: DrawCommand[]): void {
    // Snapshot — the renderer reuses its internal array between frames.
    const snapshot = commands.slice();
    if (this.mode === "keepLatest") {
      this.frames.length = 0;
    }
    this.frames.push(snapshot);
    this.stats.frames++;
    for (let i = 0; i < snapshot.length; i++) {
      const c = snapshot[i];
      this.stats.totalCommands++;
      switch (c.type) {
        case "clear": this.stats.clearCommands++; break;
        case "setCamera": this.stats.setCameraCommands++; break;
        case "setLights": this.stats.setLightsCommands++; break;
        case "mesh": this.stats.meshCommands++; break;
        case "line": this.stats.lineCommands++; break;
        case "points": this.stats.pointsCommands++; break;
      }
    }
  }

  // Convenience for tests: get the most recent frame, or empty if none.
  lastFrame(): DrawCommand[] {
    if (this.frames.length === 0) return [];
    return this.frames[this.frames.length - 1];
  }

  // Convenience: count meshes in the most recent frame.
  meshCountInLastFrame(): number {
    return this.lastFrame().filter((c) => c.type === "mesh").length;
  }

  reset(): void {
    this.frames.length = 0;
    this.stats.frames = 0;
    this.stats.totalCommands = 0;
    this.stats.meshCommands = 0;
    this.stats.lineCommands = 0;
    this.stats.pointsCommands = 0;
    this.stats.clearCommands = 0;
    this.stats.setCameraCommands = 0;
    this.stats.setLightsCommands = 0;
  }
}

// Client for the native carbon-launcher daemon (products/carbon-launcher's
// `daemon` subcommand) — a pre-warmed pool of `carbon-mini --pool-wait`
// processes that skips the ~65-83ms OS process-creation cost a direct
// `spawn()` still pays. This is the SAME daemon/pipe protocol
// products/carbon-launcher/composition/daemon.rs's own `try_daemon` speaks;
// this file is a TypeScript port of that function so `carbon run`/`carbon
// dev` — the real product commands, not a personal PATH shim — get the win
// too, without requiring anyone to have carbon-launcher.exe wired into their
// shell at all.
//
// Any failure here — no daemon listening, pool empty, a stale pooled binary
// — resolves `null`; the caller falls straight through to its existing
// direct-spawn path. The daemon is a pure optimization, never a dependency
// of `run`/`dev` working at all.
//
// On a failed connect, this warms the daemon for NEXT time by spawning
// `carbon-launcher.exe ensure-daemon` — NOT `carbon-launcher.exe daemon`
// directly. An earlier version spawned the daemon itself straight from here
// with `detached: true` + `windowsHide: true`; in practice that combination
// did NOT reliably suppress the child's console window under Bun's
// `node:child_process` compat layer on Windows, so every `carbon run`/
// `carbon dev` that warmed a missing daemon popped a visible console window
// alongside the app's own window. `ensure-daemon` fixes this by moving the
// decision natively: it does the "is one already running, else spawn one"
// check in Rust, using real Win32 `CREATE_NO_WINDOW`/`DETACHED_PROCESS`
// flags for the ONE spawn that actually needs to survive past its parent —
// see daemon.rs's `ensure_daemon` for the full reasoning. The call made HERE
// is a plain, non-detached spawn (same category as every other subprocess
// this CLI already shells out to, e.g. cargo/bun/zig) — it never allocates a
// console of its own, so nothing about this path can show a window.
//
// Windows only: named pipes are a Windows IPC primitive (see pipe.rs's own
// module doc for why windows-sys over the alternatives). There is no daemon
// to try on other platforms.

import { connect } from "node:net";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { WINDOW_VISIBLE_MARKER } from "./NodeProcessRunner.ts";

const EXIT_MARKER = "__CARBON_LAUNCHER_EXIT__:";

function pipePath(): string {
  const user = process.env["USERNAME"] ?? process.env["USER"] ?? "unknown";
  return `\\\\.\\pipe\\carbon-launcher-daemon-${user}`;
}

/**
 * Fire-and-forget: ask carbon-launcher's native `ensure-daemon` subcommand
 * to check whether a daemon is already running and, only if not, spawn one
 * hidden. Never awaited by the caller — it's fast (a pipe-connect attempt,
 * plus at most one native spawn call) and its own result doesn't change
 * anything about THIS launch, which has already fallen back to a direct
 * spawn by the time this runs. No-ops silently if `launcherExe` doesn't
 * exist on disk (fresh clone, or a platform without it yet) — a warm-up,
 * never a hard dependency.
 */
function warmDaemonInBackground(launcherExe: string | undefined): void {
  if (!launcherExe || !existsSync(launcherExe)) return;
  try {
    const child = spawn(launcherExe, ["ensure-daemon"], {
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
  } catch {
    // Best-effort only.
  }
}

/**
 * Try to have the daemon serve this run/dev launch from its pre-warmed pool.
 *
 * `onWindowVisible` fires once, exactly when the same `[carbon-mini]
 * window-visible` marker `startAndWaitForWindowVisible` watches for arrives
 * — callers use it to print the identical "ready" summary a direct-spawn
 * launch prints, so daemon-served output is indistinguishable from a direct
 * spawn except for being faster.
 *
 * Resolves:
 *  - `null` — no daemon reachable, or it declined (pool empty/stale). Caller
 *    falls back to its normal direct-spawn path; nothing was launched.
 *  - a number — the daemon fully served the launch (including relaying every
 *    non-marker stderr line live) and the pooled process has now exited with
 *    this code. NEVER falls back past this point even on an unclean pipe
 *    close, because by then a real window may already be on screen — falling
 *    back here would risk launching a second instance of the same app.
 *
 * Known gap, inherited from the Rust daemon client this mirrors: Ctrl-C
 * against a daemon-served launch cannot gracefully close the pooled process
 * (it isn't attached to this CLI's console) — callers that need that should
 * treat a daemon-served session the same way run.command.ts/dev.command.ts
 * do, i.e. accept the gap rather than build console-signal forwarding here.
 */
export function tryDaemonRun(opts: {
  projectDir: string;
  backend: string;
  devMode: boolean;
  onWindowVisible: () => void;
  /** Absolute path to carbon-launcher.exe, so a failed connect can warm the
   *  daemon (via its `ensure-daemon` subcommand) for next time. Undefined or
   *  nonexistent is fine — see warmDaemonInBackground's doc comment. */
  launcherExe?: string;
}): Promise<number | null> {
  if (process.platform !== "win32") return Promise.resolve(null);

  return new Promise((resolveOuter) => {
    const sock = connect({ path: pipePath() });
    let settled = false;
    let gotFirstLine = false;

    const finish = (result: number | null) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch {}
      resolveOuter(result);
    };

    sock.once("error", () => {
      if (!gotFirstLine) warmDaemonInBackground(opts.launcherExe);
      finish(null);
    });

    sock.once("connect", () => {
      const req = JSON.stringify({
        project_dir: opts.projectDir,
        dev_mode: opts.devMode,
        backend: opts.backend,
      });
      sock.write(req + "\n");
    });

    let buf = "";
    let visibleFired = false;

    sock.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let idx: number;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);

        if (!gotFirstLine) {
          gotFirstLine = true;
          let ok = false;
          try { ok = JSON.parse(line)?.ok === true; } catch { ok = false; }
          if (!ok) { finish(null); return; }
          continue;
        }

        if (line.startsWith(EXIT_MARKER)) {
          const code = Number.parseInt(line.slice(EXIT_MARKER.length), 10);
          finish(Number.isFinite(code) ? code : 1);
          return;
        }

        if (line.trim() === WINDOW_VISIBLE_MARKER) {
          if (!visibleFired) {
            visibleFired = true;
            opts.onWindowVisible();
          }
          continue;
        }

        process.stderr.write(line + "\n");
      }
    });

    sock.once("close", () => {
      // Pipe closed before either marker arrived. Before the daemon ever
      // said "ok" nothing was launched — safe to treat as "no daemon" and
      // fall back. After "ok", a pooled process may already be live; that's
      // a real failure, not a fallback signal (same posture as the Rust
      // client this mirrors).
      finish(gotFirstLine ? 1 : null);
    });
  });
}

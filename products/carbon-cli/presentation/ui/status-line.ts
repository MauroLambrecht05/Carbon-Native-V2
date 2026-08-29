// A single, live-updating status line for the "preparing" phase of `carbon
// dev` / `carbon run` — installing deps, compiling the runtime, bundling,
// syncing plugins. The point: a professional CLI shows *that* it's working
// and *what* it's doing right now, as one line that redraws in place, not a
// scrolling dump of everything every layer felt like printing.
//
// ── WHY A LOG SINK, NOT A WRAPPED LOGGER ────────────────────────────────────
// The pipeline this narrates spans several packages (ensureNodeModules,
// ensureRuntime, buildProject, BunBundler's carbon-split/carbon-tailwind
// passes) and not all of them take a Logger as a parameter — some reach for
// the `log` singleton from @carbon/logging directly (see BunBundler.ts).
// Wrapping only the injected Logger would miss those. Installing a sink on
// the singleton (setLogSink) catches every `log.*` call, injected or direct,
// for as long as this status line is active — see ConsoleLogger.ts for why
// the sink exists.
//
// A warn/error is never swallowed into the spinner text: it interrupts,
// prints for real (so it lands in scrollback), and the spinner resumes
// underneath it. Only info/step — routine "here's what I'm doing" chatter —
// becomes the line's text.
//
// Non-TTY (piped output, CI): cursor redraws are meaningless, so this falls
// back to one plain line per distinct message — linear, still readable, just
// never overwritten in place.

import { setLogSink, c, type LogKind, type LogSink } from "@carbon/logging";
import { accent } from "./brand.ts";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FRAME_MS = 80;

function isTtyOut(): boolean {
  return !!process.stdout.isTTY && process.env["TERM"] !== "dumb";
}

// Only one status line is ever active at a time in this CLI's flow. Tracking
// it here — rather than one `process.on("exit", …)` per instance — means a
// crash mid-render always leaves the terminal in a clean state, however many
// StatusLine instances the dev/rebuild loop has created and discarded by then.
let current: StatusLine | null = null;
process.on("exit", () => {
  current?.hardClear();
});

export class StatusLine {
  private text = "";
  private frame = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private prevSink: LogSink | null = null;
  private active = false;
  private readonly tty = isTtyOut();
  private lastPrintedNonTty = "";

  /** `verbose: true` makes every method a no-op — nothing is intercepted, so
   *  every log.* call anywhere in the pipeline prints the way it always did.
   *  This is the escape hatch: `--verbose` gets the full, uncollapsed trail. */
  constructor(private readonly verbose = false) {}

  /** Start the line and begin forwarding every log.* call into it. */
  begin(initial: string): void {
    if (this.verbose) return;
    this.active = true;
    this.text = initial;
    current = this;
    this.prevSink = setLogSink((kind, msg) => this.onLog(kind, msg));
    if (this.tty) {
      this.render();
      this.timer = setInterval(() => {
        this.frame = (this.frame + 1) % FRAMES.length;
        this.render();
      }, FRAME_MS);
      this.timer.unref?.();
    } else {
      this.printLineOnce(this.text);
    }
  }

  private onLog(kind: LogKind, msg: string): void {
    if (kind === "step" || kind === "info") {
      this.text = msg;
      if (this.tty) this.render();
      else this.printLineOnce(msg);
      return;
    }
    // warn / error / success / raw: real, permanent output — never folded
    // into the spinner text. Clear it, print for real, resume underneath.
    this.interject(kind, msg);
  }

  private interject(kind: LogKind, msg: string): void {
    if (this.tty) this.clearLine();
    const prefix =
      kind === "warn" ? c.yellow("!") :
      kind === "error" ? c.red("✗") :
      kind === "success" ? accent("✓") : "";
    process.stdout.write(prefix ? `${prefix} ${msg}\n` : `${msg}\n`);
    if (this.tty && this.active) this.render();
  }

  private render(): void {
    // Clip to terminal width: an untruncated long line (a full project path,
    // say) wraps onto a second row, and `\r` + clear-to-end-of-line only ever
    // touches the row the cursor is on — the next redraw would then leave a
    // stale fragment of the wrapped part sitting above it.
    const cols = process.stdout.columns ?? 80;
    const budget = Math.max(10, cols - 2); // "⠋ " prefix
    const text = this.text.length > budget ? this.text.slice(0, budget - 1) + "…" : this.text;
    process.stdout.write(`\r\x1b[2K${accent(FRAMES[this.frame]!)} ${text}`);
  }

  private clearLine(): void {
    process.stdout.write(`\r\x1b[2K`);
  }

  private printLineOnce(msg: string): void {
    if (msg === this.lastPrintedNonTty) return;
    this.lastPrintedNonTty = msg;
    process.stdout.write(`${c.dim("·")} ${msg}\n`);
  }

  /** Success path: stop narrating and clear the line — no trace of
   *  "preparing" survives into scrollback. */
  succeed(): void {
    if (this.verbose) return;
    this.stop();
    if (this.tty) this.clearLine();
  }

  /** Failure path: stop narrating and leave a permanent error line — the
   *  last thing on screen is what actually broke. In verbose mode nothing was
   *  intercepted (no sink was ever installed), so this is just a plain error
   *  line rather than a redraw-and-replace. */
  fail(msg: string): void {
    if (!this.verbose) {
      this.stop();
      if (this.tty) this.clearLine();
    }
    process.stdout.write(`${c.red("✗")} ${msg}\n`);
  }

  /** Synchronous best-effort cleanup for the process "exit" handler — never
   *  called directly by normal flow (succeed()/fail() already do this). */
  hardClear(): void {
    if (this.active && this.tty) this.clearLine();
  }

  private stop(): void {
    if (!this.active) return;
    this.active = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    setLogSink(this.prevSink);
    if (current === this) current = null;
  }
}

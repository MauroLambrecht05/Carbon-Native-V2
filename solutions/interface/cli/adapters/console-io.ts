// Console implementations of the Io port.
//
// The default forwards to @carbon/toolchain's console logger, so the CLI's
// output format is the one the rest of carbon already uses. BufferedIo is the
// same seam pointed at an array, which is what lets the dispatcher tests
// assert on output without swapping globals.
//
// ── THE BOXED LOOK ───────────────────────────────────────────────────────────
// Every interactive prompt — standalone or part of a Wizard — renders as a
// bordered box (`renderBox`), not a decorated line. That replaced an earlier
// clack-style design (a single ◆/◇ marker plus a `│` connector rail) the user
// rejected outright ("I hate this design with the square and lines").
//
// ── WHY THE ALTERNATE SCREEN BUFFER ──────────────────────────────────────────
// The first version of this redraw tracked "how many lines did I print last
// time" and moved the cursor up that many rows before clearing — the same
// technique the earlier (non-boxed) select() fix used. Confirmed broken on a
// real run (screenshot: two full step-frames stacked, one under the other,
// never cleared) despite a live diagnostic proving basic single-line
// cursor-up + clear DOES work in that same terminal (VS Code integrated,
// 218x23). The difference is height: a relative "move up N" is measured from
// wherever the cursor currently sits, and once cumulative output has scrolled
// the viewport, N can exceed what's actually still above the cursor —
// terminals differ on whether that clamps, scrolls, or does something else,
// and this one clearly didn't do what a same-viewport single-line case does.
//
// The alternate screen buffer (`\x1b[?1049h`/`l`, what htop/vim/lazygit use)
// sidesteps the whole class of bug: every redraw clears from an ABSOLUTE
// origin (0,0) in a screen dedicated to this prompt, so there is no "was that
// still in the visible viewport" question to get wrong. On leaving it, the
// terminal's prior contents reappear exactly as they were — nothing this
// module drew is left behind — and a short plain-text summary is printed to
// that restored normal screen so the answer still has a permanent record in
// scrollback once the box is gone, the same way `npm init`-style wizards do.

import {
  createInterface,
  emitKeypressEvents,
  cursorTo,
  clearScreenDown,
  type Key,
} from "node:readline";
import { log, c } from "@carbon/logging";
import type { Io, SelectOption, Wizard } from "../ports/io-port.ts";

// process.stdin.isTTY is false when carbon is invoked through Bazel's .bat
// wrapper on Windows even though the user is sitting at a real terminal — the
// wrapper doesn't propagate the TTY flag but leaves stdin/stdout connected to
// the real console. Fall back to environment variables terminals reliably set
// so `carbon init` still prompts interactively in that case.
function isInteractiveTerminal(): boolean {
  if (process.stdin.isTTY) return true;
  // Windows Terminal / VS Code terminal
  if (process.env["WT_SESSION"] || process.env["TERM_PROGRAM"]) return true;
  // Any ANSI-capable terminal
  if (process.env["TERM"] && process.env["TERM"] !== "dumb") return true;
  // ConEmu / Cmder
  if (process.env["ConEmuPID"]) return true;
  return false;
}

let sharedReadline: ReturnType<typeof createInterface> | undefined;

// ── Box drawing ──────────────────────────────────────────────────────────────
// Colour codes have zero visible width but count toward .length, so padding
// a coloured line with plain padEnd() misaligns the right border by however
// many escape bytes are in it. Every width computation below goes through
// visibleLength/padVisible instead of the raw string length.

const ANSI_RE = /\x1b\[[0-9;]*m/g;
function visibleLength(s: string): number {
  return s.replace(ANSI_RE, "").length;
}
function padVisible(s: string, width: number): string {
  return s + " ".repeat(Math.max(0, width - visibleLength(s)));
}

const BOX_PAD = 3; // interior spaces on each side of a content line

/** Content width for a box showing `contentLines` under `title` — as wide as
 *  the widest thing it actually has to show, clamped to the terminal so a
 *  long option hint never wraps the border, floored at a size that still
 *  reads as a real panel even for a one-word answer. */
function boxInnerWidth(title: string, contentLines: readonly string[], minWidth = 30): number {
  const terminalMax = Math.max(20, (process.stdout.columns ?? 80) - 6);
  const longestContent = contentLines.reduce((m, l) => Math.max(m, visibleLength(l)), 0);
  const titleWidth = title ? title.length + 4 : 0; // "─ title ─"
  return Math.min(terminalMax, Math.max(minWidth, longestContent, titleWidth));
}

function boxTop(title: string, innerWidth: number): string {
  const span = innerWidth + BOX_PAD * 2;
  const label = title ? `─ ${c.bold(title)} ─` : "";
  const labelVisible = title ? title.length + 4 : 0;
  const dashes = Math.max(0, span - labelVisible);
  return c.dim("╭") + label + c.dim("─".repeat(dashes) + "╮");
}
function boxBottom(innerWidth: number): string {
  return c.dim("╰" + "─".repeat(innerWidth + BOX_PAD * 2) + "╯");
}
function boxContentLine(content: string, innerWidth: number): string {
  return c.dim("│") + " ".repeat(BOX_PAD) + padVisible(content, innerWidth) + " ".repeat(BOX_PAD) + c.dim("│");
}

/** A bordered box: top border (title embedded), a blank padding line, each
 *  of `contentLines`, another blank padding line, bottom border. Nothing
 *  else renders above or beside it — no title line, no step tracker, no
 *  running summary of earlier answers. Those all got cut: the box is the
 *  entire screen now, and it's sized to have real room inside it rather
 *  than wrapping content tightly. */
function renderBox(title: string, contentLines: readonly string[], opts: { minWidth?: number } = {}): string[] {
  const innerWidth = boxInnerWidth(title, contentLines, opts.minWidth);
  return [
    boxTop(title, innerWidth),
    boxContentLine("", innerWidth),
    ...contentLines.map((l) => boxContentLine(l, innerWidth)),
    boxContentLine("", innerWidth),
    boxBottom(innerWidth),
  ];
}

function footerLine(hint: string): string {
  return `   ${c.dim(hint)}`;
}

const FOOTER_TEXT = "enter to continue · ctrl+c to cancel";
const FOOTER_SELECT = "↑↓ move · enter select · ctrl+c to cancel";

// ── Alternate screen ─────────────────────────────────────────────────────────

let altScreenActive = false;

function enterAltScreen(): void {
  altScreenActive = true;
  process.stdout.write("\x1b[?1049h"); // switch buffers
  process.stdout.write("\x1b[?25l"); // hide the real cursor; boxes draw their own caret
}
function leaveAltScreen(): void {
  if (!altScreenActive) return;
  altScreenActive = false;
  process.stdout.write("\x1b[?25h"); // restore cursor visibility before returning
  process.stdout.write("\x1b[?1049l"); // switch back — the terminal's prior contents reappear untouched
}

// Defense in depth: every normal exit path above already calls
// leaveAltScreen() itself, but an uncaught exception mid-prompt (a bug
// elsewhere, a rejected promise nothing awaited) must not leave the user's
// terminal stuck showing a dead TUI frame with no visible way back — running
// `reset`/`clear` by hand is a bad failure mode for something this cheap to
// prevent. `exit` fires synchronously and can only do sync work, which a
// plain stdout.write satisfies.
process.on("exit", () => {
  if (altScreenActive) leaveAltScreen();
});

/** Redraws a region from an absolute origin every time — see the module doc
 *  comment for why this replaced relative "move up N lines" tracking. Safe
 *  to call repeatedly; each call fully replaces whatever was drawn before. */
function redraw(lines: readonly string[]): void {
  const out = process.stdout;
  cursorTo(out, 0, 0);
  clearScreenDown(out);
  out.write(lines.length ? lines.join("\n") + "\n" : "");
}

/** Sets up raw-mode keypress delivery for the duration of `onKey`, sharing
 *  the one readline interface every interactive prompt in this module uses.
 *  Returns a cleanup function; throws if the stream can't do raw mode so the
 *  caller can fall back to a non-interactive shape. */
function captureKeypresses(onKey: (str: string, key: Key | undefined) => void): () => void {
  const rl = (sharedReadline ??= createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  }));
  emitKeypressEvents(process.stdin, rl);
  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true); // throws if unsupported — caller decides the fallback
  process.stdin.on("keypress", onKey);
  return () => {
    process.stdin.off("keypress", onKey);
    try {
      process.stdin.setRawMode(wasRaw ?? false);
    } catch {
      /* not a TTY */
    }
  };
}

/** Every interactive path that captures raw keypresses must leave the
 *  alternate screen before the process actually exits — Ctrl+C included.
 *  Without this a killed prompt leaves the terminal showing a dead TUI frame
 *  until the user runs `reset`/`clear` by hand. Idempotent and harmless to
 *  call when no alt screen is active. */
function exitAfterCancel(): never {
  leaveAltScreen();
  try {
    process.stdin.setRawMode(false);
  } catch {
    /* not a TTY */
  }
  process.stdout.write("\n" + c.dim("cancelled") + "\n");
  process.exit(130); // conventional SIGINT exit code
}

/** Boxed free-text input: hand-rolled character capture (not `rl.question`)
 *  so the whole box — border included — can redraw as one unit on every
 *  keystroke, the same way the select box below does. Nothing renders
 *  outside the box itself — no title, no step tracker (cut on request; see
 *  Wizard's own comment). Runs entirely inside the alternate screen — the
 *  caller enters it before calling this and leaves it after, once it knows
 *  whether another step follows. */
function runTextInput(title: string, defaultValue: string): Promise<string> {
  return new Promise((resolve) => {
    let value = "";
    let settled = false;

    const frame = (): string[] => {
      const shown = value.length ? value : c.dim(defaultValue);
      return [...renderBox(title, [shown + c.cyan("▏")]), "", footerLine(FOOTER_TEXT)];
    };
    const render = () => redraw(frame());

    const finish = (result: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      sharedReadline?.off("close", onClose);
      resolve(result);
    };

    // A destroyed/ended stdin (see prompt()'s own comment on why this
    // happens) must resolve with the default rather than hang forever.
    const onClose = () => finish(defaultValue);

    const onKeypress = (str: string, key: Key | undefined) => {
      if (key?.ctrl && key.name === "c") {
        cleanup();
        sharedReadline?.off("close", onClose);
        exitAfterCancel();
      }
      if (key?.name === "return") {
        finish(value.trim() || defaultValue);
        return;
      }
      if (key?.name === "backspace") {
        value = value.slice(0, -1);
        render();
        return;
      }
      // Printable characters only — arrow keys, function keys, etc. arrive
      // with a `key.name` and no useful `str`, or a control char in `str`.
      if (str && !key?.ctrl && !key?.meta && str.length === 1 && str >= " ") {
        value += str;
        render();
      }
    };

    let cleanup: () => void;
    try {
      cleanup = captureKeypresses(onKeypress);
    } catch {
      // A TTY that still refuses raw mode — fall back to plain rl.question
      // rather than hanging with a box nothing can type into.
      cleanup = () => {};
      const rl = (sharedReadline ??= createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: true,
      }));
      redraw([...renderBox(title, [c.dim(defaultValue)]), "", footerLine(FOOTER_TEXT)]);
      rl.once("close", onClose);
      rl.question("", (answer) => finish(answer.trim() || defaultValue));
      return;
    }
    render();
    sharedReadline?.once("close", onClose);
  });
}

/** Boxed arrow-key select — same approach as runTextInput above: just the
 *  box and a footer hint, nothing else on screen. */
function runSelectInput<T>(
  title: string,
  options: readonly SelectOption<T>[],
  defaultIndex: number,
): Promise<{ value: T; label: string }> {
  return new Promise((resolve) => {
    let index = Math.min(Math.max(defaultIndex, 0), options.length - 1);
    let settled = false;

    const renderOption = (o: SelectOption<T>, selected: boolean): string => {
      const pointer = selected ? c.cyan("┃") : " ";
      const label = selected ? c.bold(c.cyan(o.label)) : c.dim(o.label);
      const hint = selected && o.hint ? "  " + c.dim(o.hint) : "";
      return `${pointer} ${label}${hint}`;
    };

    const frame = (): string[] => [
      ...renderBox(title, options.map((o, i) => renderOption(o, i === index))),
      "",
      footerLine(FOOTER_SELECT),
    ];
    const render = () => redraw(frame());

    const finish = (value: T, label: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      sharedReadline?.off("close", onClose);
      resolve({ value, label });
    };

    const onClose = () => finish(options[defaultIndex]!.value, options[defaultIndex]!.label);

    const onKeypress = (_str: string, key: Key | undefined) => {
      if (!key) return;
      if (key.ctrl && key.name === "c") {
        cleanup();
        sharedReadline?.off("close", onClose);
        exitAfterCancel();
      }
      if (key.name === "up" || key.name === "k") {
        index = (index - 1 + options.length) % options.length;
        render();
      } else if (key.name === "down" || key.name === "j") {
        index = (index + 1) % options.length;
        render();
      } else if (key.name === "return") {
        finish(options[index]!.value, options[index]!.label);
      } else if (key.name && /^[1-9]$/.test(key.name)) {
        const n = Number(key.name) - 1;
        if (n < options.length) finish(options[n]!.value, options[n]!.label);
      }
    };

    let cleanup: () => void;
    try {
      cleanup = captureKeypresses(onKeypress);
    } catch {
      void selectByNumberFallback(title, options, defaultIndex).then(({ value, label }) => resolve({ value, label }));
      return;
    }
    render();
    sharedReadline?.once("close", onClose);
  });
}

/** Fallback for a stdin that can't do raw mode: numbered, plain text, and
 *  deliberately OUTSIDE the alternate screen — rare enough (a real TTY that
 *  still refuses raw mode) that it doesn't need the boxed treatment, just
 *  something that works and stays readable via plain scrollback. */
async function selectByNumberFallback<T>(
  question: string,
  options: readonly SelectOption<T>[],
  defaultIndex: number,
): Promise<{ value: T; label: string }> {
  const rl = (sharedReadline ??= createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  }));

  process.stdout.write(`\n${question}\n`);
  options.forEach((o, i) => {
    const hint = o.hint ? c.dim(`  ${o.hint}`) : "";
    process.stdout.write(`  ${c.dim(String(i + 1))}  ${o.label}${hint}\n`);
  });

  const answer = await new Promise<string>((resolve) => {
    let settled = false;
    const settle = (v: string) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    rl.once("close", () => settle(""));
    rl.question(`  ${c.dim(`(${defaultIndex + 1})`)}  `, settle);
  });

  const n = parseInt(answer.trim(), 10);
  const chosen = Number.isFinite(n) ? options[n - 1] : undefined;
  const picked = chosen ?? options[defaultIndex]!;
  return { value: picked.value, label: picked.label };
}

/** Prints the permanent record of a single answer to the NORMAL screen —
 *  called after leaving the alternate screen, so it lands in real scrollback
 *  rather than vanishing when the alt screen closes. */
function printAnswer(question: string, answer: string): void {
  process.stdout.write(`${c.green("✓")} ${c.dim(question)}  ${c.bold(answer)}\n`);
}

/** Same, for a whole Wizard's worth of answers at once — printed after its
 *  last step so the flow leaves a readable summary in scrollback instead of
 *  only the final step's answer. */
function printSummary(title: string, steps: readonly string[], values: readonly string[]): void {
  process.stdout.write(`${c.green("✓")} ${c.bold(title)}\n`);
  for (let i = 0; i < values.length; i++) {
    process.stdout.write(`  ${c.dim(steps[i] ?? "")}  ${values[i]}\n`);
  }
}

// ── Wizard ────────────────────────────────────────────────────────────────────

class ConsoleWizard implements Wizard {
  private stepIndex = 0;
  private completedValues: string[] = [];
  private altScreenEntered = false;

  constructor(
    private readonly title: string,
    private readonly steps: readonly string[],
  ) {}

  private ensureAltScreen(): void {
    if (this.altScreenEntered) return;
    this.altScreenEntered = true;
    enterAltScreen();
  }

  async text(question: string, defaultValue = ""): Promise<string> {
    if (!isInteractiveTerminal() || process.stdin.destroyed) {
      this.completedValues.push(defaultValue || c.dim("(default)"));
      this.stepIndex++;
      return defaultValue;
    }
    this.ensureAltScreen();
    // Nothing above the box — no title line, no step tracker, no running
    // summary of earlier answers. Those were all cut on request: the box
    // itself, bigger and better padded, is the whole screen now. stepIndex/
    // completedValues still get tracked (pickPreset needs the renderer
    // choice to filter stack options, and printSummary below still wants
    // the full trail) — they just don't render anywhere mid-flow anymore.
    const value = await runTextInput(question, defaultValue);
    this.completedValues.push(value);
    this.stepIndex++;
    // Last step: nothing else will render into the alt screen, so leave it
    // and print the whole flow's permanent record. Every earlier step just
    // returns — the next step's own first render() redraws over this one.
    if (this.stepIndex >= this.steps.length) {
      leaveAltScreen();
      printSummary(this.title, this.steps, this.completedValues);
    }
    return value;
  }

  async select<T>(
    question: string,
    options: readonly SelectOption<T>[],
    opts: { defaultIndex?: number } = {},
  ): Promise<T> {
    const defaultIndex = opts.defaultIndex ?? 0;
    if (!isInteractiveTerminal() || process.stdin.destroyed || options.length === 0) {
      const picked = options[defaultIndex];
      this.completedValues.push(picked?.label ?? "");
      this.stepIndex++;
      return picked?.value as T;
    }
    this.ensureAltScreen();
    const { value, label } = await runSelectInput(question, options, defaultIndex);
    this.completedValues.push(label);
    this.stepIndex++;
    if (this.stepIndex >= this.steps.length) {
      leaveAltScreen();
      printSummary(this.title, this.steps, this.completedValues);
    }
    return value;
  }
}

// ── Io ────────────────────────────────────────────────────────────────────────

export const consoleIo: Io = {
  c,
  info: (m) => log.info(m),
  step: (m) => log.step(m),
  success: (m) => log.success(m),
  warn: (m) => log.warn(m),
  error: (m) => log.error(m),
  raw: (m) => log.raw(m),

  isInteractive: isInteractiveTerminal,

  prompt(question: string, defaultValue = ""): Promise<string> {
    // Non-interactive (piped, CI): return the default immediately.
    //
    // process.stdin.destroyed also short-circuits here. Closing a readline
    // interface opened in `terminal: true` mode destroys the underlying
    // stdin stream (observed directly against Bun 1.3.10) even though
    // stdin.isTTY/isInteractiveTerminal() still say "interactive" — a second
    // prompt() call would open a new interface on an already-destroyed
    // stream, which never fires 'question' or 'close' again and hangs
    // forever. Verified: without this check, a second sequential prompt on a
    // heuristic-false-positive, no-real-input environment never resolves.
    if (!isInteractiveTerminal() || process.stdin.destroyed) {
      return Promise.resolve(defaultValue);
    }
    enterAltScreen();
    return runTextInput(question, defaultValue).then((value) => {
      leaveAltScreen();
      printAnswer(question, value);
      return value;
    });
  },

  select<T>(
    question: string,
    options: readonly SelectOption<T>[],
    opts: { defaultIndex?: number } = {},
  ): Promise<T> {
    const defaultIndex = opts.defaultIndex ?? 0;
    const fallback = () => options[defaultIndex]?.value as T;

    if (!isInteractiveTerminal() || process.stdin.destroyed || options.length === 0) {
      return Promise.resolve(fallback());
    }
    enterAltScreen();
    return runSelectInput(question, options, defaultIndex).then(({ value, label }) => {
      leaveAltScreen();
      printAnswer(question, label);
      return value;
    });
  },

  startWizard(title: string, steps: readonly string[]): Wizard {
    return new ConsoleWizard(title, steps);
  },
};

/** Collects output instead of printing it. For tests. */
export class BufferedIo implements Io {
  readonly c = c;
  readonly lines: string[] = [];

  info(m: string) { this.lines.push(m); }
  step(m: string) { this.lines.push(m); }
  success(m: string) { this.lines.push(m); }
  warn(m: string) { this.lines.push(m); }
  error(m: string) { this.lines.push(m); }
  raw(m: string) { this.lines.push(m); }

  // Tests never have a real terminal behind them.
  isInteractive(): boolean { return false; }

  // In tests prompts always return the default immediately.
  async prompt(_question: string, defaultValue = ""): Promise<string> {
    return defaultValue;
  }

  async select<T>(
    _question: string,
    options: readonly SelectOption<T>[],
    opts: { defaultIndex?: number } = {},
  ): Promise<T> {
    return options[opts.defaultIndex ?? 0]!.value;
  }

  startWizard(_title: string, _steps: readonly string[]): Wizard {
    return {
      text: async (_question: string, defaultValue = "") => defaultValue,
      select: async <T>(_question: string, options: readonly SelectOption<T>[], opts: { defaultIndex?: number } = {}) =>
        options[opts.defaultIndex ?? 0]!.value,
    };
  }

  get text(): string {
    return this.lines.join("\n");
  }
}

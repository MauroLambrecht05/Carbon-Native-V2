// The Io port.
//
// Commands write through this rather than calling console directly, so a test
// can capture what a command printed without swapping globals.

import type { c as colours } from "@carbon/logging";

/** One choice in a select() menu. */
export interface SelectOption<T> {
  readonly label: string;
  readonly value: T;
  /** Shown dim, after the label. */
  readonly hint?: string;
}

export interface Io {
  readonly c: typeof colours;
  info(message: string): void;
  step(message: string): void;
  success(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  raw(message: string): void;
  /**
   * Whether stdin/stdout look like a real interactive terminal. Commands
   * check this before showing prompts at all; prompt() below checks the same
   * thing internally before trying to read, so the two can never disagree
   * about whether input is available.
   */
  isInteractive(): boolean;
  /**
   * Ask the user a question and return what they typed.
   * Returns the defaultValue immediately (without blocking) when isInteractive()
   * is false — e.g. in tests or when the command is piped — or if the input
   * stream ends before an answer arrives.
   */
  prompt(question: string, defaultValue?: string): Promise<string>;
  /**
   * Ask the user to pick one of `options` and return its `value`.
   *
   * Arrow-key driven when stdin is a real TTY capable of raw mode; falls
   * back to numbered input (like prompt()) when it isn't — e.g. the Bazel
   * .bat wrapper case isInteractive() itself exists for, where stdin is a
   * real console but not flagged as a TTY. Returns
   * `options[defaultIndex ?? 0].value` immediately, without blocking, under
   * the same non-interactive/stream-ended conditions prompt() does.
   */
  select<T>(
    question: string,
    options: readonly SelectOption<T>[],
    opts?: { defaultIndex?: number },
  ): Promise<T>;
  /**
   * Starts a multi-step boxed flow: a fixed title/header printed once, a
   * progress-dots line that advances as each step answers, and each prior
   * step collapsing to a single `✓ value` summary line above the box
   * currently active. `steps` are short labels for the progress line (e.g.
   * ["name", "renderer", "stack"]) — the full question text for each step
   * is passed to the returned Wizard's own `text`/`select` calls, in order.
   */
  startWizard(title: string, steps: readonly string[]): Wizard;
}

/** A running multi-step boxed prompt flow — see `Io.startWizard`. Calls are
 *  positional: the Nth call (whichever of `text`/`select`) answers the Nth
 *  entry of the `steps` array `startWizard` was given. */
export interface Wizard {
  text(question: string, defaultValue?: string): Promise<string>;
  select<T>(
    question: string,
    options: readonly SelectOption<T>[],
    opts?: { defaultIndex?: number },
  ): Promise<T>;
}

// The slot lifecycle: promote, fail to launch, roll back.
//
// This test exists because its absence cost something. When SlotState was made
// pure, `load`/`save` moved to the repository — and ApplyUpdateUseCase and
// HandleCrashUseCase were left calling the methods that no longer existed.
// Nothing caught it: the update path had no test, and a CLI smoke run never
// reaches it. `tsc` did, eventually.
//
// So this covers the transitions the updater actually depends on, in memory,
// with no filesystem — which is the whole point of the entity being pure.

import { describe, expect, test } from "bun:test";
import { SlotState } from "./SlotState.ts";

describe("SlotState", () => {
  test("a fresh installation is its own last-known-good", () => {
    const state = SlotState.initial("install-1", "1.0.0");
    expect(state.active_slot).toBe("1.0.0");
    expect(state.previous_slot).toBeNull();
    expect(state.last_successful_version).toBe("1.0.0");
  });

  test("promote remembers what it replaced", () => {
    const state = SlotState.initial("install-1", "1.0.0");
    state.promote("2.0.0");
    expect(state.active_slot).toBe("2.0.0");
    expect(state.previous_slot).toBe("1.0.0");
  });

  test("rollback needs the crash threshold to be reached", () => {
    const state = SlotState.initial("install-1", "1.0.0");
    state.promote("2.0.0");

    state.markLaunchStarted();
    state.markLaunchStarted();
    expect(state.needsRollback(3)).toBe(false);

    state.markLaunchStarted();
    expect(state.needsRollback(3)).toBe(true);
  });

  test("rollback swaps active and previous, and clears the counter", () => {
    const state = SlotState.initial("install-1", "1.0.0");
    state.promote("2.0.0");
    state.markLaunchStarted();

    state.rollback();

    expect(state.active_slot).toBe("1.0.0");
    expect(state.previous_slot).toBe("2.0.0");
    expect(state.in_progress_count).toBe(0);
  });

  test("rollback with nothing to go back to is a no-op, not a crash", () => {
    const state = SlotState.initial("install-1", "1.0.0");
    state.markLaunchStarted();
    state.rollback();
    expect(state.active_slot).toBe("1.0.0");
  });

  test("reaching first frame clears the counter and banks the version", () => {
    const state = SlotState.initial("install-1", "1.0.0");
    state.promote("2.0.0");
    state.markLaunchStarted();

    state.markFirstFrame();

    expect(state.in_progress_count).toBe(0);
    expect(state.last_successful_version).toBe("2.0.0");
  });
});

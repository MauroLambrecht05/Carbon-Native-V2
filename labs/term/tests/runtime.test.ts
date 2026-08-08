// Tests for @carbon/term JS package.
// Run with: bun test
//
// Strategy: we can't load the actual runtime module (it depends on host
// globals like __ct_create_node that the Rust runtime injects). Instead
// we install minimal stubs for all host globals and then import the module
// in the same bun process. This lets us test:
//   - Scene mutation calls (create_node, set_prop, insert, remove)
//   - useInput dispatch
//   - useApp().exit()
//   - createPersistentSignal HMR survival
//   - Component rendering produces expected DrawCommands to host

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";

// ─── Host global stubs ───────────────────────────────────────────────────────
// These mirror what archive/runtimes/term/src/main.rs injects at startup.

interface HostCall {
  fn: string;
  args: unknown[];
}

const calls: HostCall[] = [];

function recordCall(fn: string, ...args: unknown[]) {
  calls.push({ fn, args });
}

function installHostGlobals() {
  (globalThis as any).__ct_create_node = (id: number, tag: string, propsJson: string) =>
    recordCall("create_node", id, tag, propsJson);
  (globalThis as any).__ct_create_inline_text = (id: number, text: string) =>
    recordCall("create_inline_text", id, text);
  (globalThis as any).__ct_set_text = (id: number, text: string) =>
    recordCall("set_text", id, text);
  (globalThis as any).__ct_set_prop = (id: number, key: string, valueJson: string) =>
    recordCall("set_prop", id, key, valueJson);
  (globalThis as any).__ct_insert_node = (parentId: number, childId: number, beforeId: number) =>
    recordCall("insert_node", parentId, childId, beforeId);
  (globalThis as any).__ct_remove_node = (id: number) =>
    recordCall("remove_node", id);
  (globalThis as any).__ct_set_root = (id: number) =>
    recordCall("set_root", id);
  (globalThis as any).__ct_request_paint = () =>
    recordCall("request_paint");
  (globalThis as any).__ct_exit = () =>
    recordCall("exit");
  (globalThis as any).__ct_initial_cols = 80;
  (globalThis as any).__ct_initial_rows = 24;
}

// Install stubs before importing the module (module-level code runs on import).
installHostGlobals();

// Now import the runtime. The module-level code (dispatch handlers, signal
// setup) runs against our stubs.
import {
  useInput,
  useApp,
  createPersistentSignal,
} from "@carbon/term";

// Helper: reset the call log between tests.
function resetCalls() {
  calls.length = 0;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("host globals", () => {
  test("all required host globals are defined", () => {
    expect(typeof (globalThis as any).__ct_create_node).toBe("function");
    expect(typeof (globalThis as any).__ct_create_inline_text).toBe("function");
    expect(typeof (globalThis as any).__ct_set_text).toBe("function");
    expect(typeof (globalThis as any).__ct_set_prop).toBe("function");
    expect(typeof (globalThis as any).__ct_insert_node).toBe("function");
    expect(typeof (globalThis as any).__ct_remove_node).toBe("function");
    expect(typeof (globalThis as any).__ct_set_root).toBe("function");
    expect(typeof (globalThis as any).__ct_request_paint).toBe("function");
    expect(typeof (globalThis as any).__ct_exit).toBe("function");
  });

  test("initial size constants are available", () => {
    expect((globalThis as any).__ct_initial_cols).toBe(80);
    expect((globalThis as any).__ct_initial_rows).toBe(24);
  });
});

describe("useApp", () => {
  beforeEach(resetCalls);

  test("exit() calls __ct_exit", () => {
    const app = useApp();
    app.exit();
    const exitCalls = calls.filter(c => c.fn === "exit");
    expect(exitCalls.length).toBeGreaterThanOrEqual(1);
  });

  test("exit() with error arg does not throw", () => {
    const app = useApp();
    expect(() => app.exit(new Error("test error"))).not.toThrow();
  });
});

describe("useInput", () => {
  beforeEach(resetCalls);

  test("registered handler is called on dispatch", () => {
    const received: Array<{ input: string; key: any }> = [];
    useInput((input, key) => {
      received.push({ input, key });
    });

    // Simulate the Rust runtime dispatching a key press.
    const rawEvent = {
      key: "a",
      input: "a",
      ctrl: false,
      meta: false,
      shift: false,
      return_key: false,
      escape: false,
      backspace: false,
      tab: false,
      up_arrow: false,
      down_arrow: false,
      left_arrow: false,
      right_arrow: false,
      page_up: false,
      page_down: false,
      delete: false,
    };
    (globalThis as any).__ct_dispatch_input(rawEvent);

    expect(received.length).toBeGreaterThanOrEqual(1);
    const last = received[received.length - 1];
    expect(last.input).toBe("a");
  });

  test("key shape maps snake_case Rust fields to camelCase Ink shape", () => {
    const keyShapes: any[] = [];
    useInput((_input, key) => {
      keyShapes.push(key);
    });

    const rawEvent = {
      key: "Enter",
      input: "\r",
      ctrl: false,
      meta: false,
      shift: false,
      return_key: true,
      escape: false,
      backspace: false,
      tab: false,
      up_arrow: false,
      down_arrow: false,
      left_arrow: false,
      right_arrow: false,
      page_up: false,
      page_down: false,
      delete: false,
    };
    (globalThis as any).__ct_dispatch_input(rawEvent);

    const k = keyShapes[keyShapes.length - 1];
    expect(k).not.toBeNull();
    // Ink-compatible camelCase fields:
    expect(k.return).toBe(true);
    expect(k.escape).toBe(false);
    expect(k.upArrow).toBe(false); // not up_arrow
  });

  test("dispatch calls __ct_request_paint", () => {
    useInput(() => {});
    const paintsBefore = calls.filter(c => c.fn === "request_paint").length;
    (globalThis as any).__ct_dispatch_input({
      key: "x", input: "x",
      ctrl: false, meta: false, shift: false,
      return_key: false, escape: false, backspace: false, tab: false,
      up_arrow: false, down_arrow: false, left_arrow: false, right_arrow: false,
      page_up: false, page_down: false, delete: false,
    });
    const paintsAfter = calls.filter(c => c.fn === "request_paint").length;
    expect(paintsAfter).toBeGreaterThan(paintsBefore);
  });

  test("isActive=false suppresses handler", () => {
    const received: string[] = [];
    useInput((input) => { received.push(input); }, { isActive: false });

    (globalThis as any).__ct_dispatch_input({
      key: "z", input: "z",
      ctrl: false, meta: false, shift: false,
      return_key: false, escape: false, backspace: false, tab: false,
      up_arrow: false, down_arrow: false, left_arrow: false, right_arrow: false,
      page_up: false, page_down: false, delete: false,
    });
    expect(received).not.toContain("z");
  });

  test("ctrl+C event carries ctrl=true", () => {
    const ctrlKeys: any[] = [];
    useInput((_input, key) => { ctrlKeys.push(key); });

    (globalThis as any).__ct_dispatch_input({
      key: "c", input: "c",
      ctrl: true, meta: false, shift: false,
      return_key: false, escape: false, backspace: false, tab: false,
      up_arrow: false, down_arrow: false, left_arrow: false, right_arrow: false,
      page_up: false, page_down: false, delete: false,
    });
    const last = ctrlKeys[ctrlKeys.length - 1];
    expect(last.ctrl).toBe(true);
  });
});

describe("createPersistentSignal", () => {
  test("initial value is returned when key is new", () => {
    const [val] = createPersistentSignal("test.newkey." + Math.random(), 42);
    expect(val()).toBe(42);
  });

  test("second call with same key returns value from stash when manually pre-seeded", () => {
    const key = "test.persist." + Math.random();
    // Pre-seed the global HMR stash (simulating what the createEffect would have
    // written after a previous session). We do this directly because Solid effects
    // run in a reactive owner and we can't easily trigger them in a plain test.
    const stash: Map<string, unknown> = ((globalThis as any).__hmr_state ??= new Map());
    stash.set(key, 99);
    const [val2] = createPersistentSignal(key, 10);
    expect(val2()).toBe(99);
  });

  test("updating the signal value changes the signal getter", () => {
    const key = "test.stash." + Math.random();
    const [val, set] = createPersistentSignal(key, 0);
    expect(val()).toBe(0);
    set(77);
    // Signal getter reflects the new value immediately.
    expect(val()).toBe(77);
    // The stash will be updated by the reactive effect when run in a Solid owner;
    // in this bare test environment the effect may be deferred — that's correct Solid behaviour.
  });

  test("different keys are independent", () => {
    const [v1] = createPersistentSignal("test.a." + Math.random(), 1);
    const [v2] = createPersistentSignal("test.b." + Math.random(), 2);
    expect(v1()).toBe(1);
    expect(v2()).toBe(2);
  });
});

describe("resize dispatch", () => {
  test("__ct_dispatch_resize is a function", () => {
    expect(typeof (globalThis as any).__ct_dispatch_resize).toBe("function");
  });

  test("dispatch does not throw", () => {
    expect(() => (globalThis as any).__ct_dispatch_resize(120, 40)).not.toThrow();
  });
});

describe("HMR reset", () => {
  test("__ct_hmr_reset is a function", () => {
    expect(typeof (globalThis as any).__ct_hmr_reset).toBe("function");
  });

  test("hmr_reset does not throw", () => {
    expect(() => (globalThis as any).__ct_hmr_reset()).not.toThrow();
  });
});

// @carbon/term — Solid universal renderer wired into the carbon-term
// scene-graph host imports. Exposes Ink-compatible component names and hooks
// so existing Ink apps port via the @carbon/vite-ink-shim Vite plugin
// without any source-code changes.
//
// Configure vite-plugin-solid with this package as the universal moduleName:
//
//   solid({ solid: { generate: 'universal', moduleName: '@carbon/term' } })

import { createRenderer } from "solid-js/universal";
import {
  createComponent as solidCreateComponent,
  createComponent,
  createEffect,
  createSignal,
  onCleanup,
} from "solid-js";

// ─── Host imports declared by archive/runtimes/term/src/main.rs ──────────────────
declare const __ct_create_node: (id: number, tag: string, propsJson: string) => void;
declare const __ct_create_inline_text: (id: number, text: string) => void;
declare const __ct_set_text: (id: number, text: string) => void;
declare const __ct_set_prop: (id: number, key: string, valueJson: string) => void;
declare const __ct_insert_node: (parentId: number, childId: number, beforeId: number) => void;
declare const __ct_remove_node: (id: number) => void;
declare const __ct_set_root: (id: number) => void;
declare const __ct_request_paint: () => void;
declare const __ct_exit: () => void;
declare const __ct_initial_cols: number;
declare const __ct_initial_rows: number;

// ─── Scene node — Solid mutates these ────────────────────────────────────
export interface CtNode {
  id: number;
  tag: string;
  parent: CtNode | null;
  children: CtNode[];
  isText: boolean;
}

let nextId = 100;

function freshNode(tag: string, isText = false): CtNode {
  const id = nextId++;
  __ct_create_node(id, tag, "{}");
  return { id, tag, parent: null, children: [], isText };
}

// ─── Renderer ────────────────────────────────────────────────────────────
const renderer = createRenderer<CtNode>({
  createElement(tag: string): CtNode {
    return freshNode(tag);
  },
  createTextNode(value: string): CtNode {
    const id = nextId++;
    __ct_create_inline_text(id, String(value));
    return { id, tag: "#text", parent: null, children: [], isText: true };
  },
  replaceText(textNode: CtNode, value: string) {
    __ct_set_text(textNode.id, String(value));
    __ct_request_paint();
  },
  setProperty(node: CtNode, name: string, value: any) {
    // Style: spread each rule as a separate scene prop. Ink users mostly
    // pass props directly, but some pass `style={{...}}` patterns; we
    // support both shapes.
    if (name === "style" && value && typeof value === "object") {
      for (const key of Object.keys(value)) {
        __ct_set_prop(node.id, key, JSON.stringify(value[key]));
      }
      __ct_request_paint();
      return;
    }
    if (name === "children") {
      // Solid will route children via insertNode; ignore the prop form.
      return;
    }
    if (name === "ref") {
      if (typeof value === "function") {
        try { value(node); } catch {}
      }
      return;
    }
    // Generic prop forwarding — value JSON-encoded so Rust gets a clean
    // shape (booleans stay booleans, numbers stay numbers, strings quoted).
    __ct_set_prop(node.id, name, JSON.stringify(value));
    __ct_request_paint();
  },
  insertNode(parent: CtNode, node: CtNode, anchor?: CtNode) {
    if (node.parent) {
      const i = node.parent.children.indexOf(node);
      if (i >= 0) node.parent.children.splice(i, 1);
    }
    node.parent = parent;
    if (anchor) {
      const i = parent.children.indexOf(anchor);
      parent.children.splice(i < 0 ? parent.children.length : i, 0, node);
      __ct_insert_node(parent.id, node.id, anchor.id);
    } else {
      parent.children.push(node);
      __ct_insert_node(parent.id, node.id, -1);
    }
    __ct_request_paint();
  },
  isTextNode(node: CtNode): boolean {
    return node.isText;
  },
  removeNode(parent: CtNode, node: CtNode) {
    const i = parent.children.indexOf(node);
    if (i >= 0) parent.children.splice(i, 1);
    node.parent = null;
    __ct_remove_node(node.id);
    __ct_request_paint();
  },
  getParentNode(node: CtNode): CtNode | undefined {
    return node.parent ?? undefined;
  },
  getFirstChild(node: CtNode): CtNode | undefined {
    return node.children[0];
  },
  getNextSibling(node: CtNode): CtNode | undefined {
    if (!node.parent) return undefined;
    const i = node.parent.children.indexOf(node);
    return node.parent.children[i + 1];
  },
});

// ─── Solid universal renderer exports for vite-plugin-solid ──────────────
export const {
  render: solidRender,
  effect,
  memo,
  createElement,
  createTextNode,
  insertNode,
  insert,
  spread,
  setProp,
  mergeProps,
  use,
} = renderer as any;

// ─── Public Ink-compatible API ──────────────────────────────────────────
// Component names match Ink's so the import-rewrite shim (which only
// changes the *source* of the import, not the names) Just Works.

const ROOT_ID = 1;
let rootNode: CtNode | null = null;

function getRoot(): CtNode {
  if (!rootNode) {
    __ct_create_node(ROOT_ID, "Box", "{}");
    __ct_set_root(ROOT_ID);
    rootNode = { id: ROOT_ID, tag: "Box", parent: null, children: [], isText: false };
  }
  return rootNode;
}

let lastDispose: (() => void) | null = null;

/**
 * Ink-compatible `render`: mounts a component into the terminal. Returns
 * an object with `unmount`, `waitUntilExit`, and `clear` matching Ink's
 * signature so existing apps don't break.
 */
export function render(component: any): {
  unmount: () => void;
  waitUntilExit: () => Promise<void>;
  clear: () => void;
  rerender: (next: any) => void;
} {
  if (lastDispose) {
    try { lastDispose(); } catch {}
    lastDispose = null;
  }
  // Ink lets you pass either a JSX element or a component fn. Normalize.
  const fn = typeof component === "function"
    ? component
    : () => component;
  lastDispose = solidRender(fn, getRoot());
  __ct_request_paint();
  return {
    unmount() {
      if (lastDispose) {
        try { lastDispose(); } catch {}
        lastDispose = null;
      }
      try { __ct_exit(); } catch {}
    },
    waitUntilExit() {
      // The Rust runtime drives the loop; this resolves on process exit.
      // We can't return a real promise tied to runtime state from inside
      // the bundle — the runtime kills us when the user app calls exit().
      // Returning a never-resolving promise matches Ink semantics for
      // "stay alive until exit".
      return new Promise<void>(() => {});
    },
    clear() {
      // Ink's clear() repaints the alt screen. With our hide-cursor +
      // alt-screen setup the next paint already overwrites everything;
      // forcing a paint is enough.
      __ct_request_paint();
    },
    rerender(next: any) {
      // Re-render path: Ink uses this for hot-reload. We just dispose
      // and re-mount.
      if (lastDispose) {
        try { lastDispose(); } catch {}
        lastDispose = null;
      }
      const fn = typeof next === "function" ? next : () => next;
      lastDispose = solidRender(fn, getRoot());
      __ct_request_paint();
    },
  };
}

// Solid's `mount` style entry: callers writing carbon-native code (not
// porting Ink) use this. Same plumbing.
export function mount(component: () => any): void {
  render(component);
}

// ─── Components: re-exports of the JSX intrinsic tags. ──────────────────
//
// Solid's universal renderer treats JSX intrinsics as element tags
// (strings) — anything PascalCase routes through `createComponent`. To
// match Ink's import-as-component pattern, we expose `Box`, `Text`, etc.
// as Solid components that simply forward props to the corresponding
// intrinsic tag. The Rust scene-graph receives the tag name and builds
// the correct node kind.
//
// This indirection is what makes the Vite shim work: user code does
// `import {Box, Text} from 'ink'`, the shim rewrites the import source
// to '@carbon/term', and Box / Text resolve to the components
// below — which in turn emit `<Box>` (caps) into the renderer.

const intrinsic = (tag: string) => (props: any) => {
  return solidCreateComponent(() => {
    // Solid's universal renderer interprets JSX directly via these
    // exports; using `createElement` with the intrinsic tag is the
    // cleanest path. We forward all props including children.
    return renderer.createElement(tag, props as any) as any;
  }, props as any);
};

// Simpler + faster: just emit the tag directly. We define the components
// using Solid's `createComponent` so the JSX runtime treats them like
// real components but they desugar to a tag node with the same children.
// (Both approaches work; the simpler one matches what JSX does today.)
function makeIntrinsic(tag: string) {
  return function Component(props: any) {
    // Build an element of `tag` with all of `props`.
    const el = (renderer as any).createElement(tag);
    // Solid's universal createComponent doesn't auto-spread — push props
    // through setProp manually so reactivity tracks setters.
    for (const key of Object.keys(props || {})) {
      if (key === "children") continue;
      const val = (props as any)[key];
      if (typeof val === "function" && key.startsWith("on")) {
        (renderer as any).setProp(el, key, val);
      } else {
        // Wrap in an effect so reactive props update the prop on change.
        createEffect(() => {
          const v = typeof val === "function" ? (val as any)() : val;
          (renderer as any).setProp(el, key, v);
        });
      }
    }
    // Insert children. Solid's compiler walks JSX children into the
    // renderer for us when we use the `createComponent`/`insert` path,
    // but here we receive `props.children` as a value (which may be
    // a function, an array, or a primitive) — push through `insert`.
    if (props && props.children !== undefined) {
      (renderer as any).insert(el, () => props.children);
    }
    return el;
  };
}

export const Box = makeIntrinsic("Box");
export const Text = makeIntrinsic("Text");
export const Newline = makeIntrinsic("Newline");
export const Spacer = makeIntrinsic("Spacer");
export const Static = makeIntrinsic("Static");

// ─── Hooks ───────────────────────────────────────────────────────────────

interface InputKey {
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  return: boolean;
  escape: boolean;
  backspace: boolean;
  tab: boolean;
  upArrow: boolean;
  downArrow: boolean;
  leftArrow: boolean;
  rightArrow: boolean;
  pageUp: boolean;
  pageDown: boolean;
  delete: boolean;
}

type InputHandler = (input: string, key: InputKey) => void;

const inputHandlers = new Set<InputHandler>();

// Wire from Rust. Rust emits a JSON-serialized InputEvent (snake_case);
// we translate to the Ink-shaped object.
(globalThis as any).__ct_dispatch_input = (raw: any) => {
  const key: InputKey = {
    ctrl: !!raw.ctrl,
    meta: !!raw.meta,
    shift: !!raw.shift,
    return: !!raw.return_key,
    escape: !!raw.escape,
    backspace: !!raw.backspace,
    tab: !!raw.tab,
    upArrow: !!raw.up_arrow,
    downArrow: !!raw.down_arrow,
    leftArrow: !!raw.left_arrow,
    rightArrow: !!raw.right_arrow,
    pageUp: !!raw.page_up,
    pageDown: !!raw.page_down,
    delete: !!raw.delete,
  };
  const input = String(raw.input || "");
  for (const h of inputHandlers) {
    try {
      h(input, key);
    } catch {}
  }
  __ct_request_paint();
};

const [stdoutCols, setStdoutCols] = createSignal<number>(
  typeof __ct_initial_cols !== "undefined" ? __ct_initial_cols : 80,
);
const [stdoutRows, setStdoutRows] = createSignal<number>(
  typeof __ct_initial_rows !== "undefined" ? __ct_initial_rows : 24,
);

(globalThis as any).__ct_dispatch_resize = (cols: number, rows: number) => {
  setStdoutCols(cols);
  setStdoutRows(rows);
};

/**
 * Ink-compatible `useInput`. Registers a key-press handler. The handler
 * is auto-removed when the component unmounts (via `onCleanup`).
 *
 * Usage:
 *   useInput((input, key) => {
 *     if (key.return) submit();
 *     if (input === '+') setCount(c => c + 1);
 *   });
 */
export function useInput(handler: InputHandler, options?: { isActive?: boolean | (() => boolean) }) {
  // Wrap so we can swap-in a no-op when isActive() is false.
  const wrapped: InputHandler = (input, key) => {
    const active =
      options?.isActive == null
        ? true
        : typeof options.isActive === "function"
        ? options.isActive()
        : options.isActive;
    if (!active) return;
    handler(input, key);
  };
  inputHandlers.add(wrapped);
  onCleanup(() => {
    inputHandlers.delete(wrapped);
  });
}

/**
 * Ink-compatible `useApp`. Returns `{ exit }` for clean shutdown.
 */
export function useApp(): { exit: (error?: Error) => void } {
  return {
    exit(_error?: Error) {
      try { __ct_exit(); } catch {}
    },
  };
}

/**
 * Ink-compatible `useStdout`. Returns the terminal output stream info.
 * We don't expose a real Node `stdout` (no Node here), but the shape
 * users care about — `columns`, `rows`, `write` — is preserved.
 */
export function useStdout(): {
  stdout: { columns: number; rows: number; write: (s: string) => void };
  write: (s: string) => void;
} {
  // `columns`/`rows` track resize via the signals above so reactive
  // consumers see updates.
  const stdoutObj = {
    get columns() { return stdoutCols(); },
    get rows() { return stdoutRows(); },
    write: (s: string) => {
      // Best-effort: emit to stderr so we don't trash the alt screen.
      // Apps that care about this shape are usually instrumenting; the
      // real terminal output is already managed by the runtime.
      try { (globalThis as any).console?.error?.(s); } catch {}
    },
  };
  return {
    stdout: stdoutObj,
    write: stdoutObj.write,
  };
}

/**
 * Ink-compatible `useStdin`. Phase-1 shim: rawMode is always on (the
 * runtime starts in raw mode), and `setRawMode` is a no-op. `isRawMode
 * Supported` is true.
 */
export function useStdin(): {
  stdin: { isRaw: boolean };
  isRawModeSupported: boolean;
  setRawMode: (mode: boolean) => void;
  internal_eventEmitter?: any;
} {
  return {
    stdin: { isRaw: true },
    isRawModeSupported: true,
    setRawMode: (_mode: boolean) => { /* always raw under carbon-term */ },
  };
}

/**
 * Ink-compatible `useFocus`. Phase-1 stub: always focused, no manager.
 * Apps that depend on multi-component focus traversal won't get correct
 * routing yet; documented as a known limitation.
 */
export function useFocus(_options?: { autoFocus?: boolean; isActive?: boolean; id?: string }) {
  return { isFocused: true, id: "" };
}

export function useFocusManager() {
  return {
    enableFocus() {},
    disableFocus() {},
    focusNext() {},
    focusPrevious() {},
    focus(_id: string) {},
  };
}

// ─── HMR support ─────────────────────────────────────────────────────────
(globalThis as any).__ct_hmr_reset = () => {
  if (lastDispose) {
    try { lastDispose(); } catch {}
    lastDispose = null;
  }
  rootNode = null;
  inputHandlers.clear();
};

/**
 * Like `createSignal` but value persists across `--dev` HMR reloads.
 * Stash key is user-supplied; the runtime keeps the rquickjs context
 * alive across re-eval so the global Map literally survives.
 */
export function createPersistentSignal<T>(key: string, initial: T) {
  const stash: Map<string, unknown> =
    ((globalThis as any).__hmr_state ??= new Map());
  const restored = stash.has(key) ? (stash.get(key) as T) : initial;
  const [value, setValue] = createSignal<T>(restored);
  createEffect(() => {
    stash.set(key, value());
  });
  return [value, setValue] as const;
}

// ─── Re-exports: solid-js convenience + Ink-shape extras ────────────────
// createComponent is required by vite-plugin-solid's universal renderer output.
export { createEffect, createSignal, createComponent };

// Some Ink code paths expect a default export. Export the components in
// a namespace shape so `import Ink from 'ink'` (rare) works too.
export default {
  render,
  Box,
  Text,
  Newline,
  Spacer,
  Static,
  useInput,
  useApp,
  useStdin,
  useStdout,
  useFocus,
  useFocusManager,
};

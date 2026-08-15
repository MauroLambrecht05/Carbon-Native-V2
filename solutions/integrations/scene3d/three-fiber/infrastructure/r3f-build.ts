// @carbon/three-fiber / r3f-build.ts
//
// Runtime side of the @carbon/vite-three-bridge contract.
//
// The plugin compiles `<Canvas>` JSX subtrees into a builder function:
//
//     (h) => [
//       h("mesh", { "rotation-y": () => angle() }, [
//         h("boxGeometry", { args: () => [1,1,1] }, []),
//         h("meshStandardMaterial", { color: () => "hotpink" }, []),
//       ]),
//     ]
//
// This file owns `h`. It walks the (possibly nested) tree of `h` calls,
// constructs three.js objects via the three-fiber renderer's primitives
// (createElement / setProp / insertNode), and wires reactivity through
// Solid's createEffect (so signal-driven thunks like `() => angle()`
// re-run on signal change and mutate the scene in place).
//
// Why a separate module from Canvas.tsx:
//   - Clear seam for tests (test r3fBuild on its own without spinning up
//     a full Canvas / rAF loop / executor stack).
//   - Smaller surface for the babel plugin to depend on conceptually
//     (`r3fBuild` is just one prop; the rest of Canvas's API is unchanged).

import { createEffect } from "solid-js";
import * as THREE from "three";
import {
  createThreeFiberRenderer,
  wrapAsNode,
  type ThreeFiberRenderer,
  type ThreeNode,
} from "./renderer.js";

/** A per-element call emitted by the babel plugin: [tag, props, children]. */
export type R3FCall = [
  tag: string | ((props: any) => any),
  props: Record<string, any>,
  children: R3FChild[],
];

/** Children in a builder result are mixed: full element calls, fragment
 *  splices, expression-thunks (returning anything renderable), or strings. */
export type R3FChild = R3FCall | (() => any) | string | null | undefined;

/** Builder function shape the plugin emits. The `h` arg is supplied by us. */
export type R3FBuilder = (
  h: (
    tag: string | ((props: any) => any),
    props: Record<string, any>,
    children: R3FChild[],
  ) => R3FCall,
) => R3FChild[];

// The `h` function is purely a structural wrapper — it just collects its
// arguments into a tuple. All the heavy lifting (constructing three.js
// objects, applying props, etc.) happens in renderCall below.
const h = (
  tag: string | ((props: any) => any),
  props: Record<string, any>,
  children: R3FChild[],
): R3FCall => [tag, props, children];

/**
 * Run a builder produced by the carbon-three-bridge babel plugin and
 * insert the constructed nodes into `parent` (typically the Canvas's
 * THREE.Scene). Reactive thunks in the props re-run inside Solid effects
 * so signal-driven JSX stays reactive.
 *
 * Returns a dispose fn that tears down the entire subtree.
 */
export function runR3FBuild(
  builder: R3FBuilder,
  tfr: ThreeFiberRenderer,
  scene: THREE.Scene,
): () => void {
  const root = wrapAsNode(scene);
  const rootCalls = builder(h);
  // Build the inner tree synchronously (under the caller's reactive owner).
  // Each call's reactive props register their own createEffect, so signal
  // changes will mutate three.js state in place over time.
  const cleanups: Array<() => void> = [];
  for (const call of rootCalls) {
    if (call == null) continue;
    if (typeof call === "function") {
      // Expression thunk at the top level: re-run inside an effect, build
      // whatever element-shaped value comes back.
      createEffect(() => {
        const v = (call as () => any)();
        spliceDynamic(v, root, tfr, cleanups);
      });
      continue;
    }
    if (typeof call === "string") continue; // ignore stray text
    insertCall(call as R3FCall, root, tfr, cleanups);
  }

  return () => {
    for (let i = cleanups.length - 1; i >= 0; i--) {
      try { cleanups[i](); } catch {}
    }
  };
}

/** Insert one R3FCall under `parent` and recurse into its children. */
function insertCall(
  call: R3FCall,
  parent: ThreeNode,
  tfr: ThreeFiberRenderer,
  cleanups: Array<() => void>,
): ThreeNode | null {
  const [tag, props, children] = call;

  // Fragment marker emitted by the plugin for JSXFragments.
  if (tag === "__fragment") {
    for (const ch of children) {
      if (ch == null) continue;
      if (typeof ch === "function") {
        createEffect(() => {
          const v = (ch as () => any)();
          spliceDynamic(v, parent, tfr, cleanups);
        });
        continue;
      }
      if (typeof ch === "string") continue;
      insertCall(ch as R3FCall, parent, tfr, cleanups);
    }
    return null;
  }

  // Component factories (uppercase identifiers): call them with the
  // resolved (non-thunked) props and splice the result. This lets users
  // write components that themselves return r3f-built subtrees.
  if (typeof tag === "function") {
    const resolved: Record<string, any> = {};
    for (const k of Object.keys(props)) {
      const v = props[k];
      resolved[k] = typeof v === "function" ? (v as () => any)() : v;
    }
    // Children are passed through as-is; component is responsible for
    // splatting them via h() if it wants three-fiber rendering.
    if (children.length > 0) resolved.children = children;
    let out: any;
    try { out = tag(resolved); } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[@carbon/three-fiber] component threw inside Canvas:", err);
      return null;
    }
    if (out == null) return null;
    if (Array.isArray(out)) {
      for (const it of out) {
        if (Array.isArray(it)) insertCall(it as R3FCall, parent, tfr, cleanups);
      }
    } else if (Array.isArray(out)) {
      // (above)
    } else if (Array.isArray((out as any))) {
      // unreachable
    } else if (typeof out === "object" && Array.isArray(out)) {
      // unreachable
    }
    return null;
  }

  // String tag (lowercase intrinsic).
  const tagName = tag as string;
  const node = tfr.createElement(tagName);

  // Apply initial props. Each value is either a thunk (reactive) or a
  // constant.
  //
  // For thunks we do BOTH:
  //   (a) Apply the value eagerly once. This is essential for two reasons:
  //       1. In environments where solid's `createEffect` is a no-op (the
  //          server build that bun:test loads by default), reactivity is
  //          off — but at least the initial value still lands.
  //       2. The three-fiber renderer needs `args` available BEFORE
  //          insertNode (factory call). createEffect-only application
  //          would let insertNode fire with no args and we'd lose the
  //          initial construction values.
  //   (b) Register an effect that re-applies the value when the thunk
  //       re-runs (signal-driven update path).
  //
  // The effect runs once on registration too, which double-applies — but
  // setProp is idempotent (in-place mutation against a stable three.js
  // object), so the duplicate call is cheap and correct.
  for (const k of Object.keys(props)) {
    if (k.startsWith("__spread")) {
      const fn = props[k];
      if (typeof fn === "function") {
        // Eager pass.
        try {
          const obj = (fn as () => any)();
          if (obj && typeof obj === "object") {
            for (const sk of Object.keys(obj)) {
              (tfr as any).setProp(node, sk, obj[sk]);
            }
          }
        } catch {}
        // Reactive pass.
        createEffect(() => {
          let obj: any;
          try { obj = (fn as () => any)(); } catch { return; }
          if (!obj || typeof obj !== "object") return;
          for (const sk of Object.keys(obj)) {
            (tfr as any).setProp(node, sk, obj[sk]);
          }
        });
      }
      continue;
    }
    const val = props[k];
    if (typeof val === "function" && (val as any).length === 0) {
      const captureKey = k;
      const captureFn = val as () => any;
      // Eager: apply the initial value before insertNode happens (below).
      try {
        (tfr as any).setProp(node, captureKey, captureFn());
      } catch {}
      // Reactive: re-apply on signal change.
      createEffect(() => {
        let v: any;
        try { v = captureFn(); } catch { return; }
        (tfr as any).setProp(node, captureKey, v);
      });
    } else {
      (tfr as any).setProp(node, k, val);
    }
  }

  // Insert before recursing into children — three-fiber's renderer wants
  // the parent established for child attachment ("geometry"/"material"
  // attachTo modes need the parent's three.js object).
  tfr.insertNode(parent, node);
  cleanups.push(() => {
    try { tfr.removeNode(parent, node); } catch {}
  });

  // Recurse into children.
  for (const ch of children) {
    if (ch == null) continue;
    if (typeof ch === "function") {
      // Dynamic child slot: re-run in an effect, splice on each change.
      // Every invocation we tear down the previous splice + build new.
      let prev: ThreeNode[] = [];
      createEffect(() => {
        for (const p of prev) {
          try { tfr.removeNode(node, p); } catch {}
        }
        prev = [];
        const v = (ch as () => any)();
        spliceDynamic(v, node, tfr, cleanups, prev);
      });
      continue;
    }
    if (typeof ch === "string") continue;
    insertCall(ch as R3FCall, node, tfr, cleanups);
  }

  return node;
}

/**
 * Insert a "dynamic" value — the runtime result of a JSXExpressionContainer
 * inside a Canvas subtree. Accepted shapes:
 *   - undefined / null / boolean / string / number : no-op
 *   - R3FCall (a [tag, props, children] tuple)     : insert
 *   - array of mixed (R3FCall | thunk | scalar)    : recurse on each
 *   - function (a thunk that itself returns one of the above) : run, recurse
 */
function spliceDynamic(
  v: any,
  parent: ThreeNode,
  tfr: ThreeFiberRenderer,
  cleanups: Array<() => void>,
  trackInserted?: ThreeNode[],
): void {
  if (v == null || typeof v === "boolean") return;
  if (typeof v === "string" || typeof v === "number") return;
  if (typeof v === "function") {
    spliceDynamic(v(), parent, tfr, cleanups, trackInserted);
    return;
  }
  if (Array.isArray(v) && v.length === 3 && (typeof v[0] === "string" || typeof v[0] === "function") && v[1] && typeof v[1] === "object" && Array.isArray(v[2])) {
    // Heuristic: looks like an R3FCall tuple.
    const inserted = insertCall(v as R3FCall, parent, tfr, cleanups);
    if (inserted && trackInserted) trackInserted.push(inserted);
    return;
  }
  if (Array.isArray(v)) {
    for (const item of v) {
      spliceDynamic(item, parent, tfr, cleanups, trackInserted);
    }
    return;
  }
  // Unknown shape — silently ignore.
}

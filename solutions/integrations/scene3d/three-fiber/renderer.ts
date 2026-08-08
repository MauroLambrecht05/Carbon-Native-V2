// @carbon/three-fiber / renderer.ts
//
// A Solid universal renderer that constructs three.js objects from JSX
// intrinsics and attaches them into a parent three.js scene tree. The
// `Canvas` component spins up one of these renderers per `<Canvas>`
// instance, with the THREE.Scene as the root node.
//
// We do NOT use the @carbon/mini-solid's renderer here — that one talks
// to the Rust scene graph. The three.js tree is a separate world that
// lives entirely in JS memory and is consumed (read) by `CarbonRenderer`
// every frame in the rAF loop.
//
// Key design choices:
//   * One physical Solid renderer per Canvas — each has its own root.
//     Multiple canvases on the same page therefore each get their own
//     three.js scene, no cross-talk.
//   * Refs and reactivity: solid's universal renderer turns reactive
//     prop reads into setProperty calls, which we route through
//     `applyProp`. The three.js object is mutated in place so identity
//     stays stable across renders.
//   * Anchor-based ordering: we keep a children array on the wrapper
//     node so insert-before semantics map cleanly onto Object3D.children
//     without needing splice on a foreign array.

import * as THREE from "three";
import { createRenderer as createSolidRenderer } from "solid-js/universal";
import { applyInitialProps, applyProp, getIntrinsicSpec, type AttachTo } from "./intrinsics.js";

// ─── Wrapper node ─────────────────────────────────────────────────────────
// Solid's universal renderer wants a single node type. We can't use
// THREE.Object3D directly because we also need to represent geometries,
// materials, text nodes (no-ops), and a synthetic root. So we wrap.
//
// `obj`: the underlying three.js thing (Object3D | BufferGeometry |
//        Material | Scene | null for the synthetic root or text nodes).
// `attach`: where on the parent does this object slot in?
// `parent`/`children`: kept by the renderer for traversal helpers
//        (`getFirstChild`, `getNextSibling`).
export interface ThreeNode {
  tag: string;
  obj: any;
  attach: AttachTo;
  isText: boolean;
  parent: ThreeNode | null;
  children: ThreeNode[];
  // Cache of pending props captured before mount, so the initial set is
  // applied as a batch right after construction. Solid hands props to us
  // in any order, so we can't apply them too eagerly without risking
  // out-of-order mutation (e.g., `args` arriving after `position`).
  initialProps?: Record<string, any>;
  // True once the node has been inserted into a parent and we've applied
  // the buffered initialProps. After this, prop changes go through
  // `applyProp` directly.
  mounted: boolean;
  // For materials/geometries — backref to the parent that "owns" us via
  // .geometry or .material. Lets us cleanly detach on removal.
  ownerParent?: ThreeNode | null;
}

// Wrap an existing three.js object as a node — used for the Scene root
// and anytime user code feeds a pre-built object via `<primitive object={obj} />`.
export function wrapAsNode(obj: any, attach: AttachTo = "child"): ThreeNode {
  return {
    tag: "primitive",
    obj,
    attach,
    isText: false,
    parent: null,
    children: [],
    mounted: true,
  };
}

// Lazy construct a node's three.js object using its registered factory.
// Idempotent — subsequent calls are no-ops once `node.obj` exists.
// `text` / `root` / `primitive` are never constructed by us.
function ensureConstructed(node: ThreeNode): void {
  if (node.obj) return;
  if (node.tag === "text" || node.tag === "root" || node.tag === "primitive") {
    return;
  }
  const spec = getIntrinsicSpec(node.tag);
  if (!spec) return;
  const args = (node.initialProps && node.initialProps.args) ?? [];
  try {
    node.obj = spec.factory(Array.isArray(args) ? args : [args]);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[@carbon/three-fiber] Failed to construct <${node.tag}>:`,
      err
    );
  }
}

function newRoot(scene: THREE.Scene): ThreeNode {
  return {
    tag: "root",
    obj: scene,
    attach: "child",
    isText: false,
    parent: null,
    children: [],
    mounted: true,
  };
}

// ─── Helpers: attach / detach against parent ──────────────────────────────
function attachToParent(parent: ThreeNode, child: ThreeNode): void {
  if (!child.obj) return;
  // Buffered props were waiting for the object to be live — apply now.
  if (!child.mounted && child.initialProps) {
    applyInitialProps(child.obj, child.initialProps);
    child.initialProps = undefined;
    child.mounted = true;
  }
  switch (child.attach) {
    case "child": {
      const p = parent.obj;
      // Cameras need to live in the scene tree so their world matrix gets
      // updated, but Canvas swaps the active camera explicitly via context.
      // Either way, just .add() — three handles parent.children.
      if (p && typeof p.add === "function") {
        p.add(child.obj);
      }
      break;
    }
    case "geometry": {
      // Attach to parent.geometry. The previous geometry, if any and if
      // this new one isn't it, gets disposed by the user's setter logic
      // — three doesn't dispose automatically, but neither does r3f. We
      // dispose only on removeNode.
      if (parent.obj) parent.obj.geometry = child.obj;
      child.ownerParent = parent;
      break;
    }
    case "material": {
      if (parent.obj) parent.obj.material = child.obj;
      child.ownerParent = parent;
      break;
    }
  }
}

function detachFromParent(parent: ThreeNode, child: ThreeNode): void {
  if (!child.obj) return;
  switch (child.attach) {
    case "child": {
      const p = parent.obj;
      if (p && typeof p.remove === "function") {
        p.remove(child.obj);
      }
      // Dispose object resources when possible. Geometries/materials on
      // a removed Object3D aren't auto-disposed (we leave that to the
      // user's `dispose-on-unmount` hook), but textures/render targets
      // owned by us… we don't own any. So just rely on the GC.
      break;
    }
    case "geometry": {
      if (parent.obj && parent.obj.geometry === child.obj) {
        parent.obj.geometry = null;
      }
      // Geometries DO have a dispose() — call it so vertex buffers are
      // released by three. Mirrors r3f behavior.
      if (typeof child.obj.dispose === "function") {
        try { child.obj.dispose(); } catch {}
      }
      break;
    }
    case "material": {
      if (parent.obj && parent.obj.material === child.obj) {
        parent.obj.material = null;
      }
      if (typeof child.obj.dispose === "function") {
        try { child.obj.dispose(); } catch {}
      }
      break;
    }
  }
}

// ─── Renderer factory ─────────────────────────────────────────────────────
// Each `<Canvas>` gets its own renderer instance so the root scene + node
// state is isolated. The factory returns the renderer's primitives plus a
// helper to mount a component into the scene root.
export interface ThreeFiberRenderer {
  render: (code: () => any, root: ThreeNode) => () => void;
  effect: <T>(fn: (prev?: T) => T, init?: T) => void;
  memo: <T>(fn: () => T, equal: boolean) => () => T;
  createComponent: <T>(Comp: (props: T) => any, props: T) => any;
  createElement: (tag: string) => ThreeNode;
  createTextNode: (value: string) => ThreeNode;
  insertNode: (parent: ThreeNode, node: ThreeNode, anchor?: ThreeNode) => void;
  insert: <T>(parent: any, accessor: (() => T) | T, marker?: any | null, initial?: any) => any;
  spread: <T>(node: any, accessor: (() => T) | T, skipChildren?: boolean) => void;
  setProp: <T>(node: ThreeNode, name: string, value: T, prev?: T) => T;
  mergeProps: (...sources: unknown[]) => unknown;
  use: <A, T>(fn: (element: ThreeNode, arg: A) => T, element: ThreeNode, arg: A) => T;
  // Exposed by us, in addition to the surface Solid's createRenderer
  // returns. Solid uses removeNode internally (via cleanChildren) and
  // doesn't re-export it; for tests + imperative callers we surface it.
  removeNode: (parent: ThreeNode, node: ThreeNode) => void;
  // ours
  mount: (component: () => any, scene: THREE.Scene) => () => void;
}

// Externalized removeNode handler so we can also surface it on the
// renderer object (Solid's createRenderer doesn't re-export removeNode,
// but tests + imperative callers want it).
function removeNodeImpl(parent: ThreeNode, node: ThreeNode): void {
  const i = parent.children.indexOf(node);
  if (i >= 0) parent.children.splice(i, 1);
  node.parent = null;
  detachFromParent(parent, node);
  // Also dispose materials/geometries hanging off a removed Mesh.
  // r3f does this; the user can opt out via attach=null but our simple
  // model assumes ownership.
  if (node.obj && node.attach === "child") {
    const o = node.obj;
    if (o.geometry && typeof o.geometry.dispose === "function") {
      try { o.geometry.dispose(); } catch {}
    }
    if (o.material) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (m && typeof m.dispose === "function") {
          try { m.dispose(); } catch {}
        }
      }
    }
  }
}

export function createThreeFiberRenderer(): ThreeFiberRenderer {
  const renderer = createSolidRenderer<ThreeNode>({
    createElement(tag: string): ThreeNode {
      // Special tags
      if (tag === "primitive") {
        // <primitive object={...} /> — built around an existing object.
        // We don't know the object yet (it arrives as a prop), so create
        // a placeholder; setProperty("object", value) will populate it.
        return {
          tag,
          obj: null,
          attach: "child",
          isText: false,
          parent: null,
          children: [],
          initialProps: {},
          mounted: false,
        };
      }
      const spec = getIntrinsicSpec(tag);
      if (!spec) {
        // Unknown intrinsic — produce an inert node so the rest of the
        // tree still works. Helpful when a typo doesn't crash the whole app.
        // eslint-disable-next-line no-console
        console.warn(`[@carbon/three-fiber] Unknown intrinsic <${tag}> — rendering as no-op.`);
        return {
          tag,
          obj: null,
          attach: "child",
          isText: false,
          parent: null,
          children: [],
          initialProps: {},
          mounted: false,
        };
      }
      // We can't construct yet because `args` arrives via setProperty
      // AFTER createElement. Defer the factory call until insertNode time
      // — that's when all initial props are guaranteed to be present.
      return {
        tag,
        obj: null,
        attach: spec.attachTo,
        isText: false,
        parent: null,
        children: [],
        initialProps: {},
        mounted: false,
      };
    },

    createTextNode(_value: string): ThreeNode {
      // Text doesn't render in three. We keep the node for tree shape.
      return {
        tag: "text",
        obj: null,
        attach: "child",
        isText: true,
        parent: null,
        children: [],
        mounted: true,
      };
    },

    replaceText(_textNode: ThreeNode, _value: string): void {
      // Text has no rendering surface here.
    },

    setProperty(node: ThreeNode, name: string, value: any): void {
      // Special: <primitive object={...} /> — when we get the `object`
      // prop, swap our wrapper in and apply any buffered props.
      if (node.tag === "primitive" && name === "object") {
        node.obj = value;
        if (node.initialProps) {
          applyInitialProps(node.obj, node.initialProps);
          node.initialProps = undefined;
        }
        node.mounted = true;
        return;
      }
      if (!node.mounted) {
        // Buffer until insertNode actually constructs the object.
        (node.initialProps ??= {})[name] = value;
        return;
      }
      if (!node.obj) return;
      applyProp(node.obj, name, value);
    },

    insertNode(parent: ThreeNode, node: ThreeNode, anchor?: ThreeNode): void {
      // Lazy-construct now that we have all initial props (specifically
      // `args`). For unknown tags / text nodes / primitives without an
      // object yet, `node.obj` stays null and attach is a no-op.
      ensureConstructed(node);
      // The parent might also still be unconstructed — solid's universal
      // renderer can land grandchildren before the parent is inserted.
      // Construct the parent eagerly so attach can succeed; it'll be
      // re-attached harmlessly when its own insertNode fires.
      ensureConstructed(parent);

      // Maintain our wrapper-tree shape so getFirstChild / getNextSibling
      // work. (Solid relies on these for portals, arrays, suspense.)
      if (node.parent) {
        const i = node.parent.children.indexOf(node);
        if (i >= 0) node.parent.children.splice(i, 1);
      }
      node.parent = parent;
      if (anchor) {
        const i = parent.children.indexOf(anchor);
        parent.children.splice(i < 0 ? parent.children.length : i, 0, node);
      } else {
        parent.children.push(node);
      }

      // Now plug into the parent three.js object.
      attachToParent(parent, node);
    },

    isTextNode(node: ThreeNode): boolean {
      return node.isText;
    },

    removeNode: removeNodeImpl,

    getParentNode(node: ThreeNode): ThreeNode | undefined {
      return node.parent ?? undefined;
    },
    getFirstChild(node: ThreeNode): ThreeNode | undefined {
      return node.children[0];
    },
    getNextSibling(node: ThreeNode): ThreeNode | undefined {
      if (!node.parent) return undefined;
      const i = node.parent.children.indexOf(node);
      return node.parent.children[i + 1];
    },
  });

  function mount(component: () => any, scene: THREE.Scene): () => void {
    const root = newRoot(scene);
    return (renderer as any).render(component, root);
  }

  return {
    ...(renderer as any),
    removeNode: removeNodeImpl,
    mount,
  } as ThreeFiberRenderer;
}

export { newRoot };

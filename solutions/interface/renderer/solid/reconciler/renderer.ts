// The Solid universal renderer, bound to the scene-graph host imports.
//
// `createRenderer` takes one config object of ~10 hooks; everything with a
// body here delegates outward — node creation to scene/node.ts, pointer
// handlers to scene/events.ts, tweening to scene/transitions.ts, the wgpu
// surface to intrinsics/canvas.ts. What is left is the mapping itself.

import { createRenderer } from "solid-js/universal";

import "../host/imports.ts";
import { freshNode, nodeTexts, type CmNode } from "../scene/node.ts";
import {
  clickHandlers,
  hasAnyPointerHandler,
  pointerDownHandlers,
  pointerMoveHandlers,
  pointerUpHandlers,
  registerPointerHandler,
} from "../scene/events.ts";
import {
  maybeStartTransition,
  parseTransition,
  recordAppliedValue,
  setAnimation,
  transitionConfig,
} from "../scene/transitions.ts";
import { applySceneStyleProp } from "../scene/css-vars.ts";
import { canvasReadyHandlers, ensureCanvasSurface } from "../intrinsics/canvas.ts";

// ─── Renderer: maps Solid's universal API onto our scene-graph host imports
const renderer = createRenderer<CmNode>({
  createElement(tag: string): CmNode {
    return freshNode(tag);
  },
  createTextNode(value: string): CmNode {
    const n = freshNode("text", true);
    const strValue = String(value);
    __cm_set_text(n.id, strValue);
    nodeTexts.set(n.id, strValue);
    return n;
  },
  replaceText(textNode: CmNode, value: string) {
    const strValue = String(value);
    __cm_set_text(textNode.id, strValue);
    nodeTexts.set(textNode.id, strValue);
    __cm_request_paint();
  },
  setProperty(node: CmNode, name: string, value: any) {
    // ── Canvas-specific props ──────────────────────────────────────
    // These intercepts fire for <canvas> nodes only; for everything
    // else they fall through to the generic setProperty path below.
    if (node.tag === "canvas") {
      if (name === "width" || name === "height") {
        const n = typeof value === "number" ? value : Number(value);
        if (Number.isFinite(n) && n > 0) {
          if (name === "width") node.canvasW = Math.round(n);
          else node.canvasH = Math.round(n);
          if (node.canvasId == null) {
            ensureCanvasSurface(node);
          } else if (node.canvasW != null && node.canvasH != null) {
            __carbon_canvas_resize(node.canvasId, node.canvasW, node.canvasH);
          }
          // Forward width/height to the scene node so taffy lays out the box.
          __cm_set_prop(node.id, name, String(name === "width" ? node.canvasW : node.canvasH));
          __cm_request_paint();
        }
        return;
      }
      // onReady({ id }): runs once when the wgpu surface is created.
      // The user uses `id` to call __carbon_canvas_clear etc. directly.
      if (name === "onReady") {
        if (typeof value === "function") {
          canvasReadyHandlers.set(node.id, value as any);
          // If the surface was already created (props came in a different
          // order), fire immediately.
          if (node.canvasId != null) {
            try { (value as any)({ id: node.canvasId }); } catch {}
          }
        } else {
          canvasReadyHandlers.delete(node.id);
        }
        return;
      }
      // ref={(el) => ...} — pass the CmNode (with `canvasId` set, if
      // available). Solid will call this synchronously during render.
      if (name === "ref") {
        if (typeof value === "function") {
          try { value(node); } catch {}
        }
        return;
      }
    }

    // Style: spread each rule as a separate scene prop.
    if (name === "style" && value && typeof value === "object") {
      for (const key of Object.keys(value)) {
        if (key === "transition") {
          transitionConfig.set(node.id, parseTransition(String(value[key])));
          continue;
        }
        if (key === "animation") {
          setAnimation(node, String(value[key]));
          continue;
        }
        // `--name: value` — defines a custom property (never
        // forwarded); consuming a `var(...)` reference happens inside
        // `applySceneStyleProp` for every OTHER key below.
        if (key.startsWith("--")) {
          applySceneStyleProp(node, key, value[key]);
          continue;
        }
        if (maybeStartTransition(node, key, value[key])) {
          recordAppliedValue(node.id, key, value[key]);
          continue;
        }
        applySceneStyleProp(node, key, value[key]);
        recordAppliedValue(node.id, key, value[key]);
      }
      __cm_request_paint();
      return;
    }
    // Standalone `transition` prop on the node — store it without
    // forwarding to the scene (carbon-mini doesn't paint anything for
    // the prop itself; it only triggers tweens on subsequent sets).
    if (name === "transition") {
      transitionConfig.set(node.id, parseTransition(String(value)));
      return;
    }
    // Standalone `animation` prop — same rationale as `transition` above.
    if (name === "animation") {
      setAnimation(node, String(value));
      return;
    }
    // Click: register handler + mark node clickable for hit-testing.
    if (name === "onClick" || name === "onclick") {
      if (typeof value === "function") {
        clickHandlers.set(node.id, value);
        __cm_set_prop(node.id, "clickable", "true");
      } else {
        clickHandlers.delete(node.id);
        if (!hasAnyPointerHandler(node.id)) {
          __cm_set_prop(node.id, "clickable", "false");
        }
      }
      return;
    }
    // Pointer events: onMouseDown / onMouseMove / onMouseUp.
    // We also flip the node `clickable` so it participates in hit-testing
    // — the Rust side dispatches based on the hit-test result, so without
    // this an onMouseDown-only node would never receive events.
    if (
      name === "onMouseDown" || name === "onmousedown" ||
      name === "onPointerDown" || name === "onpointerdown"
    ) {
      registerPointerHandler(node.id, pointerDownHandlers, value);
      return;
    }
    if (
      name === "onMouseMove" || name === "onmousemove" ||
      name === "onPointerMove" || name === "onpointermove"
    ) {
      registerPointerHandler(node.id, pointerMoveHandlers, value);
      return;
    }
    if (
      name === "onMouseUp" || name === "onmouseup" ||
      name === "onPointerUp" || name === "onpointerup"
    ) {
      registerPointerHandler(node.id, pointerUpHandlers, value);
      return;
    }
    // class — Tailwind plugin compiles to inline style; if a raw class string
    // arrives at runtime we just stash it as a prop for now (future: lookup
    // table). Doesn't crash; just won't visually apply.
    if (name === "class" || name === "className") {
      __cm_set_prop(node.id, "className", JSON.stringify(value));
      return;
    }
    // Animatable prop with an active transition spec — tween instead
    // of writing the new value immediately. Falls through to the
    // direct write otherwise.
    if (maybeStartTransition(node, name, value)) {
      recordAppliedValue(node.id, name, value);
      return;
    }
    // Generic: resolve any `var(...)` references, stringify, forward.
    applySceneStyleProp(node, name, value);
    recordAppliedValue(node.id, name, value);
    __cm_request_paint();
  },
  insertNode(parent: CmNode, node: CmNode, anchor?: CmNode) {
    if (node.parent) {
      const i = node.parent.children.indexOf(node);
      if (i >= 0) node.parent.children.splice(i, 1);
    }
    node.parent = parent;
    if (anchor) {
      const i = parent.children.indexOf(anchor);
      parent.children.splice(i < 0 ? parent.children.length : i, 0, node);
      __cm_insert_node(parent.id, node.id, anchor.id);
    } else {
      parent.children.push(node);
      __cm_insert_node(parent.id, node.id, -1);
    }
    __cm_request_paint();
  },
  isTextNode(node: CmNode): boolean {
    return node.isText;
  },
  removeNode(parent: CmNode, node: CmNode) {
    const i = parent.children.indexOf(node);
    if (i >= 0) parent.children.splice(i, 1);
    node.parent = null;
    // Tear down the wgpu surface if this was a <canvas> intrinsic.
    if (node.tag === "canvas" && node.canvasId != null) {
      __carbon_canvas_destroy(node.canvasId);
      node.canvasId = undefined;
    }
    canvasReadyHandlers.delete(node.id);
    __cm_remove_node(node.id);
    __cm_request_paint();
  },
  getParentNode(node: CmNode): CmNode | undefined {
    return node.parent ?? undefined;
  },
  getFirstChild(node: CmNode): CmNode | undefined {
    return node.children[0];
  },
  getNextSibling(node: CmNode): CmNode | undefined {
    if (!node.parent) return undefined;
    const i = node.parent.children.indexOf(node);
    return node.parent.children[i + 1];
  },
});

// ─── Public API: vite-plugin-solid emits JSX as calls to these names ─────
// Re-exporting from the renderer object — same identities Solid's compiler expects.
// (Solid's universal renderer exports `setProp`, not `setProperty`. We pass our
// `setProperty` config option to createRenderer; the renderer wraps it as `setProp`.)
export const {
  render,
  effect,
  memo,
  createComponent,
  createElement,
  createTextNode,
  insertNode,
  insert,
  spread,
  setProp,
  mergeProps,
  use,
} = renderer as any;

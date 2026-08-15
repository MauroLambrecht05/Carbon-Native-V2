// The react-reconciler HostConfig.
//
// The minimum surface for a mutation-mode reconciler. ~30 methods total;
// the bulk are stubs because we don't use Suspense, hydration, scopes,
// activity, or persistence. Everything with a body delegates: node creation
// to scene/node.ts, props to scene/props.ts, the DOM face to
// scene/dom-facade.ts, class resolution to styling/class-names.ts.

import ReactReconciler from "react-reconciler";
import { DefaultEventPriority } from "react-reconciler/constants";

import "../host/imports.ts";
import { freshNode, nodeRegistry, nodeTexts, sceneIdOf, type CmNode } from "../scene/node.ts";
import { clickHandlers, eventHandlers, inputHandlers } from "../scene/events.ts";
import { allStringLikeChildren, applyProps, flattenStringChildren } from "../scene/props.ts";
import { decorateAsDomNode } from "../scene/dom-facade.ts";
import { reResolveSubtree } from "../styling/class-names.ts";
import { bindReconciler } from "./flush-sync.ts";

const hostConfig: any = {
  // Required capability flags
  supportsMutation: true,
  supportsPersistence: false,
  supportsHydration: false,
  isPrimaryRenderer: true,
  noTimeout: -1,
  warnsIfNotActing: false,
  supportsMicrotasks: true,

  // ── Construction ──────────────────────────────────────────────────────
  createInstance(type: string, props: Record<string, unknown>): CmNode {
    const node = freshNode(type, false);
    // For `<text>` with all-string-like children, set the joined text on
    // this node directly. Pairs with shouldSetTextContent below — React
    // won't create text-instance children when that returns true, so the
    // single set_text call is the whole story.
    if (type === "text" && allStringLikeChildren(props.children)) {
      const s = flattenStringChildren(props.children);
      __cm_set_text(node.id, s);
      nodeTexts.set(node.id, s);
    }
    // Defensive applyProps: a broken prop value (undefined where
    // string expected, or a non-stringifiable cycle) should NOT crash
    // the whole render tree. Log + continue.
    try {
      applyProps(node, props);
    } catch (e: any) {
      (globalThis as any).console?.warn?.(
        `[@carbon/mini-react] applyProps failed for <${type}>:`,
        e?.message ?? String(e),
      );
    }
    decorateAsDomNode(node, type);
    return node;
  },

  createTextInstance(text: string): CmNode {
    const node = freshNode("text", true);
    const s = String(text);
    __cm_set_text(node.id, s);
    nodeTexts.set(node.id, s);
    return node;
  },

  // ── Initial mount ─────────────────────────────────────────────────────
  appendInitialChild(parent: CmNode, child: CmNode): void {
    parent.children.push(child);
    child.parent = parent;
    __cm_insert_node(parent.id, child.id, -1);
  },

  finalizeInitialChildren(): boolean {
    return false;
  },

  // ── Mutation ──────────────────────────────────────────────────────────
  appendChild(parent: CmNode, child: CmNode): void {
    if (child.parent) {
      const i = child.parent.children.indexOf(child);
      if (i >= 0) child.parent.children.splice(i, 1);
    }
    parent.children.push(child);
    child.parent = parent;
    __cm_insert_node(parent.id, child.id, -1);
    reResolveSubtree(child);
    __cm_request_paint();
  },

  appendChildToContainer(parent: CmNode, child: CmNode): void {
    if (child.parent) {
      const i = child.parent.children.indexOf(child);
      if (i >= 0) child.parent.children.splice(i, 1);
    }
    // The container may be a @carbon/compat-dom node (document.body, a Radix
    // portal target), whose `.children` isn't a plain array and whose scene
    // id is `.cmId` — so guard the JS-graph push and resolve via sceneIdOf.
    if (Array.isArray((parent as any).children)) (parent as any).children.push(child);
    child.parent = parent;
    __cm_insert_node(sceneIdOf(parent), sceneIdOf(child), -1);
    // Tree is fully wired now (this is the React root mount). Walk the
    // entire subtree and re-resolve classNames so deep group-data /
    // peer-data variants pick up ancestors that weren't in the chain
    // when applyProps first ran from createInstance.
    reResolveSubtree(child);
    __cm_request_paint();
  },

  insertBefore(parent: CmNode, child: CmNode, before: CmNode): void {
    if (child.parent) {
      const i = child.parent.children.indexOf(child);
      if (i >= 0) child.parent.children.splice(i, 1);
    }
    const idx = parent.children.indexOf(before);
    parent.children.splice(idx < 0 ? parent.children.length : idx, 0, child);
    child.parent = parent;
    __cm_insert_node(parent.id, child.id, before.id);
    reResolveSubtree(child);
    __cm_request_paint();
  },

  insertInContainerBefore(parent: CmNode, child: CmNode, before: CmNode): void {
    // Container variant of insertBefore: parent may be a @carbon/compat-dom node
    // (portal target). Resolve scene ids via sceneIdOf and guard the JS-graph
    // splice the same way appendChildToContainer does.
    if (child.parent) {
      const i = child.parent.children.indexOf(child);
      if (i >= 0) child.parent.children.splice(i, 1);
    }
    if (Array.isArray((parent as any).children)) {
      const idx = (parent as any).children.indexOf(before);
      (parent as any).children.splice(idx < 0 ? (parent as any).children.length : idx, 0, child);
    }
    child.parent = parent;
    __cm_insert_node(sceneIdOf(parent), sceneIdOf(child), sceneIdOf(before));
    reResolveSubtree(child);
    __cm_request_paint();
  },

  removeChild(parent: CmNode, child: CmNode): void {
    const i = parent.children.indexOf(child);
    if (i >= 0) parent.children.splice(i, 1);
    child.parent = null;
    clickHandlers.delete(child.id);
    inputHandlers.delete(child.id);
    nodeTexts.delete(child.id);
    eventHandlers.delete(child.id);
    nodeRegistry.delete(child.id);
    __cm_remove_node(child.id);
    __cm_request_paint();
  },

  removeChildFromContainer(parent: CmNode, child: CmNode): void {
    if (Array.isArray((parent as any).children)) {
      const i = (parent as any).children.indexOf(child);
      if (i >= 0) (parent as any).children.splice(i, 1);
    }
    child.parent = null;
    clickHandlers.delete(sceneIdOf(child));
    inputHandlers.delete(sceneIdOf(child));
    nodeTexts.delete(sceneIdOf(child));
    eventHandlers.delete(sceneIdOf(child));
    nodeRegistry.delete(sceneIdOf(child));
    __cm_remove_node(sceneIdOf(child));
    __cm_request_paint();
  },

  // ── Updates (React 18 mutation mode) ──────────────────────────────────
  // React 18's reconciler skips prepareUpdate and calls commitUpdate with
  // (instance, type, oldProps, newProps). We re-apply newProps wholesale —
  // simpler than diffing both ways and equivalent in effect for our
  // scene-prop model where setting a prop is idempotent.
  prepareUpdate(): unknown {
    return true;
  },

  commitUpdate(
    instance: CmNode,
    _payload: unknown,
    type: string,
    _oldProps: Record<string, unknown>,
    newProps: Record<string, unknown>,
  ): void {
    // Text-children collapse must run on update too — otherwise a re-render
    // of `<text>Count: {count}</text>` after `setCount(c+1)` would never
    // refresh the displayed text (commitUpdate without this branch only
    // applied props, not children).
    if (type === "text" && allStringLikeChildren(newProps.children)) {
      const s = flattenStringChildren(newProps.children);
      __cm_set_text(instance.id, s);
      nodeTexts.set(instance.id, s);
    }
    // Wipe the node's paint-related props back to defaults before
    // re-applying. Without this, conditional styles from the OLD render
    // (e.g. `data-active:bg-X` when the previous render had data-state=
    // active and the new one doesn't) would linger because __cm_set_prop
    // only overwrites keys that get re-sent.
    const reset = (globalThis as unknown as { __cm_reset_paint_props?: (id: number) => void }).__cm_reset_paint_props;
    if (typeof reset === "function") reset(instance.id);
    applyProps(instance, newProps);
  },

  commitTextUpdate(textNode: CmNode, _oldText: string, newText: string): void {
    const s = String(newText);
    __cm_set_text(textNode.id, s);
    nodeTexts.set(textNode.id, s);
    __cm_request_paint();
  },

  resetTextContent(): void {
    // No-op: our text is owned by Text nodes, not the parent.
  },

  // ── Suspense / Offscreen visibility ───────────────────────────────────
  // react-reconciler calls these during commit to hide/show a subtree
  // without unmounting it — e.g. a <Suspense> boundary showing its fallback
  // while a lazy() child loads. They are REQUIRED in mutation mode; leaving
  // them off makes React call `undefined(instance)` mid-commit, throwing
  // "TypeError: not a function" and blanking the whole window the moment any
  // Suspense/lazy boundary commits (terax lazy-loads its editor/AI panes).
  // We mirror react-dom: toggle `display:none`, restoring the prior value
  // on unhide (from the instance's own style props, else the element
  // default).
  hideInstance(instance: CmNode): void {
    __cm_set_prop(instance.id, "display", JSON.stringify("none"));
    __cm_request_paint();
  },
  unhideInstance(instance: CmNode, props: Record<string, unknown>): void {
    const style = props?.style as { display?: unknown } | undefined;
    const disp = typeof style?.display === "string" ? style.display : "";
    __cm_set_prop(instance.id, "display", JSON.stringify(disp));
    __cm_request_paint();
  },
  hideTextInstance(textInstance: CmNode): void {
    __cm_set_prop(textInstance.id, "display", JSON.stringify("none"));
    __cm_request_paint();
  },
  unhideTextInstance(textInstance: CmNode): void {
    __cm_set_prop(textInstance.id, "display", JSON.stringify(""));
    __cm_request_paint();
  },

  shouldSetTextContent(type: string, props: Record<string, unknown>): boolean {
    // Return true for `<text>` elements whose children are all string-like —
    // tells React not to create separate text-instance children for them.
    // Critical for correct layout: without this, `<text>foo {bar}</text>`
    // becomes an outer text + two text-instance children that flex-column-
    // stack vertically, producing the broken "label / value" stacking we
    // saw in the metadata row and tag chips.
    return type === "text" && allStringLikeChildren(props.children);
  },

  clearContainer(container: CmNode): void {
    while (container.children.length) {
      const child = container.children.pop()!;
      child.parent = null;
      clickHandlers.delete(child.id);
      nodeTexts.delete(child.id);
      __cm_remove_node(child.id);
    }
    __cm_request_paint();
  },

  // ── Context (we don't use host context) ───────────────────────────────
  getRootHostContext(): null {
    return null;
  },
  getChildHostContext(): null {
    return null;
  },

  // ── Commit phase ──────────────────────────────────────────────────────
  prepareForCommit(): null {
    return null;
  },
  resetAfterCommit(): void {
    __cm_request_paint();
  },
  preparePortalMount(): void {},

  // ── Public instance ───────────────────────────────────────────────────
  getPublicInstance(node: CmNode): CmNode {
    return node;
  },

  // ── Scheduling ────────────────────────────────────────────────────────
  scheduleTimeout(fn: (...args: unknown[]) => unknown, delay: number): number {
    return setTimeout(fn, delay) as unknown as number;
  },
  cancelTimeout(id: number): void {
    clearTimeout(id);
  },
  scheduleMicrotask(fn: () => unknown): void {
    queueMicrotask(fn);
  },

  // ── Event priority — same lane every event for our single-input model ─
  getCurrentEventPriority(): number {
    return DefaultEventPriority;
  },

  // ── Refs / scopes / activity / suspense — unused stubs ────────────────
  detachDeletedInstance(): void {},
  beforeActiveInstanceBlur(): void {},
  afterActiveInstanceBlur(): void {},
  prepareScopeUpdate(): void {},
  getInstanceFromScope(): null {
    return null;
  },
  getInstanceFromNode(): null {
    return null;
  },
  trackSchedulerEvent(): void {},
  resolveEventType(): null {
    return null;
  },
  resolveEventTimeStamp(): number {
    return -1.1;
  },
  requestPostPaintCallback(): void {},
  maySuspendCommit(): boolean {
    return false;
  },
  preloadInstance(): boolean {
    return true;
  },
  startSuspendingCommit(): void {},
  suspendInstance(): void {},
  waitForCommitToBeReady(): null {
    return null;
  },
  NotPendingTransition: null,
  HostTransitionContext: { $$typeof: Symbol.for("react.context"), Provider: null, _currentValue: null, _currentValue2: null, _threadCount: 0, Consumer: null, displayName: "" },
};

export const reconciler = ReactReconciler(hostConfig);

// Hand it to the dispatcher traps, which were installed before this module
// evaluated and have been holding a null reference until now.
bindReconciler(reconciler);

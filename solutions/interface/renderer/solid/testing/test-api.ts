// Testing API: AI-navigable scene inspection.

import "../host/imports.ts";
import { nodeTexts, type CmNode } from "../scene/node.ts";
import { currentRoot } from "../scene/root.ts";
import { clickHandlers } from "../scene/events.ts";

// ─── Testing API: AI-navigable scene inspection ──────────────────────────
// Install __cm_test global with methods to query, navigate, and inspect
// the rendered scene tree. Used by automated tests and AI agents.
interface TestNode {
  id: number;
  tag: string;
  text?: string;
  children: TestNode[];
}

function serializeNodeTree(node: CmNode): TestNode {
  return {
    id: node.id,
    tag: node.tag,
    text: nodeTexts.get(node.id),
    children: node.children.map(serializeNodeTree),
  };
}

function findNodesByText(node: CmNode | null, text: string, results: TestNode[] = []): TestNode[] {
  if (!node) return results;
  const nodeText = nodeTexts.get(node.id);
  if (nodeText === text) {
    results.push(serializeNodeTree(node));
  }
  node.children.forEach(child => findNodesByText(child, text, results));
  return results;
}

function findNodesByTag(node: CmNode | null, tag: string, results: TestNode[] = []): TestNode[] {
  if (!node) return results;
  if (node.tag === tag) {
    results.push(serializeNodeTree(node));
  }
  node.children.forEach(child => findNodesByTag(child, tag, results));
  return results;
}

// Walk up parent chain to find the nearest clickable ancestor (text nodes
// don't carry click handlers — their parent view does).
function findClickableAncestor(startId: number): number | null {
  // Walk the live CmNode tree (not the serialized one) to follow .parent.
  function walk(n: CmNode | null): CmNode | null {
    if (!n) return null;
    if (clickHandlers.has(n.id)) return n;
    return null;
  }
  // Find the live node by id, then walk up.
  function findLive(node: CmNode | null, id: number): CmNode | null {
    if (!node) return null;
    if (node.id === id) return node;
    for (const c of node.children) {
      const f = findLive(c, id);
      if (f) return f;
    }
    return null;
  }
  let cur = findLive(currentRoot(), startId);
  while (cur) {
    if (clickHandlers.has(cur.id)) return cur.id;
    cur = cur.parent;
  }
  return null;
}

(globalThis as any).__cm_test = {
  findByText(text: string): TestNode[] {
    return findNodesByText(currentRoot(), text);
  },

  findByTag(tag: string): TestNode[] {
    return findNodesByTag(currentRoot(), tag);
  },

  dump(): string {
    return JSON.stringify(currentRoot() ? serializeNodeTree(currentRoot()!) : null);
  },

  clickId(id: number): void {
    // If the node itself isn't clickable, walk up to find a clickable
    // ancestor — matches what the runtime's hit-test would find.
    const target = clickHandlers.has(id) ? id : findClickableAncestor(id);
    if (target != null) {
      (globalThis as any).__cm_dispatch_click?.(target);
      __cm_request_paint();
    }
  },

  clickText(text: string): void {
    const nodes = findNodesByText(currentRoot(), text);
    if (nodes.length > 0) {
      this.clickId(nodes[0].id);
    }
  },

  signals(): Record<string, unknown> {
    const stash = (globalThis as any).__hmr_state;
    if (!stash) return {};
    return Object.fromEntries(stash);
  },

  triggerPaint(): void {
    __cm_request_paint();
  },
};

export {};

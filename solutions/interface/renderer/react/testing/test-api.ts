// Test API for AI agents / automated tests.
//
// Mirrors interface/renderer/solid's `__cm_test` surface so the same harness
// works for both adapters.

import "../host/imports.ts";
import { clickHandlers } from "../scene/events.ts";
import { nodeTexts, type CmNode } from "../scene/node.ts";
import { currentRoot } from "../scene/root.ts";

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
  if (nodeTexts.get(node.id) === text) results.push(serializeNodeTree(node));
  node.children.forEach((c) => findNodesByText(c, text, results));
  return results;
}

function findNodesByTag(node: CmNode | null, tag: string, results: TestNode[] = []): TestNode[] {
  if (!node) return results;
  if (node.tag === tag) results.push(serializeNodeTree(node));
  node.children.forEach((c) => findNodesByTag(c, tag, results));
  return results;
}

function findClickableAncestor(startId: number): number | null {
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
  findByText(text: string): TestNode[] { return findNodesByText(currentRoot(), text); },
  findByTag(tag: string): TestNode[] { return findNodesByTag(currentRoot(), tag); },
  dump(): string { const r = currentRoot(); return JSON.stringify(r ? serializeNodeTree(r) : null); },
  clickId(id: number): void {
    const target = clickHandlers.has(id) ? id : findClickableAncestor(id);
    if (target != null) {
      (globalThis as any).__cm_dispatch_click?.(target);
      __cm_request_paint();
    }
  },
  clickText(text: string): void {
    const nodes = findNodesByText(currentRoot(), text);
    if (nodes.length > 0) (globalThis as any).__cm_test.clickId(nodes[0].id);
  },
  triggerPaint(): void { __cm_request_paint(); },
};

export {};

// The scene-graph host imports the runtime binds into the JS context.
//
// This is the whole surface this renderer sits on: seven functions, declared
// once, side-effect-imported by every module that calls them
// (`import "../host/imports.ts";`) — the same pattern stdlib/api uses for the
// 69 it declares.
//
// The contract is identical to the one interface/renderer/solid binds to. Both
// adapters can coexist in the same JS context because they draw node ids from
// the same globalThis counter (see scene/node.ts) and speak only through these.

declare global {
  const __cm_create_node: (id: number, tag: string, propsJson: string) => void;
  const __cm_set_text: (id: number, text: string) => void;
  const __cm_set_prop: (id: number, key: string, valueJson: string) => void;
  const __cm_insert_node: (parentId: number, childId: number, beforeId: number) => void;
  const __cm_remove_node: (id: number) => void;
  const __cm_set_root: (id: number) => void;
  const __cm_request_paint: () => void;
}

export {};

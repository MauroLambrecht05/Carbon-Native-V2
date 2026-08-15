// The host imports this renderer sits on.
//
// The scene-graph seven are the same contract interface/renderer/react binds
// to. The `__carbon_canvas_*` four are this renderer's alone: Solid owns the
// <canvas> intrinsic, and they are lazy — the wgpu device is constructed on
// the FIRST __carbon_canvas_create call, so a UI-only app never triggers GPU
// init.

declare global {
  // These are bound globals exposed by the runtime; no DOM, no IPC envelope.
  const __cm_create_node: (id: number, tag: string, propsJson: string) => void;
  const __cm_set_text: (id: number, text: string) => void;
  const __cm_set_prop: (id: number, key: string, valueJson: string) => void;
  const __cm_insert_node: (parentId: number, childId: number, beforeId: number) => void;
  const __cm_remove_node: (id: number) => void;
  const __cm_set_root: (id: number) => void;
  const __cm_request_paint: () => void;
  // GPU canvas host imports — bound by the runtime in main.rs::register_host_imports.
  // Lazy: the wgpu device is constructed on the FIRST __carbon_canvas_create
  // call. UI-only apps never trigger GPU init.
  const __carbon_canvas_create: (width: number, height: number) => number;
  const __carbon_canvas_resize: (id: number, width: number, height: number) => void;
  const __carbon_canvas_clear: (id: number, r: number, g: number, b: number, a: number) => void;
  const __carbon_canvas_destroy: (id: number) => void;
}

export {};

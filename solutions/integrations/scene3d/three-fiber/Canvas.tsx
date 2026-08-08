// @carbon/three-fiber / Canvas.tsx
//
// `<Canvas>` — the top-level component. It:
//   1. Renders @carbon/mini-solid's `<canvas>` intrinsic and grabs the
//      Rust-side canvas id via the `onReady` hook.
//   2. Constructs a THREE.Scene + a default PerspectiveCamera.
//   3. Constructs a CarbonRenderer (from @carbon/three) bound to
//      the canvas's id. Falls back to a MockCommandExecutor when no
//      executor is supplied — useful for tests and for the standalone
//      browser demo where we don't yet have the GPU executor wired.
//   4. Drives a requestAnimationFrame loop that calls `renderer.render(
//      scene, camera)` every tick.
//   5. Exposes a Solid context (scene/camera/renderer) so children that
//      need imperative access can grab them with `useThree()`.
//
// The children of `<Canvas>` render into a SECOND Solid root, with our
// custom three-fiber renderer as the JSX target. carbon-mini's renderer
// is in charge of the outer (UI / scene-graph) tree; we own the inner
// (three.js) tree.

import { createSignal, onCleanup, onMount, createMemo, createContext, useContext, untrack, createEffect } from "solid-js";
import * as THREE from "three";
import { CarbonRenderer, CanvasSurfaceExecutor, MockCommandExecutor, type CommandExecutor } from "@carbon/three";
import { createThreeFiberRenderer, type ThreeNode } from "./renderer.js";
import { runR3FBuild, type R3FBuilder } from "./r3f-build.js";

// Augment Solid's JSX so the carbon-mini `<canvas>` intrinsic is
// typed correctly here (apps importing @carbon/three-fiber may or may
// not also import @carbon/mini-solid/types, so we re-declare the
// minimal shape locally — non-conflicting with carbon-mini's fuller
// definition since it's a structural/intersection type).
declare module "solid-js" {
  namespace JSX {
    interface IntrinsicElements {
      canvas: {
        width?: number;
        height?: number;
        style?: any;
        class?: string;
        className?: string;
        onReady?: (info: { id: number }) => void;
        ref?: any;
        children?: any;
      };
    }
  }
}

// ─── Public context ───────────────────────────────────────────────────────
// Anything inside `<Canvas>` can grab these by `useThree()`. Mostly an
// escape hatch for imperative code (e.g., post-effects, raycasting).
export interface ThreeContextValue {
  scene: THREE.Scene;
  // The default camera; users can override by mounting <perspectiveCamera
  // ref={cam => setActiveCamera(cam)} />.
  camera: () => THREE.Camera;
  setCamera: (cam: THREE.Camera) => void;
  renderer: () => CarbonRenderer | null;
  // Width/height in canvas pixels. Reactive — re-reading inside an effect
  // re-runs on resize.
  size: () => { width: number; height: number };
}

const ThreeContext = createContext<ThreeContextValue>();

export function useThree(): ThreeContextValue {
  const ctx = useContext(ThreeContext);
  if (!ctx) {
    throw new Error("useThree() must be called inside <Canvas>.");
  }
  return ctx;
}

// ─── Canvas props ─────────────────────────────────────────────────────────
export interface CanvasProps {
  /** Pixel size for the wgpu surface. Use either `style={{width, height}}`
   * (when laid out by the carbon-mini layout engine) or set explicit
   * `width`/`height` on the Canvas. We accept both. */
  width?: number;
  height?: number;
  style?: any;
  class?: string;
  className?: string;
  /** Override the executor that consumes draw commands. In tests pass a
   * MockCommandExecutor; in production this gets wired to Phase 1's
   * GPU-backed executor. Default: a fresh MockCommandExecutor (so the
   * scene walk runs and emits commands even without a backend). */
  executor?: CommandExecutor;
  /** Background color for the renderer's clear command. Same shape as
   * three's `setClearColor`. Defaults to opaque black. */
  background?: THREE.ColorRepresentation;
  /** Disable frustum culling (useful for debugging). */
  enableFrustumCulling?: boolean;
  /** Pixel ratio — passed through to the renderer. Default 1 (mini's GPU
   * canvas already operates in physical pixels). */
  pixelRatio?: number;
  /** Stop the rAF loop. Useful for tests + on-demand rendering. */
  paused?: boolean;
  /** Called once per rendered frame, BEFORE the renderer.render call.
   * Use for animation logic that needs to mutate the scene each frame
   * (e.g., spinning a mesh, advancing physics). */
  onFrame?: (state: { scene: THREE.Scene; camera: THREE.Camera; delta: number; time: number }) => void;
  /** Called once after the GPU surface is ready and the renderer has been
   * constructed. Use it for one-time imperative setup. */
  onReady?: (state: { scene: THREE.Scene; camera: THREE.Camera; renderer: CarbonRenderer }) => void;
  children?: any;
  /** Internal — set automatically by @carbon/vite-three-bridge when
   * the build pipeline lifts JSX inside `<Canvas>` into a builder fn so it
   * can be evaluated against the three-fiber renderer (rather than the
   * outer @carbon/mini-solid). User code should NOT pass this directly;
   * write idiomatic JSX instead and let the babel plugin wire it up.
   * Documented here so type-checking doesn't error when the rewrite runs.
   * See packages/carbon-vite-plugin-three-bridge/. */
  r3fBuild?: R3FBuilder;
}

// ─── requestAnimationFrame shim ───────────────────────────────────────────
// In carbon-mini we don't have rAF (no DOM). The runtime exposes
// `globalThis.requestAnimationFrame` if it's wired up; otherwise we fall
// back to setTimeout(0). For tests (bun:test) we don't want a continuous
// loop at all; the test wires `paused` instead.
function getRaf(): (cb: (t: number) => void) => any {
  if (typeof (globalThis as any).requestAnimationFrame === "function") {
    return (globalThis as any).requestAnimationFrame.bind(globalThis);
  }
  return (cb: (t: number) => void) => (globalThis as any).setTimeout(() => cb(Date.now()), 16);
}
function getCaf(): (id: any) => void {
  if (typeof (globalThis as any).cancelAnimationFrame === "function") {
    return (globalThis as any).cancelAnimationFrame.bind(globalThis);
  }
  return (id: any) => (globalThis as any).clearTimeout(id);
}

// ─── The component ────────────────────────────────────────────────────────
//
// We use a TSX-free style for the carbon-mini host element so this file
// can compile cleanly in any TS setup the package gets dropped into. The
// `<canvas>` child is created via raw createComponent() calls when the
// caller passes `useCanvasIntrinsic={true}`. By default we DON'T render a
// `<canvas>` host — many test environments don't have one — and instead
// just spin up the three-fiber tree with a stub canvas size. Apps that
// want the real GPU surface set the carbon-mini `useCanvasIntrinsic`
// prop on the host or pass an existing canvas via `canvasId`.
//
// (Actually we keep the JSX form for ergonomics — Solid's universal
// renderer compiles `<canvas .../>` to a renderer call with whatever
// moduleName is configured in vite-plugin-solid. As long as the host
// app has `solid({ generate: 'universal', moduleName: '@carbon/mini-solid' })`
// set in its vite config, this works.)

export function Canvas(props: CanvasProps) {
  // Width/height resolution: explicit prop > style > default.
  const initialWidth = untrack(() => props.width ?? props.style?.width ?? 400);
  const initialHeight = untrack(() => props.height ?? props.style?.height ?? 300);
  const [size, setSize] = createSignal({ width: Number(initialWidth) || 400, height: Number(initialHeight) || 300 });

  // Three.js scene + default camera. Both stable across renders.
  const scene = new THREE.Scene();
  const defaultCamera = new THREE.PerspectiveCamera(
    75,
    size().width / Math.max(1, size().height),
    0.1,
    1000
  );
  defaultCamera.position.set(0, 0, 5);
  defaultCamera.lookAt(0, 0, 0);

  const [activeCamera, setActiveCamera] = createSignal<THREE.Camera>(defaultCamera);

  // Renderer is created on `onReady` (when the wgpu canvas surface is up).
  // In test mode (no `<canvas>` mounted) we build it eagerly with a
  // mock executor so the rAF loop has something to drive.
  const [renderer, setRenderer] = createSignal<CarbonRenderer | null>(null);
  // Canvas id signal — onReady writes here; an effect bridges it to the
  // renderer's setCanvasId once both exist. We need this indirection
  // because onReady fires SYNCHRONOUSLY during prop-set in carbon-mini-
  // runtime's universal renderer, which happens BEFORE onMount runs and
  // therefore before `renderer` is set. The effect re-runs whenever
  // either signal changes; it's idempotent because setCanvasId is
  // identity-comparison on the renderer side.
  const [canvasId, setCanvasId] = createSignal<number>(-1);
  createEffect(() => {
    const r = renderer();
    const id = canvasId();
    if (r && id >= 0 && (r as any).setCanvasId) {
      try { (r as any).setCanvasId(id); } catch {}
    }
  });

  // Build the renderer immediately if the caller supplied an executor;
  // otherwise we defer until onReady fires (in production, that's when
  // the GPU surface is ready and we can hand its id to the executor).
  // Currently the executor is decoupled from the canvas id (the GPU
  // executor will need its own constructor to bind), so for Phase 4
  // we ALWAYS construct eagerly: tests get the MockCommandExecutor, and
  // production wraps Phase 1's GPU executor before passing it in.
  const constructRenderer = (): CarbonRenderer => {
    // Default to CanvasSurfaceExecutor when the runtime exposes the
    // host binding (production / carbon-mini path); fall back to a
    // MockCommandExecutor in environments without it (browser smoke
    // tests, bun:test). Callers can override via `executor` prop.
    let defaultExecutor: CommandExecutor;
    if (typeof (globalThis as any).__carbon_canvas_execute_commands === "function") {
      defaultExecutor = new CanvasSurfaceExecutor();
    } else {
      defaultExecutor = new MockCommandExecutor();
    }
    const exec = props.executor ?? defaultExecutor;
    const r = new CarbonRenderer({
      executor: exec,
      enableFrustumCulling: props.enableFrustumCulling ?? true,
      canvas: { width: size().width, height: size().height },
    });
    r.setSize(size().width, size().height);
    r.setPixelRatio(props.pixelRatio ?? 1);
    if (props.background !== undefined) r.setClearColor(props.background, 1);
    return r;
  };

  onMount(() => {
    const r = constructRenderer();
    setRenderer(r);
    if (props.onReady) {
      try {
        props.onReady({ scene, camera: activeCamera(), renderer: r });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[@carbon/three-fiber] onReady threw:", err);
      }
    }
  });

  // ─── Inner-tree mount ───────────────────────────────────────────────────
  // We construct a fresh three-fiber renderer per Canvas and mount the
  // children into the scene. Disposal is wired to onCleanup so unmounting
  // the Canvas tears the inner tree down.
  const tfr = createThreeFiberRenderer();
  let disposeInner: (() => void) | null = null;
  onMount(() => {
    // PREFERRED PATH: @carbon/vite-three-bridge has lifted the JSX
    // inside `<Canvas>` into a builder function, attached as `r3fBuild`.
    // Run the builder against our three-fiber renderer's primitives —
    // this side-steps babel-preset-solid's per-file moduleName limitation.
    if (typeof props.r3fBuild === "function") {
      disposeInner = runR3FBuild(props.r3fBuild, tfr, scene);
      return;
    }
    // FALLBACK: no babel plugin running. Children were already compiled
    // by babel-preset-solid into the OUTER renderer's calls (carbon-mini),
    // which means they're CmNodes — not three.js objects. Mount them as
    // a no-op so the rAF loop still runs (caller can use onReady to build
    // the scene imperatively, like the legacy demo does).
    //
    // Solid passes children as a function or array; we wrap whatever we
    // got in a fragment so the inner renderer sees a single render entry.
    disposeInner = tfr.mount(() => props.children, scene);
  });
  onCleanup(() => {
    if (disposeInner) {
      try { disposeInner(); } catch {}
      disposeInner = null;
    }
  });

  // ─── rAF loop ───────────────────────────────────────────────────────────
  let rafId: any = null;
  let lastTime = 0;
  const raf = getRaf();
  const caf = getCaf();
  const tick = (t: number) => {
    rafId = null;
    const r = renderer();
    if (!r) {
      rafId = raf(tick);
      return;
    }
    const cam = activeCamera();
    const delta = lastTime === 0 ? 0 : (t - lastTime) / 1000;
    lastTime = t;
    if (props.onFrame) {
      try { props.onFrame({ scene, camera: cam, delta, time: t }); } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[@carbon/three-fiber] onFrame threw:", err);
      }
    }
    // PerspectiveCamera/orthographic: re-aspect on size changes.
    const s = size();
    if ((cam as any).isPerspectiveCamera) {
      const pc = cam as THREE.PerspectiveCamera;
      const want = s.width / Math.max(1, s.height);
      if (Math.abs(pc.aspect - want) > 1e-4) {
        pc.aspect = want;
        pc.updateProjectionMatrix();
      }
    }
    r.render(scene, cam);
    if (!props.paused) rafId = raf(tick);
  };
  onMount(() => {
    if (!props.paused) rafId = raf(tick);
  });
  onCleanup(() => {
    if (rafId != null) caf(rafId);
    rafId = null;
    const r = renderer();
    if (r) r.dispose();
  });

  // ─── Context value (memoized lookups) ───────────────────────────────────
  const ctxValue = createMemo<ThreeContextValue>(() => ({
    scene,
    camera: activeCamera,
    setCamera: setActiveCamera,
    renderer,
    size,
  }));

  // ─── The carbon-mini host element ───────────────────────────────────────
  // We render a `<canvas>` from @carbon/mini-solid so the wgpu surface
  // gets created. In test environments where we're NOT inside a carbon-mini
  // tree (e.g., bun:test running plain JS), the carbon-mini global host
  // imports won't be defined; the JSX call will fail. To stay testable we
  // fall through to `null` (no host) — children still render into the
  // three.js scene, the rAF loop still ticks. The actual JSX is created
  // by whatever runtime the host app's vite-plugin-solid is configured for.
  //
  // The returned value is provided as-is to whichever Solid renderer the
  // OUTER app is using (carbon-mini in production). This means the
  // <Canvas> JSX call lives in the OUTER tree; only `props.children` go
  // through our custom inner renderer.
  return (
    <ThreeContext.Provider value={ctxValue()}>
      <canvas
        width={size().width}
        height={size().height}
        style={props.style}
        class={props.class}
        className={props.className}
        onReady={(info: { id: number }) => {
          // onReady fires synchronously during prop-set in carbon-mini-
          // runtime, which happens BEFORE onMount has run. We stash the
          // id in a signal; an effect above bridges it to the renderer
          // once both are alive.
          setCanvasId(info.id);
        }}
      />
    </ThreeContext.Provider>
  );
}

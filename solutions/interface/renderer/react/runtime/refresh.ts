// React Fast Refresh wiring — the same mechanism Vite/webpack/Next.js use,
// via the official `react-refresh` package. This is what lets a scaffolded
// app write plain `useState`/`useRef`/`useEffect` (see main.tsx / App.tsx
// in a scaffolded project) and still keep that state across a `carbon dev`
// reload, with zero code in the app itself.
//
// Load-bearing precondition this file does NOT provide: React and
// react-reconciler's own module instances must survive a reload — only the
// app's own code (App.tsx, main.tsx) may be re-evaluated. Carbon's default
// dev build re-evaluates the WHOLE bundle (React included) on every save,
// which throws away react-refresh's own family registry along with
// everything else. This only works when the project builds in "split"
// mode (react/react-dom/react-reconciler/react-refresh bundled once into
// vendor.js; only the app half re-evaluates) — see BunBundler.ts's
// buildBundleSplit, which the CLI's `dev` command now enables by default
// for React projects for exactly this reason.
//
// react-refresh/runtime's own top-level module branches on
// `process.env.NODE_ENV`, and its "production" branch is a deliberate
// `throw` ("React Refresh runtime should not be included in the
// production bundle.") — see BunBundler.ts's NODE_ENV handling for why a
// React dev/HMR build gets "development" specifically so this module can
// even be evaluated. A real `carbon build` never imports this file at all
// (nothing in the production render path references it).
//
// CJS interop: react-refresh ships as `module.exports = {...}`, which
// lands under the default export when bundled, not as named exports —
// verified directly against this workspace's Bun/bundler pair; named
// imports (`import { register } from "..."`) came back undefined.
import RefreshRuntimeDefault from "react-refresh/runtime";
const RefreshRuntime = RefreshRuntimeDefault as unknown as {
  injectIntoGlobalHook(globalObject: unknown): void;
  register(type: unknown, id: string): void;
  createSignatureFunctionForTransform(): (
    type: unknown,
    key: string,
    forceReset?: boolean,
    getCustomHooks?: () => unknown[],
  ) => unknown;
  performReactRefresh(): void;
  hasUnrecoverableErrors(): boolean;
};

const g = globalThis as unknown as {
  __cm_refresh_injected?: boolean;
  $RefreshReg$?: (type: unknown, id: string) => void;
  $RefreshSig$?: () => (type: unknown, key: string, forceReset?: boolean, getCustomHooks?: () => unknown[]) => unknown;
};

// Guarded so re-running this module (a fresh bundle re-eval, in the
// non-split path, or a second entry importing the renderer twice) doesn't
// inject a second stub devtools hook over the first.
if (!g.__cm_refresh_injected) {
  RefreshRuntime.injectIntoGlobalHook(globalThis);
  g.__cm_refresh_injected = true;
}

// $RefreshReg$ / $RefreshSig$: what react-refresh/babel's transform emits
// bare calls to after every component declaration, assuming they already
// exist in scope. Real bundler dev-plugins (Vite, webpack) inject a
// per-module preamble that scopes these correctly for file-level HMR;
// Carbon doesn't need that — split-mode's app bundle is ONE file re-run
// top to bottom on every reload, so a single set of globals, defined once,
// is exactly as correct and far simpler. The id passed to register() only
// needs to be unique within this one app bundle, not globally.
g.$RefreshReg$ = (type: unknown, id: string) => {
  RefreshRuntime.register(type, id);
};
g.$RefreshSig$ = RefreshRuntime.createSignatureFunctionForTransform;

/**
 * Call after the bundle has finished re-evaluating (every top-level
 * $RefreshReg$ call for this pass has already run) to patch newly
 * registered component implementations into the currently mounted tree,
 * preserving hook state. A no-op the first time anything mounts — there is
 * nothing registered yet to refresh — and safe to call unconditionally.
 */
export function performReactRefresh(): void {
  if (RefreshRuntime.hasUnrecoverableErrors()) return;
  RefreshRuntime.performReactRefresh();
}

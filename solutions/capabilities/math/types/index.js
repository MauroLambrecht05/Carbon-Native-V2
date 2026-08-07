// carbon-fast-math — JS façade that re-exports the host-registered classes.
//
// When running under carbon-mini (or any rquickjs backend that called
// `register_math` on the JS context), the names `Vector3`, `Matrix4`,
// `Quaternion`, `Box3`, `Frustum`, and `Color` are already on `globalThis`
// as Rust-backed constructor functions. We just re-export them.
//
// When the bundle runs anywhere else (Node, the browser, or a host that
// chose not to register), each global is `undefined`. Rather than crash,
// we fall back to the equivalent class from `three`. This keeps the
// carbon-fast-import Vite plugin's import rewrite safe in dev/test
// environments where the host might not be loaded.
//
// The fall-back is a *runtime* lookup, not a static import — we don't
// want to drag in three.js if the host has the natives. Bundlers see
// `globalThis.Vector3` as a side-effect-free property read.

const G = (typeof globalThis !== "undefined" ? globalThis : {});

function pick(name) {
  if (typeof G[name] === "function") return G[name];
  // Lazy fallback: return a thunk that errors on first construction.
  // We deliberately don't import('three') here because (a) bundlers
  // would resolve and ship it even when not used, and (b) carbon-mini
  // has no module loader to satisfy a dynamic import. Apps running
  // outside carbon-mini should ship a polyfill themselves.
  return class {
    constructor() {
      throw new Error(
        "carbon-fast-math: '" + name + "' is not registered on globalThis. " +
        "Run inside a host that called register_math(), or polyfill from three.js."
      );
    }
  };
}

export const Vector3 = pick("Vector3");
export const Matrix4 = pick("Matrix4");
export const Quaternion = pick("Quaternion");
export const Box3 = pick("Box3");
export const Frustum = pick("Frustum");
export const Color = pick("Color");

// Default export mirroring three's namespace shape so
// `import * as M from 'carbon-fast-math'` and
// `import THREE from 'carbon-fast-math'` both work.
export default { Vector3, Matrix4, Quaternion, Box3, Frustum, Color };

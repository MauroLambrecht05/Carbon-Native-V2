// @carbon/three-fiber / intrinsics.ts
//
// The intrinsic registry. Maps JSX tag names like `<mesh>`, `<boxGeometry>`,
// `<meshStandardMaterial>` onto factory functions that construct real
// three.js objects. The registry also tells the universal renderer how to
// attach each kind of object to its parent (e.g., a geometry attaches to
// `mesh.geometry`, not as a child).
//
// Design notes:
//   * One intrinsic name maps to one three.js class. We don't try to be
//     polymorphic the way r3f's `extend()` is — apps that need it can
//     extend the registry via the exported `extend()` function.
//   * The `args` prop is consumed at construction time only. Changes to
//     `args` after mount don't re-construct (matches r3f's behavior).
//   * All other props go through `applyProp` which handles:
//       - shorthand-numeric vector props (`position={[x,y,z]}` or
//         `position-x={1}`)
//       - color props (hex string, array, or three.Color)
//       - direct setter on the three.js object
//
// Reactivity comes from solid: the universal renderer's setProperty
// handler routes through `applyProp`, which mutates the three.js object
// in place. Since solid wraps reactive prop reads in tracking effects,
// signal-driven props "just work".

import * as THREE from "three";

// ─── Object factory entry ─────────────────────────────────────────────────
// `args` length varies by class — we just spread into the constructor.
// `attachTo` decides how the object plugs into its parent. Most things
// add as a child of the parent's three.js object; geometries/materials
// instead set a property on the parent.
export type AttachTo = "child" | "geometry" | "material";

export interface IntrinsicSpec {
  // Construct a fresh three.js object given the user's `args` prop.
  factory: (args: any[]) => THREE.Object3D | THREE.BufferGeometry | THREE.Material;
  // How the constructed object plugs into the parent's three object.
  attachTo: AttachTo;
}

// ─── Registry ─────────────────────────────────────────────────────────────
const REGISTRY: Record<string, IntrinsicSpec> = {
  // Object3D-derived (default attachTo: "child")
  group: { factory: () => new THREE.Group(), attachTo: "child" },
  mesh: { factory: (a) => new (THREE.Mesh as any)(...a), attachTo: "child" },
  line: { factory: (a) => new (THREE.Line as any)(...a), attachTo: "child" },
  lineSegments: {
    factory: (a) => new (THREE.LineSegments as any)(...a),
    attachTo: "child",
  },
  lineLoop: {
    factory: (a) => new (THREE.LineLoop as any)(...a),
    attachTo: "child",
  },
  points: { factory: (a) => new (THREE.Points as any)(...a), attachTo: "child" },
  sprite: { factory: (a) => new (THREE.Sprite as any)(...a), attachTo: "child" },
  object3D: { factory: () => new THREE.Object3D(), attachTo: "child" },

  // Cameras
  perspectiveCamera: {
    factory: (a) => new (THREE.PerspectiveCamera as any)(...a),
    attachTo: "child",
  },
  orthographicCamera: {
    factory: (a) => new (THREE.OrthographicCamera as any)(...a),
    attachTo: "child",
  },

  // Lights
  ambientLight: {
    factory: (a) => new (THREE.AmbientLight as any)(...a),
    attachTo: "child",
  },
  directionalLight: {
    factory: (a) => new (THREE.DirectionalLight as any)(...a),
    attachTo: "child",
  },
  pointLight: {
    factory: (a) => new (THREE.PointLight as any)(...a),
    attachTo: "child",
  },
  hemisphereLight: {
    factory: (a) => new (THREE.HemisphereLight as any)(...a),
    attachTo: "child",
  },
  spotLight: {
    factory: (a) => new (THREE.SpotLight as any)(...a),
    attachTo: "child",
  },

  // Geometries (attach as `parent.geometry`)
  boxGeometry: {
    factory: (a) => new (THREE.BoxGeometry as any)(...a),
    attachTo: "geometry",
  },
  sphereGeometry: {
    factory: (a) => new (THREE.SphereGeometry as any)(...a),
    attachTo: "geometry",
  },
  planeGeometry: {
    factory: (a) => new (THREE.PlaneGeometry as any)(...a),
    attachTo: "geometry",
  },
  bufferGeometry: {
    factory: () => new THREE.BufferGeometry(),
    attachTo: "geometry",
  },
  cylinderGeometry: {
    factory: (a) => new (THREE.CylinderGeometry as any)(...a),
    attachTo: "geometry",
  },
  coneGeometry: {
    factory: (a) => new (THREE.ConeGeometry as any)(...a),
    attachTo: "geometry",
  },
  torusGeometry: {
    factory: (a) => new (THREE.TorusGeometry as any)(...a),
    attachTo: "geometry",
  },

  // Materials (attach as `parent.material`)
  meshBasicMaterial: {
    factory: (a) => new (THREE.MeshBasicMaterial as any)(...a),
    attachTo: "material",
  },
  meshStandardMaterial: {
    factory: (a) => new (THREE.MeshStandardMaterial as any)(...a),
    attachTo: "material",
  },
  meshPhongMaterial: {
    factory: (a) => new (THREE.MeshPhongMaterial as any)(...a),
    attachTo: "material",
  },
  meshLambertMaterial: {
    factory: (a) => new (THREE.MeshLambertMaterial as any)(...a),
    attachTo: "material",
  },
  meshNormalMaterial: {
    factory: (a) => new (THREE.MeshNormalMaterial as any)(...a),
    attachTo: "material",
  },
  lineBasicMaterial: {
    factory: (a) => new (THREE.LineBasicMaterial as any)(...a),
    attachTo: "material",
  },
  pointsMaterial: {
    factory: (a) => new (THREE.PointsMaterial as any)(...a),
    attachTo: "material",
  },
  spriteMaterial: {
    factory: (a) => new (THREE.SpriteMaterial as any)(...a),
    attachTo: "material",
  },
};

// ─── Public extension hook ────────────────────────────────────────────────
// Apps that need an additional three.js class can wire it in here. Mirrors
// r3f's `extend({ MyCustomMesh })` pattern — but lower-level. The key in
// the registry is the lowercased intrinsic name.
export function extend(map: Record<string, IntrinsicSpec>): void {
  for (const [name, spec] of Object.entries(map)) {
    REGISTRY[name] = spec;
  }
}

// Sentinel prefix used by @carbon/vite-three-bridge in alternative
// rewrite modes (e.g. "<mesh>" → "<__r3f_mesh>"). The bridge plugin's
// primary path uses an `r3fBuild` prop instead, but we also accept the
// prefixed form so external babel transforms or hand-written code can opt
// in. Lookups strip the prefix before consulting REGISTRY.
const R3F_PREFIX = "__r3f_";

export function getIntrinsicSpec(tag: string): IntrinsicSpec | undefined {
  if (REGISTRY[tag]) return REGISTRY[tag];
  if (tag.startsWith(R3F_PREFIX)) {
    return REGISTRY[tag.slice(R3F_PREFIX.length)];
  }
  return undefined;
}

// ─── Color resolution ─────────────────────────────────────────────────────
// Accepts: hex number, hex string ("#hotpink", "hotpink"), three.Color,
// or [r,g,b] array (0..1).
function toColor(value: any, target?: THREE.Color): THREE.Color {
  const c = target ?? new THREE.Color();
  if (value instanceof THREE.Color) {
    c.copy(value);
  } else if (Array.isArray(value)) {
    c.setRGB(value[0], value[1], value[2]);
  } else {
    c.set(value);
  }
  return c;
}

// ─── Vector resolution ────────────────────────────────────────────────────
// Accepts: [x,y,z] array, three.Vector3, or scalar (broadcasts to all axes).
function toVector3(value: any, target?: THREE.Vector3): THREE.Vector3 {
  const v = target ?? new THREE.Vector3();
  if (value instanceof THREE.Vector3) {
    v.copy(value);
  } else if (Array.isArray(value)) {
    v.set(value[0] ?? 0, value[1] ?? 0, value[2] ?? 0);
  } else if (typeof value === "number") {
    v.set(value, value, value);
  }
  return v;
}

// Euler accepts the same shapes as Vector3 (we treat the array as XYZ
// rotation angles, three's default Euler order).
function toEuler(value: any, target?: THREE.Euler): THREE.Euler {
  const e = target ?? new THREE.Euler();
  if (value instanceof THREE.Euler) {
    e.copy(value);
  } else if (Array.isArray(value)) {
    e.set(value[0] ?? 0, value[1] ?? 0, value[2] ?? 0, (value[3] as any) ?? e.order);
  } else if (typeof value === "number") {
    e.set(value, value, value);
  }
  return e;
}

// ─── Component-wise prop name detection ───────────────────────────────────
// Handles shorthand like `position-x={1}` → mutate position.x in place.
const COMPONENT_AXIS = new Set(["x", "y", "z", "w"]);

// Color-like props on three materials. We treat a string/number as a color
// and forward through `THREE.Color`. The list isn't exhaustive — extending
// it just trades some overhead for support of more props.
const COLOR_PROPS = new Set([
  "color",
  "emissive",
  "specular",
  "background",
  "groundColor", // hemisphere light
  "skyColor",
]);

// Vector3-like props that should be set component-wise (in place) when an
// array is given, so we don't churn allocations every prop update.
const VECTOR_PROPS = new Set(["position", "scale", "up"]);

const EULER_PROPS = new Set(["rotation"]);

// ─── Prop application ─────────────────────────────────────────────────────
// Applied by both the renderer's setProperty (on update) and at construct
// time when consuming the initial JSX props (other than `args`).
//
// Rules in order:
//   1. `args` — already consumed by the factory; ignored here.
//   2. `ref` — pass the three.js object out (for users that need it).
//   3. `attach` — override the default attach behavior (rare; r3f compat).
//   4. component-wise (`prop-axis`) — mutate scalar slot.
//   5. typed conversions for known prop names (color/vector/euler).
//   6. nested-key props like `material-color={0xff0000}` (r3f shorthand).
//   7. fall-through: assign to `obj[name]`. If the existing slot is a
//      Vector3/Color/Euler/etc. and the value isn't already that class,
//      we call `.set()` instead of clobbering the slot — this preserves
//      object identity, which three uses internally for change detection.
export function applyProp(obj: any, name: string, value: any): void {
  if (name === "args" || name === "children") return;
  if (name === "ref") {
    // Solid invokes the renderer's setProperty for refs too. Forward the
    // three.js object — that's what users care about, not our wrapper.
    if (typeof value === "function") {
      try { value(obj); } catch {}
    }
    return;
  }
  if (name === "attach") {
    // Stash on the wrapper node — handled elsewhere when (re)attaching.
    obj.__attach = value;
    return;
  }
  if (name === "object") {
    // r3f's `<primitive object={...} />` style. We handle <primitive>
    // explicitly in createElement; here it's a no-op once the factory
    // already used `value`.
    return;
  }

  // Component-wise: e.g., `position-x={2}` or `rotation-y={Math.PI}`
  const dashIdx = name.indexOf("-");
  if (dashIdx > 0) {
    const head = name.slice(0, dashIdx);
    const tail = name.slice(dashIdx + 1);
    // Single-axis shorthand: `position-x`, `scale-y`, etc.
    if (
      COMPONENT_AXIS.has(tail) &&
      (VECTOR_PROPS.has(head) || EULER_PROPS.has(head) || head === "scale" || head === "position" || head === "rotation")
    ) {
      const slot = obj[head];
      if (slot && tail in slot) {
        slot[tail] = value;
        return;
      }
    }
    // Nested r3f shorthand: `material-color={...}`,
    // `geometry-attributes-position={...}` etc. Recurse.
    const nested = obj[head];
    if (nested != null && typeof nested === "object") {
      applyProp(nested, tail, value);
      return;
    }
    // Fall-through: maybe a literal "foo-bar" property the user wants.
  }

  // Color props
  if (COLOR_PROPS.has(name) && obj[name] instanceof THREE.Color) {
    toColor(value, obj[name]);
    return;
  }
  if (COLOR_PROPS.has(name) && obj[name] === undefined) {
    obj[name] = toColor(value);
    return;
  }

  // Vector props (position, scale, up, …)
  if (VECTOR_PROPS.has(name) && obj[name] instanceof THREE.Vector3) {
    toVector3(value, obj[name]);
    return;
  }

  // Euler (rotation)
  if (EULER_PROPS.has(name) && obj[name] instanceof THREE.Euler) {
    toEuler(value, obj[name]);
    return;
  }

  // Generic fall-through: respect the current slot's type when possible.
  const cur = obj[name];
  if (cur && typeof cur === "object") {
    if (cur.isVector3) {
      toVector3(value, cur);
      return;
    }
    if (cur.isColor) {
      toColor(value, cur);
      return;
    }
    if (cur.isEuler) {
      toEuler(value, cur);
      return;
    }
    if (cur.isQuaternion && Array.isArray(value)) {
      cur.set(value[0] ?? 0, value[1] ?? 0, value[2] ?? 0, value[3] ?? 1);
      return;
    }
  }
  // Direct assignment.
  try {
    obj[name] = value;
  } catch {
    // Some three properties are getter-only (e.g., `id`); silently skip.
  }
}

// Initial-mount prop application — reads `args` first (already consumed
// by the factory), then everything else.
export function applyInitialProps(obj: any, props: Record<string, any>): void {
  for (const key of Object.keys(props)) {
    if (key === "args" || key === "children") continue;
    applyProp(obj, key, props[key]);
  }
}

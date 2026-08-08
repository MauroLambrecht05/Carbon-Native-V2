// @carbon/three / test / fixtures / snapshot-scene.ts
//
// Canonical scene + frame-normalization helpers used by both the snapshot
// test and the regen script. Centralizing them here keeps both call sites
// in lockstep.

import * as THREE from "three";
import type { DrawCommand } from "@carbon/three";

export interface BuiltScene {
  scene: THREE.Scene;
  camera: THREE.Camera;
}

// Deterministic scene exercising every command type and material kind.
//
// Layout:
//   * one ambient + one directional light
//   * three meshes: basic / standard / phong, in a row
//   * one line + one points object behind the meshes
//   * one mesh deliberately placed offscreen to verify culling
export function buildSnapshotScene(): BuiltScene {
  const scene = new THREE.Scene();

  // Lights
  scene.add(new THREE.AmbientLight(0x202020, 0.5));
  const dir = new THREE.DirectionalLight(0xffffff, 1.0);
  dir.position.set(5, 10, 7);
  dir.target.position.set(0, 0, 0);
  scene.add(dir, dir.target);

  // Meshes
  const basicCube = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial({ color: 0xff0000 })
  );
  basicCube.position.set(-2, 0, 0);

  const stdSphere = new THREE.Mesh(
    new THREE.SphereGeometry(0.5, 8, 6),
    new THREE.MeshStandardMaterial({ color: 0x00ff00, metalness: 0.3, roughness: 0.4 })
  );
  stdSphere.position.set(0, 0, 0);

  const phongPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshPhongMaterial({ color: 0x0000ff, shininess: 50 })
  );
  phongPlane.position.set(2, 0, 0);

  scene.add(basicCube, stdSphere, phongPlane);

  // Line
  const lineGeom = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-1, 1, 0),
    new THREE.Vector3(0, 2, 0),
    new THREE.Vector3(1, 1, 0),
  ]);
  scene.add(new THREE.Line(lineGeom, new THREE.LineBasicMaterial({ color: 0xffff00 })));

  // Points
  const pointsGeom = new THREE.BufferGeometry();
  pointsGeom.setAttribute(
    "position",
    new THREE.BufferAttribute(
      new Float32Array([-1, -1, 0, 0, -1, 0, 1, -1, 0]),
      3
    )
  );
  scene.add(new THREE.Points(pointsGeom, new THREE.PointsMaterial({ color: 0xff00ff, size: 4 })));

  // Offscreen mesh — should be culled.
  const offscreen = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  offscreen.position.set(0, 0, 1000);
  scene.add(offscreen);

  // Camera
  const camera = new THREE.PerspectiveCamera(60, 4 / 3, 0.1, 100);
  camera.position.set(0, 0, 6);
  camera.lookAt(0, 0, 0);

  return { scene, camera };
}

// ─── Frame normalization ─────────────────────────────────────────────────
// Convert a DrawCommand[] into a JSON-serializable shape. We:
//   * tag every TypedArray with its constructor name + length + first/last
//     few values so the fixture isn't multi-megabyte
//   * round floats to 4 decimals (cross-platform float drift)
//
// We don't store the full positions/indices payloads — they're huge and
// stable within three.js itself; the constructor + length signal is plenty
// to catch a regression in our walker.
export function normalizeFrame(frame: DrawCommand[]): unknown {
  return frame.map(normalizeCommand);
}

function normalizeCommand(cmd: DrawCommand): unknown {
  return walk(cmd);
}

const ROUND = 1e4;
function r(n: number): number {
  if (!Number.isFinite(n)) return n;
  const v = Math.round(n * ROUND) / ROUND;
  // Collapse -0 to 0 so JSON serialization is stable: JSON.stringify
  // emits "0" for both, but our round-trip via JSON.parse + deepEqual
  // distinguishes them. Normalize here.
  return v === 0 ? 0 : v;
}

function walk(v: unknown, key?: string): unknown {
  if (v === null || v === undefined) return v;
  // Geometry/texture ids are allocated from a process-wide counter and so
  // are non-deterministic across test orderings. Strip them — what matters
  // for the snapshot is that they exist and are reused consistently within
  // a single render, which other tests already cover.
  if (key === "geometryId" || (key === "id" && typeof v === "number")) {
    return "<id>";
  }
  if (typeof v === "number") return r(v);
  if (typeof v === "string" || typeof v === "boolean") return v;
  if (
    v instanceof Float32Array ||
    v instanceof Float64Array ||
    v instanceof Uint8Array ||
    v instanceof Uint16Array ||
    v instanceof Uint32Array ||
    v instanceof Int8Array ||
    v instanceof Int16Array ||
    v instanceof Int32Array
  ) {
    const arr = v as unknown as ArrayLike<number>;
    const len = arr.length;
    // Sample first 4 + last 4 elements, rounded.
    const head: number[] = [];
    const tail: number[] = [];
    for (let i = 0; i < Math.min(4, len); i++) head.push(r(arr[i]));
    for (let i = Math.max(len - 4, 4); i < len; i++) tail.push(r(arr[i]));
    return {
      __typed: v.constructor.name,
      length: len,
      head,
      tail,
    };
  }
  if (Array.isArray(v)) {
    return v.map((item) => walk(item));
  }
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v)) {
      out[k] = walk((v as any)[k], k);
    }
    return out;
  }
  return v;
}

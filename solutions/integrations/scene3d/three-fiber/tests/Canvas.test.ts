// @carbon/three-fiber / test / Canvas.test.ts
//
// End-to-end tests that wire up:
//   1. The three-fiber renderer (mounting a JSX-tree-equivalent into a
//      THREE.Scene)
//   2. A CarbonRenderer + MockCommandExecutor
//   3. A `render(scene, camera)` call that exercises the full pipeline
//
// We call the renderer primitives directly instead of JSX so the tests
// don't need vite-plugin-solid. The shape of the calls matches exactly
// what the JSX compiler emits for the `<Canvas>` example in the README.

import { describe, expect, it } from "bun:test";
import * as THREE from "three";
import { CarbonRenderer, MockCommandExecutor } from "@carbon/three";
import type { MeshCommand } from "@carbon/three";
// three-fiber's renderer.js isn't part of its public package exports (only
// "." and "./types" are), so this stays a relative reach-back to the source
// rather than a package-name import.
import { createThreeFiberRenderer, wrapAsNode } from "../renderer.ts";

function buildScene() {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(75, 4 / 3, 0.1, 1000);
  camera.position.set(0, 0, 5);
  camera.lookAt(0, 0, 0);
  return { scene, camera };
}

describe("end-to-end: @carbon/three-fiber + @carbon/three", () => {
  it("a mesh + box geometry + standard material flows through the command stream", () => {
    const tfr = createThreeFiberRenderer();
    const { scene, camera } = buildScene();
    const root = wrapAsNode(scene);

    // <mesh position={[0,0,0]}>
    //   <boxGeometry args={[1,1,1]} />
    //   <meshStandardMaterial color={0xff8800} />
    // </mesh>
    const mesh = tfr.createElement("mesh");
    (tfr as any).setProp(mesh, "position", [0, 0, 0]);
    const geom = tfr.createElement("boxGeometry");
    (tfr as any).setProp(geom, "args", [1, 1, 1]);
    const mat = tfr.createElement("meshStandardMaterial");
    (tfr as any).setProp(mat, "color", 0xff8800);
    tfr.insertNode(mesh, geom);
    tfr.insertNode(mesh, mat);
    tfr.insertNode(root, mesh);

    const exec = new MockCommandExecutor();
    const r3 = new CarbonRenderer({ executor: exec, canvas: { width: 400, height: 300 } });
    r3.render(scene, camera);

    const meshes = exec.lastFrame().filter((c) => c.type === "mesh") as MeshCommand[];
    expect(meshes.length).toBe(1);
    expect(meshes[0].material.type).toBe("standard");
    // The exact color values depend on three's working color space (sRGB
    // → linear) which has changed across versions — we just verify the
    // color flowed through (red dominant, no green/blue garbage). Any
    // non-trivial red value > 0.5 means our prop made it onto the
    // material's three.Color instance.
    expect(meshes[0].material.color[0]).toBeGreaterThan(0.5);
    expect(meshes[0].material.color[2]).toBeLessThan(0.05); // hex #ff8800 has no blue
  });

  it("ambient + directional + point lights propagate to the setLights command", () => {
    const tfr = createThreeFiberRenderer();
    const { scene, camera } = buildScene();
    const root = wrapAsNode(scene);

    const a = tfr.createElement("ambientLight");
    (tfr as any).setProp(a, "args", [0xffffff, 0.5]);
    tfr.insertNode(root, a);

    const d = tfr.createElement("directionalLight");
    (tfr as any).setProp(d, "args", [0xffffff, 1.0]);
    (tfr as any).setProp(d, "position", [5, 5, 5]);
    tfr.insertNode(root, d);

    const p = tfr.createElement("pointLight");
    (tfr as any).setProp(p, "args", [0xff0000, 2.0, 100, 1]);
    (tfr as any).setProp(p, "position", [0, 0, 1]);
    tfr.insertNode(root, p);

    const exec = new MockCommandExecutor();
    const r3 = new CarbonRenderer({ executor: exec });
    r3.render(scene, camera);

    const setLights = exec.lastFrame().find((c) => c.type === "setLights")! as any;
    expect(setLights).toBeDefined();
    expect(setLights.lights.length).toBe(3);
    const types = setLights.lights.map((l: any) => l.type).sort();
    expect(types).toEqual(["ambient", "directional", "point"]);
  });

  it("nested groups preserve world-space transforms through the command stream", () => {
    const tfr = createThreeFiberRenderer();
    const { scene, camera } = buildScene();
    const root = wrapAsNode(scene);

    const group = tfr.createElement("group");
    (tfr as any).setProp(group, "position", [10, 0, 0]);
    const inner = tfr.createElement("group");
    (tfr as any).setProp(inner, "position", [0, 5, 0]);
    const mesh = tfr.createElement("mesh");
    (tfr as any).setProp(mesh, "position", [0, 0, 2]);
    const geom = tfr.createElement("boxGeometry");
    const mat = tfr.createElement("meshBasicMaterial");
    tfr.insertNode(mesh, geom);
    tfr.insertNode(mesh, mat);
    tfr.insertNode(inner, mesh);
    tfr.insertNode(group, inner);
    tfr.insertNode(root, group);

    const exec = new MockCommandExecutor();
    const r3 = new CarbonRenderer({
      executor: exec,
      enableFrustumCulling: false, // mesh at +z=2 vs camera @ z=5 is in-frustum, but be safe
    });
    r3.render(scene, camera);

    const meshes = exec.lastFrame().filter((c) => c.type === "mesh") as MeshCommand[];
    expect(meshes.length).toBe(1);
    // Column-major translation lives at indices 12..14.
    expect(meshes[0].transform[12]).toBeCloseTo(10, 5);
    expect(meshes[0].transform[13]).toBeCloseTo(5, 5);
    expect(meshes[0].transform[14]).toBeCloseTo(2, 5);
  });

  it("subsequent renders after a reactive update reflect the new state", () => {
    const tfr = createThreeFiberRenderer();
    const { scene, camera } = buildScene();
    const root = wrapAsNode(scene);

    const mesh = tfr.createElement("mesh");
    (tfr as any).setProp(mesh, "position", [0, 0, 0]);
    const geom = tfr.createElement("boxGeometry");
    const mat = tfr.createElement("meshBasicMaterial");
    tfr.insertNode(mesh, geom);
    tfr.insertNode(mesh, mat);
    tfr.insertNode(root, mesh);

    const exec = new MockCommandExecutor();
    const r3 = new CarbonRenderer({ executor: exec, enableFrustumCulling: false });

    r3.render(scene, camera);
    let m = exec.lastFrame().filter((c) => c.type === "mesh")[0] as MeshCommand;
    expect(m.transform[12]).toBeCloseTo(0, 5);

    // Simulate Solid's reactive update.
    (tfr as any).setProp(mesh, "position", [3, 0, 0]);
    r3.render(scene, camera);
    m = exec.lastFrame().filter((c) => c.type === "mesh")[0] as MeshCommand;
    expect(m.transform[12]).toBeCloseTo(3, 5);
  });

  it("removing a mesh removes it from subsequent frames", () => {
    const tfr = createThreeFiberRenderer();
    const { scene, camera } = buildScene();
    const root = wrapAsNode(scene);

    const mesh = tfr.createElement("mesh");
    const geom = tfr.createElement("boxGeometry");
    const mat = tfr.createElement("meshBasicMaterial");
    tfr.insertNode(mesh, geom);
    tfr.insertNode(mesh, mat);
    tfr.insertNode(root, mesh);

    const exec = new MockCommandExecutor();
    const r3 = new CarbonRenderer({ executor: exec, enableFrustumCulling: false });
    r3.render(scene, camera);
    expect(exec.meshCountInLastFrame()).toBe(1);

    tfr.removeNode(root, mesh);
    r3.render(scene, camera);
    expect(exec.meshCountInLastFrame()).toBe(0);
  });
});

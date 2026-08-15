// @carbon/three-fiber / test / renderer.test.ts
//
// Tests for the three-fiber renderer — the piece that maps JSX intrinsics
// to three.js objects via Solid's universal renderer. We exercise it
// without going through the actual JSX compiler so the tests don't
// need vite-plugin-solid configured for bun:test. Instead, we call the
// renderer's primitives (createElement / setProperty / insertNode /
// removeNode) directly — exactly what the JSX compiler emits.

import { describe, expect, it } from "bun:test";
import * as THREE from "three";
// renderer.js and intrinsics.js aren't part of three-fiber's public exports,
// so these stay relative reach-backs to the source.
import {
  createThreeFiberRenderer,
  wrapAsNode,
} from "../infrastructure/renderer.ts";
import { applyProp, getIntrinsicSpec } from "../infrastructure/intrinsics.ts";

// Mini-helper: build a node + apply props + insert, matching what the
// JSX compiler would emit for `<tag args={...} prop={...} />`.
function makeNode(
  tfr: ReturnType<typeof createThreeFiberRenderer>,
  tag: string,
  props: Record<string, any> = {}
): any {
  const node = tfr.createElement(tag);
  for (const k of Object.keys(props)) {
    (tfr as any).setProp(node, k, props[k]);
  }
  return node;
}

describe("intrinsic registry", () => {
  it("knows about mesh, group, lights, cameras, geometries, materials", () => {
    expect(getIntrinsicSpec("mesh")).toBeDefined();
    expect(getIntrinsicSpec("group")).toBeDefined();
    expect(getIntrinsicSpec("ambientLight")).toBeDefined();
    expect(getIntrinsicSpec("directionalLight")).toBeDefined();
    expect(getIntrinsicSpec("pointLight")).toBeDefined();
    expect(getIntrinsicSpec("perspectiveCamera")).toBeDefined();
    expect(getIntrinsicSpec("orthographicCamera")).toBeDefined();
    expect(getIntrinsicSpec("boxGeometry")).toBeDefined();
    expect(getIntrinsicSpec("sphereGeometry")).toBeDefined();
    expect(getIntrinsicSpec("planeGeometry")).toBeDefined();
    expect(getIntrinsicSpec("meshBasicMaterial")).toBeDefined();
    expect(getIntrinsicSpec("meshStandardMaterial")).toBeDefined();
    expect(getIntrinsicSpec("meshPhongMaterial")).toBeDefined();
  });

  it("returns undefined for unknown tags", () => {
    expect(getIntrinsicSpec("notAThing")).toBeUndefined();
  });

  it("accepts the __r3f_-prefixed alias form alongside the bare name", () => {
    // The @carbon/vite-three-bridge can — in alternative rewrite
    // modes — emit prefixed intrinsic names like `__r3f_mesh` to
    // disambiguate from outer-tree intrinsics. The registry strips the
    // prefix before lookup so both forms resolve to the same spec.
    const bare = getIntrinsicSpec("mesh");
    const prefixed = getIntrinsicSpec("__r3f_mesh");
    expect(bare).toBeDefined();
    expect(prefixed).toBeDefined();
    expect(prefixed).toBe(bare!);

    expect(getIntrinsicSpec("__r3f_boxGeometry")).toBe(getIntrinsicSpec("boxGeometry")!);
    expect(getIntrinsicSpec("__r3f_meshStandardMaterial")).toBe(getIntrinsicSpec("meshStandardMaterial")!);
    // Prefixed unknowns still return undefined.
    expect(getIntrinsicSpec("__r3f_notARealIntrinsic")).toBeUndefined();
  });

  it("attaches geometries via 'geometry', materials via 'material', objects as children", () => {
    expect(getIntrinsicSpec("boxGeometry")!.attachTo).toBe("geometry");
    expect(getIntrinsicSpec("meshStandardMaterial")!.attachTo).toBe("material");
    expect(getIntrinsicSpec("mesh")!.attachTo).toBe("child");
    expect(getIntrinsicSpec("ambientLight")!.attachTo).toBe("child");
  });
});

describe("scene tree construction", () => {
  it("creates a mesh under a scene with a geometry + material child", () => {
    const tfr = createThreeFiberRenderer();
    const scene = new THREE.Scene();
    const root = wrapAsNode(scene);

    // <mesh position={[1,2,3]}>
    //   <boxGeometry args={[2,3,4]} />
    //   <meshStandardMaterial color={0x00ff00} />
    // </mesh>
    const mesh = makeNode(tfr, "mesh", { position: [1, 2, 3] });
    const geom = makeNode(tfr, "boxGeometry", { args: [2, 3, 4] });
    const mat = makeNode(tfr, "meshStandardMaterial", { color: 0x00ff00 });
    tfr.insertNode(mesh, geom);
    tfr.insertNode(mesh, mat);
    tfr.insertNode(root, mesh);

    expect(scene.children.length).toBe(1);
    const m = scene.children[0] as THREE.Mesh;
    expect(m.isMesh).toBe(true);
    expect(m.position.x).toBe(1);
    expect(m.position.y).toBe(2);
    expect(m.position.z).toBe(3);
    const geometry = m.geometry as THREE.BoxGeometry;
    expect(geometry.type).toBe("BoxGeometry");
    // BoxGeometry's parameters are stashed on the geometry — confirm
    // the args arg actually flowed through.
    expect((geometry as any).parameters.width).toBe(2);
    expect((geometry as any).parameters.height).toBe(3);
    expect((geometry as any).parameters.depth).toBe(4);
    const material = m.material as THREE.MeshStandardMaterial;
    expect(material.type).toBe("MeshStandardMaterial");
    expect(material.color.getHex()).toBe(0x00ff00);
  });

  it("creates a group with nested meshes, transforms compose correctly", () => {
    const tfr = createThreeFiberRenderer();
    const scene = new THREE.Scene();
    const root = wrapAsNode(scene);

    const group = makeNode(tfr, "group", { position: [10, 0, 0] });
    const mesh = makeNode(tfr, "mesh", { position: [0, 5, 0] });
    const geom = makeNode(tfr, "boxGeometry", { args: [1, 1, 1] });
    const mat = makeNode(tfr, "meshBasicMaterial");
    tfr.insertNode(mesh, geom);
    tfr.insertNode(mesh, mat);
    tfr.insertNode(group, mesh);
    tfr.insertNode(root, group);

    scene.updateMatrixWorld(true);
    const child = (scene.children[0] as THREE.Group).children[0] as THREE.Mesh;
    expect(child.matrixWorld.elements[12]).toBeCloseTo(10, 5);
    expect(child.matrixWorld.elements[13]).toBeCloseTo(5, 5);
  });

  it("ambient + directional + point lights live as scene children", () => {
    const tfr = createThreeFiberRenderer();
    const scene = new THREE.Scene();
    const root = wrapAsNode(scene);

    const a = makeNode(tfr, "ambientLight", { intensity: 0.4 });
    const d = makeNode(tfr, "directionalLight", { intensity: 1.0, position: [5, 5, 5] });
    const p = makeNode(tfr, "pointLight", { intensity: 2.0, position: [1, 2, 3], distance: 10, decay: 2 });
    tfr.insertNode(root, a);
    tfr.insertNode(root, d);
    tfr.insertNode(root, p);

    expect(scene.children.length).toBe(3);
    expect((scene.children[0] as THREE.AmbientLight).intensity).toBe(0.4);
    expect((scene.children[1] as THREE.DirectionalLight).position.x).toBe(5);
    const pl = scene.children[2] as THREE.PointLight;
    expect(pl.distance).toBe(10);
    expect(pl.decay).toBe(2);
  });

  it("perspective + orthographic camera intrinsics construct correctly with args", () => {
    const tfr = createThreeFiberRenderer();
    const scene = new THREE.Scene();
    const root = wrapAsNode(scene);

    const persp = makeNode(tfr, "perspectiveCamera", {
      args: [60, 16 / 9, 0.5, 500],
      position: [0, 0, 5],
    });
    const ortho = makeNode(tfr, "orthographicCamera", {
      args: [-1, 1, 1, -1, 0.1, 100],
    });
    tfr.insertNode(root, persp);
    tfr.insertNode(root, ortho);

    const p = scene.children[0] as THREE.PerspectiveCamera;
    expect(p.fov).toBe(60);
    expect(p.aspect).toBeCloseTo(16 / 9, 5);
    expect(p.near).toBe(0.5);
    expect(p.far).toBe(500);
    expect(p.position.z).toBe(5);

    const o = scene.children[1] as THREE.OrthographicCamera;
    expect(o.left).toBe(-1);
    expect(o.right).toBe(1);
  });
});

describe("reactive prop updates", () => {
  it("setProp on position mutates the three object in place", () => {
    const tfr = createThreeFiberRenderer();
    const scene = new THREE.Scene();
    const root = wrapAsNode(scene);

    const mesh = makeNode(tfr, "mesh", { position: [0, 0, 0] });
    const geom = makeNode(tfr, "boxGeometry");
    const mat = makeNode(tfr, "meshBasicMaterial");
    tfr.insertNode(mesh, geom);
    tfr.insertNode(mesh, mat);
    tfr.insertNode(root, mesh);

    const m = scene.children[0] as THREE.Mesh;
    const positionRef = m.position;
    // simulate Solid's reactive update
    (tfr as any).setProp(mesh, "position", [10, 20, 30]);
    expect(m.position.x).toBe(10);
    expect(m.position.y).toBe(20);
    expect(m.position.z).toBe(30);
    // identity preserved (in-place mutation, not a fresh Vector3)
    expect(m.position).toBe(positionRef);
  });

  it("component-wise rotation-y prop updates the y axis only", () => {
    const tfr = createThreeFiberRenderer();
    const scene = new THREE.Scene();
    const root = wrapAsNode(scene);

    const mesh = makeNode(tfr, "mesh");
    const geom = makeNode(tfr, "boxGeometry");
    const mat = makeNode(tfr, "meshBasicMaterial");
    tfr.insertNode(mesh, geom);
    tfr.insertNode(mesh, mat);
    tfr.insertNode(root, mesh);

    const m = scene.children[0] as THREE.Mesh;
    (tfr as any).setProp(mesh, "rotation-y", Math.PI / 2);
    expect(m.rotation.y).toBeCloseTo(Math.PI / 2, 5);
    expect(m.rotation.x).toBe(0);
    expect(m.rotation.z).toBe(0);
  });

  it("color prop accepts hex number, hex string, named color, and Color instance", () => {
    const tfr = createThreeFiberRenderer();
    const scene = new THREE.Scene();
    const root = wrapAsNode(scene);

    const mesh = makeNode(tfr, "mesh");
    const geom = makeNode(tfr, "boxGeometry");
    const mat = makeNode(tfr, "meshBasicMaterial", { color: 0xff0000 });
    tfr.insertNode(mesh, geom);
    tfr.insertNode(mesh, mat);
    tfr.insertNode(root, mesh);

    const m = scene.children[0] as THREE.Mesh;
    const material = m.material as THREE.MeshBasicMaterial;
    expect(material.color.getHex()).toBe(0xff0000);

    // string
    (tfr as any).setProp(mat, "color", "blue");
    expect(material.color.getHex()).toBe(0x0000ff);

    // three.Color
    const c = new THREE.Color(0x00ff88);
    (tfr as any).setProp(mat, "color", c);
    expect(material.color.getHex()).toBe(0x00ff88);

    // tuple
    (tfr as any).setProp(mat, "color", [1, 1, 0]);
    expect(material.color.getHex()).toBe(0xffff00);
  });

  it("nested r3f-style shorthand: material-color updates the parent's material color", () => {
    const tfr = createThreeFiberRenderer();
    const scene = new THREE.Scene();
    const root = wrapAsNode(scene);

    const mesh = makeNode(tfr, "mesh");
    const geom = makeNode(tfr, "boxGeometry");
    const mat = makeNode(tfr, "meshBasicMaterial", { color: 0xffffff });
    tfr.insertNode(mesh, geom);
    tfr.insertNode(mesh, mat);
    tfr.insertNode(root, mesh);

    const m = scene.children[0] as THREE.Mesh;
    (tfr as any).setProp(mesh, "material-color", 0xff8800);
    expect((m.material as THREE.MeshBasicMaterial).color.getHex()).toBe(0xff8800);
  });
});

describe("unmount + disposal", () => {
  it("removeNode detaches the mesh from the scene", () => {
    const tfr = createThreeFiberRenderer();
    const scene = new THREE.Scene();
    const root = wrapAsNode(scene);

    const mesh = makeNode(tfr, "mesh");
    const geom = makeNode(tfr, "boxGeometry");
    const mat = makeNode(tfr, "meshBasicMaterial");
    tfr.insertNode(mesh, geom);
    tfr.insertNode(mesh, mat);
    tfr.insertNode(root, mesh);

    expect(scene.children.length).toBe(1);
    tfr.removeNode(root, mesh);
    expect(scene.children.length).toBe(0);
  });

  it("removeNode disposes geometry + material on a removed mesh", () => {
    const tfr = createThreeFiberRenderer();
    const scene = new THREE.Scene();
    const root = wrapAsNode(scene);

    const mesh = makeNode(tfr, "mesh");
    const geom = makeNode(tfr, "boxGeometry");
    const mat = makeNode(tfr, "meshBasicMaterial");
    tfr.insertNode(mesh, geom);
    tfr.insertNode(mesh, mat);
    tfr.insertNode(root, mesh);

    let geomDisposed = false;
    let matDisposed = false;
    const m = scene.children[0] as THREE.Mesh;
    const origGeomDispose = m.geometry.dispose.bind(m.geometry);
    m.geometry.dispose = () => { geomDisposed = true; origGeomDispose(); };
    const matObj = m.material as THREE.MeshBasicMaterial;
    const origMatDispose = matObj.dispose.bind(matObj);
    matObj.dispose = () => { matDisposed = true; origMatDispose(); };

    tfr.removeNode(root, mesh);
    expect(geomDisposed).toBe(true);
    expect(matDisposed).toBe(true);
  });

  it("removeNode of a geometry node detaches it from the parent's .geometry slot", () => {
    const tfr = createThreeFiberRenderer();
    const scene = new THREE.Scene();
    const root = wrapAsNode(scene);

    const mesh = makeNode(tfr, "mesh");
    const geom = makeNode(tfr, "boxGeometry");
    const mat = makeNode(tfr, "meshBasicMaterial");
    tfr.insertNode(mesh, geom);
    tfr.insertNode(mesh, mat);
    tfr.insertNode(root, mesh);

    const m = scene.children[0] as THREE.Mesh;
    expect(m.geometry).toBeInstanceOf(THREE.BoxGeometry);
    tfr.removeNode(mesh, geom);
    expect(m.geometry).toBeNull();
  });
});

describe("primitive escape hatch", () => {
  it("<primitive object={...} /> wraps an existing three.js object", () => {
    const tfr = createThreeFiberRenderer();
    const scene = new THREE.Scene();
    const root = wrapAsNode(scene);

    const cube = new THREE.Mesh(
      new THREE.BoxGeometry(),
      new THREE.MeshBasicMaterial()
    );
    cube.position.set(7, 0, 0);
    const node = makeNode(tfr, "primitive", { object: cube });
    tfr.insertNode(root, node);

    expect(scene.children[0]).toBe(cube);
  });
});

describe("applyProp shape coverage", () => {
  it("euler array with 4 elements sets order", () => {
    const obj: any = { rotation: new THREE.Euler() };
    applyProp(obj, "rotation", [1, 2, 3, "ZYX"]);
    expect(obj.rotation.x).toBe(1);
    expect(obj.rotation.y).toBe(2);
    expect(obj.rotation.z).toBe(3);
    expect(obj.rotation.order).toBe("ZYX");
  });

  it("scalar position broadcasts to all axes", () => {
    const obj: any = { position: new THREE.Vector3() };
    applyProp(obj, "position", 5);
    expect(obj.position.x).toBe(5);
    expect(obj.position.y).toBe(5);
    expect(obj.position.z).toBe(5);
  });

  it("ref={fn} forwards the three.js object", () => {
    let captured: any = null;
    const obj: any = {};
    applyProp(obj, "ref", (x: any) => { captured = x; });
    expect(captured).toBe(obj);
  });
});

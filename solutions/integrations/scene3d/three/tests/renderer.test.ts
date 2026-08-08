// @carbon/three / test / renderer.test.ts
//
// Unit tests for the scene-walk + command emission pipeline. Run with:
//   bun test
//
// Each test:
//   1. builds a synthetic three.js scene
//   2. renders it through `CarbonRenderer` with a `MockCommandExecutor`
//   3. asserts the structure of the recorded command stream

import { describe, expect, it } from "bun:test";
import * as THREE from "three";
import { CarbonRenderer, MockCommandExecutor } from "@carbon/three";
import type { DrawCommand, MeshCommand, MaterialDesc } from "@carbon/three";

// ─── Helpers ──────────────────────────────────────────────────────────────
function defaultCamera(): THREE.PerspectiveCamera {
  // Camera positioned looking at the origin from +Z. Wide enough fov so
  // bounded geometry is in-frustum by default.
  const cam = new THREE.PerspectiveCamera(75, 4 / 3, 0.1, 1000);
  cam.position.set(0, 0, 10);
  cam.lookAt(0, 0, 0);
  return cam;
}

function makeRenderer(opts: { cull?: boolean } = {}) {
  const exec = new MockCommandExecutor();
  const renderer = new CarbonRenderer({
    executor: exec,
    enableFrustumCulling: opts.cull ?? true,
    canvas: { width: 400, height: 300 },
  });
  return { exec, renderer };
}

// ─── Header commands ──────────────────────────────────────────────────────
describe("header commands", () => {
  it("emits clear, setCamera, setLights in order on every render", () => {
    const { exec, renderer } = makeRenderer();
    const scene = new THREE.Scene();
    renderer.render(scene, defaultCamera());

    const frame = exec.lastFrame();
    expect(frame.length).toBeGreaterThanOrEqual(3);
    expect(frame[0].type).toBe("clear");
    expect(frame[1].type).toBe("setCamera");
    expect(frame[2].type).toBe("setLights");
  });

  it("clear color defaults to opaque black", () => {
    const { exec, renderer } = makeRenderer();
    renderer.render(new THREE.Scene(), defaultCamera());
    const clear = exec.lastFrame()[0] as Extract<DrawCommand, { type: "clear" }>;
    expect(clear.rgba).toEqual([0, 0, 0, 1]);
  });

  it("setClearColor flows through to the clear command", () => {
    const exec = new MockCommandExecutor();
    const renderer = new CarbonRenderer({ executor: exec });
    renderer.setClearColor(0xff0000, 0.5);
    renderer.render(new THREE.Scene(), defaultCamera());
    const clear = exec.lastFrame()[0] as Extract<DrawCommand, { type: "clear" }>;
    expect(clear.rgba[0]).toBeCloseTo(1, 5);
    expect(clear.rgba[1]).toBeCloseTo(0, 5);
    expect(clear.rgba[2]).toBeCloseTo(0, 5);
    expect(clear.rgba[3]).toBeCloseTo(0.5, 5);
  });

  it("setCamera carries 16-element view + projection matrices and a position", () => {
    const { exec, renderer } = makeRenderer();
    const cam = defaultCamera();
    renderer.render(new THREE.Scene(), cam);
    const setCam = exec.lastFrame()[1] as Extract<DrawCommand, { type: "setCamera" }>;
    expect(setCam.camera.view).toBeInstanceOf(Float32Array);
    expect(setCam.camera.view.length).toBe(16);
    expect(setCam.camera.projection.length).toBe(16);
    expect(setCam.camera.position).toEqual([0, 0, 10]);
  });

  it("orthographic camera passes through its own projection matrix", () => {
    const { exec, renderer } = makeRenderer();
    const cam = new THREE.OrthographicCamera(-5, 5, 5, -5, 0.1, 100);
    cam.position.set(0, 0, 10);
    cam.lookAt(0, 0, 0);
    renderer.render(new THREE.Scene(), cam);
    const setCam = exec.lastFrame()[1] as Extract<DrawCommand, { type: "setCamera" }>;
    // Ortho projections have a 1.0 in the [3,3] slot (column-major index 15).
    expect(setCam.camera.projection[15]).toBe(1);
  });
});

// ─── Mesh emission ────────────────────────────────────────────────────────
describe("mesh emission", () => {
  it("emits one mesh command per Mesh in the scene", () => {
    const { exec, renderer } = makeRenderer({ cull: false });
    const scene = new THREE.Scene();
    for (let i = 0; i < 5; i++) {
      const m = new THREE.Mesh(
        new THREE.BoxGeometry(1, 1, 1),
        new THREE.MeshBasicMaterial({ color: 0xff8800 })
      );
      m.position.set(i, 0, 0);
      scene.add(m);
    }
    renderer.render(scene, defaultCamera());
    expect(exec.meshCountInLastFrame()).toBe(5);
  });

  it("preserves world transform via matrixWorld", () => {
    const { exec, renderer } = makeRenderer({ cull: false });
    const scene = new THREE.Scene();
    const parent = new THREE.Group();
    parent.position.set(10, 0, 0);
    const child = new THREE.Mesh(
      new THREE.BoxGeometry(),
      new THREE.MeshBasicMaterial()
    );
    child.position.set(0, 5, 0); // local
    parent.add(child);
    scene.add(parent);

    renderer.render(scene, defaultCamera());
    const meshes = exec.lastFrame().filter((c) => c.type === "mesh") as MeshCommand[];
    expect(meshes.length).toBe(1);
    // Column-major translation lives in elements[12..14].
    expect(meshes[0].transform[12]).toBeCloseTo(10, 5);
    expect(meshes[0].transform[13]).toBeCloseTo(5, 5);
    expect(meshes[0].transform[14]).toBeCloseTo(0, 5);
  });

  it("emits positions, normals, uvs, indices for indexed BoxGeometry", () => {
    const { exec, renderer } = makeRenderer({ cull: false });
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()));
    renderer.render(scene, defaultCamera());
    const m = exec.lastFrame().filter((c) => c.type === "mesh")[0] as MeshCommand;
    expect(m.positions).toBeInstanceOf(Float32Array);
    expect(m.normals).toBeInstanceOf(Float32Array);
    expect(m.uvs).toBeInstanceOf(Float32Array);
    expect(m.indices.length).toBeGreaterThan(0);
    // Box has 24 vertices (4 per face * 6 faces) and 36 indices.
    expect(m.positions.length).toBe(24 * 3);
    expect(m.indices.length).toBe(36);
  });

  it("synthesizes indices for non-indexed geometry", () => {
    const { exec, renderer } = makeRenderer({ cull: false });
    const scene = new THREE.Scene();
    const g = new THREE.BufferGeometry();
    // 1 triangle, no index buffer.
    g.setAttribute(
      "position",
      new THREE.BufferAttribute(
        new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        3
      )
    );
    scene.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial()));
    renderer.render(scene, defaultCamera());
    const m = exec.lastFrame().filter((c) => c.type === "mesh")[0] as MeshCommand;
    expect(m.indices).toBeInstanceOf(Uint16Array);
    expect(Array.from(m.indices)).toEqual([0, 1, 2]);
  });

  it("computes a normal matrix matching three's getNormalMatrix()", () => {
    const { exec, renderer } = makeRenderer({ cull: false });
    const scene = new THREE.Scene();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
    mesh.position.set(2, 3, 4);
    mesh.rotation.set(0.5, 0.7, 0.1);
    mesh.scale.set(1, 2, 3);
    scene.add(mesh);
    renderer.render(scene, defaultCamera());
    const m = exec.lastFrame().filter((c) => c.type === "mesh")[0] as MeshCommand;

    // Reference: three computes inverse-transpose of upper-3x3 of matrixWorld.
    mesh.updateMatrixWorld(true);
    const expected = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
    for (let i = 0; i < 9; i++) {
      expect(m.normalMatrix[i]).toBeCloseTo(expected.elements[i], 5);
    }
  });
});

// ─── Material translation ─────────────────────────────────────────────────
describe("material translation", () => {
  it("MeshBasicMaterial → 'basic' descriptor", () => {
    const { exec, renderer } = makeRenderer({ cull: false });
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(
      new THREE.BoxGeometry(),
      new THREE.MeshBasicMaterial({ color: 0x336699, opacity: 0.7, transparent: true })
    ));
    renderer.render(scene, defaultCamera());
    const m = exec.lastFrame().filter((c) => c.type === "mesh")[0] as MeshCommand;
    expect(m.material.type).toBe("basic");
    expect(m.material.opacity).toBeCloseTo(0.7, 5);
    expect(m.material.transparent).toBe(true);
  });

  it("MeshStandardMaterial → 'standard' descriptor with metalness/roughness", () => {
    const { exec, renderer } = makeRenderer({ cull: false });
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(
      new THREE.BoxGeometry(),
      new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.4, roughness: 0.2 })
    ));
    renderer.render(scene, defaultCamera());
    const m = exec.lastFrame().filter((c) => c.type === "mesh")[0] as MeshCommand;
    expect(m.material.type).toBe("standard");
    if (m.material.type === "standard") {
      expect(m.material.metalness).toBeCloseTo(0.4, 5);
      expect(m.material.roughness).toBeCloseTo(0.2, 5);
    }
  });

  it("MeshPhongMaterial → 'phong' descriptor with shininess", () => {
    const { exec, renderer } = makeRenderer({ cull: false });
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(
      new THREE.BoxGeometry(),
      new THREE.MeshPhongMaterial({ color: 0xff0000, shininess: 80 })
    ));
    renderer.render(scene, defaultCamera());
    const m = exec.lastFrame().filter((c) => c.type === "mesh")[0] as MeshCommand;
    expect(m.material.type).toBe("phong");
    if (m.material.type === "phong") {
      expect(m.material.shininess).toBeCloseTo(80, 5);
    }
  });

  it("emits a texture descriptor with pixels on first appearance, null on reuse", () => {
    const { exec, renderer } = makeRenderer({ cull: false });
    const scene = new THREE.Scene();

    // DataTexture: 2x2 RGBA, all red. We can ship pixels (unlike images
    // which need canvas readback).
    const data = new Uint8Array([
      255, 0, 0, 255,
      255, 0, 0, 255,
      255, 0, 0, 255,
      255, 0, 0, 255,
    ]);
    const tex = new THREE.DataTexture(data, 2, 2, THREE.RGBAFormat);
    tex.needsUpdate = true;

    const mat = new THREE.MeshBasicMaterial({ map: tex });
    const a = new THREE.Mesh(new THREE.BoxGeometry(), mat);
    const b = new THREE.Mesh(new THREE.BoxGeometry(), mat);
    a.position.set(0, 0, 0);
    b.position.set(2, 0, 0);
    scene.add(a, b);
    renderer.render(scene, defaultCamera());

    const meshes = exec.lastFrame().filter((c) => c.type === "mesh") as MeshCommand[];
    expect(meshes.length).toBe(2);
    const map0 = (meshes[0].material as MaterialDesc & { map: any }).map;
    const map1 = (meshes[1].material as MaterialDesc & { map: any }).map;
    expect(map0).not.toBeNull();
    expect(map1).not.toBeNull();
    // Same id.
    expect(map0!.id).toBe(map1!.id);
    // Pixels uploaded once (first mesh), null on subsequent.
    expect(map0!.pixels).toBeInstanceOf(Uint8Array);
    expect(map1!.pixels).toBeNull();
  });

  it("ShaderMaterial falls back to magenta basic + warns", () => {
    const { exec, renderer } = makeRenderer({ cull: false });
    const scene = new THREE.Scene();
    const shader = new THREE.ShaderMaterial({
      vertexShader: "void main(){gl_Position=vec4(0.,0.,0.,1.);}",
      fragmentShader: "void main(){gl_FragColor=vec4(1.);}",
    });
    scene.add(new THREE.Mesh(new THREE.BoxGeometry(), shader));
    // Silence the warning during the test.
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      renderer.render(scene, defaultCamera());
    } finally {
      console.warn = originalWarn;
    }
    const m = exec.lastFrame().filter((c) => c.type === "mesh")[0] as MeshCommand;
    expect(m.material.type).toBe("basic");
    expect(m.material.color).toEqual([1, 0, 1]);
  });
});

// ─── Lights ───────────────────────────────────────────────────────────────
describe("lights", () => {
  it("aggregates lights into the setLights command", () => {
    const { exec, renderer } = makeRenderer({ cull: false });
    const scene = new THREE.Scene();
    scene.add(new THREE.AmbientLight(0x444444, 0.5));
    const dir = new THREE.DirectionalLight(0xffffff, 1.0);
    dir.position.set(0, 10, 0);
    dir.target.position.set(0, 0, 0);
    scene.add(dir);
    scene.add(dir.target);
    const pl = new THREE.PointLight(0xff8800, 2.0, 100, 1);
    pl.position.set(5, 0, 0);
    scene.add(pl);
    renderer.render(scene, defaultCamera());
    const setLights = exec.lastFrame()[2] as Extract<DrawCommand, { type: "setLights" }>;
    expect(setLights.lights.length).toBe(3);
    const types = setLights.lights.map((l) => l.type).sort();
    expect(types).toEqual(["ambient", "directional", "point"]);
  });

  it("directional light direction is normalized world-space (target - position)", () => {
    const { exec, renderer } = makeRenderer({ cull: false });
    const scene = new THREE.Scene();
    const dir = new THREE.DirectionalLight(0xffffff, 1.0);
    dir.position.set(0, 10, 0);
    dir.target.position.set(0, 0, 0);
    scene.add(dir, dir.target);
    renderer.render(scene, defaultCamera());
    const setLights = exec.lastFrame()[2] as Extract<DrawCommand, { type: "setLights" }>;
    const d = (setLights.lights[0] as any).direction as [number, number, number];
    // Should be (0, -1, 0) since target is below the light.
    expect(d[0]).toBeCloseTo(0, 5);
    expect(d[1]).toBeCloseTo(-1, 5);
    expect(d[2]).toBeCloseTo(0, 5);
  });

  it("point light position is in world space, follows parent transforms", () => {
    const { exec, renderer } = makeRenderer({ cull: false });
    const scene = new THREE.Scene();
    const group = new THREE.Group();
    group.position.set(10, 0, 0);
    const pl = new THREE.PointLight(0xffffff, 1.0);
    pl.position.set(0, 5, 0);
    group.add(pl);
    scene.add(group);
    renderer.render(scene, defaultCamera());
    const setLights = exec.lastFrame()[2] as Extract<DrawCommand, { type: "setLights" }>;
    const p = (setLights.lights[0] as any).position as [number, number, number];
    expect(p[0]).toBeCloseTo(10, 5);
    expect(p[1]).toBeCloseTo(5, 5);
    expect(p[2]).toBeCloseTo(0, 5);
  });

  it("invisible lights are not emitted", () => {
    const { exec, renderer } = makeRenderer({ cull: false });
    const scene = new THREE.Scene();
    const a = new THREE.AmbientLight(0xffffff, 1.0);
    a.visible = false;
    scene.add(a);
    renderer.render(scene, defaultCamera());
    const setLights = exec.lastFrame()[2] as Extract<DrawCommand, { type: "setLights" }>;
    expect(setLights.lights.length).toBe(0);
  });
});

// ─── Visibility / culling ─────────────────────────────────────────────────
describe("visibility & culling", () => {
  it("invisible objects are not emitted, and skip their subtree", () => {
    const { exec, renderer } = makeRenderer({ cull: false });
    const scene = new THREE.Scene();
    const hiddenParent = new THREE.Group();
    hiddenParent.visible = false;
    hiddenParent.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()));
    scene.add(hiddenParent);
    scene.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()));
    renderer.render(scene, defaultCamera());
    expect(exec.meshCountInLastFrame()).toBe(1);
  });

  it("frustum culls objects outside the view", () => {
    const { exec, renderer } = makeRenderer({ cull: true });
    const scene = new THREE.Scene();
    // In-frustum at origin, out-of-frustum way behind the camera.
    const inMesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    scene.add(inMesh);
    const outMesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    outMesh.position.set(0, 0, 1000); // behind camera @ z=10 looking at origin
    scene.add(outMesh);
    renderer.render(scene, defaultCamera());
    expect(exec.meshCountInLastFrame()).toBe(1);
    expect(renderer.stats.objectsCulled).toBe(1);
  });

  it("respects frustumCulled=false on individual objects", () => {
    const { exec, renderer } = makeRenderer({ cull: true });
    const scene = new THREE.Scene();
    const m = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    m.position.set(0, 0, 1000); // would normally be culled
    m.frustumCulled = false;
    scene.add(m);
    renderer.render(scene, defaultCamera());
    expect(exec.meshCountInLastFrame()).toBe(1);
  });

  it("disabling culling via the renderer flag emits everything", () => {
    const { exec, renderer } = makeRenderer({ cull: false });
    const scene = new THREE.Scene();
    for (let i = 0; i < 4; i++) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
      m.position.set(0, 0, 1000 + i);
      scene.add(m);
    }
    renderer.render(scene, defaultCamera());
    expect(exec.meshCountInLastFrame()).toBe(4);
  });
});

// ─── Lines & Points ───────────────────────────────────────────────────────
describe("lines & points", () => {
  it("THREE.Line emits a 'line' command with mode=LINE_STRIP", () => {
    const { exec, renderer } = makeRenderer({ cull: false });
    const scene = new THREE.Scene();
    const g = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(1, 1, 0),
    ]);
    const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0x00ff00 }));
    scene.add(line);
    renderer.render(scene, defaultCamera());
    const cmd = exec.lastFrame().find((c) => c.type === "line") as Extract<DrawCommand, { type: "line" }>;
    expect(cmd).toBeDefined();
    expect(cmd.mode).toBe(1);
    expect(cmd.color).toEqual([0, 1, 0]);
  });

  it("THREE.LineSegments emits mode=LINES", () => {
    const { exec, renderer } = makeRenderer({ cull: false });
    const scene = new THREE.Scene();
    const g = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(1, 0, 0),
    ]);
    scene.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial()));
    renderer.render(scene, defaultCamera());
    const cmd = exec.lastFrame().find((c) => c.type === "line") as Extract<DrawCommand, { type: "line" }>;
    expect(cmd.mode).toBe(0);
  });

  it("THREE.Points emits a 'points' command", () => {
    const { exec, renderer } = makeRenderer({ cull: false });
    const scene = new THREE.Scene();
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0]), 3));
    scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0x0000ff, size: 4 })));
    renderer.render(scene, defaultCamera());
    const cmd = exec.lastFrame().find((c) => c.type === "points") as Extract<DrawCommand, { type: "points" }>;
    expect(cmd).toBeDefined();
    expect(cmd.color).toEqual([0, 0, 1]);
    expect(cmd.size).toBe(4);
  });
});

// ─── Repeated render reuses the command list ──────────────────────────────
describe("repeated renders", () => {
  it("each render emits a complete, independent frame", () => {
    const { exec, renderer } = makeRenderer({ cull: false });
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()));
    renderer.render(scene, defaultCamera());
    renderer.render(scene, defaultCamera());
    renderer.render(scene, defaultCamera());
    expect(exec.frames.length).toBe(3);
    for (const f of exec.frames) {
      expect(f[0].type).toBe("clear");
      expect(f.filter((c) => c.type === "mesh").length).toBe(1);
    }
  });

  it("framesRendered counter advances", () => {
    const { exec, renderer } = makeRenderer({ cull: false });
    renderer.render(new THREE.Scene(), defaultCamera());
    renderer.render(new THREE.Scene(), defaultCamera());
    expect(renderer.stats.framesRendered).toBe(2);
  });
});

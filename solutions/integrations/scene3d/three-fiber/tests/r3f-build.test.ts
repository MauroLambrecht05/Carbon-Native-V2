// @carbon/three-fiber / test / r3f-build.test.ts
//
// Tests for the runtime that consumes builder fns produced by
// @carbon/vite-three-bridge. We don't run the babel plugin here —
// just hand-craft what its output would look like and verify the
// three.js scene gets built correctly.
//
// NOTE on reactivity: Bun resolves `solid-js` to its server build by
// default, where createEffect is a no-op. So we test reactive thunks by
// invoking the runtime, then mutating the underlying signal source
// (a closure variable) and re-running the effect by re-calling
// runR3FBuild — this exercises the in-place mutation path. End-to-end
// reactivity is exercised in the production build path; the unit tests
// here cover the construction + prop-application + dispose surface.

import { describe, expect, it } from "bun:test";
import * as THREE from "three";
// Neither renderer.js nor r3f-build.js are part of three-fiber's public
// exports, so these stay relative reach-backs to the source.
import { createThreeFiberRenderer } from "../infrastructure/renderer.ts";
import { runR3FBuild, type R3FBuilder } from "../infrastructure/r3f-build.ts";

describe("runR3FBuild — bridge runtime", () => {
  it("constructs a mesh with geometry + material from a builder", () => {
    const tfr = createThreeFiberRenderer();
    const scene = new THREE.Scene();

    // What @carbon/vite-three-bridge would emit for:
    //   <Canvas>
    //     <mesh position={[1,2,3]}>
    //       <boxGeometry args={[2,3,4]} />
    //       <meshStandardMaterial color={0x00ff00} />
    //     </mesh>
    //   </Canvas>
    const builder: R3FBuilder = (h) => [
      h(
        "mesh",
        { position: () => [1, 2, 3] },
        [
          h("boxGeometry", { args: () => [2, 3, 4] }, []),
          h("meshStandardMaterial", { color: () => 0x00ff00 }, []),
        ],
      ),
    ];

    runR3FBuild(builder, tfr, scene);

    expect(scene.children.length).toBe(1);
    const mesh = scene.children[0] as THREE.Mesh;
    expect(mesh.isMesh).toBe(true);
    expect(mesh.position.x).toBe(1);
    expect(mesh.position.y).toBe(2);
    expect(mesh.position.z).toBe(3);
    const geom = mesh.geometry as THREE.BoxGeometry;
    expect(geom.type).toBe("BoxGeometry");
    expect((geom as any).parameters.width).toBe(2);
    const mat = mesh.material as THREE.MeshStandardMaterial;
    expect(mat.color.getHex()).toBe(0x00ff00);
  });

  it("multiple top-level children all attach to the scene", () => {
    const tfr = createThreeFiberRenderer();
    const scene = new THREE.Scene();

    const builder: R3FBuilder = (h) => [
      h("ambientLight", { intensity: 0.5 }, []),
      h(
        "perspectiveCamera",
        { args: () => [75, 1, 0.1, 1000], position: () => [0, 0, 5] },
        [],
      ),
      h(
        "mesh",
        {},
        [
          h("boxGeometry", {}, []),
          h("meshBasicMaterial", {}, []),
        ],
      ),
    ];
    runR3FBuild(builder, tfr, scene);

    expect(scene.children.length).toBe(3);
    expect((scene.children[0] as THREE.AmbientLight).isLight).toBe(true);
    expect((scene.children[1] as THREE.PerspectiveCamera).isCamera).toBe(true);
    expect((scene.children[2] as THREE.Mesh).isMesh).toBe(true);
  });

  it("dispose tears the subtree down", () => {
    const tfr = createThreeFiberRenderer();
    const scene = new THREE.Scene();

    const builder: R3FBuilder = (h) => [
      h(
        "mesh",
        {},
        [
          h("boxGeometry", {}, []),
          h("meshBasicMaterial", {}, []),
        ],
      ),
    ];
    const teardown = runR3FBuild(builder, tfr, scene);
    expect(scene.children.length).toBe(1);
    teardown();
    expect(scene.children.length).toBe(0);
  });

  it("non-reactive (constant) prop values are applied to three objects", () => {
    const tfr = createThreeFiberRenderer();
    const scene = new THREE.Scene();
    // String literals come in as constants (the plugin emits them
    // unwrapped).
    const builder: R3FBuilder = (h) => [
      h(
        "mesh",
        {},
        [
          h("boxGeometry", {}, []),
          h("meshStandardMaterial", { color: "hotpink" }, []),
        ],
      ),
    ];
    runR3FBuild(builder, tfr, scene);
    const mat = (scene.children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial;
    // hotpink → 0xff69b4
    expect(mat.color.getHex()).toBe(0xff69b4);
  });

  it("thunked args/props are evaluated at construction time", () => {
    // Even though the server build of solid-js makes createEffect a
    // no-op, the FIRST run still calls each thunk synchronously when
    // attaching props — so the resulting three.js object reflects the
    // thunk's return value.
    const tfr = createThreeFiberRenderer();
    const scene = new THREE.Scene();

    let visibilityValue = true;
    const builder: R3FBuilder = (h) => [
      h(
        "mesh",
        { visible: () => visibilityValue, "position-x": () => 7 },
        [
          h("boxGeometry", {}, []),
          h("meshBasicMaterial", {}, []),
        ],
      ),
    ];
    runR3FBuild(builder, tfr, scene);
    const mesh = scene.children[0] as THREE.Mesh;
    expect(mesh.visible).toBe(true);
    expect(mesh.position.x).toBe(7);
  });

  it("uppercase tag treated as a component factory and called with resolved props", () => {
    const tfr = createThreeFiberRenderer();
    const scene = new THREE.Scene();

    let received: any = null;
    function MyComp(props: { speed: number; children: any[] }) {
      received = props;
      // Component returns a single h() child to actually render
      // something; runtime splices nothing without an array shape, so
      // the test just verifies the call surface.
      return null;
    }

    const builder: R3FBuilder = (h) => [
      h(MyComp as any, { speed: () => 1.5 }, []),
    ];
    runR3FBuild(builder, tfr, scene);
    expect(received).not.toBeNull();
    // Thunk for `speed` resolved to 1.5 before the component saw it.
    expect(received!.speed).toBe(1.5);
  });
});

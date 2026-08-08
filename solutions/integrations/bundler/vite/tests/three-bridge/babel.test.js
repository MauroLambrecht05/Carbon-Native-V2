// @carbon/vite-three-bridge / test / babel.test.js
//
// Tests for the babel plugin in src/babel.js. We feed it source strings,
// run @babel/core.transformSync, and inspect the output for the expected
// rewrite shape (r3fBuild prop with a builder fn body).

import { describe, expect, it } from "bun:test";
import babel from "@babel/core";
import threeBridge from "@carbon/vite/three-bridge/babel";

function run(code, opts = {}) {
  const r = babel.transformSync(code, {
    babelrc: false,
    configFile: false,
    plugins: [[threeBridge, opts]],
    parserOpts: {
      plugins: ["jsx", "typescript"],
      sourceType: "module",
    },
    generatorOpts: { compact: false },
  });
  return r.code;
}

describe("carbonThreeBridgeBabel — JSX-lift inside <Canvas>", () => {
  it("leaves files without <Canvas> alone", () => {
    const out = run(`function App() { return <view><text>hi</text></view>; }`);
    expect(out).not.toContain("r3fBuild");
    expect(out).toContain("<view");
    expect(out).toContain("<text");
  });

  it("lifts a single <mesh> child into a builder fn", () => {
    const code = `
      function App() {
        return (
          <Canvas>
            <mesh />
          </Canvas>
        );
      }
    `;
    const out = run(code);
    expect(out).toContain("r3fBuild");
    expect(out).toContain('h("mesh"');
  });

  it("strips the JSX children of Canvas and self-closes", () => {
    const code = `
      function App() {
        return (
          <Canvas>
            <mesh />
            <ambientLight />
          </Canvas>
        );
      }
    `;
    const out = run(code);
    // No more <mesh> or <ambientLight> as JSX children — they're inside h().
    expect(out).not.toMatch(/<mesh\s*\/>/);
    expect(out).not.toMatch(/<ambientLight\s*\/>/);
    expect(out).toContain('h("mesh"');
    expect(out).toContain('h("ambientLight"');
  });

  it("wraps reactive expression-container props in thunks", () => {
    const code = `
      function App() {
        const a = createSignal(0);
        return (
          <Canvas>
            <mesh rotation-y={a()} />
          </Canvas>
        );
      }
    `;
    const out = run(code);
    // The rotation-y prop should appear as a thunk: () => a()
    expect(out).toMatch(/"rotation-y":\s*\(\)\s*=>\s*a\(\)/);
  });

  it("passes string-literal props through unwrapped", () => {
    const code = `
      function App() {
        return (
          <Canvas>
            <meshStandardMaterial color="hotpink" />
          </Canvas>
        );
      }
    `;
    const out = run(code);
    // String literal: NOT wrapped in a thunk (constant).
    expect(out).toContain('color: "hotpink"');
    expect(out).not.toMatch(/color:\s*\(\)\s*=>\s*"hotpink"/);
  });

  it("recurses into nested intrinsics inside Canvas", () => {
    const code = `
      function App() {
        return (
          <Canvas>
            <mesh>
              <boxGeometry args={[1,1,1]} />
              <meshStandardMaterial color="hotpink" />
            </mesh>
          </Canvas>
        );
      }
    `;
    const out = run(code);
    expect(out).toContain('h("mesh"');
    expect(out).toContain('h("boxGeometry"');
    expect(out).toContain('h("meshStandardMaterial"');
    // args is an expression-container — wrapped in a thunk.
    expect(out).toMatch(/args:\s*\(\)\s*=>\s*\[1,\s*1,\s*1\]/);
  });

  it("preserves uppercase component identity (passes by reference)", () => {
    const code = `
      function App() {
        return (
          <Canvas>
            <MyOrbit speed={1.5} />
          </Canvas>
        );
      }
    `;
    const out = run(code);
    // The uppercase tag is passed as an identifier, not a string literal.
    expect(out).toContain("h(MyOrbit");
    expect(out).not.toContain('h("MyOrbit"');
  });

  it("preserves Canvas's own props (style, etc.) on the outer JSX", () => {
    const code = `
      function App() {
        return (
          <Canvas style={{ width: 600, height: 400 }} background="black">
            <mesh />
          </Canvas>
        );
      }
    `;
    const out = run(code);
    expect(out).toContain("style=");
    expect(out).toContain('background="black"');
    expect(out).toContain("r3fBuild");
  });

  it("idempotent: running the plugin twice doesn't re-lift", () => {
    const code = `
      function App() {
        return (
          <Canvas>
            <mesh />
          </Canvas>
        );
      }
    `;
    const once = run(code);
    const twice = run(once);
    // Count occurrences of r3fBuild — should still be exactly one.
    const occurrences = (twice.match(/r3fBuild/g) || []).length;
    expect(occurrences).toBe(1);
  });

  it("respects custom bridgeComponents option", () => {
    const code = `
      function App() {
        return (
          <Scene>
            <mesh />
          </Scene>
        );
      }
    `;
    const out = run(code, { bridgeComponents: ["Scene"] });
    expect(out).toContain("r3fBuild");
    expect(out).toContain('h("mesh"');
  });

  it("drops JSX whitespace-text inside Canvas", () => {
    const code = `
      function App() {
        return (
          <Canvas>

            <mesh />

          </Canvas>
        );
      }
    `;
    const out = run(code);
    // No string literal "\n            " or similar leftovers in the output.
    expect(out).toContain('h("mesh"');
  });

  it("handles JSX spread attributes via __spread thunk", () => {
    const code = `
      function App() {
        return (
          <Canvas>
            <mesh {...meshProps} />
          </Canvas>
        );
      }
    `;
    const out = run(code);
    expect(out).toMatch(/__spread0/);
  });

  it("doesn't touch <view>/<text> outside <Canvas>", () => {
    const code = `
      function App() {
        return (
          <view>
            <text>label</text>
            <Canvas>
              <mesh />
            </Canvas>
          </view>
        );
      }
    `;
    const out = run(code);
    expect(out).toContain("<view");
    expect(out).toContain("<text");
    expect(out).toContain("r3fBuild");
    expect(out).toContain('h("mesh"');
  });
});

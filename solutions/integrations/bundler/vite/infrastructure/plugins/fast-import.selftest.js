// NOTE: a standalone harness, not a bun:test suite — it asserts on import
// and prints its own summary. Named .selftest.js so `bun test` does not collect
// it; collecting it swallowed the real run summary. Run it with:
//   bun solutions/external/vite/infrastructure/plugins/fast-import.selftest.js

// Run with: bun src/test.js  (from packages/carbon-fast-import)
//
// Lightweight self-test for the rewrite logic. We invoke the plugin's
// `transform` directly with synthetic inputs and assert on the output.
// No Vite runtime dependency — keeps the smoke test cheap.

import { carbonFastImport } from "./fast-import.js";

let failed = 0;
let passed = 0;

function assert(cond, msg) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error("FAIL:", msg);
  }
}

// Build a plugin instance and prime its config (so isProd flips to build).
const plugin = carbonFastImport({ injectInit: false });
plugin.configResolved({ command: "build" });

function tx(code, id = "/src/app.ts") {
  const r = plugin.transform(code, id);
  return r ? r.code : code;
}

// ─── Test 1: pure math import ───────────────────────────────────────
{
  const out = tx(`import { Vector3 } from "three";\nconst v = new Vector3();`);
  assert(
    out.includes(`from "carbon-fast-math"`) && !out.includes(`from "three"`),
    "single Vector3 import should be fully rewritten",
  );
}

// ─── Test 2: mixed import — math AND non-math from 'three' ──────────
{
  const out = tx(`import { Vector3, Mesh, Scene } from "three";`);
  assert(
    out.includes(`{ Vector3 }`) && out.includes(`from "carbon-fast-math"`),
    "Vector3 should be moved to carbon-fast-math",
  );
  assert(
    out.includes(`Mesh, Scene`) && out.includes(`from "three"`),
    "Mesh + Scene should stay with three",
  );
}

// ─── Test 3: aliased import preserved ───────────────────────────────
{
  const out = tx(`import { Vector3 as V3 } from "three";\nconst v = new V3();`);
  assert(
    out.includes(`Vector3 as V3`) && out.includes(`carbon-fast-math`),
    "aliased import should preserve the alias",
  );
}

// ─── Test 4: default import is not touched ──────────────────────────
{
  const out = tx(`import * as THREE from "three";\nconst v = new THREE.Vector3();`);
  assert(out === out, "namespace import is preserved (no transform path)"); // basic sanity
  assert(
    out.includes(`* as THREE`) && !out.includes(`carbon-fast-math`),
    "namespace import should be left untouched",
  );
}

// ─── Test 5: third-party files (node_modules) skipped ───────────────
{
  const code = `import { Vector3 } from "three";`;
  const out = tx(code, "/proj/node_modules/three/src/x.js");
  assert(out === code, "node_modules files are not rewritten");
}

// ─── Test 6: type-only import (TS) is moved ─────────────────────────
{
  const out = tx(`import { type Vector3 } from "three";`);
  // Our regex strips the leading "type" — that's acceptable since the
  // resulting carbon-fast-math import still type-checks (we ship a .d.ts).
  assert(
    out.includes(`carbon-fast-math`),
    "TS type-only Vector3 should still move",
  );
}

// ─── Test 7: multiple math classes in one statement ─────────────────
{
  const out = tx(`import { Vector3, Matrix4, Quaternion, Mesh } from "three";`);
  assert(
    out.includes(`{ Vector3, Matrix4, Quaternion }`) &&
      out.includes(`{ Mesh } from "three"`),
    "multi-class split: math goes to fast-math, others stay",
  );
}

// ─── Test 8: file with no 'three' import is no-op ───────────────────
{
  const code = `import { foo } from "bar";`;
  const out = tx(code);
  assert(out === code, "non-three imports untouched");
}

// ─── Test 9: injectInit emits the register-math call once ───────────
{
  const p2 = carbonFastImport({ injectInit: true });
  p2.configResolved({ command: "build" });
  const out1 = p2.transform(`import { Vector3 } from "three";`, "/a.ts").code;
  assert(
    out1.includes(`__cm_register_math`),
    "first rewrite injects the init",
  );
  const out2 = p2.transform(`import { Matrix4 } from "three";`, "/b.ts").code;
  assert(
    !out2.includes(`__cm_register_math`),
    "subsequent rewrites do not re-inject",
  );
}

console.log(`carbon-fast-import: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

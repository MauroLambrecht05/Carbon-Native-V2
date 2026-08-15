// @carbon/three / test / snapshot.regen.ts
//
// Regenerate the committed JSON fixture. Run after intentionally changing
// the command-stream schema or the canonical scene:
//
//   bun run shared/tests/ecosystem/system/stdlib/three/snapshot.regen.ts

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { CarbonRenderer, MockCommandExecutor } from "@carbon/three";
import { buildSnapshotScene, normalizeFrame } from "./fixtures/snapshot-scene.ts";

const exec = new MockCommandExecutor();
const renderer = new CarbonRenderer({
  executor: exec,
  enableFrustumCulling: true,
  canvas: { width: 800, height: 600 },
  clearColor: [0.1, 0.2, 0.3, 1.0],
});
const { scene, camera } = buildSnapshotScene();
renderer.render(scene, camera);

const out = normalizeFrame(exec.lastFrame());
const path = join(import.meta.dir, "fixtures", "snapshot-scene.json");
writeFileSync(path, JSON.stringify(out, null, 2) + "\n", "utf-8");
console.log(`wrote ${path}`);

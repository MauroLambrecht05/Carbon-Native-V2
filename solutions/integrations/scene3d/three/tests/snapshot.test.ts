// @carbon/three / test / snapshot.test.ts
//
// "Golden" command-stream test. Builds a known scene (mixed materials,
// transforms, lights, cameras), renders it, then asserts a JSON-serialized
// shape of the command stream matches the committed fixture.
//
// To regenerate after an intentional schema change:
//   bun run shared/tests/ecosystem/system/stdlib/three/snapshot.regen.ts
//
// We strip TypedArrays into plain arrays + a length tag so the JSON is
// human-readable in code review. Floats are rounded to 4 decimals so cross-
// platform float drift doesn't break the test.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as THREE from "three";
import { CarbonRenderer, MockCommandExecutor } from "@carbon/three";
import { buildSnapshotScene, normalizeFrame } from "./fixtures/snapshot-scene.js";

describe("command stream snapshot", () => {
  it("matches the committed fixture for the canonical scene", () => {
    const exec = new MockCommandExecutor();
    const renderer = new CarbonRenderer({
      executor: exec,
      enableFrustumCulling: true,
      canvas: { width: 800, height: 600 },
      clearColor: [0.1, 0.2, 0.3, 1.0],
    });
    const { scene, camera } = buildSnapshotScene();
    renderer.render(scene, camera);

    const actual = normalizeFrame(exec.lastFrame());
    const fixturePath = join(import.meta.dir, "fixtures", "snapshot-scene.json");
    const expected = JSON.parse(readFileSync(fixturePath, "utf-8"));

    expect(actual).toEqual(expected);
  });
});

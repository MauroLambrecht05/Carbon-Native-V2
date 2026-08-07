// Ported from the #[cfg(test)] module in V1 tools/updater/src/rollout.rs.
//
// The two statistical tests are the ones that matter and are worth keeping
// verbatim: V1's comments record that an earlier version asserted two specific
// installation IDs landed on opposite sides of a 50% rollout, which for a
// uniform hash is a coin flip — it asserted a property the function does not
// have. These assert the properties it does have.

import { describe, expect, test } from "bun:test";
import { inRollout } from "./RolloutService.ts";

describe("inRollout", () => {
  test("100 percent admits everyone", () => {
    expect(inRollout("install-123", "1.0.0", 100)).toBe(true);
    expect(inRollout("install-456", "1.0.1", 100)).toBe(true);
  });

  test("0 percent admits no one", () => {
    expect(inRollout("install-123", "1.0.0", 0)).toBe(false);
    expect(inRollout("install-456", "1.0.1", 0)).toBe(false);
  });

  test("is stable for a given installation and version", () => {
    expect(inRollout("install-123", "1.0.0", 50)).toBe(inRollout("install-123", "1.0.0", 50));
  });

  test("distributes across installations", () => {
    for (const pct of [10, 25, 50, 75, 90]) {
      let admitted = 0;
      for (let i = 0; i < 2000; i++) {
        if (inRollout(`install-${i}`, "1.0.0", pct)) admitted++;
      }
      const actual = (admitted / 2000) * 100;
      const delta = Math.abs(actual - pct);
      expect(delta).toBeLessThan(5);
    }
  });

  test("reshuffles per version", () => {
    let differs = 0;
    for (let i = 0; i < 500; i++) {
      const id = `install-${i}`;
      if (inRollout(id, "1.0.0", 50) !== inRollout(id, "2.0.0", 50)) differs++;
    }
    expect(differs).toBeGreaterThan(100);
  });
});

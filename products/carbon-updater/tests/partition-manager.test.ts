import { describe, expect, test } from "bun:test";
import { PartitionManager } from "../infrastructure/services/PartitionManager.ts";

describe("PartitionManager (A/B Slots & Crash Rollback)", () => {
  test("initializes default state and tracks launches", () => {
    const pm = new PartitionManager({ active_slot: "1.0.0", previous_slot: "0.9.0" });
    const s1 = pm.reportAppLaunch();
    expect(s1.rollbackTriggered).toBe(false);
    expect(pm.getState().in_progress_count).toBe(1);

    pm.reportAppSuccess();
    expect(pm.getState().in_progress_count).toBe(0);
  });

  test("triggers automatic rollback on 3 consecutive launch crashes", () => {
    const pm = new PartitionManager({
      active_slot: "2.0.0",
      previous_slot: "1.0.0",
      in_progress_count: 0,
    });

    // Crash 1
    const l1 = pm.reportAppLaunch();
    expect(l1.rollbackTriggered).toBe(false);
    expect(pm.getState().in_progress_count).toBe(1);

    // Crash 2
    const l2 = pm.reportAppLaunch();
    expect(l2.rollbackTriggered).toBe(false);
    expect(pm.getState().in_progress_count).toBe(2);

    // Crash 3
    const l3 = pm.reportAppLaunch();
    expect(l3.rollbackTriggered).toBe(false);
    expect(pm.getState().in_progress_count).toBe(3);

    // Launch 4 (attempting after 3 crashes) -> AUTOMATIC ROLLBACK!
    const l4 = pm.reportAppLaunch();
    expect(l4.rollbackTriggered).toBe(true);
    expect(l4.activeVersion).toBe("1.0.0");
    expect(pm.getState().active_slot).toBe("1.0.0");
    expect(pm.getState().previous_slot).toBe("2.0.0");
    expect(pm.getState().in_progress_count).toBe(0);
  });

  test("promotes new version to active slot", () => {
    const pm = new PartitionManager({ active_slot: "1.0.0" });
    pm.promoteSlot("1.1.0");

    expect(pm.getState().active_slot).toBe("1.1.0");
    expect(pm.getState().previous_slot).toBe("1.0.0");
    expect(pm.getState().in_progress_count).toBe(0);
  });

  test("renders and parses TOML partition state", () => {
    const pm = new PartitionManager({
      active_slot: "1.2.0",
      previous_slot: "1.1.0",
      in_progress_count: 2,
      installation_id: "inst-abc-123",
    });

    const toml = pm.renderToml();
    expect(toml).toContain('active_slot = "1.2.0"');

    const parsed = pm.parseToml(toml);
    expect(parsed.active_slot).toBe("1.2.0");
    expect(parsed.previous_slot).toBe("1.1.0");
    expect(parsed.in_progress_count).toBe(2);
    expect(parsed.installation_id).toBe("inst-abc-123");
  });
});

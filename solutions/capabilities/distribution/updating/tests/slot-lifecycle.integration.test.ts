// The A/B slot lifecycle against a real filesystem.
//
// The entity tests next to SlotState cover the state machine in memory. This
// covers the part that actually ships: staging a version, promoting it,
// failing to launch three times, and rolling back — with the file-backed
// repository, so the TOML round trip is exercised too.
//
// It exists because that path broke silently once. When SlotState was made
// pure, `load`/`save` moved to the repository and both use cases were left
// calling methods that no longer existed. Nothing caught it — the unit tests
// did not reach the repository, and no CLI command touches updates.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyUpdate, FileSlotStateRepository, handleCrashDetection } from "../index.ts";

let root: string;
const repository = new FileSlotStateRepository();

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "carbon-updates-"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** An install dir with a staged version ready to promote. */
function installWithStaged(name: string, version: string) {
  const install = join(root, name, "install");
  const staging = join(root, name, "staging");
  mkdirSync(join(staging, version), { recursive: true });
  writeFileSync(join(staging, version, "app.bin"), `binary for ${version}`);
  return { install, staging };
}

describe("applying an update", () => {
  test("promotes the staged version and remembers what it replaced", () => {
    const { install, staging } = installWithStaged("apply", "2.0.0");

    applyUpdate(install, staging, "2.0.0");

    const state = repository.load(install);
    expect(state.active_slot).toBe("2.0.0");
    expect(state.previous_slot).toBe("1.0.0");
    expect(existsSync(join(install, "slots", "2.0.0", "app.bin"))).toBe(true);
  });

  test("the staged directory is moved, not copied", () => {
    const { install, staging } = installWithStaged("moved", "3.0.0");

    applyUpdate(install, staging, "3.0.0");

    expect(existsSync(join(staging, "3.0.0"))).toBe(false);
  });

  test("refuses a version that was never staged", () => {
    const install = join(root, "unstaged", "install");
    const staging = join(root, "unstaged", "staging");
    mkdirSync(staging, { recursive: true });

    expect(() => applyUpdate(install, staging, "9.9.9")).toThrow(/does not exist/i);
  });
});

describe("crash-loop recovery", () => {
  test("three failed launches roll back, and the rollback persists", () => {
    const { install, staging } = installWithStaged("crash", "2.0.0");
    applyUpdate(install, staging, "2.0.0");

    const state = repository.load(install);
    state.markLaunchStarted();
    state.markLaunchStarted();
    state.markLaunchStarted();

    expect(handleCrashDetection(state, 3, install, repository)).toBe(true);

    // Reloaded from disk — the rollback has to survive the process that died.
    const recovered = repository.load(install);
    expect(recovered.active_slot).toBe("1.0.0");
    expect(recovered.previous_slot).toBe("2.0.0");
    expect(recovered.in_progress_count).toBe(0);
  });

  test("two failures are not enough to roll back a threshold of three", () => {
    const { install, staging } = installWithStaged("undercount", "2.0.0");
    applyUpdate(install, staging, "2.0.0");

    const state = repository.load(install);
    state.markLaunchStarted();
    state.markLaunchStarted();

    expect(handleCrashDetection(state, 3, install, repository)).toBe(false);
    expect(repository.load(install).active_slot).toBe("2.0.0");
  });

  test("reaching first frame clears the counter, so a later crash starts fresh", () => {
    const { install, staging } = installWithStaged("firstframe", "2.0.0");
    applyUpdate(install, staging, "2.0.0");

    const state = repository.load(install);
    state.markLaunchStarted();
    state.markFirstFrame();
    repository.save(install, state);

    const reloaded = repository.load(install);
    expect(reloaded.in_progress_count).toBe(0);
    expect(reloaded.last_successful_version).toBe("2.0.0");
  });
});

describe("state persistence", () => {
  test("a fresh install mints an installation id that survives a reload", () => {
    const install = join(root, "fresh", "install");

    const first = repository.load(install);
    repository.save(install, first);

    expect(repository.load(install).installation_id).toBe(first.installation_id);
  });

  test("no previous slot round-trips as absent, not as an empty string", () => {
    const install = join(root, "noprev", "install");
    const state = repository.load(install);
    repository.save(install, state);

    // TOML has no null. An empty string would make a rollback to "" look
    // available, which is how you brick an install that never updated.
    expect(repository.load(install).previous_slot).toBeNull();
  });
});

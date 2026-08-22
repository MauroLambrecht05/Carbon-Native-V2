// The manifest a release announces.
//
// Crosses contracts/update (the shape the updater reads) and contracts/security
// (the keyring window) — which is the point: this manifest is the one artifact
// two contracts meet in, and the version it replaced satisfied neither.

import { describe, expect, test } from "bun:test";
import { KEYRING_DEFAULT_VALIDITY_WINDOW_DAYS } from "@carbon/contracts/security";
import { parseManifest } from "@carbon/contracts/update";
import { BuildUpdateManifestUseCase } from "../index.ts";

const useCase = new BuildUpdateManifestUseCase();
const AT = new Date("2026-03-14T09:15:00Z");

function build(overrides: Partial<Parameters<typeof useCase.execute>[0]> = {}) {
  return useCase.execute({
    version: "1.2.0",
    channel: "stable",
    rollout: 100,
    pubkey: "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3",
    now: AT,
    ...overrides,
  });
}

describe("the manifest satisfies the contract", () => {
  test("every required field is present", () => {
    const manifest = build();

    // min_version was the one the hand-written literal omitted, so a
    // dry-run printed a manifest the updater's type would reject.
    expect(manifest.min_version).toBeNull();
    expect(manifest.version).toBe("1.2.0");
    expect(manifest.channel).toBe("stable");
    expect(manifest.notes).toBe("");
    expect(manifest.platforms).toEqual({});
  });

  test("it round-trips through the contract's own parser", () => {
    const parsed = parseManifest(JSON.stringify(build()));
    expect(parsed.version).toBe("1.2.0");
    expect(parsed.keyring.primary).toContain("RWQf6");
  });

  test("the keyring window comes from the contract, not a local copy", () => {
    expect(build().keyring.validity_window_days).toBe(KEYRING_DEFAULT_VALIDITY_WINDOW_DAYS);
  });

  test("pub_date is a date, not a timestamp", () => {
    // Two builds from the same inputs have to produce the same manifest.
    expect(build().pub_date).toBe("2026-03-14");
    expect(build().pub_date).toBe(build().pub_date);
  });
});

describe("rollout is clamped", () => {
  test("a percentage above 100 is capped", () => {
    expect(build({ rollout: 300 }).rollout).toBe(100);
  });

  test("a negative percentage becomes zero, not a shipped release", () => {
    expect(build({ rollout: -20 }).rollout).toBe(0);
  });

  test("a staged rollout passes through", () => {
    expect(build({ rollout: 25 }).rollout).toBe(25);
  });
});

describe("what the caller supplies", () => {
  test("platforms are carried through when given", () => {
    const entry = { signature: "sig", url: "https://x/y.exe", sha256: "abc" };
    const manifest = build({ platforms: { "x86_64-pc-windows-msvc": entry } });
    expect(manifest.platforms["x86_64-pc-windows-msvc"]).toEqual(entry);
  });

  test("a min_version is carried through", () => {
    expect(build({ minVersion: "1.0.0" }).min_version).toBe("1.0.0");
  });

  test("no pubkey yields an empty primary rather than a fabricated one", () => {
    // An app with no [updater] pubkey publishes a manifest nothing trusts,
    // which is the correct outcome — better than inventing a key.
    expect(build({ pubkey: "" }).keyring.primary).toBe("");
  });
});

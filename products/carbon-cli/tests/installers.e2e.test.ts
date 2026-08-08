#!/usr/bin/env bun
// Quick test of installer generation logic
// Usage: bun test-installers.ts

// @carbon/cli is a bin package with no library exports, so these stay
// relative reach-backs to the source rather than package-name imports.
import { generateNSIS } from "@carbon/packaging";
import { generateDEB } from "@carbon/packaging";
import { generateAppImage } from "@carbon/packaging";
import { generateDMG } from "@carbon/packaging";
import { generateWiX } from "@carbon/packaging";
import type { CarbonConfig } from "@carbon/contracts/app";

async function test() {
  const testConfig: CarbonConfig = {
    app: {
      name: "testapp",
      display_name: "Test Application",
      version: "1.0.0",
      dev_url: undefined,
    },
    runtime: {
      backend: "mini",
      bytecode: false,
      // Required by the contract. This fixture predates them; V1 never
      // typechecked this file, so nothing said so.
      image: false,
      audio: false,
    },
    raw: {},
  };

  console.log("Testing NSIS generation...");
  const nsis = await generateNSIS(testConfig, "carbon-mini.exe", "dist/installers");
  console.log("✓ NSIS generated:", nsis.split("\n").length, "lines");

  console.log("\nTesting WiX generation...");
  const wix = await generateWiX(testConfig, "carbon-mini.exe", "dist/installers");
  console.log("✓ WiX generated:", wix.split("\n").length, "lines");

  console.log("\nTesting DMG generation...");
  const dmg = await generateDMG(testConfig, "TestApp.app", "dist/installers");
  console.log("✓ DMG config generated:", JSON.parse(dmg).title);

  console.log("\nTesting AppImage generation...");
  const appimage = await generateAppImage(testConfig, "carbon-mini", "dist/installers");
  console.log("✓ AppImage config generated");

  console.log("\nTesting DEB generation...");
  const deb = await generateDEB(testConfig, "carbon-mini", "dist/installers");
  const debConfig = JSON.parse(deb);
  console.log("✓ DEB package name:", debConfig.packageName);

  console.log("\n✅ All installer generators working!");
}

test().catch((e) => {
  console.error("❌ Test failed:", e.message);
  process.exit(1);
});

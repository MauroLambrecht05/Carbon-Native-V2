#!/usr/bin/env bun
// A macOS build worker's entrypoint — see worker.ts for the shared wiring.
//
// NO DOCKERFILE, unlike worker-linux.ts/worker-windows.ts. Docker cannot
// run macOS at all — not "unverified here" the way the Windows Dockerfile
// is, genuinely impossible. Run this directly on real Mac hardware:
//
//   bun install --cwd .config
//   CONTROL_PLANE_URL=... WORKER_API_TOKEN=... \
//   OBJECT_STORE_ENDPOINT=... OBJECT_STORE_ACCESS_KEY_ID=... OBJECT_STORE_SECRET_ACCESS_KEY=... \
//   OBJECT_STORE_BUCKET=carbon-cloud \
//   bun products/carbon-cloud/composition/worker-macos.ts
//
// Needs on that machine: Rust (ensureRuntime compiles from source on first
// use), Xcode command-line tools (codesign, xcrun notarytool/stapler — part
// of Xcode, no separate install), appdmg (`npm i -g appdmg`), git.

import { runWorker } from "./worker.ts";

await runWorker({
  platform: "darwin",
  defaultWorkDir: "/tmp/carbon-cloud-worker",
  signingKey:
    process.env.SIGNING_KEY_PATH && process.env.SIGNING_KEY_PASSWORD
      ? { keyFile: process.env.SIGNING_KEY_PATH, password: process.env.SIGNING_KEY_PASSWORD }
      : undefined,
  macos:
    process.env.CARBON_DEVELOPER_ID && process.env.CARBON_APPLE_ID && process.env.CARBON_APP_PASSWORD && process.env.CARBON_TEAM_ID
      ? {
          developerId: process.env.CARBON_DEVELOPER_ID,
          appleId: process.env.CARBON_APPLE_ID,
          appPassword: process.env.CARBON_APP_PASSWORD,
          teamId: process.env.CARBON_TEAM_ID,
        }
      : undefined,
});

#!/usr/bin/env bun
// A Linux build worker's entrypoint. See worker.ts for the actual wiring —
// this only supplies what's Linux-specific: the platform to claim for, the
// default work directory, and (Linux has none of its own) which extra
// signing step applies.

import { runWorker } from "./worker.ts";

await runWorker({
  platform: "linux",
  defaultWorkDir: "/tmp/carbon-cloud-worker",
  signingKey:
    process.env.SIGNING_KEY_PATH && process.env.SIGNING_KEY_PASSWORD
      ? { keyFile: process.env.SIGNING_KEY_PATH, password: process.env.SIGNING_KEY_PASSWORD }
      : undefined,
});

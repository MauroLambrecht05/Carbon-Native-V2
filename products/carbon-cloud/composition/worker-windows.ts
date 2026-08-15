#!/usr/bin/env bun
// A Windows build worker's entrypoint — see worker.ts for the shared wiring.
// Windows-specific: the platform, the default work directory, and the
// Authenticode credentials nsis/wix artifacts get signed with (on top of
// the same minisign signature every platform gets).

import { runWorker } from "./worker.ts";

await runWorker({
  platform: "win32",
  defaultWorkDir: "C:\\carbon-cloud-worker",
  signingKey:
    process.env.SIGNING_KEY_PATH && process.env.SIGNING_KEY_PASSWORD
      ? { keyFile: process.env.SIGNING_KEY_PATH, password: process.env.SIGNING_KEY_PASSWORD }
      : undefined,
  authenticode:
    process.env.CARBON_CERT_PATH && process.env.CARBON_CERT_PASSWORD
      ? {
          certPath: process.env.CARBON_CERT_PATH,
          certPassword: process.env.CARBON_CERT_PASSWORD,
          timestampServer: process.env.CARBON_TIMESTAMP_SERVER,
        }
      : undefined,
});

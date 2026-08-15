#!/usr/bin/env bun
// carbon-cloud — the composition root. Builds the server and starts
// listening; nothing else. See composition/entrypoint.ts for the wiring.

import { configFromEnv, startServer } from "./composition/entrypoint.ts";

const server = await startServer(configFromEnv());
console.log(`carbon-cloud listening on :${server.port}`);

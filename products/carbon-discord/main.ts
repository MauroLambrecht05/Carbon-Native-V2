#!/usr/bin/env bun
// carbon-discord: the composition root. Builds the client and logs in;
// nothing else. See composition/entrypoint.ts for the wiring.

import { configFromEnv, startBot } from "./composition/entrypoint.ts";

startBot(configFromEnv());

#!/usr/bin/env bun
// Entrypoint for carbon-database product. Standalone executable script.

import { configFromEnv, startDatabase } from "./composition/entrypoint.ts";

startDatabase(configFromEnv());

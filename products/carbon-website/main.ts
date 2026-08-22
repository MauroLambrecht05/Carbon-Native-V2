#!/usr/bin/env bun
// carbon-website — the composition root. Unlike carbon-cloud's main.ts,
// there's no server process to start: this product is a static site, and
// its real entrypoint is index.html loading composition/main.tsx directly
// in the browser. What "build the graph, hand off, exit" means here is the
// production build — so that's what running this does.

import { build } from "vite";

await build({ root: import.meta.dirname });
console.log("carbon-website built to dist/");

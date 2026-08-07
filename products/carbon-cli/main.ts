#!/usr/bin/env bun
// carbon — the composition root.
//
// This file wires the pieces together and does nothing else: no routing, no
// help text, no argument parsing. Those live in kernel/, and what commands
// exist lives in commands/registry.ts. V1 kept all three inline here as a
// 100-line switch plus a hand-maintained help template.
//
// What is left in this product is the CLI surface and nothing else: the
// command classes and this root. Everything that was not carbon-cli-specific
// moved out to solutions/, where another product can reach it —
//
//   @carbon/cli-kernel   the command framework (was src/kernel/)
//   @carbon/bundler      the build engine     (was src/infrastructure/bundler/)
//   @carbon/packaging    installer generators (was src/infrastructure/packaging/)
//   @carbon/storage      release artifact IO  (was src/infrastructure/storage/)
//   @carbon/project       manifest, backends, paths — the domain model
//
// and the two standalone scripts that had no exports at all became tools under
// .tools/automation/.

import { Dispatcher, consoleIo } from "@carbon/cli";
import { buildRegistry } from "./composition/registry.ts";

const VERSION = "0.2.0";

async function main(argv: readonly string[]): Promise<number> {
  const dispatcher = new Dispatcher({
    registry: buildRegistry(),
    io: consoleIo,
    binary: "carbon",
    version: VERSION,
  });

  return dispatcher.run(argv);
}

// Wrapped rather than top-level await so this entry compiles to a CJS-friendly
// form — `bun build --compile --bytecode` rejects top-level await.
main(process.argv.slice(2))
  .then((exitCode) => process.exit(exitCode))
  .catch((error) => {
    consoleIo.error(error?.message ?? String(error));
    process.exit(1);
  });

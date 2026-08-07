// @carbon/process — running subprocesses, behind a port.
//
// Building a carbon app means shelling out to cargo and bun. Depending on this
// port rather than node:child_process is what makes that testable without a
// toolchain installed.

export type { ProcessRunner, ProcessResult, ProcessOptions } from "./ports/ProcessRunner.ts";
export { run, start, nodeProcessRunner, type SpawnResult } from "./adapters/NodeProcessRunner.ts";

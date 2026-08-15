// The state a build moves through, and the only transitions allowed.
//
// queued -> claimed -> running -> succeeded | failed
//
// A worker can also fail a claimed/running build outright (a checkout that
// never starts running still needs to report why). Nothing moves backward,
// and nothing skips claimed — a build a worker never picked up cannot be
// "running".

export type BuildStatus = "queued" | "claimed" | "running" | "succeeded" | "failed";

const ALLOWED: Record<BuildStatus, readonly BuildStatus[]> = {
  queued: ["claimed"],
  claimed: ["running", "failed"],
  running: ["succeeded", "failed"],
  succeeded: [],
  failed: [],
};

export function canTransition(from: BuildStatus, to: BuildStatus): boolean {
  return ALLOWED[from].includes(to);
}

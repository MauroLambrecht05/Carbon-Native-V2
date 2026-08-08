// Process control — relaunch / exit. Sibling of @carbon/api/app's
// process-metadata-only role; this one *acts* on the current process.

import "./hosts";

/** Restart the current process. Spawns a fresh instance with the same
 *  argv, then schedules the current process to exit after a short delay
 *  so the new instance has time to claim the foreground window. */
export async function relaunch(): Promise<void> {
  __cm_proc_relaunch_self();
}

/** Hard-exit. Skips Node-style cleanup hooks (we don't have those).
 *  Defaults to code 0. */
export async function exit(code = 0): Promise<void> {
  const v = JSON.stringify({ code });
  __cm_invoke("app:exit", v);
}

/** Current process id. */
export function pid(): number {
  return __cm_proc_pid_self();
}

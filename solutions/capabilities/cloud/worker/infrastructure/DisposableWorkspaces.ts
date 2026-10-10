// Workspaces under one root that belongs to one worker process. Each attempt
// gets a directory that did not exist before and does not exist afterwards.

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { BuildWorkspace, WorkspaceProvider } from "../application/ports/LeasedBuild.ts";

export class WorkspaceNotErasedError extends Error {
  constructor(readonly directory: string) { super(`The workspace ${directory} could not be erased`); }
}

// git marks its object files read-only and Windows holds files briefly after a process exits, so removal retries.
async function remove(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  if (existsSync(directory)) throw new WorkspaceNotErasedError(directory);
}

export class DisposableWorkspaces implements WorkspaceProvider {
  private readonly root: string;
  constructor(root: string) { this.root = resolve(root); }

  async reset(): Promise<void> {
    mkdirSync(this.root, { recursive: true });
    for (const entry of readdirSync(this.root)) await remove(join(this.root, entry));
    if (readdirSync(this.root).length) throw new WorkspaceNotErasedError(this.root);
  }

  async create(buildId: string, attempt: number): Promise<BuildWorkspace> {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(buildId) || !Number.isInteger(attempt) || attempt < 1) throw new Error("Invalid workspace name");
    const directory = join(this.root, `${buildId}-${attempt}`);
    // Not recursive: an existing directory is an error, never a workspace to reuse.
    mkdirSync(directory);
    for (const part of ["out", "scratch"]) mkdirSync(join(directory, part));
    return { directory, erase: () => remove(directory) };
  }
}

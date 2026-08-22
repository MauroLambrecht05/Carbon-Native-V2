// Public HTTPS clone, via the ProcessRunner port (not node:child_process
// directly, so it stays fake-able the same way every other subprocess call
// in this codebase does). No credential handling — a private repo fails
// clearly through git's own "Authentication failed" rather than silently.

import type { ProcessRunner } from "@carbon/process";
import type { RepoFetcher } from "../application/ports/RepoFetcher.ts";

export class GitCloneError extends Error {
  constructor(readonly repoUrl: string, readonly code: number) {
    super(`git clone of ${repoUrl} exited with code ${code}`);
  }
}

export class GitCheckoutError extends Error {
  constructor(readonly commitSha: string, readonly code: number) {
    super(`git checkout ${commitSha} exited with code ${code}`);
  }
}

export class GitRepoFetcher implements RepoFetcher {
  constructor(private readonly runner: ProcessRunner) {}

  async fetch(repoUrl: string, commitSha: string, destDir: string): Promise<void> {
    const clone = await this.runner.run("git", ["clone", "--no-checkout", repoUrl, destDir]);
    if (clone.code !== 0) throw new GitCloneError(repoUrl, clone.code);

    const checkout = await this.runner.run("git", ["checkout", commitSha], { cwd: destDir });
    if (checkout.code !== 0) throw new GitCheckoutError(commitSha, checkout.code);
  }
}

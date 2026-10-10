// Checks out one exact commit with git, through the ProcessRunner port.
//
// The checkout never rewrites line endings (the lockfile digest is over the
// committed bytes), never asks for credentials, and uses no credential
// helper from the machine: a private repository fails clearly instead of
// borrowing whatever identity the worker's user happens to have.

import { mkdirSync } from "node:fs";
import type { ProcessRunner } from "@carbon/process";
import { BuildFailure, type SourceCheckout, type ToolVersion } from "../application/ports/LeasedBuild.ts";

const SETTINGS = ["-c", "core.autocrlf=false", "-c", "credential.helper=", "-c", "advice.detachedHead=false"];

export class GitSourceCheckout implements SourceCheckout {
  constructor(private readonly runner: ProcessRunner) {}

  private async git(args: string[], cwd?: string): Promise<{ readonly code: number; readonly stdout: string }> {
    const result = await this.runner.run("git", [...SETTINGS, ...args], { cwd, stdio: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    return { code: result.code, stdout: (result.stdout ?? "").trim() };
  }

  async checkout(repositoryUrl: string, commitSha: string, directory: string): Promise<{ readonly resolvedCommit: string; readonly tool: ToolVersion }> {
    // Both values end up on a command line; neither may be read as an option.
    if (!/^[a-f0-9]{40}$/.test(commitSha) || repositoryUrl.startsWith("-") || /\s/.test(repositoryUrl)) throw new BuildFailure("source.invalid", "Invalid repository or commit");
    mkdirSync(directory);
    const version = /(\d+\.\d+[A-Za-z0-9._+-]*)/.exec((await this.git(["--version"])).stdout)?.[1];
    if (!version) throw new BuildFailure("source.unavailable", "git is not available");
    for (const step of [["init", "--quiet"], ["remote", "add", "origin", repositoryUrl]]) if ((await this.git(step, directory)).code !== 0) throw new BuildFailure("source.unavailable", "The checkout could not be prepared");
    // Ask for the one commit; hosts that refuse a commit by name get an ordinary fetch instead.
    if ((await this.git(["fetch", "--quiet", "--no-tags", "--depth", "1", "origin", commitSha], directory)).code !== 0
      && (await this.git(["fetch", "--quiet", "--no-tags", "origin"], directory)).code !== 0) throw new BuildFailure("source.unavailable", "The repository could not be fetched");
    if ((await this.git(["checkout", "--quiet", "--detach", commitSha], directory)).code !== 0) throw new BuildFailure("source.commit_missing", "The repository does not contain the requested commit");
    const head = await this.git(["rev-parse", "HEAD"], directory);
    if (head.code !== 0 || !/^[a-f0-9]{40}$/.test(head.stdout)) throw new BuildFailure("source.unavailable", "The checked-out commit could not be read");
    return { resolvedCommit: head.stdout, tool: { name: "git", version } };
  }
}

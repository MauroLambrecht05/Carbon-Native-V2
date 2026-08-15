// Getting a repo + commit onto local disk. Public HTTPS clone only for
// v1 — private-repo auth (deploy keys, tokens) is a real gap, tracked as
// follow-up rather than solved here with something half-built.

export interface RepoFetcher {
  fetch(repoUrl: string, commitSha: string, destDir: string): Promise<void>;
}

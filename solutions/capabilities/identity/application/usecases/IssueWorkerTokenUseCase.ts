// Mints a worker-scoped token for an already-verified org. Self-hosted v1's
// model: the org running the deployment also runs its own workers, so a
// worker token is issued FROM an org token rather than through a separate
// platform-operator concept that doesn't exist yet. Whoever holds it can
// claim/complete builds for ANY org sharing this control plane, not just
// the one that issued it — that's what makes it a worker token and not
// just another org token; see ApiToken.ts's TokenScope note.

import { ApiToken } from "../../domain/entities/ApiToken.ts";
import type { IdentityRepository } from "../ports/IdentityRepository.ts";

export interface IssueWorkerTokenResult {
  /** Shown once. Not recoverable — only its hash is stored. */
  readonly workerToken: string;
}

export class IssueWorkerTokenUseCase {
  constructor(private readonly identity: IdentityRepository) {}

  async execute(orgId: string): Promise<IssueWorkerTokenResult> {
    const plaintext = `wk_${crypto.randomUUID().replaceAll("-", "")}`;
    const token = ApiToken.issue({ id: crypto.randomUUID(), orgId, scope: "worker", plaintext });
    await this.identity.saveToken(token);
    return { workerToken: plaintext };
  }
}

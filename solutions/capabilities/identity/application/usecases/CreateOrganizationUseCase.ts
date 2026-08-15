// Self-hosted v1's whole signup flow: name an org, get back its first API
// token. No email/password — the token itself is the credential, generated
// here and returned exactly once, matching how GitHub/npm/etc. issue a
// personal access token you're told to copy now because you won't see it
// again (only the hash is kept, per TokenHash.ts).

import { Organization } from "../../domain/entities/Organization.ts";
import { ApiToken } from "../../domain/entities/ApiToken.ts";
import type { IdentityRepository } from "../ports/IdentityRepository.ts";

export interface CreateOrganizationResult {
  readonly orgId: string;
  /** Shown once. Not recoverable — only its hash is stored. */
  readonly apiToken: string;
}

export class CreateOrganizationUseCase {
  constructor(private readonly identity: IdentityRepository) {}

  async execute(name: string): Promise<CreateOrganizationResult> {
    const org = Organization.create({ id: crypto.randomUUID(), name });
    await this.identity.saveOrganization(org);

    const plaintext = `cc_${crypto.randomUUID().replaceAll("-", "")}`;
    const token = ApiToken.issue({ id: crypto.randomUUID(), orgId: org.id, plaintext });
    await this.identity.saveToken(token);

    return { orgId: org.id, apiToken: plaintext };
  }
}

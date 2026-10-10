export interface ProviderRepository {
  readonly id: string;
  readonly fullName: string;
  readonly defaultBranch: string;
  readonly private: boolean;
  readonly archived: boolean;
}

export interface RepositoryInstallationSnapshot {
  readonly installationId: string;
  readonly accountId: string;
  readonly account: string;
  readonly accountKind: 'organization' | 'user';
  readonly repositories: readonly ProviderRepository[];
}

export interface RepositoryCommit {
  readonly repositoryId: string;
  readonly requestedRef: string;
  readonly sha: string;
}
export interface RepositoryProposal { readonly path: string; readonly content: string; readonly title: string; readonly message: string; readonly branch: string; }
export interface ProviderProposalReceipt { readonly pullRequestNumber: number; readonly url: string; readonly branch: string; readonly baseSha: string; readonly headSha: string; }

export interface RepositoryProvider {
  readonly provider: 'github';
  refresh(installationId: string): Promise<RepositoryInstallationSnapshot>;
  resolveCommit(installationId: string, repositoryId: string, ref: string): Promise<RepositoryCommit>;
  createProposal(installationId: string, repositoryId: string, baseBranch: string, proposal: RepositoryProposal): Promise<ProviderProposalReceipt>;
  verifyWebhook(rawBody: Uint8Array, signature: string, deliveryId: string, event: string): void;
}

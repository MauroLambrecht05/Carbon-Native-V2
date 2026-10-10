import type { ProjectRepositoryConfiguration, ProjectRepositoryReceipt, RepositoryInstallation, RepositoryInstallationReceipt, RepositoryProposalReceipt, RepositoryWebhookReceipt, ResolvedRepositoryCommit, Scope } from '@carbon/contracts/platform';
import type { OrganizationActor } from '@carbon/identity';
import type { RepositoryCommit, RepositoryInstallationSnapshot } from './RepositoryProvider.ts';

export interface RepositoryCommandContext { readonly keyDigest: string; readonly requestDigest: string; readonly requestId: string; readonly expectedRevision: string; }
export interface RepositorySelection { readonly installationId: string; readonly repositoryId: string; readonly branch: string; readonly rootDirectory: string; readonly pushTrigger: boolean; readonly pullRequestTrigger: boolean; }
export interface RepositoryProviderBinding { readonly installationId: string; readonly providerInstallationId: string; readonly repositoryId: string; readonly providerRepositoryId: string; readonly repositoryRevision: string; }
export interface RepositoryProposalPreparation { readonly receipt?: RepositoryProposalReceipt; readonly binding?: RepositoryProviderBinding; readonly baseBranch?: string; }
export interface RepositoryIntegrationRepository {
  authorizeOrganization(actor: OrganizationActor, orgId: string, expectedRevision?: string): Promise<void>;
  installations(actor: OrganizationActor, orgId: string, limit: number, afterId?: string): Promise<readonly RepositoryInstallation[]>;
  connect(actor: OrganizationActor, orgId: string, snapshot: RepositoryInstallationSnapshot, context: RepositoryCommandContext): Promise<RepositoryInstallationReceipt>;
  configuration(actor: OrganizationActor, scope: Scope): Promise<ProjectRepositoryConfiguration>;
  providerInstallation(actor: OrganizationActor, orgId: string, installationId: string): Promise<string>;
  binding(actor: OrganizationActor, scope: Scope, mutation?: boolean): Promise<RepositoryProviderBinding>;
  configure(actor: OrganizationActor, scope: Scope, selection: RepositorySelection | undefined, snapshot: RepositoryInstallationSnapshot | undefined, context: RepositoryCommandContext): Promise<ProjectRepositoryReceipt>;
  recordResolution(actor: OrganizationActor, scope: Scope, binding: RepositoryProviderBinding, commit: RepositoryCommit, requestId: string): Promise<ResolvedRepositoryCommit>;
  prepareProposal(actor: OrganizationActor, scope: Scope, context: RepositoryCommandContext): Promise<RepositoryProposalPreparation>;
  recordProposal(actor: OrganizationActor, scope: Scope, binding: RepositoryProviderBinding, providerReceipt: import('./RepositoryProvider.ts').ProviderProposalReceipt, context: RepositoryCommandContext): Promise<RepositoryProposalReceipt>;
  webhook(deliveryId: string, event: string, payloadDigest: string, snapshot: RepositoryInstallationSnapshot, requestId: string): Promise<RepositoryWebhookReceipt>;
  revokeInstallation(deliveryId: string, event: string, payloadDigest: string, providerInstallationId: string, action: 'suspended' | 'deleted', requestId: string): Promise<RepositoryWebhookReceipt>;
}

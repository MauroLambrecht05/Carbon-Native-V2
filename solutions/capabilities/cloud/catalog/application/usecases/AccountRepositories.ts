import { PlatformFault, parseComponent, type CommandOptions, type PageRequest, type ProjectRepositoryCommand, type RepositoryFileProposal, type RepositoryInstallationPage, type RepositoryInstallationReceipt, type RepositoryProposalReceipt, type RepositoryWebhookReceipt, type ResolvedRepositoryCommit, type Scope } from '@carbon/contracts/platform';
import { tokenDigest, tokenMatches, type AccountAuthentication, type MessageProtector, type OrganizationActor } from '@carbon/identity';
import type { RepositoryIntegrationRepository } from '../ports/RepositoryIntegrationRepository.ts';
import type { RepositoryProvider } from '../ports/RepositoryProvider.ts';

export class AccountRepositories {
  constructor(private readonly auth: AccountAuthentication, private readonly repository: RepositoryIntegrationRepository, private readonly provider: RepositoryProvider, private readonly cursors: MessageProtector) {}
  private async actor(token: string, csrf?: string): Promise<OrganizationActor> {
    const session = await this.auth.session(token); if (!session) throw new PlatformFault('unauthenticated', 'Sign in to manage repositories');
    if (csrf !== undefined && !tokenMatches(csrf, session.csrfHash)) throw new PlatformFault('forbidden', 'Invalid CSRF token');
    return { accountId: session.account.id, sessionId: session.id, securityRevision: session.account.securityRevision, permissionRevision: session.account.permissionRevision, tokenHash: tokenDigest(token), csrfHash: session.csrfHash };
  }
  private context(options: CommandOptions, value: unknown, scope: unknown, requestId: string) {
    parseComponent('CommandOptions', options); parseComponent('Id', requestId);
    if (!options.expectedRevision) throw new PlatformFault('validation', 'A current revision is required');
    return { expectedRevision: options.expectedRevision, keyDigest: tokenDigest(options.idempotencyKey), requestDigest: tokenDigest(JSON.stringify({ scope, value, expectedRevision: options.expectedRevision })), requestId };
  }
  async installations(token: string, orgId: string, query: PageRequest): Promise<RepositoryInstallationPage> {
    parseComponent('Id', orgId); parseComponent('PageRequest', query); if (query.filter || (query.sort && query.sort !== 'id')) throw new PlatformFault('validation', 'Only ID ordering is supported');
    const actor = await this.actor(token); const limit = query.limit ?? 25; const context = `repository-installations:${actor.sessionId}:${actor.permissionRevision}:${orgId}:${limit}`; let afterId: string | undefined;
    if (query.cursor) try { afterId = parseComponent('Id', JSON.parse(await this.cursors.open(query.cursor, context)).afterId); } catch { throw new PlatformFault('validation', 'The page cursor is invalid or expired'); }
    const rows = await this.repository.installations(actor, orgId, limit + 1, afterId); const items = rows.slice(0, limit);
    return parseComponent('RepositoryInstallationPage', { items, nextCursor: rows[limit] && items.length ? await this.cursors.seal(JSON.stringify({ afterId: items.at(-1)!.id }), context) : null });
  }
  async connect(token: string, csrf: string, orgId: string, installationId: string, options: CommandOptions, requestId: string): Promise<RepositoryInstallationReceipt> {
    const input = parseComponent('RepositoryInstallationConnect', { installationId }); const actor = await this.actor(token, csrf); const context = this.context(options, input, { orgId }, requestId);
    await this.repository.authorizeOrganization(actor, orgId); const snapshot = await this.provider.refresh(input.installationId);
    return this.repository.connect(actor, orgId, snapshot, context);
  }
  async configuration(token: string, scope: Scope) { parseComponent('Scope', scope); return this.repository.configuration(await this.actor(token), scope); }
  async command(token: string, csrf: string, scope: Scope, value: ProjectRepositoryCommand, options: CommandOptions, requestId: string) {
    const command = parseComponent('ProjectRepositoryCommand', value); const actor = await this.actor(token, csrf); const context = this.context(options, command, scope, requestId);
    if (command.kind === 'save' && command.rootDirectory !== '.' && (!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(command.rootDirectory) || command.rootDirectory.split('/').includes('..'))) throw new PlatformFault('validation', 'Root directory must be a relative repository path');
    let snapshot; if (command.kind === 'save') { const providerInstallationId = await this.repository.providerInstallation(actor, scope.orgId, command.installationId); snapshot = await this.provider.refresh(providerInstallationId); }
    return this.repository.configure(actor, scope, command.kind === 'save' ? command : undefined, snapshot, context);
  }
  async resolve(token: string, csrf: string, scope: Scope, ref: string, requestId: string): Promise<ResolvedRepositoryCommit> {
    const input = parseComponent('RepositoryCommitResolve', { ref }); const actor = await this.actor(token, csrf); const binding = await this.repository.binding(actor, scope, true);
    const commit = await this.provider.resolveCommit(binding.providerInstallationId, binding.providerRepositoryId, input.ref);
    return this.repository.recordResolution(actor, scope, binding, commit, requestId);
  }
  async propose(token:string,csrf:string,scope:Scope,value:RepositoryFileProposal,options:CommandOptions,requestId:string):Promise<RepositoryProposalReceipt>{
    const proposal=parseComponent('RepositoryFileProposal',value);if(Buffer.byteLength(proposal.content,'utf8')>262144)throw new PlatformFault('validation','Proposed file exceeds 256 KiB');const actor=await this.actor(token,csrf);
    const safe={...proposal,content:undefined,contentDigest:tokenDigest(proposal.content)};const context=this.context(options,safe,scope,requestId);const prepared=await this.repository.prepareProposal(actor,scope,context);if(prepared.receipt)return prepared.receipt;
    const binding=prepared.binding!;const branch=`carbon/proposal-${tokenDigest(`${actor.accountId}:${context.keyDigest}`).slice(0,32)}`;const providerReceipt=await this.provider.createProposal(binding.providerInstallationId,binding.providerRepositoryId,prepared.baseBranch!,{...proposal,branch});
    return this.repository.recordProposal(actor,scope,binding,providerReceipt,context);
  }
  async webhook(raw: Uint8Array, signature: string, delivery: string, event: string, requestId: string): Promise<RepositoryWebhookReceipt> {
    this.provider.verifyWebhook(raw, signature, delivery, event); let value: any;
    try { value = JSON.parse(Buffer.from(raw).toString('utf8')); } catch { throw new PlatformFault('validation', 'Invalid GitHub webhook JSON'); }
    const installationId = String(value?.installation?.id ?? ''); if (!/^[1-9][0-9]{0,19}$/.test(installationId)) throw new PlatformFault('validation', 'GitHub webhook has no installation');
    const digest=tokenDigest(Buffer.from(raw).toString('base64'));if(event==='installation'&&['suspend','deleted'].includes(value?.action))return this.repository.revokeInstallation(delivery,event,digest,installationId,value.action==='suspend'?'suspended':'deleted',requestId);
    const snapshot = await this.provider.refresh(installationId); return this.repository.webhook(delivery, event, digest, snapshot, requestId);
  }
}

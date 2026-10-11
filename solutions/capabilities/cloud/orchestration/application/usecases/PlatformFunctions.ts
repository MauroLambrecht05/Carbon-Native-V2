import { createHash, randomUUID } from 'node:crypto';
import type { WorkerLeaseInput } from '@carbon/catalog';
import {
  PlatformFault, parseComponent, type CommandOptions, type EnvironmentScope, type FunctionCommand, type FunctionDeploy, type FunctionDetails, type FunctionExecution, type FunctionExecutionCommand, type FunctionExecutionPage,
  type FunctionExecutionReceipt, type FunctionInvoke, type FunctionPage, type FunctionReceipt, type FunctionRevisionDetails, type FunctionScheduleCommand, type FunctionScheduleCreate, type FunctionScheduleList,
  type FunctionScheduleReceipt, type PageRequest, type WorkerFunctionComplete, type WorkerFunctionInput,
} from '@carbon/contracts/platform';
import { tokenDigest, tokenMatches, type AccountAuthentication, type MessageProtector, type OrganizationActor } from '@carbon/identity';
import type { CommandIdentity, PlatformFunctionRepository } from '../ports/PlatformFunctionRepository.ts';

const MAX_INPUT_BYTES = 65536;

/** Developers deploy functions, run them, follow their executions and schedule them through the browser session. */
export class AccountFunctions {
  constructor(private readonly auth: AccountAuthentication, private readonly repository: PlatformFunctionRepository, private readonly cursors: MessageProtector) {}

  private async actor(token: string, csrf?: string): Promise<OrganizationActor> {
    const session = await this.auth.session(token);
    if (!session) throw new PlatformFault('unauthenticated', 'Sign in to manage functions');
    if (csrf !== undefined && !tokenMatches(csrf, session.csrfHash)) throw new PlatformFault('forbidden', 'Invalid CSRF token');
    return { accountId: session.account.id, sessionId: session.id, securityRevision: session.account.securityRevision,
      permissionRevision: session.account.permissionRevision, tokenHash: tokenDigest(token), csrfHash: session.csrfHash };
  }
  private identity(options: CommandOptions, requestId: string, request: unknown): CommandIdentity {
    parseComponent('CommandOptions', options); parseComponent('Id', requestId);
    return { keyDigest: tokenDigest(options.idempotencyKey), requestDigest: tokenDigest(JSON.stringify(request)), requestId };
  }
  private revision(options: CommandOptions): string { if (!options.expectedRevision) throw new PlatformFault('validation', 'A current revision is required'); return options.expectedRevision; }
  private async page<T extends { id: string }>(context: string, query: PageRequest, read: (limit: number, afterId?: string) => Promise<readonly T[]>) {
    parseComponent('PageRequest', query);
    if (query.filter || (query.sort && query.sort !== 'id')) throw new PlatformFault('validation', 'Only ID ordering is supported');
    const limit = query.limit ?? 25; const bound = `${context}:${limit}`; let afterId: string | undefined;
    if (query.cursor) try { afterId = parseComponent('Id', JSON.parse(await this.cursors.open(query.cursor, bound)).afterId); } catch { throw new PlatformFault('validation', 'The page cursor is invalid or expired'); }
    const rows = await read(limit + 1, afterId); const items = rows.slice(0, limit);
    return { items, nextCursor: rows[limit] && items.length ? await this.cursors.seal(JSON.stringify({ afterId: items.at(-1)!.id }), bound) : null };
  }

  /**
   * Deploys code as a new immutable revision and makes it the active one. The first deploy of a name creates the
   * function. The code is stored as given and identified by its SHA-256; it is not run, imported or evaluated here.
   */
  async deploy(token: string, csrf: string, input: EnvironmentScope, value: FunctionDeploy, options: CommandOptions, requestId: string): Promise<FunctionReceipt> {
    const scope = parseComponent('EnvironmentScope', input); const deploy = parseComponent('FunctionDeploy', value);
    const codeDigest = createHash('sha256').update(deploy.code, 'utf8').digest('hex');
    return this.repository.deploy(await this.actor(token, csrf), scope, randomUUID(), { ...deploy, secretNames: [...deploy.secretNames].sort() }, codeDigest, this.identity(options, requestId, { scope, deploy: { ...deploy, code: codeDigest } }));
  }
  async list(token: string, input: EnvironmentScope, query: PageRequest): Promise<FunctionPage> {
    const scope = parseComponent('EnvironmentScope', input); const actor = await this.actor(token);
    return parseComponent('FunctionPage', await this.page(`functions:${actor.sessionId}:${actor.permissionRevision}:${scope.environmentId}`, query, (limit, afterId) => this.repository.list(actor, scope, limit, afterId)));
  }
  async get(token: string, input: EnvironmentScope, functionId: string): Promise<FunctionDetails> {
    return this.repository.get(await this.actor(token), parseComponent('EnvironmentScope', input), parseComponent('Id', functionId));
  }
  async revisionCode(token: string, input: EnvironmentScope, functionId: string, number: number): Promise<FunctionRevisionDetails> {
    if (!Number.isInteger(number) || number < 1 || number > 1000000) throw new PlatformFault('validation', 'Invalid revision number');
    return this.repository.revision(await this.actor(token), parseComponent('EnvironmentScope', input), parseComponent('Id', functionId), number);
  }
  async command(token: string, csrf: string, input: EnvironmentScope, functionId: string, value: FunctionCommand, options: CommandOptions, requestId: string): Promise<FunctionReceipt> {
    const scope = parseComponent('EnvironmentScope', input); parseComponent('Id', functionId); const command = parseComponent('FunctionCommand', value);
    return this.repository.command(await this.actor(token, csrf), scope, functionId, command, this.revision(options), this.identity(options, requestId, { scope, functionId, command, expectedRevision: options.expectedRevision }));
  }

  /** Queues one execution of the function's active revision. It is pinned to that revision from this moment. */
  async invoke(token: string, csrf: string, input: EnvironmentScope, functionId: string, value: FunctionInvoke, options: CommandOptions, requestId: string): Promise<FunctionExecutionReceipt> {
    const scope = parseComponent('EnvironmentScope', input); parseComponent('Id', functionId); const invoke = parseComponent('FunctionInvoke', value);
    if (Buffer.byteLength(JSON.stringify(invoke.input ?? null)) > MAX_INPUT_BYTES) throw new PlatformFault('validation', 'The function input exceeds the size limit');
    return this.repository.invoke(await this.actor(token, csrf), scope, functionId, { executionId: randomUUID(), leaseId: randomUUID() }, invoke.input ?? null, this.identity(options, requestId, { scope, functionId, input: invoke.input ?? null }));
  }
  async executions(token: string, input: EnvironmentScope, functionId: string, query: PageRequest): Promise<FunctionExecutionPage> {
    const scope = parseComponent('EnvironmentScope', input); parseComponent('Id', functionId); const actor = await this.actor(token);
    return parseComponent('FunctionExecutionPage', await this.page(`executions:${actor.sessionId}:${actor.permissionRevision}:${functionId}`, query, (limit, afterId) => this.repository.executions(actor, scope, functionId, limit, afterId)));
  }
  async execution(token: string, input: EnvironmentScope, executionId: string): Promise<FunctionExecution> {
    return this.repository.execution(await this.actor(token), parseComponent('EnvironmentScope', input), parseComponent('Id', executionId));
  }
  async executionCommand(token: string, csrf: string, input: EnvironmentScope, executionId: string, value: FunctionExecutionCommand, options: CommandOptions, requestId: string): Promise<FunctionExecutionReceipt> {
    const scope = parseComponent('EnvironmentScope', input); parseComponent('Id', executionId); const command = parseComponent('FunctionExecutionCommand', value);
    return this.repository.executionCommand(await this.actor(token, csrf), scope, executionId, command.kind, { executionId: randomUUID(), leaseId: randomUUID() }, this.revision(options),
      this.identity(options, requestId, { scope, executionId, command, expectedRevision: options.expectedRevision }));
  }

  async createSchedule(token: string, csrf: string, input: EnvironmentScope, functionId: string, value: FunctionScheduleCreate, options: CommandOptions, requestId: string): Promise<FunctionScheduleReceipt> {
    const scope = parseComponent('EnvironmentScope', input); parseComponent('Id', functionId); const schedule = parseComponent('FunctionScheduleCreate', value);
    return this.repository.createSchedule(await this.actor(token, csrf), scope, functionId, randomUUID(), schedule.intervalSeconds, this.identity(options, requestId, { scope, functionId, schedule }));
  }
  async schedules(token: string, input: EnvironmentScope, functionId: string): Promise<FunctionScheduleList> {
    return parseComponent('FunctionScheduleList', { items: await this.repository.schedules(await this.actor(token), parseComponent('EnvironmentScope', input), parseComponent('Id', functionId)) });
  }
  async scheduleCommand(token: string, csrf: string, input: EnvironmentScope, scheduleId: string, value: FunctionScheduleCommand, options: CommandOptions, requestId: string): Promise<FunctionScheduleReceipt> {
    const scope = parseComponent('EnvironmentScope', input); parseComponent('Id', scheduleId); const command = parseComponent('FunctionScheduleCommand', value);
    return this.repository.scheduleCommand(await this.actor(token, csrf), scope, scheduleId, command.kind, this.revision(options), this.identity(options, requestId, { scope, scheduleId, command, expectedRevision: options.expectedRevision }));
  }
}

/** What the worker holding an execution's lease can do: read exactly what to run, and report how it went. */
export class WorkerFunctions {
  constructor(private readonly repository: PlatformFunctionRepository) {}

  private lease(authorization: string, leaseId: string, leaseToken: string, requestId: string): WorkerLeaseInput {
    parseComponent('Id', leaseId); parseComponent('Id', requestId);
    const match = /^Bearer (wc_[A-Za-z0-9_-]{43})$/.exec(authorization);
    if (!match) throw new PlatformFault('unauthenticated', 'A worker credential is required');
    if (!/^wl_[A-Za-z0-9_-]{43}$/.test(leaseToken)) throw new PlatformFault('unauthenticated', 'A lease token is required');
    return { tokenHash: tokenDigest(match[1]!), leaseId, leaseTokenHash: tokenDigest(leaseToken), requestId };
  }
  async input(authorization: string, leaseId: string, leaseToken: string, requestId: string): Promise<WorkerFunctionInput> { return this.repository.input(this.lease(authorization, leaseId, leaseToken, requestId)); }
  async complete(authorization: string, leaseId: string, leaseToken: string, value: WorkerFunctionComplete, requestId: string): Promise<FunctionExecution> {
    return this.repository.complete(this.lease(authorization, leaseId, leaseToken, requestId), parseComponent('WorkerFunctionComplete', value));
  }
}

/** Cloud's timers for functions: fire due schedules, and end executions that can no longer finish. Not reachable over HTTP. */
export class FunctionOrchestration {
  constructor(private readonly repository: PlatformFunctionRepository) {}
  async reconcile(requestId: string, limit = 50) { parseComponent('Id', requestId); return this.repository.reconcile(requestId, limit); }
  async tick(requestId: string, limit = 50) { parseComponent('Id', requestId); return this.repository.tick(requestId, limit); }
}

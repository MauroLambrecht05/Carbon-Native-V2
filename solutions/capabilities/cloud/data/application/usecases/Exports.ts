import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { PlatformFault, parseComponent, type CommandOptions, type DataExportCancel, type DataExportCreate, type DataExportDownload, type DataExportJob, type DataExportList, type DataExportReceipt,
  type EnvironmentScope } from '@carbon/contracts/platform';
import { tokenDigest, tokenMatches, type AccountAuthentication, type OrganizationActor } from '@carbon/identity';
import type { DataTransport } from '../ports/AccountDataAuthority.ts';
import type { ExportDownloadSource, ExportJobs, ExportLease, ExportStore } from '../ports/ExportJobs.ts';
import { encodeExportRows, exportColumns } from '../../domain/ExportEncoding.ts';

const PAGE_ROWS = 500;
/** Pages one claim reads before it gives the job back, so one large export cannot hold a worker indefinitely. */
const PAGES_PER_LEASE = 20;

/** Developers start, follow, cancel and download exports through the browser session. */
export class AccountExports {
  constructor(private readonly auth: AccountAuthentication, private readonly jobs: ExportJobs, private readonly origin: string) {}

  private async actor(token: string, csrf: string): Promise<OrganizationActor> {
    const session = await this.auth.session(token);
    if (!session) throw new PlatformFault('unauthenticated', 'Sign in to access exports');
    if (!tokenMatches(csrf, session.csrfHash)) throw new PlatformFault('forbidden', 'Invalid CSRF token');
    return { accountId: session.account.id, sessionId: session.id, securityRevision: session.account.securityRevision,
      permissionRevision: session.account.permissionRevision, tokenHash: tokenDigest(token), csrfHash: session.csrfHash };
  }

  async enqueue(token: string, csrf: string, scope: EnvironmentScope, input: DataExportCreate, options: CommandOptions, requestId: string): Promise<DataExportReceipt> {
    const command = parseComponent('DataExportCreate', input); parseComponent('CommandOptions', options);
    if (options.idempotencyKey.toLowerCase() !== command.commandId.toLowerCase()) throw new PlatformFault('validation', 'The command identity must match the idempotency key');
    return this.jobs.enqueue(await this.actor(token, csrf), parseComponent('EnvironmentScope', scope), command, parseComponent('Id', requestId));
  }
  async get(token: string, csrf: string, scope: EnvironmentScope, id: string): Promise<DataExportJob> {
    return this.jobs.get(await this.actor(token, csrf), parseComponent('EnvironmentScope', scope), parseComponent('Id', id));
  }
  async list(token: string, csrf: string, scope: EnvironmentScope): Promise<DataExportList> {
    return parseComponent('DataExportList', { items: await this.jobs.list(await this.actor(token, csrf), parseComponent('EnvironmentScope', scope)) });
  }
  async cancel(token: string, csrf: string, scope: EnvironmentScope, id: string, input: DataExportCancel, options: CommandOptions): Promise<DataExportReceipt> {
    const command = parseComponent('DataExportCancel', input); parseComponent('CommandOptions', options);
    if (options.idempotencyKey.toLowerCase() !== command.commandId.toLowerCase() || options.expectedRevision !== command.revision) throw new PlatformFault('validation', 'Command identity and revision must match the headers');
    return this.jobs.cancel(await this.actor(token, csrf), parseComponent('EnvironmentScope', scope), parseComponent('Id', id), command);
  }

  /**
   * Issues an address that downloads the export once. The token is returned here and never again; only its hash is
   * stored. The address carries no session: it is useless after one use or a minute, whichever comes first.
   */
  async download(token: string, csrf: string, scope: EnvironmentScope, id: string, requestId: string): Promise<DataExportDownload> {
    const actor = await this.actor(token, csrf); const secret = `ex_${randomBytes(32).toString('base64url')}`;
    const expiresAt = await this.jobs.issueDownload(actor, parseComponent('EnvironmentScope', scope), parseComponent('Id', id), tokenDigest(secret), parseComponent('Id', requestId));
    return parseComponent('DataExportDownload', { url: `${this.origin.replace(/\/+$/, '')}/platform/v1/exports/download/${secret}`, expiresAt });
  }
}

/** Serves a download address. It checks nothing about the caller except the token, which is spent by this call. */
export class ExportDownloads {
  constructor(private readonly jobs: ExportJobs, private readonly store: ExportStore) {}

  async open(token: string): Promise<{ readonly source: ExportDownloadSource; readonly body: ReadableStream<Uint8Array> } | null> {
    if (!/^ex_[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const source = await this.jobs.openDownload(tokenDigest(token));
    if (!source) return null;
    const store = this.store; let index = 0;
    // Parts are read one at a time as the client consumes them; the whole export is never held in memory.
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (index >= source.objectKeys.length) { controller.close(); return; }
        const bytes = await store.get(source.objectKeys[index++]!);
        if (!bytes) { controller.error(new Error('An export part is missing')); return; }
        controller.enqueue(bytes);
      },
    });
    return { source, body };
  }
}

/**
 * Cloud's export worker. Each call claims one job, reads up to a fixed number of pages from Database as the job's
 * creator, stores each page as a part and checkpoints it, then either finishes the job or hands it back.
 *
 * Every claim re-resolves the creator's authority in Cloud, and every request to Database carries a fresh assertion
 * that Database checks against Cloud again. A part is written to storage before its checkpoint, under a key fixed by
 * its number, so an interrupted run overwrites the same object on resume instead of duplicating rows.
 */
export class RunExportJobs {
  constructor(private readonly jobs: ExportJobs, private readonly transport: DataTransport, private readonly store: ExportStore) {}

  async execute(): Promise<boolean> {
    const lease = await this.jobs.claim();
    if (!lease) return false; if (lease === 'settled') return true;
    try { await this.run(lease); }
    catch (error) {
      // Database refusing the request is a verdict on the job. Not reaching it is not: the job waits and tries again.
      if (error instanceof PlatformFault && error.code !== 'unavailable') await this.jobs.fail(lease, error.code === 'forbidden' || error.code === 'unauthenticated' ? 'access_revoked' : error.code === 'not_found' ? 'table_missing' : 'rejected');
      else await this.jobs.release(lease, 15);
    }
    return true;
  }

  private async table(lease: ExportLease) {
    const response = await this.transport.execute({ scope: lease.scope, bindingId: lease.bindingId, command: { kind: 'table.get', tableId: lease.request.tableId } },
      { principal: lease.principal, role: lease.role, requestId: randomUUID() });
    return parseComponent('DataTable', response.result);
  }

  private async run(lease: ExportLease): Promise<void> {
    const table = await this.table(lease);
    // Every part of one export has the same columns. A schema change part-way ends the export rather than mixing shapes.
    if (lease.tableRevision !== null && table.revision !== lease.tableRevision) { await this.jobs.fail(lease, 'schema_changed'); return; }
    const selection = lease.request.selection ?? {}; const columns = exportColumns(table.definition, selection.columns);
    let afterId = lease.afterRowId; let parts = lease.parts;
    for (let page = 0; page < PAGES_PER_LEASE; page++) {
      const response = await this.transport.execute({ scope: lease.scope, bindingId: lease.bindingId, command: { kind: 'rows.query', tableId: lease.request.tableId, access: lease.request.access, limit: PAGE_ROWS,
        ...(selection.filters ? { filters: selection.filters } : {}), ...(selection.columns ? { columns: selection.columns } : {}), ...(selection.selectedIds ? { selectedIds: selection.selectedIds } : {}),
        ...(afterId ? { afterId } : {}) } }, { principal: lease.principal, role: lease.role, requestId: randomUUID() });
      const result = parseComponent('DataQueryResult', response.result);
      const bytes = encodeExportRows(lease.request.format, columns, result.rows, parts === 0);
      const next = result.nextAfterId ?? result.rows.at(-1)?.id ?? afterId;
      if (bytes.byteLength) {
        const number = parts + 1; const objectKey = `exports/${lease.scope.orgId}/${lease.scope.environmentId}/${lease.jobId}/${String(number).padStart(6, '0')}`;
        await this.store.put(objectKey, bytes).catch(() => { throw new PlatformFault('unavailable', 'Export storage could not be reached'); });
        if (await this.jobs.checkpoint(lease, { number, objectKey, rows: result.rows.length, bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex'), afterRowId: next, tableRevision: table.revision }) === 'stop') return;
        parts = number;
      }
      afterId = next;
      if (!result.nextAfterId) {
        if ((await this.table(lease)).revision !== table.revision) { await this.jobs.fail(lease, 'schema_changed'); return; }
        await this.jobs.finish(lease); return;
      }
    }
    await this.jobs.release(lease, 0);
  }

  /** Housekeeping: expires old exports and deletes stored parts no job needs any more. Safe to run at any time. */
  async sweep(limit = 100): Promise<number> {
    await this.jobs.expire(); let removed = 0;
    for (const part of await this.jobs.purgeable(limit)) {
      try { await this.store.delete(part.objectKey); } catch { continue; }
      await this.jobs.purged(part.jobId, part.number); removed++;
    }
    return removed;
  }
}

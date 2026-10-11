import type { OrganizationActor } from '@carbon/identity';
import type { DataExportCancel, DataExportCreate, DataExportJob, DataExportReceipt, EnvironmentScope, Principal, Role } from '@carbon/contracts/platform';

/** One worker's hold on a job, with the authority it was just re-granted and where the job had got to. */
export interface ExportLease {
  readonly jobId: string;
  readonly leaseId: string;
  readonly scope: EnvironmentScope;
  readonly bindingId: string;
  readonly principal: Principal;
  readonly role: Role;
  readonly requestId: string;
  readonly request: DataExportCreate;
  /** The last row already stored, or null when nothing has been. */
  readonly afterRowId: string | null;
  readonly parts: number;
  /** The table revision earlier parts were read at, or null on the first lease. */
  readonly tableRevision: string | null;
}

/** A part whose object is already in storage, with the checkpoint that makes it count. */
export interface ExportPart {
  readonly number: number;
  readonly objectKey: string;
  readonly rows: number;
  readonly bytes: number;
  readonly sha256: string;
  readonly afterRowId: string | null;
  readonly tableRevision: string;
}

export interface ExportDownloadSource {
  readonly jobId: string;
  readonly format: 'jsonl' | 'csv';
  readonly bytes: number;
  readonly objectKeys: readonly string[];
}

export interface ExportJobs {
  enqueue(actor: OrganizationActor, scope: EnvironmentScope, input: DataExportCreate, requestId: string): Promise<DataExportReceipt>;
  get(actor: OrganizationActor, scope: EnvironmentScope, id: string): Promise<DataExportJob>;
  list(actor: OrganizationActor, scope: EnvironmentScope): Promise<readonly DataExportJob[]>;
  cancel(actor: OrganizationActor, scope: EnvironmentScope, id: string, command: DataExportCancel): Promise<DataExportReceipt>;
  /** Records a download token for a ready export. Returns when it stops working. */
  issueDownload(actor: OrganizationActor, scope: EnvironmentScope, id: string, tokenHash: string, requestId: string): Promise<string>;
  /** Spends a download token. Null unless it is unused, unexpired, and its owner may still read this data. */
  openDownload(tokenHash: string): Promise<ExportDownloadSource | null>;

  // Cloud's own worker.
  claim(): Promise<ExportLease | 'settled' | null>;
  /** Makes a stored part count and extends the lease. `stop` means the lease is gone or the job is ending. */
  checkpoint(lease: ExportLease, part: ExportPart): Promise<'continue' | 'stop'>;
  finish(lease: ExportLease): Promise<boolean>;
  fail(lease: ExportLease, code: string): Promise<boolean>;
  /** Gives the job back to the queue, to be claimed again after a delay. */
  release(lease: ExportLease, retryAfterSeconds: number): Promise<boolean>;
  /** Marks ready exports past their expiry as expired. */
  expire(): Promise<number>;
  /** Stored parts of jobs that no longer need them. */
  purgeable(limit: number): Promise<readonly { readonly jobId: string; readonly number: number; readonly objectKey: string }[]>;
  purged(jobId: string, number: number): Promise<void>;
}

/** Private object storage for export parts. Nothing in it is ever addressable by a public URL. */
export interface ExportStore {
  put(objectKey: string, bytes: Uint8Array): Promise<void>;
  get(objectKey: string): Promise<Uint8Array | null>;
  delete(objectKey: string): Promise<void>;
}

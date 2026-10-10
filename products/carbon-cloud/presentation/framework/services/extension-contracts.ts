import type { CommandOptions, Page, PageRequest, RequestContext, Result, Scope, Unsubscribe } from "./contracts";
import type { CommandReceipt } from "./identity-contracts";
import type { DataRow, DataTable, LocalDownload, RowValues } from "./data-contracts";
import type { AppUser } from "./app-auth-contracts";

export type ScopedRecord = { id: string; scope: Scope; name: string; revision: string };
export type Bucket = ScopedRecord & { public: boolean; mimeTypes: string[]; maxBytes: number; versioning: boolean; retentionDays: number; userUploads: boolean; anonymousUploads: boolean; userPrefix: string };
export type ObjectVersion = { id: string; bytes: number[]; contentType: string; size: number; digest: string; createdAt: string };
export type StoredBlob = ScopedRecord & { bucketId: string; key: string; ownerId?: string; versions: ObjectVersion[] };
export type BlobMetadata = Omit<StoredBlob, "versions"> & { versions: Omit<ObjectVersion, "bytes">[] };
export type BlobAccess = { mode: "dashboard" | "anonymous" | "app" };
export type UploadInput = { key: string; bytes: number[]; contentType: string; conflict: "error" | "replace"; objectRevision?: string; access: BlobAccess; fail?: boolean };
export type BinaryDownload = { filename: string; contentType: string; bytes: number[]; digest: string };
export type VectorPoint = { id: string; vector: number[]; metadata: RowValues; revision: string };
export type VectorCollection = ScopedRecord & { dimensions: number; metric: "cosine" | "euclidean" | "dot"; points: VectorPoint[]; index: "none" | "building" | "ready" | "failed"; lastOperation?: string };
export type GraphNode = { id: string; label: string; properties: RowValues; revision: string };
export type GraphEdge = { id: string; source: string; target: string; relationship: string; weight: number; properties: RowValues; revision: string };
export type Graph = ScopedRecord & { nodes: GraphNode[]; edges: GraphEdge[] };
export type RealtimeConfig = ScopedRecord & { tableId: string; events: ("insert" | "update" | "delete")[]; capture: "accepted mock row commits (including supported SQL fixtures); no WAL" };
export type RowEvent = { id: string; cursor: string; tableId: string; rowId: string; revision: string; occurredAt: string; kind: "insert" | "update" | "delete"; old?: RowValues; row?: RowValues };
export type RealtimeMessage = { state: "connected" | "gap" | "closed"; cursor: string; events: RowEvent[]; reason?: string };
export type Migration = ScopedRecord & { order: number; checksum: string; forward: string; reverse: string; reviewed: boolean; base: string; status: "registered" | "applied" | "rolled-back" | "failed"; appliedSchema?: string; operationId?: string };
export type Coverage = "relational" | "policies" | "blobs" | "vectors" | "graph" | "app-users";
export const coverageOptions: Coverage[] = ["relational", "policies", "blobs", "vectors", "graph", "app-users"];
export type Backup = ScopedRecord & { coverage: Coverage[]; schema: string; createdAt: string; protected: boolean; expiresAt: string; consistency: string; omitted: string[]; counts: Record<string, number> };
export type Snapshot = { tables: DataTable[]; rows: DataRow[]; buckets: Bucket[]; blobs: StoredBlob[]; vectors: VectorCollection[]; graphs: Graph[]; users: AppUser[] };
export type BackupSchedule = ScopedRecord & { enabled: boolean; timezone: string; hour: number; retentionDays: number; coverage: Coverage[]; nextAt: string; lastOutcome?: string };
export type RestoreInput = { backupId: string; targetId?: string; newName?: string; coverage: Coverage[]; conflict: "replace"; confirmation: string; failResource?: Coverage };
export type ExtensionCommand =
  | { kind: "bucket.save"; id?: string; name: string; public: boolean; publicConfirmation: string; mimeTypes: string[]; maxBytes: number; versioning: boolean; retentionDays: number; userUploads: boolean; anonymousUploads: boolean; userPrefix: string }
  | { kind: "bucket.delete"; id: string; recursive: boolean; confirmation: string }
  | { kind: "blob.delete"; id: string; confirmation: string }
  | { kind: "blob.copy"; id: string; targetBucketId: string; key: string; move: boolean; failCopy: boolean }
  | { kind: "blob.restore"; id: string; versionId: string }
  | { kind: "vector.create"; name: string; dimensions: number; metric: VectorCollection["metric"] }
  | { kind: "vector.upsert"; id: string; points: { id: string; vector: number[]; metadata: RowValues }[] }
  | { kind: "vector.delete"; id: string; pointId?: string; confirmation: string }
  | { kind: "vector.index"; id: string; fail: boolean }
  | { kind: "graph.create"; name: string }
  | { kind: "graph.import"; id: string; nodes: Omit<GraphNode, "revision">[]; edges: Omit<GraphEdge, "revision">[]; preview: boolean }
  | { kind: "graph.delete"; id: string; nodeId?: string; edgeId?: string; cascade: boolean; confirmation: string }
  | { kind: "realtime.save"; tableId: string; events: RealtimeConfig["events"] }
  | { kind: "migration.register"; name: string; order: number; forward: string; reverse: string; reviewed: boolean; base: string }
  | { kind: "migration.apply"; id: string; rollback: boolean }
  | { kind: "migration.promote"; id: string; targetId: string; targetBase: string; confirmation: string }
  | { kind: "backup.create"; name: string; coverage: Coverage[]; protected: boolean; retentionDays: number }
  | { kind: "backup.delete"; id: string; confirmation: string }
  | { kind: "backup.protect"; id: string; protected: boolean }
  | { kind: "backup.schedule"; enabled: boolean; timezone: string; hour: number; retentionDays: number; coverage: Coverage[] }
  | { kind: "backup.restore"; input: RestoreInput };
export type ExtensionLists = { buckets: Bucket; vectors: Omit<VectorCollection, "points"> & { count: number }; graphs: Omit<Graph, "nodes" | "edges"> & { nodeCount: number; edgeCount: number }; realtime: RealtimeConfig; migrations: Migration; backups: Backup; schedules: BackupSchedule };
export type ExtensionJobResult = { message: string; resources: { resource: string; state: "restored" | "skipped" | "failed" | "succeeded"; message: string }[]; targetId?: string };
export interface ExtensionService {
  getResource<K extends "buckets" | "vectors" | "graphs">(context: RequestContext, kind: K, id: string): Promise<Result<ExtensionLists[K]>>;
  list<K extends keyof ExtensionLists>(context: RequestContext, kind: K, page?: PageRequest): Promise<Result<Page<ExtensionLists[K]>>>;
  command(context: RequestContext, command: ExtensionCommand, production: string, options: CommandOptions): Promise<Result<CommandReceipt>>;
  objects(context: RequestContext, bucketId: string, page?: PageRequest & { prefix?: string }): Promise<Result<Page<BlobMetadata>>>;
  upload(context: RequestContext, bucketId: string, input: UploadInput, production: string, options: CommandOptions): Promise<Result<CommandReceipt>>;
  download(context: RequestContext, id: string, access: BlobAccess, versionId?: string): Promise<Result<BinaryDownload>>;
  createLink(context: RequestContext, bucketId: string, key: string, mode: "download" | "upload", ttlSeconds: number, production: string, options: CommandOptions): Promise<Result<CommandReceipt>>;
  useLink(context: RequestContext, token: string, upload?: { bytes: number[]; contentType: string }): Promise<Result<BinaryDownload | CommandReceipt>>;
  vectorPoints(context: RequestContext, id: string, page?: PageRequest): Promise<Result<Page<VectorPoint>>>;
  vectorSearch(context: RequestContext, id: string, vector: number[], topK: number, filter: RowValues): Promise<Result<{ meaning: string; hits: { id: string; score: number; metadata: RowValues }[] }>>;
  graphRecords(context: RequestContext, id: string, kind: "nodes" | "edges", query?: PageRequest & { label?: string; properties?: RowValues; neighbor?: string }): Promise<Result<Page<GraphNode | GraphEdge>>>;
  graphPath(context: RequestContext, id: string, source: string, target: string): Promise<Result<{ found: boolean; nodes: string[]; edges: string[]; cost: number }>>;
  subscribe(context: RequestContext, tableId: string, cursor: string | undefined, listener: (message: RealtimeMessage) => void): Promise<Result<Unsubscribe>>;
  schemaStatus(context: RequestContext): Promise<Result<{ revision: string; expected?: string; drift: boolean; supported: string }>>;
  previewMigration(context: RequestContext, id: string, rollback: boolean): Promise<Result<{ compatible: boolean; current: string; expected: string; message: string }>>;
  previewRestore(context: RequestContext, input: RestoreInput): Promise<Result<ExtensionJobResult>>;
  backupExportAccess(context: RequestContext, id: string): Promise<Result<{ token: string; expiresAt: string }>>;
  backupDownload(context: RequestContext, id: string, token: string): Promise<Result<LocalDownload>>;
  jobResult(context: RequestContext, id: string): Promise<Result<ExtensionJobResult>>;
  cancel(context: RequestContext, id: string, options: CommandOptions): Promise<Result<CommandReceipt>>;
}

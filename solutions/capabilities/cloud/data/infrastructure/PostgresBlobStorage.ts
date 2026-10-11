import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { PlatformFault, blobPermission, canonicalBlobRequest, parseComponent, type BlobBucket, type BlobBucketDefinition, type BlobCommand, type BlobObject, type BlobReceipt, type BlobResponse,
  type Permission } from '@carbon/contracts/platform';
import { bodyDigest } from '@carbon/identity';
import type { BlobAuthority, BlobContent, BlobStorageRepository, BlobStore, BlobSweepResult } from '../application/ports/BlobStorage.ts';

type Row = Record<string, any>;
type Tx = Bun.TransactionSQL;
const UPLOAD_SECONDS = 300;
const DOWNLOAD_SECONDS = 60;
/** How long after an upload began it is treated as abandoned. */
const INTERRUPTED_SECONDS = 600;
const MAX_BUCKETS = 100;
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

function bucketView(row: Row): BlobBucket {
  return parseComponent('BlobBucket', { id: row.id, definition: row.definition, usedBytes: Number(row.used_bytes), objectCount: Number(row.object_count), revision: String(row.revision), createdAt: row.created_at.toISOString() });
}
function objectView(row: Row): BlobObject {
  return parseComponent('BlobObject', { key: row.key, versionId: row.id, sizeBytes: Number(row.size_bytes), sha256: row.sha256, contentType: row.content_type, state: row.state, createdAt: row.created_at.toISOString(),
    removedAt: row.removed_at?.toISOString() ?? null, purgeAfter: row.purge_after?.toISOString() ?? null });
}

export class PostgresBlobStorage implements BlobStorageRepository {
  /** `origin` is this service's public origin: transfer addresses are built from it. */
  constructor(private readonly sql: Bun.SQL, private readonly store: BlobStore, private readonly origin: string) {}

  private transact<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.sql.begin(async tx => { await tx`SET LOCAL lock_timeout = '5s'`; await tx`SET LOCAL statement_timeout = '15s'`; return work(tx); }) as Promise<T>;
  }
  private async environment(tx: Tx, authority: BlobAuthority, permission: Permission) {
    parseComponent('EnvironmentScope', authority.scope); parseComponent('Id', authority.bindingId); parseComponent('Principal', authority.principal); parseComponent('Id', authority.requestId);
    const principal = authority.principal;
    // Blob management is for accounts and service accounts. App users have no blob access yet.
    if (!((principal.kind === 'account' && principal.audience === 'dashboard') || (principal.kind === 'service_account' && principal.audience === 'automation')) || !await authority.permit(permission)) {
      throw new PlatformFault('forbidden', 'Blob access is not authorized');
    }
    const scope = authority.scope;
    const rows = await tx<Row[]>`SELECT id, state FROM public.platform_environments WHERE org_id = ${scope.orgId} AND project_id = ${scope.projectId} AND environment_id = ${scope.environmentId}
      AND binding_id = ${authority.bindingId} FOR SHARE`;
    if (!rows.length) throw new PlatformFault('not_found', 'Environment resource not found');
    if (permission !== 'data.read' && permission !== 'metadata.read' && rows[0]!.state !== 'active') throw new PlatformFault('conflict', 'Environment is paused');
    return rows[0]!;
  }
  /** A live bucket of the caller's own environment. Another environment's bucket is simply not found. */
  private async bucket(tx: Tx, authority: BlobAuthority, id: string, lock = false): Promise<Row> {
    const scope = authority.scope;
    const rows = await tx.unsafe(`SELECT * FROM public.blob_buckets WHERE id = $1 AND org_id = $2 AND project_id = $3 AND environment_id = $4 AND state = 'active'${lock ? ' FOR UPDATE' : ' FOR SHARE'}`,
      [id, scope.orgId, scope.projectId, scope.environmentId]);
    if (!rows.length) throw new PlatformFault('not_found', 'Bucket not found');
    return rows[0];
  }
  private audit(tx: Tx, bucketId: string, actor: unknown | null, action: string, requestId: string, detail: Record<string, unknown> = {}) {
    return tx`INSERT INTO public.blob_events (id, bucket_id, actor, action, request_id, detail) VALUES (${randomUUID()}, ${bucketId}, ${actor ? JSON.stringify(actor) : null}::text::jsonb, ${action}, ${requestId}, ${JSON.stringify(detail)}::text::jsonb)`;
  }
  private usage(tx: Tx, bucket: Row, kind: 'stored' | 'removed' | 'egress', bytes: number, sourceId: string) {
    return tx`INSERT INTO public.blob_usage (id, bucket_id, org_id, project_id, environment_id, kind, bytes, source_id)
      VALUES (${randomUUID()}, ${bucket.id}, ${bucket.org_id}, ${bucket.project_id}, ${bucket.environment_id}, ${kind}, ${bytes}, ${sourceId}) ON CONFLICT (kind, source_id) DO NOTHING`;
  }
  /** When a version that stops being current may be removed: after the bucket's retention if it keeps versions, otherwise now. */
  private purgeAt(definition: BlobBucketDefinition): string {
    return definition.versioning && definition.retentionDays !== null ? `now() + make_interval(days => ${Number(definition.retentionDays)})` : 'now()';
  }
  private async retire(tx: Tx, bucket: Row, objectId: string, state: 'replaced' | 'deleted', immediately = false) {
    await tx.unsafe(`UPDATE public.blob_objects SET state = $1, removed_at = now(), purge_after = ${immediately ? 'now()' : this.purgeAt(bucket.definition)} WHERE id = $2`, [state, objectId]);
  }
  private transfer(kind: 'PUT' | 'GET', token: string, expiresAt: Date, headers: Record<string, string>) {
    return parseComponent('BlobTransfer', { method: kind, url: `${this.origin.replace(/\/+$/, '')}/storage/v1/transfers/${token}`, expiresAt: expiresAt.toISOString(), headers });
  }

  // ── Signed commands ──────────────────────────────────────────────────────

  async execute(authority: BlobAuthority, input: BlobCommand): Promise<BlobResponse['result']> {
    const command = parseComponent('BlobCommand', structuredClone(input)); const permission = blobPermission(command.kind);
    const digest = bodyDigest(canonicalBlobRequest({ scope: authority.scope, bindingId: authority.bindingId, command }));
    return this.transact(async tx => {
      const environment = await this.environment(tx, authority, permission); const actor = authority.principal; const scope = authority.scope;
      const again = async () => { if (!await authority.permit(permission)) throw new PlatformFault('forbidden', 'Blob authority is no longer current'); };
      // Uploads are not replayable: the address is a secret that is returned once. Other commands return their receipt again.
      if ('commandId' in command && command.kind !== 'object.upload') {
        await tx`SELECT pg_advisory_xact_lock(1128354377, hashtext(${JSON.stringify([actor.kind, actor.id, command.commandId])}))`;
        const existing = (await tx<Row[]>`SELECT request_digest, result FROM public.blob_commands WHERE principal_kind = ${actor.kind} AND principal_id = ${actor.id} AND command_id = ${command.commandId}`)[0];
        if (existing) { if (existing.request_digest !== digest) throw new PlatformFault('conflict', 'Command ID was used for a different request'); await again(); return parseComponent('BlobReceipt', existing.result); }
      }
      const remember = async (receipt: BlobReceipt) => {
        await tx`INSERT INTO public.blob_commands (principal_kind, principal_id, command_id, environment_id, request_digest, result)
          VALUES (${actor.kind}, ${actor.id}, ${receipt.commandId}, ${scope.environmentId}, ${digest}, ${JSON.stringify(receipt)}::text::jsonb)`;
        await again(); return parseComponent('BlobReceipt', receipt);
      };

      switch (command.kind) {
        case 'buckets.list': {
          const rows = await tx<Row[]>`SELECT * FROM public.blob_buckets WHERE org_id = ${scope.orgId} AND project_id = ${scope.projectId} AND environment_id = ${scope.environmentId} AND state = 'active' ORDER BY name LIMIT ${MAX_BUCKETS}`;
          await again(); return parseComponent('BlobBucketList', { buckets: rows.map(bucketView) });
        }
        case 'bucket.get': { const row = await this.bucket(tx, authority, command.bucketId); await again(); return bucketView(row); }
        case 'bucket.create': {
          await tx`SELECT id FROM public.platform_environments WHERE id = ${environment.id} FOR UPDATE`;
          if ((await tx`SELECT 1 FROM public.blob_buckets WHERE environment_id = ${scope.environmentId} AND state = 'active'`).length >= MAX_BUCKETS) throw new PlatformFault('quota', 'This environment has reached its bucket limit');
          if ((await tx`SELECT 1 FROM public.blob_buckets WHERE environment_id = ${scope.environmentId} AND state = 'active' AND name = ${command.definition.name}`).length) throw new PlatformFault('conflict', 'A bucket with this name already exists');
          await tx`INSERT INTO public.blob_buckets (id, resource_id, org_id, project_id, environment_id, name, definition)
            VALUES (${command.bucketId}, ${environment.id}, ${scope.orgId}, ${scope.projectId}, ${scope.environmentId}, ${command.definition.name}, ${JSON.stringify(command.definition)}::text::jsonb)`;
          await this.audit(tx, command.bucketId, actor, 'bucket.create', authority.requestId, { visibility: command.definition.visibility });
          return remember({ commandId: command.commandId, bucketId: command.bucketId, revision: '1' });
        }
        case 'bucket.update': {
          const row = await this.bucket(tx, authority, command.bucketId, true);
          if (String(row.revision) !== command.revision) throw new PlatformFault('conflict', 'Bucket revision changed');
          if (command.definition.name !== row.name && (await tx`SELECT 1 FROM public.blob_buckets WHERE environment_id = ${scope.environmentId} AND state = 'active' AND name = ${command.definition.name}`).length) throw new PlatformFault('conflict', 'A bucket with this name already exists');
          const updated = (await tx<Row[]>`UPDATE public.blob_buckets SET name = ${command.definition.name}, definition = ${JSON.stringify(command.definition)}::text::jsonb, revision = revision + 1, updated_at = now()
            WHERE id = ${row.id} RETURNING revision::text`)[0]!;
          await this.audit(tx, row.id, actor, 'bucket.update', authority.requestId, { revision: updated.revision, visibility: command.definition.visibility });
          return remember({ commandId: command.commandId, bucketId: row.id, revision: updated.revision });
        }
        case 'bucket.delete': {
          const row = await this.bucket(tx, authority, command.bucketId, true);
          if (String(row.revision) !== command.revision) throw new PlatformFault('conflict', 'Bucket revision changed');
          if (command.confirmation !== row.name) throw new PlatformFault('validation', 'Confirm the bucket name to delete it');
          // Everything in it becomes removable now; addresses not yet used stop working. Cleanup deletes the bytes.
          await tx`UPDATE public.blob_objects SET state = CASE WHEN state = 'current' THEN 'deleted' ELSE state END, removed_at = COALESCE(removed_at, now()), purge_after = now() WHERE bucket_id = ${row.id}`;
          await tx`UPDATE public.blob_transfers SET state = 'expired', finished_at = now() WHERE bucket_id = ${row.id} AND state = 'issued'`;
          const updated = (await tx<Row[]>`UPDATE public.blob_buckets SET state = 'deleting', object_count = 0, revision = revision + 1, updated_at = now() WHERE id = ${row.id} RETURNING revision::text`)[0]!;
          await this.audit(tx, row.id, actor, 'bucket.delete', authority.requestId, { revision: updated.revision });
          return remember({ commandId: command.commandId, bucketId: row.id, revision: updated.revision });
        }
        case 'objects.list': {
          const row = await this.bucket(tx, authority, command.bucketId); const limit = command.limit ?? 100;
          const rows = await tx<Row[]>`SELECT * FROM public.blob_objects WHERE bucket_id = ${row.id} AND state = 'current' AND starts_with(key, ${command.prefix ?? ''})
            AND (${command.afterKey ?? null}::text IS NULL OR key COLLATE "C" > ${command.afterKey ?? null}::text COLLATE "C") ORDER BY key COLLATE "C" LIMIT ${limit + 1}`;
          await again(); const page = rows.slice(0, limit);
          return parseComponent('BlobObjectList', { bucketId: row.id, objects: page.map(objectView), nextAfterKey: rows.length > limit ? page.at(-1)!.key : null });
        }
        case 'object.versions': {
          const row = await this.bucket(tx, authority, command.bucketId);
          const rows = await tx<Row[]>`SELECT * FROM public.blob_objects WHERE bucket_id = ${row.id} AND key = ${command.key} ORDER BY created_at DESC, id LIMIT 1000`;
          await again(); return parseComponent('BlobObjectList', { bucketId: row.id, objects: rows.map(objectView), nextAfterKey: null });
        }
        case 'object.upload': {
          // The bucket is locked so two uploads cannot both take the last of the quota.
          const row = await this.bucket(tx, authority, command.bucketId, true); const definition = row.definition as BlobBucketDefinition;
          if (command.sizeBytes > definition.maxObjectBytes) throw new PlatformFault('validation', 'The object is larger than this bucket allows');
          if (definition.allowedContentTypes.length && !definition.allowedContentTypes.includes(command.contentType)) throw new PlatformFault('validation', 'This bucket does not accept that content type');
          if ((await tx`SELECT 1 FROM public.blob_transfers WHERE id = ${command.commandId}`).length) throw new PlatformFault('conflict', 'This upload was already requested; use a new command ID');
          // Bytes already stored, plus every upload that may still land, plus this one.
          const reserved = Number((await tx<{ bytes: string }[]>`SELECT COALESCE(sum(size_bytes), 0)::bigint::text AS bytes FROM public.blob_transfers WHERE bucket_id = ${row.id} AND kind = 'upload' AND state IN ('issued', 'receiving')`)[0]!.bytes);
          if (Number(row.used_bytes) + reserved + command.sizeBytes > definition.quotaBytes) throw new PlatformFault('quota', 'This bucket has no room for the object', { quota: 'blob_bytes' });
          const token = `bt_${randomBytes(32).toString('base64url')}`; const objectId = randomUUID();
          const issued = (await tx<{ expires_at: Date }[]>`INSERT INTO public.blob_transfers (token_hash, id, bucket_id, kind, key, object_id, size_bytes, sha256, content_type, storage_key, principal, request_id, expires_at)
            VALUES (${tokenHash(token)}, ${command.commandId}, ${row.id}, 'upload', ${command.key}, ${objectId}, ${command.sizeBytes}, ${command.sha256}, ${command.contentType},
              ${`blobs/${scope.environmentId}/${row.id}/${objectId}`}, ${JSON.stringify(actor)}::text::jsonb, ${authority.requestId}, now() + make_interval(secs => ${UPLOAD_SECONDS})) RETURNING expires_at`)[0]!;
          await this.audit(tx, row.id, actor, 'object.upload_issued', authority.requestId, { versionId: objectId });
          await again(); return this.transfer('PUT', token, issued.expires_at, { 'content-type': command.contentType, 'content-length': String(command.sizeBytes) });
        }
        case 'object.download': {
          const row = await this.bucket(tx, authority, command.bucketId);
          const found = command.versionId
            ? (await tx<Row[]>`SELECT * FROM public.blob_objects WHERE bucket_id = ${row.id} AND key = ${command.key} AND id = ${command.versionId}`)[0]
            : (await tx<Row[]>`SELECT * FROM public.blob_objects WHERE bucket_id = ${row.id} AND key = ${command.key} AND state = 'current'`)[0];
          if (!found) throw new PlatformFault('not_found', 'Object not found');
          const token = `bt_${randomBytes(32).toString('base64url')}`;
          const issued = (await tx<{ expires_at: Date }[]>`INSERT INTO public.blob_transfers (token_hash, id, bucket_id, kind, key, object_id, size_bytes, sha256, content_type, storage_key, principal, request_id, expires_at)
            VALUES (${tokenHash(token)}, ${randomUUID()}, ${row.id}, 'download', ${found.key}, ${found.id}, ${found.size_bytes}, ${found.sha256}, ${found.content_type}, ${found.storage_key},
              ${JSON.stringify(actor)}::text::jsonb, ${authority.requestId}, now() + make_interval(secs => ${DOWNLOAD_SECONDS})) RETURNING expires_at`)[0]!;
          await this.audit(tx, row.id, actor, 'object.download_issued', authority.requestId, { versionId: found.id });
          await again(); return this.transfer('GET', token, issued.expires_at, {});
        }
        case 'object.delete': {
          const row = await this.bucket(tx, authority, command.bucketId, true);
          const found = command.versionId
            ? (await tx<Row[]>`SELECT * FROM public.blob_objects WHERE bucket_id = ${row.id} AND key = ${command.key} AND id = ${command.versionId} FOR UPDATE`)[0]
            : (await tx<Row[]>`SELECT * FROM public.blob_objects WHERE bucket_id = ${row.id} AND key = ${command.key} AND state = 'current' FOR UPDATE`)[0];
          if (!found) throw new PlatformFault('not_found', 'Object not found');
          // Naming a version removes that version for good. Deleting the object keeps it restorable for the bucket's retention.
          if (found.state === 'current') { await this.retire(tx, row, found.id, 'deleted', command.versionId !== undefined); await tx`UPDATE public.blob_buckets SET object_count = object_count - 1 WHERE id = ${row.id}`; }
          else await tx`UPDATE public.blob_objects SET purge_after = now() WHERE id = ${found.id}`;
          await this.audit(tx, row.id, actor, 'object.delete', authority.requestId, { versionId: found.id, permanent: command.versionId !== undefined });
          return remember({ commandId: command.commandId, bucketId: row.id, key: command.key, versionId: found.id });
        }
        case 'object.restore': {
          const row = await this.bucket(tx, authority, command.bucketId, true);
          const found = (await tx<Row[]>`SELECT * FROM public.blob_objects WHERE bucket_id = ${row.id} AND key = ${command.key} AND id = ${command.versionId} FOR UPDATE`)[0];
          if (!found) throw new PlatformFault('not_found', 'Version not found');
          if (found.state === 'current') throw new PlatformFault('conflict', 'This version is already current');
          const current = (await tx<Row[]>`SELECT id FROM public.blob_objects WHERE bucket_id = ${row.id} AND key = ${command.key} AND state = 'current' FOR UPDATE`)[0];
          if (current) await this.retire(tx, row, current.id, 'replaced'); else await tx`UPDATE public.blob_buckets SET object_count = object_count + 1 WHERE id = ${row.id}`;
          await tx`UPDATE public.blob_objects SET state = 'current', removed_at = NULL, purge_after = NULL WHERE id = ${found.id}`;
          await this.audit(tx, row.id, actor, 'object.restore', authority.requestId, { versionId: found.id });
          return remember({ commandId: command.commandId, bucketId: row.id, key: command.key, versionId: found.id });
        }
      }
    });
  }

  // ── Transfers ────────────────────────────────────────────────────────────

  async receive(token: string, body: ReadableStream<Uint8Array> | null, declared: { readonly contentType: string | null; readonly contentLength: string | null }): Promise<void> {
    if (!/^bt_[A-Za-z0-9_-]{43}$/.test(token)) throw new PlatformFault('not_found', 'This transfer address is not valid');
    const hash = tokenHash(token);
    // The one use begins here, before a single byte is read: a second request with the same address finds it spent.
    const transfer = await this.transact(async tx => {
      const row = (await tx<Row[]>`SELECT t.*, b.state AS bucket_state FROM public.blob_transfers t JOIN public.blob_buckets b ON b.id = t.bucket_id WHERE t.token_hash = ${hash} FOR UPDATE OF t`)[0];
      if (!row || row.kind !== 'upload' || row.state !== 'issued' || row.expires_at <= new Date() || row.bucket_state !== 'active') return null;
      await tx`UPDATE public.blob_transfers SET state = 'receiving', used_at = now() WHERE token_hash = ${hash}`;
      return row;
    });
    if (!transfer) throw new PlatformFault('not_found', 'This transfer address is not valid');
    const fail = async (fault: PlatformFault, stored: boolean): Promise<never> => {
      if (stored) await this.store.delete(transfer.storage_key).catch(() => undefined);
      await this.sql`UPDATE public.blob_transfers SET state = 'failed', finished_at = now() WHERE token_hash = ${hash} AND state = 'receiving'`;
      throw fault;
    };
    const size = Number(transfer.size_bytes);
    if (declared.contentType?.split(';')[0]?.trim().toLowerCase() !== transfer.content_type) return fail(new PlatformFault('validation', 'The content type does not match the upload that was authorized'), false);
    if (declared.contentLength !== null && declared.contentLength !== String(size)) return fail(new PlatformFault('validation', 'The length does not match the upload that was authorized'), false);
    if (!body) return fail(new PlatformFault('validation', 'An upload needs a body'), false);
    // Exactly the authorized number of bytes: reading stops one byte past it, so an oversized body is never buffered.
    const chunks: Uint8Array[] = []; let received = 0; const hasher = createHash('sha256'); const reader = body.getReader();
    try {
      while (received <= size) { const { done, value } = await reader.read(); if (done) break; received += value.byteLength; if (received <= size) { chunks.push(value); hasher.update(value); } }
    } catch { return fail(new PlatformFault('validation', 'The upload was interrupted'), false); }
    finally { await reader.cancel().catch(() => undefined); }
    if (received !== size) return fail(new PlatformFault('validation', 'The upload is not the authorized size'), false);
    if (hasher.digest('hex') !== transfer.sha256) return fail(new PlatformFault('validation', 'The upload does not match the authorized digest'), false);
    try { await this.store.put(transfer.storage_key, Buffer.concat(chunks), transfer.content_type); }
    catch { return fail(new PlatformFault('unavailable', 'Blob storage could not be reached'), true); }
    try {
      await this.transact(async tx => {
        const bucket = (await tx<Row[]>`SELECT * FROM public.blob_buckets WHERE id = ${transfer.bucket_id} FOR UPDATE`)[0]!;
        const live = (await tx<Row[]>`SELECT state FROM public.blob_transfers WHERE token_hash = ${hash} FOR UPDATE`)[0];
        // The bucket may have been deleted, or cleanup may have given up on this upload, while the bytes were arriving.
        if (bucket.state !== 'active' || live?.state !== 'receiving') throw new PlatformFault('conflict', 'The upload is no longer accepted');
        const previous = (await tx<Row[]>`SELECT id FROM public.blob_objects WHERE bucket_id = ${bucket.id} AND key = ${transfer.key} AND state = 'current' FOR UPDATE`)[0];
        if (previous) await this.retire(tx, bucket, previous.id, 'replaced');
        await tx`INSERT INTO public.blob_objects (id, bucket_id, key, size_bytes, sha256, content_type, storage_key, created_by)
          VALUES (${transfer.object_id}, ${bucket.id}, ${transfer.key}, ${size}, ${transfer.sha256}, ${transfer.content_type}, ${transfer.storage_key}, ${JSON.stringify(transfer.principal)}::text::jsonb)`;
        await tx`UPDATE public.blob_buckets SET used_bytes = used_bytes + ${size}, object_count = object_count + ${previous ? 0 : 1}, updated_at = now() WHERE id = ${bucket.id}`;
        await tx`UPDATE public.blob_transfers SET state = 'completed', finished_at = now() WHERE token_hash = ${hash}`;
        await this.usage(tx, bucket, 'stored', size, transfer.object_id);
        await this.audit(tx, bucket.id, transfer.principal, 'object.stored', transfer.request_id, { versionId: transfer.object_id });
      });
    } catch (error) { return fail(error instanceof PlatformFault ? error : new PlatformFault('unavailable', 'The upload could not be recorded'), true); }
  }

  private async content(row: Row): Promise<BlobContent> {
    const bytes = await this.store.get(row.storage_key).catch(() => { throw new PlatformFault('unavailable', 'Blob storage could not be reached'); });
    if (!bytes) throw new PlatformFault('unavailable', 'The object could not be read');
    return { bytes, contentType: row.content_type, sha256: row.sha256, name: String(row.key).split('/').at(-1)! };
  }

  async open(token: string): Promise<BlobContent | null> {
    if (!/^bt_[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const hash = tokenHash(token);
    const found = await this.transact(async tx => {
      const row = (await tx<Row[]>`SELECT t.*, b.state AS bucket_state FROM public.blob_transfers t JOIN public.blob_buckets b ON b.id = t.bucket_id WHERE t.token_hash = ${hash} FOR UPDATE OF t`)[0];
      if (!row || row.kind !== 'download' || row.state !== 'issued' || row.expires_at <= new Date() || row.bucket_state !== 'active') return null;
      await tx`UPDATE public.blob_transfers SET state = 'completed', used_at = now(), finished_at = now() WHERE token_hash = ${hash}`;
      // The version may have been purged since the address was issued.
      const object = (await tx<Row[]>`SELECT * FROM public.blob_objects WHERE id = ${row.object_id}`)[0]; if (!object) return null;
      const bucket = (await tx<Row[]>`SELECT * FROM public.blob_buckets WHERE id = ${row.bucket_id}`)[0]!;
      await this.usage(tx, bucket, 'egress', Number(object.size_bytes), row.id);
      await this.audit(tx, bucket.id, row.principal, 'object.downloaded', row.request_id, { versionId: object.id });
      return object;
    });
    return found ? this.content(found) : null;
  }

  async publicObject(environmentId: string, bucketName: string, key: string): Promise<BlobContent | null> {
    try { parseComponent('Id', environmentId); parseComponent('BlobBucketName', bucketName); parseComponent('BlobKey', key); } catch { return null; }
    // Visibility is read now, from the bucket as it is: a bucket made private stops being served at once.
    const found = await this.transact(async tx => {
      const row = (await tx<Row[]>`SELECT o.*, b.org_id, b.project_id, b.environment_id FROM public.blob_objects o JOIN public.blob_buckets b ON b.id = o.bucket_id
        JOIN public.platform_environments e ON e.environment_id = b.environment_id
        WHERE b.environment_id = ${environmentId} AND b.name = ${bucketName} AND b.state = 'active' AND b.definition->>'visibility' = 'public' AND e.state = 'active' AND o.key = ${key} AND o.state = 'current'`)[0];
      if (!row) return null;
      await this.usage(tx, { id: row.bucket_id, org_id: row.org_id, project_id: row.project_id, environment_id: row.environment_id }, 'egress', Number(row.size_bytes), randomUUID());
      return row;
    });
    return found ? this.content(found) : null;
  }

  // ── Cleanup ──────────────────────────────────────────────────────────────

  async sweep(): Promise<BlobSweepResult> {
    const expired = (await this.sql`UPDATE public.blob_transfers SET state = 'expired', finished_at = now() WHERE state = 'issued' AND expires_at <= now() RETURNING id`).length;
    // An upload that began and never finished: its bytes may or may not have reached storage. Delete them, then close it.
    let interrupted = 0;
    const stuck = await this.sql<Row[]>`SELECT token_hash, storage_key, object_id FROM public.blob_transfers WHERE kind = 'upload' AND state = 'receiving' AND used_at <= now() - make_interval(secs => ${INTERRUPTED_SECONDS}) ORDER BY used_at LIMIT 200`;
    for (const transfer of stuck) {
      const closed = await this.transact(async tx => {
        const row = (await tx<Row[]>`SELECT state FROM public.blob_transfers WHERE token_hash = ${transfer.token_hash} FOR UPDATE`)[0];
        if (row?.state !== 'receiving') return false;
        await tx`UPDATE public.blob_transfers SET state = 'failed', finished_at = now() WHERE token_hash = ${transfer.token_hash}`;
        return true;
      });
      if (!closed) continue;
      // Closed first: the upload can no longer record itself, so these bytes belong to nothing.
      try { await this.store.delete(transfer.storage_key); interrupted++; } catch { /* Retried by hand or by a bucket lifecycle rule; see the gap ledger. */ }
    }
    let purged = 0;
    const due = await this.sql<Row[]>`SELECT id, storage_key FROM public.blob_objects WHERE state <> 'current' AND purge_after <= now() ORDER BY purge_after LIMIT 500`;
    for (const object of due) {
      await this.transact(async tx => {
        // The version is locked while its bytes go, so it cannot be restored half-way: a restore waits, then finds nothing.
        const row = (await tx<Row[]>`SELECT o.*, b.org_id, b.project_id, b.environment_id FROM public.blob_objects o JOIN public.blob_buckets b ON b.id = o.bucket_id WHERE o.id = ${object.id} AND o.state <> 'current' AND o.purge_after <= now() FOR UPDATE OF o`)[0];
        if (!row) return;
        // Bytes first. If the delete fails the transaction rolls back and the version is still due next time.
        await this.store.delete(row.storage_key);
        await tx`DELETE FROM public.blob_objects WHERE id = ${row.id}`;
        await tx`UPDATE public.blob_buckets SET used_bytes = used_bytes - ${row.size_bytes}, updated_at = now() WHERE id = ${row.bucket_id}`;
        await this.usage(tx, { id: row.bucket_id, org_id: row.org_id, project_id: row.project_id, environment_id: row.environment_id }, 'removed', Number(row.size_bytes), row.id);
        purged++;
      }).catch(() => undefined);
    }
    return { expired, interrupted, purged };
  }
}

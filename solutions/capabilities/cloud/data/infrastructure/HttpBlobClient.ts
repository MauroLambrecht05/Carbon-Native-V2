import { PlatformFault, blobPermission, blobRequestPath, canonicalBlobRequest, parseComponent, type BlobRequest, type BlobResponse, type Principal, type Role } from '@carbon/contracts/platform';
import { bodyDigest, sameScope, type ServiceAssertionIssuer } from '@carbon/identity';
import type { BlobTransport } from '../application/usecases/Blobs.ts';
import type { BlobStore } from '../application/ports/BlobStorage.ts';

/** Cloud's transport for blob commands. Each call carries a fresh assertion bound to this exact request. */
export class HttpBlobClient implements BlobTransport {
  private readonly origin: string;
  constructor(origin: string, private readonly issuer: ServiceAssertionIssuer, private readonly transport: typeof fetch = fetch) {
    const url = new URL(origin);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/'
      || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('Blob transport requires a pinned HTTPS or loopback origin');
    this.origin = url.origin;
  }

  async execute(input: BlobRequest, actor: { principal: Principal; role: Role; requestId: string }, signal?: AbortSignal): Promise<BlobResponse> {
    const request = parseComponent('BlobRequest', input); const command = request.command;
    const body = canonicalBlobRequest(request); const path = blobRequestPath(request.scope, request.bindingId, command.kind);
    const proof = await this.issuer.issue({ aud: 'carbon-database', principal: actor.principal, scope: request.scope, roles: [actor.role],
      grants: [{ permission: blobPermission(command.kind), scope: request.scope }], requestId: actor.requestId, request: { method: 'POST', path, bodyDigest: bodyDigest(body) } });
    const deadline = AbortSignal.timeout(20000); let response: Response;
    try {
      response = await this.transport(this.origin + path, { method: 'POST', body, redirect: 'error', signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
        headers: { authorization: `Bearer ${proof}`, 'content-type': 'application/json', 'x-request-id': actor.requestId, ...('commandId' in command ? { 'idempotency-key': command.commandId } : {}) } });
    } catch { throw new PlatformFault('unavailable', 'The storage service could not be reached'); }
    if (response.status !== 200) {
      await response.body?.cancel();
      // Only the kind of refusal crosses the boundary, never the owning service's own wording.
      throw new PlatformFault(response.status === 400 ? 'validation' : response.status === 401 ? 'unauthenticated' : response.status === 403 ? 'forbidden' : response.status === 404 ? 'not_found'
        : response.status === 409 ? 'conflict' : response.status === 429 ? 'quota' : response.status === 501 ? 'capability' : 'unavailable', 'The storage service rejected this request');
    }
    try {
      if (response.redirected || response.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json' || response.headers.get('x-request-id') !== actor.requestId) throw new Error('Invalid response');
      const text = await response.text(); if (text.length > 2_000_000) throw new Error('Oversized response');
      const result = parseComponent('BlobResponse', JSON.parse(text));
      if (result.bindingId !== request.bindingId || !sameScope(result.scope, request.scope)) throw new Error('Mismatched scope');
      if ('commandId' in command && command.kind !== 'object.upload') { const receipt = parseComponent('BlobReceipt', result.result); if (receipt.commandId !== command.commandId || receipt.bucketId !== command.bucketId) throw new Error('Mismatched receipt'); }
      return result;
    } catch { throw new PlatformFault('unavailable', 'The storage service returned an invalid response'); }
  }
}

export interface BlobStoreConfig { readonly endpoint: string; readonly bucket: string; readonly accessKeyId: string; readonly secretAccessKey: string }

/** Blob bytes in an S3-compatible bucket. The bucket must be private: bytes leave only through the service's own checks. */
export class S3BlobStore implements BlobStore {
  private readonly client: Bun.S3Client;
  constructor(config: BlobStoreConfig) { this.client = new Bun.S3Client({ endpoint: config.endpoint, bucket: config.bucket, accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey }); }
  async put(storageKey: string, bytes: Uint8Array, contentType: string): Promise<void> { await this.client.write(storageKey, bytes, { type: contentType }); }
  async get(storageKey: string): Promise<Uint8Array | null> { const file = this.client.file(storageKey); if (!await file.exists()) return null; return new Uint8Array(await file.arrayBuffer()); }
  async delete(storageKey: string): Promise<void> { await this.client.delete(storageKey); }
}

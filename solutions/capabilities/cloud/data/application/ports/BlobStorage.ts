import type { BlobCommand, BlobResponse } from '@carbon/contracts/platform';
import type { NativeDataAuthority } from './NativeTables.ts';

/** A verified caller with live authority, exactly as for table data. */
export type BlobAuthority = NativeDataAuthority;

/** Private object storage for blob bytes. Keys are opaque; nothing here is ever addressable by a public URL. */
export interface BlobStore {
  put(storageKey: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(storageKey: string): Promise<Uint8Array | null>;
  delete(storageKey: string): Promise<void>;
}

export interface BlobContent {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly sha256: string;
  /** The last path segment of the object's key, for a download file name. */
  readonly name: string;
}

export interface BlobSweepResult {
  /** Addresses that were never used and have lapsed. */
  readonly expired: number;
  /** Uploads that began and never finished; their stored bytes, if any, were deleted. */
  readonly interrupted: number;
  /** Versions past their retention whose bytes were deleted. */
  readonly purged: number;
}

export interface BlobStorageRepository {
  execute(authority: BlobAuthority, command: BlobCommand): Promise<BlobResponse['result']>;
  /** Spends an upload address. `declared` is what the request's own headers claimed. */
  receive(token: string, body: ReadableStream<Uint8Array> | null, declared: { readonly contentType: string | null; readonly contentLength: string | null }): Promise<void>;
  /** Spends a download address. Null when it is not valid. */
  open(token: string): Promise<BlobContent | null>;
  /** A current object of a bucket that is public right now. Null otherwise. */
  publicObject(environmentId: string, bucket: string, key: string): Promise<BlobContent | null>;
  sweep(): Promise<BlobSweepResult>;
}

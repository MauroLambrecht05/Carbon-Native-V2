// The real disk and the real network for installing Registry packages.

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import type { RegistryTrustBundle } from '@carbon/contracts/platform';
import { RegistryUnreachableError, type PackageCache, type PluginProject, type RegistrySource } from '../application/usecases/RegistryConsumption.ts';
import type { ArchiveFile } from '../domain/RegistryArchive.ts';

const MAX_ARCHIVE_BYTES = 67108864;
const MAX_JSON_BYTES = 4194304;

/** Registry's anonymous endpoints over HTTP. It follows no redirects and reads no more than a bounded answer. */
export class HttpRegistrySource implements RegistrySource {
  constructor(private readonly transport: typeof fetch = fetch, private readonly timeoutMs = 30000) {}

  private async get(url: string, limit: number, type: string): Promise<Uint8Array | undefined> {
    let response: Response;
    try { response = await this.transport(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs) }); } catch { throw new RegistryUnreachableError('The registry could not be reached'); }
    if (response.status === 404) { await response.body?.cancel(); return undefined; }
    if (response.status !== 200 || response.headers.get('content-type')?.split(';')[0]?.trim() !== type) { await response.body?.cancel(); throw new RegistryUnreachableError('The registry did not answer as expected'); }
    const reader = response.body?.getReader(); if (!reader) throw new RegistryUnreachableError('The registry sent no body');
    const chunks: Uint8Array[] = []; let length = 0;
    try { for (;;) { const { done, value } = await reader.read(); if (done) break; length += value.byteLength; if (length > limit) throw new RegistryUnreachableError('The registry sent more than the limit'); chunks.push(value); } }
    catch (error) { if (error instanceof RegistryUnreachableError) throw error; throw new RegistryUnreachableError('The connection to the registry was lost'); }
    finally { await reader.cancel().catch(() => {}); }
    return new Uint8Array(Buffer.concat(chunks));
  }
  private async json(url: string): Promise<unknown | undefined> {
    const bytes = await this.get(url, MAX_JSON_BYTES, 'application/json'); if (!bytes) return undefined;
    try { return JSON.parse(Buffer.from(bytes).toString('utf8')); } catch { throw new RegistryUnreachableError('The registry sent invalid JSON'); }
  }
  async trust(registry: string): Promise<unknown> { const value = await this.json(`${registry}/registry/v1/trust`); if (value === undefined) throw new RegistryUnreachableError('The registry has no trust bundle'); return value; }
  package(registry: string, publisher: string, name: string) { return this.json(`${registry}/registry/v1/packages/${publisher}/${name}`); }
  archive(registry: string, publisher: string, name: string, version: string, target: string) { return this.get(`${registry}/registry/v1/packages/${publisher}/${name}/${encodeURIComponent(version)}/${target}`, MAX_ARCHIVE_BYTES, 'application/zstd'); }
}

/** A project directory on disk. Every path is relative to the project root and may not leave it. */
export class NodePluginProject implements PluginProject {
  private readonly root: string;
  constructor(root: string) { this.root = resolve(root); }

  private at(path: string): string {
    const full = resolve(this.root, path);
    if (full !== this.root && !full.startsWith(this.root + sep)) throw new Error('A path left the project directory');
    return full;
  }
  read(path: string): string | undefined { const bytes = this.readBytes(path); return bytes && Buffer.from(bytes).toString('utf8'); }
  readBytes(path: string): Uint8Array | undefined {
    const full = this.at(path);
    try { return statSync(full).isFile() ? new Uint8Array(readFileSync(full)) : undefined; } catch { return undefined; }
  }
  write(path: string, text: string): void {
    const full = this.at(path); mkdirSync(dirname(full), { recursive: true });
    const temporary = `${full}.${randomBytes(6).toString('hex')}.tmp`;
    try { writeFileSync(temporary, text); renameSync(temporary, full); } finally { rmSync(temporary, { force: true }); }
  }
  replaceDirectory(path: string, files: readonly ArchiveFile[]): void {
    const full = this.at(path); const parent = dirname(full); mkdirSync(parent, { recursive: true });
    const staging = `${full}.${randomBytes(6).toString('hex')}.staging`; const previous = `${full}.${randomBytes(6).toString('hex')}.previous`;
    try {
      for (const file of files) {
        const target = resolve(staging, file.path);
        if (!target.startsWith(staging + sep)) throw new Error('An archive path left its directory');
        mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, file.bytes);
      }
      // The old directory is moved aside, not deleted, until the new one is in place.
      const had = existsSync(full); if (had) renameSync(full, previous);
      try { renameSync(staging, full); } catch (error) { if (had) renameSync(previous, full); throw error; }
      rmSync(previous, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } finally { rmSync(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
  }
  removeDirectory(path: string): void {
    let full = this.at(path); rmSync(full, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    // Parents left empty by the removal go too, up to the project root.
    for (full = dirname(full); full !== this.root && full.startsWith(this.root + sep); full = dirname(full)) { try { if (readdirSync(full).length) break; rmSync(full, { recursive: true }); } catch { break; } }
  }
  directories(path: string, depth: number): string[] {
    const walk = (directory: string, remaining: number): string[] => {
      let names: string[]; try { names = readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory() && !/\.(staging|previous)$/.test(entry.name)).map(entry => entry.name).sort(); } catch { return []; }
      return remaining === 1 ? names : names.flatMap(name => walk(join(directory, name), remaining - 1).map(rest => `${name}/${rest}`));
    };
    return walk(this.at(path), depth);
  }
}

/** Verified archives by digest, and the last verified trust bundle per root key, in one directory on this machine. */
export class NodePackageCache implements PackageCache {
  constructor(private readonly directory: string) {}
  private write(path: string, bytes: Uint8Array): void {
    mkdirSync(dirname(path), { recursive: true }); const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`;
    try { writeFileSync(temporary, bytes); renameSync(temporary, path); } catch { /* A cache that cannot be written is only a slower next install. */ } finally { rmSync(temporary, { force: true }); }
  }
  archive(sha256: string): Uint8Array | undefined {
    if (!/^[a-f0-9]{64}$/.test(sha256)) return undefined;
    try { return new Uint8Array(readFileSync(join(this.directory, 'archives', `${sha256}.tar.zst`))); } catch { return undefined; }
  }
  putArchive(sha256: string, bytes: Uint8Array): void { if (/^[a-f0-9]{64}$/.test(sha256)) this.write(join(this.directory, 'archives', `${sha256}.tar.zst`), bytes); }
  trust(rootPublicKey: string): unknown | undefined {
    if (!/^[a-f0-9]{64}$/.test(rootPublicKey)) return undefined;
    try { return JSON.parse(readFileSync(join(this.directory, 'trust', `${rootPublicKey}.json`), 'utf8')); } catch { return undefined; }
  }
  putTrust(rootPublicKey: string, bundle: RegistryTrustBundle): void { if (/^[a-f0-9]{64}$/.test(rootPublicKey)) this.write(join(this.directory, 'trust', `${rootPublicKey}.json`), new TextEncoder().encode(JSON.stringify(bundle))); }
}

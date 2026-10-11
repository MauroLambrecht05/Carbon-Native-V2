// A Registry that exists only in memory, for tests of the installing side.
// It signs with real keys and packs real archives, and a test can make it
// lie, fail, or go away.

import { createHash, randomBytes } from 'node:crypto';
import type { RegistryManifest, RegistryPublicVersion, RegistryTarget, RegistryTrustBundle } from '@carbon/contracts/platform';
import { RegistrySigner, RegistryUnreachableError, libraryFile, manifestDigest, manifestFile, packArchive, publicKeyHex, signTrustBundle, type ArchiveFile, type RegistrySource } from '../index.ts';

const text = (value: string) => new TextEncoder().encode(value);

/** The smallest file each format's loader would recognize as a library for that machine. Not a working library. */
export function fakeLibrary(target: RegistryTarget): Uint8Array {
  const bytes = Buffer.alloc(256);
  if (target.includes('windows')) { bytes.write('MZ', 0); bytes.writeUInt32LE(64, 60); bytes.write('PE\0\0', 64); bytes.writeUInt16LE(target.startsWith('x86_64') ? 0x8664 : 0xaa64, 68); }
  else if (target.includes('linux')) { Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]).copy(bytes); bytes.writeUInt16LE(target.startsWith('x86_64') ? 62 : 183, 18); }
  else { bytes.writeUInt32LE(0xfeedfacf, 0); bytes.writeUInt32LE(target.startsWith('x86_64') ? 0x01000007 : 0x0100000c, 4); }
  return new Uint8Array(bytes);
}

export interface Publication {
  readonly target?: RegistryTarget; readonly abiMajor?: number; readonly abiMinor?: number; readonly required?: readonly string[]; readonly optional?: readonly string[];
  readonly yanked?: boolean; readonly state?: 'published' | 'revoked'; readonly reason?: string; readonly signer?: RegistrySigner; readonly extra?: readonly ArchiveFile[];
}

export class FakeRegistry implements RegistrySource {
  readonly origin = 'https://registry.example.test';
  readonly rootSeed = randomBytes(32).toString('hex'); readonly rootPublicKey = publicKeyHex(this.rootSeed);
  readonly signer = new RegistrySigner('registry-2026', randomBytes(32).toString('hex'));
  bundle: RegistryTrustBundle = signTrustBundle(this.rootSeed, { sequence: 3, issuedAt: '2026-10-11T08:00:00Z', keys: [{ id: this.signer.keyId, publicKey: this.signer.publicKeyHex, state: 'active' }] });
  readonly versions = new Map<string, RegistryPublicVersion[]>(); readonly archives = new Map<string, Uint8Array>();
  /** When true, every request fails as an unreachable network would. */
  down = false;
  readonly requests: string[] = [];

  /** Publishes one version the way the real Registry would: a packed archive and a signed statement naming it. */
  publish(key: string, version: string, options: Publication = {}): RegistryPublicVersion {
    const [publisher, name] = key.split('/') as [string, string]; const target = options.target ?? 'x86_64-pc-windows-msvc';
    const manifest: RegistryManifest = { abiMajor: options.abiMajor ?? 1, abiMinor: options.abiMinor ?? 4, description: `${name} for tests`, requiredCapabilities: [...(options.required ?? [])], optionalCapabilities: [...(options.optional ?? [])] };
    const coordinates = { publisher, name, version, target };
    const bytes = packArchive([{ path: 'carbon-plugin.json', bytes: text(manifestFile(coordinates, manifest)) }, { path: libraryFile(name, target), bytes: fakeLibrary(target) }, { path: 'README.md', bytes: text(`# ${name} ${version}\n`) }, ...(options.extra ?? [])]);
    const signed = (options.signer ?? this.signer).sign({ ...coordinates, sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.length, manifestDigest: manifestDigest(manifest), publishedAt: '2026-10-11T08:00:00Z' });
    const entry: RegistryPublicVersion = { version, target, state: options.state ?? 'published', yanked: options.yanked ?? false, reason: options.reason ?? null, signed, manifest };
    this.versions.set(key, [...(this.versions.get(key) ?? []).filter(item => item.version !== version || item.target !== target), entry]); this.archives.set(`${key}@${version}/${target}`, bytes);
    return entry;
  }
  /** Changes what Registry says about a published version, as a yank or a revocation does. */
  mark(key: string, version: string, change: Partial<Pick<RegistryPublicVersion, 'state' | 'yanked' | 'reason'>>): void {
    this.versions.set(key, this.versions.get(key)!.map(item => (item.version === version ? { ...item, ...change } : item)));
  }

  private reach(request: string): void { this.requests.push(request); if (this.down) throw new RegistryUnreachableError('down'); }
  async trust(): Promise<unknown> { this.reach('trust'); return structuredClone(this.bundle); }
  async package(_registry: string, publisher: string, name: string): Promise<unknown | undefined> {
    this.reach(`package ${publisher}/${name}`); const versions = this.versions.get(`${publisher}/${name}`);
    return versions && structuredClone({ publisher, name, versions });
  }
  async archive(_registry: string, publisher: string, name: string, version: string, target: string): Promise<Uint8Array | undefined> {
    this.reach(`archive ${publisher}/${name}@${version}`);
    const listed = this.versions.get(`${publisher}/${name}`)?.find(item => item.version === version && item.target === target);
    return listed?.state === 'published' ? this.archives.get(`${publisher}/${name}@${version}/${target}`) : undefined;
  }
}

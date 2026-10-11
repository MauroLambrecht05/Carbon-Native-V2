// A package archive is one zstd frame around a ustar tarball. Registry reads
// every byte of an upload before a reviewer ever sees it, and refuses anything
// it cannot fully account for. Nothing here writes to disk or runs anything.

import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { canonicalJson, type RegistryManifest, type RegistryTarget } from '@carbon/contracts/platform';

export const MANIFEST_PATH = 'carbon-plugin.json';
export const MAX_ARCHIVE_BYTES = 67108864;
const MAX_EXPANDED_BYTES = 268435456;
const MAX_EXPANSION_RATIO = 200;
const MAX_ENTRIES = 2000;
const MAX_PATH = 200;
const BLOCK = 512;

export interface PackageCoordinates { readonly publisher: string; readonly name: string; readonly version: string; readonly target: RegistryTarget }
export interface ArchiveFile { readonly path: string; readonly bytes: Uint8Array }
export type ArchiveInspection = { readonly ok: true; readonly files: readonly { readonly path: string; readonly sizeBytes: number }[] } | { readonly ok: false; readonly category: string };

const LIBRARY: Record<RegistryTarget, { file: (name: string) => string; format: 'pe' | 'elf' | 'macho'; machine: number }> = {
  'x86_64-pc-windows-msvc': { file: name => `${name}.dll`, format: 'pe', machine: 0x8664 },
  'aarch64-pc-windows-msvc': { file: name => `${name}.dll`, format: 'pe', machine: 0xaa64 },
  'x86_64-unknown-linux-gnu': { file: name => `lib${name}.so`, format: 'elf', machine: 62 },
  'aarch64-unknown-linux-gnu': { file: name => `lib${name}.so`, format: 'elf', machine: 183 },
  'x86_64-apple-darwin': { file: name => `lib${name}.dylib`, format: 'macho', machine: 0x01000007 },
  'aarch64-apple-darwin': { file: name => `lib${name}.dylib`, format: 'macho', machine: 0x0100000c },
};
/** The one native library a package for this target must contain, at the archive root. */
export const libraryFile = (name: string, target: RegistryTarget) => LIBRARY[target].file(name);

class Refused extends Error { constructor(readonly category: string) { super(category); } }
const refuse = (category: string): never => { throw new Refused(category); };

/** What the manifest file inside the archive must say, byte for byte once canonicalized. */
export function manifestFile(coordinates: PackageCoordinates, manifest: RegistryManifest): string {
  return canonicalJson({ publisher: coordinates.publisher, name: coordinates.name, version: coordinates.version, target: coordinates.target, ...manifest });
}

/** The length of the first zstd frame, read from its block headers. An archive is exactly one frame: nothing may follow it uninspected. */
function frameLength(bytes: Uint8Array): number {
  if (bytes.length < 9 || bytes[0] !== 0x28 || bytes[1] !== 0xb5 || bytes[2] !== 0x2f || bytes[3] !== 0xfd) refuse('archive.not_zstd');
  const descriptor = bytes[4]!; const single = (descriptor & 0x20) !== 0; const checksum = (descriptor & 0x04) !== 0;
  const dictionary = [0, 1, 2, 4][descriptor & 0x03]!; const content = [single ? 1 : 0, 2, 4, 8][descriptor >> 6]!;
  if (dictionary !== 0) refuse('archive.dictionary');
  let offset = 5 + (single ? 0 : 1) + content;
  for (;;) {
    if (offset + 3 > bytes.length) refuse('archive.truncated');
    const header = bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16); const type = (header >> 1) & 3; const size = header >> 3;
    if (type === 3) refuse('archive.not_zstd');
    offset += 3 + (type === 1 ? 1 : size);
    if (header & 1) break;
  }
  offset += checksum ? 4 : 0;
  if (offset > bytes.length) refuse('archive.truncated');
  return offset;
}

function text(block: Uint8Array, start: number, length: number): string {
  let end = start; while (end < start + length && block[end] !== 0) end++;
  const value = Buffer.from(block.subarray(start, end)).toString('utf8');
  if (Buffer.from(value, 'utf8').length !== end - start) refuse('archive.path'); return value;
}
function octal(block: Uint8Array, start: number, length: number): number {
  const value = text(block, start, length).trim(); if (!/^[0-7]{1,12}$/.test(value)) refuse('archive.header'); return Number.parseInt(value, 8);
}
/** A path that means the same file on every platform, and cannot leave the directory it is extracted into. */
function safePath(path: string): string {
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path;
  if (!trimmed || trimmed.length > MAX_PATH || trimmed.startsWith('/') || /[\\:*?"<>|\u0000-\u001f\u007f]/.test(trimmed)) refuse('archive.path');
  for (const segment of trimmed.split('/')) {
    if (!segment || segment === '.' || segment === '..' || /[. ]$/.test(segment) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(segment)) refuse('archive.path');
  }
  return trimmed;
}
const starts = (bytes: Uint8Array, ...magic: number[]) => magic.every((value, index) => bytes[index] === value);
function executable(bytes: Uint8Array): 'pe' | 'elf' | 'macho' | 'script' | undefined {
  if (starts(bytes, 0x4d, 0x5a)) return 'pe';
  if (starts(bytes, 0x7f, 0x45, 0x4c, 0x46)) return 'elf';
  if (starts(bytes, 0xcf, 0xfa, 0xed, 0xfe) || starts(bytes, 0xce, 0xfa, 0xed, 0xfe) || starts(bytes, 0xca, 0xfe, 0xba, 0xbe) || starts(bytes, 0xfe, 0xed, 0xfa, 0xcf)) return 'macho';
  if (starts(bytes, 0x23, 0x21)) return 'script';
  return undefined;
}
/** The machine a native library was built for, or undefined when the file is not a well-formed library of that format. */
function machine(bytes: Uint8Array, format: 'pe' | 'elf' | 'macho'): number | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (format === 'pe') {
    if (bytes.length < 64) return undefined; const header = view.getUint32(60, true);
    if (header + 6 > bytes.length || view.getUint32(header, true) !== 0x00004550) return undefined;
    return view.getUint16(header + 4, true);
  }
  // 64-bit, little-endian only: the targets Carbon builds for.
  if (format === 'elf') return bytes.length >= 20 && bytes[4] === 2 && bytes[5] === 1 ? view.getUint16(18, true) : undefined;
  return bytes.length >= 8 && starts(bytes, 0xcf, 0xfa, 0xed, 0xfe) ? view.getUint32(4, true) : undefined;
}

function entries(tar: Uint8Array): ArchiveFile[] {
  const files: ArchiveFile[] = []; const seen = new Set<string>(); let offset = 0; let ended = false; let count = 0;
  while (offset + BLOCK <= tar.length) {
    const block = tar.subarray(offset, offset + BLOCK); offset += BLOCK;
    if (block.every(value => value === 0)) { ended = true; break; }
    if (++count > MAX_ENTRIES) refuse('archive.too_many_entries');
    let sum = 0; for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : block[i]!;
    if (octal(block, 148, 8) !== sum) refuse('archive.header');
    if (text(block, 257, 5) !== 'ustar') refuse('archive.header');
    const type = block[156]!; const prefix = text(block, 345, 155); const name = text(block, 0, 100); const size = octal(block, 124, 12);
    // Regular files and directories only. Links, devices and extension records can each point somewhere else.
    if (type !== 0x30 && type !== 0 && type !== 0x35) refuse('archive.entry_type');
    const path = safePath(prefix ? `${prefix}/${name}` : name); const key = path.toLowerCase();
    if (seen.has(key)) refuse('archive.duplicate_path'); seen.add(key);
    if (type === 0x35) { if (size !== 0) refuse('archive.header'); continue; }
    if (offset + size > tar.length) refuse('archive.truncated');
    files.push({ path, bytes: tar.subarray(offset, offset + size) }); offset += Math.ceil(size / BLOCK) * BLOCK;
  }
  if (!ended || tar.subarray(offset).some(value => value !== 0)) refuse('archive.trailing_data');
  // A file cannot also be a directory another entry lives under.
  for (const file of files) for (const other of seen) if (other.startsWith(`${file.path.toLowerCase()}/`)) refuse('archive.duplicate_path');
  return files;
}

/**
 * Checks an uploaded archive against what its publisher declared. It must be one zstd frame, expand within bounds,
 * hold only plain files with portable paths, carry the declared manifest, and contain exactly one native library:
 * the one named for the package, built for the declared target.
 */
export function inspectArchive(bytes: Uint8Array, coordinates: PackageCoordinates, manifest: RegistryManifest): ArchiveInspection {
  try {
    if (bytes.length === 0 || bytes.length > MAX_ARCHIVE_BYTES) refuse('archive.size');
    if (frameLength(bytes) !== bytes.length) refuse('archive.trailing_data');
    let tar: Uint8Array;
    try { tar = zstdDecompressSync(bytes, { maxOutputLength: Math.min(MAX_EXPANDED_BYTES, Math.max(bytes.length * MAX_EXPANSION_RATIO, 1048576)) }); }
    catch (error) { return { ok: false, category: (error as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE' ? 'archive.expands_too_much' : 'archive.not_zstd' }; }
    if (tar.length === 0 || tar.length % BLOCK !== 0) refuse('archive.truncated');
    const files = entries(tar);
    const declared = files.find(file => file.path === MANIFEST_PATH); if (!declared) refuse('archive.manifest_missing');
    let inside: unknown; try { inside = JSON.parse(Buffer.from(declared!.bytes).toString('utf8')); } catch { refuse('archive.manifest_invalid'); }
    let canonical: string; try { canonical = canonicalJson(inside); } catch { return { ok: false, category: 'archive.manifest_invalid' }; }
    if (canonical !== manifestFile(coordinates, manifest)) refuse('archive.manifest_mismatch');
    const expected = LIBRARY[coordinates.target]; const library = expected.file(coordinates.name);
    const found = files.find(file => file.path === library); if (!found) refuse('archive.library_missing');
    if (machine(found!.bytes, expected.format) !== expected.machine) refuse('archive.library_target');
    // Any other executable is something the manifest does not account for.
    for (const file of files) if (file !== found && executable(file.bytes)) refuse('archive.unexpected_executable');
    return { ok: true, files: files.map(file => ({ path: file.path, sizeBytes: file.bytes.length })) };
  } catch (error) {
    if (error instanceof Refused) return { ok: false, category: error.category };
    throw error;
  }
}

/**
 * Packs files into an archive. The same files always give the same tarball: entries are sorted, and carry no
 * owner, time or mode that differs between machines.
 */
export function packArchive(files: readonly ArchiveFile[]): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const name = Buffer.from(file.path, 'utf8'); if (name.length > 100) throw new Error('Archive paths are limited to 100 bytes');
    const header = Buffer.alloc(BLOCK); name.copy(header, 0);
    header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
    header.write(file.bytes.length.toString(8).padStart(11, '0') + '\0', 124); header.write('00000000000\0', 136);
    header.write('        ', 148); header[156] = 0x30; header.write('ustar\0', 257); header.write('00', 263);
    let sum = 0; for (const value of header) sum += value;
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(header, file.bytes, new Uint8Array((BLOCK - (file.bytes.length % BLOCK)) % BLOCK));
  }
  blocks.push(new Uint8Array(BLOCK * 2));
  return new Uint8Array(zstdCompressSync(Buffer.concat(blocks)));
}

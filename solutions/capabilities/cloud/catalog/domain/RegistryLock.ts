// What a project asks Registry for, and exactly what it got.
//
// The declaration (`carbon/registry.json`) is written by people: which
// packages, in which version ranges, from which Registry, under which pinned
// root key. The lock (`carbon/registry.lock.json`) is written by the tool: the
// one exact version of each, with the signed statement that names its bytes.
// A build installs from the lock and from nothing else.

import { canonicalJson, parseComponent, type RegistryManifest, type RegistrySignedStatement, type RegistryTarget } from '@carbon/contracts/platform';

export const DECLARATION_PATH = 'carbon/registry.json';
export const LOCK_PATH = 'carbon/registry.lock.json';
export const INSTALL_ROOT = 'carbon/plugins/registry';
export const PROVENANCE_FILE = '.carbon-provenance.json';

/** Why a plugin operation stopped. `code` is stable; a command line branches on it. */
export class RegistryPluginError extends Error {
  constructor(readonly code: 'invalid_file' | 'not_configured' | 'not_declared' | 'unavailable' | 'not_found' | 'no_compatible_version' | 'approval_required' | 'lock_out_of_date' | 'revoked' | 'untrusted' | 'not_cached',
    message: string, readonly details: Readonly<Record<string, unknown>> = {}) { super(message); }
}
const invalid = (file: string, what: string): never => { throw new RegistryPluginError('invalid_file', `${file} is not valid: ${what}`); };

// ── Versions and ranges ──────────────────────────────────────────────────────

interface Version { readonly major: number; readonly minor: number; readonly patch: number; readonly pre: readonly string[] }
function parseVersion(value: string): Version | undefined {
  const match = /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
  return match ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre: match[4] ? match[4].split('.') : [] } : undefined;
}
/** Semantic-version precedence: negative when `a` is older than `b`. */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a); const right = parseVersion(b); if (!left || !right) throw new Error('Not a version');
  for (const part of ['major', 'minor', 'patch'] as const) if (left[part] !== right[part]) return left[part] - right[part];
  // A release is newer than any of its pre-releases.
  if (!left.pre.length || !right.pre.length) return (left.pre.length ? 0 : 1) - (right.pre.length ? 0 : 1);
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const x = left.pre[i]; const y = right.pre[i];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const numeric = [/^[0-9]+$/.test(x), /^[0-9]+$/.test(y)];
    if (numeric[0] && numeric[1]) { if (Number(x) !== Number(y)) return Number(x) - Number(y); }
    else if (numeric[0] !== numeric[1]) return numeric[0] ? -1 : 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
/** A range is an exact version, `^1.2.3`, `~1.2.3` or `*`. */
export function validRange(range: string): boolean { return range === '*' || !!parseVersion(range.replace(/^[\^~]/, '')); }
/**
 * Whether a version is inside a range. `^` allows changes that keep the left-most non-zero part; `~` allows patch
 * changes. A pre-release is only ever chosen by naming it exactly: a range never drifts onto one.
 */
export function satisfies(version: string, range: string): boolean {
  const candidate = parseVersion(version); if (!candidate || !validRange(range)) return false;
  if (range === '*') return !candidate.pre.length;
  if (!/^[\^~]/.test(range)) return compareVersions(version, range) === 0;
  const floor = parseVersion(range.slice(1))!;
  if (candidate.pre.length || compareVersions(version, range.slice(1)) < 0) return false;
  if (range[0] === '~') return candidate.major === floor.major && candidate.minor === floor.minor;
  if (floor.major > 0) return candidate.major === floor.major;
  if (floor.minor > 0) return candidate.major === 0 && candidate.minor === floor.minor;
  return candidate.major === 0 && candidate.minor === 0 && candidate.patch === floor.patch;
}

// ── Names ────────────────────────────────────────────────────────────────────

export interface PackageName { readonly publisher: string; readonly name: string }
export function parsePackageName(value: string): PackageName {
  const match = /^([^/@]+)\/([^/@]+)$/.exec(value);
  try { if (!match) throw new Error(); return { publisher: parseComponent('RegistrySlug', match[1]!), name: parseComponent('RegistryPackageName', match[2]!) }; }
  catch { throw new RegistryPluginError('invalid_file', `"${value}" is not a package name. Use publisher/name`); }
}
/** `publisher/name` or `publisher/name@range`. Without a range, any release. */
export function parsePackageSpec(value: string): PackageName & { readonly range: string | undefined } {
  const at = value.lastIndexOf('@'); const name = parsePackageName(at > 0 ? value.slice(0, at) : value); const range = at > 0 ? value.slice(at + 1) : undefined;
  if (range !== undefined && !validRange(range)) throw new RegistryPluginError('invalid_file', `"${range}" is not a version range. Use 1.2.3, ^1.2.3, ~1.2.3 or *`);
  return { ...name, range };
}

// ── The declaration ──────────────────────────────────────────────────────────

export interface RegistryDeclaration {
  /** The Registry this project installs from. */
  readonly registry: string;
  /** The root key every trust bundle must be signed by. Pinned here, in the repository; never taken from Registry. */
  readonly rootPublicKey: string;
  readonly plugins: Readonly<Record<string, string>>;
}
function registryOrigin(value: unknown, file: string): string {
  let url: URL; try { url = new URL(String(value)); } catch { return invalid(file, 'registry must be a URL'); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) invalid(file, 'registry must be an HTTPS or loopback origin');
  return url.origin;
}
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export function parseDeclaration(text: string): RegistryDeclaration {
  let value: unknown; try { value = JSON.parse(text); } catch { return invalid(DECLARATION_PATH, 'it is not JSON'); }
  if (!plain(value) || Object.keys(value).some(key => !['registry', 'rootPublicKey', 'plugins'].includes(key))) invalid(DECLARATION_PATH, 'it may hold only registry, rootPublicKey and plugins');
  const input = value as Record<string, unknown>;
  if (typeof input.rootPublicKey !== 'string' || !/^[a-f0-9]{64}$/.test(input.rootPublicKey)) invalid(DECLARATION_PATH, 'rootPublicKey must be 64 lowercase hex characters');
  if (!plain(input.plugins)) invalid(DECLARATION_PATH, 'plugins must be an object');
  for (const [name, range] of Object.entries(input.plugins as Record<string, unknown>)) { parsePackageName(name); if (typeof range !== 'string' || !validRange(range)) invalid(DECLARATION_PATH, `the range of ${name} is not a version range`); }
  return { registry: registryOrigin(input.registry, DECLARATION_PATH), rootPublicKey: input.rootPublicKey as string, plugins: input.plugins as Record<string, string> };
}

// ── The lock ─────────────────────────────────────────────────────────────────

export interface LockedTarget { readonly signed: RegistrySignedStatement; readonly manifest: RegistryManifest }
export interface LockedPlugin {
  /** The declared range this version was chosen for. A different declared range means the lock is out of date. */
  readonly range: string;
  readonly version: string;
  /** Every capability a person approved for this package. A version that asks for more needs approval again. */
  readonly approvedCapabilities: readonly string[];
  readonly targets: Readonly<Partial<Record<RegistryTarget, LockedTarget>>>;
}
export interface RegistryLock {
  readonly lockVersion: 1;
  readonly registry: string;
  /** The highest trust-bundle sequence this project has accepted. An older bundle is refused from then on. */
  readonly trustSequence: number;
  readonly plugins: Readonly<Record<string, LockedPlugin>>;
}
export const emptyLock = (registry: string): RegistryLock => ({ lockVersion: 1, registry, trustSequence: 0, plugins: {} });
export function parseLock(text: string): RegistryLock {
  let value: unknown; try { value = JSON.parse(text); } catch { return invalid(LOCK_PATH, 'it is not JSON'); }
  if (!plain(value) || value.lockVersion !== 1 || !Number.isInteger(value.trustSequence) || (value.trustSequence as number) < 0 || !plain(value.plugins)) invalid(LOCK_PATH, 'it is not a version 1 lock');
  const input = value as { registry: unknown; trustSequence: number; plugins: Record<string, unknown> }; const plugins: Record<string, LockedPlugin> = {};
  for (const [key, raw] of Object.entries(input.plugins)) {
    const name = parsePackageName(key);
    if (!plain(raw) || typeof raw.range !== 'string' || !validRange(raw.range) || typeof raw.version !== 'string' || !parseVersion(raw.version) || !Array.isArray(raw.approvedCapabilities)
      || raw.approvedCapabilities.some(item => typeof item !== 'string') || !plain(raw.targets) || !Object.keys(raw.targets).length) invalid(LOCK_PATH, `the entry for ${key} is malformed`);
    const entry = raw as { range: string; version: string; approvedCapabilities: string[]; targets: Record<string, unknown> }; const targets: Partial<Record<RegistryTarget, LockedTarget>> = {};
    for (const [target, item] of Object.entries(entry.targets)) {
      try {
        if (!plain(item)) throw new Error(); const signed = parseComponent('RegistrySignedStatement', item.signed as RegistrySignedStatement); const manifest = parseComponent('RegistryManifest', item.manifest as RegistryManifest);
        // An entry can only be for the package, version and target it is filed under.
        if (signed.statement.publisher !== name.publisher || signed.statement.name !== name.name || signed.statement.version !== entry.version || signed.statement.target !== target) throw new Error();
        targets[parseComponent('RegistryTarget', target as RegistryTarget)] = { signed, manifest };
      } catch { invalid(LOCK_PATH, `the ${target} entry for ${key} is malformed`); }
    }
    plugins[key] = { range: entry.range, version: entry.version, approvedCapabilities: [...entry.approvedCapabilities].sort(), targets };
  }
  return { lockVersion: 1, registry: registryOrigin(input.registry, LOCK_PATH), trustSequence: input.trustSequence, plugins };
}

/** The same content always gives the same file, so a lock only changes in version control when what it says changes. */
export function serialize(value: RegistryDeclaration | RegistryLock): string { return `${JSON.stringify(JSON.parse(canonicalJson(value)), null, 2)}\n`; }
export const installPath = (name: string, target: string) => `${INSTALL_ROOT}/${name}/${target}`;

// Installing packages from Registry into a project.
//
// Every command here follows one rule: the lock is the truth. `add`, `update`
// and `remove` change the declaration and the lock; `install` makes the disk
// match the lock and never changes the lock. A command that fails part-way has
// either changed nothing, or left a lock that `install` can finish from.
//
// Nothing Registry answers is trusted until it is checked against the root key
// pinned in the project's own declaration.

import { createHash } from 'node:crypto';
import { parseComponent, type RegistryPublicPackage, type RegistryPublicVersion, type RegistryTarget, type RegistryTrustBundle } from '@carbon/contracts/platform';
import { readArchive, type ArchiveFile } from '../../domain/RegistryArchive.ts';
import { DECLARATION_PATH, INSTALL_ROOT, LOCK_PATH, PROVENANCE_FILE, RegistryPluginError, compareVersions, emptyLock, installPath, parseDeclaration, parseLock, parsePackageName, parsePackageSpec, satisfies, serialize,
  type LockedPlugin, type LockedTarget, type RegistryDeclaration, type RegistryLock } from '../../domain/RegistryLock.ts';
import { RegistryTrustError, verifyRegistryPackage, verifyTrustBundle } from '../../domain/RegistryTrust.ts';

/** Registry's anonymous endpoints. Answers are untrusted JSON and bytes; `undefined` means Registry said "not found". */
export interface RegistrySource {
  trust(registry: string): Promise<unknown>;
  package(registry: string, publisher: string, name: string): Promise<unknown | undefined>;
  archive(registry: string, publisher: string, name: string, version: string, target: string): Promise<Uint8Array | undefined>;
}
/** The registry could not be reached, or did not answer as Registry does. Distinct from "not found". */
export class RegistryUnreachableError extends Error {}

/** The project directory. Writes replace a file or a directory whole, or leave what was there. */
export interface PluginProject {
  read(path: string): string | undefined;
  /** Writes through a temporary file and a rename: a reader sees the old file or the new one, never part of one. */
  write(path: string, text: string): void;
  /** Builds the directory beside its destination, then swaps it in. */
  replaceDirectory(path: string, files: readonly ArchiveFile[]): void;
  removeDirectory(path: string): void;
  /** Paths of the directories exactly `depth` levels below `path`, relative to it. */
  directories(path: string, depth: number): string[];
  readBytes(path: string): Uint8Array | undefined;
}
/** Verified archives and the last verified trust bundle, kept outside the project so an install can work offline. */
export interface PackageCache {
  archive(sha256: string): Uint8Array | undefined;
  putArchive(sha256: string, bytes: Uint8Array): void;
  trust(rootPublicKey: string): unknown | undefined;
  putTrust(rootPublicKey: string, bundle: RegistryTrustBundle): void;
}
/** The machine a project is being built for. A package must match the target and fit inside the host's plugin ABI. */
export interface PluginHost { readonly target: RegistryTarget; readonly abiMajor: number; readonly abiMinor: number }

export interface ChangeReport { readonly name: string; readonly from: string | undefined; readonly to: string | undefined; readonly capabilities: readonly string[] }
export interface InstallReport { readonly installed: readonly string[]; readonly unchanged: readonly string[]; readonly removed: readonly string[] }
export interface AuditFinding { readonly name: string; readonly version: string; readonly problem: 'revoked' | 'yanked' | 'withdrawn' | 'changed' | 'not_installed' | 'modified'; readonly reason: string | null }
interface Provenance { readonly signed: LockedTarget['signed']; readonly trustSequence: number; readonly registry: string; readonly files: readonly { readonly path: string; readonly sha256: string }[] }

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const capabilitiesOf = (item: LockedTarget | RegistryPublicVersion) => [...new Set([...item.manifest.requiredCapabilities, ...item.manifest.optionalCapabilities])].sort();

export class RegistryPlugins {
  constructor(private readonly project: PluginProject, private readonly source: RegistrySource, private readonly cache: PackageCache, private readonly host: PluginHost) {}

  // ── Files ────────────────────────────────────────────────────────────────

  private declaration(): RegistryDeclaration {
    const text = this.project.read(DECLARATION_PATH);
    if (text === undefined) throw new RegistryPluginError('not_configured', `This project has no ${DECLARATION_PATH}. Run: carbon plugin registry init --registry <url> --root-key <key>`);
    return parseDeclaration(text);
  }
  private lock(declaration: RegistryDeclaration): RegistryLock {
    const text = this.project.read(LOCK_PATH); const lock = text === undefined ? emptyLock(declaration.registry) : parseLock(text);
    // A lock made against another Registry says nothing about this one.
    if (lock.registry !== declaration.registry) throw new RegistryPluginError('lock_out_of_date', `${LOCK_PATH} was made for ${lock.registry}, but ${DECLARATION_PATH} names ${declaration.registry}`);
    return lock;
  }

  /** Records which Registry and which root key this project trusts. Refuses to change either once set: that is a decision for a person, made by editing the file. */
  init(registry: string, rootPublicKey: string): RegistryDeclaration {
    const next = parseDeclaration(JSON.stringify({ registry, rootPublicKey, plugins: {} })); const existing = this.project.read(DECLARATION_PATH);
    if (existing !== undefined) {
      const current = parseDeclaration(existing);
      if (current.registry !== next.registry || current.rootPublicKey !== next.rootPublicKey) throw new RegistryPluginError('invalid_file', `${DECLARATION_PATH} already names a registry and a root key. Edit it by hand to change them`);
      return current;
    }
    this.project.write(DECLARATION_PATH, serialize(next)); return next;
  }

  // ── Registry, checked ────────────────────────────────────────────────────

  private async reach<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); } catch (error) {
      if (error instanceof RegistryPluginError) throw error;
      throw new RegistryPluginError('unavailable', 'The registry could not be reached. Nothing was changed');
    }
  }
  private untrusted(error: unknown, what: string): never {
    if (error instanceof RegistryTrustError) throw new RegistryPluginError('untrusted', `${what} failed its trust check (${error.category}). Nothing was installed`, { category: error.category });
    throw error;
  }
  /** The current trust bundle, accepted only under the pinned root and never older than one this project has seen. */
  private async trust(declaration: RegistryDeclaration, lock: RegistryLock): Promise<RegistryTrustBundle> {
    const answer = await this.reach(() => this.source.trust(declaration.registry));
    try { verifyTrustBundle(declaration.rootPublicKey, answer as RegistryTrustBundle, lock.trustSequence); } catch (error) { this.untrusted(error, 'The registry trust bundle'); }
    const bundle = parseComponent('RegistryTrustBundle', answer as RegistryTrustBundle); this.cache.putTrust(declaration.rootPublicKey, bundle); return bundle;
  }
  private async listing(declaration: RegistryDeclaration, key: string): Promise<RegistryPublicPackage> {
    const name = parsePackageName(key); const answer = await this.reach(() => this.source.package(declaration.registry, name.publisher, name.name));
    if (answer === undefined) throw new RegistryPluginError('not_found', `${key} is not published on ${declaration.registry}`);
    let listing: RegistryPublicPackage; try { listing = parseComponent('RegistryPublicPackage', answer as RegistryPublicPackage); } catch { throw new RegistryPluginError('unavailable', 'The registry returned an invalid package listing. Nothing was changed'); }
    if (listing.publisher !== name.publisher || listing.name !== name.name) throw new RegistryPluginError('untrusted', `The registry answered for another package than ${key}`, { category: 'wrong_package' });
    return listing;
  }

  /** The newest version in range that this host can load, or the reason there is none. */
  private choose(key: string, range: string, listing: RegistryPublicPackage): RegistryPublicVersion {
    const inRange = listing.versions.filter(item => satisfies(item.version, range));
    const forTarget = inRange.filter(item => item.target === this.host.target);
    const live = forTarget.filter(item => item.state === 'published' && !item.yanked);
    // The plugin must have been built against this ABI generation, and must not need functions newer than the host has.
    const loadable = live.filter(item => item.manifest.abiMajor === this.host.abiMajor && item.manifest.abiMinor <= this.host.abiMinor);
    if (loadable.length) return loadable.sort((a, b) => compareVersions(b.version, a.version))[0]!;
    const why = !inRange.length ? `no version matches ${range}` : !forTarget.length ? `no version matching ${range} is built for ${this.host.target}`
      : !live.length ? `every version matching ${range} has been yanked or revoked`
      : `every version matching ${range} needs plugin ABI ${[...new Set(live.map(item => `${item.manifest.abiMajor}.${item.manifest.abiMinor}`))].join(', ')}, and this toolchain provides ${this.host.abiMajor}.${this.host.abiMinor}`;
    throw new RegistryPluginError('no_compatible_version', `${key}: ${why}`);
  }

  /** Bytes for one locked target, verified. From the cache when they are there; from Registry otherwise. */
  private async verified(declaration: RegistryDeclaration, trust: RegistryTrustBundle, minimumSequence: number, key: string, version: RegistryPublicVersion, offline: boolean): Promise<readonly ArchiveFile[]> {
    const name = parsePackageName(key); const statement = version.signed.statement; const expected = { ...name, version: version.version, target: version.target };
    let bytes = this.cache.archive(statement.sha256); const cached = !!bytes;
    if (!bytes) {
      if (offline) throw new RegistryPluginError('not_cached', `${key} ${version.version} is not in the local cache, and --offline was given. Nothing was changed`);
      bytes = await this.reach(() => this.source.archive(declaration.registry, name.publisher, name.name, version.version, version.target));
      if (!bytes) throw new RegistryPluginError('not_found', `${key} ${version.version} for ${version.target} can no longer be downloaded from ${declaration.registry}`);
    }
    try { verifyRegistryPackage({ rootPublicKey: declaration.rootPublicKey, trust, minimumSequence, expected, version, bytes }); } catch (error) { this.untrusted(error, `${key} ${version.version}`); }
    // The same inspection Registry made before publishing, made again here: only files that pass it are written.
    const archive = readArchive(bytes, expected, version.manifest);
    if (!archive.ok) throw new RegistryPluginError('untrusted', `${key} ${version.version} failed inspection (${archive.category}). Nothing was installed`, { category: archive.category });
    if (!cached) this.cache.putArchive(statement.sha256, bytes);
    return archive.files;
  }

  private stage(lock: RegistryLock, key: string, target: RegistryTarget, entry: LockedTarget, files: readonly ArchiveFile[]): void {
    const provenance: Provenance = { signed: entry.signed, trustSequence: lock.trustSequence, registry: lock.registry, files: files.map(file => ({ path: file.path, sha256: sha256(file.bytes) })) };
    this.project.replaceDirectory(installPath(key, target), [...files, { path: PROVENANCE_FILE, bytes: new TextEncoder().encode(`${JSON.stringify(provenance, null, 2)}\n`) }]);
  }
  /** Whether what is on disk is exactly what the lock names, file for file. */
  private intact(key: string, target: RegistryTarget, entry: LockedTarget): boolean {
    const directory = installPath(key, target); const text = this.project.read(`${directory}/${PROVENANCE_FILE}`); if (text === undefined) return false;
    let provenance: Provenance; try { provenance = JSON.parse(text); } catch { return false; }
    if (provenance?.signed?.statement?.sha256 !== entry.signed.statement.sha256 || provenance.signed.signature !== entry.signed.signature || !Array.isArray(provenance.files)) return false;
    return provenance.files.every(file => { const bytes = this.project.readBytes(`${directory}/${file.path}`); return !!bytes && sha256(bytes) === file.sha256; });
  }

  // ── Commands ─────────────────────────────────────────────────────────────

  /**
   * Resolves one package to an exact version, verifies it, and records it. `approve` lists the capabilities a
   * person agreed to; a package that asks for any other stops here with nothing written.
   */
  private async resolve(declaration: RegistryDeclaration, lock: RegistryLock, trust: RegistryTrustBundle, key: string, range: string, approve: readonly string[] | 'all'): Promise<{ entry: LockedPlugin; files: readonly ArchiveFile[]; chosen: RegistryPublicVersion }> {
    const chosen = this.choose(key, range, await this.listing(declaration, key)); const asked = capabilitiesOf(chosen); const before = lock.plugins[key]?.approvedCapabilities ?? [];
    const approved = approve === 'all' ? asked : [...new Set([...before, ...approve])]; const missing = asked.filter(item => !approved.includes(item));
    if (missing.length) throw new RegistryPluginError('approval_required', `${key} ${chosen.version} asks for capabilities that have not been approved: ${missing.join(', ')}. Review them, then repeat with --approve ${missing.join(',')}`, { capabilities: missing, version: chosen.version });
    const files = await this.verified(declaration, trust, lock.trustSequence, key, chosen, false);
    // Only what this version asks for stays approved: a later version that asks again must be approved again.
    // Entries another machine locked for its own target are kept while the version is the same.
    const others = lock.plugins[key]?.version === chosen.version ? lock.plugins[key]!.targets : {};
    return { chosen, files, entry: { range, version: chosen.version, approvedCapabilities: asked, targets: { ...others, [chosen.target]: { signed: chosen.signed, manifest: chosen.manifest } } } };
  }

  async add(spec: string, approve: readonly string[] | 'all' = []): Promise<ChangeReport> {
    const declaration = this.declaration(); const lock = this.lock(declaration); const parsed = parsePackageSpec(spec); const key = `${parsed.publisher}/${parsed.name}`;
    const trust = await this.trust(declaration, lock); const listing = parsed.range === undefined ? await this.listing(declaration, key) : undefined;
    // Without a range, the newest loadable release is found first and the range becomes "compatible with that".
    const range = parsed.range ?? `^${this.choose(key, '*', listing!).version}`;
    const resolved = await this.resolve(declaration, lock, trust, key, range, approve);
    const next: RegistryLock = { ...lock, trustSequence: Math.max(lock.trustSequence, trust.bundle.sequence), plugins: { ...lock.plugins, [key]: resolved.entry } };
    // The declaration, then the lock, then the files. Interrupted after the first, `update` finishes; after the second, `install` does.
    this.project.write(DECLARATION_PATH, serialize({ ...declaration, plugins: { ...declaration.plugins, [key]: range } })); this.project.write(LOCK_PATH, serialize(next));
    this.stage(next, key, resolved.chosen.target, resolved.entry.targets[resolved.chosen.target]!, resolved.files);
    return { name: key, from: lock.plugins[key]?.version, to: resolved.entry.version, capabilities: resolved.entry.approvedCapabilities };
  }

  /** Moves locked packages to the newest version their declared range allows. With no name, all of them. */
  async update(name?: string, approve: readonly string[] | 'all' = []): Promise<readonly ChangeReport[]> {
    const declaration = this.declaration(); const lock = this.lock(declaration);
    if (name !== undefined) { parsePackageName(name); if (!(name in declaration.plugins)) throw new RegistryPluginError('not_declared', `${name} is not declared in ${DECLARATION_PATH}`); }
    const trust = await this.trust(declaration, lock); const reports: ChangeReport[] = []; let plugins = { ...lock.plugins }; const staged: (() => void)[] = [];
    let next: RegistryLock = { ...lock, trustSequence: Math.max(lock.trustSequence, trust.bundle.sequence) };
    // Everything is resolved and verified before anything is written: one package that cannot update stops them all.
    for (const key of name !== undefined ? [name] : Object.keys(declaration.plugins).sort()) {
      const resolved = await this.resolve(declaration, lock, trust, key, declaration.plugins[key]!, approve);
      const same = lock.plugins[key]?.version === resolved.entry.version && lock.plugins[key]?.range === resolved.entry.range && !!lock.plugins[key]?.targets[resolved.chosen.target];
      if (same) continue;
      plugins = { ...plugins, [key]: resolved.entry }; reports.push({ name: key, from: lock.plugins[key]?.version, to: resolved.entry.version, capabilities: resolved.entry.approvedCapabilities });
      staged.push(() => this.stage(next, key, resolved.chosen.target, resolved.entry.targets[resolved.chosen.target]!, resolved.files));
    }
    next = { ...next, plugins };
    if (reports.length || next.trustSequence !== lock.trustSequence) this.project.write(LOCK_PATH, serialize(next));
    for (const work of staged) work();
    return reports;
  }

  remove(name: string): ChangeReport {
    const declaration = this.declaration(); const lock = this.lock(declaration); parsePackageName(name);
    if (!(name in declaration.plugins) && !(name in lock.plugins)) throw new RegistryPluginError('not_declared', `${name} is not declared in ${DECLARATION_PATH}`);
    const { [name]: _declared, ...declared } = declaration.plugins; const { [name]: locked, ...remaining } = lock.plugins;
    this.project.write(DECLARATION_PATH, serialize({ ...declaration, plugins: declared })); this.project.write(LOCK_PATH, serialize({ ...lock, plugins: remaining }));
    this.project.removeDirectory(`${INSTALL_ROOT}/${name}`);
    return { name, from: locked?.version, to: undefined, capabilities: [] };
  }

  /**
   * Makes the disk match the lock, for this host's target. It never resolves a version and never writes the lock:
   * a declaration the lock does not answer for is an error, not something to fix quietly. Offline, it needs the
   * archives and a trust bundle from an earlier install on this machine.
   */
  async install(options: { readonly offline?: boolean } = {}): Promise<InstallReport> {
    const declaration = this.declaration(); const lock = this.lock(declaration); const offline = options.offline ?? false;
    for (const [key, range] of Object.entries(declaration.plugins)) {
      const entry = lock.plugins[key];
      if (!entry || entry.range !== range) throw new RegistryPluginError('lock_out_of_date', `${LOCK_PATH} does not answer for ${key}@${range}. Run: carbon plugin registry update ${key}`);
      if (!entry.targets[this.host.target]) throw new RegistryPluginError('lock_out_of_date', `${LOCK_PATH} has no ${this.host.target} entry for ${key}. Run: carbon plugin registry update ${key}`);
    }
    for (const key of Object.keys(lock.plugins)) if (!(key in declaration.plugins)) throw new RegistryPluginError('lock_out_of_date', `${LOCK_PATH} holds ${key}, which ${DECLARATION_PATH} does not declare. Run: carbon plugin registry remove ${key}`);
    const wanted = Object.entries(lock.plugins).map(([key, entry]) => ({ key, entry, target: entry.targets[this.host.target]! }));
    const pending = wanted.filter(item => !this.intact(item.key, this.host.target, item.target)); const work: (() => void)[] = [];
    if (pending.length) {
      let trust: RegistryTrustBundle;
      if (offline) {
        const cached = this.cache.trust(declaration.rootPublicKey);
        if (cached === undefined) throw new RegistryPluginError('not_cached', 'There is no cached trust bundle for this root key, and --offline was given. Nothing was changed');
        try { verifyTrustBundle(declaration.rootPublicKey, cached as RegistryTrustBundle, lock.trustSequence); } catch (error) { this.untrusted(error, 'The cached trust bundle'); }
        trust = cached as RegistryTrustBundle;
      } else trust = await this.trust(declaration, lock);
      for (const item of pending) {
        let version: RegistryPublicVersion = { version: item.entry.version, target: this.host.target, state: 'published', yanked: false, reason: null, signed: item.target.signed, manifest: item.target.manifest };
        if (!offline) {
          // Online, Registry is asked what it says about this exact version now. A revocation stops the install.
          const listed = (await this.listing(declaration, item.key)).versions.find(candidate => candidate.version === item.entry.version && candidate.target === this.host.target);
          if (!listed) throw new RegistryPluginError('not_found', `${item.key} ${item.entry.version} is no longer listed on ${declaration.registry}`);
          if (listed.state === 'revoked') throw new RegistryPluginError('revoked', `${item.key} ${item.entry.version} was revoked: ${listed.reason ?? 'no reason given'}. Run: carbon plugin registry update ${item.key}`, { reason: listed.reason });
          // A published version is immutable. A different statement for the locked version is not the locked version.
          if (listed.signed.statement.sha256 !== item.target.signed.statement.sha256) throw new RegistryPluginError('untrusted', `${item.key} ${item.entry.version} on the registry is not the version in ${LOCK_PATH}. Nothing was installed`, { category: 'changed' });
          version = { ...version, yanked: listed.yanked, reason: listed.reason };
        }
        const files = await this.verified(declaration, trust, lock.trustSequence, item.key, version, offline);
        work.push(() => this.stage(lock, item.key, this.host.target, item.target, files));
      }
    }
    // Everything verified; only now is anything written.
    for (const step of work) step();
    const removed: string[] = [];
    for (const path of this.project.directories(INSTALL_ROOT, 3)) {
      const [publisher, name, target] = path.split('/'); const key = `${publisher}/${name}`;
      if (!lock.plugins[key]?.targets[target as RegistryTarget]) { this.project.removeDirectory(`${INSTALL_ROOT}/${path}`); removed.push(`${key} (${target})`); }
    }
    return { installed: pending.map(item => item.key), unchanged: wanted.filter(item => !pending.includes(item)).map(item => item.key), removed };
  }

  /** Asks Registry about every locked version, and checks every installed file. Changes nothing. */
  async audit(): Promise<readonly AuditFinding[]> {
    const declaration = this.declaration(); const lock = this.lock(declaration); const findings: AuditFinding[] = [];
    await this.trust(declaration, lock);
    for (const [key, entry] of Object.entries(lock.plugins).sort(([a], [b]) => (a < b ? -1 : 1))) {
      const target = entry.targets[this.host.target]; if (!target) continue;
      let listed: RegistryPublicVersion | undefined;
      try { listed = (await this.listing(declaration, key)).versions.find(candidate => candidate.version === entry.version && candidate.target === this.host.target); }
      catch (error) { if (!(error instanceof RegistryPluginError) || error.code !== 'not_found') throw error; }
      if (!listed) findings.push({ name: key, version: entry.version, problem: 'withdrawn', reason: null });
      else if (listed.state === 'revoked') findings.push({ name: key, version: entry.version, problem: 'revoked', reason: listed.reason });
      else if (listed.signed.statement.sha256 !== target.signed.statement.sha256 || listed.signed.signature !== target.signed.signature) findings.push({ name: key, version: entry.version, problem: 'changed', reason: null });
      else if (listed.yanked) findings.push({ name: key, version: entry.version, problem: 'yanked', reason: listed.reason });
      if (this.project.read(`${installPath(key, this.host.target)}/${PROVENANCE_FILE}`) === undefined) findings.push({ name: key, version: entry.version, problem: 'not_installed', reason: null });
      else if (!this.intact(key, this.host.target, target)) findings.push({ name: key, version: entry.version, problem: 'modified', reason: null });
    }
    return findings;
  }

  list(): readonly { readonly name: string; readonly range: string; readonly version: string | undefined; readonly installed: boolean; readonly capabilities: readonly string[] }[] {
    const declaration = this.declaration(); const lock = this.lock(declaration);
    return Object.entries(declaration.plugins).sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, range]) => {
      const entry = lock.plugins[name]; const target = entry?.targets[this.host.target];
      return { name, range, version: entry?.version, installed: !!target && this.intact(name, this.host.target, target), capabilities: entry?.approvedCapabilities ?? [] };
    });
  }
}

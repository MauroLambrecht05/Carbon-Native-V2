import { afterEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DECLARATION_PATH, INSTALL_ROOT, LOCK_PATH, NodePackageCache, NodePluginProject, PROVENANCE_FILE, RegistryPluginError, RegistryPlugins, RegistrySigner, compareVersions, parseDeclaration, parseLock, parsePackageSpec, publicKeyHex,
  satisfies, serialize, signTrustBundle, type PluginHost, type PluginProject } from '../index.ts';
import { FakeRegistry, fakeLibrary } from './registry-fixture.ts';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
const host: PluginHost = { target: 'x86_64-pc-windows-msvc', abiMajor: 1, abiMinor: 23 };
const text = (value: string) => new TextEncoder().encode(value);

/** A project directory, a cache directory and the commands over them, against one fake Registry. */
function setup(registry = new FakeRegistry(), options: { project?: string; cache?: string; host?: PluginHost; wrap?: (project: PluginProject) => PluginProject } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'carbon-registry-consumption-')); roots.push(root);
  const project = options.project ?? join(root, 'project'); const cache = options.cache ?? join(root, 'cache'); mkdirSync(project, { recursive: true });
  const disk = new NodePluginProject(project);
  const plugins = new RegistryPlugins(options.wrap ? options.wrap(disk) : disk, registry, new NodePackageCache(cache), options.host ?? host);
  const read = (path: string) => (existsSync(join(project, path)) ? readFileSync(join(project, path), 'utf8') : undefined);
  const installed = (name: string, target = host.target) => { const directory = join(project, INSTALL_ROOT, name, target); return existsSync(directory) ? readdirSync(directory).sort() : undefined; };
  return { registry, project, cache, plugins, read, installed, lock: () => parseLock(read(LOCK_PATH)!), declaration: () => parseDeclaration(read(DECLARATION_PATH)!), init: () => plugins.init(registry.origin, registry.rootPublicKey) };
}
const refusal = async (work: Promise<unknown> | (() => unknown)) => {
  try { await (typeof work === 'function' ? work() : work); return 'accepted'; }
  catch (error) { if (error instanceof RegistryPluginError) return error.details.category ? `${error.code}:${error.details.category}` : error.code; throw error; }
};
/** Everything a command could have written, as one value to compare before and after a refusal. */
const snapshot = (s: ReturnType<typeof setup>) => JSON.stringify([s.read(DECLARATION_PATH), s.read(LOCK_PATH), existsSync(join(s.project, INSTALL_ROOT)) ? readdirSync(join(s.project, INSTALL_ROOT), { recursive: true }).map(String).sort() : []]);

describe('versions and ranges', () => {
  test('versions order by semantic-version precedence', () => {
    const ordered = ['0.9.0', '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.1', '1.2.0', '1.10.0', '2.0.0'];
    expect([...ordered].reverse().sort(compareVersions)).toEqual(ordered); expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
  });
  test('a range admits exactly the versions it says, and never drifts onto a pre-release', async () => {
    const inside = (range: string) => ['0.0.3', '0.0.4', '0.2.3', '0.2.9', '0.3.0', '1.2.2', '1.2.3', '1.2.9', '1.3.0', '1.9.0', '2.0.0', '2.0.0-rc.1', '1.3.0-beta.1'].filter(version => satisfies(version, range));
    expect(inside('^1.2.3')).toEqual(['1.2.3', '1.2.9', '1.3.0', '1.9.0']); expect(inside('~1.2.3')).toEqual(['1.2.3', '1.2.9']); expect(inside('1.2.3')).toEqual(['1.2.3']);
    // Below 1.0, a minor change is a breaking change; below 0.1, every change is.
    expect(inside('^0.2.3')).toEqual(['0.2.3', '0.2.9']); expect(inside('^0.0.3')).toEqual(['0.0.3']);
    expect(inside('*')).toEqual(['0.0.3', '0.0.4', '0.2.3', '0.2.9', '0.3.0', '1.2.2', '1.2.3', '1.2.9', '1.3.0', '1.9.0', '2.0.0']);
    // A pre-release is chosen only by naming it.
    expect(inside('2.0.0-rc.1')).toEqual(['2.0.0-rc.1']); expect(inside('^2.0.0-rc.1')).toEqual(['2.0.0']);
    for (const bad of ['', 'latest', '>=1.0.0', '1.2', '^1.2', '1.2.3 || 2.0.0', 'v1.2.3']) expect(satisfies('1.2.3', bad)).toBe(false);
    expect(parsePackageSpec('acme/clipboard@^1.2.0')).toEqual({ publisher: 'acme', name: 'clipboard', range: '^1.2.0' }); expect(parsePackageSpec('acme/clipboard').range).toBeUndefined();
    for (const bad of ['clipboard', 'acme/clipboard@latest', 'Acme/clipboard', 'acme/clip/board', '../clipboard', 'acme/']) expect(await refusal(() => parsePackageSpec(bad))).toBe('invalid_file');
  });
});

describe('the declaration and the lock', () => {
  test('a declaration names one registry, one pinned root key and ranges, and nothing else', async () => {
    const good = { registry: 'https://registry.example.test', rootPublicKey: 'a'.repeat(64), plugins: { 'acme/clipboard': '^1.2.0' } };
    expect(parseDeclaration(JSON.stringify(good))).toEqual(good); expect(parseDeclaration(JSON.stringify({ ...good, registry: 'http://127.0.0.1:54323' })).registry).toBe('http://127.0.0.1:54323');
    for (const bad of ['{ not json', JSON.stringify({ ...good, extra: true }), JSON.stringify({ ...good, registry: 'http://registry.example.test' }), JSON.stringify({ ...good, registry: 'https://user:pass@registry.example.test' }),
      JSON.stringify({ ...good, registry: 'https://registry.example.test/path' }), JSON.stringify({ ...good, rootPublicKey: 'short' }), JSON.stringify({ ...good, rootPublicKey: 'A'.repeat(64) }), JSON.stringify({ ...good, plugins: { 'acme/clipboard': 'latest' } }),
      JSON.stringify({ ...good, plugins: { clipboard: '1.0.0' } }), JSON.stringify({ ...good, plugins: [] }), JSON.stringify([good])]) expect(await refusal(() => parseDeclaration(bad))).toBe('invalid_file');
  });

  test('a lock entry can only be for the package, version and target it is filed under, and the same content is always the same file', async () => {
    const s = setup(); s.registry.publish('acme/clipboard', '1.2.0'); s.init(); await s.plugins.add('acme/clipboard'); const lock = s.lock(); const raw = JSON.parse(s.read(LOCK_PATH)!);
    expect(serialize(lock)).toBe(s.read(LOCK_PATH)!);
    // Key order in memory does not reach the file.
    expect(serialize({ plugins: lock.plugins, trustSequence: lock.trustSequence, registry: lock.registry, lockVersion: 1 })).toBe(s.read(LOCK_PATH)!);
    const edit = (change: (value: any) => void) => { const copy = structuredClone(raw); change(copy); return JSON.stringify(copy); };
    for (const bad of [edit(v => { v.lockVersion = 2; }), edit(v => { v.trustSequence = -1; }), edit(v => { v.plugins['acme/clipboard'].version = '1.2.1'; }), edit(v => { v.plugins['acme/keychain'] = v.plugins['acme/clipboard']; }),
      edit(v => { v.plugins['acme/clipboard'].targets['aarch64-pc-windows-msvc'] = v.plugins['acme/clipboard'].targets[host.target]; }), edit(v => { v.plugins['acme/clipboard'].targets = {}; }),
      edit(v => { v.plugins['acme/clipboard'].targets[host.target].signed.signature = 'x'; }), edit(v => { delete v.plugins['acme/clipboard'].approvedCapabilities; }), edit(v => { v.registry = 'ftp://registry.example.test'; }), '{']) {
      expect(await refusal(() => parseLock(bad))).toBe('invalid_file');
    }
  });
});

describe('installing from Registry', () => {
  test('add resolves the newest version this host can load, verifies it, and writes the declaration, the lock and the files', async () => {
    const s = setup(); const key = 'acme/clipboard';
    expect(await refusal(s.plugins.add(key))).toBe('not_configured'); expect(s.init().plugins).toEqual({});
    for (const version of ['1.0.0', '1.2.0', '1.2.1']) s.registry.publish(key, version);
    s.registry.publish(key, '2.0.0-beta.1'); s.registry.publish(key, '1.3.0', { abiMinor: 99 }); s.registry.publish(key, '3.0.0', { abiMajor: 2 }); s.registry.publish(key, '1.4.0', { target: 'x86_64-unknown-linux-gnu' });
    s.registry.publish(key, '1.2.2', { yanked: true, reason: 'bad build' }); s.registry.publish(key, '1.2.3', { state: 'revoked', reason: 'malware' });
    // Newer versions exist, but each is a pre-release, needs a newer ABI, is for another target, is yanked or is revoked.
    expect(await s.plugins.add(key)).toEqual({ name: key, from: undefined, to: '1.2.1', capabilities: [] });
    expect(s.declaration().plugins).toEqual({ [key]: '^1.2.1' });
    const entry = s.lock().plugins[key]!; const listed = s.registry.versions.get(key)!.find(item => item.version === '1.2.1')!;
    expect(entry).toEqual({ range: '^1.2.1', version: '1.2.1', approvedCapabilities: [], targets: { [host.target]: { signed: listed.signed, manifest: listed.manifest } } }); expect(s.lock().trustSequence).toBe(3);
    expect(s.installed(key)).toEqual([PROVENANCE_FILE, 'README.md', 'carbon-plugin.json', 'clipboard.dll']);
    expect(Buffer.from(readFileSync(join(s.project, INSTALL_ROOT, key, host.target, 'clipboard.dll'))).equals(Buffer.from(fakeLibrary(host.target)))).toBe(true);
    expect(JSON.parse(readFileSync(join(s.project, INSTALL_ROOT, key, host.target, PROVENANCE_FILE), 'utf8'))).toMatchObject({ signed: listed.signed, trustSequence: 3, registry: s.registry.origin });
    expect(s.plugins.list()).toEqual([{ name: key, range: '^1.2.1', version: '1.2.1', installed: true, capabilities: [] }]);
    // An explicit range is kept as written, and an exact pre-release can be asked for by name.
    await s.plugins.add(`${key}@~1.2.0`); expect(s.declaration().plugins[key]).toBe('~1.2.0'); expect(s.lock().plugins[key]!.version).toBe('1.2.1');
    await s.plugins.add(`${key}@2.0.0-beta.1`); expect(s.lock().plugins[key]!.version).toBe('2.0.0-beta.1');
    // The trust root, once recorded, is not changed by a command.
    expect(await refusal(() => s.plugins.init(s.registry.origin, publicKeyHex(randomBytes(32).toString('hex'))))).toBe('invalid_file'); expect(await refusal(() => s.plugins.init('https://other.example.test', s.registry.rootPublicKey))).toBe('invalid_file');
    expect(s.plugins.init(s.registry.origin, s.registry.rootPublicKey).plugins).toEqual({ [key]: '2.0.0-beta.1' });
  });

  test('when nothing can be installed the reason is exact, and nothing is written', async () => {
    const s = setup(); s.init(); const key = 'acme/clipboard'; const before = snapshot(s);
    const message = async (range: string) => { try { await s.plugins.add(`${key}@${range}`); return 'accepted'; } catch (error) { return (error as RegistryPluginError).code === 'no_compatible_version' ? (error as Error).message : String(error); } };
    expect(await refusal(s.plugins.add(key))).toBe('not_found');
    s.registry.publish(key, '1.0.0'); s.registry.publish(key, '2.0.0', { target: 'aarch64-apple-darwin' }); s.registry.publish(key, '3.0.0', { yanked: true }); s.registry.publish(key, '3.0.1', { state: 'revoked', reason: 'malware' });
    s.registry.publish(key, '4.0.0', { abiMinor: 24 }); s.registry.publish(key, '5.0.0', { abiMajor: 2, abiMinor: 0 });
    expect(await message('^9.0.0')).toBe(`${key}: no version matches ^9.0.0`);
    expect(await message('^2.0.0')).toBe(`${key}: no version matching ^2.0.0 is built for ${host.target}`);
    expect(await message('^3.0.0')).toBe(`${key}: every version matching ^3.0.0 has been yanked or revoked`);
    expect(await message('^4.0.0')).toBe(`${key}: every version matching ^4.0.0 needs plugin ABI 1.24, and this toolchain provides 1.23`);
    expect(await message('^5.0.0')).toBe(`${key}: every version matching ^5.0.0 needs plugin ABI 2.0, and this toolchain provides 1.23`);
    expect(snapshot(s)).toBe(before);
    // An older ABI minor of the same major loads; the exact host minor loads.
    s.registry.publish(key, '4.1.0', { abiMinor: 23 }); expect((await s.plugins.add(`${key}@^4.0.0`)).to).toBe('4.1.0');
  });

  test('capabilities a package asks for must be approved by name, and a later version that asks for more must be approved again', async () => {
    const s = setup(); s.init(); const key = 'acme/clipboard'; s.registry.publish(key, '1.0.0', { required: ['clipboard.read'], optional: ['clipboard.write'] }); const before = snapshot(s);
    const asked = async (work: Promise<unknown>) => { try { await work; return 'accepted'; } catch (error) { return (error as RegistryPluginError).code === 'approval_required' ? (error as RegistryPluginError).details.capabilities : String(error); } };
    expect(await asked(s.plugins.add(key))).toEqual(['clipboard.read', 'clipboard.write']); expect(await asked(s.plugins.add(key, ['clipboard.read']))).toEqual(['clipboard.write']);
    expect(snapshot(s)).toBe(before);
    expect((await s.plugins.add(key, ['clipboard.read', 'clipboard.write', 'unrelated.thing'])).capabilities).toEqual(['clipboard.read', 'clipboard.write']);
    // Only what this version asks for is recorded as approved.
    expect(s.lock().plugins[key]!.approvedCapabilities).toEqual(['clipboard.read', 'clipboard.write']);
    // The next version asks for the network as well: updating stops until someone agrees, and changes nothing meanwhile.
    s.registry.publish(key, '1.1.0', { required: ['clipboard.read', 'net.connect'] }); const locked = snapshot(s);
    expect(await asked(s.plugins.update())).toEqual(['net.connect']); expect(await asked(s.plugins.update(key, ['fs.read']))).toEqual(['net.connect']); expect(snapshot(s)).toBe(locked);
    expect(await s.plugins.update(key, ['net.connect'])).toEqual([{ name: key, from: '1.0.0', to: '1.1.0', capabilities: ['clipboard.read', 'net.connect'] }]);
    // What an earlier version was allowed is not carried to a version that no longer asks for it, so it cannot come back unasked.
    expect(s.lock().plugins[key]!.approvedCapabilities).toEqual(['clipboard.read', 'net.connect']);
    s.registry.publish(key, '1.2.0', { required: ['clipboard.read', 'clipboard.write'] }); expect(await asked(s.plugins.update())).toEqual(['clipboard.write']);
    expect((await s.plugins.update(undefined, 'all'))[0]).toMatchObject({ to: '1.2.0' });
  });

  test('install makes a fresh checkout match the lock exactly, without resolving anything, and repeats as a no-op', async () => {
    const author = setup(); author.init(); const key = 'acme/clipboard'; author.registry.publish(key, '1.2.0'); await author.plugins.add(key);
    // A newer version appears afterwards. A build from the committed lock does not move to it.
    author.registry.publish(key, '1.2.1');
    const fresh = setup(author.registry); cpSync(join(author.project, 'carbon', 'registry.json'), join(fresh.project, 'carbon', 'registry.json'), { recursive: true }); cpSync(join(author.project, LOCK_PATH), join(fresh.project, LOCK_PATH));
    const lockBefore = fresh.read(LOCK_PATH); author.registry.requests.length = 0;
    expect(await fresh.plugins.install()).toEqual({ installed: [key], unchanged: [], removed: [] });
    expect(author.registry.requests).toEqual(['trust', `package ${key}`, `archive ${key}@1.2.0`]); expect(fresh.read(LOCK_PATH)).toBe(lockBefore);
    for (const file of ['README.md', 'carbon-plugin.json', 'clipboard.dll']) expect(readFileSync(join(fresh.project, INSTALL_ROOT, key, host.target, file)).equals(readFileSync(join(author.project, INSTALL_ROOT, key, host.target, file)))).toBe(true);
    // Again: nothing to do, and nothing asked of the network.
    author.registry.requests.length = 0; expect(await fresh.plugins.install()).toEqual({ installed: [], unchanged: [key], removed: [] }); expect(author.registry.requests).toEqual([]);

    // The lock moves under an existing install, as after pulling a colleague's update: install brings the files to the new version.
    await author.plugins.update(key); cpSync(join(author.project, LOCK_PATH), join(fresh.project, LOCK_PATH)); expect(fresh.plugins.list()[0]).toMatchObject({ version: '1.2.1', installed: false });
    expect((await fresh.plugins.install()).installed).toEqual([key]); expect(readFileSync(join(fresh.project, INSTALL_ROOT, key, host.target, 'README.md'), 'utf8')).toBe('# clipboard 1.2.1\n');
    // Directories the lock does not name are removed; a file changed on disk is put back.
    mkdirSync(join(fresh.project, INSTALL_ROOT, 'acme', 'stale', host.target), { recursive: true }); writeFileSync(join(fresh.project, INSTALL_ROOT, 'acme', 'stale', host.target, 'stale.dll'), 'x');
    mkdirSync(join(fresh.project, INSTALL_ROOT, 'acme', 'clipboard', 'aarch64-apple-darwin'), { recursive: true });
    writeFileSync(join(fresh.project, INSTALL_ROOT, key, host.target, 'clipboard.dll'), 'patched');
    expect(fresh.plugins.list()[0]!.installed).toBe(false);
    expect(await fresh.plugins.install()).toEqual({ installed: [key], unchanged: [], removed: ['acme/clipboard (aarch64-apple-darwin)', `acme/stale (${host.target})`] });
    expect(Buffer.from(readFileSync(join(fresh.project, INSTALL_ROOT, key, host.target, 'clipboard.dll'))).equals(Buffer.from(fakeLibrary(host.target)))).toBe(true); expect(existsSync(join(fresh.project, INSTALL_ROOT, 'acme', 'stale'))).toBe(false);
    // A deleted file, and a deleted provenance record, each count as not installed.
    rmSync(join(fresh.project, INSTALL_ROOT, key, host.target, 'README.md')); expect((await fresh.plugins.install()).installed).toEqual([key]);
    rmSync(join(fresh.project, INSTALL_ROOT, key, host.target, PROVENANCE_FILE)); expect((await fresh.plugins.install()).installed).toEqual([key]);
  });

  test('a declaration the lock does not answer for is an error, not something install fixes quietly', async () => {
    const s = setup(); s.init(); const key = 'acme/clipboard'; s.registry.publish(key, '1.2.0'); s.registry.publish('acme/keychain', '1.0.0'); await s.plugins.add(key);
    const declaration = s.declaration(); const lock = s.lock(); const write = (path: string, value: unknown) => writeFileSync(join(s.project, path), serialize(value as never));
    // Someone edited the range, declared a package by hand, or removed one by hand.
    write(DECLARATION_PATH, { ...declaration, plugins: { [key]: '^2.0.0' } }); expect(await refusal(s.plugins.install())).toBe('lock_out_of_date');
    write(DECLARATION_PATH, { ...declaration, plugins: { ...declaration.plugins, 'acme/keychain': '^1.0.0' } }); expect(await refusal(s.plugins.install())).toBe('lock_out_of_date');
    write(DECLARATION_PATH, { ...declaration, plugins: {} }); expect(await refusal(s.plugins.install())).toBe('lock_out_of_date');
    // The lock was made for another Registry.
    write(DECLARATION_PATH, { ...declaration, registry: 'https://other.example.test' }); expect(await refusal(s.plugins.install())).toBe('lock_out_of_date');
    write(DECLARATION_PATH, declaration);
    // This machine's target was never locked.
    const mac = setup(s.registry, { project: s.project, host: { ...host, target: 'aarch64-apple-darwin' } }); expect(await refusal(mac.plugins.install())).toBe('lock_out_of_date');
    // `update` is what brings the lock back in line. It keeps the other machine's entry while the version is the same.
    s.registry.publish(key, '1.2.0', { target: 'aarch64-apple-darwin' }); expect(await mac.plugins.update(key)).toEqual([{ name: key, from: '1.2.0', to: '1.2.0', capabilities: [] }]);
    expect(Object.keys(s.lock().plugins[key]!.targets).sort()).toEqual(['aarch64-apple-darwin', host.target]); expect(s.lock().plugins[key]!.targets[host.target]).toEqual(lock.plugins[key]!.targets[host.target]);
    expect((await mac.plugins.install()).unchanged).toEqual([key]); expect((await s.plugins.install()).unchanged).toEqual([key]);
    expect(mac.installed(key, 'aarch64-apple-darwin')).toContain('libclipboard.dylib');
  });

  test('offline, install works from this machine\'s cache alone, and says exactly what is missing when it cannot', async () => {
    const author = setup(); author.init(); const key = 'acme/clipboard'; author.registry.publish(key, '1.2.0'); await author.plugins.add(key);
    const clone = (cache: string) => { const s = setup(author.registry, { cache }); mkdirSync(join(s.project, 'carbon')); cpSync(join(author.project, DECLARATION_PATH), join(s.project, DECLARATION_PATH)); cpSync(join(author.project, LOCK_PATH), join(s.project, LOCK_PATH)); return s; };
    // The network is gone. A checkout on the machine that installed before still installs, and asks the network for nothing.
    author.registry.down = true; author.registry.requests.length = 0;
    const warm = clone(author.cache); expect(await warm.plugins.install({ offline: true })).toEqual({ installed: [key], unchanged: [], removed: [] }); expect(author.registry.requests).toEqual([]);
    expect(warm.installed(key)).toContain('clipboard.dll');
    // Without --offline the same situation is a network failure, reported as one, with nothing written.
    const online = clone(author.cache); expect(await refusal(online.plugins.install())).toBe('unavailable'); expect(online.installed(key)).toBeUndefined();
    // A machine that never installed has nothing to install from.
    const cold = clone(join(author.cache, '..', 'empty-cache')); expect(await refusal(cold.plugins.install({ offline: true }))).toBe('not_cached'); expect(cold.installed(key)).toBeUndefined();
    const archive = join(author.cache, 'archives', readdirSync(join(author.cache, 'archives'))[0]!); const original = readFileSync(archive);
    // Offline means offline: with the network back but the archive gone from the cache, nothing is fetched.
    author.registry.down = false; rmSync(archive); author.registry.requests.length = 0; const partial = clone(author.cache);
    expect(await refusal(partial.plugins.install({ offline: true }))).toBe('not_cached'); expect(author.registry.requests).toEqual([]); expect(partial.installed(key)).toBeUndefined(); writeFileSync(archive, original); author.registry.down = true;
    // The cache is not trusted either: a cached archive that was changed is refused, and so is a cached bundle from another root.
    const changed = Buffer.from(original); changed[changed.length - 1]! ^= 1; writeFileSync(archive, changed);
    const poisoned = clone(author.cache); expect(await refusal(poisoned.plugins.install({ offline: true }))).toBe('untrusted:digest'); expect(poisoned.installed(key)).toBeUndefined(); writeFileSync(archive, original);
    const bundle = join(author.cache, 'trust', `${author.registry.rootPublicKey}.json`); const good = readFileSync(bundle, 'utf8');
    writeFileSync(bundle, JSON.stringify(signTrustBundle(randomBytes(32).toString('hex'), author.registry.bundle.bundle))); expect(await refusal(clone(author.cache).plugins.install({ offline: true }))).toBe('untrusted:bundle_signature');
    // An older cached bundle than the lock has seen could bring a revoked key back.
    writeFileSync(bundle, JSON.stringify(signTrustBundle(author.registry.rootSeed, { ...author.registry.bundle.bundle, sequence: 2 }))); expect(await refusal(clone(author.cache).plugins.install({ offline: true }))).toBe('untrusted:bundle_rollback');
    writeFileSync(bundle, good); expect((await clone(author.cache).plugins.install({ offline: true })).installed).toEqual([key]);
    // Add, update and audit need Registry; offline they fail cleanly.
    expect(await refusal(author.plugins.update())).toBe('unavailable'); expect(await refusal(author.plugins.audit())).toBe('unavailable'); expect(await refusal(author.plugins.add('acme/keychain'))).toBe('unavailable');
  });

  test('nothing Registry answers is installed unless it checks out against the pinned root, the lock and the declared package', async () => {
    const key = 'acme/clipboard';
    const locked = async (prepare: (registry: FakeRegistry) => void = () => {}) => {
      const author = setup(); author.init(); author.registry.publish(key, '1.2.0'); await author.plugins.add(key);
      const s = setup(author.registry); mkdirSync(join(s.project, 'carbon')); cpSync(join(author.project, DECLARATION_PATH), join(s.project, DECLARATION_PATH)); cpSync(join(author.project, LOCK_PATH), join(s.project, LOCK_PATH));
      prepare(author.registry); return s;
    };
    const install = async (prepare: (registry: FakeRegistry) => void) => { const s = await locked(prepare); const result = await refusal(s.plugins.install()); expect(s.installed(key)).toBeUndefined(); return result; };
    const archiveKey = `${key}@1.2.0/${host.target}`;
    // Other bytes under the locked name: changed, truncated, or another package's archive.
    expect(await install(r => { const bytes = new Uint8Array(r.archives.get(archiveKey)!); bytes[20]! ^= 1; r.archives.set(archiveKey, bytes); })).toBe('untrusted:digest');
    expect(await install(r => { r.archives.set(archiveKey, r.archives.get(archiveKey)!.subarray(0, 100)); })).toBe('untrusted:digest');
    expect(await install(r => { r.publish('acme/keychain', '1.2.0'); r.archives.set(archiveKey, r.archives.get(`acme/keychain@1.2.0/${host.target}`)!); })).toBe('untrusted:digest');
    // The version was replaced on the Registry after it was locked: a different statement, even a validly signed one.
    expect(await install(r => { r.publish(key, '1.2.0', { extra: [{ path: 'new.txt', bytes: text('republished') }] }); })).toBe('untrusted:changed');
    // The trust bundle: signed by someone else, or older than this project has already accepted.
    expect(await install(r => { r.bundle = signTrustBundle(randomBytes(32).toString('hex'), r.bundle.bundle); })).toBe('untrusted:bundle_signature');
    expect(await install(r => { r.bundle = signTrustBundle(r.rootSeed, { ...r.bundle.bundle, sequence: 2 }); })).toBe('untrusted:bundle_rollback');
    // The key that signed the locked statement has since been revoked by the root.
    expect(await install(r => { r.bundle = signTrustBundle(r.rootSeed, { sequence: 4, issuedAt: '2026-10-12T08:00:00Z', keys: [{ id: r.signer.keyId, publicKey: r.signer.publicKeyHex, state: 'revoked' }] }); })).toBe('untrusted:key_revoked');
    // Registry answers for another package, answers with nonsense, or stops serving the archive.
    expect(await install(r => { r.versions.set(key, r.publish('acme/keychain', '1.2.0') && r.versions.get('acme/keychain')!); r.package = async () => ({ publisher: 'acme', name: 'keychain', versions: r.versions.get('acme/keychain') }); })).toBe('untrusted:wrong_package');
    expect(await install(r => { r.package = async () => ({ versions: 'yes' }); })).toBe('unavailable');
    expect(await install(r => { r.archives.delete(archiveKey); })).toBe('not_found'); expect(await install(r => { r.versions.set(key, []); })).toBe('not_found');
    expect(await install(r => { r.versions.delete(key); })).toBe('not_found');
    // Revoked after it was locked: the install stops and says why.
    const revoked = await locked(r => r.mark(key, '1.2.0', { state: 'revoked', reason: 'steals credentials' }));
    try { await revoked.plugins.install(); throw new Error('accepted'); } catch (error) { expect((error as RegistryPluginError).code).toBe('revoked'); expect((error as Error).message).toContain('steals credentials'); }
    expect(revoked.installed(key)).toBeUndefined();
    // Yanked after it was locked: it still installs, because the lock names it exactly.
    expect((await (await locked(r => r.mark(key, '1.2.0', { yanked: true, reason: 'superseded' }))).plugins.install()).installed).toEqual([key]);

    // The same holds when adding. A signature from a key the root never listed, or a correctly signed archive that fails inspection, installs nothing.
    const adding = async (prepare: (registry: FakeRegistry) => void) => { const s = setup(); s.init(); prepare(s.registry); const before = snapshot(s); const result = await refusal(s.plugins.add(key)); expect(snapshot(s)).toBe(before); return result; };
    expect(await adding(r => { r.publish(key, '1.0.0', { signer: new RegistrySigner('unlisted', randomBytes(32).toString('hex')) }); })).toBe('untrusted:key_unknown');
    expect(await adding(r => { r.publish(key, '1.0.0', { signer: new RegistrySigner(r.signer.keyId, randomBytes(32).toString('hex')) }); })).toBe('untrusted:signature');
    expect(await adding(r => { r.publish(key, '1.0.0', { extra: [{ path: 'tools/helper.exe', bytes: fakeLibrary(host.target) }] }); })).toBe('untrusted:archive.unexpected_executable');
    expect(await adding(r => { r.publish(key, '1.0.0'); r.bundle = signTrustBundle(randomBytes(32).toString('hex'), r.bundle.bundle); })).toBe('untrusted:bundle_signature');
    // A project pinned to another root trusts nothing this Registry says.
    const stranger = setup(); stranger.registry.publish(key, '1.0.0'); stranger.plugins.init(stranger.registry.origin, publicKeyHex(randomBytes(32).toString('hex'))); expect(await refusal(stranger.plugins.add(key))).toBe('untrusted:bundle_signature');
  });

  test('update moves every package together or none, remove takes a package away entirely, and audit reports what Registry now says', async () => {
    const s = setup(); s.init(); const [clip, keys] = ['acme/clipboard', 'acme/keychain']; s.registry.publish(clip, '1.2.0'); s.registry.publish(keys, '2.0.0'); await s.plugins.add(clip); await s.plugins.add(keys);
    expect(await s.plugins.update()).toEqual([]); expect(await s.plugins.audit()).toEqual([]);
    expect(await refusal(s.plugins.update('acme/unknown'))).toBe('not_declared'); expect(await refusal(() => s.plugins.remove('acme/unknown'))).toBe('not_declared');
    // Both have a newer version, but one of them now needs approval: neither moves.
    s.registry.publish(clip, '1.2.5'); s.registry.publish(keys, '2.1.0', { required: ['keychain.read'] }); s.registry.publish(clip, '2.0.0'); const before = snapshot(s);
    expect(await refusal(s.plugins.update())).toBe('approval_required'); expect(snapshot(s)).toBe(before);
    // One by name moves alone, inside its range: 2.0.0 is outside ^1.2.0.
    expect(await s.plugins.update(clip)).toEqual([{ name: clip, from: '1.2.0', to: '1.2.5', capabilities: [] }]); expect(s.lock().plugins[keys]!.version).toBe('2.0.0');
    expect(readFileSync(join(s.project, INSTALL_ROOT, clip, host.target, 'README.md'), 'utf8')).toBe('# clipboard 1.2.5\n');
    expect(await s.plugins.update(undefined, ['keychain.read'])).toEqual([{ name: keys, from: '2.0.0', to: '2.1.0', capabilities: ['keychain.read'] }]);
    // A trust bundle with a higher sequence is remembered, so an older one is refused from then on.
    s.registry.bundle = signTrustBundle(s.registry.rootSeed, { ...s.registry.bundle.bundle, sequence: 7 }); expect(await s.plugins.update()).toEqual([]); expect(s.lock().trustSequence).toBe(7);
    s.registry.bundle = signTrustBundle(s.registry.rootSeed, { ...s.registry.bundle.bundle, sequence: 6 }); expect(await refusal(s.plugins.update())).toBe('untrusted:bundle_rollback');
    s.registry.bundle = signTrustBundle(s.registry.rootSeed, { ...s.registry.bundle.bundle, sequence: 7 });

    // Audit: Registry's current word on each locked version, and the state of the files.
    s.registry.mark(clip, '1.2.5', { yanked: true, reason: 'superseded' }); s.registry.mark(keys, '2.1.0', { state: 'revoked', reason: 'steals credentials' });
    writeFileSync(join(s.project, INSTALL_ROOT, clip, host.target, 'clipboard.dll'), 'patched');
    expect(await s.plugins.audit()).toEqual([{ name: clip, version: '1.2.5', problem: 'yanked', reason: 'superseded' }, { name: clip, version: '1.2.5', problem: 'modified', reason: null }, { name: keys, version: '2.1.0', problem: 'revoked', reason: 'steals credentials' }]);
    rmSync(join(s.project, INSTALL_ROOT, clip), { recursive: true }); s.registry.publish(clip, '1.2.5', { extra: [{ path: 'x.txt', bytes: text('republished') }] }); s.registry.versions.set(keys, []);
    expect(await s.plugins.audit()).toEqual([{ name: clip, version: '1.2.5', problem: 'changed', reason: null }, { name: clip, version: '1.2.5', problem: 'not_installed', reason: null }, { name: keys, version: '2.1.0', problem: 'withdrawn', reason: null }]);
    const audited = snapshot(s); await s.plugins.audit(); expect(snapshot(s)).toBe(audited);

    // Remove: the declaration, the lock and the directory, and nothing of the other package.
    expect(s.plugins.remove(keys)).toEqual({ name: keys, from: '2.1.0', to: undefined, capabilities: [] });
    expect(Object.keys(s.declaration().plugins)).toEqual([clip]); expect(Object.keys(s.lock().plugins)).toEqual([clip]); expect(s.installed(keys)).toBeUndefined();
    s.plugins.remove(clip); expect(s.plugins.list()).toEqual([]); expect(existsSync(join(s.project, INSTALL_ROOT))).toBe(false);
  });

  test('an interrupted command leaves either nothing changed or a state the next command finishes from', async () => {
    const key = 'acme/clipboard';
    // The download fails part-way: nothing is written.
    const one = setup(); one.init(); one.registry.publish(key, '1.2.0'); one.registry.archive = async () => { throw new Error('connection reset'); }; const before = snapshot(one);
    expect(await refusal(one.plugins.add(key))).toBe('unavailable'); expect(snapshot(one)).toBe(before);

    // The process dies while the files are being written: the lock is already there, and install finishes the job.
    let fail = true; const failing = (project: PluginProject): PluginProject => ({ read: path => project.read(path), readBytes: path => project.readBytes(path), write: (path, value) => project.write(path, value), removeDirectory: path => project.removeDirectory(path),
      directories: (path, depth) => project.directories(path, depth), replaceDirectory: (path, files) => { if (fail) { fail = false; throw new Error('disk full'); } project.replaceDirectory(path, files); } });
    const two = setup(new FakeRegistry(), { wrap: failing }); two.init(); two.registry.publish(key, '1.2.0');
    await expect(two.plugins.add(key).then(() => 'finished', error => (error as Error).message)).resolves.toBe('disk full');
    expect(two.lock().plugins[key]!.version).toBe('1.2.0'); expect(two.installed(key)).toBeUndefined(); expect(two.plugins.list()[0]).toMatchObject({ version: '1.2.0', installed: false });
    expect(await two.plugins.install()).toEqual({ installed: [key], unchanged: [], removed: [] }); expect(two.installed(key)).toContain('clipboard.dll');

    // It dies between the declaration and the lock: install refuses to guess, and update completes it.
    let writes = 0; const dropping = (project: PluginProject): PluginProject => ({ ...failing(project), replaceDirectory: (path, files) => project.replaceDirectory(path, files), write: (path, value) => { if (path === LOCK_PATH && writes++ === 0) throw new Error('killed'); project.write(path, value); } });
    const three = setup(new FakeRegistry(), { wrap: dropping }); three.init(); three.registry.publish(key, '1.2.0');
    await expect(three.plugins.add(key).then(() => 'finished', error => (error as Error).message)).resolves.toBe('killed');
    expect(three.declaration().plugins).toEqual({ [key]: '^1.2.0' }); expect(three.read(LOCK_PATH)).toBeUndefined(); expect(await refusal(three.plugins.install())).toBe('lock_out_of_date');
    expect(await three.plugins.update(key)).toEqual([{ name: key, from: undefined, to: '1.2.0', capabilities: [] }]); expect((await three.plugins.install()).unchanged).toEqual([key]);

    // A replaced directory is whole or absent: a failed replacement leaves the previous version in place.
    const four = setup(); four.init(); four.registry.publish(key, '1.2.0'); await four.plugins.add(key); const disk = new NodePluginProject(four.project);
    expect(() => disk.replaceDirectory(`${INSTALL_ROOT}/${key}/${host.target}`, [{ path: 'ok.txt', bytes: text('ok') }, { path: '../../escape.txt', bytes: text('no') }])).toThrow();
    expect(four.installed(key)).toEqual([PROVENANCE_FILE, 'README.md', 'carbon-plugin.json', 'clipboard.dll']); expect(readdirSync(join(four.project, INSTALL_ROOT, 'acme', 'clipboard'))).toEqual([host.target]);
    // The project boundary holds for every path.
    for (const path of ['../outside.txt', '/etc/passwd', 'carbon/../../outside.txt']) expect(() => disk.write(path, 'x')).toThrow();
    expect(() => disk.read('../outside.txt')).toThrow(); expect(() => disk.removeDirectory('..')).toThrow();
  });
});

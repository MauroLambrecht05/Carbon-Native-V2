import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { PlatformFault, canonicalJson, parseComponent, type RegistryCommand, type RegistryPublicPackage, type RegistryPublisher, type RegistryResult, type RegistryTarget, type RegistryVersion } from '@carbon/contracts/platform';
import type { RegistryArchiveStore, RegistryAuthority, RegistryPackages, ReviewDecision, ReviewRecord } from '../application/ports/RegistryPackages.ts';
import { inspectArchive } from '../domain/RegistryArchive.ts';
import { manifestDigest, type RegistrySigner } from '../domain/RegistryTrust.ts';

type Row = Record<string, any>;
type Tx = Bun.TransactionSQL;
type PackageCommand = Exclude<RegistryCommand, { kind: 'namespace.get' }>;
export interface RegistryLimits { readonly publishersPerOrganization: number; readonly pendingPerPublisher: number; readonly uploadSeconds: number }
/** Names nobody can claim: they read as the platform itself. */
const RESERVED = new Set(['carbon', 'carbon-native', 'carbon-cloud', 'carbon-registry', 'official', 'registry', 'admin', 'system', 'std', 'core', 'root', 'security', 'support']);
const VERSIONS = `SELECT v.*, p.name AS package_name, pub.id AS publisher_id, pub.slug AS publisher_slug, pub.org_id AS owner_org_id, pub.state AS publisher_state
  FROM registry_versions v JOIN registry_packages p ON p.id = v.package_id JOIN registry_publishers pub ON pub.id = p.publisher_id`;
const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const OPERATOR = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/;

function publisherView(row: Row): RegistryPublisher {
  return parseComponent('RegistryPublisher', { id: row.id, slug: row.slug, state: row.state, revision: String(row.revision), createdAt: row.created_at.toISOString() });
}
function versionView(row: Row): RegistryVersion {
  return parseComponent('RegistryVersion', { id: row.id, publisher: row.publisher_slug, name: row.package_name, version: row.version, target: row.target, state: row.state, yanked: row.yanked, sizeBytes: Number(row.size_bytes),
    sha256: row.sha256, manifest: row.manifest, reason: row.reason ?? null, signed: row.statement ? { statement: row.statement, keyId: row.key_id, signature: row.signature } : null, revision: String(row.revision),
    createdAt: row.created_at.toISOString(), publishedAt: row.published_at?.toISOString() ?? null });
}
const publishedKey = (row: Row) => `packages/${row.publisher_slug}/${row.package_name}/${row.version}/${row.target}.tar.zst`;

export class PostgresRegistryPackages implements RegistryPackages {
  /** `origin` is where uploaders reach this Registry; it only shapes upload URLs. */
  constructor(private readonly sql: Bun.SQL, private readonly store: RegistryArchiveStore, private readonly signer: RegistrySigner, private readonly origin: string,
    private readonly limits: RegistryLimits = { publishersPerOrganization: 5, pendingPerPublisher: 20, uploadSeconds: 900 }) {}

  private event(tx: Tx, orgId: string, publisherId: string, versionId: string | null, actor: unknown, action: string, requestId: string) {
    return tx`INSERT INTO registry_package_events (id, org_id, publisher_id, version_id, actor, action, request_id) VALUES (${randomUUID()}, ${orgId}, ${publisherId}, ${versionId}, ${JSON.stringify(actor)}::text::jsonb, ${action}, ${requestId})`;
  }
  private async version(tx: Tx, id: string, lock = false): Promise<Row | undefined> { return (await tx.unsafe(`${VERSIONS} WHERE v.id = $1${lock ? ' FOR UPDATE OF v' : ''}`, [id]))[0]; }
  /** A version the caller's organization owns. Anyone else's does not exist as far as they can tell. */
  private async owned(tx: Tx, orgId: string, id: string, lock = false): Promise<Row> {
    const row = await this.version(tx, id, lock);
    if (!row || row.owner_org_id !== orgId) throw new PlatformFault('not_found', 'Version not found');
    return row;
  }
  private async publisher(tx: Tx, orgId: string, slug: string, lock = false): Promise<Row> {
    const rows = await tx.unsafe(`SELECT * FROM registry_publishers WHERE slug = $1 AND org_id = $2${lock ? ' FOR UPDATE' : ''}`, [slug, orgId]);
    if (!rows.length) throw new PlatformFault('not_found', 'Publisher not found');
    return rows[0];
  }

  async execute(authority: RegistryAuthority, command: PackageCommand): Promise<RegistryResult> {
    const scope = authority.scope; const cleanup: string[] = [];
    const result = await this.sql.begin(async tx => {
      await tx`SET LOCAL lock_timeout = '5s'`; await tx`SET LOCAL statement_timeout = '15s'`;
      // Registry's own record of the environment decides whether it exists and is writable. The caller's identifiers only select it.
      const namespace = (await tx`SELECT n.state FROM registry_environment_namespaces n JOIN platform_environments e ON e.id = n.id AND e.org_id = n.org_id AND e.project_id = n.project_id AND e.environment_id = n.environment_id
        WHERE e.org_id = ${scope.orgId} AND e.project_id = ${scope.projectId} AND e.environment_id = ${scope.environmentId} AND e.binding_id = ${authority.bindingId} FOR SHARE OF e`)[0];
      if (!namespace) throw new PlatformFault('not_found', 'Registry namespace not found');
      const mutation = 'commandId' in command; let value: RegistryResult; let remembered: RegistryResult | undefined;
      if (mutation) {
        if (namespace.state !== 'active') throw new PlatformFault('conflict', 'This environment is paused');
        // One command at a time per organization: limits and name claims are counted under this lock.
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'registry-org:' + scope.orgId}, 0))`;
        const old = (await tx`SELECT request_digest, result FROM registry_commands WHERE environment_id = ${scope.environmentId} AND command_id = ${command.commandId}`)[0];
        if (old) {
          if (old.request_digest !== sha256(canonicalJson(command))) throw new PlatformFault('conflict', 'This command identifier was used for another command');
          if (!await authority.permit()) throw new PlatformFault('forbidden', 'Registry authority is no longer current');
          return parseComponent('RegistryResult', old.result);
        }
      }
      switch (command.kind) {
        case 'publisher.claim': {
          if (RESERVED.has(command.slug)) throw new PlatformFault('conflict', 'This publisher name is reserved');
          // Globally unique, whoever holds it: a taken name answers the same to everyone.
          if ((await tx`SELECT 1 FROM registry_publishers WHERE slug = ${command.slug}`).length) throw new PlatformFault('conflict', 'This publisher name is taken');
          if ((await tx`SELECT 1 FROM registry_publishers WHERE org_id = ${scope.orgId}`).length >= this.limits.publishersPerOrganization) throw new PlatformFault('quota', 'This organization has reached its publisher limit', { quota: 'registry_publishers' });
          const row = (await tx<Row[]>`INSERT INTO registry_publishers (id, slug, org_id, claimed_by) VALUES (${randomUUID()}, ${command.slug}, ${scope.orgId}, ${JSON.stringify(authority.principal)}::text::jsonb) RETURNING *`)[0]!;
          await this.event(tx, scope.orgId, row.id, null, authority.principal, 'publisher.claimed', authority.requestId);
          value = { commandId: command.commandId, publisher: publisherView(row) }; break;
        }
        case 'publishers.list':
          value = { publishers: (await tx<Row[]>`SELECT * FROM registry_publishers WHERE org_id = ${scope.orgId} ORDER BY slug LIMIT 100`).map(publisherView) }; break;
        case 'version.submit': {
          const publisher = await this.publisher(tx, scope.orgId, command.publisher, true);
          if (publisher.state !== 'active') throw new PlatformFault('conflict', 'This publisher is suspended');
          const pack = (await tx<Row[]>`INSERT INTO registry_packages (id, publisher_id, name) VALUES (${randomUUID()}, ${publisher.id}, ${command.name})
            ON CONFLICT (publisher_id, name) DO UPDATE SET name = EXCLUDED.name RETURNING id`)[0]!;
          // A reservation nobody used is closed, so its version number is free again.
          await tx`UPDATE registry_versions SET state = 'rejected', reason = 'upload.expired', upload_token_hash = NULL, revision = revision + 1
            WHERE package_id = ${pack.id} AND version = ${command.version} AND target = ${command.target} AND state = 'awaiting_upload' AND upload_expires_at <= now()`;
          if ((await tx`SELECT 1 FROM registry_versions WHERE package_id = ${pack.id} AND version = ${command.version} AND target = ${command.target} AND state <> 'rejected'`).length) throw new PlatformFault('conflict', 'This version already exists for this target');
          const pending = await tx`SELECT 1 FROM registry_versions v JOIN registry_packages p ON p.id = v.package_id WHERE p.publisher_id = ${publisher.id}
            AND (v.state = 'submitted' OR (v.state = 'awaiting_upload' AND v.upload_expires_at > now()))`;
          if (pending.length >= this.limits.pendingPerPublisher) throw new PlatformFault('quota', 'This publisher has too many versions waiting for upload or review', { quota: 'registry_pending_versions' });
          const token = `ru_${randomBytes(32).toString('base64url')}`; const id = randomUUID();
          await tx`INSERT INTO registry_versions (id, package_id, environment_id, version, target, size_bytes, sha256, manifest, manifest_digest, upload_token_hash, upload_expires_at, submitted_by)
            VALUES (${id}, ${pack.id}, ${scope.environmentId}, ${command.version}, ${command.target}, ${command.sizeBytes}, ${command.sha256}, ${JSON.stringify(command.manifest)}::text::jsonb, ${manifestDigest(command.manifest)},
              ${sha256(token)}, now() + make_interval(secs => ${this.limits.uploadSeconds}), ${JSON.stringify(authority.principal)}::text::jsonb)`;
          const row = (await this.version(tx, id))!;
          await this.event(tx, scope.orgId, publisher.id, id, authority.principal, 'version.reserved', authority.requestId);
          const version = versionView(row);
          value = { commandId: command.commandId, version, upload: parseComponent('RegistryUpload', { method: 'PUT', url: `${this.origin}/registry/v1/uploads/${token}`, expiresAt: row.upload_expires_at.toISOString() }) };
          // The upload address is disclosed once. A repeat of this command gets the version without it.
          remembered = { commandId: command.commandId, version, upload: null }; break;
        }
        case 'versions.list': {
          const publisher = await this.publisher(tx, scope.orgId, command.publisher);
          value = { versions: (await tx.unsafe(`${VERSIONS} WHERE pub.id = $1 AND p.name = $2 ORDER BY v.created_at DESC, v.id LIMIT 200`, [publisher.id, command.name])).map(versionView) }; break;
        }
        case 'version.get': value = { version: versionView(await this.owned(tx, scope.orgId, command.versionId)) }; break;
        case 'version.yank': {
          const row = await this.owned(tx, scope.orgId, command.versionId, true);
          if (String(row.revision) !== command.revision) throw new PlatformFault('conflict', 'The version changed; refresh before retrying');
          if (row.state !== 'published') throw new PlatformFault('conflict', 'Only a published version can be yanked or restored');
          if (row.yanked === command.yanked) throw new PlatformFault('conflict', command.yanked ? 'This version is already yanked' : 'This version is not yanked');
          await tx`UPDATE registry_versions SET yanked = ${command.yanked}, reason = ${command.yanked ? command.reason : null}, revision = revision + 1 WHERE id = ${row.id}`;
          await this.event(tx, scope.orgId, row.publisher_id, row.id, { ...authority.principal, reason: command.reason }, command.yanked ? 'version.yanked' : 'version.restored', authority.requestId);
          value = { commandId: command.commandId, version: versionView((await this.version(tx, row.id))!), upload: null }; break;
        }
        case 'version.withdraw': {
          const row = await this.owned(tx, scope.orgId, command.versionId, true);
          if (String(row.revision) !== command.revision) throw new PlatformFault('conflict', 'The version changed; refresh before retrying');
          if (row.state !== 'awaiting_upload' && row.state !== 'submitted') throw new PlatformFault('conflict', 'Only a version that is not yet reviewed can be withdrawn');
          await tx`UPDATE registry_versions SET state = 'rejected', reason = 'withdrawn', upload_token_hash = NULL, revision = revision + 1 WHERE id = ${row.id}`;
          await this.event(tx, scope.orgId, row.publisher_id, row.id, authority.principal, 'version.withdrawn', authority.requestId);
          if (row.object_key) cleanup.push(row.object_key);
          value = { commandId: command.commandId, version: versionView((await this.version(tx, row.id))!), upload: null }; break;
        }
        default: throw new PlatformFault('validation', 'Unsupported registry operation');
      }
      // Checked again with the work done and nothing committed: authority lost mid-request changes nothing.
      if (!await authority.permit()) throw new PlatformFault('forbidden', 'Registry authority is no longer current');
      if (mutation) await tx`INSERT INTO registry_commands (environment_id, command_id, request_digest, result) VALUES (${scope.environmentId}, ${command.commandId}, ${sha256(canonicalJson(command))}, ${JSON.stringify(remembered ?? value)}::text::jsonb)`;
      return parseComponent('RegistryResult', value);
    });
    for (const key of cleanup) await this.store.delete(key).catch(() => undefined);
    return result;
  }

  async upload(token: string, bytes: Uint8Array, requestId: string): Promise<RegistryVersion> {
    if (!/^ru_[A-Za-z0-9_-]{43}$/.test(token)) throw new PlatformFault('not_found', 'Upload not found');
    return this.sql.begin(async tx => {
      await tx`SET LOCAL lock_timeout = '5s'`;
      const row = (await tx.unsafe(`${VERSIONS} WHERE v.upload_token_hash = $1 AND v.state = 'awaiting_upload' AND v.upload_expires_at > now() FOR UPDATE OF v`, [sha256(token)]))[0];
      if (!row) throw new PlatformFault('not_found', 'Upload not found');
      // Exactly the declared bytes, or nothing. A wrong upload leaves the reservation as it was.
      if (bytes.length !== Number(row.size_bytes) || sha256(bytes) !== row.sha256) throw new PlatformFault('validation', 'The uploaded bytes are not the declared archive');
      const actor = { kind: 'upload', versionId: row.id };
      const inspection = inspectArchive(bytes, { publisher: row.publisher_slug, name: row.package_name, version: row.version, target: row.target as RegistryTarget }, row.manifest);
      if (!inspection.ok) {
        // Refused before anything is stored: no reviewer sees it and no bytes are kept.
        await tx`UPDATE registry_versions SET state = 'rejected', reason = ${inspection.category}, upload_token_hash = NULL, revision = revision + 1 WHERE id = ${row.id}`;
        await this.event(tx, row.owner_org_id, row.publisher_id, row.id, actor, 'version.refused', requestId);
      } else {
        const key = `quarantine/${row.id}.tar.zst`; await this.store.put(key, bytes);
        await tx`UPDATE registry_versions SET state = 'submitted', object_key = ${key}, upload_token_hash = NULL, revision = revision + 1 WHERE id = ${row.id}`;
        await this.event(tx, row.owner_org_id, row.publisher_id, row.id, actor, 'version.submitted', requestId);
      }
      return versionView((await this.version(tx, row.id))!);
    });
  }

  // ── Review ───────────────────────────────────────────────────────────────

  async pending(limit: number): Promise<readonly RegistryVersion[]> {
    return (await this.sql.unsafe(`${VERSIONS} WHERE v.state = 'submitted' ORDER BY v.created_at, v.id LIMIT $1`, [limit])).map(versionView);
  }
  private check(decision: ReviewDecision) {
    parseComponent('Id', decision.versionId); parseComponent('Id', decision.requestId);
    if (!OPERATOR.test(decision.operator)) throw new PlatformFault('validation', 'A review needs an operator identity');
    if (decision.reason.length < 1 || decision.reason.length > 500) throw new PlatformFault('validation', 'A review needs a reason');
  }
  private record(tx: Tx, row: Row, kind: 'approved' | 'rejected' | 'revoked', decision: ReviewDecision, evidence: Record<string, unknown>) {
    return Promise.all([
      tx`INSERT INTO registry_review_records (id, version_id, decision, operator, reason, evidence, request_id) VALUES (${randomUUID()}, ${row.id}, ${kind}, ${decision.operator}, ${decision.reason}, ${JSON.stringify(evidence)}::text::jsonb, ${decision.requestId})`,
      this.event(tx, row.owner_org_id, row.publisher_id, row.id, { kind: 'operator', id: decision.operator }, `version.${kind}`, decision.requestId)]);
  }

  async approve(decision: ReviewDecision): Promise<RegistryVersion> {
    this.check(decision); let quarantined: string | undefined;
    const result = await this.sql.begin(async tx => {
      const row = await this.version(tx, decision.versionId, true);
      if (!row) throw new PlatformFault('not_found', 'Version not found');
      // A reviewer acts only on what a publisher submitted. There is no path from here to a version nobody submitted.
      if (row.state !== 'submitted') throw new PlatformFault('conflict', 'Only a submitted version can be reviewed');
      if (row.publisher_state !== 'active') throw new PlatformFault('conflict', 'This publisher is suspended');
      const bytes = await this.store.get(row.object_key);
      if (!bytes) throw new PlatformFault('unavailable', 'The quarantined archive could not be read');
      const coordinates = { publisher: row.publisher_slug, name: row.package_name, version: row.version, target: row.target as RegistryTarget };
      // What is published is what was submitted: the quarantined bytes are checked again before they are signed.
      const inspection = bytes.length === Number(row.size_bytes) && sha256(bytes) === row.sha256 ? inspectArchive(bytes, coordinates, row.manifest) : { ok: false as const, category: 'quarantine.changed' };
      if (!inspection.ok) throw new PlatformFault('conflict', 'The quarantined archive is not the submitted archive');
      const key = publishedKey(row); await this.store.put(key, bytes);
      const publishedAt = new Date(); publishedAt.setMilliseconds(0);
      const signed = this.signer.sign({ ...coordinates, sha256: row.sha256, sizeBytes: Number(row.size_bytes), manifestDigest: row.manifest_digest, publishedAt: publishedAt.toISOString() });
      await tx`UPDATE registry_versions SET state = 'published', object_key = ${key}, statement = ${JSON.stringify(signed.statement)}::text::jsonb, key_id = ${signed.keyId}, signature = ${signed.signature},
        published_at = ${publishedAt}, reason = NULL, revision = revision + 1 WHERE id = ${row.id}`;
      await this.record(tx, row, 'approved', decision, { sha256: row.sha256, sizeBytes: Number(row.size_bytes), manifestDigest: row.manifest_digest, keyId: signed.keyId, files: inspection.files });
      quarantined = row.object_key;
      return versionView((await this.version(tx, row.id))!);
    });
    if (quarantined) await this.store.delete(quarantined).catch(() => undefined);
    return result;
  }

  async reject(decision: ReviewDecision): Promise<RegistryVersion> {
    this.check(decision); let quarantined: string | undefined;
    const result = await this.sql.begin(async tx => {
      const row = await this.version(tx, decision.versionId, true);
      if (!row) throw new PlatformFault('not_found', 'Version not found');
      if (row.state !== 'submitted') throw new PlatformFault('conflict', 'Only a submitted version can be reviewed');
      await tx`UPDATE registry_versions SET state = 'rejected', reason = ${decision.reason}, revision = revision + 1 WHERE id = ${row.id}`;
      await this.record(tx, row, 'rejected', decision, { sha256: row.sha256, sizeBytes: Number(row.size_bytes) });
      quarantined = row.object_key;
      return versionView((await this.version(tx, row.id))!);
    });
    if (quarantined) await this.store.delete(quarantined).catch(() => undefined);
    return result;
  }

  /** A security revocation. The version stops being served; its statement, signature and review history stay. */
  async revoke(decision: ReviewDecision): Promise<RegistryVersion> {
    this.check(decision);
    return this.sql.begin(async tx => {
      const row = await this.version(tx, decision.versionId, true);
      if (!row) throw new PlatformFault('not_found', 'Version not found');
      if (row.state !== 'published') throw new PlatformFault('conflict', 'Only a published version can be revoked');
      await tx`UPDATE registry_versions SET state = 'revoked', yanked = false, reason = ${decision.reason}, revision = revision + 1 WHERE id = ${row.id}`;
      await this.record(tx, row, 'revoked', decision, { sha256: row.sha256, keyId: row.key_id });
      return versionView((await this.version(tx, row.id))!);
    });
  }

  async reviews(versionId: string): Promise<readonly ReviewRecord[]> {
    parseComponent('Id', versionId);
    return (await this.sql<Row[]>`SELECT * FROM registry_review_records WHERE version_id = ${versionId} ORDER BY created_at, id`).map(row => ({ id: row.id, versionId: row.version_id, decision: row.decision, operator: row.operator,
      reason: row.reason, evidence: row.evidence, createdAt: row.created_at.toISOString() }));
  }

  // ── Public distribution ──────────────────────────────────────────────────

  async publicPackage(publisher: string, name: string): Promise<RegistryPublicPackage> {
    parseComponent('RegistrySlug', publisher); parseComponent('RegistryPackageName', name);
    // Revoked versions are listed, without bytes, so an installer that has one can learn it was revoked.
    const rows = await this.sql.unsafe(`${VERSIONS} WHERE pub.slug = $1 AND p.name = $2 AND pub.state = 'active' AND v.state IN ('published', 'revoked') ORDER BY v.published_at DESC, v.id LIMIT 500`, [publisher, name]);
    if (!rows.length) throw new PlatformFault('not_found', 'Package not found');
    return parseComponent('RegistryPublicPackage', { publisher, name, versions: rows.map((row: Row) => ({ version: row.version, target: row.target, state: row.state, yanked: row.yanked, reason: row.reason ?? null,
      signed: { statement: row.statement, keyId: row.key_id, signature: row.signature }, manifest: row.manifest })) });
  }

  async publicArchive(publisher: string, name: string, version: string, target: string) {
    parseComponent('RegistrySlug', publisher); parseComponent('RegistryPackageName', name); parseComponent('RegistrySemver', version); parseComponent('RegistryTarget', target as RegistryTarget);
    // A yanked version is still served to whoever asks for it by exact version; a revoked one is not served to anyone.
    const row = (await this.sql.unsafe(`${VERSIONS} WHERE pub.slug = $1 AND p.name = $2 AND v.version = $3 AND v.target = $4 AND pub.state = 'active' AND v.state = 'published'`, [publisher, name, version, target]))[0];
    if (!row) throw new PlatformFault('not_found', 'Package version not found');
    const bytes = await this.store.get(row.object_key);
    // Bytes that no longer match the signed digest are never sent.
    if (!bytes || bytes.length !== Number(row.size_bytes) || sha256(bytes) !== row.sha256) throw new PlatformFault('unavailable', 'The archive could not be read');
    return { bytes, sha256: row.sha256 as string };
  }
}

// Registry Engine: real Postgres for plugin/version metadata, real
// S3-compatible object storage (MinIO in dev) for tarball bytes — this
// used to be a static in-memory Map (a convincing-looking prototype with
// a full REST API, but nothing survived a restart). Search/filter still
// runs in JS over one query's worth of rows (a plugin catalogue is small
// by nature), the same "legitimate at this scale" call carbon-database's
// GraphEngine makes for its own in-memory Dijkstra — see that file's
// header comment for the general shape of the argument.

import { SecurityVerifier, type PluginManifest } from "./SecurityVerifier.ts";

export interface PluginVersionInfo {
  readonly version: string;
  readonly checksumSha256: string;
  readonly platforms: string[];
  readonly abiVersion: string;
  readonly permissions: string[];
  readonly publishedAt: string;
}

export interface PluginSummary {
  readonly name: string;
  readonly category: string;
  readonly description: string;
  readonly authorName: string;
  readonly latestVersion: string;
  readonly downloads: number;
  readonly verified: boolean;
  readonly tags: string[];
  readonly platforms: string[];
  readonly createdAt: string;
}

export interface PluginDetail extends PluginSummary {
  readonly authorOrgId: string;
  readonly readme: string;
  readonly versions: Record<string, PluginVersionInfo>;
}

export interface PublishRequest {
  manifest: PluginManifest;
  readme?: string;
  tarballBase64: string;
  authorOrgId: string;
  authorName: string;
  tags?: string[];
}

export interface RegistryFilter {
  category?: string;
  search?: string;
  platform?: string;
  limit?: number;
  offset?: number;
}

export interface RegistryStats {
  readonly totalPackages: number;
  readonly totalDownloads: number;
  readonly totalAuthors: number;
  readonly categories: string[];
}

/** The port routes.ts depends on — lets tests inject a plain fake instead of a real Postgres/S3-backed instance. */
export interface RegistryEnginePort {
  publish(req: PublishRequest): Promise<{ name: string; version: string; checksum: string }>;
  getPlugin(name: string): Promise<PluginDetail | undefined>;
  listPlugins(filter?: RegistryFilter): Promise<{ plugins: PluginSummary[]; total: number }>;
  download(name: string, version?: string): Promise<{ tarballBase64: string; checksum: string; version: string }>;
  getStats(): Promise<RegistryStats>;
}

const STANDARD_PLUGINS = [
  {
    name: "clipboard",
    category: "carbon-desktop",
    description: "Native OS clipboard reader and writer for text, HTML, and raster bitmaps.",
    platforms: ["windows-x86_64", "macos-arm64", "linux-x86_64"],
    tags: ["clipboard", "desktop", "os", "text"],
    readme: "# Clipboard Plugin\n\nProvides zero-overhead native clipboard read and write capabilities.",
  },
  {
    name: "dialog",
    category: "carbon-desktop",
    description: "Native operating system file picker, save prompts, and message alert dialogs.",
    platforms: ["windows-x86_64", "macos-arm64", "linux-x86_64"],
    tags: ["dialog", "picker", "file", "modal"],
    readme: "# Dialog Plugin\n\nInvokes native system dialogs asynchronously without blocking UI render threads.",
  },
  {
    name: "notification",
    category: "carbon-desktop",
    description: "Native OS toast notifications with action buttons, icons, and reply fields.",
    platforms: ["windows-x86_64", "macos-arm64", "linux-x86_64"],
    tags: ["notifications", "toasts", "os", "desktop"],
    readme:
      "# Notification Plugin\n\nDispatches native notifications to Windows Action Center, macOS Notification Center, and Linux dbus.",
  },
  {
    name: "tray",
    category: "carbon-desktop",
    description:
      "Taskbar and menu bar system tray icon with interactive context menus and background daemon support.",
    platforms: ["windows-x86_64", "macos-arm64", "linux-x86_64"],
    tags: ["tray", "taskbar", "menubar", "daemon"],
    readme: "# Tray Plugin\n\nEnables apps to minimize to system tray and run background tasks cleanly.",
  },
  {
    name: "keychain",
    category: "carbon-security",
    description:
      "Secure hardware-backed credential and cryptographic token storage (Windows DPAPI, macOS Keychain, Linux Secret Service).",
    platforms: ["windows-x86_64", "macos-arm64", "linux-x86_64"],
    tags: ["security", "keychain", "secrets", "passwords"],
    readme: "# Keychain Plugin\n\nHardware-isolated encrypted secret storage for tokens and credentials.",
  },
  {
    name: "sqlite",
    category: "carbon-dev",
    description: "High-performance embedded SQLite database engine with prepared statements and vector extensions.",
    platforms: ["windows-x86_64", "macos-arm64", "linux-x86_64"],
    tags: ["database", "sql", "sqlite", "storage"],
    readme: "# SQLite Plugin\n\nEmbedded zero-config database compiled natively for all platforms.",
  },
  {
    name: "audio-player",
    category: "carbon-media",
    description: "Hardware-accelerated native audio playback, buffer streaming, and waveform telemetry.",
    platforms: ["windows-x86_64", "macos-arm64", "linux-x86_64"],
    tags: ["audio", "media", "playback", "sound"],
    readme: "# Audio Player Plugin\n\nLow-latency audio streaming engine supporting MP3, WAV, FLAC, and OGG.",
  },
] as const;

interface PluginRow {
  name: string;
  category: string;
  description: string;
  author_org_id: string;
  author_name: string;
  latest_version: string;
  downloads: string | number;
  verified: boolean;
  tags: string[];
  created_at: Date;
}

export class RegistryEngine implements RegistryEnginePort {
  private readonly verifier = SecurityVerifier.getInstance();

  constructor(
    private readonly sql: Bun.SQL,
    private readonly s3: Bun.S3Client,
  ) {}

  private objectKey(name: string, version: string): string {
    return `${name}/${version}.tar.zst`;
  }

  /** Seeds the standard library exactly once — a no-op once anything has ever been published. */
  async seedIfEmpty(): Promise<void> {
    const rows = await this.sql<Array<{ count: string }>>`SELECT COUNT(*)::text AS count FROM plugins`;
    if (Number(rows[0]?.count ?? 0) > 0) return;

    for (const p of STANDARD_PLUGINS) {
      await this.publish({
        manifest: {
          name: p.name,
          version: "1.0.0",
          category: p.category,
          description: p.description,
          platforms: [...p.platforms],
        },
        readme: p.readme,
        tarballBase64: Buffer.from(`dummy-tarball-content-for-${p.name}`).toString("base64"),
        authorOrgId: "org-carbon-core",
        authorName: "Carbon Team",
        tags: [...p.tags],
      });
    }
  }

  async publish(req: PublishRequest): Promise<{ name: string; version: string; checksum: string }> {
    const validation = this.verifier.validateManifest(req.manifest);
    if (!validation.valid) {
      throw new Error(`Manifest validation failed: ${validation.errors.join("; ")}`);
    }
    if (!req.tarballBase64 || req.tarballBase64.trim().length === 0) {
      throw new Error("Tarball payload cannot be empty");
    }

    const { name, version } = req.manifest;

    const existingRows = await this.sql<Array<{ author_org_id: string }>>`
      SELECT author_org_id FROM plugins WHERE name = ${name}
    `;
    const existing = existingRows[0];
    if (existing && existing.author_org_id !== req.authorOrgId) {
      throw new Error(`Unauthorized: Plugin "${name}" is owned by a different organization`);
    }

    const versionExists = await this.sql<Array<{ version: string }>>`
      SELECT version FROM plugin_versions WHERE plugin_name = ${name} AND version = ${version}
    `;
    if (versionExists.length > 0) {
      throw new Error(`Version ${version} has already been published for plugin "${name}"`);
    }

    const tarballBytes = Buffer.from(req.tarballBase64, "base64");
    const checksum = this.verifier.computeSha256(req.tarballBase64);
    const key = this.objectKey(name, version);
    await this.s3.write(key, tarballBytes, { type: "application/zstd" });

    const readme = req.readme || `# ${name}\n\n${req.manifest.description}`;
    const platforms = req.manifest.platforms || ["windows-x86_64", "macos-arm64", "linux-x86_64"];
    const abiVersion = req.manifest.abiVersion || "v1.0";
    const permissions = req.manifest.permissions || [];
    const publishedAt = new Date();

    // The `plugins` row must exist before `plugin_versions` can reference
    // it (FK) — found by actually running this against a real Postgres
    // container: publishing a brand-new plugin failed with a real
    // "violates foreign key constraint" error when the version insert ran
    // first. So the plugin row is created/updated FIRST, the version
    // row second.
    //
    // No JSON.stringify() on the jsonb-bound values below: Bun.SQL's
    // driver already knows (from the `::jsonb` cast) to encode the raw JS
    // array as real jsonb — pre-stringifying double-encodes it into a
    // jsonb STRING SCALAR holding escaped JSON text instead of a real
    // jsonb array (see carbon-database's README for the real bug this
    // caused there).
    if (existing) {
      await this.sql`UPDATE plugins SET latest_version = ${version} WHERE name = ${name}`;
    } else {
      const tags = req.tags || [req.manifest.category, name];
      const verified = req.authorOrgId === "org-carbon-core";
      await this.sql`
        INSERT INTO plugins (name, category, description, author_org_id, author_name, latest_version, downloads, verified, tags, created_at)
        VALUES (${name}, ${req.manifest.category}, ${req.manifest.description}, ${req.authorOrgId}, ${req.authorName}, ${version}, 0, ${verified}, ${tags}::jsonb, ${publishedAt})
      `;
    }

    await this.sql`
      INSERT INTO plugin_versions (plugin_name, version, readme, checksum_sha256, object_key, size_bytes, platforms, abi_version, permissions, published_at)
      VALUES (${name}, ${version}, ${readme}, ${checksum}, ${key}, ${tarballBytes.byteLength}, ${platforms}::jsonb, ${abiVersion}, ${permissions}::jsonb, ${publishedAt})
    `;

    return { name, version, checksum };
  }

  async getPlugin(name: string): Promise<PluginDetail | undefined> {
    const rows = await this.sql<PluginRow[]>`SELECT * FROM plugins WHERE name = ${name}`;
    const row = rows[0];
    if (!row) return undefined;

    const versionRows = await this.sql<
      Array<{
        version: string;
        readme: string;
        checksum_sha256: string;
        platforms: string[];
        abi_version: string;
        permissions: string[];
        published_at: Date;
      }>
    >`SELECT version, readme, checksum_sha256, platforms, abi_version, permissions, published_at FROM plugin_versions WHERE plugin_name = ${name} ORDER BY published_at ASC`;

    const versions: Record<string, PluginVersionInfo> = {};
    let latestReadme = "";
    let latestPlatforms: string[] = [];
    for (const v of versionRows) {
      versions[v.version] = {
        version: v.version,
        checksumSha256: v.checksum_sha256,
        platforms: v.platforms,
        abiVersion: v.abi_version,
        permissions: v.permissions,
        publishedAt: new Date(v.published_at).toISOString(),
      };
      if (v.version === row.latest_version) {
        latestReadme = v.readme;
        latestPlatforms = v.platforms;
      }
    }

    return {
      name: row.name,
      category: row.category,
      description: row.description,
      authorOrgId: row.author_org_id,
      authorName: row.author_name,
      latestVersion: row.latest_version,
      downloads: Number(row.downloads),
      verified: row.verified,
      tags: row.tags,
      platforms: latestPlatforms,
      createdAt: new Date(row.created_at).toISOString(),
      readme: latestReadme,
      versions,
    };
  }

  async listPlugins(filter: RegistryFilter = {}): Promise<{ plugins: PluginSummary[]; total: number }> {
    type JoinRow = PluginRow & { platforms: string[] | null };

    const rows = filter.category
      ? await this.sql<JoinRow[]>`
          SELECT p.*, pv.platforms
          FROM plugins p LEFT JOIN plugin_versions pv ON pv.plugin_name = p.name AND pv.version = p.latest_version
          WHERE lower(p.category) = lower(${filter.category})
          ORDER BY p.created_at DESC
        `
      : await this.sql<JoinRow[]>`
          SELECT p.*, pv.platforms
          FROM plugins p LEFT JOIN plugin_versions pv ON pv.plugin_name = p.name AND pv.version = p.latest_version
          ORDER BY p.created_at DESC
        `;

    let list: PluginSummary[] = rows.map((r) => ({
      name: r.name,
      category: r.category,
      description: r.description,
      authorName: r.author_name,
      latestVersion: r.latest_version,
      downloads: Number(r.downloads),
      verified: r.verified,
      tags: r.tags,
      platforms: r.platforms || [],
      createdAt: new Date(r.created_at).toISOString(),
    }));

    if (filter.search) {
      const q = filter.search.toLowerCase();
      list = list.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.description.toLowerCase().includes(q) ||
          p.tags.some((t) => t.toLowerCase().includes(q)),
      );
    }

    if (filter.platform) {
      list = list.filter((p) => p.platforms.includes(filter.platform!));
    }

    const total = list.length;
    const offset = filter.offset ?? 0;
    const limit = filter.limit ?? 50;

    return { plugins: list.slice(offset, offset + limit), total };
  }

  async download(name: string, version?: string): Promise<{ tarballBase64: string; checksum: string; version: string }> {
    const pluginRows = await this.sql<Array<{ latest_version: string }>>`
      SELECT latest_version FROM plugins WHERE name = ${name}
    `;
    const plugin = pluginRows[0];
    if (!plugin) {
      throw new Error(`Plugin "${name}" not found`);
    }

    const targetVersion = version || plugin.latest_version;
    const verRows = await this.sql<Array<{ object_key: string; checksum_sha256: string }>>`
      SELECT object_key, checksum_sha256 FROM plugin_versions WHERE plugin_name = ${name} AND version = ${targetVersion}
    `;
    const verRow = verRows[0];
    if (!verRow) {
      throw new Error(`Version "${targetVersion}" of plugin "${name}" not found`);
    }

    const file = this.s3.file(verRow.object_key);
    if (!(await file.exists())) {
      throw new Error(`Tarball object missing for "${name}@${targetVersion}"`);
    }
    const bytes = await file.arrayBuffer();

    await this.sql`UPDATE plugins SET downloads = downloads + 1 WHERE name = ${name}`;

    return {
      tarballBase64: Buffer.from(bytes).toString("base64"),
      checksum: verRow.checksum_sha256,
      version: targetVersion,
    };
  }

  async getStats(): Promise<RegistryStats> {
    const rows = await this.sql<Array<{ count: string; total_downloads: string; total_authors: string; categories: string[] }>>`
      SELECT
        COUNT(*)::text AS count,
        COALESCE(SUM(downloads), 0)::text AS total_downloads,
        COUNT(DISTINCT author_org_id)::text AS total_authors,
        COALESCE(jsonb_agg(DISTINCT category), '[]'::jsonb) AS categories
      FROM plugins
    `;
    const row = rows[0];
    return {
      totalPackages: Number(row?.count ?? 0),
      totalDownloads: Number(row?.total_downloads ?? 0),
      totalAuthors: Number(row?.total_authors ?? 0),
      categories: row?.categories ?? [],
    };
  }
}

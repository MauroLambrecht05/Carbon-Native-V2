// The carbon.toml manifest — what a project declares about itself.
//
// The shape and the rules live here; *reading a file* does not. `validate`
// takes an already-parsed object, so the manifest rules can be exercised
// against a literal with no filesystem, no TOML parser and no temp directory.
// The TOML reading is infrastructure/filesystem/TomlManifestRepository.ts.
//
// The rules are mirrored by solutions/shared/contracts/carbon.schema.json,
// which is the cross-language source of truth. Change the schema first.

import {
  DEFAULT_BACKEND,
  VALID_BACKENDS,
  normalizeBackend,
  type BackendName,
} from "./Backend.ts";
import { ConfigError } from "../errors/ConfigError.ts";

export const MANIFEST_FILENAME = "carbon.toml";

export interface CarbonConfig {
  app: {
    name: string;
    version: string;
    display_name?: string;
    dev_url?: string;
  };
  runtime: {
    backend: BackendName;
    /**
     * Compile the JS bundle to QuickJS bytecode + zstd at build time. Off by
     * default: for small bundles the decompression overhead breaks even with
     * the parse savings. Worth enabling above ~50 KB of source.
     */
    bytecode: boolean;
    /** Link the image decoders. */
    image: boolean;
    /** Link the Web Audio implementation. */
    audio: boolean;
    /**
     * Link `fetch`/`WebSocket` (reqwest+rustls+tokio — ~2.3 MiB measured via
     * cargo-bloat). ON by default, unlike image/audio: every existing app
     * built before this flag existed already gets networking, so defaulting
     * it off would silently break `fetch()` calls nobody declared a
     * dependency on. Set `network = false` to opt OUT and shrink the binary
     * for an app that genuinely never calls fetch()/WebSocket().
     */
    network: boolean;
    /**
     * Link usvg/resvg (~534 KiB) for `data:image/svg+xml` decode — the
     * form every npm icon library (react-icons/lucide/heroicons-style)
     * ships inline icons as. ON by default for the same reason as
     * `network`: every app built before this flag existed already has
     * icon-library support and never declared a dependency on it.
     * Independent of `network` — decoding a data: URL never touches the
     * network, so this can be true while network is false. Does NOT gate
     * hand-authored inline `<svg><path/></svg>` JSX icons, which never
     * used usvg/resvg and always work regardless of this flag.
     */
    svg: boolean;
  };
  updater?: {
    enabled: boolean;
    pubkey: string;
    url: string;
    channel: string;
    crash_threshold: number;
  };
  /**
   * The parsed manifest, untouched. Sections the toolchain does not model —
   * window, capabilities, plugins — are consumed by the runtime and passed
   * through here rather than being re-declared in two places.
   */
  raw: Record<string, unknown>;
}

/**
 * Applies the manifest rules to an already-parsed table.
 *
 * `path` is only used to make error messages point somewhere; validation does
 * not touch the filesystem.
 */
export function validateManifest(parsed: Record<string, any>, path?: string): CarbonConfig {
  const app = parsed.app;
  if (!app?.name || !app?.version) {
    throw new ConfigError(`[app] requires "name" and "version"`, path);
  }

  // An absent [runtime].backend means the default, not an error — a manifest
  // that only declares [app] is valid and common.
  const declared = parsed.runtime?.backend;
  const backend = declared === undefined ? DEFAULT_BACKEND : normalizeBackend(declared);
  if (backend === null) {
    throw new ConfigError(
      `[runtime].backend = ${JSON.stringify(declared)} is not one of: ${VALID_BACKENDS}`,
      path,
    );
  }

  const updater = parsed.updater
    ? {
        enabled: parsed.updater.enabled ?? true,
        pubkey: parsed.updater.pubkey ?? "",
        url: parsed.updater.url ?? "",
        channel: parsed.updater.channel ?? "stable",
        crash_threshold: parsed.updater.crash_threshold ?? 3,
      }
    : undefined;

  if (updater?.enabled && !updater.pubkey) {
    throw new ConfigError(
      `[updater] is enabled but has no "pubkey". Generate one with \`carbon signer generate\`.`,
      path,
    );
  }

  return {
    app: {
      name: app.name,
      version: app.version,
      display_name: app.display_name,
      dev_url: app.dev_url,
    },
    runtime: {
      backend,
      bytecode: Boolean(parsed.runtime?.bytecode ?? false),
      image: Boolean(parsed.runtime?.image ?? false),
      audio: Boolean(parsed.runtime?.audio ?? false),
      network: Boolean(parsed.runtime?.network ?? true),
      svg: Boolean(parsed.runtime?.svg ?? true),
    },
    updater,
    raw: parsed,
  };
}

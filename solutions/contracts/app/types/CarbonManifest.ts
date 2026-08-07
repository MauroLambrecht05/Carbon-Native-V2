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
    },
    updater,
    raw: parsed,
  };
}

// Where a project manifest comes from.
//
// The interface is domain's, the implementation is infrastructure's. Today
// there is one — TOML on disk — but the seam is what lets a use case be given
// a manifest from a fixture, a remote descriptor, or an in-memory literal.

import type { CarbonConfig } from "@carbon/contracts/app";

export interface ManifestRepository {
  /** Absolute path a project's manifest would occupy, whether or not it exists. */
  pathFor(projectDir: string): string;
  exists(projectDir: string): boolean;
  /** Throws ConfigError when absent, unparseable, or invalid. */
  load(projectDir: string): CarbonConfig;
}

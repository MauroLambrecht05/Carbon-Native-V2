import type { Plugin } from "vite";

export interface CarbonDevOptions {
  /** Inject the error-overlay shim. Default: true. */
  errorOverlay?: boolean;
  /** Inject the HMR helper. Default: true. */
  hmr?: boolean;
  /** Inject `__CARBON_DEV` + `__carbonDebug` globals. Default: true. */
  globals?: boolean;
  /** Log per-file injections. Default: false. */
  debug?: boolean;
  /** Override auto-detect of dev vs prod. */
  forceMode?: "dev" | "prod";
}

/**
 * Vite plugin that injects dev-only glue (error overlay shim, HMR helper,
 * `__CARBON_DEV` flag) into the bundle entry. No-op in production builds.
 */
export function carbonDev(options?: CarbonDevOptions): Plugin;

export default carbonDev;

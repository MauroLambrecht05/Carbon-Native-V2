import type { Plugin } from "vite";

export interface CarbonFastImportOptions {
  /** Log every file we rewrite. */
  debug?: boolean;
  /** Inject `globalThis.__cm_register_math?.()` at the top of the first
   *  rewritten module. Default: true. */
  injectInit?: boolean;
  /** Additional named exports to also rewrite (e.g. for three.js forks
   *  that expose extra math classes). */
  extraNames?: string[];
}

export function carbonFastImport(options?: CarbonFastImportOptions): Plugin;
export default carbonFastImport;

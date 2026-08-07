import type { Plugin } from "vite";

export interface InkShimOptions {
  /** Log per-file rewrites to stdout. Default: false. */
  debug?: boolean;
  /**
   * Extra package → target pairs as alternating ["source","target"] elements.
   * e.g. ["ink-foo", "@carbon/term", "my-ink-lib", "my-shim"]
   */
  extraRewrites?: string[];
}

/**
 * Vite plugin that rewrites `import ... from 'ink'` to
 * `import ... from '@carbon/term'` at module-resolution time.
 *
 * Also provides virtual stubs for common Ink companion packages:
 *   - ink-spinner
 *   - ink-select-input
 *   - ink-text-input
 */
export function inkShim(options?: InkShimOptions): Plugin;

export default inkShim;

import type { Plugin } from "vite";

export interface CarbonAssetsOptions {
  /** Log per-file routing decisions to stdout. Default: false. */
  debug?: boolean;
  /** Additional extensions that should be inlined as text. With or without a leading dot. */
  extraTextExtensions?: string[];
}

/**
 * Vite plugin that handles non-JS asset imports for carbon apps.
 *
 *   `import src from './shader.wgsl'`  → shader source as string
 *   `import logo from './logo.png'`    → URL string into dist/assets/ (Vite default)
 */
export function carbonAssets(options?: CarbonAssetsOptions): Plugin;

export const TEXT_ASSET_EXTENSIONS: ReadonlySet<string>;
export const IMAGE_ASSET_EXTENSIONS: ReadonlySet<string>;

export default carbonAssets;

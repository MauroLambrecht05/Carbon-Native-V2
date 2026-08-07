// Types for the three-bridge Babel plugin.
//
// The plugin itself stays JavaScript because Babel plugins are loaded by Babel
// at runtime, not compiled with the rest of the tree. This declaration is what
// lets a TypeScript consumer — @carbon/bundling, which registers it in the
// Bun.build path — import it without falling back to `any`.

/** Babel's plugin API object, passed as the first argument. */
export interface BabelPluginApi {
  assertVersion(range: string | number): void;
  types: unknown;
  [key: string]: unknown;
}

export interface ThreeBridgeOptions {
  /**
   * Components whose JSX subtree compiles for the three-fiber renderer rather
   * than the outer mini-solid one. Defaults to `["Canvas"]`.
   */
  bridgeComponents?: string[];
  debug?: boolean;
}

/** The shape Babel expects back from a plugin factory. */
export interface BabelPlugin {
  name?: string;
  visitor: Record<string, unknown>;
  [key: string]: unknown;
}

export default function carbonThreeBridgeBabel(
  api: BabelPluginApi,
  opts?: ThreeBridgeOptions,
): BabelPlugin;

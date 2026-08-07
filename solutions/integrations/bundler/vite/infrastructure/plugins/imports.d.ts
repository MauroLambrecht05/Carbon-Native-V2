import type { Plugin } from "vite";

export interface CarbonImportsOptions {
  /** Log per-file rewrites + manifest discovery. Default: false. */
  debug?: boolean;
  /** Override path to carbon.toml. Default: <project root>/carbon.toml. */
  carbonToml?: string;
  /** Override workspace root for `packages/*` manifest discovery. */
  workspaceRoot?: string;
  /** Disable the build-time capability validation pass. Default: false. */
  skipCapabilityCheck?: boolean;
  /** Extra `carbon:*` specifier → exports map. Each export is a name string. */
  extraModules?: Record<string, string[]>;
}

/**
 * Vite plugin that resolves `import 'carbon:*'` specifiers as virtual modules
 * re-exporting runtime globals installed by carbon native plugins, plus a
 * build-time capability validation pass tied to carbon.toml `[plugins]`.
 */
export function carbonImports(options?: CarbonImportsOptions): Plugin;

export const BUILTIN_MODULES: Record<
  string,
  Array<{ name: string; global: string }>
>;
export const BUILTIN_SPECIFIERS: Set<string>;
export function pluginNameOf(specifier: string): string | null;

export default carbonImports;

// Ambient declarations for the Babel packages the Bun.build path loads.
//
// None of these ship types, and only @babel/core has a usable @types package.
// Rather than add a dependency that covers one of four, they are declared here
// — next to BunBundler, the only file that imports them.
//
// The declarations are intentionally loose. BunBundler loads these lazily and
// immediately casts the results, because it uses them as opaque handles it
// passes back to Babel:
//
//     const [core, solidMod] = await Promise.all([...]);
//     transformSync = (core as any).transformSync;
//
// So a precise type would buy nothing real, and pretending to a precision we
// have not verified against the actual packages would be worse than `unknown`.
// What these DO buy is the error that matters: a typo in a specifier is now a
// missing-module error instead of silently resolving to `any`.

declare module "@babel/core" {
  /** Transforms source, synchronously. Options are Babel's own config shape. */
  export function transformSync(
    code: string,
    options?: Record<string, unknown>,
  ): { code?: string | null; map?: unknown } | null;

  const babel: Record<string, unknown>;
  export default babel;
}

declare module "babel-preset-solid" {
  /** A Babel preset factory. Passed straight into `presets: [...]`. */
  const preset: (api: unknown, options?: Record<string, unknown>) => unknown;
  export default preset;
}

declare module "@babel/preset-react" {
  const preset: (api: unknown, options?: Record<string, unknown>) => unknown;
  export default preset;
}

declare module "@babel/preset-typescript" {
  const preset: (api: unknown, options?: Record<string, unknown>) => unknown;
  export default preset;
}

declare module "react-refresh/babel" {
  /** A Babel plugin factory. Passed straight into `plugins: [...]`. */
  const plugin: (api: unknown, options?: Record<string, unknown>) => unknown;
  export default plugin;
}

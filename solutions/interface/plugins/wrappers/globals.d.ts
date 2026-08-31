// Ambient declarations for what this package's wrappers assume exist, but
// that `solutions/tsconfig.json` doesn't otherwise know about — deliberately
// narrow, not a `"lib": ["DOM"]` addition (see that tsconfig's own comment on
// why: DOM would make a stray `document.` compile everywhere in the tree,
// not just here).
//
// `carbon:*` — bundler-resolved virtual modules (see solutions/integrations/
// bundler/vite's import-rewriting), one per installed plugin's raw bridge
// (`carbon:fonts`, `carbon:clipboard`, …). Never a real file on disk, so TS
// has nothing to resolve without this — `any`-typed rather than hand-written
// per plugin because the real shape already lives, checked, in each
// plugin's own carbon-plugin.toml `[exports]` table and the Zig source that
// implements it; duplicating it here as TS types would be a second copy of
// that agreement, exactly what this codebase avoids elsewhere.
declare module "carbon:*";

// requestAnimationFrame/cancelAnimationFrame — real globals the runtime
// provides (run_loop.rs drains the rAF queue every redraw frame), not a
// browser environment. Signatures match the DOM ones these wrappers were
// written against.
declare function requestAnimationFrame(callback: (time: number) => void): number;
declare function cancelAnimationFrame(handle: number): void;

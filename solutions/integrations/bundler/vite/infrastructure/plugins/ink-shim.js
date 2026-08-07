// @carbon/vite/ink-shim — at module-resolution time, rewrites
// `import ... from 'ink'` (and common Ink companion packages) to resolve from
// `@carbon/term` instead.
//
// Why this works:
//   Ink's public API (Box, Text, useInput, useApp, …) is 1:1 mirrored in
//   @carbon/term. The shim just changes the *source* of the import; all
//   exported names are preserved. Zero source changes required in existing Ink
//   apps.
//
// Companion packages:
//   - ink-spinner        → stub component that emits a static "⠋" spinner
//                          character and warns once at load time.
//   - ink-select-input   → stub component; logs warning + renders a text list.
//   - ink-text-input     → re-export useInput + a minimal Text-based stub.
//
// Pattern mirrors packages/carbon-fast-import/src/index.js.

/** Packages we intercept + where they route. */
const REWRITES = new Map([
  ["ink", "@carbon/term"],
]);

/** Companion packages get a virtual stub module instead of a real package. */
const COMPANION_STUBS = new Set([
  "ink-spinner",
  "ink-select-input",
  "ink-text-input",
]);

// Virtual module ids (prefixed to avoid clashes with real ids).
const VIRTUAL_PREFIX = "\0carbon-ink-shim:";

/**
 * @param {object} [options]
 * @param {boolean} [options.debug]            Log per-file rewrites. Default: false.
 * @param {string[]} [options.extraRewrites]   Extra pkg → target pairs as ["ink-foo","@carbon/term"].
 * @returns {import('vite').Plugin}
 */
export function inkShim(options = {}) {
  const { debug = false, extraRewrites = [] } = options;

  // Merge extra rewrites (pairs of [source, target]).
  const rewrites = new Map(REWRITES);
  for (let i = 0; i + 1 < extraRewrites.length; i += 2) {
    rewrites.set(extraRewrites[i], extraRewrites[i + 1]);
  }

  return {
    name: "@carbon/vite/ink-shim",
    enforce: "pre",

    // ── resolveId: intercept bare specifiers ─────────────────────────────
    resolveId(source) {
      // Direct rewrite: ink → @carbon/term.
      if (rewrites.has(source)) {
        const target = rewrites.get(source);
        if (debug) {
          console.log(`[carbon-ink-shim] resolveId: '${source}' → '${target}'`);
        }
        // Return null so Vite resolves the target naturally through node_modules.
        // We handle this in the transform hook instead, which is simpler for
        // named-export passthrough.
        return null; // resolved below via transform
      }

      // Companion stubs: return a virtual module id.
      if (COMPANION_STUBS.has(source)) {
        const vid = VIRTUAL_PREFIX + source;
        if (debug) {
          console.log(`[carbon-ink-shim] resolveId: '${source}' → virtual stub`);
        }
        return vid;
      }

      return null;
    },

    // ── load: serve virtual stub modules ─────────────────────────────────
    load(id) {
      if (!id.startsWith(VIRTUAL_PREFIX)) return null;
      const pkg = id.slice(VIRTUAL_PREFIX.length);

      if (pkg === "ink-spinner") {
        // Spinner: static character, one-time console.warn.
        return `
import { Text } from '@carbon/term';
let _warned = false;
export function Spinner({ type = 'dots' }) {
  if (!_warned) {
    _warned = true;
    console.warn('[carbon-ink-shim] ink-spinner is not supported; showing static spinner character.');
  }
  return Text({ children: '⠋' });
}
export default Spinner;
`;
      }

      if (pkg === "ink-select-input") {
        // SelectInput: renders items as a plain text list, warns once.
        return `
import { Box, Text } from '@carbon/term';
let _warned = false;
export function SelectInput({ items = [], onSelect, isFocused = true }) {
  if (!_warned) {
    _warned = true;
    console.warn('[carbon-ink-shim] ink-select-input is a stub; use useInput + custom rendering for full behavior.');
  }
  return Box({
    flexDirection: 'column',
    children: (items || []).map((item, i) =>
      Text({ key: item.value ?? i, children: (isFocused && i === 0 ? '> ' : '  ') + (item.label ?? String(item.value)) })
    )
  });
}
export default SelectInput;
`;
      }

      if (pkg === "ink-text-input") {
        // TextInput: basic controlled-input stub backed by useInput.
        return `
import { Box, Text, useInput } from '@carbon/term';
let _warned = false;
export function TextInput({ value = '', placeholder = '', onChange, onSubmit, focus = true }) {
  if (!_warned) {
    _warned = true;
    console.warn('[carbon-ink-shim] ink-text-input is a basic stub; only printable chars + backspace + enter handled.');
  }
  useInput((ch, key) => {
    if (!focus) return;
    if (key.return) { onSubmit?.(value); return; }
    if (key.backspace) { onChange?.(value.slice(0, -1)); return; }
    if (!key.ctrl && !key.meta && ch.length === 1) { onChange?.(value + ch); }
  }, { isActive: focus });
  const display = value.length > 0 ? value : placeholder;
  return Text({ children: display });
}
export default TextInput;
`;
      }

      return null;
    },

    // ── transform: rewrite `from 'ink'` in source files ─────────────────
    transform(code, id) {
      // Skip node_modules; don't touch real Ink internals.
      if (id.includes("node_modules")) return null;
      if (!/\.(tsx|ts|jsx|js|mjs)$/.test(id)) return null;

      let out = code;
      let changed = false;

      for (const [source, target] of rewrites) {
        // Match both double and single quotes.
        const re = new RegExp(`(from\\s+)(["'])${escapeRegex(source)}\\2`, "g");
        if (!re.test(out)) continue;
        out = out.replace(
          new RegExp(`(from\\s+)(["'])${escapeRegex(source)}\\2`, "g"),
          (_, from, q) => `${from}${q}${target}${q}`,
        );
        changed = true;
        if (debug) {
          console.log(`[carbon-ink-shim] transform: '${source}' → '${target}' in ${id}`);
        }
      }

      return changed ? { code: out, map: null } : null;
    },
  };
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export default inkShim;

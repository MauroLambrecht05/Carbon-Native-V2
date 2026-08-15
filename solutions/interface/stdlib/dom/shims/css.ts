// Minimal CSS stylesheet engine — the cascade primitive for carbon-mini.
//
// carbon-mini applies INLINE styles (style.x = …) and Tailwind classes to
// scene nodes, but had no notion of author stylesheets: `<style>` rules and
// imported `.css` files were ignored. Many unmodified npm packages ship a
// stylesheet (xterm.js's xterm.css positions its canvas render layers,
// CodeMirror, Radix, etc.) — without applying it they render broken.
//
// This engine parses CSS into rules and applies matched declarations to
// scene nodes via the same __cm_set_prop path inline styles use (the
// runtime normalises CSS prop names). Selector support is the practical
// subset real component CSS uses: selector lists (`,`), descendant (` `)
// and child (`>`) combinators, and compound selectors built from a tag,
// `#id`, `.class`es, and `*`. Pseudo-classes/elements and attribute
// selectors are stripped (the rule still matches on the rest), except
// `:hover` which would need runtime state we don't track here.
//
// Rules are (re)applied to a node when it's inserted and when its class/id
// changes; registering a new stylesheet re-applies to all live nodes.

declare const __cm_set_prop: (id: number, key: string, valueJson: string) => void;
declare const __cm_request_paint: () => void;

type Decl = Record<string, string>;
interface Simple { tag: string | null; id: string | null; classes: string[]; universal: boolean; }
interface Compound { sel: Simple; comb: " " | ">" | null; } // comb links to the compound on its LEFT
interface Rule { compounds: Compound[]; decls: Decl; spec: number; order: number; source: number; }

let RULES: Rule[] = [];
let ORDER = 0;
let SOURCE = 0;
// Per-source rule generations: a `<style>` element whose textContent updates
// (e.g. xterm's per-resize dimension stylesheet) re-registers with the SAME
// source id; we drop its previous rules instead of accumulating, otherwise
// RULES grows without bound and re-apply turns into a storm.
const SOURCE_KEYS = new Map<string, number>();

const ELEMENT_NODE = 1;

// ── parsing ─────────────────────────────────────────────────────────────────
function parseSimple(text: string): Simple {
  const s: Simple = { tag: null, id: null, classes: [], universal: false };
  // Strip pseudo-classes/elements and attribute selectors — match on the rest.
  let t = text.replace(/::?[A-Za-z-]+(\([^)]*\))?/g, "").replace(/\[[^\]]*\]/g, "");
  const re = /([.#]?)([A-Za-z0-9_-]+|\*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    const [, kind, name] = m;
    if (kind === ".") s.classes.push(name);
    else if (kind === "#") s.id = name;
    else if (name === "*") s.universal = true;
    else s.tag = name.toLowerCase();
  }
  return s;
}

function parseSelector(sel: string): Compound[] | null {
  // Tokenise into compounds + combinators. e.g. ".a > .b .c"
  const parts: Compound[] = [];
  const tokens = sel.trim().split(/\s+/);
  let pendingComb: " " | ">" | null = null;
  let first = true;
  for (const tok of tokens) {
    if (tok === ">") { pendingComb = ">"; continue; }
    if (tok === "+" || tok === "~") return null; // sibling combinators unsupported
    parts.push({ sel: parseSimple(tok), comb: first ? null : (pendingComb ?? " ") });
    pendingComb = null;
    first = false;
  }
  return parts.length ? parts : null;
}

function specificity(compounds: Compound[]): number {
  let a = 0, b = 0, c = 0;
  for (const cc of compounds) {
    if (cc.sel.id) a++;
    b += cc.sel.classes.length;
    if (cc.sel.tag) c++;
  }
  return a * 10000 + b * 100 + c;
}

/** Parse a CSS string into rules and add to the global sheet. `sourceKey`
 *  identifies a re-registerable source (e.g. a `<style>` element's id) — a
 *  repeat call with the same key replaces that source's previous rules. */
export function registerStylesheet(css: string, sourceKey?: string): void {
  if (typeof css !== "string" || css.length === 0) return;
  // Replace prior rules from this source (idempotent re-registration).
  let source: number;
  if (sourceKey != null) {
    const existing = SOURCE_KEYS.get(sourceKey);
    if (existing != null) {
      source = existing;
      const before = RULES.length;
      RULES = RULES.filter((r) => r.source !== source);
      if (RULES.length === before) {
        // nothing removed — but we still re-add below; that's fine.
      }
    } else {
      source = ++SOURCE;
      SOURCE_KEYS.set(sourceKey, source);
    }
  } else {
    source = ++SOURCE;
  }
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  let i = 0;
  const n = clean.length;
  while (i < n) {
    // skip whitespace
    while (i < n && /\s/.test(clean[i])) i++;
    if (i >= n) break;
    // @-rules: skip @media/@keyframes/@supports blocks and @import; — we
    // don't model media queries, just drop them rather than mis-parse.
    if (clean[i] === "@") {
      // skip to matching block or ';'
      let depth = 0;
      while (i < n) {
        const ch = clean[i++];
        if (ch === "{") depth++;
        else if (ch === "}") { if (--depth <= 0) break; }
        else if (ch === ";" && depth === 0) break;
      }
      continue;
    }
    // read selector list up to '{'
    const selStart = i;
    while (i < n && clean[i] !== "{") i++;
    if (i >= n) break;
    const selectorList = clean.slice(selStart, i).trim();
    i++; // skip '{'
    const declStart = i;
    while (i < n && clean[i] !== "}") i++;
    const declBlock = clean.slice(declStart, i);
    i++; // skip '}'
    const decls = parseDecls(declBlock);
    if (Object.keys(decls).length === 0) continue;
    for (const sel of selectorList.split(",")) {
      const compounds = parseSelector(sel);
      if (!compounds) continue;
      RULES.push({ compounds, decls, spec: specificity(compounds), order: ORDER++, source });
    }
  }
  // Re-apply to all live nodes — a sheet may register after nodes exist.
  const reg = (globalThis as any).__cm_node_registry as Map<number, any> | undefined;
  if (reg) for (const node of reg.values()) applyStylesheetTo(node, false);
  __cm_request_paint();
}

function parseDecls(block: string): Decl {
  const out: Decl = {};
  for (const decl of block.split(";")) {
    const idx = decl.indexOf(":");
    if (idx < 0) continue;
    const prop = decl.slice(0, idx).trim();
    if (!prop) continue;
    let value = decl.slice(idx + 1).trim();
    value = value.replace(/\s*!important\s*$/i, "");
    if (value.length) out[prop] = value;
  }
  return out;
}

// ── matching ─────────────────────────────────────────────────────────────────
function compoundMatches(node: any, s: Simple): boolean {
  if (!node || node.nodeType !== ELEMENT_NODE) return false;
  // A compound that reduced to nothing (e.g. a bare `:root` / `::selection`
  // we stripped) must NOT match every element. Only an explicit `*` is a
  // universal match.
  if (!s.tag && !s.id && s.classes.length === 0 && !s.universal) return false;
  if (s.tag && (node.tagName ? node.tagName.toLowerCase() : "") !== s.tag) return false;
  if (s.id && node.id !== s.id) return false;
  if (s.classes.length) {
    const cls = " " + (node.className || "") + " ";
    for (const c of s.classes) if (!cls.includes(" " + c + " ")) return false;
  }
  return true;
}

function selectorMatches(node: any, compounds: Compound[]): boolean {
  const last = compounds.length - 1;
  if (!compoundMatches(node, compounds[last].sel)) return false;
  let cur = node;
  for (let k = last; k >= 1; k--) {
    const comb = compounds[k].comb; // links compounds[k-1] (left) to compounds[k]
    const leftSel = compounds[k - 1].sel;
    if (comb === ">") {
      cur = cur.parentNode;
      if (!compoundMatches(cur, leftSel)) return false;
    } else {
      cur = cur ? cur.parentNode : null;
      let found = false;
      while (cur) {
        if (compoundMatches(cur, leftSel)) { found = true; break; }
        cur = cur.parentNode;
      }
      if (!found) return false;
    }
  }
  return true;
}

function matchedDecls(node: any): Decl {
  if (RULES.length === 0) return {};
  const hits: Rule[] = [];
  for (const r of RULES) if (selectorMatches(node, r.compounds)) hits.push(r);
  if (hits.length === 0) return {};
  hits.sort((a, b) => a.spec - b.spec || a.order - b.order);
  const out: Decl = {};
  for (const h of hits) Object.assign(out, h.decls);
  return out;
}

/** Apply matched stylesheet declarations to a node (and optionally its
 *  subtree). Called on insert and on class/id changes. */
export function applyStylesheetTo(node: any, recurse = true): void {
  if (RULES.length === 0) return;
  if (node && node.nodeType === ELEMENT_NODE && typeof node.cmId === "number") {
    const decls = matchedDecls(node);
    for (const prop in decls) {
      try { __cm_set_prop(node.cmId, prop, JSON.stringify(decls[prop])); } catch { /* ignore */ }
    }
  }
  if (recurse && node && node.childNodes) {
    for (const c of node.childNodes) applyStylesheetTo(c, true);
  }
}

export function hasStylesheets(): boolean {
  return RULES.length > 0;
}

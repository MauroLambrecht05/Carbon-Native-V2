// Reading and editing the [plugins] table of a carbon.toml, as text.
//
// ── WHY NOT A TOML LIBRARY ──────────────────────────────────────────────────
// Because this edits a file a human owns. A parse-and-reserialise round trip
// through a TOML library rewrites the whole document: comments vanish, key
// order is normalised, string quoting changes. `carbon plugin install` would
// then show up in a diff as a rewrite of the user's entire config, and that is
// a bad trade for adding one line.
//
// So these are line operations, and the invariant is: every line the caller did
// not ask to change comes out byte-identical.
//
// The parsing is correspondingly shallow — it understands `key = "value"`
// inside `[plugins]`, and nothing else. That is the whole schema of the
// section. Anything more (inline tables, sub-tables) is left alone rather than
// half-understood.

export interface PluginEntry {
  readonly name: string;
  /** Path as written, relative to the carbon.toml. */
  readonly path: string;
}

const SECTION = "[plugins]";

function isSectionHeader(line: string): boolean {
  const t = line.trim();
  return t.startsWith("[") && t.endsWith("]");
}

/** Every plugin declared in the section. Empty when there is no section. */
export function readPluginEntries(toml: string): PluginEntry[] {
  const entries: PluginEntry[] = [];
  let inSection = false;

  for (const raw of toml.split("\n")) {
    const line = raw.trim();
    if (isSectionHeader(line)) {
      inSection = line === SECTION;
      continue;
    }
    if (!inSection || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const name = line.slice(0, eq).trim();
    const path = line.slice(eq + 1).trim().replace(/^"|"$/g, "");
    if (name && path) entries.push({ name, path });
  }

  return entries;
}

/**
 * Adds or replaces one entry, leaving every other line untouched.
 *
 * Three cases, in the order they are checked:
 *   1. the name is already in [plugins] — that line is replaced in place, so
 *      reinstalling a plugin updates its path rather than duplicating the key
 *      (duplicate keys are a TOML parse error, i.e. a broken project);
 *   2. the section exists — the entry is appended at its end, before whatever
 *      section follows;
 *   3. no section — one is appended to the document.
 */
export function upsertPluginEntry(toml: string, entry: PluginEntry): string {
  const keyLine = `${entry.name} = "${entry.path}"`;
  const lines = toml.split("\n");

  const start = lines.findIndex((l) => l.trim() === SECTION);
  if (start === -1) {
    let out = toml;
    if (out && !out.endsWith("\n")) out += "\n";
    return `${out}\n${SECTION}\n${keyLine}\n`;
  }

  // The section runs until the next header, or to the end of the file.
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (isSectionHeader(lines[i])) {
      end = i;
      break;
    }
  }

  const prefix = `${entry.name} =`;
  for (let i = start + 1; i < end; i++) {
    if (lines[i].trimStart().startsWith(prefix)) {
      lines[i] = keyLine;
      return lines.join("\n");
    }
  }

  lines.splice(end, 0, keyLine);
  return lines.join("\n");
}

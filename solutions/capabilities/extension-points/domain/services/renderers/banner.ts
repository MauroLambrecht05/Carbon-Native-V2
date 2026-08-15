// The banner every generated artifact carries, and the comment wrapper the
// renderers share.
//
// The banner is not decoration: `carbon ext check` re-renders each artifact
// and compares it byte for byte, so the first thing anyone opening a generated
// file needs to know is that editing it will be reverted by the next check.

export const GENERATED_BANNER: readonly string[] = [
  "GENERATED — DO NOT EDIT.",
  "",
  "Source of truth: solutions/contracts/plugin/registry/extension-points.zig",
  "Regenerate:      carbon ext generate",
  "Verified by:     .tools/validation/check_extension_points.py",
];

/**
 * Wrap prose to `width`, preserving the author's paragraph breaks and never
 * splitting a word.
 *
 * The docs in the registry are written as Zig multi-line strings with their
 * own line breaks; those breaks are the author's and are kept. This only
 * rewraps lines that are too long for the target language's comment column.
 */
export function wrapComment(text: string, width: number): string[] {
  const out: string[] = [];

  for (const paragraph of text.split("\n")) {
    if (paragraph.trim() === "") {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of paragraph.split(/\s+/)) {
      if (line === "") {
        line = word;
      } else if (line.length + 1 + word.length <= width) {
        line += ` ${word}`;
      } else {
        out.push(line);
        line = word;
      }
    }
    if (line !== "") out.push(line);
  }

  // Trailing blank lines add nothing to a comment block and make the diff
  // between two renderings noisier than the change that caused it.
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
}

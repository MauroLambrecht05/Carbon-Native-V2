// One-shot script: subset Roboto-Regular.ttf to ASCII printable + a few common
// punctuation/arrow code points, write the result to disk. Uses subset-font
// (which wraps harfbuzz's hb-subset → handles cmap correctly).
//
// Run once after updating Roboto-Regular; commit the output.
//
//   bun /tmp/subset-roboto.mjs
//   → writes carbon-native/runtimes/mini/assets/Roboto-Regular-Latin.ttf

import subsetFont from "subset-font";
import { readFile, writeFile } from "node:fs/promises";

const SRC =
  "C:/Users/mauro/Desktop/electrobun-bench/carbon-native/runtimes/mini/assets/Roboto-Regular.ttf";
const DST =
  "C:/Users/mauro/Desktop/electrobun-bench/carbon-native/runtimes/mini/assets/Roboto-Regular-Latin.ttf";

// Codepoints we want to keep:
//   0x20-0x7E   ASCII printable (space..tilde)
//   0xA0        non-breaking space
//   0x2013/14   en/em dashes
//   0x2018-1B   smart quotes
//   0x2022      bullet
//   0x2026      ellipsis
//   0xD7        ×  (multiplication / close UI affordance)
//   0x2190-93   ← → ↑ ↓
const text =
  // ASCII printable
  Array.from({ length: 0x7e - 0x20 + 1 }, (_, i) => String.fromCharCode(0x20 + i)).join("") +
  // Extras
  " –—‘’“”•…×←→↑↓";

const buf = await readFile(SRC);
const subset = await subsetFont(buf, text, { targetFormat: "truetype" });
await writeFile(DST, subset);
console.log(
  `subset: ${SRC} (${buf.length} B) -> ${DST} (${subset.length} B; ${(((buf.length - subset.length) / buf.length) * 100).toFixed(1)}% reduction)`,
);

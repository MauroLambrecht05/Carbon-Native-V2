# Font licenses

These files are compiled into every `carbon-mini` binary via `include_bytes!`
(see `../src/text.rs`), which means they are redistributed to every end user of
every app built with carbon. Their licenses ship with them.

| File | Family | License | Full text |
|---|---|---|---|
| `Inter-Regular.ttf` | Inter | SIL Open Font License 1.1 | [`LICENSE-Inter.txt`](./LICENSE-Inter.txt) |
| `Inter-Medium.ttf` | Inter | SIL Open Font License 1.1 | [`LICENSE-Inter.txt`](./LICENSE-Inter.txt) |
| `Inter-SemiBold.ttf` | Inter | SIL Open Font License 1.1 | [`LICENSE-Inter.txt`](./LICENSE-Inter.txt) |
| `Inter-Bold.ttf` | Inter | SIL Open Font License 1.1 | [`LICENSE-Inter.txt`](./LICENSE-Inter.txt) |
| `Roboto-Regular.ttf` | Roboto | Apache License 2.0 | [`LICENSE-Roboto.txt`](./LICENSE-Roboto.txt) |
| `Roboto-Regular-Latin.ttf` | Roboto (Latin subset) | Apache License 2.0 | [`LICENSE-Roboto.txt`](./LICENSE-Roboto.txt) |

- **Inter** — Copyright 2016 The Inter Project Authors
  (<https://github.com/rsms/inter>). OFL-1.1 permits bundling and
  redistribution, including inside a binary, provided the license travels with
  the font and the font is not sold on its own.
- **Roboto** — Copyright 2011 Google Inc. Apache-2.0, the same license carbon
  itself uses.

`Roboto-Regular-Latin.ttf` is a subset generated from `Roboto-Regular.ttf` with
harfbuzz's `hb-subset`; regenerate it with `scripts/fonts/subset-roboto.mjs`. A
subset is a derivative work and carries the same license as its source.

`just check-boundaries` fails if a font lands in this directory without a
license file beside it.

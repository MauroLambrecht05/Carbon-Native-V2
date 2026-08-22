// A plugin's name, in the three forms the toolchain needs.
//
// These differ, and mixing them up is the classic plugin bug: a plugin named
// "my-thing" produces a Rust crate `my_thing`, which produces `libmy_thing.so`.
// Deriving all three from one place is what keeps the manifest, the build
// output and the install step pointing at the same file.

export class PluginName {
  private constructor(
    /** As written in carbon.toml and on disk: lowercase, hyphenated. */
    readonly slug: string,
    /** Rust/Zig identifier form — hyphens are not legal in either. */
    readonly crate: string,
  ) {}

  static from(input: string): PluginName {
    const slug = slugify(input);
    return new PluginName(slug, slug.replaceAll("-", "_"));
  }

  /**
   * The shared-library filename the build produces on this platform.
   *
   * Rust and Zig agree here — both follow the platform convention — so one
   * function covers both languages.
   */
  libraryFilename(platform: NodeJS.Platform = process.platform): string {
    if (platform === "win32") return `${this.crate}.dll`;
    if (platform === "darwin") return `lib${this.crate}.dylib`;
    return `lib${this.crate}.so`;
  }
}

function slugify(s: string): string {
  let out = "";
  let lastDash = true;
  for (const ch of s) {
    if (/[A-Za-z0-9]/.test(ch)) {
      out += ch.toLowerCase();
      lastDash = false;
    } else if (!lastDash) {
      out += "-";
      lastDash = true;
    }
  }
  while (out.endsWith("-")) out = out.slice(0, -1);
  return out || "carbon-plugin";
}

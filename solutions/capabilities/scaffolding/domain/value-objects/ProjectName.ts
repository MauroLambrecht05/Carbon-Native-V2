// A project name, in the two forms everything downstream needs.
//
// `carbon init "My Cool App"` has to produce a directory name, a package name
// and a window title, and they are not the same string. Deriving both once,
// here, is what stops the manifest and the package.json disagreeing about what
// the project is called.

export class ProjectName {
  private constructor(
    /** Filesystem- and npm-safe: lowercase, hyphen-separated. */
    readonly slug: string,
    /** Title-cased, for the window title and the generated App.tsx. */
    readonly display: string,
  ) {}

  static from(input: string): ProjectName {
    const slug = slugify(input);
    return new ProjectName(slug, humanize(slug));
  }
}

/**
 * Collapses anything into a-z0-9 and single hyphens.
 *
 * Runs of non-alphanumerics become one hyphen and trailing hyphens are dropped,
 * so "My Cool App!!" and "my--cool--app" both land on "my-cool-app". An input
 * with nothing alphanumeric in it at all still has to yield a usable directory
 * name, hence the fallback.
 */
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
  return out || "carbon-app";
}

/** "my-cool-app" -> "My Cool App". */
function humanize(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

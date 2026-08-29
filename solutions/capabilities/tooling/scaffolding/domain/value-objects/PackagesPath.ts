// The relative path from a new project back to the workspace root.
//
// A generated package.json depends on the runtime and the build plugins with
// `file:` specifiers, and `file:` is resolved relative to the project. So the
// templates need to know how far up the workspace root is.
//
// ── ONE PLACEHOLDER, NOT SEVERAL ────────────────────────────────────────────
// Templates say `file:@@ROOT@@/solutions/interface/renderer/solid`. The
// alternative — a placeholder per dependency, or paths like
// `@@PACKAGES@@/../../../integrations/...` — puts the same arithmetic in five
// template strings, and each of those breaks silently when a package moves.
// One placeholder means a move changes the literal path in the template, where
// it is readable.
//
// V1 pointed these at `<root>/packages/mini-runtime`, a directory that has not
// existed since the migration, so every scaffolded project failed
// `bun install` on a missing @carbon/mini-solid.
//
// `file:` rather than a published version because nothing is published yet.
// When it is, these become version ranges and this arithmetic goes away.

/**
 * How many `../` it takes to get from `target` up to `root`.
 *
 * Case-insensitive because Windows paths compare that way, and split on both
 * separators for the same reason.
 *
 * @throws if target is not inside root — a `file:` dependency cannot reach it.
 */
export function workspaceRelativeTo(target: string, root: string): string {
  // Both inputs are assumed already absolute (resolve()'d by the caller).
  const targetParts = target.toLowerCase().split(/[\\/]+/).filter(Boolean);
  const rootParts = root.toLowerCase().split(/[\\/]+/).filter(Boolean);

  if (targetParts.length < rootParts.length) {
    throw new Error(`target ${target} is shallower than carbon root ${root}`);
  }

  let common = 0;
  while (common < rootParts.length && targetParts[common] === rootParts[common]) common++;
  if (common !== rootParts.length) {
    throw new Error(`target ${target} is not inside carbon root ${root}`);
  }

  const depth = targetParts.length - common;
  // A project AT the root would be odd, but "." is the honest answer.
  return depth === 0 ? "." : Array(depth).fill("..").join("/");
}

/**
 * Like workspaceRelativeTo, but never throws.
 *
 * Returns:
 *   { kind: "relative", path: "../../.." }  — target is inside root (normal case)
 *   { kind: "absolute", path: "/abs/path" } — target is outside root (standalone / global install)
 *
 * The caller decides what to do with each kind. The scaffolding layer uses
 * "relative" for tsconfig paths (portable, survives the repo being moved) and
 * "absolute" for standalone projects where there is no relative path that works.
 */
export type WorkspacePath =
  | { kind: "relative"; path: string }
  | { kind: "absolute"; path: string };

export function workspacePathFrom(target: string, root: string): WorkspacePath {
  try {
    return { kind: "relative", path: workspaceRelativeTo(target, root) };
  } catch {
    // Normalise to forward slashes so the tsconfig path works on Windows too.
    return { kind: "absolute", path: root.replace(/\\/g, "/") };
  }
}

/**
 * Kept as the old name so nothing outside this capability had to change when
 * the meaning shifted from "path to packages/" to "path to the workspace root".
 *
 * @deprecated use workspaceRelativeTo
 */
export const packagesRelativeTo = workspaceRelativeTo;

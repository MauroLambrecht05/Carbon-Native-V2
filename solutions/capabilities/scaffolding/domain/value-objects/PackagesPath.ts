// The relative path from a new project back to the workspace's packages/ dir.
//
// ── KNOWN BROKEN, PRESERVED DELIBERATELY ────────────────────────────────────
// The generated package.json pins the runtime as `file:<this>/mini-runtime`.
// There has been no packages/ directory since V1, so `bun install` in a freshly
// scaffolded project fails to resolve @carbon/mini-solid.
//
// This is carried over unchanged rather than fixed, because fixing it is a
// decision about how V2 publishes its runtime — workspace protocol, a Bazel
// output path, or actually publishing to npm — and that decision has not been
// made. Silently pointing the templates somewhere that happens to exist today
// would bury the question. When it is answered, this file and the package
// templates are the two places to change.
//
// The path arithmetic itself is correct and tested; it is the destination that
// does not exist.

/**
 * How many `../` it takes to get from `target` to `<root>/packages`.
 *
 * Case-insensitive because Windows paths compare that way, and split on both
 * separators for the same reason.
 *
 * @throws if target is not inside root — a `file:` dependency cannot reach it.
 */
export function packagesRelativeTo(target: string, root: string): string {
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
  if (depth === 0) return "./packages";
  return Array(depth).fill("..").join("/") + "/packages";
}

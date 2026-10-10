// Version ordering for updates: Semantic Versioning 2.0.0 precedence.
//
// Every consumer of an update manifest must order versions the same way, or
// one of them offers a downgrade another refuses. The rules are the shared
// conformance fixture's (solutions/contracts/update/fixtures/conformance.json)
// and the Rust half is rust/domain/version.rs.
//
//   - MAJOR.MINOR.PATCH, numeric, no leading zeros, at most 15 digits each
//   - a pre-release (`-rc.1`) sorts before its release
//   - pre-release identifiers compare left to right: numeric ones by value and
//     before alphanumeric ones, which compare by ASCII; fewer identifiers first
//   - build metadata (`+build.5`) is ignored
//
// Anything else is not a version, and is refused rather than guessed at.

const VERSION = /^(0|[1-9]\d{0,14})\.(0|[1-9]\d{0,14})\.(0|[1-9]\d{0,14})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const NUMERIC = /^\d+$/;

export interface ParsedVersion {
  readonly core: readonly [number, number, number];
  readonly prerelease: readonly string[];
}

export function parseVersion(version: string): ParsedVersion | null {
  const match = VERSION.exec(version);
  if (!match) return null;
  const prerelease = match[4] ? match[4].split(".") : [];
  // A numeric identifier with a leading zero, or one too long to compare exactly, is not valid.
  if (prerelease.some((part) => NUMERIC.test(part) && ((part.length > 1 && part.startsWith("0")) || part.length > 15))) return null;
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease };
}

/** Negative when `a` is older than `b`, zero when they have equal precedence, positive when newer. Null when either is not a version. */
export function compareVersions(a: string, b: string): number | null {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  for (let index = 0; index < 3; index++) {
    if (left.core[index] !== right.core[index]) return left.core[index]! < right.core[index]! ? -1 : 1;
  }
  if (!left.prerelease.length || !right.prerelease.length) {
    return left.prerelease.length === right.prerelease.length ? 0 : left.prerelease.length ? -1 : 1;
  }
  for (let index = 0; index < Math.min(left.prerelease.length, right.prerelease.length); index++) {
    const x = left.prerelease[index]!;
    const y = right.prerelease[index]!;
    if (x === y) continue;
    const xNumeric = NUMERIC.test(x);
    const yNumeric = NUMERIC.test(y);
    if (xNumeric && yNumeric) return Number(x) < Number(y) ? -1 : 1;
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return left.prerelease.length === right.prerelease.length ? 0 : left.prerelease.length < right.prerelease.length ? -1 : 1;
}

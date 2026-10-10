// Version ordering for updates: Semantic Versioning 2.0.0 precedence.
//
// The same rules as the TypeScript half (domain/services/VersionOrder.ts), and
// both are held to solutions/contracts/update/fixtures/conformance.json:
//
//   - MAJOR.MINOR.PATCH, numeric, no leading zeros, at most 15 digits each
//   - a pre-release (`-rc.1`) sorts before its release
//   - pre-release identifiers compare left to right: numeric ones by value and
//     before alphanumeric ones, which compare by ASCII; fewer identifiers first
//   - build metadata (`+build.5`) is ignored
//
// Anything else is not a version, and is refused rather than guessed at.

use std::cmp::Ordering;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Version {
    core: [u64; 3],
    prerelease: Vec<String>,
}

fn identifier(part: &str) -> bool {
    !part.is_empty() && part.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

fn numeric(part: &str) -> bool {
    !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit())
}

/// A numeric field: digits only, no leading zero, at most 15 digits.
fn number(part: &str) -> Option<u64> {
    if !numeric(part) || part.len() > 15 || (part.len() > 1 && part.starts_with('0')) {
        return None;
    }
    part.parse().ok()
}

pub fn parse(version: &str) -> Option<Version> {
    let (rest, build) = match version.split_once('+') {
        Some((rest, build)) => (rest, Some(build)),
        None => (version, None),
    };
    if let Some(build) = build {
        if !build.split('.').all(identifier) {
            return None;
        }
    }
    let (core, prerelease) = match rest.split_once('-') {
        Some((core, prerelease)) => (core, Some(prerelease)),
        None => (rest, None),
    };
    let mut fields = core.split('.');
    let parsed = [
        number(fields.next()?)?,
        number(fields.next()?)?,
        number(fields.next()?)?,
    ];
    if fields.next().is_some() {
        return None;
    }
    let mut identifiers = Vec::new();
    if let Some(prerelease) = prerelease {
        for part in prerelease.split('.') {
            if !identifier(part) || (numeric(part) && number(part).is_none()) {
                return None;
            }
            identifiers.push(part.to_string());
        }
    }
    Some(Version {
        core: parsed,
        prerelease: identifiers,
    })
}

/// `None` when either side is not a version.
pub fn compare(a: &str, b: &str) -> Option<Ordering> {
    let left = parse(a)?;
    let right = parse(b)?;
    let core = left.core.cmp(&right.core);
    if core != Ordering::Equal {
        return Some(core);
    }
    if left.prerelease.is_empty() || right.prerelease.is_empty() {
        // A release is newer than any of its pre-releases.
        return Some(
            match (left.prerelease.is_empty(), right.prerelease.is_empty()) {
                (true, false) => Ordering::Greater,
                (false, true) => Ordering::Less,
                _ => Ordering::Equal,
            },
        );
    }
    for (x, y) in left.prerelease.iter().zip(right.prerelease.iter()) {
        if x == y {
            continue;
        }
        return Some(match (number(x), number(y)) {
            (Some(x), Some(y)) => x.cmp(&y),
            (Some(_), None) => Ordering::Less,
            (None, Some(_)) => Ordering::Greater,
            (None, None) => x.as_bytes().cmp(y.as_bytes()),
        });
    }
    Some(left.prerelease.len().cmp(&right.prerelease.len()))
}

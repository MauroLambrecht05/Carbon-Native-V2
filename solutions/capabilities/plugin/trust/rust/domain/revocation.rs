// The revocation list.
//
// ── THIS IS A STUB. READ THIS BEFORE RELYING ON IT. ─────────────────────────
// The list below is HARDCODED into the binary. That means a plugin can only be
// revoked by shipping a new build of the runtime, which is exactly the property
// a revocation list exists to avoid — the whole point of step 8 in
// .local/notes/roadmap/04-security-and-capabilities/README.md is that "a mistake
// found after publish is fixable retroactively," and a list compiled into last
// month's release is not.
//
// What is real here is the SHAPE: the loader computes a content hash it already
// needs for signature verification, checks it against a list, and refuses with a
// named reason. Everything downstream of that decision — the error path, the
// call site, the identity a revocation names — is finished and will not change
// when the list stops being a constant.
//
// ── WHAT THE REAL MECHANISM LOOKS LIKE (future work) ────────────────────────
// Per the plan doc, a periodically-refreshed, SHORT-LIVED-SIGNED list:
//
//   1. Carbon publishes a list of revoked content hashes, signed with the same
//      Ed25519 key the plugins are, carrying an explicit `not_after` timestamp
//      measured in days rather than months.
//   2. The runtime refreshes it on its own schedule — never on the load path,
//      which must not acquire a network dependency (and, per "The Fs/Net split,"
//      must not be the thing that gives the plugin side network reach).
//   3. Load time reads the cached copy and checks the signature and `not_after`
//      before trusting it. An expired list is a soft failure that keeps the last
//      known-good entries, not a reason to refuse every plugin — a revocation
//      list that bricks an app when a CDN is down is worse than the bug it was
//      trying to contain.
//   4. The compiled-in list below survives as the floor: entries here are
//      checked whatever the fetched list says, so a revocation can never be
//      rolled back by feeding the runtime a stale signed list.
//
// Until then: adding an entry here is a release.

use crate::digest::ContentHash;
use anyhow::{anyhow, Result};

/// `(sha256 hex of the artifact, why it was revoked)`.
///
/// The reason is not decoration — it is what the user sees when their app
/// refuses to start a plugin that worked yesterday, and "revoked" with no
/// further explanation is the kind of message that gets worked around by
/// disabling the check.
pub const REVOKED_PLUGINS: &[(&str, &str)] = &[
    // A reserved, permanently-unreachable entry so the list is never empty and
    // the check is never dead code: no artifact hashes to all zeroes, so this
    // revokes nothing while still exercising the lookup in tests.
    (
        "0000000000000000000000000000000000000000000000000000000000000000",
        "reserved test vector — not a real plugin",
    ),
];

/// Why this hash is revoked, or `None` if it is not.
pub fn revocation_reason(hash: &ContentHash) -> Option<&'static str> {
    let hex = hash.to_hex();
    REVOKED_PLUGINS
        .iter()
        .find(|(revoked, _)| revoked.eq_ignore_ascii_case(&hex))
        .map(|(_, reason)| *reason)
}

/// The loader's call: `Ok(())` unless this artifact has been revoked.
///
/// Separate from signature verification and called separately, because the two
/// failures are not the same thing and should not read as one. A bad signature
/// means "this is not a Carbon plugin"; a revocation means "this WAS one, and
/// we have since withdrawn it" — the second is the one a user is likely to have
/// been running successfully until now.
pub fn ensure_not_revoked(hash: &ContentHash) -> Result<()> {
    match revocation_reason(hash) {
        None => Ok(()),
        Some(reason) => Err(anyhow!(
            "plugin is REVOKED: {reason}\n  \
             content hash: {hash}\n  \
             A revoked build is refused even though it is correctly signed. \
             Update the plugin to a newer release."
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_ordinary_artifact_is_not_revoked() {
        let hash = ContentHash::of(b"a perfectly ordinary plugin");
        assert!(revocation_reason(&hash).is_none());
        assert!(ensure_not_revoked(&hash).is_ok());
    }

    #[test]
    fn a_listed_hash_is_refused_with_its_reason() {
        // Reached through the same public API the loader uses, via the reserved
        // all-zero entry — the list lookup itself is what is under test.
        let zero = ContentHash::parse_hex(REVOKED_PLUGINS[0].0).expect("valid hex in the list");
        assert_eq!(revocation_reason(&zero), Some(REVOKED_PLUGINS[0].1));
        let err = ensure_not_revoked(&zero).unwrap_err().to_string();
        assert!(err.contains("REVOKED"), "unhelpful message: {err}");
        assert!(err.contains(REVOKED_PLUGINS[0].1), "no reason given: {err}");
    }

    #[test]
    fn every_entry_in_the_list_is_a_well_formed_hash() {
        // A typo'd entry would silently revoke nothing, which is the worst
        // possible failure mode for this list.
        for (hex, reason) in REVOKED_PLUGINS {
            assert!(
                ContentHash::parse_hex(hex).is_ok(),
                "revocation entry `{hex}` is not a 32-byte hex digest"
            );
            assert!(!reason.is_empty(), "revocation entry `{hex}` has no reason");
        }
    }
}

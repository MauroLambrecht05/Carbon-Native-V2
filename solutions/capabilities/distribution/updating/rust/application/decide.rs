// What an installed app does with a verified manifest and stop list.
//
// One function, so the decision is the same wherever it is made. The order of
// the checks is part of the contract: it is what the shared conformance
// fixture (solutions/contracts/update/fixtures/conformance.json) pins down,
// and the TypeScript half is domain/services/UpdateDecision.ts.
//
// The manifest passed in must already have had its signature verified against
// the key the app pins (verify.rs). Nothing here trusts a key the manifest
// names.

use crate::manifest::{PlatformEntry, UpdaterManifest};
use crate::rollout::in_rollout;
use crate::stop_list::{is_yanked, StopList};
use crate::version::compare;
use std::cmp::Ordering;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NoUpdate {
    ChannelMismatch,
    InvalidVersion,
    Current,
    Older,
    Withdrawn,
    Incompatible,
    NoPlatform,
    NotInRollout,
}

impl NoUpdate {
    /// The name the conformance fixture and the TypeScript half use.
    pub fn as_str(&self) -> &'static str {
        match self {
            NoUpdate::ChannelMismatch => "channel_mismatch",
            NoUpdate::InvalidVersion => "invalid_version",
            NoUpdate::Current => "current",
            NoUpdate::Older => "older",
            NoUpdate::Withdrawn => "withdrawn",
            NoUpdate::Incompatible => "incompatible",
            NoUpdate::NoPlatform => "no_platform",
            NoUpdate::NotInRollout => "not_in_rollout",
        }
    }
}

#[derive(Debug, Clone)]
pub enum Decision<'a> {
    None(NoUpdate),
    /// The running version was withdrawn: go back to the previous slot.
    Rollback,
    Update {
        version: &'a str,
        artifact: &'a PlatformEntry,
    },
}

/// `channel` is the channel this install follows; when given, a manifest for
/// another channel is ignored.
pub fn decide<'a>(
    manifest: &'a UpdaterManifest,
    stop_list: &StopList,
    current_version: &str,
    installation_id: &str,
    platform: &str,
    channel: Option<&str>,
) -> Decision<'a> {
    // 1. A manifest signed for another channel must not be accepted on this one.
    if channel.is_some_and(|channel| channel != manifest.channel) {
        return Decision::None(NoUpdate::ChannelMismatch);
    }
    // 2. A withdrawn running version rolls back whether or not anything newer is offered.
    if is_yanked(stop_list, current_version).is_some() {
        return Decision::Rollback;
    }
    // 3. Only a strictly newer version is an update. An older one is never installed.
    match compare(&manifest.version, current_version) {
        None => return Decision::None(NoUpdate::InvalidVersion),
        Some(Ordering::Equal) => return Decision::None(NoUpdate::Current),
        Some(Ordering::Less) => return Decision::None(NoUpdate::Older),
        Some(Ordering::Greater) => {}
    }
    // 4. A withdrawn version is not installed even if a stale manifest still offers it.
    if is_yanked(stop_list, &manifest.version).is_some() {
        return Decision::None(NoUpdate::Withdrawn);
    }
    // 5. Compatibility: installs older than min_version cannot jump straight to this release.
    if let Some(min_version) = &manifest.min_version {
        match compare(current_version, min_version) {
            None => return Decision::None(NoUpdate::InvalidVersion),
            Some(Ordering::Less) => return Decision::None(NoUpdate::Incompatible),
            Some(_) => {}
        }
    }
    // 6. There must be an artifact for this platform.
    let Some(artifact) = manifest.platforms.get(platform) else {
        return Decision::None(NoUpdate::NoPlatform);
    };
    // 7. Staged rollout.
    if !in_rollout(installation_id, &manifest.version, manifest.rollout) {
        return Decision::None(NoUpdate::NotInRollout);
    }
    Decision::Update {
        version: &manifest.version,
        artifact,
    }
}

#[cfg(test)]
mod conformance {
    //! The Rust updater against the shared conformance fixture. The TypeScript
    //! updater and the standalone updater run the same file.
    use super::*;
    use crate::verify::verify_manifest_signature;
    use serde_json::Value;

    fn fixture() -> Value {
        serde_json::from_str(include_str!(
            "../../../../../contracts/update/fixtures/conformance.json"
        ))
        .expect("the conformance fixture is JSON")
    }

    fn items<'a>(fixture: &'a Value, key: &str, at_least: usize) -> &'a Vec<Value> {
        let list = fixture[key].as_array().expect("a list");
        assert!(
            list.len() >= at_least,
            "{key} has only {} cases",
            list.len()
        );
        list
    }

    fn text<'a>(value: &'a Value, key: &str) -> &'a str {
        value[key]
            .as_str()
            .unwrap_or_else(|| panic!("{key} is a string"))
    }

    #[test]
    fn signature_bytes() {
        let fixture = fixture();
        for item in items(&fixture, "signatures", 8) {
            let verified = verify_manifest_signature(
                text(item, "manifest"),
                text(item, "signature"),
                text(item, "publicKey"),
            )
            .is_ok();
            assert_eq!(
                verified,
                item["valid"].as_bool().unwrap(),
                "{}",
                text(item, "name")
            );
        }
    }

    #[test]
    fn version_ordering() {
        let fixture = fixture();
        for item in items(&fixture, "versions", 20) {
            let (a, b) = (text(item, "a"), text(item, "b"));
            let expected = match item["expected"].as_i64().unwrap() {
                -1 => Ordering::Less,
                0 => Ordering::Equal,
                _ => Ordering::Greater,
            };
            assert_eq!(compare(a, b), Some(expected), "{a} against {b}");
            assert_eq!(compare(b, a), Some(expected.reverse()), "{b} against {a}");
        }
        for version in items(&fixture, "invalidVersions", 15) {
            let version = version.as_str().unwrap();
            assert!(
                crate::version::parse(version).is_none(),
                "{version:?} parsed"
            );
            assert_eq!(compare(version, "1.0.0"), None);
            assert_eq!(compare("1.0.0", version), None);
        }
    }

    #[test]
    fn rollout_bucket() {
        let fixture = fixture();
        for item in items(&fixture, "rollout", 72) {
            let (id, version) = (text(item, "installationId"), text(item, "version"));
            let percent = item["percent"].as_u64().unwrap() as u8;
            assert_eq!(
                in_rollout(id, version, percent),
                item["offered"].as_bool().unwrap(),
                "{id} {version} at {percent}%"
            );
        }
    }

    #[test]
    fn decisions() {
        let fixture = fixture();
        for item in items(&fixture, "decisions", 22) {
            let name = text(item, "name");
            let manifest: UpdaterManifest =
                serde_json::from_value(item["manifest"].clone()).unwrap();
            let stop_list: StopList = serde_json::from_value(item["stopList"].clone()).unwrap();
            let decision = decide(
                &manifest,
                &stop_list,
                text(item, "currentVersion"),
                text(item, "installationId"),
                text(item, "platform"),
                item["channel"].as_str(),
            );
            let expected = &item["expected"];
            match decision {
                Decision::Update { version, artifact } => {
                    assert_eq!(text(expected, "action"), "update", "{name}");
                    assert_eq!(text(expected, "version"), version, "{name}");
                    assert_eq!(
                        artifact.sha256,
                        manifest.platforms[text(item, "platform")].sha256
                    );
                }
                Decision::Rollback => {
                    assert_eq!(text(expected, "action"), "rollback", "{name}");
                    assert_eq!(text(expected, "reason"), "current_withdrawn", "{name}");
                }
                Decision::None(reason) => {
                    assert_eq!(text(expected, "action"), "none", "{name}");
                    assert_eq!(text(expected, "reason"), reason.as_str(), "{name}");
                }
            }
        }
    }
}

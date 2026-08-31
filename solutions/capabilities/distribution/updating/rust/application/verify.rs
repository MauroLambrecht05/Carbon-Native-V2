// Verifying what the manifest claims — the half of the pipeline that was
// entirely missing. `downloader.rs`'s verify_file only ever checked sha256,
// which proves the bytes match what the manifest SAYS, not that whoever
// published the manifest is who the app already trusts. A manifest served
// over a compromised or MITM'd connection could carry a consistent
// (forged-artifact, forged-sha256) pair all day; only the ed25519 signature,
// checked against the pubkey `carbon.toml`'s own [updater] section pins —
// never against whatever the fetched manifest itself claims as its
// "keyring.primary" — closes that.
//
// Signs/verifies RAW bytes directly, no intermediate hash: matches
// @carbon/signing's signBytes/signManifest exactly (Buffer.from(sk.sign(
// bytes)).toString("base64")), NOT carbon-plugin-trust's sign-the-hash
// convention a few capabilities over — same primitive (ed25519-dalek /
// @noble/curves, byte-compatible), different agreement about what the
// signature covers, because these are two independent trust pipelines that
// happen to both use Ed25519.

use anyhow::{anyhow, Context, Result};
use base64::Engine;
use ed25519_dalek::{Signature, VerifyingKey};

fn decode_pubkey(pubkey_base64: &str) -> Result<VerifyingKey> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(pubkey_base64)
        .context("decoding updater pubkey as base64")?;
    let bytes: [u8; 32] = bytes
        .try_into()
        .map_err(|v: Vec<u8>| anyhow!("updater pubkey must be 32 bytes, got {}", v.len()))?;
    VerifyingKey::from_bytes(&bytes)
        .map_err(|e| anyhow!("updater pubkey is not a valid Ed25519 point: {e}"))
}

fn decode_signature(sig_base64: &str) -> Result<Signature> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(sig_base64)
        .context("decoding signature as base64")?;
    let bytes: [u8; 64] = bytes
        .try_into()
        .map_err(|v: Vec<u8>| anyhow!("signature must be 64 bytes, got {}", v.len()))?;
    Ok(Signature::from_bytes(&bytes))
}

/// Verifies `bytes` against `sig_base64`, using the pubkey the app itself
/// already trusts (`carbon.toml`'s `[updater].pubkey`) — never the manifest's
/// own `keyring.primary`, which is attacker-controlled the moment the
/// manifest is.
fn verify_bytes(bytes: &[u8], sig_base64: &str, pubkey_base64: &str) -> Result<()> {
    let key = decode_pubkey(pubkey_base64)?;
    let sig = decode_signature(sig_base64)?;
    // verify_strict, not verify — same reasoning as carbon-plugin-trust's own
    // verification.rs: it additionally rejects a small-order/torsion-component
    // key, closing the signature-malleability hole plain `verify` had in
    // ed25519-dalek 1.x. Right default whenever the key is fixed (pinned in
    // carbon.toml) and the signature is the attacker-supplied half.
    key.verify_strict(bytes, &sig)
        .map_err(|e| anyhow!("Ed25519 verification failed: {e}"))
}

/// Verifies a fetched manifest against its detached signature. `manifest_json`
/// must be the exact bytes as fetched (the literal HTTP response body), not a
/// re-serialization of the parsed struct — the signature covers those exact
/// bytes, same as @carbon/signing's verifyManifest on the publishing side.
pub fn verify_manifest_signature(
    manifest_json: &str,
    sig_base64: &str,
    pubkey_base64: &str,
) -> Result<()> {
    verify_bytes(manifest_json.as_bytes(), sig_base64, pubkey_base64)
        .context("manifest signature verification failed")
}

/// Verifies a downloaded artifact against its `platforms[...].signature` entry.
pub fn verify_artifact_signature(
    bytes: &[u8],
    sig_base64: &str,
    pubkey_base64: &str,
) -> Result<()> {
    verify_bytes(bytes, sig_base64, pubkey_base64).context("artifact signature verification failed")
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    fn keypair() -> (SigningKey, String) {
        let key = SigningKey::from_bytes(&[7u8; 32]);
        let pubkey_b64 =
            base64::engine::general_purpose::STANDARD.encode(key.verifying_key().to_bytes());
        (key, pubkey_b64)
    }

    fn sign(key: &SigningKey, bytes: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(key.sign(bytes).to_bytes())
    }

    #[test]
    fn accepts_a_real_signature() {
        let (key, pubkey) = keypair();
        let bytes = b"pretend manifest json";
        let sig = sign(&key, bytes);
        assert!(verify_bytes(bytes, &sig, &pubkey).is_ok());
    }

    #[test]
    fn refuses_a_tampered_payload() {
        let (key, pubkey) = keypair();
        let sig = sign(&key, b"original bytes");
        assert!(verify_bytes(b"tampered bytes", &sig, &pubkey).is_err());
    }

    #[test]
    fn refuses_a_signature_from_a_different_key() {
        let (_key, pubkey) = keypair();
        let (attacker, _) = keypair_seed(9);
        let bytes = b"pretend manifest json";
        let sig = sign(&attacker, bytes);
        assert!(verify_bytes(bytes, &sig, &pubkey).is_err());
    }

    #[test]
    fn refuses_a_manifest_that_only_matches_its_own_claimed_key() {
        // The exact attack this module exists to stop: an attacker who
        // controls the manifest also controls what "keyring.primary" says,
        // so a manifest self-signed with an attacker key would verify fine
        // against ITSELF. It must not verify against the app's own pinned
        // [updater].pubkey.
        let (attacker, attacker_pubkey) = keypair();
        let (_app_key, app_pubkey) = keypair_seed(3);
        let forged_manifest = br#"{"version":"9.9.9","platforms":{}}"#;
        let forged_sig = sign(&attacker, forged_manifest);

        assert!(verify_manifest_signature(
            std::str::from_utf8(forged_manifest).unwrap(),
            &forged_sig,
            &attacker_pubkey
        )
        .is_ok());
        assert!(verify_manifest_signature(
            std::str::from_utf8(forged_manifest).unwrap(),
            &forged_sig,
            &app_pubkey
        )
        .is_err());
    }

    #[test]
    fn rejects_malformed_base64_without_panicking() {
        let (_key, pubkey) = keypair();
        assert!(verify_bytes(b"x", "not valid base64!!!", &pubkey).is_err());
        assert!(verify_bytes(b"x", "AAAA", &pubkey).is_err()); // valid base64, wrong length
    }

    fn keypair_seed(seed: u8) -> (SigningKey, String) {
        let key = SigningKey::from_bytes(&[seed; 32]);
        let pubkey_b64 =
            base64::engine::general_purpose::STANDARD.encode(key.verifying_key().to_bytes());
        (key, pubkey_b64)
    }
}

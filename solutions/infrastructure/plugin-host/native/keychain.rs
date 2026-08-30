// Native credential storage via the `keyring` crate, backing the
// `keychain_*` ABI trampolines (ABI 1.3, abi/host_exports.rs). Previously a
// `carbon-os` adapter installing `__cm_keychain_*` directly onto the JS
// context — moved here so keychain access goes through the `keychain`
// plugin (products/carbon-sdk/keychain) like every other optional OS
// capability. The keyring usage is unchanged:
//   - Windows: Credential Manager (wincred)
//   - macOS:   Keychain Services (Security framework)
//   - Linux:   Secret Service (libsecret) — falls back to keyutils if D-Bus
//              isn't available.
//
// Storage is keyed by (service, account) — `service` is typically the app's
// reverse-DNS or human name; `account` is the user-scoped key (e.g.
// "openai-api-key"). Password is an arbitrary UTF-8 string; binary blobs
// should be base64-encoded by the caller.

use anyhow::Result;
use keyring::Entry;

pub fn set(service: &str, account: &str, password: &str) -> Result<()> {
    let entry = Entry::new(service, account)?;
    entry.set_password(password)?;
    Ok(())
}

/// `Ok(None)` when no entry exists — the common "haven't logged in yet"
/// path, not an error.
pub fn get(service: &str, account: &str) -> Result<Option<String>> {
    let entry = Entry::new(service, account)?;
    match entry.get_password() {
        Ok(s) => Ok(Some(s)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Idempotent — deleting a missing entry is a no-op rather than an error.
pub fn delete(service: &str, account: &str) -> Result<()> {
    let entry = Entry::new(service, account)?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}

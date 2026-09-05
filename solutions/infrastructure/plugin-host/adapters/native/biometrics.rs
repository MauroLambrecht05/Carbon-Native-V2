// Windows Hello user-consent verification via WinRT's UserConsentVerifier
// — backs the `biometric_verify` ABI trampoline in abi/host_exports.rs
// (ABI 1.18).
//
// WINRT, NOT WIN32: unlike every other adapters/native/*.rs file in this
// crate, `RequestVerificationAsync` is a WinRT (not classic Win32/COM)
// call, still reached through the `windows` crate's WinRT projection
// (verified directly against the downloaded windows-0.58.0 source —
// `src/Windows/Security/Credentials/UI/mod.rs` — for the exact method
// names and the `UserConsentVerificationResult`/`UserConsentVerifierAvailability`
// enum values below, rather than assumed from memory).
//
// WHY A DEDICATED MTA THREAD, NOT THE CALLING (JS/UI) THREAD: this crate's
// own `IAsyncOperation<T>::get()` blocks with a raw `WaitForSingleObject`
// (verified directly against windows-core-0.58.0's `src/imp/waiter.rs` —
// no message pump). taskbar.rs/menu.rs/media.rs's COM calls all run on the
// JS/event-loop thread, which is COINIT_APARTMENTTHREADED (a single-
// threaded apartment) — an STA's own async completions are marshaled back
// through THAT SAME thread's message queue. Blocking that thread on a
// non-pumping wait for its own pending callback is a guaranteed deadlock,
// not a hypothetical one, the moment the Windows Hello prompt would
// otherwise appear. An MTA thread has no such message-queue marshaling
// requirement, so a plain blocking wait there is safe — every call here
// therefore spawns a fresh, dedicated MTA thread (COINIT_MULTITHREADED)
// rather than reusing the calling thread. This is a rare, user-interactive,
// sub-second-to-several-second operation, not a hot path, so a new thread
// per call is simpler than a persistent worker (contrast media.rs's
// long-lived hotkey-listener thread, started once and kept alive).
//
// RESULT DELIVERY: `verify()` only dispatches the request — the actual
// outcome arrives via `push_plugin_event("biometrics.result", ...)`, the
// same `carbon.on`/`carbon.off` shim tray/menu/media already install for
// anything whose result can't be known synchronously.
//
// PLATFORM: Windows-only (Windows Hello). macOS Touch ID/Face ID
// (LAContext) and a Linux equivalent are NOT covered here.

use anyhow::Result;

#[cfg(target_os = "windows")]
pub fn verify(message: String) -> Result<()> {
    std::thread::spawn(move || {
        use windows::core::HSTRING;
        use windows::Security::Credentials::UI::{
            UserConsentVerificationResult, UserConsentVerifier,
        };
        use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

        unsafe {
            // Same "a failure here isn't fatal, the call below will just
            // fail too" posture as taskbar.rs's ensure_com_initialized.
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }

        let prompt = if message.is_empty() {
            "Verify your identity".to_string()
        } else {
            message
        };
        let hstring_prompt = HSTRING::from(prompt);

        let outcome = (|| -> windows::core::Result<UserConsentVerificationResult> {
            UserConsentVerifier::RequestVerificationAsync(&hstring_prompt)?.get()
        })();

        let (verified, label) = match outcome {
            Ok(r) if r == UserConsentVerificationResult::Verified => (true, "verified"),
            Ok(r) if r == UserConsentVerificationResult::DeviceNotPresent => {
                (false, "deviceNotPresent")
            }
            Ok(r) if r == UserConsentVerificationResult::NotConfiguredForUser => {
                (false, "notConfigured")
            }
            Ok(r) if r == UserConsentVerificationResult::DisabledByPolicy => {
                (false, "disabledByPolicy")
            }
            Ok(r) if r == UserConsentVerificationResult::DeviceBusy => (false, "deviceBusy"),
            Ok(r) if r == UserConsentVerificationResult::RetriesExhausted => {
                (false, "retriesExhausted")
            }
            Ok(r) if r == UserConsentVerificationResult::Canceled => (false, "canceled"),
            Ok(_) => (false, "error"),
            Err(_) => (false, "error"),
        };

        crate::host_exports::push_plugin_event(
            "biometrics.result".to_string(),
            format!("{{\"verified\":{verified},\"result\":\"{label}\"}}"),
        );
    });
    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub fn verify(_message: String) -> Result<()> {
    Err(anyhow::anyhow!(
        "biometric verification not yet implemented on this platform"
    ))
}

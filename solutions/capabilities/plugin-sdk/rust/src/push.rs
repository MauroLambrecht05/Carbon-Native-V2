//! Helpers for pushing events from a plugin's background thread onto the
//! carbon-mini event loop. This is a thin wrapper around
//! `CarbonApp.push_event` that handles CString conversion and JSON encoding.
//!
//! The runtime delivers each event to JS as
//! `globalThis.__carbon_on_event(event_name, payload_json_string)`. Plugin
//! authors typically wrap that in a higher-level `carbon:audio`-style module
//! that translates string payloads back to typed objects.

use core::ffi::c_char;
use std::ffi::CString;

use crate::ffi::{CarbonApp, CARBON_ERR_INVALID, CARBON_OK};

/// Push an event with a raw JSON payload. Returns the C ABI status code.
///
/// Safe to call from any thread (the runtime side queues into a mpsc that
/// drains on the JS thread). Calls during shutdown return CARBON_ERR_NO_CTX.
pub fn push_event_raw(app: *mut CarbonApp, name: &str, json_payload: &str) -> i32 {
    if app.is_null() {
        return CARBON_ERR_INVALID;
    }
    let push = unsafe { (*app).push_event };
    let push = match push {
        Some(f) => f,
        None => return CARBON_ERR_INVALID,
    };
    let cname = match CString::new(name) {
        Ok(s) => s,
        Err(_) => return CARBON_ERR_INVALID,
    };
    let cpayload = match CString::new(json_payload) {
        Ok(s) => s,
        Err(_) => return CARBON_ERR_INVALID,
    };
    unsafe {
        push(
            app,
            cname.as_ptr() as *const c_char,
            cpayload.as_ptr() as *const c_char,
        )
    }
}

/// Push an event with a serializable payload. Falls back to "null" if the
/// value can't be serialized.
pub fn push_event<T: serde::Serialize>(app: *mut CarbonApp, name: &str, payload: &T) -> i32 {
    let json = serde_json::to_string(payload).unwrap_or_else(|_| "null".to_string());
    push_event_raw(app, name, &json)
}

/// Same as [`push_event_raw`] but always returns Ok(()) on CARBON_OK and
/// Err(code) otherwise. Convenient for `?` chains.
pub fn try_push(app: *mut CarbonApp, name: &str, json_payload: &str) -> Result<(), i32> {
    let r = push_event_raw(app, name, json_payload);
    if r == CARBON_OK {
        Ok(())
    } else {
        Err(r)
    }
}

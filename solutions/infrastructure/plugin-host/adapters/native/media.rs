// System audio volume/mute (via Core Audio's IAudioEndpointVolume) and
// hardware media-key handling (play/pause, next, previous, stop, via a
// dedicated RegisterHotKey listener thread) — backs the `media_*` ABI
// trampolines in abi/host_exports.rs (ABI 1.16).
//
// VOLUME: the `windows` crate, same reasoning as taskbar.rs — real COM
// interfaces (IMMDeviceEnumerator -> IMMDevice -> IAudioEndpointVolume),
// not primitive-typed.
//
// MEDIA KEYS: hand-rolled `extern "system"` RegisterHotKey/GetMessageW —
// primitive-typed, unlike volume. Deliberately NOT sharing
// carbon-system/shortcuts' `global_hotkey` crate/listener thread: that
// crate's `HotKey`/event channel is a separate, general-purpose
// mechanism this doesn't need to couple to (see menu_events.rs's header
// for what happens when two independent features share one channel
// without coordinating — not repeating that here by using a dedicated
// thread + RegisterHotKey with a NULL hwnd, which delivers WM_HOTKEY to
// the calling thread's own queue with no window needed). Media keys are
// registerable via RegisterHotKey with zero modifiers — an exemption
// Windows makes specifically for this class of key, not a workaround.
//
// NOT YET BUILT: now-playing metadata in the OS media overlay (needs
// WinRT's SystemMediaTransportControls, a materially larger, separate
// piece of work) and a hardware-accelerated video decode surface (needs
// Media Foundation). This file covers volume + media-key capture only —
// see the media plugin's own main.zig header for the same scope note
// surfaced to app authors.
//
// PLATFORM: Windows-only for now.

use anyhow::{anyhow, Result};
use std::cell::RefCell;
use std::sync::OnceLock;
use windows::core::GUID;
use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
use windows::Win32::Media::Audio::{eConsole, eRender, IMMDeviceEnumerator, MMDeviceEnumerator};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED};

thread_local! {
    static COM_READY: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    static ENDPOINT_VOLUME: RefCell<Option<IAudioEndpointVolume>> = const { RefCell::new(None) };
}

fn ensure_com_initialized() {
    COM_READY.with(|ready| {
        if !ready.get() {
            unsafe {
                let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            }
            ready.set(true);
        }
    });
}

fn with_endpoint_volume<T>(f: impl FnOnce(&IAudioEndpointVolume) -> Result<T>) -> Result<T> {
    ensure_com_initialized();
    ENDPOINT_VOLUME.with(|cell| {
        let mut slot = cell.borrow_mut();
        if slot.is_none() {
            let volume: IAudioEndpointVolume = unsafe {
                let enumerator: IMMDeviceEnumerator =
                    CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_INPROC_SERVER)
                        .map_err(|e| anyhow!("CoCreateInstance(MMDeviceEnumerator) failed: {e}"))?;
                let device = enumerator
                    .GetDefaultAudioEndpoint(eRender, eConsole)
                    .map_err(|e| anyhow!("GetDefaultAudioEndpoint failed: {e}"))?;
                device
                    .Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None)
                    .map_err(|e| anyhow!("IMMDevice::Activate(IAudioEndpointVolume) failed: {e}"))?
            };
            *slot = Some(volume);
        }
        f(slot.as_ref().expect("just set or already present"))
    })
}

/// 0.0..=1.0.
pub fn get_volume() -> Result<f32> {
    with_endpoint_volume(|v| unsafe { v.GetMasterVolumeLevelScalar().map_err(|e| anyhow!("{e}")) })
}

/// `level` clamped to 0.0..=1.0.
pub fn set_volume(level: f32) -> Result<()> {
    let level = level.clamp(0.0, 1.0);
    with_endpoint_volume(|v| unsafe {
        v.SetMasterVolumeLevelScalar(level, &GUID::zeroed()).map_err(|e| anyhow!("{e}"))
    })
}

pub fn get_mute() -> Result<bool> {
    with_endpoint_volume(|v| unsafe { Ok(v.GetMute()?.as_bool()) })
}

pub fn set_mute(muted: bool) -> Result<()> {
    with_endpoint_volume(|v| unsafe { v.SetMute(muted, &GUID::zeroed()).map_err(|e| anyhow!("{e}")) })
}

// ── Media keys ───────────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
extern "system" {
    fn RegisterHotKey(hwnd: *mut core::ffi::c_void, id: i32, fs_modifiers: u32, vk: u32) -> i32;
    fn GetMessageW(msg: *mut MsgOnly, hwnd: *mut core::ffi::c_void, min: u32, max: u32) -> i32;
}

#[cfg(target_os = "windows")]
#[repr(C)]
struct MsgOnly {
    hwnd: *mut core::ffi::c_void,
    message: u32,
    wparam: usize,
    lparam: isize,
    time: u32,
    pt_x: i32,
    pt_y: i32,
}

#[cfg(target_os = "windows")]
const WM_HOTKEY: u32 = 0x0312;
#[cfg(target_os = "windows")]
const VK_MEDIA_NEXT_TRACK: u32 = 0xB0;
#[cfg(target_os = "windows")]
const VK_MEDIA_PREV_TRACK: u32 = 0xB1;
#[cfg(target_os = "windows")]
const VK_MEDIA_STOP: u32 = 0xB2;
#[cfg(target_os = "windows")]
const VK_MEDIA_PLAY_PAUSE: u32 = 0xB3;

#[cfg(target_os = "windows")]
const HOTKEY_IDS: [(i32, u32, &str); 4] = [
    (1, VK_MEDIA_PLAY_PAUSE, "playpause"),
    (2, VK_MEDIA_NEXT_TRACK, "next"),
    (3, VK_MEDIA_PREV_TRACK, "previous"),
    (4, VK_MEDIA_STOP, "stop"),
];

static LISTENER_STARTED: OnceLock<()> = OnceLock::new();

/// Starts (once, lazily) a dedicated background thread that registers all
/// four media-key hotkeys and delivers each press via
/// `push_event("media.key", "{\"key\":\"<name>\"}")`. Idempotent — safe
/// to call from every `media_listen_keys` invocation.
pub fn ensure_media_key_listener() {
    #[cfg(not(target_os = "windows"))]
    {}

    #[cfg(target_os = "windows")]
    {
        LISTENER_STARTED.get_or_init(|| {
            std::thread::spawn(|| unsafe {
                for (id, vk, _name) in HOTKEY_IDS {
                    // Zero modifiers is the documented exemption for this
                    // specific class of key — not a workaround, see this
                    // file's own header comment.
                    RegisterHotKey(core::ptr::null_mut(), id, 0, vk);
                }
                let mut msg = MsgOnly {
                    hwnd: core::ptr::null_mut(),
                    message: 0,
                    wparam: 0,
                    lparam: 0,
                    time: 0,
                    pt_x: 0,
                    pt_y: 0,
                };
                loop {
                    let got = GetMessageW(&mut msg, core::ptr::null_mut(), 0, 0);
                    if got <= 0 {
                        break; // WM_QUIT or an error — this thread has no window to outlive.
                    }
                    if msg.message == WM_HOTKEY {
                        let id = msg.wparam as i32;
                        if let Some((_, _, name)) = HOTKEY_IDS.iter().find(|(hid, _, _)| *hid == id) {
                            crate::host_exports::push_plugin_event(
                                "media.key".to_string(),
                                format!("{{\"key\":\"{name}\"}}"),
                            );
                        }
                    }
                }
            });
        });
    }
}

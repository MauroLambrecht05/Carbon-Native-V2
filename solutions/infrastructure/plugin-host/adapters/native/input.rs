// Modifier-key/caps-lock/num-lock state, synthetic keyboard/mouse input,
// and keyboard-layout detection — backs the `input_*` ABI trampolines in
// abi/host_exports.rs (ABI 1.17).
//
// Hand-rolled `extern "system"`, no windows-sys/windows dependency: every
// call here (GetKeyState, SendInput, GetKeyboardLayout,
// GetKeyboardLayoutNameW) takes only integers/pointers-to-PODs — the
// INPUT struct SendInput takes is a plain, fixed, well-documented union
// layout with no ownership concerns, same "safe to hand-roll" case as
// screencapture.rs's BITMAPINFOHEADER.
//
// SCOPE, v1: modifier/lock-key polling, synthetic key press/release,
// synthetic mouse move/click, and the active keyboard layout's locale
// name. NOT covered: multi-touch trackpad gestures, Force Touch, pen/
// stylus pressure curves, and on-screen keyboard control — each is a
// separate, materially larger piece of work (raw WM_POINTER/WM_TOUCH
// handling, or ITipInvocation for the OSK), not stubbed out here rather
// than guessed at. See the input plugin's own main.zig header for the
// same scope note surfaced to app authors.
//
// PLATFORM: Windows-only for now.

use anyhow::{anyhow, Result};

#[cfg(target_os = "windows")]
extern "system" {
    fn GetKeyState(vkey: i32) -> i16;
    fn SendInput(c_inputs: u32, inputs: *const Input, size: i32) -> u32;
    fn GetKeyboardLayout(thread_id: u32) -> isize;
    fn GetKeyboardLayoutNameW(name: *mut u16) -> i32;
}

#[cfg(target_os = "windows")]
const VK_SHIFT: i32 = 0x10;
#[cfg(target_os = "windows")]
const VK_CONTROL: i32 = 0x11;
#[cfg(target_os = "windows")]
const VK_MENU: i32 = 0x12; // Alt
#[cfg(target_os = "windows")]
const VK_CAPITAL: i32 = 0x14;
#[cfg(target_os = "windows")]
const VK_NUMLOCK: i32 = 0x90;

#[cfg(target_os = "windows")]
const INPUT_MOUSE: u32 = 0;
#[cfg(target_os = "windows")]
const INPUT_KEYBOARD: u32 = 1;
#[cfg(target_os = "windows")]
const KEYEVENTF_KEYUP: u32 = 0x0002;
#[cfg(target_os = "windows")]
const MOUSEEVENTF_MOVE: u32 = 0x0001;
#[cfg(target_os = "windows")]
const MOUSEEVENTF_ABSOLUTE: u32 = 0x8000;
#[cfg(target_os = "windows")]
const MOUSEEVENTF_LEFTDOWN: u32 = 0x0002;
#[cfg(target_os = "windows")]
const MOUSEEVENTF_LEFTUP: u32 = 0x0004;
#[cfg(target_os = "windows")]
const MOUSEEVENTF_RIGHTDOWN: u32 = 0x0008;
#[cfg(target_os = "windows")]
const MOUSEEVENTF_RIGHTUP: u32 = 0x0010;
#[cfg(target_os = "windows")]
const MOUSEEVENTF_MIDDLEDOWN: u32 = 0x0020;
#[cfg(target_os = "windows")]
const MOUSEEVENTF_MIDDLEUP: u32 = 0x0040;

// A real Rust `union`, not a flattened same-named-fields approximation —
// MOUSEINPUT and KEYBDINPUT do NOT share byte offsets for their same-
// named-in-spirit fields (KEYBDINPUT's dwFlags sits at union-relative
// offset 4; MOUSEINPUT's sits at offset 12 — a first hand-flattened
// version of this file got exactly this wrong, catchable only by knowing
// the real per-struct layout, not by "it compiled"). Mirroring the real C
// union lets Rust's own repr(C) layout algorithm get the offsets and the
// padding-before-dwExtraInfo right, the same way the real compiler does.
#[cfg(target_os = "windows")]
#[repr(C)]
#[derive(Clone, Copy)]
struct MouseInput {
    dx: i32,
    dy: i32,
    mouse_data: u32,
    dw_flags: u32,
    time: u32,
    dw_extra_info: usize,
}

#[cfg(target_os = "windows")]
#[repr(C)]
#[derive(Clone, Copy)]
struct KeybdInput {
    w_vk: u16,
    w_scan: u16,
    dw_flags: u32,
    time: u32,
    dw_extra_info: usize,
}

#[cfg(target_os = "windows")]
#[repr(C)]
#[derive(Clone, Copy)]
union InputUnion {
    mi: MouseInput,
    ki: KeybdInput,
}

#[cfg(target_os = "windows")]
#[repr(C)]
struct Input {
    input_type: u32,
    u: InputUnion,
}

#[cfg(target_os = "windows")]
fn key_input(vk: u16, key_up: bool) -> Input {
    Input {
        input_type: INPUT_KEYBOARD,
        u: InputUnion {
            ki: KeybdInput {
                w_vk: vk,
                w_scan: 0,
                dw_flags: if key_up { KEYEVENTF_KEYUP } else { 0 },
                time: 0,
                dw_extra_info: 0,
            },
        },
    }
}

#[cfg(target_os = "windows")]
fn mouse_input(dx: i32, dy: i32, flags: u32) -> Input {
    Input {
        input_type: INPUT_MOUSE,
        u: InputUnion { mi: MouseInput { dx, dy, mouse_data: 0, dw_flags: flags, time: 0, dw_extra_info: 0 } },
    }
}

#[cfg(target_os = "windows")]
#[cfg(test)]
mod layout_tests {
    use super::*;

    // Verified against the real Win32 INPUT struct: 8 (type + padding) +
    // 32 (union, MOUSEINPUT-dominated: 20 bytes of u32 fields + 4 bytes
    // padding to 8-align dwExtraInfo + 8-byte dwExtraInfo) = 40 on x64.
    #[test]
    fn input_struct_matches_win32_size_on_x64() {
        assert_eq!(core::mem::size_of::<Input>(), 40);
    }
}

fn key_lock_active(vk: i32) -> bool {
    #[cfg(target_os = "windows")]
    {
        unsafe { (GetKeyState(vk) & 0x0001) != 0 }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = vk;
        false
    }
}

fn key_pressed(vk: i32) -> bool {
    #[cfg(target_os = "windows")]
    {
        unsafe { (GetKeyState(vk) as u16 & 0x8000) != 0 }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = vk;
        false
    }
}

pub struct ModifierState {
    pub shift: bool,
    pub ctrl: bool,
    pub alt: bool,
    pub caps_lock: bool,
    pub num_lock: bool,
}

pub fn modifier_state() -> ModifierState {
    #[cfg(target_os = "windows")]
    {
        ModifierState {
            shift: key_pressed(VK_SHIFT),
            ctrl: key_pressed(VK_CONTROL),
            alt: key_pressed(VK_MENU),
            caps_lock: key_lock_active(VK_CAPITAL),
            num_lock: key_lock_active(VK_NUMLOCK),
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        ModifierState { shift: false, ctrl: false, alt: false, caps_lock: false, num_lock: false }
    }
}

pub fn send_key(vk: u16, key_down: bool) -> Result<()> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (vk, key_down);
        Err(anyhow!("synthetic input not yet implemented on this platform"))
    }
    #[cfg(target_os = "windows")]
    {
        let input = key_input(vk, !key_down);
        let sent = unsafe { SendInput(1, &input, core::mem::size_of::<Input>() as i32) };
        if sent != 1 {
            return Err(anyhow!("SendInput (key) failed"));
        }
        Ok(())
    }
}

/// `x`/`y` in normalized 0..=65535 screen-absolute coordinates (Win32's
/// own MOUSEEVENTF_ABSOLUTE convention) — the caller maps real pixel
/// coordinates onto that range.
pub fn move_mouse(x: i32, y: i32) -> Result<()> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (x, y);
        Err(anyhow!("synthetic input not yet implemented on this platform"))
    }
    #[cfg(target_os = "windows")]
    {
        let input = mouse_input(x, y, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE);
        let sent = unsafe { SendInput(1, &input, core::mem::size_of::<Input>() as i32) };
        if sent != 1 {
            return Err(anyhow!("SendInput (mouse move) failed"));
        }
        Ok(())
    }
}

/// `button`: 0 = left, 1 = right, 2 = middle.
pub fn click_mouse(button: i32, is_down: bool) -> Result<()> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (button, is_down);
        Err(anyhow!("synthetic input not yet implemented on this platform"))
    }
    #[cfg(target_os = "windows")]
    {
        let flags = match (button, is_down) {
            (0, true) => MOUSEEVENTF_LEFTDOWN,
            (0, false) => MOUSEEVENTF_LEFTUP,
            (1, true) => MOUSEEVENTF_RIGHTDOWN,
            (1, false) => MOUSEEVENTF_RIGHTUP,
            (2, true) => MOUSEEVENTF_MIDDLEDOWN,
            (2, false) => MOUSEEVENTF_MIDDLEUP,
            _ => return Err(anyhow!("unknown button {button}")),
        };
        let input = mouse_input(0, 0, flags);
        let sent = unsafe { SendInput(1, &input, core::mem::size_of::<Input>() as i32) };
        if sent != 1 {
            return Err(anyhow!("SendInput (mouse click) failed"));
        }
        Ok(())
    }
}

/// The active keyboard layout's locale identifier, e.g. `"00000409"`
/// (US English) — Windows' own hex LCID string form, not further parsed
/// into a BCP-47 tag here (matching `os.locale()`'s own note that format
/// varies; this is a distinct, layout-specific value from that).
pub fn keyboard_layout_name() -> Result<String> {
    #[cfg(not(target_os = "windows"))]
    {
        Err(anyhow!("keyboard layout detection not yet implemented on this platform"))
    }
    #[cfg(target_os = "windows")]
    {
        let mut buf = [0u16; 9]; // KL_NAMELENGTH
        let ok = unsafe { GetKeyboardLayoutNameW(buf.as_mut_ptr()) };
        if ok == 0 {
            // Fall back to the low word of GetKeyboardLayout's HKL, same
            // information, different accessor — best-effort rather than
            // an outright failure.
            let hkl = unsafe { GetKeyboardLayout(0) };
            return Ok(format!("{:08X}", (hkl as usize) & 0xFFFF));
        }
        let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        Ok(String::from_utf16_lossy(&buf[..len]))
    }
}

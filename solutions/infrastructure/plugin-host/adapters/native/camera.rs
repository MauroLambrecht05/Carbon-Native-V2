// Live camera frame capture via WinRT's `Windows.Media.Capture` frame-
// reader pipeline (`MediaCapture` + `MediaFrameReader`) — backs the
// `camera_start`/`camera_stop` ABI trampolines in abi/host_exports.rs
// (ABI 1.22). Verified directly against the downloaded windows-0.58.0
// source for every method name/signature below, the same rigor as every
// other WinRT adapter in this crate.
//
// WHY THIS FILE'S THREADING LOOKS DIFFERENT FROM bluetooth.rs/
// microphone.rs: those cache a `BluetoothLEDevice`/`AudioGraph` handle in
// a process-wide `Mutex` because the `windows` crate itself marks them
// `unsafe impl Send`. `MediaCapture` and `MediaFrameReader` are NOT
// marked `Send` anywhere in that crate's generated bindings — checked
// directly, not assumed, since getting this wrong wouldn't even compile
// (a `Mutex<Option<MediaCapture>>` used as a `static` requires
// `MediaCapture: Send` to be `Sync`, so the type system would refuse a
// well-intentioned copy of the other two files' pattern here, but this
// was verified proactively rather than discovered via a compile error).
// So the `MediaCapture`/`MediaFrameReader` pair is created, used, AND
// torn down entirely on ONE dedicated background thread that stays ALIVE
// for the whole capture session (unlike biometrics.rs's/bluetooth.rs's
// spawn-once-and-exit threads) — `camera_start` spawns it; `camera_stop`
// signals it to stop via a plain `std::sync::mpsc::Sender<()>` (Send by
// the standard library, no WinRT type crosses the thread boundary at
// all), cached in a process-wide `Mutex` instead of the capture objects
// themselves.
//
// FORMAT: every frame is converted to `BitmapPixelFormat::Rgba8` before
// delivery — the same byte order browser `<canvas>` `ImageData`/
// `putImageData` already expects, so the app never needs to channel-
// swizzle a BGRA camera frame itself. `camera.started` (fired once, on
// the first frame, since resolution isn't queried up front) reports
// `{"width":int,"height":int}` so the caller can construct an ImageData
// of the right size for `camera.frame`'s raw bytes.
//
// V1 SCOPE: the first available color (non-infrared/depth) camera only,
// no device enumeration/selection, no resolution/format negotiation
// (accepts whatever the device's default format is, converted to Rgba8
// after the fact — not requested from the device directly), no still-
// photo capture, and no publishing this stream as a virtual/system
// camera source (a separate, larger piece of work). A permission prompt
// is NOT modeled here: unlike a UWP/MSIX-packaged app, a plain Win32
// desktop process is not gated by the OS camera-privacy toggle the same
// way — this matches this repo's own established posture elsewhere
// (dialog.rs's native pickers, keychain.rs) of relying on the OS's own
// UI/prompts rather than re-implementing a permission model in Carbon.
//
// PLATFORM: Windows-only.

use anyhow::{anyhow, Result};

#[cfg(target_os = "windows")]
static STOP_SENDER: std::sync::Mutex<Option<std::sync::mpsc::Sender<()>>> = std::sync::Mutex::new(None);

#[cfg(target_os = "windows")]
pub fn start() -> Result<()> {
    {
        let guard = STOP_SENDER.lock().unwrap_or_else(|e| e.into_inner());
        if guard.is_some() {
            return Err(anyhow!("camera capture already running"));
        }
    }

    let (stop_tx, stop_rx) = std::sync::mpsc::channel::<()>();
    {
        let mut guard = STOP_SENDER.lock().unwrap_or_else(|e| e.into_inner());
        *guard = Some(stop_tx);
    }

    std::thread::spawn(move || {
        use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }

        let outcome = run_capture_session(&stop_rx);
        if let Err(e) = outcome {
            crate::host_exports::push_plugin_event(
                "camera.start_error".to_string(),
                format!("{{\"error\":{:?}}}", e.to_string()),
            );
        }

        let mut guard = STOP_SENDER.lock().unwrap_or_else(|e| e.into_inner());
        *guard = None;
    });
    Ok(())
}

#[cfg(target_os = "windows")]
fn run_capture_session(stop_rx: &std::sync::mpsc::Receiver<()>) -> Result<()> {
    use windows::Foundation::TypedEventHandler;
    use windows::Graphics::Imaging::{BitmapBufferAccessMode, BitmapPixelFormat, SoftwareBitmap};
    use windows::Media::Capture::Frames::{MediaFrameReader, MediaFrameSourceGroup, MediaFrameSourceKind};
    use windows::Media::Capture::{MediaCapture, MediaCaptureInitializationSettings, MediaCaptureMemoryPreference};
    use windows::Win32::System::WinRT::IMemoryBufferByteAccess;

    // ── Find the first color source across every frame-source group ──────
    let groups = MediaFrameSourceGroup::FindAllAsync()
        .map_err(|e| anyhow!("MediaFrameSourceGroup::FindAllAsync failed: {e}"))?
        .get()
        .map_err(|e| anyhow!("enumerating capture devices failed: {e}"))?;

    let mut chosen: Option<(MediaFrameSourceGroup, windows::core::HSTRING)> = None;
    for i in 0..groups.Size().unwrap_or(0) {
        let Ok(group) = groups.GetAt(i) else { continue };
        let Ok(infos) = group.SourceInfos() else { continue };
        for j in 0..infos.Size().unwrap_or(0) {
            let Ok(info) = infos.GetAt(j) else { continue };
            if info.SourceKind().unwrap_or(MediaFrameSourceKind::Custom) == MediaFrameSourceKind::Color {
                if let Ok(id) = info.Id() {
                    chosen = Some((group, id));
                    break;
                }
            }
        }
        if chosen.is_some() {
            break;
        }
    }
    let (group, source_id) = chosen.ok_or_else(|| anyhow!("no color camera found"))?;

    // ── Initialize MediaCapture against that group, CPU-accessible frames ─
    let media_capture = MediaCapture::new().map_err(|e| anyhow!("MediaCapture::new failed: {e}"))?;
    let settings =
        MediaCaptureInitializationSettings::new().map_err(|e| anyhow!("MediaCaptureInitializationSettings::new failed: {e}"))?;
    settings.SetSourceGroup(&group).map_err(|e| anyhow!("SetSourceGroup failed: {e}"))?;
    settings
        .SetMemoryPreference(MediaCaptureMemoryPreference::Cpu)
        .map_err(|e| anyhow!("SetMemoryPreference failed: {e}"))?;
    media_capture
        .InitializeWithSettingsAsync(&settings)
        .map_err(|e| anyhow!("InitializeWithSettingsAsync failed: {e}"))?
        .get()
        .map_err(|e| anyhow!("camera initialization failed: {e}"))?;

    let sources = media_capture.FrameSources().map_err(|e| anyhow!("FrameSources() failed: {e}"))?;
    let source = sources.Lookup(&source_id).map_err(|e| anyhow!("frame source lookup failed: {e}"))?;

    let reader: MediaFrameReader = media_capture
        .CreateFrameReaderAsync(&source)
        .map_err(|e| anyhow!("CreateFrameReaderAsync failed: {e}"))?
        .get()
        .map_err(|e| anyhow!("creating the frame reader failed: {e}"))?;

    let started_sent = std::sync::atomic::AtomicBool::new(false);
    let started_sent = std::sync::Arc::new(started_sent);
    let started_sent_cb = started_sent.clone();

    reader
        .FrameArrived(&TypedEventHandler::new(move |reader: &Option<MediaFrameReader>, _args| -> windows::core::Result<()> {
            let Some(reader) = reader else { return Ok(()) };
            let Ok(frame_ref) = reader.TryAcquireLatestFrame() else { return Ok(()) };
            let Ok(video_frame) = frame_ref.VideoMediaFrame() else { return Ok(()) };
            let Ok(bitmap) = video_frame.SoftwareBitmap() else { return Ok(()) };
            let Ok(rgba) = SoftwareBitmap::Convert(&bitmap, BitmapPixelFormat::Rgba8) else { return Ok(()) };

            let width = rgba.PixelWidth().unwrap_or(0);
            let height = rgba.PixelHeight().unwrap_or(0);
            if !started_sent_cb.swap(true, std::sync::atomic::Ordering::SeqCst) {
                crate::host_exports::push_plugin_event(
                    "camera.started".to_string(),
                    format!("{{\"width\":{width},\"height\":{height}}}"),
                );
            }

            if let Ok(buffer) = rgba.LockBuffer(BitmapBufferAccessMode::Read) {
                if let Ok(reference) = buffer.CreateReference() {
                    use windows::core::Interface;
                    if let Ok(byte_access) = reference.cast::<IMemoryBufferByteAccess>() {
                        let mut ptr: *mut u8 = core::ptr::null_mut();
                        let mut len: u32 = 0;
                        unsafe {
                            if byte_access.GetBuffer(&mut ptr, &mut len).is_ok() && !ptr.is_null() && len > 0 {
                                let bytes = core::slice::from_raw_parts(ptr, len as usize).to_vec();
                                crate::host_exports::push_plugin_binary_event("camera.frame".to_string(), bytes);
                            }
                        }
                    }
                }
            }
            Ok(())
        }))
        .map_err(|e| anyhow!("FrameArrived registration failed: {e}"))?;

    reader.StartAsync().map_err(|e| anyhow!("MediaFrameReader::StartAsync failed: {e}"))?.get().map_err(|e| anyhow!("starting the frame reader failed: {e}"))?;

    // Block this dedicated thread until camera_stop() signals it — the
    // capture objects above must stay alive (and on this same thread)
    // for the whole session; dropping them ends the stream.
    let _ = stop_rx.recv();

    let _ = reader.StopAsync().and_then(|op| op.get());
    let _ = reader.Close();
    let _ = media_capture.Close();
    Ok(())
}

#[cfg(target_os = "windows")]
pub fn stop() -> Result<()> {
    let mut guard = STOP_SENDER.lock().unwrap_or_else(|e| e.into_inner());
    let Some(sender) = guard.take() else {
        return Err(anyhow!("camera capture is not running"));
    };
    let _ = sender.send(());
    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub fn start() -> Result<()> {
    Err(anyhow!("camera capture is not yet implemented on this platform"))
}
#[cfg(not(target_os = "windows"))]
pub fn stop() -> Result<()> {
    Err(anyhow!("camera capture is not yet implemented on this platform"))
}

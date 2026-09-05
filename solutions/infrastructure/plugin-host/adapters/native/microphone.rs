// Live microphone PCM capture via WinRT's `Windows.Media.Audio.AudioGraph`
// — backs the `microphone_start`/`microphone_stop` ABI trampolines in
// abi/host_exports.rs (ABI 1.21).
//
// AUDIOGRAPH, NOT MediaCapture: `MediaCapture` is the heavier photo/video/
// audio class built around `MediaCaptureInitializationSettings` and
// recording sessions; `AudioGraph` is WinRT's purpose-built real-time
// audio I/O API (also what a DAW-style low-latency capture path would
// use) — `AudioGraph::CreateAsync` -> `CreateDeviceInputNodeAsync` ->
// `CreateFrameOutputNode` -> `AddOutgoingConnection`, then `QuantumStarted`
// fires roughly every audio quantum (device-dependent, commonly ~10ms) so
// the graph can be drained via `AudioFrameOutputNode::GetFrame()`.
// Verified directly against the downloaded windows-0.58.0 source for
// every method name/signature below, the same rigor as every other WinRT
// adapter in this crate.
//
// SETUP IS ASYNC, CAPTURE IS NOT: `AudioGraph::CreateAsync` and
// `CreateDeviceInputNodeAsync` are `IAsyncOperation`s — same blocking-
// `.get()`-with-no-message-pump hazard biometrics.rs documents at length
// — so `start()` spawns a dedicated MTA background thread
// (COINIT_MULTITHREADED) to do setup, exactly like bluetooth.rs's
// connect/subscribe/write. Once running, `QuantumStarted` fires on its
// own real-time audio thread (not the JS/UI thread), so calling
// `push_plugin_binary_event` from inside that callback is safe the same
// way bluetooth.rs's `ValueChanged` callback is. `Stop`/`Close` are plain
// synchronous calls (not `IAsyncOperation`s), so `stop()` can run
// directly on whichever thread calls it — the `AudioGraph` handle is
// cached in a process-wide `Mutex` for that reason (confirmed `Send` by
// the `windows` crate itself: `unsafe impl Send for AudioGraph`).
//
// FORMAT: AudioGraph always delivers 32-bit float PCM (Microsoft's own
// documented behavior — the graph normalizes every node's buffers to
// float32 internally regardless of the source device's native format),
// interleaved by channel. The `microphone.started` event reports the
// actual sample rate and channel count so the caller can interpret the
// raw bytes in `microphone.frame` correctly; this file does not resample,
// downmix, or convert format.
//
// V1 SCOPE: single default capture device, no device enumeration/
// selection, no gain control, no voice-activity detection, no system-
// audio loopback (a separate, larger piece of work — the render/loopback
// side of AudioGraph, not the capture side this file uses).
//
// PLATFORM: Windows-only.

use anyhow::{anyhow, Result};

#[cfg(target_os = "windows")]
static GRAPH: std::sync::Mutex<Option<windows::Media::Audio::AudioGraph>> = std::sync::Mutex::new(None);

#[cfg(target_os = "windows")]
pub fn start() -> Result<()> {
    use windows::Media::Audio::{AudioFrameOutputNode, AudioGraph, AudioGraphSettings};
    use windows::Media::Capture::MediaCategory;
    use windows::Media::Render::AudioRenderCategory;
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

    {
        let guard = GRAPH.lock().unwrap_or_else(|e| e.into_inner());
        if guard.is_some() {
            return Err(anyhow!("microphone capture already running"));
        }
    }

    std::thread::spawn(move || {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }

        let outcome = (|| -> Result<(AudioGraph, u32, u32)> {
            let settings = AudioGraphSettings::Create(AudioRenderCategory::Media)
                .map_err(|e| anyhow!("AudioGraphSettings::Create failed: {e}"))?;
            let graph = AudioGraph::CreateAsync(&settings)
                .map_err(|e| anyhow!("AudioGraph::CreateAsync failed: {e}"))?
                .get()
                .map_err(|e| anyhow!("AudioGraph creation failed: {e}"))?;
            let graph = graph.Graph().map_err(|e| anyhow!("CreateAudioGraphResult::Graph failed: {e}"))?;

            let input_result = graph
                .CreateDeviceInputNodeAsync(MediaCategory::Other)
                .map_err(|e| anyhow!("CreateDeviceInputNodeAsync failed: {e}"))?
                .get()
                .map_err(|e| anyhow!("device input node creation failed: {e}"))?;
            let input_node = input_result.DeviceInputNode().map_err(|e| anyhow!("DeviceInputNode() failed: {e}"))?;

            let encoding = input_node.EncodingProperties().map_err(|e| anyhow!("EncodingProperties() failed: {e}"))?;
            let sample_rate = encoding.SampleRate().unwrap_or(0);
            let channels = encoding.ChannelCount().unwrap_or(0);

            let output_node: AudioFrameOutputNode =
                graph.CreateFrameOutputNode().map_err(|e| anyhow!("CreateFrameOutputNode failed: {e}"))?;
            input_node
                .AddOutgoingConnection(&output_node)
                .map_err(|e| anyhow!("AddOutgoingConnection failed: {e}"))?;

            install_quantum_handler(&graph, &output_node)?;
            graph.Start().map_err(|e| anyhow!("AudioGraph::Start failed: {e}"))?;

            Ok((graph, sample_rate, channels))
        })();

        match outcome {
            Ok((graph, sample_rate, channels)) => {
                let mut slot = GRAPH.lock().unwrap_or_else(|e| e.into_inner());
                *slot = Some(graph);
                drop(slot);
                crate::host_exports::push_plugin_event(
                    "microphone.started".to_string(),
                    format!("{{\"sampleRate\":{sample_rate},\"channels\":{channels}}}"),
                );
            }
            Err(e) => {
                crate::host_exports::push_plugin_event(
                    "microphone.start_error".to_string(),
                    format!("{{\"error\":{:?}}}", e.to_string()),
                );
            }
        }
    });
    Ok(())
}

#[cfg(target_os = "windows")]
fn install_quantum_handler(
    graph: &windows::Media::Audio::AudioGraph,
    output_node: &windows::Media::Audio::AudioFrameOutputNode,
) -> Result<()> {
    use windows::Foundation::TypedEventHandler;
    use windows::Media::Audio::AudioGraph;
    use windows::Media::AudioBufferAccessMode;
    use windows::Win32::System::WinRT::IMemoryBufferByteAccess;

    let output_node = output_node.clone();
    graph
        .QuantumStarted(&TypedEventHandler::new(
            move |_sender: &Option<AudioGraph>, _args: &Option<windows::core::IInspectable>| -> windows::core::Result<()> {
                let frame = output_node.GetFrame()?;
                let buffer = frame.LockBuffer(AudioBufferAccessMode::Read)?;
                let reference = buffer.CreateReference()?;
                let byte_access: IMemoryBufferByteAccess = windows_core_cast(&reference)?;
                let mut ptr: *mut u8 = core::ptr::null_mut();
                let mut len: u32 = 0;
                unsafe {
                    byte_access.GetBuffer(&mut ptr, &mut len)?;
                }
                if !ptr.is_null() && len > 0 {
                    let bytes = unsafe { core::slice::from_raw_parts(ptr, len as usize) }.to_vec();
                    crate::host_exports::push_plugin_binary_event("microphone.frame".to_string(), bytes);
                }
                Ok(())
            },
        ))
        .map_err(|e| anyhow!("QuantumStarted registration failed: {e}"))?;
    Ok(())
}

// `IMemoryBufferReference` doesn't have a safe `.cast()` re-export at the
// call site used above without importing `windows_core::Interface`
// explicitly — small helper so that import stays local to this file
// instead of leaking into the module's public surface.
#[cfg(target_os = "windows")]
fn windows_core_cast<T: windows::core::Interface>(
    from: &windows::Foundation::IMemoryBufferReference,
) -> windows::core::Result<T> {
    use windows::core::Interface;
    from.cast()
}

#[cfg(target_os = "windows")]
pub fn stop() -> Result<()> {
    let mut slot = GRAPH.lock().unwrap_or_else(|e| e.into_inner());
    let Some(graph) = slot.take() else {
        return Err(anyhow!("microphone capture is not running"));
    };
    let _ = graph.Stop();
    let _ = graph.Close();
    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub fn start() -> Result<()> {
    Err(anyhow!("microphone capture is not yet implemented on this platform"))
}
#[cfg(not(target_os = "windows"))]
pub fn stop() -> Result<()> {
    Err(anyhow!("microphone capture is not yet implemented on this platform"))
}

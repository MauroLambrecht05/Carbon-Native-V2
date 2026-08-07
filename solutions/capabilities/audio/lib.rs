// carbon-audio — Web Audio API-shaped JS bindings backed by cpal + symphonia.
//
// Architecture overview
// ---------------------
// The library is organized into six public modules that mirror the Web Audio
// spec's node taxonomy:
//
//   context   — AudioContext (device open, stream spawn, factory methods)
//   buffer    — AudioBuffer + decodeAudioData (symphonia decoder)
//   source    — AudioBufferSourceNode
//   gain      — GainNode + AudioParam automation
//   oscillator — OscillatorNode (sine / square / sawtooth / triangle)
//   analyser  — AnalyserNode (realfft-backed FFT visualization)
//   routing   — AudioParam, AudioDestinationNode
//
// The `mixer` module is crate-private: it owns the Graph, GRAPH static, and
// the render loop. All JS-visible nodes hold a NodeId and mutate the graph
// through `mixer::with_graph_mut`. The audio thread reads the graph through
// `mixer::with_graph` (or acquires the same lock in the cpal callback).
//
// Thread model
// ------------
// JS thread: single-threaded. All `Class` method calls land here.
// Audio thread: cpal callback, runs on a platform OS thread. The two sides
// share only `mixer::GRAPH` (parking_lot Mutex) and some AtomicU32/U64 fields
// inside node states. No rquickjs values cross the thread boundary.
//
// Binary size opt-in
// ------------------
// `register_audio` is gated by the caller (mini/main.rs checks
// `cfg.runtime.audio`). A binary that never calls `register_audio` still links
// the crate (it's a path dep) but cpal's device-open path is never executed,
// so there is zero cold-start cost. Typical binary size delta: ~850 KB on
// Windows (cpal WASAPI + symphonia codecs + realfft).

// ── Layout ──────────────────────────────────────────────────────────────────
// There is no domain/ here, and that is a finding rather than an omission.
//
// The first attempt at this migration put buffer and routing under domain/ and
// mixer under infrastructure/. It did not survive its own check: both files
// import `crate::mixer` — `with_graph_mut`, `NodeId`, `DecodedBuffer` — because
// a Web Audio node is not a standalone object. It is a handle into one global,
// mutable graph that an audio thread is reading concurrently. There is no layer
// of this crate that is free of that graph, so a domain/ directory here would
// have been a label, not a boundary.
//
// What is actually true:
//
//   graph/           the audio graph and everything bound to its shared state:
//                    mixer (the graph itself plus the audio-thread callback),
//                    routing (AudioParam, the destination), buffer, common.
//
//   nodes/           analyser, gain, oscillator, source. Each is inseparably
//                    three things — a model, a DSP routine, and a QuickJS
//                    class. Filing them under domain/ would deny the binding;
//                    under infrastructure/ would deny the DSP.
//
//   infrastructure/  context — opening the cpal output device and owning the
//                    stream. The one part that can be swapped without touching
//                    the graph, and the part `no-audio` turns off.
//
// `#[path]` keeps every module name where it was, so the public API is
// unchanged — `carbon_audio::gain::GainNode` still resolves. Rust resolves
// modules by filesystem position, which is the one thing a restructure moves.
#[path = "nodes/analyser.rs"]
pub mod analyser;
#[path = "graph/buffer.rs"]
pub mod buffer;
#[path = "infrastructure/context.rs"]
pub mod context;
#[path = "nodes/gain.rs"]
pub mod gain;
#[path = "nodes/oscillator.rs"]
pub mod oscillator;
#[path = "graph/routing.rs"]
pub mod routing;
#[path = "nodes/source.rs"]
pub mod source;

#[path = "graph/common.rs"]
pub(crate) mod common;
#[path = "graph/mixer.rs"]
pub(crate) mod mixer;

pub use analyser::AnalyserNode;
pub use buffer::AudioBuffer;
pub use context::AudioContext;
pub use gain::GainNode;
pub use oscillator::OscillatorNode;
pub use routing::{AudioDestinationNode, AudioParam};
pub use source::AudioBufferSourceNode;

use rquickjs::{Class, Ctx, Result};

/// Register every Web Audio class onto the given QuickJS context's globals.
///
/// Call this once at startup when `[runtime] audio = true` in carbon.toml.
/// The globals installed are:
///   `AudioContext`, `AudioBuffer`, `AudioBufferSourceNode`,
///   `GainNode`, `OscillatorNode`, `AnalyserNode`,
///   `AudioParam`, `AudioDestinationNode`.
///
/// After this call, user JS can write:
///   `const ctx = new AudioContext();`
///   `const osc = ctx.createOscillator();`
///   etc.
pub fn register_audio(ctx: &Ctx<'_>) -> Result<()> {
    let globals = ctx.globals();
    Class::<AudioContext>::define(&globals)?;
    Class::<AudioBuffer>::define(&globals)?;
    Class::<AudioBufferSourceNode>::define(&globals)?;
    Class::<GainNode>::define(&globals)?;
    Class::<OscillatorNode>::define(&globals)?;
    Class::<AnalyserNode>::define(&globals)?;
    Class::<AudioParam>::define(&globals)?;
    Class::<AudioDestinationNode>::define(&globals)?;
    Ok(())
}

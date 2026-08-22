// mixer.rs — the audio thread's view of the graph.
//
// Architecture
// ------------
// JS owns lightweight handles (NodeId = u64) that index into a shared
// `Graph` protected by a parking_lot Mutex. The audio thread (running
// inside cpal's data callback) acquires the mutex, walks the graph from
// the destination backwards, and produces interleaved stereo output.
//
// We do NOT walk the graph forward: it's a single-output system, so we
// pull from the destination and recursively pull from any node connected
// into it. With the typical app shape (a handful of source nodes -> a
// gain -> destination) this is O(N) per frame buffer.
//
// JS thread safety
// ----------------
// rquickjs is single-threaded; every JS-side call lands on the same
// thread. The audio thread is separate. The only shared state is the
// `Graph`. Every audio-thread mutation goes through `with_graph_mut`,
// which takes the parking_lot Mutex. JS-side methods (start, stop,
// connect, gain.value=...) also take the same Mutex. No other shared
// state exists between the threads — buffers are Arc'd PCM data that's
// immutable once decoded, and AudioParam values are atomic f32s.
//
// We never call into JS from the audio thread. If the audio callback
// panics, cpal will log and the stream fails over to silence — but our
// callback wraps every read in `catch_unwind` so a Rust panic on the
// audio thread can never propagate into cpal's callsite (which on some
// platforms aborts the process).

use parking_lot::Mutex;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;

/// Stable handle for a node in the graph. JS holds these by value;
/// Rust's mixer looks them up in `Graph::nodes`.
pub type NodeId = u64;

/// Special NodeId reserved for the destination node. Always exists in
/// the Graph after `Graph::new()`.
pub const DESTINATION_ID: NodeId = 1;

/// Atomic counter for node IDs. We deliberately start past DESTINATION_ID
/// so allocations never collide with the reserved destination handle.
static NEXT_ID: AtomicU64 = AtomicU64::new(2);

pub fn next_node_id() -> NodeId {
    NEXT_ID.fetch_add(1, Ordering::Relaxed)
}

/// A scheduled state for a BufferSource node. JS schedules in `currentTime`
/// seconds; the mixer treats those as sample-absolute frames.
#[derive(Debug, Clone, Default)]
pub struct SourceState {
    pub buffer: Option<Arc<DecodedBuffer>>,
    /// Absolute sample frame at which playback begins. Zero means
    /// "not started yet"; this differs from the spec's "0 means now"
    /// because we set this at start() time using the current sample frame.
    /// `None` means start() was never called.
    pub start_frame: Option<u64>,
    /// Sample offset within the buffer where playback began (in source
    /// sample rate frames). 0 by default.
    pub offset_frames: u64,
    /// Absolute sample frame at which playback should stop, or `None`
    /// if no stop scheduled. The mixer compares the device frame
    /// against this each callback; once it's reached, the source is
    /// marked finished.
    pub stop_frame: Option<u64>,
    /// JS-set looping; if true, the playback head wraps from
    /// `loop_end` back to `loop_start` (in source-sample frames).
    pub loop_: bool,
    pub loop_start_frames: u64,
    /// Zero means "use buffer length" (matching the Web Audio spec).
    pub loop_end_frames: u64,
    /// Source-sample playback rate. 1.0 = native rate of the buffer.
    /// We multiply this against (source_sr / device_sr) to get the
    /// per-device-frame stride through the source buffer.
    pub playback_rate: f32,
    /// The source has played to its natural end (or hit stop_frame).
    /// Once true, the mixer skips this source. JS retains the handle
    /// but further start()/stop() are no-ops per spec.
    pub finished: bool,
    /// Outgoing connections — node IDs we feed our samples into.
    pub outputs: Vec<NodeId>,
    /// Per-source playback head (in fractional source-sample frames),
    /// updated by the mixer each callback. Stored as f64 to avoid
    /// drift over millions of samples.
    pub playhead: f64,
}

/// Gain node state. `gain_value` is the only audio-rate parameter we
/// expose right now; we don't yet support full AudioParam automation
/// (linear/exp ramp scheduling). The atomic lets JS set it from the
/// JS thread without taking the graph lock.
#[derive(Debug)]
pub struct GainState {
    /// Stored as f32 bits in an AtomicU32 because there's no AtomicF32.
    /// We use Ordering::Relaxed because a torn read of a gain value is
    /// harmless — at worst one sample plays at the previous gain.
    pub gain_bits: AtomicU32,
    /// Pending ramp end frame (absolute), end value bits, ramp kind.
    /// When the audio thread crosses `ramp_end_frame`, it commits the
    /// ramp end value into `gain_bits` and clears `ramp_active`.
    /// Between ramp_start_frame and ramp_end_frame the audio thread
    /// computes the interpolated value per sample.
    pub ramp_active: AtomicBool,
    pub ramp_kind: AtomicU32, // 0 = linear, 1 = exponential
    pub ramp_start_frame: AtomicU64,
    pub ramp_end_frame: AtomicU64,
    pub ramp_start_bits: AtomicU32,
    pub ramp_end_bits: AtomicU32,
    pub outputs: Vec<NodeId>,
}

impl GainState {
    pub fn new(initial: f32) -> Self {
        Self {
            gain_bits: AtomicU32::new(initial.to_bits()),
            ramp_active: AtomicBool::new(false),
            ramp_kind: AtomicU32::new(0),
            ramp_start_frame: AtomicU64::new(0),
            ramp_end_frame: AtomicU64::new(0),
            ramp_start_bits: AtomicU32::new(initial.to_bits()),
            ramp_end_bits: AtomicU32::new(initial.to_bits()),
            outputs: Vec::new(),
        }
    }

    pub fn gain(&self) -> f32 {
        f32::from_bits(self.gain_bits.load(Ordering::Relaxed))
    }
    pub fn set_gain(&self, v: f32) {
        self.gain_bits.store(v.to_bits(), Ordering::Relaxed);
        // A direct set cancels any active ramp — matches Web Audio behavior
        // for `gain.value = x` (which does cancelScheduledValues + setValueAtTime).
        self.ramp_active.store(false, Ordering::Relaxed);
    }
}

/// Oscillator node state. `frequency` is atomic so JS can change it from
/// the JS thread without taking the graph lock; the audio thread reads
/// it once per buffer.
#[derive(Debug)]
pub struct OscillatorState {
    pub kind: OscillatorKind,
    pub frequency_bits: AtomicU32,
    pub detune_bits: AtomicU32, // cents
    pub start_frame: Option<u64>,
    pub stop_frame: Option<u64>,
    pub finished: bool,
    pub outputs: Vec<NodeId>,
    /// Phase accumulator in turns (0..1). f64 to avoid drift.
    pub phase: f64,
}

#[derive(Debug, Clone, Copy)]
pub enum OscillatorKind {
    Sine,
    Square,
    Sawtooth,
    Triangle,
}

impl OscillatorKind {
    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "sine" => Some(Self::Sine),
            "square" => Some(Self::Square),
            "sawtooth" => Some(Self::Sawtooth),
            "triangle" => Some(Self::Triangle),
            _ => None,
        }
    }
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Sine => "sine",
            Self::Square => "square",
            Self::Sawtooth => "sawtooth",
            Self::Triangle => "triangle",
        }
    }
}

/// Analyser node state. The audio thread copies the most recent
/// `fft_size` samples into a ring buffer; JS can read it via
/// getByteTimeDomainData / getByteFrequencyData.
#[derive(Debug)]
pub struct AnalyserState {
    pub fft_size: usize, // must be power of two between 32 and 32768
    /// Ring buffer of recent (post-mix) samples. Mono — we sum the two
    /// stereo channels before pushing. Length is fft_size; head wraps.
    pub time_domain: Vec<f32>,
    pub head: usize,
    pub smoothing_time_constant: f32,
    pub min_decibels: f32,
    pub max_decibels: f32,
    /// Smoothed magnitude spectrum from the last analyse() call. JS asks
    /// for it on demand; we recompute when JS calls
    /// getByteFrequencyData. Length = fft_size / 2.
    pub last_magnitude: Vec<f32>,
    pub outputs: Vec<NodeId>,
}

impl AnalyserState {
    pub fn new() -> Self {
        let fft_size = 2048;
        Self {
            fft_size,
            time_domain: vec![0.0; fft_size],
            head: 0,
            smoothing_time_constant: 0.8,
            min_decibels: -100.0,
            max_decibels: -30.0,
            last_magnitude: vec![0.0; fft_size / 2],
            outputs: Vec::new(),
        }
    }
}

/// Decoded PCM data. Channels are stored deinterleaved (channel0 first,
/// then channel1, ...) for cache-friendly per-channel reads in the
/// mixer's resampling loop.
#[derive(Debug)]
pub struct DecodedBuffer {
    pub channels: usize,
    pub sample_rate: u32,
    pub frames: usize,
    pub data: Vec<f32>, // length = channels * frames; planar layout
}

impl DecodedBuffer {
    /// Read a single sample from a given channel and frame. Returns 0
    /// for out-of-range frames (silence past the end).
    #[inline]
    pub fn sample(&self, channel: usize, frame: usize) -> f32 {
        if frame >= self.frames {
            return 0.0;
        }
        // For mono buffers, every channel reads the same data.
        let ch = if self.channels == 0 {
            return 0.0;
        } else {
            channel.min(self.channels - 1)
        };
        let idx = ch * self.frames + frame;
        // SAFETY-equivalent: bounds checked by the `frame >= self.frames`
        // gate above plus `ch < channels`.
        self.data[idx]
    }

    /// Linear-interpolated read between two integer frames. `frac_frame`
    /// is in source-sample-rate units. Out-of-range frames return 0.
    #[inline]
    pub fn sample_lerp(&self, channel: usize, frac_frame: f64) -> f32 {
        if frac_frame < 0.0 {
            return 0.0;
        }
        let i0 = frac_frame.floor() as usize;
        let i1 = i0 + 1;
        let t = (frac_frame - i0 as f64) as f32;
        let s0 = self.sample(channel, i0);
        let s1 = self.sample(channel, i1);
        s0 + (s1 - s0) * t
    }
}

/// What kind of node lives at this id.
#[derive(Debug)]
pub enum Node {
    Destination,
    Source(SourceState),
    Gain(GainState),
    Oscillator(OscillatorState),
    Analyser(AnalyserState),
}

/// The graph. JS-side calls and the audio thread both reach into this
/// through `with_graph_mut` / `with_graph`. The mutex is parking_lot's,
/// so contention is cheap and there's no poisoning.
pub struct Graph {
    pub nodes: HashMap<NodeId, Node>,
    /// Inbound adjacency for the destination — every connect(node, ctx.destination)
    /// pushes onto this. The audio thread walks this list each callback.
    pub destination_inputs: Vec<NodeId>,
    /// Inbound adjacency for non-destination nodes. The audio thread
    /// recursively pulls from these when computing a gain node's input.
    pub inputs: HashMap<NodeId, Vec<NodeId>>,
    /// Device sample rate. Set when the AudioContext starts the cpal stream.
    pub device_sample_rate: u32,
    /// Channels emitted by the device. Currently always 2 (stereo).
    pub device_channels: u16,
    /// Absolute frame counter at the device sample rate. The audio thread
    /// is the sole writer; JS reads it (via `currentTime`) through
    /// Ordering::Relaxed.
    pub current_frame: Arc<AtomicU64>,
}

impl Graph {
    pub fn new() -> Self {
        let mut nodes = HashMap::new();
        nodes.insert(DESTINATION_ID, Node::Destination);
        Self {
            nodes,
            destination_inputs: Vec::new(),
            inputs: HashMap::new(),
            device_sample_rate: 48_000,
            device_channels: 2,
            current_frame: Arc::new(AtomicU64::new(0)),
        }
    }

    /// Frames rendered since the context started.
    ///
    /// Part of the mixer's public surface but not called inside this crate —
    /// it backs `AudioContext.currentTime` on the JS side, which reads it
    /// through the host binding rather than through Rust.
    #[allow(dead_code)]
    pub fn current_frame(&self) -> u64 {
        self.current_frame.load(Ordering::Relaxed)
    }

    /// Connect `src` -> `dst`. We track the connection in BOTH directions
    /// (forward outputs in the source's state, inbound `inputs` for
    /// non-destination targets, plus the dedicated `destination_inputs`
    /// list when `dst == DESTINATION_ID`). The redundant bookkeeping lets
    /// disconnect O(1) per direction without re-scanning the whole graph.
    pub fn connect(&mut self, src: NodeId, dst: NodeId) {
        // Push to outputs list of src
        match self.nodes.get_mut(&src) {
            Some(Node::Source(s)) => {
                if !s.outputs.contains(&dst) {
                    s.outputs.push(dst);
                }
            }
            Some(Node::Gain(g)) => {
                if !g.outputs.contains(&dst) {
                    g.outputs.push(dst);
                }
            }
            Some(Node::Oscillator(o)) => {
                if !o.outputs.contains(&dst) {
                    o.outputs.push(dst);
                }
            }
            Some(Node::Analyser(a)) => {
                if !a.outputs.contains(&dst) {
                    a.outputs.push(dst);
                }
            }
            _ => return,
        }
        // Push to inputs list of dst
        if dst == DESTINATION_ID {
            if !self.destination_inputs.contains(&src) {
                self.destination_inputs.push(src);
            }
        } else {
            self.inputs.entry(dst).or_default().push(src);
        }
    }

    pub fn disconnect_all(&mut self, src: NodeId) {
        // Strip src out of every inbound list AND clear src's own outputs.
        let outputs: Vec<NodeId> = match self.nodes.get_mut(&src) {
            Some(Node::Source(s)) => std::mem::take(&mut s.outputs),
            Some(Node::Gain(g)) => std::mem::take(&mut g.outputs),
            Some(Node::Oscillator(o)) => std::mem::take(&mut o.outputs),
            Some(Node::Analyser(a)) => std::mem::take(&mut a.outputs),
            _ => return,
        };
        for dst in outputs {
            if dst == DESTINATION_ID {
                self.destination_inputs.retain(|&x| x != src);
            } else if let Some(list) = self.inputs.get_mut(&dst) {
                list.retain(|&x| x != src);
            }
        }
    }

    pub fn disconnect_target(&mut self, src: NodeId, dst: NodeId) {
        match self.nodes.get_mut(&src) {
            Some(Node::Source(s)) => s.outputs.retain(|&x| x != dst),
            Some(Node::Gain(g)) => g.outputs.retain(|&x| x != dst),
            Some(Node::Oscillator(o)) => o.outputs.retain(|&x| x != dst),
            Some(Node::Analyser(a)) => a.outputs.retain(|&x| x != dst),
            _ => return,
        }
        if dst == DESTINATION_ID {
            self.destination_inputs.retain(|&x| x != src);
        } else if let Some(list) = self.inputs.get_mut(&dst) {
            list.retain(|&x| x != src);
        }
    }
}

/// Render `out_frames` device-rate stereo frames into `out` (interleaved
/// L,R,L,R...). `out` must have length `out_frames * 2`.
///
/// This is the core mix routine. Called once per cpal callback. We:
///   1. Snapshot `current_frame` for this buffer (audio thread is the
///      sole writer of it).
///   2. For each destination input, compute its contribution and sum
///      into `out`.
///   3. Advance `current_frame`.
pub fn render_destination(graph: &mut Graph, out: &mut [f32], out_frames: usize) {
    let channels = graph.device_channels as usize;
    debug_assert_eq!(out.len(), out_frames * channels);
    out.fill(0.0);

    let start_frame = graph.current_frame.load(Ordering::Relaxed);
    let device_sr = graph.device_sample_rate;

    // Walk inputs to destination. We need to drop the borrow before
    // mutating, so collect the IDs first.
    let inputs: Vec<NodeId> = graph.destination_inputs.clone();
    for nid in inputs {
        render_node(
            graph,
            nid,
            start_frame,
            out,
            out_frames,
            channels,
            device_sr,
            &mut HashSet::new(),
        );
    }

    // Update analyser node ring buffers AFTER mixing. We push the
    // mono-summed post-mix output to every analyser that's connected
    // anywhere in the graph (analysers tee, they don't replace input).
    push_to_analysers(graph, out, out_frames, channels);

    graph
        .current_frame
        .store(start_frame + out_frames as u64, Ordering::Relaxed);
}

/// Render the contribution of a single node into `out` and return.
/// Sources/oscillators produce signal directly. Gains pull their inputs
/// recursively and scale. Analysers tee their input through unchanged.
///
/// `visited` guards against cycles (which the spec forbids but JS code
/// can still construct via connect). On cycle detection we silently
/// drop the recursive contribution rather than blowing the stack.
fn render_node(
    graph: &mut Graph,
    nid: NodeId,
    start_frame: u64,
    out: &mut [f32],
    out_frames: usize,
    channels: usize,
    device_sr: u32,
    visited: &mut HashSet<NodeId>,
) {
    if !visited.insert(nid) {
        return; // cycle
    }
    // Defensive copy of the node kind so we can call back into the graph
    // (for input recursion in gains/analysers) without holding a borrow.
    let kind = match graph.nodes.get(&nid) {
        Some(Node::Source(_)) => 1,
        Some(Node::Gain(_)) => 2,
        Some(Node::Oscillator(_)) => 3,
        Some(Node::Analyser(_)) => 4,
        _ => 0,
    };
    match kind {
        1 => render_source_into(
            graph,
            nid,
            start_frame,
            out,
            out_frames,
            channels,
            device_sr,
        ),
        2 => render_gain_into(
            graph,
            nid,
            start_frame,
            out,
            out_frames,
            channels,
            device_sr,
            visited,
        ),
        3 => render_osc_into(
            graph,
            nid,
            start_frame,
            out,
            out_frames,
            channels,
            device_sr,
        ),
        4 => render_analyser_into(
            graph,
            nid,
            start_frame,
            out,
            out_frames,
            channels,
            device_sr,
            visited,
        ),
        _ => {}
    }
    visited.remove(&nid);
}

fn render_source_into(
    graph: &mut Graph,
    nid: NodeId,
    start_frame: u64,
    out: &mut [f32],
    out_frames: usize,
    channels: usize,
    device_sr: u32,
) {
    let Some(Node::Source(s)) = graph.nodes.get_mut(&nid) else {
        return;
    };
    if s.finished {
        return;
    }
    let Some(start) = s.start_frame else { return };
    let buffer = match &s.buffer {
        Some(b) => b.clone(),
        None => return,
    };
    let stop = s.stop_frame;
    let loop_ = s.loop_;
    let loop_start = s.loop_start_frames as f64;
    let loop_end_frames = if s.loop_end_frames == 0 {
        buffer.frames as f64
    } else {
        s.loop_end_frames as f64
    };
    let rate = (s.playback_rate as f64) * (buffer.sample_rate as f64 / device_sr as f64);
    let mut playhead = s.playhead;

    for f in 0..out_frames {
        let abs = start_frame + f as u64;
        if abs < start {
            continue;
        }
        if let Some(stop_frame) = stop {
            if abs >= stop_frame {
                s.finished = true;
                break;
            }
        }
        if !loop_ && playhead >= buffer.frames as f64 {
            s.finished = true;
            break;
        }
        if loop_ {
            // Wrap into the loop region. If playhead is below loop_start,
            // we just keep advancing until we reach it (matches the spec's
            // behavior when loopStart is set after start()).
            if playhead >= loop_end_frames {
                let span = loop_end_frames - loop_start;
                if span > 0.0 {
                    let over = (playhead - loop_start) % span;
                    playhead = loop_start + over;
                }
            }
        }
        // Mix in the buffer's channels into the device's channel layout.
        // Stereo device, mono buffer: duplicate. Mono device: average.
        // Stereo->stereo: pass through.
        if channels == 2 {
            let (l, r) = if buffer.channels >= 2 {
                (
                    buffer.sample_lerp(0, playhead),
                    buffer.sample_lerp(1, playhead),
                )
            } else {
                let m = buffer.sample_lerp(0, playhead);
                (m, m)
            };
            out[f * 2] += l;
            out[f * 2 + 1] += r;
        } else {
            // Mono fallback: average buffer channels.
            let mut acc = 0.0f32;
            let cc = buffer.channels.max(1);
            for ch in 0..cc {
                acc += buffer.sample_lerp(ch, playhead);
            }
            out[f] += acc / cc as f32;
        }
        playhead += rate;
    }
    s.playhead = playhead;
}

fn render_osc_into(
    graph: &mut Graph,
    nid: NodeId,
    start_frame: u64,
    out: &mut [f32],
    out_frames: usize,
    channels: usize,
    device_sr: u32,
) {
    let Some(Node::Oscillator(o)) = graph.nodes.get_mut(&nid) else {
        return;
    };
    if o.finished {
        return;
    }
    let Some(start) = o.start_frame else { return };
    let stop = o.stop_frame;
    let frequency = f32::from_bits(o.frequency_bits.load(Ordering::Relaxed));
    let detune_cents = f32::from_bits(o.detune_bits.load(Ordering::Relaxed));
    // detune is in cents: 100 cents = 1 semitone, 1200 cents = octave.
    let final_freq = frequency * 2f32.powf(detune_cents / 1200.0);
    let inc = (final_freq as f64) / (device_sr as f64);
    let kind = o.kind;
    let mut phase = o.phase;

    for f in 0..out_frames {
        let abs = start_frame + f as u64;
        if abs < start {
            continue;
        }
        if let Some(stop_frame) = stop {
            if abs >= stop_frame {
                o.finished = true;
                break;
            }
        }
        let v = waveform(kind, phase as f32);
        if channels == 2 {
            out[f * 2] += v;
            out[f * 2 + 1] += v;
        } else {
            out[f] += v;
        }
        phase += inc;
        if phase >= 1.0 {
            phase -= phase.floor();
        }
    }
    o.phase = phase;
}

#[inline]
fn waveform(kind: OscillatorKind, phase: f32) -> f32 {
    // Phase is 0..1. We compute the four standard Web Audio waveforms
    // naively (no band-limiting). For audible-range frequencies <=
    // ~5 kHz this is fine; a band-limited oscillator is on the roadmap
    // but isn't required for the demo.
    match kind {
        OscillatorKind::Sine => (phase * std::f32::consts::TAU).sin(),
        OscillatorKind::Square => {
            if phase < 0.5 {
                1.0
            } else {
                -1.0
            }
        }
        OscillatorKind::Sawtooth => 2.0 * phase - 1.0,
        OscillatorKind::Triangle => {
            // |2*phase - 1| ranges 0..1 ; subtract 0.5 then * 2 to span -1..1
            let t = (2.0 * phase - 1.0).abs();
            (t - 0.5) * 2.0
        }
    }
}

fn render_gain_into(
    graph: &mut Graph,
    nid: NodeId,
    start_frame: u64,
    out: &mut [f32],
    out_frames: usize,
    channels: usize,
    device_sr: u32,
    visited: &mut HashSet<NodeId>,
) {
    // Compute inputs into a scratch buffer, then scale by gain into `out`.
    // We allocate the scratch on the stack only if it's small; for typical
    // cpal buffers (256-4096 frames) we use a heap Vec. Reusing scratch
    // across nodes is a future optimization (TLS arena).
    let mut scratch = vec![0.0f32; out_frames * channels];
    let inputs = graph.inputs.get(&nid).cloned().unwrap_or_default();
    for src in inputs {
        render_node(
            graph,
            src,
            start_frame,
            &mut scratch,
            out_frames,
            channels,
            device_sr,
            visited,
        );
    }
    let Some(Node::Gain(g)) = graph.nodes.get(&nid) else {
        return;
    };

    // Branch: ramp active vs steady.
    if g.ramp_active.load(Ordering::Relaxed) {
        let kind = g.ramp_kind.load(Ordering::Relaxed);
        let rs = g.ramp_start_frame.load(Ordering::Relaxed);
        let re = g.ramp_end_frame.load(Ordering::Relaxed);
        let v0 = f32::from_bits(g.ramp_start_bits.load(Ordering::Relaxed));
        let v1 = f32::from_bits(g.ramp_end_bits.load(Ordering::Relaxed));
        let span = (re.saturating_sub(rs)).max(1) as f32;
        for f in 0..out_frames {
            let abs = start_frame + f as u64;
            let g_val = if abs >= re {
                v1
            } else if abs <= rs {
                v0
            } else {
                let t = (abs - rs) as f32 / span;
                if kind == 1 {
                    // Exponential: v0 * (v1/v0)^t. Spec says both v0 and v1
                    // must be > 0; we enforce a tiny positive floor to avoid
                    // log(0) blowing up.
                    let v0p = v0.max(1e-6);
                    let v1p = v1.max(1e-6);
                    v0p * (v1p / v0p).powf(t)
                } else {
                    v0 + (v1 - v0) * t
                }
            };
            for c in 0..channels {
                out[f * channels + c] += scratch[f * channels + c] * g_val;
            }
        }
        // If the ramp completed during this buffer, commit and clear.
        let buf_end = start_frame + out_frames as u64;
        if buf_end >= re {
            g.gain_bits.store(v1.to_bits(), Ordering::Relaxed);
            g.ramp_active.store(false, Ordering::Relaxed);
        }
    } else {
        let g_val = g.gain();
        for f in 0..out_frames {
            for c in 0..channels {
                out[f * channels + c] += scratch[f * channels + c] * g_val;
            }
        }
    }
}

fn render_analyser_into(
    graph: &mut Graph,
    nid: NodeId,
    start_frame: u64,
    out: &mut [f32],
    out_frames: usize,
    channels: usize,
    device_sr: u32,
    visited: &mut HashSet<NodeId>,
) {
    // Analyser is a tee: its input is forwarded unchanged to its outputs
    // (downstream of the analyser), AND a snapshot is captured for JS
    // visualization. We pull inputs into a scratch buffer, write that
    // into `out`, and update the time-domain ring buffer.
    let mut scratch = vec![0.0f32; out_frames * channels];
    let inputs = graph.inputs.get(&nid).cloned().unwrap_or_default();
    for src in inputs {
        render_node(
            graph,
            src,
            start_frame,
            &mut scratch,
            out_frames,
            channels,
            device_sr,
            visited,
        );
    }
    // Forward through.
    for i in 0..scratch.len() {
        out[i] += scratch[i];
    }
    // Update analyser ring buffer.
    let Some(Node::Analyser(a)) = graph.nodes.get_mut(&nid) else {
        return;
    };
    for f in 0..out_frames {
        let m = if channels >= 2 {
            (scratch[f * 2] + scratch[f * 2 + 1]) * 0.5
        } else {
            scratch[f]
        };
        a.time_domain[a.head] = m;
        a.head = (a.head + 1) % a.fft_size;
    }
}

/// Push the post-mix output sample stream to every analyser node in the
/// graph. We do this even for analysers that AREN'T inline in any path
/// — that's intentionally NOT spec-compliant; per spec, analysers only
/// see what flows through them. So skip this and only update analysers
/// that were touched in `render_analyser_into`. (Keeping this function
/// stub for clarity; the work happens above.)
fn push_to_analysers(_graph: &mut Graph, _out: &[f32], _out_frames: usize, _channels: usize) {
    // intentionally empty — analysers update inside render_analyser_into.
}

/// Global graph singleton. The mixer thread and the JS thread both grab
/// `GRAPH.lock()` before reading or writing.
pub static GRAPH: once_cell::sync::Lazy<Mutex<Graph>> =
    once_cell::sync::Lazy::new(|| Mutex::new(Graph::new()));

/// Convenience: run a closure with mutable access to the graph.
pub fn with_graph_mut<R>(f: impl FnOnce(&mut Graph) -> R) -> R {
    let mut g = GRAPH.lock();
    f(&mut g)
}

pub fn with_graph<R>(f: impl FnOnce(&Graph) -> R) -> R {
    let g = GRAPH.lock();
    f(&g)
}

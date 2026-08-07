// context.rs — AudioContext: device open, cpal stream, factory methods.
//
// The AudioContext is the entry point for the Web Audio API. On construction
// we open cpal's default output device, configure it for stereo f32 output,
// and spawn the mixer callback. The callback runs on cpal's audio thread and
// calls `mixer::render_destination` once per buffer.
//
// Factory methods (createGain, createOscillator, etc.) insert a new node into
// the shared Graph and return a JS Class instance pointing at it.
//
// Promises
// --------
// Methods that the Web Audio spec specifies as Promise-returning
// (decodeAudioData, resume, suspend, close) return a resolved Promise via
// `Promise.resolve(value)` evaluated in the QuickJS context.
//
// No-audio CI / feature flag
// --------------------------
// When compiled with `--features no-audio`, the cpal device-open is skipped
// and the context works in "offline" mode (no sound output, graph still
// functions for unit tests).

use crate::{
    analyser::AnalyserNode,
    buffer::{decode_audio_data, AudioBuffer},
    gain::GainNode,
    mixer::{
        next_node_id, with_graph, with_graph_mut, Node, OscillatorKind, OscillatorState,
        SourceState, AnalyserState,
    },
    oscillator::OscillatorNode,
    routing::AudioDestinationNode,
    source::AudioBufferSourceNode,
};
use rquickjs::{
    class::{JsClass, Trace, Tracer, Writable},
    function::{Constructor, Func, This},
    Class, Ctx, Object, Result, Value,
};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

// ---------------------------------------------------------------------------
// State shared between JS and the cpal callback
// ---------------------------------------------------------------------------

pub struct ContextState {
    pub sample_rate: f32,
    pub current_frame: Arc<AtomicU64>,
    pub running: AtomicBool,
    #[allow(dead_code)]
    pub stream: Option<StreamHolder>,
}

/// Opaque holder for the cpal Stream. cpal::Stream is not Send+Sync on Windows
/// (it contains PhantomData<*mut ()>). We hold it as a raw pointer wrapped in
/// our own holder and declare Send+Sync ourselves.
///
/// SAFETY: The stream is only ever used to keep audio playing (cpal callbacks
/// run on cpal's own thread). We never move or access the stream from multiple
/// threads simultaneously. The pointer is valid as long as StreamHolder is alive.
pub struct StreamHolder {
    #[allow(dead_code)]
    inner: Box<dyn std::any::Any>,
}
unsafe impl Send for StreamHolder {}
unsafe impl Sync for StreamHolder {}

impl StreamHolder {
    pub fn new<T: 'static>(v: T) -> Self {
        Self { inner: Box::new(v) }
    }
}

// ---------------------------------------------------------------------------
// AudioContext
// ---------------------------------------------------------------------------

pub struct AudioContext {
    pub state: Arc<ContextState>,
}

unsafe impl<'js> rquickjs::JsLifetime<'js> for AudioContext {
    type Changed<'to> = AudioContext;
}

impl<'js> Trace<'js> for AudioContext {
    fn trace<'a>(&self, _tracer: Tracer<'a, 'js>) {}
}

impl<'js> JsClass<'js> for AudioContext {
    const NAME: &'static str = "AudioContext";
    type Mutable = Writable;

    fn prototype(ctx: &Ctx<'js>) -> Result<Option<Object<'js>>> {
        let proto = Object::new(ctx.clone())?;

        // sampleRate getter
        crate::common::define_accessor(
            ctx,
            &proto,
            "sampleRate",
            Func::from(|this: This<Class<'js, AudioContext>>| -> f32 {
                this.borrow().state.sample_rate
            }),
            Func::from(|_this: This<Class<'js, AudioContext>>, _v: f32| {}),
        )?;

        // currentTime getter
        crate::common::define_accessor(
            ctx,
            &proto,
            "currentTime",
            Func::from(|this: This<Class<'js, AudioContext>>| -> f64 {
                let b = this.borrow();
                let frames = b.state.current_frame.load(Ordering::Relaxed);
                frames as f64 / b.state.sample_rate as f64
            }),
            Func::from(|_this: This<Class<'js, AudioContext>>, _v: f64| {}),
        )?;

        // state getter
        crate::common::define_accessor(
            ctx,
            &proto,
            "state",
            Func::from(|this: This<Class<'js, AudioContext>>| -> &'static str {
                if this.borrow().state.running.load(Ordering::Relaxed) {
                    "running"
                } else {
                    "suspended"
                }
            }),
            Func::from(|_this: This<Class<'js, AudioContext>>, _v: Value<'js>| {}),
        )?;

        // destination getter
        proto.set(
            "destination",
            Func::from(
                |ctx: Ctx<'js>,
                 _this: This<Class<'js, AudioContext>>|
                 -> Result<Class<'js, AudioDestinationNode>> {
                    Class::instance(ctx, AudioDestinationNode::new())
                },
            ),
        )?;

        // createBufferSource()
        proto.set(
            "createBufferSource",
            Func::from(
                |ctx: Ctx<'js>,
                 _this: This<Class<'js, AudioContext>>|
                 -> Result<Class<'js, AudioBufferSourceNode>> {
                    let id = next_node_id();
                    with_graph_mut(|g| {
                        g.nodes.insert(
                            id,
                            Node::Source(SourceState { playback_rate: 1.0, ..Default::default() }),
                        );
                    });
                    Class::instance(ctx, AudioBufferSourceNode { node_id: id })
                },
            ),
        )?;

        // createGain()
        proto.set(
            "createGain",
            Func::from(
                |ctx: Ctx<'js>,
                 _this: This<Class<'js, AudioContext>>|
                 -> Result<Class<'js, GainNode>> {
                    let id = next_node_id();
                    with_graph_mut(|g| {
                        use crate::mixer::GainState;
                        g.nodes.insert(id, Node::Gain(GainState::new(1.0)));
                    });
                    Class::instance(ctx, GainNode { node_id: id })
                },
            ),
        )?;

        // createOscillator()
        proto.set(
            "createOscillator",
            Func::from(
                |ctx: Ctx<'js>,
                 _this: This<Class<'js, AudioContext>>|
                 -> Result<Class<'js, OscillatorNode>> {
                    let id = next_node_id();
                    with_graph_mut(|g| {
                        use std::sync::atomic::AtomicU32;
                        g.nodes.insert(
                            id,
                            Node::Oscillator(OscillatorState {
                                kind: OscillatorKind::Sine,
                                frequency_bits: AtomicU32::new(440.0f32.to_bits()),
                                detune_bits: AtomicU32::new(0.0f32.to_bits()),
                                start_frame: None,
                                stop_frame: None,
                                finished: false,
                                outputs: Vec::new(),
                                phase: 0.0,
                            }),
                        );
                    });
                    Class::instance(ctx, OscillatorNode { node_id: id })
                },
            ),
        )?;

        // createAnalyser()
        proto.set(
            "createAnalyser",
            Func::from(
                |ctx: Ctx<'js>,
                 _this: This<Class<'js, AudioContext>>|
                 -> Result<Class<'js, AnalyserNode>> {
                    let id = next_node_id();
                    with_graph_mut(|g| {
                        g.nodes.insert(id, Node::Analyser(AnalyserState::new()));
                    });
                    Class::instance(ctx, AnalyserNode { node_id: id })
                },
            ),
        )?;

        // createBuffer(numberOfChannels, length, sampleRate)
        proto.set(
            "createBuffer",
            Func::from(
                |ctx: Ctx<'js>,
                 _this: This<Class<'js, AudioContext>>,
                 channels: u32,
                 length: u32,
                 sample_rate: f32|
                 -> Result<Class<'js, AudioBuffer>> {
                    let buf = AudioBuffer::new(
                        channels as usize,
                        length as usize,
                        sample_rate as u32,
                    );
                    Class::instance(ctx, buf)
                },
            ),
        )?;

        // decodeAudioData(arrayLike) → Promise<AudioBuffer>
        proto.set(
            "decodeAudioData",
            Func::from(
                |ctx: Ctx<'js>,
                 _this: This<Class<'js, AudioContext>>,
                 data: Value<'js>|
                 -> Result<Value<'js>> {
                    let bytes: Vec<u8> = if let Some(arr) = data.as_array() {
                        (0..arr.len())
                            .filter_map(|i| arr.get::<u8>(i).ok())
                            .collect()
                    } else {
                        Vec::new()
                    };
                    match decode_audio_data(bytes) {
                        Ok(audio_buf) => {
                            let cls = Class::instance(ctx.clone(), audio_buf)?;
                            resolve_promise(ctx, cls.into_value())
                        }
                        Err(_) => {
                            // Return Promise.resolve(null) on decode failure so callers
                            // get an object (spec-shaped) without synchronous throw.
                            // Pre-build the null value before moving ctx into resolve_promise
                            // (Rust evaluates function args left-to-right; cloning ctx after
                            // it has been moved would be a compile error).
                            let null_val = rquickjs::Value::new_null(ctx.clone());
                            resolve_promise(ctx, null_val)
                        }
                    }
                },
            ),
        )?;

        // resume() → Promise<void>
        proto.set(
            "resume",
            Func::from(
                |ctx: Ctx<'js>, this: This<Class<'js, AudioContext>>| -> Result<Value<'js>> {
                    this.borrow().state.running.store(true, Ordering::Relaxed);
                    resolve_promise_undefined(ctx)
                },
            ),
        )?;

        // suspend() → Promise<void>
        proto.set(
            "suspend",
            Func::from(
                |ctx: Ctx<'js>, this: This<Class<'js, AudioContext>>| -> Result<Value<'js>> {
                    this.borrow().state.running.store(false, Ordering::Relaxed);
                    resolve_promise_undefined(ctx)
                },
            ),
        )?;

        // close() → Promise<void>
        proto.set(
            "close",
            Func::from(
                |ctx: Ctx<'js>, this: This<Class<'js, AudioContext>>| -> Result<Value<'js>> {
                    this.borrow().state.running.store(false, Ordering::Relaxed);
                    resolve_promise_undefined(ctx)
                },
            ),
        )?;

        Ok(Some(proto))
    }

    fn constructor(ctx: &Ctx<'js>) -> Result<Option<Constructor<'js>>> {
        let c = Constructor::new_class::<AudioContext, _, _>(ctx.clone(), || make_audio_context())?;
        Ok(Some(c))
    }
}

// ---------------------------------------------------------------------------
// Device open
// ---------------------------------------------------------------------------

impl<'js> rquickjs::IntoJs<'js> for AudioContext {
    fn into_js(self, ctx: &rquickjs::Ctx<'js>) -> rquickjs::Result<rquickjs::Value<'js>> {
        Class::instance(ctx.clone(), self)?.into_js(ctx)
    }
}

fn make_audio_context() -> AudioContext {
    match open_audio_context() {
        Ok(ctx) => ctx,
        Err(_) => offline_context(),
    }
}

fn open_audio_context() -> Result<AudioContext> {
    #[cfg(feature = "no-audio")]
    return Ok(offline_context());

    #[cfg(not(feature = "no-audio"))]
    match try_open_device() {
        Ok(ctx) => Ok(ctx),
        Err(e) => {
            eprintln!("[carbon-audio] device open failed ({e:#}), running offline");
            Ok(offline_context())
        }
    }
}

fn offline_context() -> AudioContext {
    let frame_arc = with_graph(|g| g.current_frame.clone());
    AudioContext {
        state: Arc::new(ContextState {
            sample_rate: 48_000.0,
            current_frame: frame_arc,
            running: AtomicBool::new(false),
            stream: None,
        }),
    }
}

#[cfg(not(feature = "no-audio"))]
fn try_open_device() -> anyhow::Result<AudioContext> {
    use anyhow::Context as AnyhowContext;
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use cpal::SampleFormat;

    let host = cpal::default_host();
    let device = host
        .default_output_device()
        .ok_or_else(|| anyhow::anyhow!("no default output device"))?;

    // Prefer stereo f32 at 48 kHz
    let supported = device
        .supported_output_configs()
        .context("query output configs")?;

    let mut chosen: Option<cpal::SupportedStreamConfigRange> = None;
    for cfg in supported {
        if cfg.channels() == 2 && cfg.sample_format() == SampleFormat::F32 {
            chosen = Some(cfg);
            break;
        }
    }

    let (config, sample_rate) = if let Some(c) = chosen {
        let sr = cpal::SampleRate(48_000)
            .max(c.min_sample_rate())
            .min(c.max_sample_rate());
        let stream_cfg = c.with_sample_rate(sr);
        let sr = stream_cfg.sample_rate().0;
        (cpal::StreamConfig::from(stream_cfg), sr)
    } else {
        let default = device
            .default_output_config()
            .context("default output config")?;
        let sr = default.sample_rate().0;
        (cpal::StreamConfig::from(default), sr)
    };

    // Update graph sample rate + channel count
    with_graph_mut(|g| {
        g.device_sample_rate = sample_rate;
        g.device_channels = config.channels;
    });

    let frame_arc = with_graph(|g| g.current_frame.clone());
    let frame_arc2 = frame_arc.clone();
    let channels = config.channels as usize;

    let stream = device
        .build_output_stream(
            &config,
            move |data: &mut [f32], _info: &cpal::OutputCallbackInfo| {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    let out_frames = data.len() / channels.max(1);
                    let mut g = crate::mixer::GRAPH.lock();
                    crate::mixer::render_destination(&mut g, data, out_frames);
                }));
                if result.is_err() {
                    eprintln!("[carbon-audio] audio callback panic caught; silencing");
                    data.fill(0.0);
                }
            },
            move |err| {
                eprintln!("[carbon-audio] cpal stream error: {err}");
                let _ = &frame_arc2;
            },
            None,
        )
        .context("build output stream")?;

    stream.play().context("play stream")?;

    Ok(AudioContext {
        state: Arc::new(ContextState {
            sample_rate: sample_rate as f32,
            current_frame: frame_arc,
            running: AtomicBool::new(true),
            stream: Some(StreamHolder::new(stream)),
        }),
    })
}

// ---------------------------------------------------------------------------
// Promise helpers
// ---------------------------------------------------------------------------

// `Promise.resolve` / `Promise.reject` are static methods on the Promise
// constructor, and the spec requires `this` to be the constructor itself —
// QuickJS starts them with `JS_ToObject(this_val)`. Calling them through a
// bare `Function::call` passes `this = undefined`, so QuickJS raises
// "TypeError: not an object" from inside `resolve (native)` before any of our
// code runs. Every one of these helpers must pass the constructor as `This`.

/// Wrap a JS Value in `Promise.resolve(value)`.
fn resolve_promise<'js>(ctx: Ctx<'js>, v: Value<'js>) -> Result<Value<'js>> {
    let promise_ctor: Object<'js> = ctx.globals().get("Promise")?;
    let resolve_fn: rquickjs::Function<'js> = promise_ctor.get("resolve")?;
    resolve_fn.call((This(promise_ctor), v))
}

/// Wrap `undefined` in `Promise.resolve()`.
fn resolve_promise_undefined(ctx: Ctx<'_>) -> Result<Value<'_>> {
    let promise_ctor: Object<'_> = ctx.globals().get("Promise")?;
    let resolve_fn: rquickjs::Function<'_> = promise_ctor.get("resolve")?;
    resolve_fn.call((This(promise_ctor), rquickjs::Undefined))
}

/// Wrap an error string in `Promise.reject(new Error(msg))`.
/// Used by decodeAudioData to return a rejected Promise rather than throwing.
fn reject_promise_str<'js>(ctx: Ctx<'js>, msg: &str) -> Result<Value<'js>> {
    let promise_ctor: Object<'_> = ctx.globals().get("Promise")?;
    let reject_fn: rquickjs::Function<'_> = promise_ctor.get("reject")?;
    // Build a JS Error so the rejection reason has a message
    let err_ctor: rquickjs::Function<'_> = ctx.globals().get("Error")?;
    let err: Value<'_> = err_ctor.call((msg.to_string(),))?;
    reject_fn.call((This(promise_ctor), err))
}

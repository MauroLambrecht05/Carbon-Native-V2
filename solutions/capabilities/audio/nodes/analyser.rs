// analyser.rs — AnalyserNode JS class.
//
// AnalyserNode taps the audio signal flowing through it (the mixer writes to
// its ring buffer in render_analyser_into) and provides JS-callable methods to
// read out time-domain waveform data and frequency-domain FFT magnitude data.
//
// FFT
// ---
// We use realfft (a thin wrapper over rustfft for real-input transforms). The
// ring buffer is copied into a contiguous scratch slice, the FFT is computed,
// and the magnitude spectrum is smoothed with the smoothingTimeConstant.
//
// The AnalyserNode's data lives inside the Graph (AnalyserState), so reading
// it requires acquiring the Graph mutex. For the typical pattern
// (requestAnimationFrame → getByteFrequencyData → draw) this is fine: the rAF
// callback runs on the JS thread while the audio thread only holds the mutex
// for microseconds per buffer.

use crate::gain::node_id_from_value;
use crate::mixer::{with_graph, with_graph_mut, AnalyserState, Node, NodeId};
use realfft::RealFftPlanner;
use rquickjs::{
    class::{JsClass, Trace, Tracer, Writable},
    function::{Constructor, Func, This},
    Array, Class, Ctx, Object, Result, Value,
};

pub struct AnalyserNode {
    pub node_id: NodeId,
}

unsafe impl rquickjs::JsLifetime<'_> for AnalyserNode {
    type Changed<'to> = AnalyserNode;
}

impl<'js> Trace<'js> for AnalyserNode {
    fn trace<'a>(&self, _tracer: Tracer<'a, 'js>) {}
}

impl<'js> JsClass<'js> for AnalyserNode {
    const NAME: &'static str = "AnalyserNode";
    type Mutable = Writable;

    fn prototype(ctx: &Ctx<'js>) -> Result<Option<Object<'js>>> {
        let proto = Object::new(ctx.clone())?;

        // fftSize getter/setter (power of 2, 32–32768)
        crate::common::define_accessor(
            ctx,
            &proto,
            "fftSize",
            Func::from(|this: This<Class<'js, AnalyserNode>>| -> u32 {
                let id = this.borrow().node_id;
                with_graph(|g| match g.nodes.get(&id) {
                    Some(Node::Analyser(a)) => a.fft_size as u32,
                    _ => 2048,
                })
            }),
            Func::from(|this: This<Class<'js, AnalyserNode>>, size: u32| {
                let id = this.borrow().node_id;
                // Clamp to power of 2 in [32, 32768]
                let clamped = size.next_power_of_two().max(32).min(32768);
                with_graph_mut(|g| {
                    if let Some(Node::Analyser(a)) = g.nodes.get_mut(&id) {
                        a.fft_size = clamped as usize;
                        a.time_domain.resize(clamped as usize, 0.0);
                        a.last_magnitude.resize(clamped as usize / 2, 0.0);
                        a.head = 0;
                    }
                });
            }),
        )?;

        // frequencyBinCount getter (= fftSize / 2, read-only)
        crate::common::define_accessor(
            ctx,
            &proto,
            "frequencyBinCount",
            Func::from(|this: This<Class<'js, AnalyserNode>>| -> u32 {
                let id = this.borrow().node_id;
                with_graph(|g| match g.nodes.get(&id) {
                    Some(Node::Analyser(a)) => (a.fft_size / 2) as u32,
                    _ => 1024,
                })
            }),
            Func::from(|_this: This<Class<'js, AnalyserNode>>, _v: u32| {}),
        )?;

        // smoothingTimeConstant getter/setter (0..1)
        crate::common::define_accessor(
            ctx,
            &proto,
            "smoothingTimeConstant",
            Func::from(|this: This<Class<'js, AnalyserNode>>| -> f64 {
                let id = this.borrow().node_id;
                with_graph(|g| match g.nodes.get(&id) {
                    Some(Node::Analyser(a)) => a.smoothing_time_constant as f64,
                    _ => 0.8,
                })
            }),
            Func::from(|this: This<Class<'js, AnalyserNode>>, v: f64| {
                let id = this.borrow().node_id;
                with_graph_mut(|g| {
                    if let Some(Node::Analyser(a)) = g.nodes.get_mut(&id) {
                        a.smoothing_time_constant = (v as f32).max(0.0).min(1.0);
                    }
                });
            }),
        )?;

        // minDecibels getter/setter
        crate::common::define_accessor(
            ctx,
            &proto,
            "minDecibels",
            Func::from(|this: This<Class<'js, AnalyserNode>>| -> f64 {
                let id = this.borrow().node_id;
                with_graph(|g| match g.nodes.get(&id) {
                    Some(Node::Analyser(a)) => a.min_decibels as f64,
                    _ => -100.0,
                })
            }),
            Func::from(|this: This<Class<'js, AnalyserNode>>, v: f64| {
                let id = this.borrow().node_id;
                with_graph_mut(|g| {
                    if let Some(Node::Analyser(a)) = g.nodes.get_mut(&id) {
                        a.min_decibels = v as f32;
                    }
                });
            }),
        )?;

        // maxDecibels getter/setter
        crate::common::define_accessor(
            ctx,
            &proto,
            "maxDecibels",
            Func::from(|this: This<Class<'js, AnalyserNode>>| -> f64 {
                let id = this.borrow().node_id;
                with_graph(|g| match g.nodes.get(&id) {
                    Some(Node::Analyser(a)) => a.max_decibels as f64,
                    _ => -30.0,
                })
            }),
            Func::from(|this: This<Class<'js, AnalyserNode>>, v: f64| {
                let id = this.borrow().node_id;
                with_graph_mut(|g| {
                    if let Some(Node::Analyser(a)) = g.nodes.get_mut(&id) {
                        a.max_decibels = v as f32;
                    }
                });
            }),
        )?;

        // getByteTimeDomainData(array: Array) — fills with waveform 0..255
        proto.set(
            "getByteTimeDomainData",
            Func::from(
                |this: This<Class<'js, AnalyserNode>>, arr: Array<'js>| -> Result<()> {
                    let id = this.borrow().node_id;
                    let samples = with_graph(|g| match g.nodes.get(&id) {
                        Some(Node::Analyser(a)) => {
                            let n = arr.len();
                            let n = n.min(a.fft_size);
                            let mut out = Vec::with_capacity(n);
                            for i in 0..n {
                                // Ring buffer: newest sample is at (head - 1 + fft_size) % fft_size
                                let idx = (a.head + a.fft_size - n + i) % a.fft_size;
                                let v = a.time_domain[idx];
                                // Map -1..1 to 0..255
                                let byte = ((v + 1.0) * 0.5 * 255.0).clamp(0.0, 255.0) as u8;
                                out.push(byte);
                            }
                            out
                        }
                        _ => vec![128u8; arr.len()],
                    });
                    for (i, &b) in samples.iter().enumerate() {
                        arr.set(i, b as u32)?;
                    }
                    Ok(())
                },
            ),
        )?;

        // getFloatTimeDomainData(array: Array) — fills with raw f32 waveform
        proto.set(
            "getFloatTimeDomainData",
            Func::from(
                |this: This<Class<'js, AnalyserNode>>, arr: Array<'js>| -> Result<()> {
                    let id = this.borrow().node_id;
                    let samples = with_graph(|g| match g.nodes.get(&id) {
                        Some(Node::Analyser(a)) => {
                            let n = arr.len();
                            let n = n.min(a.fft_size);
                            let mut out = Vec::with_capacity(n);
                            for i in 0..n {
                                let idx = (a.head + a.fft_size - n + i) % a.fft_size;
                                out.push(a.time_domain[idx]);
                            }
                            out
                        }
                        _ => vec![0.0f32; arr.len()],
                    });
                    for (i, &v) in samples.iter().enumerate() {
                        arr.set(i, v)?;
                    }
                    Ok(())
                },
            ),
        )?;

        // getByteFrequencyData(array: Array) — fills with FFT magnitude 0..255
        proto.set(
            "getByteFrequencyData",
            Func::from(
                |this: This<Class<'js, AnalyserNode>>, arr: Array<'js>| -> Result<()> {
                    let id = this.borrow().node_id;
                    let magnitudes = compute_fft_magnitudes(id);
                    let n = arr.len().min(magnitudes.len());
                    for i in 0..n {
                        let db_range = with_graph(|g| match g.nodes.get(&id) {
                            Some(Node::Analyser(a)) => (a.min_decibels, a.max_decibels),
                            _ => (-100.0f32, -30.0f32),
                        });
                        let mag = magnitudes[i];
                        let db = if mag > 1e-10 {
                            20.0 * mag.log10()
                        } else {
                            -100.0
                        };
                        let byte = ((db - db_range.0) / (db_range.1 - db_range.0) * 255.0)
                            .clamp(0.0, 255.0) as u8;
                        arr.set(i, byte as u32)?;
                    }
                    Ok(())
                },
            ),
        )?;

        // getFloatFrequencyData(array: Array) — fills with FFT magnitude in dB
        proto.set(
            "getFloatFrequencyData",
            Func::from(
                |this: This<Class<'js, AnalyserNode>>, arr: Array<'js>| -> Result<()> {
                    let id = this.borrow().node_id;
                    let magnitudes = compute_fft_magnitudes(id);
                    let n = arr.len().min(magnitudes.len());
                    for i in 0..n {
                        let mag = magnitudes[i];
                        let db = if mag > 1e-10 {
                            20.0 * mag.log10()
                        } else {
                            -100.0f32
                        };
                        arr.set(i, db)?;
                    }
                    Ok(())
                },
            ),
        )?;

        // connect(destination)
        proto.set(
            "connect",
            Func::from(
                |this: This<Class<'js, AnalyserNode>>, dest: Value<'js>| -> Value<'js> {
                    let src_id = this.borrow().node_id;
                    let dst_id = node_id_from_value(&dest);
                    with_graph_mut(|g| g.connect(src_id, dst_id));
                    dest
                },
            ),
        )?;

        // disconnect(destination?)
        proto.set(
            "disconnect",
            Func::from(
                |this: This<Class<'js, AnalyserNode>>,
                 dest: rquickjs::function::Opt<Value<'js>>| {
                    let src_id = this.borrow().node_id;
                    if let Some(d) = dest.0 {
                        let dst_id = node_id_from_value(&d);
                        with_graph_mut(|g| g.disconnect_target(src_id, dst_id));
                    } else {
                        with_graph_mut(|g| g.disconnect_all(src_id));
                    }
                },
            ),
        )?;

        Ok(Some(proto))
    }

    fn constructor(ctx: &Ctx<'js>) -> Result<Option<Constructor<'js>>> {
        let c = Constructor::new_class::<AnalyserNode, _, _>(ctx.clone(), make_analyser_node)?;
        Ok(Some(c))
    }
}

// ---------------------------------------------------------------------------
// FFT helper
// ---------------------------------------------------------------------------

impl<'js> rquickjs::IntoJs<'js> for AnalyserNode {
    fn into_js(self, ctx: &rquickjs::Ctx<'js>) -> Result<rquickjs::Value<'js>> {
        Class::instance(ctx.clone(), self)?.into_js(ctx)
    }
}

fn make_analyser_node() -> AnalyserNode {
    let id = crate::mixer::next_node_id();
    with_graph_mut(|g| {
        g.nodes.insert(id, Node::Analyser(AnalyserState::new()));
    });
    AnalyserNode { node_id: id }
}

/// Snapshot the time-domain ring buffer for `nid` and run a real FFT.
/// Returns magnitude spectrum (length = fft_size / 2). Applies smoothing.
fn compute_fft_magnitudes(nid: NodeId) -> Vec<f32> {
    // Take a snapshot of the ring buffer while holding the lock, then
    // release the lock before doing the FFT (FFT is CPU-bound, shouldn't
    // block the audio thread longer than necessary).
    let (samples, fft_size, smoothing, prev_mag) = with_graph_mut(|g| {
        match g.nodes.get_mut(&nid) {
            Some(Node::Analyser(a)) => {
                let n = a.fft_size;
                // Unwrap ring buffer into a contiguous slice starting at `head`
                let mut buf = Vec::with_capacity(n);
                for i in 0..n {
                    let idx = (a.head + i) % n;
                    buf.push(a.time_domain[idx]);
                }
                let s = a.smoothing_time_constant;
                let prev = a.last_magnitude.clone();
                (buf, n, s, prev)
            }
            _ => (vec![0.0f32; 2048], 2048, 0.8f32, vec![0.0f32; 1024]),
        }
    });

    // Run real FFT
    let mut planner = RealFftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(fft_size);
    let mut input = samples;
    let mut spectrum = fft.make_output_vec();

    // Apply Hann window to reduce spectral leakage
    let n = input.len();
    for (i, s) in input.iter_mut().enumerate() {
        let w = 0.5 * (1.0 - (2.0 * std::f32::consts::PI * i as f32 / (n - 1) as f32).cos());
        *s *= w;
    }

    let _ = fft.process(&mut input, &mut spectrum);

    // Compute magnitude, apply smoothing
    let bin_count = fft_size / 2;
    let mut mag: Vec<f32> = spectrum
        .iter()
        .take(bin_count)
        .map(|c| (c.re * c.re + c.im * c.im).sqrt() / fft_size as f32)
        .collect();

    for (i, m) in mag.iter_mut().enumerate() {
        let prev = prev_mag.get(i).copied().unwrap_or(0.0);
        *m = smoothing * prev + (1.0 - smoothing) * (*m);
    }

    // Store smoothed magnitude back
    with_graph_mut(|g| {
        if let Some(Node::Analyser(a)) = g.nodes.get_mut(&nid) {
            a.last_magnitude.clone_from(&mag);
        }
    });

    mag
}

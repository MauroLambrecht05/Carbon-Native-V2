// gain.rs — GainNode JS class.
//
// GainNode wraps a NodeId into the global Graph. The `gain` AudioParam is
// backed by the GainState's AtomicU32 in mixer.rs. We wire ramp automation
// through the GainState fields so the audio thread can compute linear or
// exponential ramps sample-by-sample.

use crate::{
    mixer::{with_graph, with_graph_mut, Node, NodeId, DESTINATION_ID},
    routing::AudioParam,
};
use rquickjs::{
    class::{JsClass, Trace, Tracer, Writable},
    function::{Constructor, Func, This},
    Class, Ctx, Object, Result,
};

pub struct GainNode {
    pub node_id: NodeId,
}

unsafe impl<'js> rquickjs::JsLifetime<'js> for GainNode {
    type Changed<'to> = GainNode;
}

impl<'js> Trace<'js> for GainNode {
    fn trace<'a>(&self, _tracer: Tracer<'a, 'js>) {}
}

impl<'js> JsClass<'js> for GainNode {
    const NAME: &'static str = "GainNode";
    type Mutable = Writable;

    fn prototype(ctx: &Ctx<'js>) -> Result<Option<Object<'js>>> {
        let proto = Object::new(ctx.clone())?;

        // gain — returns a synthetic AudioParam backed by the GainState atomics.
        // Each access creates a fresh AudioParam JS object, but the underlying
        // ParamState Arc holds a reference to the same atomic. Mutations via
        // gain.value = x or gain.setValueAtTime(x, t) write through to the
        // GainState immediately.
        //
        // The AudioParam object returned here is a "view" into the GainState,
        // not a persistent object. For the common case (gain.value = 0.5) this
        // is fine. For complex automation you'd cache the AudioParam in a JS
        // variable.
        // gain — exposed as a getter so `gainNode.gain.value` works without calling
        // it as a function. Each getter invocation creates a fresh AudioParam view
        // into the same GainState atomics.
        crate::common::define_accessor(
            ctx,
            &proto,
            "gain",
            Func::from(
                |ctx: Ctx<'js>,
                 this: This<Class<'js, GainNode>>|
                 -> Result<Class<'js, AudioParam>> {
                    let id = this.borrow().node_id;
                    let current = with_graph(|g| {
                        match g.nodes.get(&id) {
                            Some(Node::Gain(gs)) => gs.gain(),
                            _ => 1.0,
                        }
                    });
                    build_gain_param(ctx, id, current)
                },
            ),
            Func::from(|_this: This<Class<'js, GainNode>>, _v: rquickjs::Value<'js>| {}),
        )?;

        // connect(destination) — wire this gain node's output
        proto.set(
            "connect",
            Func::from(
                |_ctx: Ctx<'js>,
                 this: This<Class<'js, GainNode>>,
                 dest: rquickjs::Value<'js>|
                 -> Result<rquickjs::Value<'js>> {
                    let src_id = this.borrow().node_id;
                    let dst_id = node_id_from_value(&dest);
                    with_graph_mut(|g| g.connect(src_id, dst_id));
                    Ok(dest)
                },
            ),
        )?;

        // disconnect(destination?)
        proto.set(
            "disconnect",
            Func::from(
                |this: This<Class<'js, GainNode>>,
                 dest: rquickjs::function::Opt<rquickjs::Value<'js>>| {
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
        let c = Constructor::new_class::<GainNode, _, _>(ctx.clone(), || make_gain_node())?;
        Ok(Some(c))
    }
}

impl<'js> rquickjs::IntoJs<'js> for GainNode {
    fn into_js(self, ctx: &rquickjs::Ctx<'js>) -> rquickjs::Result<rquickjs::Value<'js>> {
        Class::instance(ctx.clone(), self)?.into_js(ctx)
    }
}

fn make_gain_node() -> GainNode {
    let id = crate::mixer::next_node_id();
    with_graph_mut(|g| {
        g.nodes.insert(id, crate::mixer::Node::Gain(crate::mixer::GainState::new(1.0)));
    });
    GainNode { node_id: id }
}

// ---------------------------------------------------------------------------
// GainParamBridge — builds a JS AudioParam-like object that proxies to GainState
// ---------------------------------------------------------------------------

fn build_gain_param<'js>(
    ctx: Ctx<'js>,
    node_id: NodeId,
    current: f32,
) -> Result<Class<'js, AudioParam>> {
    // Build a regular AudioParam with the current value as initial.
    let param_inst = Class::instance(
        ctx.clone(),
        AudioParam {
            state: crate::routing::ParamState::new(current, f32::NEG_INFINITY, f32::INFINITY),
        },
    )?;

    // Override `value` getter/setter on the instance's own properties so writes
    // go to GainState AND to the ParamState. We work with the Class as an Object
    // by using its Deref impl (Class<'js, T>: Deref<Target=Object<'js>>).
    let node_id2 = node_id;
    let node_id3 = node_id;

    crate::common::define_accessor(
        &ctx,
        &param_inst,
        "value",
        Func::from(move || -> f32 {
            with_graph(|g| {
                match g.nodes.get(&node_id2) {
                    Some(Node::Gain(gs)) => gs.gain(),
                    _ => 1.0,
                }
            })
        }),
        Func::from(move |v: f32| {
            with_graph_mut(|g| {
                if let Some(Node::Gain(gs)) = g.nodes.get_mut(&node_id3) {
                    gs.set_gain(v);
                }
            });
        }),
    )?;

    // setValueAtTime wires into GainState's ramp machinery
    let nid = node_id;
    param_inst.set(
        "setValueAtTime",
        Func::from(move |value: f32, _start_time: f64| {
            with_graph_mut(|g| {
                if let Some(Node::Gain(gs)) = g.nodes.get_mut(&nid) {
                    gs.set_gain(value);
                }
            });
        }),
    )?;

    // linearRampToValueAtTime
    let nid2 = node_id;
    param_inst.set(
        "linearRampToValueAtTime",
        Func::from(move |value: f32, end_time: f64| {
            with_graph_mut(|g| {
                if let Some(Node::Gain(gs)) = g.nodes.get_mut(&nid2) {
                    use std::sync::atomic::Ordering;
                    let sr = g.device_sample_rate as f64;
                    let cur_frame = g.current_frame.load(Ordering::Relaxed);
                    let end_frame = (end_time * sr) as u64;
                    let v0 = gs.gain();
                    gs.ramp_start_frame.store(cur_frame, Ordering::Relaxed);
                    gs.ramp_end_frame.store(end_frame, Ordering::Relaxed);
                    gs.ramp_start_bits.store(v0.to_bits(), Ordering::Relaxed);
                    gs.ramp_end_bits.store(value.to_bits(), Ordering::Relaxed);
                    gs.ramp_kind.store(0, Ordering::Relaxed); // linear
                    gs.ramp_active.store(true, Ordering::Relaxed);
                }
            });
        }),
    )?;

    // exponentialRampToValueAtTime
    let nid3 = node_id;
    param_inst.set(
        "exponentialRampToValueAtTime",
        Func::from(move |value: f32, end_time: f64| {
            with_graph_mut(|g| {
                if let Some(Node::Gain(gs)) = g.nodes.get_mut(&nid3) {
                    use std::sync::atomic::Ordering;
                    let sr = g.device_sample_rate as f64;
                    let cur_frame = g.current_frame.load(Ordering::Relaxed);
                    let end_frame = (end_time * sr) as u64;
                    let v0 = gs.gain();
                    gs.ramp_start_frame.store(cur_frame, Ordering::Relaxed);
                    gs.ramp_end_frame.store(end_frame, Ordering::Relaxed);
                    gs.ramp_start_bits.store(v0.to_bits(), Ordering::Relaxed);
                    gs.ramp_end_bits.store(value.to_bits(), Ordering::Relaxed);
                    gs.ramp_kind.store(1, Ordering::Relaxed); // exponential
                    gs.ramp_active.store(true, Ordering::Relaxed);
                }
            });
        }),
    )?;

    // setTargetAtTime — approximate: schedule a linear ramp to the target
    // over ~3 time constants.
    let nid4 = node_id;
    param_inst.set(
        "setTargetAtTime",
        Func::from(move |target: f32, _start_time: f64, time_constant: f64| {
            with_graph_mut(|g| {
                if let Some(Node::Gain(gs)) = g.nodes.get_mut(&nid4) {
                    use std::sync::atomic::Ordering;
                    let sr = g.device_sample_rate as f64;
                    let cur_frame = g.current_frame.load(Ordering::Relaxed);
                    // 3τ ≈ 95% of target
                    let end_frame = cur_frame + (3.0 * time_constant * sr) as u64;
                    let v0 = gs.gain();
                    gs.ramp_start_frame.store(cur_frame, Ordering::Relaxed);
                    gs.ramp_end_frame.store(end_frame, Ordering::Relaxed);
                    gs.ramp_start_bits.store(v0.to_bits(), Ordering::Relaxed);
                    gs.ramp_end_bits.store(target.to_bits(), Ordering::Relaxed);
                    gs.ramp_kind.store(1, Ordering::Relaxed); // exponential
                    gs.ramp_active.store(true, Ordering::Relaxed);
                }
            });
        }),
    )?;

    // cancelScheduledValues
    let nid5 = node_id;
    param_inst.set(
        "cancelScheduledValues",
        Func::from(move |_cancel_time: f64| {
            with_graph_mut(|g| {
                if let Some(Node::Gain(gs)) = g.nodes.get_mut(&nid5) {
                    use std::sync::atomic::Ordering;
                    gs.ramp_active.store(false, Ordering::Relaxed);
                }
            });
        }),
    )?;

    Ok(param_inst)
}

// ---------------------------------------------------------------------------
// Helper: extract NodeId from a JS value (GainNode, OscillatorNode, etc.)
// ---------------------------------------------------------------------------

/// Extract a NodeId from any audio node JS value. We look for a hidden `__id`
/// property that every node class sets on its prototype. If not found, fall
/// back to DESTINATION_ID.
pub(crate) fn node_id_from_value(v: &rquickjs::Value<'_>) -> NodeId {
    if let Some(obj) = v.as_object() {
        // Try each known type in order
        if let Some(cls) = Class::<GainNode>::from_object(obj) {
            return cls.borrow().node_id;
        }
        if let Some(cls) = Class::<crate::source::AudioBufferSourceNode>::from_object(obj) {
            return cls.borrow().node_id;
        }
        if let Some(cls) = Class::<crate::oscillator::OscillatorNode>::from_object(obj) {
            return cls.borrow().node_id;
        }
        if let Some(cls) = Class::<crate::analyser::AnalyserNode>::from_object(obj) {
            return cls.borrow().node_id;
        }
        if let Some(cls) = Class::<crate::routing::AudioDestinationNode>::from_object(obj) {
            return cls.borrow().node_id;
        }
        // Fall back to DESTINATION_ID when the value is unrecognized
        return DESTINATION_ID;
    }
    DESTINATION_ID
}

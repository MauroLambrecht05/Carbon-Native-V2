// oscillator.rs — OscillatorNode JS class.
//
// Wraps a NodeId pointing at a Node::Oscillator in the Graph. Waveform
// generation (sine/square/sawtooth/triangle) lives in mixer.rs's
// render_osc_into and the waveform() helper.

use crate::{
    gain::node_id_from_value,
    mixer::{with_graph, with_graph_mut, Node, NodeId, OscillatorKind, OscillatorState},
    routing::AudioParam,
};
use rquickjs::{
    class::{JsClass, Trace, Tracer, Writable},
    function::{Constructor, Func, Opt, This},
    Class, Ctx, Object, Result, Value,
};
use std::sync::atomic::{AtomicU32, Ordering};

pub struct OscillatorNode {
    pub node_id: NodeId,
}

unsafe impl<'js> rquickjs::JsLifetime<'js> for OscillatorNode {
    type Changed<'to> = OscillatorNode;
}

impl<'js> Trace<'js> for OscillatorNode {
    fn trace<'a>(&self, _tracer: Tracer<'a, 'js>) {}
}

impl<'js> JsClass<'js> for OscillatorNode {
    const NAME: &'static str = "OscillatorNode";
    type Mutable = Writable;

    fn prototype(ctx: &Ctx<'js>) -> Result<Option<Object<'js>>> {
        let proto = Object::new(ctx.clone())?;

        // type getter/setter ("sine" | "square" | "sawtooth" | "triangle")
        crate::common::define_accessor(
            ctx,
            &proto,
            "type",
            Func::from(|this: This<Class<'js, OscillatorNode>>| -> &'static str {
                let id = this.borrow().node_id;
                with_graph(|g| match g.nodes.get(&id) {
                    Some(Node::Oscillator(o)) => o.kind.as_str(),
                    _ => "sine",
                })
            }),
            Func::from(|this: This<Class<'js, OscillatorNode>>, kind_str: String| {
                let id = this.borrow().node_id;
                if let Some(kind) = OscillatorKind::from_str(&kind_str) {
                    with_graph_mut(|g| {
                        if let Some(Node::Oscillator(o)) = g.nodes.get_mut(&id) {
                            o.kind = kind;
                        }
                    });
                }
            }),
        )?;

        // frequency — AudioParam-like, backed by OscillatorState.frequency_bits
        proto.set(
            "frequency",
            Func::from(
                |ctx: Ctx<'js>,
                 this: This<Class<'js, OscillatorNode>>|
                 -> Result<Class<'js, AudioParam>> {
                    let id = this.borrow().node_id;
                    let current = with_graph(|g| match g.nodes.get(&id) {
                        Some(Node::Oscillator(o)) => {
                            f32::from_bits(o.frequency_bits.load(Ordering::Relaxed))
                        }
                        _ => 440.0,
                    });
                    let param = Class::instance(
                        ctx.clone(),
                        AudioParam {
                            state: crate::routing::ParamState::new(current, 0.0, 22050.0),
                        },
                    )?;
                    let nid = id;
                    crate::common::define_accessor(
                        &ctx,
                        &param,
                        "value",
                        Func::from(move || -> f32 {
                            with_graph(|g| match g.nodes.get(&nid) {
                                Some(Node::Oscillator(o)) => {
                                    f32::from_bits(o.frequency_bits.load(Ordering::Relaxed))
                                }
                                _ => 440.0,
                            })
                        }),
                        Func::from(move |v: f32| {
                            with_graph_mut(|g| {
                                if let Some(Node::Oscillator(o)) = g.nodes.get_mut(&nid) {
                                    o.frequency_bits.store(v.to_bits(), Ordering::Relaxed);
                                }
                            });
                        }),
                    )?;
                    Ok(param)
                },
            ),
        )?;

        // detune — AudioParam-like, backed by OscillatorState.detune_bits
        proto.set(
            "detune",
            Func::from(
                |ctx: Ctx<'js>,
                 this: This<Class<'js, OscillatorNode>>|
                 -> Result<Class<'js, AudioParam>> {
                    let id = this.borrow().node_id;
                    let current = with_graph(|g| match g.nodes.get(&id) {
                        Some(Node::Oscillator(o)) => {
                            f32::from_bits(o.detune_bits.load(Ordering::Relaxed))
                        }
                        _ => 0.0,
                    });
                    let param = Class::instance(
                        ctx.clone(),
                        AudioParam {
                            state: crate::routing::ParamState::new(current, -1200.0 * 12.0, 1200.0 * 12.0),
                        },
                    )?;
                    let nid = id;
                    crate::common::define_accessor(
                        &ctx,
                        &param,
                        "value",
                        Func::from(move || -> f32 {
                            with_graph(|g| match g.nodes.get(&nid) {
                                Some(Node::Oscillator(o)) => {
                                    f32::from_bits(o.detune_bits.load(Ordering::Relaxed))
                                }
                                _ => 0.0,
                            })
                        }),
                        Func::from(move |v: f32| {
                            with_graph_mut(|g| {
                                if let Some(Node::Oscillator(o)) = g.nodes.get_mut(&nid) {
                                    o.detune_bits.store(v.to_bits(), Ordering::Relaxed);
                                }
                            });
                        }),
                    )?;
                    Ok(param)
                },
            ),
        )?;

        // start(when?)
        proto.set(
            "start",
            Func::from(|this: This<Class<'js, OscillatorNode>>, when: Opt<f64>| {
                let id = this.borrow().node_id;
                with_graph_mut(|g| {
                    let sr = g.device_sample_rate as f64;
                    let cur = g.current_frame.load(Ordering::Relaxed);
                    let when_secs = when.0.unwrap_or(0.0).max(0.0);
                    if let Some(Node::Oscillator(o)) = g.nodes.get_mut(&id) {
                        o.start_frame = Some(cur + (when_secs * sr) as u64);
                        o.finished = false;
                    }
                });
            }),
        )?;

        // stop(when?)
        proto.set(
            "stop",
            Func::from(|this: This<Class<'js, OscillatorNode>>, when: Opt<f64>| {
                let id = this.borrow().node_id;
                with_graph_mut(|g| {
                    let sr = g.device_sample_rate as f64;
                    let cur = g.current_frame.load(Ordering::Relaxed);
                    let when_secs = when.0.unwrap_or(0.0).max(0.0);
                    if let Some(Node::Oscillator(o)) = g.nodes.get_mut(&id) {
                        o.stop_frame = Some(cur + (when_secs * sr) as u64);
                    }
                });
            }),
        )?;

        // connect(destination)
        proto.set(
            "connect",
            Func::from(
                |this: This<Class<'js, OscillatorNode>>, dest: Value<'js>| -> Value<'js> {
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
                |this: This<Class<'js, OscillatorNode>>, dest: Opt<Value<'js>>| {
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
        let c = Constructor::new_class::<OscillatorNode, _, _>(ctx.clone(), || make_oscillator_node())?;
        Ok(Some(c))
    }
}

impl<'js> rquickjs::IntoJs<'js> for OscillatorNode {
    fn into_js(self, ctx: &rquickjs::Ctx<'js>) -> rquickjs::Result<rquickjs::Value<'js>> {
        Class::instance(ctx.clone(), self)?.into_js(ctx)
    }
}

fn make_oscillator_node() -> OscillatorNode {
    let id = crate::mixer::next_node_id();
    with_graph_mut(|g| {
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
    OscillatorNode { node_id: id }
}

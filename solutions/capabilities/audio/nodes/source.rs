// source.rs — AudioBufferSourceNode JS class.
//
// Wraps a NodeId (pointing to a Node::Source in the Graph). Playback is driven
// by the mixer's render_source_into function. The JS API calls here translate
// into mutations of SourceState inside the Graph.

use crate::{
    buffer::AudioBuffer,
    gain::node_id_from_value,
    mixer::{with_graph, with_graph_mut, Node, NodeId, SourceState},
    routing::AudioParam,
};
use rquickjs::{
    class::{JsClass, Trace, Tracer, Writable},
    function::{Constructor, Func, Opt, This},
    Class, Ctx, Object, Result, Value,
};
use std::sync::atomic::Ordering;

pub struct AudioBufferSourceNode {
    pub node_id: NodeId,
}

unsafe impl rquickjs::JsLifetime<'_> for AudioBufferSourceNode {
    type Changed<'to> = AudioBufferSourceNode;
}

impl<'js> Trace<'js> for AudioBufferSourceNode {
    fn trace<'a>(&self, _tracer: Tracer<'a, 'js>) {}
}

impl<'js> JsClass<'js> for AudioBufferSourceNode {
    const NAME: &'static str = "AudioBufferSourceNode";
    type Mutable = Writable;

    fn prototype(ctx: &Ctx<'js>) -> Result<Option<Object<'js>>> {
        let proto = Object::new(ctx.clone())?;

        // buffer setter — queue decoded PCM to the mixer
        crate::common::define_accessor(
            ctx,
            &proto,
            "buffer",
            Func::from(
                |ctx: Ctx<'js>,
                 this: This<Class<'js, AudioBufferSourceNode>>|
                 -> Result<Value<'js>> {
                    // Getter: return null (we don't store a separate JS reference)
                    let _ = this;
                    Ok(Value::new_null(ctx))
                },
            ),
            Func::from(
                |this: This<Class<'js, AudioBufferSourceNode>>, buf: Class<'js, AudioBuffer>| {
                    let id = this.borrow().node_id;
                    let arc = buf.borrow().inner.clone();
                    with_graph_mut(|g| {
                        if let Some(Node::Source(s)) = g.nodes.get_mut(&id) {
                            s.buffer = Some(arc);
                        }
                    });
                },
            ),
        )?;

        // loop getter/setter
        crate::common::define_accessor(
            ctx,
            &proto,
            "loop",
            Func::from(|this: This<Class<'js, AudioBufferSourceNode>>| -> bool {
                let id = this.borrow().node_id;
                with_graph(|g| match g.nodes.get(&id) {
                    Some(Node::Source(s)) => s.loop_,
                    _ => false,
                })
            }),
            Func::from(|this: This<Class<'js, AudioBufferSourceNode>>, v: bool| {
                let id = this.borrow().node_id;
                with_graph_mut(|g| {
                    if let Some(Node::Source(s)) = g.nodes.get_mut(&id) {
                        s.loop_ = v;
                    }
                });
            }),
        )?;

        // loopStart getter/setter (seconds)
        crate::common::define_accessor(
            ctx,
            &proto,
            "loopStart",
            Func::from(|this: This<Class<'js, AudioBufferSourceNode>>| -> f64 {
                let id = this.borrow().node_id;
                with_graph(|g| match g.nodes.get(&id) {
                    Some(Node::Source(s)) => {
                        s.loop_start_frames as f64 / g.device_sample_rate as f64
                    }
                    _ => 0.0,
                })
            }),
            Func::from(|this: This<Class<'js, AudioBufferSourceNode>>, v: f64| {
                let id = this.borrow().node_id;
                with_graph_mut(|g| {
                    let sr = g.device_sample_rate;
                    if let Some(Node::Source(s)) = g.nodes.get_mut(&id) {
                        s.loop_start_frames = (v * sr as f64) as u64;
                    }
                });
            }),
        )?;

        // loopEnd getter/setter (seconds)
        crate::common::define_accessor(
            ctx,
            &proto,
            "loopEnd",
            Func::from(|this: This<Class<'js, AudioBufferSourceNode>>| -> f64 {
                let id = this.borrow().node_id;
                with_graph(|g| match g.nodes.get(&id) {
                    Some(Node::Source(s)) => s.loop_end_frames as f64 / g.device_sample_rate as f64,
                    _ => 0.0,
                })
            }),
            Func::from(|this: This<Class<'js, AudioBufferSourceNode>>, v: f64| {
                let id = this.borrow().node_id;
                with_graph_mut(|g| {
                    let sr = g.device_sample_rate;
                    if let Some(Node::Source(s)) = g.nodes.get_mut(&id) {
                        s.loop_end_frames = (v * sr as f64) as u64;
                    }
                });
            }),
        )?;

        // playbackRate — returns an AudioParam-like object backed by SourceState.playback_rate
        proto.set(
            "playbackRate",
            Func::from(
                |ctx: Ctx<'js>,
                 this: This<Class<'js, AudioBufferSourceNode>>|
                 -> Result<Class<'js, AudioParam>> {
                    let id = this.borrow().node_id;
                    let current = with_graph(|g| match g.nodes.get(&id) {
                        Some(Node::Source(s)) => s.playback_rate,
                        _ => 1.0,
                    });
                    let param = Class::instance(
                        ctx.clone(),
                        AudioParam {
                            state: crate::routing::ParamState::new(current, 0.0, f32::MAX),
                        },
                    )?;
                    let nid = id;
                    crate::common::define_accessor(
                        &ctx,
                        &param,
                        "value",
                        Func::from(move || -> f32 {
                            with_graph(|g| match g.nodes.get(&nid) {
                                Some(Node::Source(s)) => s.playback_rate,
                                _ => 1.0,
                            })
                        }),
                        Func::from(move |v: f32| {
                            with_graph_mut(|g| {
                                if let Some(Node::Source(s)) = g.nodes.get_mut(&nid) {
                                    s.playback_rate = v;
                                }
                            });
                        }),
                    )?;
                    Ok(param)
                },
            ),
        )?;

        // onended — stored as a plain property (we can't call it back from Rust
        // without unsafe shenanigans, so it's a stub for API compat).
        proto.set("onended", rquickjs::Value::new_null(ctx.clone()))?;

        // start(when?, offset?, duration?)
        proto.set(
            "start",
            Func::from(
                |this: This<Class<'js, AudioBufferSourceNode>>,
                 when: Opt<f64>,
                 offset: Opt<f64>,
                 _duration: Opt<f64>| {
                    let id = this.borrow().node_id;
                    with_graph_mut(|g| {
                        let sr = g.device_sample_rate as f64;
                        let cur = g.current_frame.load(Ordering::Relaxed);
                        let when_secs = when.0.unwrap_or(0.0).max(0.0);
                        let offset_secs = offset.0.unwrap_or(0.0).max(0.0);
                        if let Some(Node::Source(s)) = g.nodes.get_mut(&id) {
                            s.start_frame = Some(cur + (when_secs * sr) as u64);
                            s.offset_frames = (offset_secs * sr) as u64;
                            s.playhead = s.offset_frames as f64;
                            s.finished = false;
                        }
                    });
                },
            ),
        )?;

        // stop(when?)
        proto.set(
            "stop",
            Func::from(
                |this: This<Class<'js, AudioBufferSourceNode>>, when: Opt<f64>| {
                    let id = this.borrow().node_id;
                    with_graph_mut(|g| {
                        let sr = g.device_sample_rate as f64;
                        let cur = g.current_frame.load(Ordering::Relaxed);
                        let when_secs = when.0.unwrap_or(0.0).max(0.0);
                        if let Some(Node::Source(s)) = g.nodes.get_mut(&id) {
                            s.stop_frame = Some(cur + (when_secs * sr) as u64);
                        }
                    });
                },
            ),
        )?;

        // connect(destination) → destination
        proto.set(
            "connect",
            Func::from(
                |this: This<Class<'js, AudioBufferSourceNode>>, dest: Value<'js>| -> Value<'js> {
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
                |this: This<Class<'js, AudioBufferSourceNode>>, dest: Opt<Value<'js>>| {
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
        let c = Constructor::new_class::<AudioBufferSourceNode, _, _>(ctx.clone(), || {
            make_source_node()
        })?;
        Ok(Some(c))
    }
}

impl<'js> rquickjs::IntoJs<'js> for AudioBufferSourceNode {
    fn into_js(self, ctx: &rquickjs::Ctx<'js>) -> rquickjs::Result<rquickjs::Value<'js>> {
        Class::instance(ctx.clone(), self)?.into_js(ctx)
    }
}

fn make_source_node() -> AudioBufferSourceNode {
    let id = crate::mixer::next_node_id();
    with_graph_mut(|g| {
        g.nodes.insert(
            id,
            Node::Source(SourceState {
                playback_rate: 1.0,
                ..Default::default()
            }),
        );
    });
    AudioBufferSourceNode { node_id: id }
}

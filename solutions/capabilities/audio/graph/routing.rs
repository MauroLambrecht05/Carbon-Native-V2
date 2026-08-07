// routing.rs — AudioParam and AudioDestinationNode.
//
// AudioParam
// ----------
// Represents a single automatable parameter (gain value, frequency, detune,
// playback rate). The Web Audio spec defines a "timeline" of events that the
// audio thread processes sample-by-sample. We approximate this with the same
// Atomic storage that GainState uses in mixer.rs, plus a Vec<AutomationEvent>
// that the JS thread appends to and the audio thread processes in order.
//
// For the demo we implement the K-rate (control-rate) path: the audio thread
// reads the parameter value once per buffer (not once per sample). This is
// valid for all parameters except some edge cases in the spec. Full a-rate
// automation is a future enhancement.
//
// AudioDestinationNode
// --------------------
// A singleton output sink. There is exactly one per AudioContext; it cannot be
// constructed by user JS. We expose only `channelCount` and stub `connect` /
// `disconnect` so user-land `ctx.destination.channelCount` works.

use crate::mixer::{with_graph_mut, NodeId, DESTINATION_ID};
use rquickjs::{
    class::{JsClass, Trace, Tracer, Writable},
    function::{Constructor, Func, This},
    Class, Ctx, Object, Result,
};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

// ---------------------------------------------------------------------------
// Automation event types (matches Web Audio spec §1.9)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub enum AutomationEvent {
    SetValueAtTime { value: f32, start_time: f64 },
    LinearRampToValueAtTime { value: f32, end_time: f64 },
    ExponentialRampToValueAtTime { value: f32, end_time: f64 },
    SetTargetAtTime { target: f32, start_time: f64, time_constant: f64 },
}

// ---------------------------------------------------------------------------
// AudioParam
// ---------------------------------------------------------------------------

/// Shared state for one automatable parameter. The atomic stores the current
/// instantaneous value; the Vec (protected by a Mutex) holds pending events.
#[derive(Debug)]
pub struct ParamState {
    /// Current value bits (f32 stored in u32 via `to_bits`).
    pub value_bits: AtomicU32,
    /// Automation timeline. JS thread appends; audio thread drains completed.
    pub events: parking_lot::Mutex<Vec<AutomationEvent>>,
    pub default_value: f32,
    pub min_value: f32,
    pub max_value: f32,
}

impl ParamState {
    pub fn new(default: f32, min: f32, max: f32) -> Arc<Self> {
        Arc::new(Self {
            value_bits: AtomicU32::new(default.to_bits()),
            events: parking_lot::Mutex::new(Vec::new()),
            default_value: default,
            min_value: min,
            max_value: max,
        })
    }

    pub fn get(&self) -> f32 {
        f32::from_bits(self.value_bits.load(Ordering::Relaxed))
    }

    pub fn set(&self, v: f32) {
        let clamped = v.max(self.min_value).min(self.max_value);
        self.value_bits.store(clamped.to_bits(), Ordering::Relaxed);
    }
}

/// JS-visible AudioParam class. Wraps an Arc<ParamState> so multiple owners
/// (the node that created it + the GainNode handle in JS) all see the same
/// atomic value.
pub struct AudioParam {
    pub state: Arc<ParamState>,
}

impl AudioParam {
    pub fn new(default: f32, min: f32, max: f32) -> Self {
        Self { state: ParamState::new(default, min, max) }
    }
}

unsafe impl<'js> rquickjs::JsLifetime<'js> for AudioParam {
    type Changed<'to> = AudioParam;
}

impl<'js> Trace<'js> for AudioParam {
    fn trace<'a>(&self, _tracer: Tracer<'a, 'js>) {}
}

impl<'js> JsClass<'js> for AudioParam {
    const NAME: &'static str = "AudioParam";
    type Mutable = Writable;

    fn prototype(ctx: &Ctx<'js>) -> Result<Option<Object<'js>>> {
        let proto = Object::new(ctx.clone())?;

        // value getter/setter
        crate::common::define_accessor(
            ctx,
            &proto,
            "value",
            Func::from(|this: This<Class<'js, AudioParam>>| -> f32 {
                this.borrow().state.get()
            }),
            Func::from(|this: This<Class<'js, AudioParam>>, v: f32| {
                this.borrow().state.set(v);
            }),
        )?;

        // defaultValue
        crate::common::define_accessor(
            ctx,
            &proto,
            "defaultValue",
            Func::from(|this: This<Class<'js, AudioParam>>| -> f32 {
                this.borrow().state.default_value
            }),
            Func::from(|_this: This<Class<'js, AudioParam>>, _v: f32| {}),
        )?;

        // minValue
        crate::common::define_accessor(
            ctx,
            &proto,
            "minValue",
            Func::from(|this: This<Class<'js, AudioParam>>| -> f32 {
                this.borrow().state.min_value
            }),
            Func::from(|_this: This<Class<'js, AudioParam>>, _v: f32| {}),
        )?;

        // maxValue
        crate::common::define_accessor(
            ctx,
            &proto,
            "maxValue",
            Func::from(|this: This<Class<'js, AudioParam>>| -> f32 {
                this.borrow().state.max_value
            }),
            Func::from(|_this: This<Class<'js, AudioParam>>, _v: f32| {}),
        )?;

        // setValueAtTime(value, startTime)
        proto.set(
            "setValueAtTime",
            Func::from(
                |this: This<Class<'js, AudioParam>>, value: f32, start_time: f64| {
                    let state = this.borrow().state.clone();
                    // Immediate-ish: also set the atomic so ramp queries don't
                    // see a stale value if start_time ≈ currentTime.
                    state.set(value);
                    state
                        .events
                        .lock()
                        .push(AutomationEvent::SetValueAtTime { value, start_time });
                },
            ),
        )?;

        // linearRampToValueAtTime(value, endTime)
        proto.set(
            "linearRampToValueAtTime",
            Func::from(
                |this: This<Class<'js, AudioParam>>, value: f32, end_time: f64| {
                    this.borrow()
                        .state
                        .events
                        .lock()
                        .push(AutomationEvent::LinearRampToValueAtTime { value, end_time });
                },
            ),
        )?;

        // exponentialRampToValueAtTime(value, endTime)
        proto.set(
            "exponentialRampToValueAtTime",
            Func::from(
                |this: This<Class<'js, AudioParam>>, value: f32, end_time: f64| {
                    this.borrow()
                        .state
                        .events
                        .lock()
                        .push(AutomationEvent::ExponentialRampToValueAtTime {
                            value,
                            end_time,
                        });
                },
            ),
        )?;

        // setTargetAtTime(target, startTime, timeConstant)
        proto.set(
            "setTargetAtTime",
            Func::from(
                |this: This<Class<'js, AudioParam>>,
                 target: f32,
                 start_time: f64,
                 time_constant: f64| {
                    this.borrow()
                        .state
                        .events
                        .lock()
                        .push(AutomationEvent::SetTargetAtTime {
                            target,
                            start_time,
                            time_constant,
                        });
                },
            ),
        )?;

        // cancelScheduledValues(cancelTime)
        proto.set(
            "cancelScheduledValues",
            Func::from(|this: This<Class<'js, AudioParam>>, _cancel_time: f64| {
                this.borrow().state.events.lock().clear();
            }),
        )?;

        Ok(Some(proto))
    }

    fn constructor(_ctx: &Ctx<'js>) -> Result<Option<Constructor<'js>>> {
        // AudioParam is not user-constructable (spec says internal)
        Ok(None)
    }
}

// ---------------------------------------------------------------------------
// AudioDestinationNode
// ---------------------------------------------------------------------------

pub struct AudioDestinationNode {
    pub node_id: NodeId,
}

impl AudioDestinationNode {
    pub fn new() -> Self {
        Self { node_id: DESTINATION_ID }
    }
}

unsafe impl<'js> rquickjs::JsLifetime<'js> for AudioDestinationNode {
    type Changed<'to> = AudioDestinationNode;
}

impl<'js> Trace<'js> for AudioDestinationNode {
    fn trace<'a>(&self, _tracer: Tracer<'a, 'js>) {}
}

impl<'js> JsClass<'js> for AudioDestinationNode {
    const NAME: &'static str = "AudioDestinationNode";
    type Mutable = Writable;

    fn prototype(ctx: &Ctx<'js>) -> Result<Option<Object<'js>>> {
        let proto = Object::new(ctx.clone())?;

        crate::common::define_accessor(
            ctx,
            &proto,
            "channelCount",
            Func::from(|_this: This<Class<'js, AudioDestinationNode>>| -> u32 { 2 }),
            Func::from(|_this: This<Class<'js, AudioDestinationNode>>, _v: u32| {}),
        )?;

        // connect() — destination nodes don't connect downstream, so this
        // is a no-op stub for API compat.
        proto.set(
            "connect",
            Func::from(|_this: This<Class<'js, AudioDestinationNode>>| {}),
        )?;

        proto.set(
            "disconnect",
            Func::from(|_this: This<Class<'js, AudioDestinationNode>>| {
                // Clear all inputs into the destination
                with_graph_mut(|g| {
                    g.destination_inputs.clear();
                });
            }),
        )?;

        Ok(Some(proto))
    }

    fn constructor(_ctx: &Ctx<'js>) -> Result<Option<Constructor<'js>>> {
        Ok(None)
    }
}

impl<'js> rquickjs::IntoJs<'js> for AudioParam {
    fn into_js(self, ctx: &Ctx<'js>) -> Result<rquickjs::Value<'js>> {
        Class::instance(ctx.clone(), self)?.into_js(ctx)
    }
}

impl<'js> rquickjs::IntoJs<'js> for AudioDestinationNode {
    fn into_js(self, ctx: &Ctx<'js>) -> Result<rquickjs::Value<'js>> {
        Class::instance(ctx.clone(), self)?.into_js(ctx)
    }
}


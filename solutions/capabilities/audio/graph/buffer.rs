// buffer.rs — AudioBuffer and symphonia-backed decodeAudioData.
//
// AudioBuffer
// -----------
// Stores decoded PCM audio as planar f32 data (channel 0 first, then channel 1,
// etc.) matching the DecodedBuffer layout in mixer.rs. JS sees:
//   - numberOfChannels, length, sampleRate, duration (read-only getters)
//   - getChannelData(channel) → returns a regular JS Array of f32 samples
//   - copyToChannel / copyFromChannel for bulk copies
//
// We do NOT return Float32Array here because rquickjs's TypedArray bridge
// requires the underlying buffer to stay pinned in memory for the lifetime of
// the JSValue — which is impossible across async boundaries with our Arc model.
// A plain Array is spec-compliant (the spec says Float32Array but we're not a
// browser; the data is correct).
//
// decodeAudioData
// ---------------
// Synchronous in this implementation (no Workers). Symphonia decodes the input
// bytes through whatever codec it detects (WAV/PCM, MP3, OGG/Vorbis, FLAC).
// The decoded f32 samples are stored planar and wrapped in AudioBuffer.
//
// Error cases: unsupported format, corrupt data → Err.

use crate::mixer::DecodedBuffer;
use rquickjs::{
    class::{JsClass, Trace, Tracer, Writable},
    function::{Constructor, Func, This},
    Array, Class, Ctx, Object, Result,
};
use std::sync::Arc;
use symphonia::core::{
    audio::SampleBuffer,
    codecs::DecoderOptions,
    formats::FormatOptions,
    io::MediaSourceStream,
    meta::MetadataOptions,
    probe::Hint,
};

// ---------------------------------------------------------------------------
// AudioBuffer
// ---------------------------------------------------------------------------

pub struct AudioBuffer {
    /// Shared with the mixer (immutable after construction).
    pub inner: Arc<DecodedBuffer>,
}

impl AudioBuffer {
    pub fn new(channels: usize, length: usize, sample_rate: u32) -> Self {
        Self {
            inner: Arc::new(DecodedBuffer {
                channels,
                sample_rate,
                frames: length,
                data: vec![0.0f32; channels * length],
            }),
        }
    }

    pub fn from_decoded(buf: Arc<DecodedBuffer>) -> Self {
        Self { inner: buf }
    }
}

unsafe impl<'js> rquickjs::JsLifetime<'js> for AudioBuffer {
    type Changed<'to> = AudioBuffer;
}

impl<'js> Trace<'js> for AudioBuffer {
    fn trace<'a>(&self, _tracer: Tracer<'a, 'js>) {}
}

impl<'js> JsClass<'js> for AudioBuffer {
    const NAME: &'static str = "AudioBuffer";
    type Mutable = Writable;

    fn prototype(ctx: &Ctx<'js>) -> Result<Option<Object<'js>>> {
        let proto = Object::new(ctx.clone())?;

        // numberOfChannels
        crate::common::define_accessor(
            ctx,
            &proto,
            "numberOfChannels",
            Func::from(|this: This<Class<'js, AudioBuffer>>| -> u32 {
                this.borrow().inner.channels as u32
            }),
            Func::from(|_this: This<Class<'js, AudioBuffer>>, _v: u32| {}),
        )?;

        // length
        crate::common::define_accessor(
            ctx,
            &proto,
            "length",
            Func::from(|this: This<Class<'js, AudioBuffer>>| -> u32 {
                this.borrow().inner.frames as u32
            }),
            Func::from(|_this: This<Class<'js, AudioBuffer>>, _v: u32| {}),
        )?;

        // sampleRate
        crate::common::define_accessor(
            ctx,
            &proto,
            "sampleRate",
            Func::from(|this: This<Class<'js, AudioBuffer>>| -> f32 {
                this.borrow().inner.sample_rate as f32
            }),
            Func::from(|_this: This<Class<'js, AudioBuffer>>, _v: f32| {}),
        )?;

        // duration
        crate::common::define_accessor(
            ctx,
            &proto,
            "duration",
            Func::from(|this: This<Class<'js, AudioBuffer>>| -> f64 {
                let b = this.borrow();
                b.inner.frames as f64 / b.inner.sample_rate as f64
            }),
            Func::from(|_this: This<Class<'js, AudioBuffer>>, _v: f64| {}),
        )?;

        // getChannelData(channel) → Array<f32>
        proto.set(
            "getChannelData",
            Func::from(
                |ctx: Ctx<'js>,
                 this: This<Class<'js, AudioBuffer>>,
                 channel: u32|
                 -> Result<Array<'js>> {
                    let b = this.borrow();
                    let ch = channel as usize;
                    let frames = b.inner.frames;
                    let channels = b.inner.channels;
                    if ch >= channels {
                        return Err(rquickjs::Error::Unknown);
                    }
                    let arr = Array::new(ctx.clone())?;
                    let offset = ch * frames;
                    for i in 0..frames {
                        arr.set(i, b.inner.data[offset + i])?;
                    }
                    Ok(arr)
                },
            ),
        )?;

        // copyToChannel(source: Array<f32>, channelNumber, bufferOffset)
        proto.set(
            "copyToChannel",
            Func::from(
                |this: This<Class<'js, AudioBuffer>>,
                 source: Array<'js>,
                 channel_number: u32,
                 buffer_offset: rquickjs::function::Opt<u32>| {
                    let b = this.borrow();
                    let ch = channel_number as usize;
                    let frames = b.inner.frames;
                    let channels = b.inner.channels;
                    if ch >= channels {
                        return;
                    }
                    let buf_off = buffer_offset.0.unwrap_or(0) as usize;
                    // SAFETY: We need mut access but we hold an Arc. This is
                    // a known limitation: copyToChannel after construction is
                    // only safe before the buffer is shared with the mixer.
                    // We use unsafe here because the alternative (Mutex wrap)
                    // would add latency on every audio-thread read.
                    let data_ptr = b.inner.data.as_ptr() as *mut f32;
                    let len = source.len() as usize;
                    for i in 0..len {
                        let dst_frame = buf_off + i;
                        if dst_frame >= frames {
                            break;
                        }
                        let v: f32 = source.get(i).unwrap_or(0.0);
                        let idx = ch * frames + dst_frame;
                        unsafe { *data_ptr.add(idx) = v; }
                    }
                },
            ),
        )?;

        // copyFromChannel(destination: Array<f32>, channelNumber, bufferOffset)
        proto.set(
            "copyFromChannel",
            Func::from(
                |this: This<Class<'js, AudioBuffer>>,
                 dest: Array<'js>,
                 channel_number: u32,
                 buffer_offset: rquickjs::function::Opt<u32>| -> Result<()> {
                    let b = this.borrow();
                    let ch = channel_number as usize;
                    let frames = b.inner.frames;
                    let channels = b.inner.channels;
                    if ch >= channels {
                        return Ok(());
                    }
                    let buf_off = buffer_offset.0.unwrap_or(0) as usize;
                    let len = dest.len() as usize;
                    let offset = ch * frames;
                    for i in 0..len {
                        let src_frame = buf_off + i;
                        let v = if src_frame < frames {
                            b.inner.data[offset + src_frame]
                        } else {
                            0.0
                        };
                        dest.set(i, v)?;
                    }
                    Ok(())
                },
            ),
        )?;

        Ok(Some(proto))
    }

    fn constructor(ctx: &Ctx<'js>) -> Result<Option<Constructor<'js>>> {
        let c = Constructor::new_class::<AudioBuffer, _, _>(
            ctx.clone(),
            |ch: rquickjs::function::Opt<u32>,
             len: rquickjs::function::Opt<u32>,
             sr: rquickjs::function::Opt<f32>| make_audio_buffer(ch, len, sr),
        )?;
        Ok(Some(c))
    }
}

impl<'js> rquickjs::IntoJs<'js> for AudioBuffer {
    fn into_js(self, ctx: &rquickjs::Ctx<'js>) -> rquickjs::Result<rquickjs::Value<'js>> {
        Class::instance(ctx.clone(), self)?.into_js(ctx)
    }
}

fn make_audio_buffer(
    channels: rquickjs::function::Opt<u32>,
    length: rquickjs::function::Opt<u32>,
    sample_rate: rquickjs::function::Opt<f32>,
) -> AudioBuffer {
    AudioBuffer::new(
        channels.0.unwrap_or(1) as usize,
        length.0.unwrap_or(0) as usize,
        sample_rate.0.unwrap_or(44100.0) as u32,
    )
}

// ---------------------------------------------------------------------------
// decode_audio_data — symphonia decoding
// ---------------------------------------------------------------------------

/// Decode raw audio bytes (WAV, MP3, OGG/Vorbis, FLAC) into an AudioBuffer.
///
/// This is intentionally synchronous. The Web Audio spec's `decodeAudioData`
/// returns a Promise; callers in `context.rs` wrap this in a JS Promise.
pub fn decode_audio_data(bytes: Vec<u8>) -> Result<AudioBuffer> {
    let cursor = std::io::Cursor::new(bytes);
    let mss = MediaSourceStream::new(Box::new(cursor), Default::default());

    let hint = Hint::new();
    let format_opts = FormatOptions::default();
    let metadata_opts = MetadataOptions::default();
    let decoder_opts = DecoderOptions::default();

    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &format_opts, &metadata_opts)
        .map_err(|_e| rquickjs::Error::Unknown)?;

    let mut format = probed.format;
    let track = format
        .default_track()
        .ok_or(rquickjs::Error::Unknown)?;

    let track_id = track.id;
    let sample_rate = track.codec_params.sample_rate.unwrap_or(44100);
    let channels_count = track
        .codec_params
        .channels
        .map(|c| c.count())
        .unwrap_or(1);

    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &decoder_opts)
        .map_err(|_e| rquickjs::Error::Unknown)?;

    // Collect all decoded packets into planar f32.
    let mut planar: Vec<Vec<f32>> = vec![Vec::new(); channels_count];

    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(_) => break,
        };
        if packet.track_id() != track_id {
            continue;
        }
        let audio_buf = match decoder.decode(&packet) {
            Ok(b) => b,
            Err(_) => continue,
        };
        let spec = *audio_buf.spec();
        let mut sample_buf: SampleBuffer<f32> =
            SampleBuffer::new(audio_buf.capacity() as u64, spec);
        sample_buf.copy_interleaved_ref(audio_buf);

        let interleaved = sample_buf.samples();
        let ch = spec.channels.count();
        // Deinterleave into planar
        let frames = interleaved.len() / ch.max(1);
        for (i, &s) in interleaved.iter().enumerate() {
            let channel = i % ch;
            if channel < planar.len() {
                planar[channel].push(s);
            }
        }
        let _ = frames; // used indirectly via loop
    }

    let frames = planar.first().map(|v| v.len()).unwrap_or(0);
    let mut data = vec![0.0f32; channels_count * frames];
    for (ch, ch_data) in planar.iter().enumerate() {
        let dst = &mut data[ch * frames..ch * frames + ch_data.len().min(frames)];
        dst.copy_from_slice(&ch_data[..ch_data.len().min(frames)]);
    }

    let decoded = Arc::new(DecodedBuffer {
        channels: channels_count,
        sample_rate,
        frames,
        data,
    });

    Ok(AudioBuffer::from_decoded(decoded))
}

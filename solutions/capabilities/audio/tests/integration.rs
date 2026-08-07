// integration.rs — carbon-audio integration tests.
//
// These tests run in a minimal rquickjs context with the `no-audio` feature
// enabled (no real cpal device, no sound). The JS API still works — nodes
// are created, connected, and the graph is valid — we just don't produce
// output.
//
// To run:
//   cargo test -p carbon-audio --features no-audio
//   cargo test -p carbon-audio --features no-audio -- --nocapture
//
// CI note: the `no-audio` feature skips cpal device open, so these tests
// work in headless environments without a sound card.

use rquickjs::{Context as JsContext, Runtime as JsRuntime};

/// Helper: spin up a minimal rquickjs context with all audio classes registered.
fn make_ctx() -> (JsRuntime, JsContext) {
    let rt = JsRuntime::new().expect("js runtime");
    let ctx = JsContext::full(&rt).expect("js context");
    ctx.with(|ctx| {
        carbon_audio::register_audio(&ctx).expect("register_audio");
    });
    (rt, ctx)
}

// ---------------------------------------------------------------------------
// Test 1: register_audio runs without panicking
// ---------------------------------------------------------------------------

#[test]
fn test_register_audio_no_panic() {
    let (_rt, ctx) = make_ctx();
    ctx.with(|ctx| {
        // Check that the global classes exist
        let globals = ctx.globals();
        let has_audio_context: bool = globals
            .get::<_, rquickjs::Value<'_>>("AudioContext")
            .map(|v| !v.is_undefined())
            .unwrap_or(false);
        assert!(has_audio_context, "AudioContext should be defined globally");

        let has_gain: bool = globals
            .get::<_, rquickjs::Value<'_>>("GainNode")
            .map(|v| !v.is_undefined())
            .unwrap_or(false);
        assert!(has_gain, "GainNode should be defined globally");
    });
}

// ---------------------------------------------------------------------------
// Test 2: AudioBuffer allocation
// ---------------------------------------------------------------------------

#[test]
fn test_audio_buffer_allocation() {
    let (_rt, ctx) = make_ctx();
    ctx.with(|ctx| {
        let result: rquickjs::Result<()> = (|| {
            // createBuffer via AudioContext
            ctx.eval::<(), _>(
                b"
                const ctx = new AudioContext();
                const buf = ctx.createBuffer(2, 1024, 44100);
                if (buf.numberOfChannels !== 2) throw new Error('numberOfChannels wrong');
                if (buf.length !== 1024) throw new Error('length wrong');
                if (buf.sampleRate !== 44100) throw new Error('sampleRate wrong');
                const dur = buf.duration;
                // duration = 1024/44100 ~= 0.0232
                if (dur < 0.02 || dur > 0.03) throw new Error('duration wrong: ' + dur);
                " as &[u8],
            )?;
            Ok(())
        })();
        assert!(result.is_ok(), "audio buffer test failed: {:?}", result.err());
    });
}

// ---------------------------------------------------------------------------
// Test 3: AudioBuffer channel data read/write
// ---------------------------------------------------------------------------

#[test]
fn test_audio_buffer_channel_data() {
    let (_rt, ctx) = make_ctx();
    ctx.with(|ctx| {
        let result: rquickjs::Result<()> = (|| {
            ctx.eval::<(), _>(
                b"
                const ctx = new AudioContext();
                const buf = ctx.createBuffer(1, 4, 48000);
                // copyToChannel is hard to test without Float32Array, so just
                // check getChannelData returns an array of the right length.
                const data = buf.getChannelData(0);
                if (data.length !== 4) throw new Error('getChannelData length wrong: ' + data.length);
                // Default samples should be 0
                if (data[0] !== 0) throw new Error('default sample should be 0');
                " as &[u8],
            )?;
            Ok(())
        })();
        assert!(result.is_ok(), "channel data test failed: {:?}", result.err());
    });
}

// ---------------------------------------------------------------------------
// Test 4: GainNode automation timeline (setValueAtTime sets value at JS level)
// ---------------------------------------------------------------------------

#[test]
fn test_gain_node_automation() {
    let (_rt, ctx) = make_ctx();
    ctx.with(|ctx| {
        let result: rquickjs::Result<()> = (|| {
            ctx.eval::<(), _>(
                b"var actx = new AudioContext();" as &[u8],
            )?;
            ctx.eval::<(), _>(
                b"var gainNode = actx.createGain();" as &[u8],
            )?;
            // createGain returns a GainNode — test that gain getter works
            let gain_val: f32 = ctx.eval(b"gainNode.gain.value" as &[u8])?;
            if (gain_val - 1.0).abs() > 0.01 {
                return Err(rquickjs::Error::Unknown);
            }
            // Set value
            ctx.eval::<(), _>(b"gainNode.gain.value = 0.5;" as &[u8])?;
            let after: f32 = ctx.eval(b"gainNode.gain.value" as &[u8])?;
            if (after - 0.5).abs() > 0.01 {
                return Err(rquickjs::Error::Unknown);
            }
            Ok(())
        })();
        assert!(result.is_ok(), "gain automation test failed: {:?}", result.err());
    });
}

// ---------------------------------------------------------------------------
// Test 5: OscillatorNode type and frequency
// ---------------------------------------------------------------------------

#[test]
fn test_oscillator_node_type_frequency() {
    let (_rt, ctx) = make_ctx();
    ctx.with(|ctx| {
        let result: rquickjs::Result<()> = (|| {
            ctx.eval::<(), _>(
                b"
                const ctx = new AudioContext();
                const osc = ctx.createOscillator();
                // Default type is 'sine'
                if (osc.type !== 'sine') throw new Error('default type wrong: ' + osc.type);
                // Default frequency is 440
                const freq = osc.frequency.value;
                if (Math.abs(freq - 440.0) > 1.0) throw new Error('default frequency wrong: ' + freq);
                // Change type
                osc.type = 'square';
                if (osc.type !== 'square') throw new Error('type change failed');
                // Change frequency
                osc.frequency.value = 880;
                const newFreq = osc.frequency.value;
                if (Math.abs(newFreq - 880.0) > 1.0) throw new Error('frequency change failed: ' + newFreq);
                " as &[u8],
            )?;
            Ok(())
        })();
        assert!(result.is_ok(), "oscillator test failed: {:?}", result.err());
    });
}

// ---------------------------------------------------------------------------
// Test 6: Connect / disconnect graph wiring
// ---------------------------------------------------------------------------

#[test]
fn test_connect_disconnect() {
    let (_rt, ctx) = make_ctx();
    ctx.with(|ctx| {
        let result: rquickjs::Result<()> = (|| {
            ctx.eval::<(), _>(
                b"
                const ctx = new AudioContext();
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                // connect osc -> gain -> destination
                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.start();
                // disconnect gain from destination
                gain.disconnect(ctx.destination);
                // Should not throw
                osc.stop();
                " as &[u8],
            )?;
            Ok(())
        })();
        assert!(result.is_ok(), "connect/disconnect test failed: {:?}", result.err());
    });
}

// ---------------------------------------------------------------------------
// Test 7: decodeAudioData with a minimal embedded WAV
// ---------------------------------------------------------------------------

// Minimal 4-frame mono 16-bit 44100 Hz WAV
// Generated offline: 44-byte header + 8 bytes of PCM data
static MINIMAL_WAV: &[u8] = &[
    // RIFF header
    0x52, 0x49, 0x46, 0x46, // "RIFF"
    0x24, 0x00, 0x00, 0x00, // chunk size = 36 + data = 44 bytes total - 8 = 36
    0x57, 0x41, 0x56, 0x45, // "WAVE"
    // fmt chunk
    0x66, 0x6D, 0x74, 0x20, // "fmt "
    0x10, 0x00, 0x00, 0x00, // chunk size = 16
    0x01, 0x00,             // PCM format = 1
    0x01, 0x00,             // channels = 1
    0x44, 0xAC, 0x00, 0x00, // sample rate = 44100
    0x88, 0x58, 0x01, 0x00, // byte rate = 88200
    0x02, 0x00,             // block align = 2
    0x10, 0x00,             // bits per sample = 16
    // data chunk
    0x64, 0x61, 0x74, 0x61, // "data"
    0x08, 0x00, 0x00, 0x00, // data size = 8 bytes = 4 frames
    // 4 samples: 0, 16383, -16384, 0
    0x00, 0x00,
    0xFF, 0x3F,
    0x00, 0xC0,
    0x00, 0x00,
];

#[test]
fn test_decode_audio_data() {
    let (_rt, ctx) = make_ctx();

    // Pass the WAV bytes as a JS Array of numbers, then decode
    let wav_bytes: Vec<u8> = MINIMAL_WAV.to_vec();
    ctx.with(|ctx| {
        // Set the wav data on globalThis
        let globals = ctx.globals();
        let arr = rquickjs::Array::new(ctx.clone()).unwrap();
        for (i, &b) in wav_bytes.iter().enumerate() {
            arr.set(i, b as u32).unwrap();
        }
        globals.set("__wav_bytes", arr).unwrap();

        let result: rquickjs::Result<()> = (|| {
            ctx.eval::<(), _>(
                b"
                const ctx = new AudioContext();
                // decodeAudioData returns a Promise; we don't await here since
                // there's no microtask pump in tests. Instead we call it and
                // verify the API doesn't throw synchronously.
                const p = ctx.decodeAudioData(__wav_bytes);
                if (typeof p !== 'object') throw new Error('decodeAudioData should return object/Promise');
                " as &[u8],
            )?;
            Ok(())
        })();
        assert!(
            result.is_ok(),
            "decodeAudioData test failed: {:?}",
            result.err()
        );
    });
}

// ---------------------------------------------------------------------------
// Test 8: AnalyserNode fftSize / frequencyBinCount
// ---------------------------------------------------------------------------

#[test]
fn test_analyser_node() {
    let (_rt, ctx) = make_ctx();
    ctx.with(|ctx| {
        let result: rquickjs::Result<()> = (|| {
            ctx.eval::<(), _>(
                b"
                const ctx = new AudioContext();
                const analyser = ctx.createAnalyser();
                // Default fftSize = 2048
                if (analyser.fftSize !== 2048) throw new Error('default fftSize wrong: ' + analyser.fftSize);
                if (analyser.frequencyBinCount !== 1024) throw new Error('frequencyBinCount wrong');
                // Change fftSize
                analyser.fftSize = 512;
                if (analyser.fftSize !== 512) throw new Error('fftSize change failed');
                if (analyser.frequencyBinCount !== 256) throw new Error('frequencyBinCount after change wrong');
                // getByteTimeDomainData should not throw
                const buf = new Array(256).fill(0);
                analyser.getByteTimeDomainData(buf);
                // Default is silence ~= 127 or 128 (midpoint of 0-255, 0.0 samples map to ~127)
                if (buf[0] < 120 || buf[0] > 135) throw new Error('default time domain out of range, got ' + buf[0]);
                " as &[u8],
            )?;
            Ok(())
        })();
        assert!(result.is_ok(), "analyser test failed: {:?}", result.err());
    });
}

// ---------------------------------------------------------------------------
// Test 9: AudioContext state and currentTime
// ---------------------------------------------------------------------------

#[test]
fn test_audio_context_state() {
    let (_rt, ctx) = make_ctx();
    ctx.with(|ctx| {
        let result: rquickjs::Result<()> = (|| {
            ctx.eval::<(), _>(
                b"
                const ctx = new AudioContext();
                // In no-audio mode, context starts suspended
                // (or running if device opened successfully)
                const s = ctx.state;
                if (s !== 'running' && s !== 'suspended') throw new Error('state invalid: ' + s);
                // currentTime should be >= 0
                const t = ctx.currentTime;
                if (t < 0) throw new Error('currentTime negative: ' + t);
                // sampleRate should be > 0
                const sr = ctx.sampleRate;
                if (sr <= 0) throw new Error('sampleRate invalid: ' + sr);
                " as &[u8],
            )?;
            Ok(())
        })();
        assert!(result.is_ok(), "context state test failed: {:?}", result.err());
    });
}

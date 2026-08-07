/**
 * carbon-audio — Web Audio API bindings for the carbon runtime.
 *
 * These types mirror the W3C Web Audio API specification
 * (https://webaudio.github.io/web-audio-api/) as implemented by Rust/cpal
 * on the mini/term backends. When running on the webview2 backend the host
 * browser's native Web Audio API is used instead and these types are not
 * loaded.
 *
 * Usage (in an audio-enabled carbon app):
 *   const ctx = new AudioContext();
 *   const osc = ctx.createOscillator();
 *   osc.connect(ctx.destination);
 *   osc.start();
 */

// ---------------------------------------------------------------------------
// AudioParam
// ---------------------------------------------------------------------------

/**
 * Represents an automatable audio parameter (gain value, frequency, detune,
 * playback rate). Automation events are scheduled via the timeline methods.
 */
export interface AudioParam {
    /** Current instantaneous value. Setting this cancels any pending automation. */
    value: number;
    /** Default value. Read-only. */
    readonly defaultValue: number;
    /** Minimum value. Read-only. */
    readonly minValue: number;
    /** Maximum value. Read-only. */
    readonly maxValue: number;

    /**
     * Sets the value to `value` at the given `startTime` (in seconds from
     * AudioContext.currentTime). Also updates `value` immediately.
     */
    setValueAtTime(value: number, startTime: number): AudioParam;

    /**
     * Schedules a linear ramp from the current value to `value`,
     * completing at `endTime`.
     */
    linearRampToValueAtTime(value: number, endTime: number): AudioParam;

    /**
     * Schedules an exponential ramp from the current value to `value`,
     * completing at `endTime`. Both values must be positive non-zero.
     */
    exponentialRampToValueAtTime(value: number, endTime: number): AudioParam;

    /**
     * Starts an exponential approach to `target` beginning at `startTime`
     * with the given `timeConstant` (seconds).
     */
    setTargetAtTime(target: number, startTime: number, timeConstant: number): AudioParam;

    /**
     * Cancels all scheduled parameter changes with a `startTime` greater
     * than or equal to `cancelTime`.
     */
    cancelScheduledValues(cancelTime: number): AudioParam;
}

// ---------------------------------------------------------------------------
// AudioDestinationNode
// ---------------------------------------------------------------------------

/** The final output node. Every AudioContext has exactly one. */
export interface AudioDestinationNode {
    /** Number of output channels (always 2 — stereo). Read-only. */
    readonly channelCount: number;
    connect(destination: AudioNode): AudioNode;
    disconnect(destination?: AudioNode): void;
}

// ---------------------------------------------------------------------------
// Generic AudioNode (union of all connectable types)
// ---------------------------------------------------------------------------

export type AudioNode =
    | AudioBufferSourceNode
    | GainNode
    | OscillatorNode
    | AnalyserNode
    | AudioDestinationNode;

// ---------------------------------------------------------------------------
// AudioBuffer
// ---------------------------------------------------------------------------

/**
 * Holds decoded PCM audio data. Created via `AudioContext.createBuffer` or
 * returned from `AudioContext.decodeAudioData`. Immutable after creation.
 */
export interface AudioBuffer {
    /** Number of discrete audio channels. Read-only. */
    readonly numberOfChannels: number;
    /** Length of the buffer in sample frames. Read-only. */
    readonly length: number;
    /** Sample rate in Hz. Read-only. */
    readonly sampleRate: number;
    /** Duration in seconds (length / sampleRate). Read-only. */
    readonly duration: number;

    /**
     * Returns the PCM samples for the given channel as an Array of floats
     * in the range [-1, 1].
     */
    getChannelData(channel: number): number[];

    /**
     * Copies samples from `source` into the buffer at `channel` starting
     * at frame `bufferOffset`.
     */
    copyToChannel(source: number[], channelNumber: number, bufferOffset?: number): void;

    /**
     * Copies samples from the buffer's `channel` into `destination`
     * starting at frame `bufferOffset`.
     */
    copyFromChannel(
        destination: number[],
        channelNumber: number,
        bufferOffset?: number,
    ): void;
}

// ---------------------------------------------------------------------------
// AudioBufferSourceNode
// ---------------------------------------------------------------------------

/** Plays back an AudioBuffer once or in a loop. */
export interface AudioBufferSourceNode {
    /** The decoded audio buffer to play. Setting this after start() is a no-op. */
    buffer: AudioBuffer | null;
    /** Whether to loop the buffer. */
    loop: boolean;
    /** Loop start point in seconds (default: 0). */
    loopStart: number;
    /** Loop end point in seconds (default: buffer length). 0 means buffer end. */
    loopEnd: number;
    /** Playback rate AudioParam (default: 1.0). */
    readonly playbackRate: AudioParam;
    /** Called when playback ends naturally or via stop(). */
    onended: (() => void) | null;

    /**
     * Schedules playback to begin at `when` seconds (default: 0 = now),
     * from `offset` seconds into the buffer, for at most `duration` seconds.
     */
    start(when?: number, offset?: number, duration?: number): void;

    /** Schedules playback to stop at `when` seconds (default: 0 = now). */
    stop(when?: number): void;

    connect(destination: AudioNode | AudioDestinationNode): AudioNode;
    disconnect(destination?: AudioNode | AudioDestinationNode): void;
}

// ---------------------------------------------------------------------------
// GainNode
// ---------------------------------------------------------------------------

/**
 * Applies a volume gain to its inputs. Supports automation via the `gain`
 * AudioParam.
 */
export interface GainNode {
    /** Gain level. Default: 1.0. Can be negative to invert phase. */
    readonly gain: AudioParam;

    connect(destination: AudioNode | AudioDestinationNode): AudioNode;
    disconnect(destination?: AudioNode | AudioDestinationNode): void;
}

// ---------------------------------------------------------------------------
// OscillatorNode
// ---------------------------------------------------------------------------

export type OscillatorType = "sine" | "square" | "sawtooth" | "triangle";

/**
 * Generates a periodic waveform (tone). Must be started before it produces
 * any output. Unlike AudioBufferSourceNode, it can be stopped and the sound
 * ceases immediately.
 */
export interface OscillatorNode {
    /** Waveform type. Default: "sine". */
    type: OscillatorType;
    /** Frequency in Hz. AudioParam, default: 440. */
    readonly frequency: AudioParam;
    /** Detune in cents. AudioParam, default: 0. */
    readonly detune: AudioParam;

    /** Schedules the oscillator to start at `when` seconds (default: now). */
    start(when?: number): void;
    /** Schedules the oscillator to stop at `when` seconds (default: now). */
    stop(when?: number): void;

    connect(destination: AudioNode | AudioDestinationNode): AudioNode;
    disconnect(destination?: AudioNode | AudioDestinationNode): void;
}

// ---------------------------------------------------------------------------
// AnalyserNode
// ---------------------------------------------------------------------------

/**
 * Provides real-time frequency and time-domain analysis of the audio signal.
 * Acts as a transparent pass-through (does not modify the signal).
 */
export interface AnalyserNode {
    /**
     * FFT size. Must be a power of 2 between 32 and 32768. Default: 2048.
     * Setting this resets the time-domain ring buffer.
     */
    fftSize: number;
    /**
     * Half of fftSize. Read-only. This is the number of frequency bins
     * returned by the frequency-data methods.
     */
    readonly frequencyBinCount: number;
    /**
     * Smoothing factor for frequency magnitude (0–1). Default: 0.8.
     * Higher values smooth more across frames.
     */
    smoothingTimeConstant: number;
    /** Minimum dB value for byte frequency scaling. Default: -100. */
    minDecibels: number;
    /** Maximum dB value for byte frequency scaling. Default: -30. */
    maxDecibels: number;

    /**
     * Fills `array` with waveform data (0–255, where 128 = silence).
     * Array length determines how many samples are read (up to fftSize).
     */
    getByteTimeDomainData(array: number[]): void;

    /**
     * Fills `array` with waveform data as floats in [-1, 1].
     */
    getFloatTimeDomainData(array: number[]): void;

    /**
     * Fills `array` with frequency magnitude data (0–255), scaled
     * between minDecibels and maxDecibels.
     */
    getByteFrequencyData(array: number[]): void;

    /**
     * Fills `array` with frequency magnitude data in dB.
     */
    getFloatFrequencyData(array: number[]): void;

    connect(destination: AudioNode | AudioDestinationNode): AudioNode;
    disconnect(destination?: AudioNode | AudioDestinationNode): void;
}

// ---------------------------------------------------------------------------
// AudioContext
// ---------------------------------------------------------------------------

/**
 * The root object for the Web Audio API. Each carbon app should create
 * exactly one AudioContext.
 *
 * Requires `[runtime] audio = true` in carbon.toml.
 */
export interface AudioContext {
    /** Device sample rate in Hz. Read-only. */
    readonly sampleRate: number;
    /** Current playback position in seconds. Read-only. Advances as samples play. */
    readonly currentTime: number;
    /** Context state: "running" | "suspended" | "closed". Read-only. */
    readonly state: "running" | "suspended" | "closed";
    /** The audio graph output destination node. Read-only. */
    readonly destination: AudioDestinationNode;

    /**
     * Creates a new AudioBufferSourceNode.
     * You must set `.buffer` before calling `.start()`.
     */
    createBufferSource(): AudioBufferSourceNode;

    /** Creates a new GainNode (volume control). */
    createGain(): GainNode;

    /** Creates a new OscillatorNode (tone generator). */
    createOscillator(): OscillatorNode;

    /** Creates a new AnalyserNode (FFT visualizer). */
    createAnalyser(): AnalyserNode;

    /**
     * Allocates an empty AudioBuffer.
     * @param numberOfChannels Number of audio channels (1 = mono, 2 = stereo).
     * @param length Number of sample frames.
     * @param sampleRate Sample rate in Hz.
     */
    createBuffer(
        numberOfChannels: number,
        length: number,
        sampleRate: number,
    ): AudioBuffer;

    /**
     * Decodes an audio file from raw bytes into an AudioBuffer.
     * Supported formats: WAV/PCM, MP3, OGG/Vorbis, FLAC.
     *
     * Pass `Array.from(new Uint8Array(arrayBuffer))` as the argument.
     *
     * @param data Array of byte values (0–255).
     * @returns Promise that resolves to a decoded AudioBuffer.
     */
    decodeAudioData(data: number[]): Promise<AudioBuffer>;

    /** Resumes a suspended context. */
    resume(): Promise<void>;

    /** Suspends audio output without closing the context. */
    suspend(): Promise<void>;

    /** Closes the context and releases all resources. */
    close(): Promise<void>;
}

export interface AudioContextConstructor {
    new (): AudioContext;
}

// ---------------------------------------------------------------------------
// Global declarations (injected by register_audio)
// ---------------------------------------------------------------------------

declare global {
    /** The main entry point for the Web Audio API. */
    const AudioContext: AudioContextConstructor;

    interface AudioBuffer {}
    interface AudioBufferSourceNode {}
    interface GainNode {}
    interface OscillatorNode {}
    interface AnalyserNode {}
    interface AudioParam {}
    interface AudioDestinationNode {}
}

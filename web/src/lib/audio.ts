/**
 * Listening to a shot.
 *
 * The captures are 262 144 Hz, which Web Audio only promises to play back
 * between 8 and 96 kHz, so each one is low-passed and kept one sample in five
 * (52 428.8 Hz, still well past hearing). A real shot is ~140 dB, which no
 * speaker should attempt, so levels are scaled: a lone shot to a fixed peak, a
 * set of shots by one shared factor so the quieter can still sounds quieter.
 */

export const DECIMATE = 5;
const TAPS = 63;
const HEADROOM = 0.5; // peak amplitude the loudest shot is scaled to
const FADE_S = 0.004;

/** Windowed-sinc low-pass at `cutoff` cycles per sample. */
export function lowpass(cutoff: number, taps = TAPS): Float64Array {
  const h = new Float64Array(taps);
  const mid = (taps - 1) / 2;
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const x = i - mid;
    const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
    const blackman = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (taps - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (taps - 1));
    h[i] = sinc * blackman;
    sum += h[i];
  }
  for (let i = 0; i < taps; i++) h[i] /= sum;
  return h;
}

/** Filter and keep every `factor`th sample. */
export function downsample(samples: ArrayLike<number>, factor = DECIMATE): Float32Array {
  // Cut at 80% of the new Nyquist so nothing folds back into the audible band.
  const h = lowpass((0.5 / factor) * 0.8);
  const mid = (h.length - 1) / 2;
  const out = new Float32Array(Math.floor(samples.length / factor));
  for (let o = 0; o < out.length; o++) {
    const centre = o * factor;
    let acc = 0;
    for (let k = 0; k < h.length; k++) {
      const i = centre + k - mid;
      if (i >= 0 && i < samples.length) acc += h[k] * samples[i];
    }
    out[o] = acc;
  }
  return out;
}

export const peakOf = (values: ArrayLike<number>) => {
  let peak = 0;
  for (let i = 0; i < values.length; i++) peak = Math.max(peak, Math.abs(values[i]));
  return peak;
};

export interface Clip {
  /** Downsampled pressure, Pa. */
  values: Float32Array;
  rate: number;
  /** Anything to tag the clip with; handed back while it plays. */
  id: number;
}

export function clipOf(samples: ArrayLike<number>, dt: number, id: number): Clip {
  return { values: downsample(samples), rate: 1 / dt / DECIMATE, id };
}

let context: AudioContext | null = null;
let current: { stop(): void } | null = null;

export interface Playing {
  id: number;
  /** AudioContext time the clip started, and how long it lasts, in seconds. */
  start: number;
  duration: number;
}

/**
 * Play clips one after another, scaled by one shared factor.
 *
 * `onClip` is called as each clip starts and with null at the end, so a plot
 * can draw a playhead. Starting new playback stops the old.
 */
export function play(clips: Clip[], onClip: (playing: Playing | null) => void, gap = 0.6): { stop(): void } {
  current?.stop();
  context ??= new AudioContext();
  const ctx = context;
  void ctx.resume();

  const loudest = Math.max(...clips.map((c) => peakOf(c.values))) || 1;
  const gain = HEADROOM / loudest;
  const sources: AudioBufferSourceNode[] = [];
  const timers: ReturnType<typeof setTimeout>[] = [];
  let when = ctx.currentTime + 0.05;

  clips.forEach((clip, n) => {
    const buffer = ctx.createBuffer(1, clip.values.length, clip.rate);
    const channel = buffer.getChannelData(0);
    const fade = Math.round(FADE_S * clip.rate);
    for (let i = 0; i < clip.values.length; i++) {
      const edge = Math.min(1, i / fade, (clip.values.length - 1 - i) / fade);
      channel[i] = clip.values[i] * gain * edge;
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.start(when);
    sources.push(source);
    const start = when;
    timers.push(setTimeout(() => onClip({ id: clip.id, start, duration: buffer.duration }), (start - ctx.currentTime) * 1000));
    when += buffer.duration + (n < clips.length - 1 ? gap : 0);
  });
  const end = setTimeout(() => finish(), (when - ctx.currentTime) * 1000 + 30);

  const finish = () => {
    timers.forEach(clearTimeout);
    clearTimeout(end);
    if (current === handle) current = null;
    onClip(null);
  };
  const handle = {
    stop() {
      for (const source of sources) {
        try {
          source.stop();
        } catch {
          // already finished
        }
      }
      finish();
    },
  };
  current = handle;
  return handle;
}

/** Seconds into the current clip, for a playhead. */
export const elapsed = (playing: Playing) => (context ? context.currentTime - playing.start : 0);

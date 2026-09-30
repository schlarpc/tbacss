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
  /** Where the clip starts on the record's own time axis, ms. */
  offsetMs: number;
}

/**
 * A clip of `samples` from index `start`, placed at `t0Ms` + start on the
 * record's time axis so a plot can follow it.
 */
export function clipOf(samples: Float32Array, dt: number, id: number, start = 0, t0Ms = 0): Clip {
  const from = Math.max(0, Math.min(start, samples.length - 1));
  return { values: downsample(samples.subarray(from)), rate: 1 / dt / DECIMATE, id, offsetMs: t0Ms + from * dt * 1000 };
}

let context: AudioContext | null = null;
let current: { stop(): void } | null = null;

export interface Playing {
  id: number;
  /** AudioContext time the clip started, and how long it lasts, in seconds. */
  start: number;
  duration: number;
  /** Playback speed, and where the clip sits on the record's time axis. */
  rate: number;
  offsetMs: number;
  /** Which clip of how many: "shot 2 of 5". */
  index: number;
  count: number;
}

/**
 * Play clips one after another, scaled by one shared factor, at `rate` of
 * real time.
 *
 * Two ways to slow down. Played slower, a buffer's pitch drops with it -- at
 * a quarter speed a crack becomes a thud two octaves down -- but every feature
 * of the waveform survives one-to-one, like tape. Or `prepare` stretches each
 * clip first at its original pitch (see stretch.ts) and it plays at normal
 * speed. Clips are prepared one ahead of playback, so a string starts as soon
 * as its first shot is ready.
 *
 * The shared gain comes from the clips as recorded, so relative levels match
 * in both modes. `onClip` is called as each clip starts and with null at the
 * end, so a plot can draw a playhead. Starting new playback stops the old.
 */
export function play(
  clips: Clip[],
  onClip: (playing: Playing | null) => void,
  { gap = 0.8, rate = 1, prepare }: { gap?: number; rate?: number; prepare?: (clip: Clip) => Promise<Float32Array> } = {},
): { stop(): void } {
  current?.stop();
  context ??= new AudioContext();
  const ctx = context;
  void ctx.resume();

  const loudest = Math.max(...clips.map((c) => peakOf(c.values))) || 1;
  const sources: AudioBufferSourceNode[] = [];
  const timers: ReturnType<typeof setTimeout>[] = [];
  let stopped = false;
  let end: ReturnType<typeof setTimeout> | undefined;

  const finish = () => {
    stopped = true;
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
      if (!stopped) finish();
    },
  };
  current = handle;

  void (async () => {
    // A stretched clip can peak a little above its original, where coherent
    // frames overlap on an attack; keep the shared gain clear of clipping.
    const prepared = clips.map((clip) => (prepare ? prepare(clip) : Promise.resolve(clip.values)));
    let when = 0;
    for (const [n, clip] of clips.entries()) {
      const values = await prepared[n];
      if (stopped) return;
      const gain = Math.min(HEADROOM / loudest, 0.95 / (peakOf(values) || 1));
      const buffer = ctx.createBuffer(1, values.length, clip.rate);
      const channel = buffer.getChannelData(0);
      const fade = Math.round(FADE_S * clip.rate);
      for (let i = 0; i < values.length; i++) {
        const edge = Math.min(1, i / fade, (values.length - 1 - i) / fade);
        channel[i] = values[i] * gain * edge;
      }
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.playbackRate.value = prepare ? 1 : rate;
      source.connect(ctx.destination);
      when = Math.max(when, ctx.currentTime + 0.05);
      source.start(when);
      sources.push(source);
      const start = when;
      const duration = buffer.duration / source.playbackRate.value;
      const playing = { id: clip.id, start, duration, rate, offsetMs: clip.offsetMs, index: n, count: clips.length };
      timers.push(setTimeout(() => onClip(playing), (start - ctx.currentTime) * 1000));
      when += duration + gap;
    }
    end = setTimeout(() => {
      if (!stopped) finish();
    }, (when - gap - ctx.currentTime) * 1000 + 30);
  })();
  return handle;
}

/** Seconds into the current clip, for a playhead. */
export const elapsed = (playing: Playing) => (context ? context.currentTime - playing.start : 0);

/** Where the playhead is on the record's own time axis, ms. */
export const position = (playing: Playing) =>
  playing.offsetMs + Math.max(0, Math.min(elapsed(playing), playing.duration)) * playing.rate * 1000;

/**
 * The blast itself is ~20 ms, so it takes a steep slowdown to watch a
 * playhead cross it: at 64× it is about a second and a half, and six octaves
 * down.
 */
export const SPEEDS = [
  { rate: 1, label: 'Real time' },
  { rate: 1 / 4, label: '4× slower' },
  { rate: 1 / 16, label: '16× slower' },
  { rate: 1 / 64, label: '64× slower' },
];

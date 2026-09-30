/**
 * Slowing a shot down without lowering its pitch.
 *
 * Pitch-preserving time-scale modification (TSM) of a gunshot at 4-64x is the
 * hard case for every standard method. The classical phase vocoder smears the
 * crack into a swoosh ("phasiness"); overlap-add methods repeat it as a
 * stutter. This combines four published ideas, the first three as published
 * and the fourth our own adaptation for extreme factors:
 *
 * 1. Phase gradient heap integration -- Průša & Holighaus, "Phase Vocoder Done
 *    Right", EUSIPCO 2017 (arXiv:2202.07382), Algorithm 1. Synthesis phase is
 *    integrated along time *and* frequency, largest coefficient first, so
 *    partials keep their relative phase (vertical coherence) without peak
 *    picking. Following their eq. (6), the frequency-direction step uses the
 *    synthesis frequency step, i.e. the group delay scaled by the stretch.
 *
 * 2. Phase derivatives by reassignment -- Auger & Flandrin, "Improving the
 *    readability of time-frequency and time-scale representations by the
 *    reassignment method", IEEE TSP 1995. Instantaneous frequency and group
 *    delay come from STFTs with the derivative and time-weighted windows,
 *    exact per frame for a pure tone and an impulse, instead of PVDR's finite
 *    differences across frames and bins. Röbel uses the same group delay to
 *    locate transients (DAFx-03, eqs. 3-4 and 9).
 *
 * 3. Harmonic-percussive separation -- Fitzgerald, "Harmonic/percussive
 *    separation using median filtering", DAFx-10; used for TSM by Driedger,
 *    Müller & Ewert, IEEE SPL 21(1), 2014. A median along time gives the part
 *    of each bin that persists (ringing, decay, noise); a median along
 *    frequency gives the broadband part (the crack). Soft Wiener masks split
 *    the magnitude between them.
 *
 * 4. Transient gating (our adaptation). PVDR places a coefficient's energy at
 *    alpha times its group delay from the synthesis frame centre. Near a
 *    transient that is exactly right -- neighbouring frames add up coherently
 *    at the stretched position -- but at alpha = 64 a frame whose transient
 *    sits even N/128 samples off-centre would place it outside the frame, and
 *    the FFT wraps it back in as a spurious click. So the percussive part of
 *    a coefficient is kept only while alpha * group delay stays inside the
 *    synthesis window, tapered towards the edge. That leaves about four
 *    frames at any stretch: the crack is synthesised once, sharp, at alpha
 *    times its original time, with no pre-echo. It is the goal of Röbel's
 *    transient processing (DAFx-03) reached without his phase reset, which
 *    would break the coherence the heap integration builds.
 *
 * The persistent part is stretched as a normal PVDR would, so the ringing and
 * the decay last alpha times longer at their original pitch.
 */

/* ------------------------------------------------------------------ FFT */

/** In-place iterative radix-2 complex FFT. `sign` -1 forward, +1 inverse (unscaled). */
export function fft(re: Float64Array, im: Float64Array, sign: -1 | 1): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = (sign * 2 * Math.PI) / size;
    const wr = Math.cos(step);
    const wi = Math.sin(step);
    for (let start = 0; start < n; start += size) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < half; k++) {
        const a = start + k;
        const b = a + half;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

/* ---------------------------------------------------------------- heap */

/** Max-heap of (magnitude, key) pairs, for the heap integration. */
class MaxHeap {
  private keys: Int32Array;
  private vals: Float64Array;
  size = 0;
  constructor(capacity: number) {
    this.keys = new Int32Array(capacity);
    this.vals = new Float64Array(capacity);
  }
  clear() {
    this.size = 0;
  }
  push(key: number, value: number) {
    let i = this.size++;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.vals[parent] >= value) break;
      this.keys[i] = this.keys[parent];
      this.vals[i] = this.vals[parent];
      i = parent;
    }
    this.keys[i] = key;
    this.vals[i] = value;
  }
  pop(): number {
    const top = this.keys[0];
    const lastKey = this.keys[--this.size];
    const lastVal = this.vals[this.size];
    let i = 0;
    for (;;) {
      let child = 2 * i + 1;
      if (child >= this.size) break;
      if (child + 1 < this.size && this.vals[child + 1] > this.vals[child]) child++;
      if (this.vals[child] <= lastVal) break;
      this.keys[i] = this.keys[child];
      this.vals[i] = this.vals[child];
      i = child;
    }
    this.keys[i] = lastKey;
    this.vals[i] = lastVal;
    return top;
  }
}

/* -------------------------------------------------------------- medians */

function median(values: Float64Array, count: number): number {
  // Insertion sort: the windows here are a dozen or so values.
  for (let i = 1; i < count; i++) {
    const v = values[i];
    let j = i - 1;
    while (j >= 0 && values[j] > v) {
      values[j + 1] = values[j];
      j--;
    }
    values[j + 1] = v;
  }
  return values[count >> 1];
}

/* -------------------------------------------------------------- stretch */

export interface StretchOptions {
  /** Window length and FFT size, samples; a power of two. */
  window?: number;
  /** Synthesis hop as a fraction of the window (redundancy 1/hop). */
  hop?: number;
  /**
   * Harmonic median length along time, seconds of input. It has to span
   * several windows: an impulse shows in every frame for a window's length,
   * and a shorter median would call it persistent. Default 2.5 windows.
   */
  harmonicSeconds?: number;
  /** Percussive median length along frequency, Hz. */
  percussiveHz?: number;
  /** Relative magnitude below which a coefficient gets a random phase (PVDR: 1e-6). */
  tolerance?: number;
  /** For tests: skip the percussive gating, i.e. plain PVDR with reassignment. */
  plain?: boolean;
  /** For tests: seeded phase noise. */
  random?: () => number;
  /** For tests: the transient events found, in input samples. */
  inspect?: (info: { events: number[] }) => void;
}

/**
 * Stretch `input` (sampled at `rate` Hz) by `alpha` >= 1, keeping its pitch.
 * `alpha` times the analysis hop must come out whole: the synthesis hop is
 * fixed and the analysis hop is it divided by alpha.
 */
export function stretch(input: ArrayLike<number>, rate: number, alpha: number, options: StretchOptions = {}): Float32Array {
  const N = options.window ?? 256;
  const Hs = Math.round(N * (options.hop ?? 1 / 8));
  const Ha = Hs / alpha;
  const tol = options.tolerance ?? 1e-6;
  const random = options.random ?? Math.random;
  const half = N / 2;
  const bins = half + 1;

  // Frames every Ha input samples. Ha may be fractional (alpha does not divide
  // Hs); analysis then reads at a fractional offset by linear interpolation,
  // which only happens for the odd factor -- the page uses 4, 16 and 64.
  const L = input.length;
  const frames = Math.max(1, Math.ceil((L + N) / Ha));
  const x = (t: number) => {
    const i = Math.floor(t);
    const f = t - i;
    const a = i >= 0 && i < L ? input[i] : 0;
    const b = i + 1 >= 0 && i + 1 < L ? input[i + 1] : 0;
    return a + (b - a) * f;
  };

  // Hann window centred on 0, its time-weighted and derivative companions.
  const h = new Float64Array(N);
  const hT = new Float64Array(N);
  const hD = new Float64Array(N);
  for (let k = 0; k < N; k++) {
    const l = k - half; // centred sample offset
    h[k] = 0.5 + 0.5 * Math.cos((2 * Math.PI * l) / N);
    hT[k] = l * h[k];
    hD[k] = -(Math.PI / N) * Math.sin((2 * Math.PI * l) / N);
  }

  /* -- analysis: magnitude, instantaneous frequency, group delay ---------- */
  const mag = new Float64Array(frames * bins);
  const inst = new Float64Array(frames * bins); // rad/sample
  const delay = new Float64Array(frames * bins); // samples from frame centre
  const re = new Float64Array(N), im = new Float64Array(N);
  const reT = new Float64Array(N), imT = new Float64Array(N);
  const reD = new Float64Array(N), imD = new Float64Array(N);
  // Frame n is centred at input time n * Ha - pad and output time
  // n * Hs - alpha * pad, so input sample t lands at output alpha * t.
  const pad = half;
  for (let n = 0; n < frames; n++) {
    const centre = n * Ha - pad;
    for (let k = 0; k < N; k++) {
      const s = x(centre + (k - half));
      // Circular shift so the frame centre is index 0: the phase is then
      // relative to the frame centre (frequency-invariant), as PVDR assumes.
      const idx = (k - half + N) % N;
      re[idx] = s * h[k];
      reT[idx] = s * hT[k];
      reD[idx] = s * hD[k];
    }
    im.fill(0);
    imT.fill(0);
    imD.fill(0);
    fft(re, im, -1);
    fft(reT, imT, -1);
    fft(reD, imD, -1);
    for (let m = 0; m < bins; m++) {
      const p = re[m] * re[m] + im[m] * im[m];
      const o = n * bins + m;
      mag[o] = Math.sqrt(p);
      if (p > 1e-30) {
        // Auger & Flandrin: t = Re(X_T X*)/|X|^2, w = w_m - Im(X_D X*)/|X|^2.
        delay[o] = (reT[m] * re[m] + imT[m] * im[m]) / p;
        inst[o] = (2 * Math.PI * m) / N - (imD[m] * re[m] - reD[m] * im[m]) / p;
      } else {
        inst[o] = (2 * Math.PI * m) / N;
      }
    }
  }

  /* -- harmonic / percussive split (Fitzgerald) ------------------------- */
  // keep = what is synthesised; kept = its stretched (persistent) share,
  // tracked separately so its energy can be corrected at the end.
  let keep = mag;
  let kept = mag;
  if (!options.plain && alpha > 1) {
    const harmonic = new Float64Array(frames * bins);
    const percussive = new Float64Array(frames * bins);
    // Time median over `harmonicSeconds` of input, sampled at 15 points so
    // the cost does not grow with alpha; evaluated on a coarse frame grid and
    // interpolated between.
    const seconds = options.harmonicSeconds ?? (2.5 * N) / rate;
    const span = Math.max(3, Math.round((seconds * rate) / Ha));
    const taps = Math.min(15, span) | 1;
    const stride = Math.max(1, Math.floor(span / 8));
    const buf = new Float64Array(Math.max(taps, 64));
    for (let m = 0; m < bins; m++) {
      let prev = -1;
      let prevVal = 0;
      for (let n = 0; ; n = Math.min(n + stride, frames - 1)) {
        for (let t = 0; t < taps; t++) {
          const f = Math.round(n - span / 2 + (t * span) / (taps - 1));
          buf[t] = f >= 0 && f < frames ? mag[f * bins + m] : 0;
        }
        const value = median(buf, taps);
        if (prev >= 0) {
          for (let f = prev + 1; f <= n; f++) {
            harmonic[f * bins + m] = prevVal + ((value - prevVal) * (f - prev)) / (n - prev);
          }
        } else harmonic[n * bins + m] = value;
        prev = n;
        prevVal = value;
        if (n === frames - 1) break;
      }
    }
    // Frequency median across `percussiveHz`.
    const width = Math.max(9, Math.round(((options.percussiveHz ?? 2000) * N) / rate)) | 1;
    for (let n = 0; n < frames; n++) {
      for (let m = 0; m < bins; m++) {
        let count = 0;
        for (let d = -(width >> 1); d <= width >> 1; d++) {
          const b = m + d;
          buf[count++] = b >= 0 && b < bins ? mag[n * bins + b] : 0;
        }
        percussive[n * bins + m] = median(buf, count);
      }
    }
    // Harmonic-percussive-residual split (Driedger, Müller & Disch, "Extending
    // harmonic-percussive separation of audio signals", ISMIR 2014): a
    // coefficient is percussive only when its frequency median beats its time
    // median by a separation factor. With a plain Wiener split, noise -- equal
    // on both medians -- goes half percussive and half of it would be gated
    // away; here noise lands in the residual and is stretched with the
    // persistent part. The share ramps from beta_lo to beta_hi on a log scale.
    // The percussive share is then gated on where alpha times its group delay
    // lands in the synthesis frame.
    const betaLo = Math.log(1.5);
    const betaHi = Math.log(4);
    keep = new Float64Array(frames * bins);
    kept = new Float64Array(frames * bins);
    const shares = new Float64Array(frames * bins);
    for (let o = 0; o < frames * bins; o++) {
      // Floored: silent padding frames round to tiny negatives, and a NaN
      // here would poison the peak energy and silence event detection.
      const ratio = Math.log(Math.max(percussive[o], 1e-20) / Math.max(harmonic[o], 1e-20));
      shares[o] = Math.min(1, Math.max(0, (ratio - betaLo) / (betaHi - betaLo)));
    }

    // Transient events, after Röbel (DAFx-03): the centre of gravity of the
    // percussive energy, from the group delay, crosses the frame centre as the
    // analysis window slides over an attack. One event per crossing, placed
    // at that frame's centre plus its COG. A per-bin group delay is biased by
    // whatever else shares the bin -- the ring behind a crack -- by a few
    // samples, which at alpha = 64 is the whole synthesis window; one position
    // per event is not.
    const cog = new Float64Array(frames);
    const energy = new Float64Array(frames);
    for (let n = 0; n < frames; n++) {
      let e = 0;
      let c = 0;
      for (let m = 0; m < bins; m++) {
        const o = n * bins + m;
        // Energy squared as the weight: the crack outweighs the ring behind it,
        // which otherwise pulls the estimate late by several samples.
        const p = (mag[o] * shares[o]) ** 4;
        e += p;
        c += p * delay[o];
      }
      energy[n] = e;
      cog[n] = e > 0 ? c / e : 0;
    }
    let peakEnergy = 0;
    for (let n = 0; n < frames; n++) peakEnergy = Math.max(peakEnergy, energy[n]);
    // With hysteresis: an event arms only once the energy centre is well
    // ahead of the frame centre (an attack approaching) and fires on the
    // crossing. Noise whose centre wobbles around zero never arms it.
    const events: number[] = [];
    let armed = false;
    for (let n = 1; n < frames; n++) {
      const loud = energy[n] > 1e-6 * peakEnergy;
      if (loud && cog[n] > N / 8) armed = true;
      if (armed && cog[n - 1] > 0 && cog[n] <= 0 && loud) {
        const pick = Math.abs(cog[n - 1]) < Math.abs(cog[n]) ? n - 1 : n;
        // The energy centre sits a little behind the attack (the ring after
        // it counts too); the attack itself is the loudest input sample near.
        const guess = pick * Ha - pad + cog[pick];
        let at = Math.round(guess);
        for (let t = Math.max(0, Math.round(guess - N / 4)); t <= Math.min(L - 1, Math.round(guess + N / 4)); t++) {
          if (Math.abs(input[t]) > Math.abs(input[at] ?? 0)) at = t;
        }
        events.push(at);
        armed = false;
      }
    }
    options.inspect?.({ events });
    // For each frame, the offset of its nearest event from its centre.
    const offset = new Float64Array(frames).fill(Infinity);
    for (let n = 0, e = 0; n < frames && events.length; n++) {
      const centre = n * Ha - pad;
      while (e + 1 < events.length && Math.abs(events[e + 1] - centre) < Math.abs(events[e] - centre)) e++;
      offset[n] = events[e] - centre;
    }

    const inner = half / 2;
    for (let o = 0; o < frames * bins; o++) {
      const n = Math.floor(o / bins);
      // A bin whose energy points at a nearby event belongs to it, however
      // faint the event is in this frame: otherwise frames with the attack at
      // their edge stretch part of it backwards as pre-echo (Röbel's
      // pre-transient frames).
      const aim = Math.abs(delay[o] - offset[n]);
      // Broadband energy with no event within reach has nothing to be placed
      // at, so it is stretched with the rest instead of gated away.
      const near = Math.abs(offset[n]) < half;
      const share = !near ? 0 : aim < N / 8 ? Math.max(shares[o], 1 - aim / (N / 8)) : shares[o];
      const d = Math.abs(alpha * offset[n]);
      const gate = d <= inner ? 1 : d >= half ? 0 : 0.5 + 0.5 * Math.cos((Math.PI * (d - inner)) / (half - inner));
      kept[o] = mag[o] * (1 - share);
      keep[o] = kept[o] + mag[o] * share * gate;
      // The percussive share is placed by its event, not its own estimate.
      if (Number.isFinite(offset[n])) delay[o] = share * offset[n] + (1 - share) * delay[o];
    }
  }

  /* -- phase gradient heap integration (PVDR, Algorithm 1) --------------- */
  const out = new Float64Array(Math.ceil(L * alpha) + N);
  // The stretched share on its own, with the same phases, for the energy fix.
  const outH = new Float64Array(out.length);
  const hre = new Float64Array(N);
  const him = new Float64Array(N);
  const target = new Float64Array(frames);
  const phase = new Float64Array(bins);
  const prevPhase = new Float64Array(bins);
  const done = new Uint8Array(bins);
  const heap = new MaxHeap(2 * bins + 4);
  const step = (2 * Math.PI) / N;
  // Dual window for the synthesis hop (PVDR eq. 11): the analysis window
  // over the sum of its squares at that hop, so analysis x synthesis windows
  // overlap-add to one. The sum depends only on the index modulo the hop.
  const overlap = new Float64Array(Hs);
  for (let k = 0; k < N; k++) overlap[k % Hs] += h[k] * h[k];
  const sre = new Float64Array(N);
  const sim = new Float64Array(N);

  for (let n = 0; n < frames; n++) {
    const base = n * bins;
    let top = 0;
    for (let m = 0; m < bins; m++) {
      top = Math.max(top, keep[base + m]);
      if (n > 0) top = Math.max(top, keep[base - bins + m]);
    }
    const abstol = tol * top;
    let remaining = 0;
    for (let m = 0; m < bins; m++) {
      if (keep[base + m] > abstol) {
        done[m] = 0;
        remaining++;
      } else {
        done[m] = 1;
        phase[m] = random() * 2 * Math.PI;
      }
    }
    heap.clear();
    if (n > 0) for (let m = 0; m < bins; m++) if (keep[base - bins + m] > abstol) heap.push(m, keep[base - bins + m]);
    while (remaining > 0) {
      if (heap.size === 0) {
        // Nothing to propagate from: seed the largest remaining bin with its
        // analysis-consistent phase, 0 relative to the frame centre.
        let best = -1;
        for (let m = 0; m < bins; m++) if (!done[m] && (best < 0 || keep[base + m] > keep[base + best])) best = m;
        phase[best] = 0;
        done[best] = 1;
        remaining--;
        heap.push(best + bins, keep[base + best]);
        continue;
      }
      const key = heap.pop();
      if (key < bins) {
        // Popped from the previous frame: propagate along time (eq. 8).
        const m = key;
        if (!done[m]) {
          phase[m] = prevPhase[m] + (Hs / 2) * (inst[base - bins + m] + inst[base + m]);
          done[m] = 1;
          remaining--;
          heap.push(m + bins, keep[base + m]);
        }
      } else {
        // Popped from this frame: propagate along frequency, with the group
        // delay scaled by the stretch (PVDR's b_s = alpha * b_a).
        const m = key - bins;
        for (const nb of [m + 1, m - 1]) {
          if (nb < 0 || nb >= bins || done[nb]) continue;
          const dir = nb > m ? 1 : -1;
          phase[nb] = phase[m] - dir * step * alpha * 0.5 * (delay[base + m] + delay[base + nb]);
          done[nb] = 1;
          remaining--;
          heap.push(nb + bins, keep[base + nb]);
        }
      }
    }

    // Synthesis frame: Hermitian spectrum, inverse FFT, centre back to N/2.
    for (let m = 0; m < bins; m++) {
      const c = Math.cos(phase[m]);
      const sn = Math.sin(phase[m]);
      sre[m] = keep[base + m] * c;
      sim[m] = keep[base + m] * sn;
      hre[m] = kept[base + m] * c;
      him[m] = kept[base + m] * sn;
      // Parseval: the windowed input energy this frame's stretched share had.
      target[n] += ((m === 0 || m === half ? 1 : 2) * kept[base + m] * kept[base + m]) / N;
    }
    for (let m = 1; m < half; m++) {
      sre[N - m] = sre[m];
      sim[N - m] = -sim[m];
      hre[N - m] = hre[m];
      him[N - m] = -him[m];
    }
    sim[0] = 0;
    sim[half] = 0;
    him[0] = 0;
    him[half] = 0;
    fft(sre, sim, 1);
    fft(hre, him, 1);
    const at = Math.round(n * Hs - alpha * pad) - half;
    for (let k = 0; k < N; k++) {
      const t = at + k;
      if (t < 0 || t >= out.length) continue;
      const w = h[k] / overlap[k % Hs] / N;
      out[t] += sre[(k - half + N) % N] * w;
      outH[t] += hre[(k - half + N) % N] * w;
    }
    prevPhase.set(phase);
  }

  /* -- energy correction for the stretched share -------------------------
   * Stretched noise loses energy: overlapping frames whose phases no longer
   * agree add in power, not in amplitude. Tones come through whole, so rather
   * than a fixed factor, each synthesis frame's windowed output energy is
   * matched to the windowed input energy its stretched share came from, the
   * gains smoothed over a few frames. The percussive share -- the crack -- is
   * left exactly as synthesised.
   */
  if (!options.plain && alpha > 1) {
    const gains = new Float64Array(frames);
    for (let n = 0; n < frames; n++) {
      const at = Math.round(n * Hs - alpha * pad) - half;
      let measured = 0;
      for (let k = 0; k < N; k++) {
        const t = at + k;
        if (t >= 0 && t < outH.length) measured += (outH[t] * h[k]) ** 2;
      }
      gains[n] = measured > 1e-20 && target[n] > 1e-20 ? Math.min(4, Math.max(0.25, Math.sqrt(target[n] / measured))) : 1;
    }
    const smooth = new Float64Array(frames);
    for (let n = 0; n < frames; n++) {
      let sum = 0;
      let count = 0;
      for (let d = -4; d <= 4; d++) {
        if (n + d >= 0 && n + d < frames) {
          sum += gains[n + d];
          count++;
        }
      }
      smooth[n] = sum / count;
    }
    for (let t = 0; t < out.length; t++) {
      const pos = (t + alpha * pad) / Hs;
      const n0 = Math.max(0, Math.min(frames - 1, Math.floor(pos)));
      const n1 = Math.min(frames - 1, n0 + 1);
      const f = Math.min(1, Math.max(0, pos - n0));
      const g = smooth[n0] + (smooth[n1] - smooth[n0]) * f;
      out[t] += outH[t] * (g - 1);
    }
  }

  const length = Math.round(L * alpha);
  const result = new Float32Array(length);
  for (let i = 0; i < length; i++) result[i] = out[i];
  return result;
}

/**
 * Reference reader for the bundle written by `python -m tbacss publish`.
 *
 * No dependencies and no query engine. The catalog is small enough to hold
 * entirely in typed arrays, so filtering and Pareto search are plain loops
 * over Float32Array. Waveforms are pulled one at a time with HTTP Range.
 */

const MISSING = -1; // dictionary code for a null string

/* ------------------------------------------------------------------ catalog */

/**
 * Load a columnar table and convert its numeric columns to typed arrays.
 * Dictionary columns stay as Int32Array of codes plus the string table, which
 * doubles as the facet list for a filter UI.
 */
async function loadTable(url) {
  const raw = await (await fetch(url)).json();
  const columns = {};
  for (const [name, values] of Object.entries(raw.columns)) {
    columns[name] = raw.dictionaries?.[name]
      ? Int32Array.from(values)
      : Float64Array.from(values, (v) => (v === null ? NaN : v));
  }
  return {
    n: raw.n,
    ids: raw.ids ?? null,
    columns,
    dictionaries: raw.dictionaries ?? {},
    datasets: raw.datasets ?? null,
    // Host code -> {label, description}, transcribed from each year's report;
    // the codes are not explained anywhere in all.csv.
    hosts: raw.hosts ?? {},
    /** Row as a plain object, for display. */
    row(i) {
      const out = {};
      for (const [name, column] of Object.entries(this.columns)) {
        const dictionary = this.dictionaries[name];
        out[name] = dictionary
          ? column[i] === MISSING
            ? null
            : dictionary[column[i]]
          : Number.isNaN(column[i])
            ? null
            : column[i];
      }
      return out;
    },
  };
}

/**
 * Rebuild per-record entries from the columnar index.
 *
 * The published file leaves offsets out: envelopes are all `env_len` bytes so
 * theirs is `position * env_len`, and the frame offsets are the prefix sum of
 * `raw_len`. Reconstructing costs one pass and saves a few MB on the wire.
 */
function expandWaveformIndex(index) {
  const { columns, dictionaries, env_len: envLen } = index;
  const entries = new Array(index.n);
  let rawOffset = 0;
  for (let i = 0; i < index.n; i++) {
    const rawLen = columns.raw_len[i];
    entries[i] = {
      id: columns.id[i],
      run: columns.run[i],
      mic: dictionaries.mic[columns.mic[i]] ?? null,
      shot: columns.shot[i],
      excluded: Boolean(columns.excluded[i]),
      n: columns.n[i],
      dt: columns.dt[i],
      overload: columns.overload[i],
      env: [i * envLen, envLen, columns.env_scale[i]],
      raw: [rawOffset, rawLen],
    };
    rawOffset += rawLen;
  }
  return entries;
}

export async function loadBundle(baseUrl = '.') {
  const [catalog, shots, index] = await Promise.all([
    loadTable(`${baseUrl}/catalog.json`),
    loadTable(`${baseUrl}/shots.json`),
    (await fetch(`${baseUrl}/waveforms.json`)).json(),
  ]);
  const entries = expandWaveformIndex(index);
  const waveforms = { ...index, entries };

  const byId = new Map(entries.map((e) => [e.id, e]));
  const byRun = new Map();
  for (const entry of entries) {
    if (!byRun.has(entry.run)) byRun.set(entry.run, []);
    byRun.get(entry.run).push(entry);
  }
  return { baseUrl, catalog, shots, waveforms, byId, byRun };
}

/* ------------------------------------------------------------------ filters */

/**
 * Build a row mask. `spec` maps a column to either a Set of allowed strings
 * (dictionary columns) or a [min, max] range (numeric columns); either bound
 * may be null. Rows whose value is null never pass a range test.
 */
export function selection(table, spec) {
  const mask = new Uint8Array(table.n).fill(1);
  for (const [name, test] of Object.entries(spec)) {
    const column = table.columns[name];
    if (!column) throw new Error(`no column ${name}`);
    const dictionary = table.dictionaries[name];
    if (dictionary) {
      const allowed = new Set(
        [...test].map((v) => dictionary.indexOf(v)).filter((c) => c >= 0),
      );
      for (let i = 0; i < table.n; i++) {
        if (mask[i] && !allowed.has(column[i])) mask[i] = 0;
      }
    } else {
      const [lo, hi] = test;
      for (let i = 0; i < table.n; i++) {
        if (!mask[i]) continue;
        const v = column[i];
        if (Number.isNaN(v) || (lo !== null && v < lo) || (hi !== null && v > hi)) {
          mask[i] = 0;
        }
      }
    }
  }
  return mask;
}

export function rows(table, mask) {
  const out = [];
  for (let i = 0; i < table.n; i++) if (mask[i]) out.push(i);
  return out;
}

/* ------------------------------------------------------------------- pareto */

/**
 * Indices on the Pareto frontier over the given objectives.
 *
 * `objectives` is a list of `{column, direction}` where direction is 'min' or
 * 'max'. A row is on the frontier when nothing else is at least as good on
 * every objective and strictly better on one. Rows with a null in any
 * objective are excluded rather than treated as infinitely good.
 *
 * O(n^2 * k). At a few thousand rows that is well under a millisecond, which
 * is why this needs no index and no engine.
 */
export function paretoFront(table, objectives, mask = null) {
  const signs = objectives.map((o) => (o.direction === 'max' ? -1 : 1));
  const columns = objectives.map((o) => {
    const column = table.columns[o.column];
    if (!column) throw new Error(`no column ${o.column}`);
    return column;
  });

  const candidates = [];
  for (let i = 0; i < table.n; i++) {
    if (mask && !mask[i]) continue;
    if (columns.some((c) => Number.isNaN(c[i]))) continue;
    candidates.push(i);
  }

  const front = [];
  for (const i of candidates) {
    let dominated = false;
    for (const j of candidates) {
      if (i === j) continue;
      let noWorse = true;
      let better = false;
      for (let k = 0; k < columns.length; k++) {
        const a = signs[k] * columns[k][j];
        const b = signs[k] * columns[k][i];
        if (a > b) { noWorse = false; break; }
        if (a < b) better = true;
      }
      if (noWorse && better) { dominated = true; break; }
    }
    if (!dominated) front.push(i);
  }
  return front;
}

/* ---------------------------------------------------------------- waveforms */

let warnedAboutRanges = false;

/**
 * Fetch `length` bytes at `offset`.
 *
 * A server that ignores `Range` answers 200 with the *whole* file — Python's
 * stock http.server does exactly this. That would hand back hundreds of
 * megabytes and, worse, silently wrong bytes at the wrong offset, so detect it
 * and slice client-side rather than trusting the response. Use
 * `scripts/serve.py` to get real 206s.
 */
async function fetchSlice(url, offset, length) {
  const response = await fetch(url, {
    headers: { Range: `bytes=${offset}-${offset + length - 1}` },
  });
  if (!response.ok && response.status !== 206) {
    throw new Error(`range request failed: ${response.status}`);
  }
  const buffer = await response.arrayBuffer();
  if (response.status === 206) return buffer;

  if (!warnedAboutRanges) {
    warnedAboutRanges = true;
    console.warn(
      `${url} answered ${response.status} to a Range request: this server ` +
        'sends whole files. Slicing locally; use scripts/serve.py to avoid it.',
    );
  }
  return buffer.slice(offset, offset + length);
}

async function fetchRange(url, offset, length) {
  return new Int16Array(await fetchSlice(url, offset, length));
}

/**
 * Overview trace: interleaved [min, max] per bucket, in Pa.
 * Min/max decimation keeps the extremes, which is the whole point of a blast
 * trace, so this is visually lossless for any canvas narrower than `buckets`.
 */
export async function fetchEnvelope(bundle, waveformId) {
  const entry = bundle.byId.get(waveformId);
  const [offset, length, scale] = entry.env;
  const codes = await fetchRange(`${bundle.baseUrl}/envelopes.bin`, offset, length);
  const out = new Float32Array(codes.length);
  for (let i = 0; i < codes.length; i++) out[i] = codes[i] * scale;
  return { values: out, buckets: bundle.waveforms.buckets, entry };
}

/**
 * Every envelope for one run, in a single Range request.
 *
 * `publish` writes records in run order, so a run's records are contiguous in
 * the file. Opening a run therefore costs one request of roughly 120 KB
 * rather than fifteen.
 */
export async function fetchRunEnvelopes(bundle, runId) {
  const first = bundle.waveforms.run_first[String(runId)];
  const count = bundle.waveforms.run_count[String(runId)];
  if (first === undefined) throw new Error(`no waveforms for run ${runId}`);
  const envLen = bundle.waveforms.env_len;
  const base = first * envLen;
  const length = count * envLen;
  const buffer = await fetchSlice(`${bundle.baseUrl}/envelopes.bin`, base, length);

  return bundle.byRun.get(runId).map((entry) => {
    const [offset, size, scale] = entry.env;
    const codes = new Int16Array(buffer, offset - base, size / 2);
    const values = new Float32Array(codes.length);
    for (let i = 0; i < codes.length; i++) values[i] = codes[i] * scale;
    return { values, buckets: bundle.waveforms.buckets, entry };
  });
}

/**
 * Full-rate analysis window, in Pa. Fetch this when the user zooms in.
 *
 * The bytes are a `fixed2-rice-v1` frame, roughly half the size of raw int16;
 * decoding a 32k-sample record takes about 2 ms.
 */
export async function fetchSamples(bundle, waveformId) {
  const entry = bundle.byId.get(waveformId);
  const [offset, length] = entry.raw;
  const frame = await fetchSlice(`${bundle.baseUrl}/samples.bin`, offset, length);
  const { values } = decodeFrame(frame);
  return { values, dt: entry.dt, t0: bundle.waveforms.window_start_s, entry };
}

/* -------------------------------------------------------------- frame codec
 *
 * Decoder for the `fixed2-rice-v1` frames written by tbacss/wavecodec.py:
 * integer-quantised samples, second-differenced, Rice-coded with a per-block
 * parameter. That is the cheap tier of FLAC, and it halves the size of raw
 * int16 because it exploits correlation between samples rather than trying to
 * find a cleverer way to spell each one.
 *
 * Layout, little-endian:
 *   0   char[4]  "TBW1"
 *   4   u8       version
 *   5   u8       predictor order
 *   6   u8       quantiser bit depth
 *   7   u8       log2 of the Rice block size
 *   8   u32      sample count
 *   12  f64      scale, Pa per code
 *   20  i32[order]  seeds, one per difference level
 *   ..  u8[blocks]  Rice parameter per block
 *   ..  bitstream, MSB first
 */

const FRAME_MAGIC = 0x31574254; // "TBW1" read as little-endian u32

export function decodeFrame(buffer, byteOffset = 0, byteLength = null) {
  const view = new DataView(
    buffer,
    byteOffset,
    byteLength ?? buffer.byteLength - byteOffset,
  );
  if (view.getUint32(0, true) !== FRAME_MAGIC) throw new Error('not a TBW1 frame');
  const version = view.getUint8(4);
  if (version !== 1) throw new Error(`unsupported frame version ${version}`);

  const order = view.getUint8(5);
  const blockLog2 = view.getUint8(7);
  const n = view.getUint32(8, true);
  const scale = view.getFloat64(12, true);

  let offset = 20;
  const seeds = new Int32Array(order);
  for (let i = 0; i < order; i++, offset += 4) seeds[i] = view.getInt32(offset, true);

  const count = n - order;
  const block = 1 << blockLog2;
  const blocks = Math.ceil(count / block);
  const parameters = new Uint8Array(
    buffer,
    byteOffset + offset,
    blocks,
  );
  offset += blocks;

  const bytes = new Uint8Array(buffer, byteOffset + offset, view.byteLength - offset);
  const codes = new Float64Array(n);

  // Bit reader: a 32-bit window refilled a byte at a time.
  let bitPos = 0;
  const readBit = () => {
    const bit = (bytes[bitPos >>> 3] >>> (7 - (bitPos & 7))) & 1;
    bitPos++;
    return bit;
  };
  const readBits = (width) => {
    let value = 0;
    for (let i = 0; i < width; i++) value = (value << 1) | readBit();
    return value >>> 0;
  };

  let index = order;
  for (let b = 0; b < blocks; b++) {
    const k = parameters[b];
    const size = Math.min(block, count - b * block);
    for (let i = 0; i < size; i++) {
      let quotient = 0;
      while (readBit()) quotient++;
      const value = k ? quotient * 2 ** k + readBits(k) : quotient;
      // zigzag -> signed
      codes[index++] = (value >>> 1) ^ -(value & 1);
    }
  }

  // Undo the differences. The residual occupies [order, n); each level writes
  // its seed one slot to the left and prefix-sums from there to the end, which
  // is exactly cumsum([seed, ...previous]) done in place.
  for (let level = order - 1; level >= 0; level--) {
    codes[level] = seeds[level];
    let running = 0;
    for (let i = level; i < n; i++) {
      running += codes[i];
      codes[i] = running;
    }
  }

  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = codes[i] * scale;
  return { values: out, scale, n };
}

/* ------------------------------------------------- client-side derived curves
 *
 * Impulse and Leq are not published: they are cheap to derive from the
 * full-rate window, and deriving them here lets the user re-window or
 * re-weight interactively rather than being stuck with publish-time choices.
 */

const P0 = 20e-6;

export function toDb(pa, reference = P0) {
  return 20 * Math.log10(Math.abs(pa) / reference);
}

/** Cumulative trapezoidal integral of pressure, in Pa*ms. */
export function impulse(samples, dt) {
  const stepMs = dt * 1000;
  const out = new Float64Array(samples.length);
  let total = 0;
  for (let i = 1; i < samples.length; i++) {
    total += ((samples[i] + samples[i - 1]) / 2) * stepMs;
    out[i] = total;
  }
  return out;
}

/**
 * IEC 61672 A-weighting, bilinear-transformed to `fs`.
 * Same analog prototype as the Octave `adsgn.m` TBAC publishes.
 */
export function aWeightingCoefficients(fs) {
  const [f1, f2, f3, f4] = [20.598997, 107.65265, 737.86223, 12194.217];
  const a1000 = 1.9997;
  const conv = (a, b) => {
    const out = new Array(a.length + b.length - 1).fill(0);
    for (let i = 0; i < a.length; i++) {
      for (let j = 0; j < b.length; j++) out[i + j] += a[i] * b[j];
    }
    return out;
  };
  const num = [(2 * Math.PI * f4) ** 2 * 10 ** (a1000 / 20), 0, 0, 0, 0];
  let den = conv(
    [1, 4 * Math.PI * f4, (2 * Math.PI * f4) ** 2],
    [1, 4 * Math.PI * f1, (2 * Math.PI * f1) ** 2],
  );
  den = conv(conv(den, [1, 2 * Math.PI * f3]), [1, 2 * Math.PI * f2]);
  return bilinear(num, den, fs);
}

/** Analog (b, a) -> digital (b, a) by the bilinear transform, matching scipy. */
function bilinear(b, a, fs) {
  const n = Math.max(b.length, a.length) - 1;
  const bp = new Array(n + 1).fill(0);
  const ap = new Array(n + 1).fill(0);
  // Pad to a common order, highest power first.
  const bIn = [...new Array(n + 1 - b.length).fill(0), ...b];
  const aIn = [...new Array(n + 1 - a.length).fill(0), ...a];
  const k = 2 * fs;

  // Expand each s^m term as (k*(z-1))^m * (z+1)^(n-m), accumulating in z.
  const binomial = (m, j) => {
    let out = 1;
    for (let t = 0; t < j; t++) out = (out * (m - t)) / (t + 1);
    return out;
  };
  for (let m = 0; m <= n; m++) {
    const power = n - m; // s^power
    const coefficientB = bIn[m];
    const coefficientA = aIn[m];
    if (coefficientB === 0 && coefficientA === 0) continue;
    const scale = k ** power;
    for (let i = 0; i <= power; i++) {
      const left = binomial(power, i) * (-1) ** i;
      for (let j = 0; j <= n - power; j++) {
        const right = binomial(n - power, j);
        const index = i + j;
        bp[index] += coefficientB * scale * left * right;
        ap[index] += coefficientA * scale * left * right;
      }
    }
  }
  const norm = ap[0];
  return [bp.map((v) => v / norm), ap.map((v) => v / norm)];
}

/** Direct-form-II transposed IIR, equivalent to scipy's lfilter. */
export function lfilter(b, a, x) {
  const out = new Float64Array(x.length);
  const order = Math.max(b.length, a.length);
  const state = new Float64Array(order);
  for (let n = 0; n < x.length; n++) {
    const y = b[0] * x[n] + state[0];
    for (let i = 1; i < order; i++) {
      state[i - 1] =
        (b[i] ?? 0) * x[n] - (a[i] ?? 0) * y + (i + 1 < order ? state[i] : 0);
    }
    out[n] = y;
  }
  return out;
}

/**
 * Running RMS over a rectangular window of `tau` seconds, matching TBAC's
 * `Leq_fast.m`. A prefix-sum of squares gives the same answer as their FFT
 * convolution without needing an FFT.
 */
export function leq(samples, fs, tau = 0.01) {
  const width = Math.floor(fs * tau);
  const out = new Float64Array(samples.length);
  let total = 0;
  for (let i = 0; i < samples.length; i++) {
    total += samples[i] * samples[i];
    if (i >= width) total -= samples[i - width] * samples[i - width];
    out[i] = Math.sqrt(total / width);
  }
  return out;
}

/** Peak, impulse and Leq for one window, in the published units. */
export function metrics(samples, dt, fs = 1 / dt) {
  const [b, a] = aWeightingCoefficients(fs);
  const weighted = lfilter(b, a, samples);
  const integral = impulse(samples, dt);
  const running = leq(weighted, fs);

  let peak = -Infinity;
  let peakA = -Infinity;
  for (let i = 0; i < samples.length; i++) {
    if (samples[i] > peak) peak = samples[i];
    if (weighted[i] > peakA) peakA = weighted[i];
  }
  // Impulse window ends at the trough, per the report's method.
  let trough = 0;
  for (let i = 1; i < integral.length; i++) {
    if (integral[i] < integral[trough]) trough = i;
  }
  let peakImpulse = 0;
  for (let i = 0; i <= trough; i++) {
    if (integral[i] > peakImpulse) peakImpulse = integral[i];
  }
  let peakLeq = 0;
  for (let i = 0; i < running.length; i++) {
    if (running[i] > peakLeq) peakLeq = running[i];
  }

  return {
    peak_pa: peak,
    peak_db: toDb(peak),
    peak_dba: toDb(peakA),
    impulse_pa_ms: peakImpulse,
    impulse_db_ms: toDb(peakImpulse),
    peak_leq10ms_dba: toDb(peakLeq),
  };
}

/**
 * Reference reader for the bundle written by `python -m tbacss publish`.
 *
 * No dependencies and no query engine. The catalog is small enough to hold
 * entirely in typed arrays, so filtering and Pareto search are plain loops
 * over Float32Array. Waveforms are pulled one at a time with HTTP Range.
 */

const MISSING = -1; // dictionary code for a null string

/* -------------------------------------------------------------------- types
 *
 * The shapes `tbacss/webexport.py` writes. They are trusted rather than
 * validated: the bundle is ours, and a bundle that does not match is a publish
 * bug to fix there, not something for the reader to paper over.
 */

/** A loaded column: numbers as Float64Array with NaN for null, or dictionary codes. */
export type Column = Float64Array | Int32Array;

/** Any table's columns, by name. A name the bundle does not carry is undefined. */
export interface Columns {
  [name: string]: Column | undefined;
}

/** Numbers become `Float64Array` with NaN for null; strings stay as codes. */
export interface CatalogColumns extends Columns {
  // Dictionary-encoded, codes into `dictionaries[name]` with -1 for null.
  manufacturer: Int32Array;
  suppressor: Int32Array;
  caliber: Int32Array;
  cartridge: Int32Array;
  event_label: Int32Array;
  host_cycling: Int32Array;
  host_platform: Int32Array;
  host_ammo: Int32Array;
  /** TBAC's advisory summary per run; missing from bundles older than caveats.py. */
  caveat?: Int32Array;
  /** Which suppressor, as a key into `cans`; missing from bundles older than names.py. */
  can?: Int32Array;

  year: Float64Array;
  is_baseline: Float64Array;
  shots: Float64Array;
  waveform_count: Float64Array;
  weight_oz: Float64Array;
  length_in: Float64Array;
  max_diameter_in: Float64Array;
  vol_cuin: Float64Array;
  host_barrel_in: Float64Array;
  host_grains: Float64Array;
  // ...plus the per-mic measures (`se_peak_dba`, `ml_reduction_db`, ...) and a
  // `<measure>_sem` companion for each shot-averaged one, reached by name.
}

export interface ShotColumns extends Columns {
  waveform_id: Float64Array;
  test_run_id: Float64Array;
  shot: Float64Array;
  mic: Int32Array;
  peak_db: Float64Array;
  peak_dba: Float64Array;
  impulse_db_ms: Float64Array;
  peak_leq10ms_dba: Float64Array;
}

/** One summit year, as `catalog.datasets` lists it. */
export interface Dataset {
  year: number;
  name: string;
  report_url: string | null;
  archive_sha256: string | null;
}

/** A host code as the report describes it; `tbacss.hosts.Host`. */
export interface Host {
  label: string;
  description: string;
  barrel_in: number | null;
  /** "report" if TBAC stated the barrel, "model" if it is the named gun's spec. */
  barrel_source: string | null;
  cycling: string | null;
  platform: string | null;
  integral: boolean;
  subsonic: boolean | null;
  grains: number | null;
}

/** One suppressor under its settled name; `tbacss.names.display_names`. */
export interface Can {
  maker: string;
  model: string;
}

/** An advisory TBAC published in prose; `tbacss.caveats.Caveat`. */
export interface Caveat {
  year: number;
  cartridge: string;
  mics: string[];
  severity: string;
  summary: string;
  detail: string;
}

/** A columnar table exactly as it is on the wire. */
export interface RawTable {
  n: number;
  ids?: number[];
  columns: Record<string, (number | null)[]>;
  dictionaries?: Record<string, string[]>;
  datasets?: Dataset[];
  version?: string;
  hosts?: Record<string, Host>;
  caveats?: Caveat[];
  band_centres?: number[];
  cans?: Record<string, Can>;
}

/** The minimum a filter or frontier needs: row count, columns, dictionaries. */
export interface ColumnarTable {
  n: number;
  columns: Columns;
  dictionaries: Record<string, string[] | undefined>;
}

export interface Table<C extends Columns = Columns> extends ColumnarTable {
  ids: number[] | null;
  columns: C;
  datasets: Dataset[] | null;
  version: string | null;
  hosts: Record<string, Host | undefined>;
  cans: Record<string, Can | undefined>;
  row(i: number): Record<string, string | number | null>;
}

/** The run catalog, which always names its rows' test_run ids. */
export interface Catalog extends Table<CatalogColumns> {
  ids: number[];
}
export type ShotTable = Table<ShotColumns>;

/** `waveforms.json`: one row per record, offsets left out. */
export interface WaveformIndex {
  n: number;
  buckets: number;
  /** Bytes per envelope; every envelope is the same size. */
  env_len: number;
  sample_codec: string;
  sample_bits: number;
  sample_rate_hz: number;
  window_start_s: number;
  dictionaries: { mic: string[] };
  columns: {
    id: number[];
    run: number[];
    mic: number[];
    shot: number[];
    excluded: number[];
    n: number[];
    dt: number[];
    overload: (number | null)[];
    env_scale: number[];
    raw_len: number[];
  };
  run_first: Record<string, number | undefined>;
  run_count: Record<string, number | undefined>;
}

/** One record, with its byte ranges rebuilt. */
export interface WaveformEntry {
  id: number;
  run: number;
  mic: string | null;
  shot: number;
  excluded: boolean;
  n: number;
  dt: number;
  overload: number | null;
  /** [offset, length, scale] into envelopes.bin. */
  env: [number, number, number];
  /** [offset, length] into samples.bin. */
  raw: [number, number];
}

/** `bands.json`: per run, per mic, one-third-octave levels in dB. */
export interface Bands {
  centres: number[];
  runs: Record<string, Record<string, (number | null)[]> | undefined>;
}

export interface Bundle {
  baseUrl: string;
  /** `?v=<content hash>`, or '' for an unversioned bundle. */
  version: string;
  catalog: Catalog;
  shots: ShotTable;
  waveforms: WaveformIndex & { entries: WaveformEntry[] };
  byId: Map<number, WaveformEntry>;
  byRun: Map<number, WaveformEntry[]>;
  /** Fetched on first use; null when the bundle was published without bands. */
  bands?: Bands | null;
}

/** Interleaved [min, max] per bucket, in Pa. */
export interface Envelope {
  values: Float32Array;
  buckets: number;
  entry: WaveformEntry;
}

export interface Samples {
  values: Float32Array;
  dt: number;
  t0: number;
  entry: WaveformEntry;
}

/* ------------------------------------------------------------------ catalog */

/**
 * Load a columnar table and convert its numeric columns to typed arrays.
 * Dictionary columns stay as Int32Array of codes plus the string table, which
 * doubles as the facet list for a filter UI.
 */
async function loadTable<C extends Columns>(url: string, init?: RequestInit): Promise<Table<C>> {
  const raw = (await (await fetch(url, init)).json()) as RawTable;
  const columns: Columns = {};
  for (const [name, values] of Object.entries(raw.columns)) {
    columns[name] = raw.dictionaries?.[name]
      ? Int32Array.from(values, (v) => v ?? MISSING)
      : Float64Array.from(values, (v) => (v === null ? NaN : v));
  }
  const table: Table<C> = {
    n: raw.n,
    ids: raw.ids ?? null,
    // The loop above fills exactly what the file names; C is what it promises.
    columns: columns as C,
    dictionaries: raw.dictionaries ?? {},
    datasets: raw.datasets ?? null,
    version: raw.version ?? null,
    // Host code -> {label, description}, transcribed from each year's report;
    // the codes are not explained anywhere in all.csv.
    hosts: raw.hosts ?? {},
    cans: raw.cans ?? {},
    /** Row as a plain object, for display. */
    row(i) {
      const out: Record<string, string | number | null> = {};
      for (const [name, column] of Object.entries(this.columns)) {
        if (!column) continue;
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
  return table;
}

/**
 * Rebuild per-record entries from the columnar index.
 *
 * The published file leaves offsets out: envelopes are all `env_len` bytes so
 * theirs is `position * env_len`, and the frame offsets are the prefix sum of
 * `raw_len`. Reconstructing costs one pass and saves a few MB on the wire.
 */
function expandWaveformIndex(index: WaveformIndex): WaveformEntry[] {
  const { columns, dictionaries, env_len: envLen } = index;
  const entries = new Array<WaveformEntry>(index.n);
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

export async function loadBundle(baseUrl = '.'): Promise<Bundle> {
  // The catalog is revalidated on every load (a 304 when nothing changed) and
  // carries the version that busts the rest. That way the big files can be
  // cached hard without a republish ever serving half a stale bundle.
  const table = await loadTable<CatalogColumns>(`${baseUrl}/catalog.json`, { cache: 'no-cache' });
  const { ids } = table;
  if (!ids) throw new Error('catalog.json has no ids');
  const catalog: Catalog = Object.assign(table, { ids });
  const version = catalog.version ? `?v=${encodeURIComponent(catalog.version)}` : '';

  const [shots, index] = await Promise.all([
    loadTable<ShotColumns>(`${baseUrl}/shots.json${version}`),
    (await fetch(`${baseUrl}/waveforms.json${version}`)).json() as Promise<WaveformIndex>,
  ]);
  const entries = expandWaveformIndex(index);
  const waveforms = { ...index, entries };

  const byId = new Map(entries.map((e) => [e.id, e]));
  const byRun = new Map<number, WaveformEntry[]>();
  for (const entry of entries) {
    let group = byRun.get(entry.run);
    if (!group) byRun.set(entry.run, (group = []));
    group.push(entry);
  }
  return { baseUrl, version, catalog, shots, waveforms, byId, byRun };
}

/* ------------------------------------------------------------------ filters */

/** Inclusive bounds; null leaves that side open. */
export type Range = [number | null, number | null];

/** Allowed strings for a dictionary column, or a range for a numeric one. */
export type Spec = Record<string, Set<string> | Range>;

/**
 * Build a row mask. `spec` maps a column to either a Set of allowed strings
 * (dictionary columns) or a [min, max] range (numeric columns); either bound
 * may be null. Rows whose value is null never pass a range test.
 */
export function selection(table: ColumnarTable, spec: Spec): Uint8Array {
  const mask = new Uint8Array(table.n).fill(1);
  for (const [name, test] of Object.entries(spec)) {
    const column = table.columns[name];
    if (!column) throw new Error(`no column ${name}`);
    const dictionary = table.dictionaries[name];
    if (dictionary) {
      const allowed = new Set(
        [...test]
          .map((v) => (typeof v === 'string' ? dictionary.indexOf(v) : -1))
          .filter((c) => c >= 0),
      );
      for (let i = 0; i < table.n; i++) {
        if (mask[i] && !allowed.has(column[i])) mask[i] = 0;
      }
    } else {
      if (test instanceof Set) throw new Error(`${name} is numeric; filter it by range`);
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

export function rows(table: { n: number }, mask: ArrayLike<number>): number[] {
  const out: number[] = [];
  for (let i = 0; i < table.n; i++) if (mask[i]) out.push(i);
  return out;
}

/* ------------------------------------------------------------------- pareto */

export type Direction = 'min' | 'max';

export interface Objective {
  column: string;
  direction: Direction;
}

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
export function paretoFront(
  table: ColumnarTable,
  objectives: Objective[],
  mask: ArrayLike<number> | null = null,
): number[] {
  const signs = objectives.map((o) => (o.direction === 'max' ? -1 : 1));
  const columns = objectives.map((o) => {
    const column = table.columns[o.column];
    if (!column) throw new Error(`no column ${o.column}`);
    return column;
  });

  const candidates: number[] = [];
  for (let i = 0; i < table.n; i++) {
    if (mask && !mask[i]) continue;
    if (columns.some((c) => Number.isNaN(c[i]))) continue;
    candidates.push(i);
  }

  const front: number[] = [];
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
async function fetchSlice(url: string, offset: number, length: number): Promise<ArrayBuffer> {
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

async function fetchRange(url: string, offset: number, length: number): Promise<Int16Array> {
  return new Int16Array(await fetchSlice(url, offset, length));
}

/** The index entry for a record id, or an error naming it. */
function entryFor(bundle: Bundle, waveformId: number): WaveformEntry {
  const entry = bundle.byId.get(waveformId);
  if (!entry) throw new Error(`no waveform ${waveformId}`);
  return entry;
}

/**
 * Overview trace: interleaved [min, max] per bucket, in Pa.
 * Min/max decimation keeps the extremes, which is the whole point of a blast
 * trace, so this is visually lossless for any canvas narrower than `buckets`.
 */
export async function fetchEnvelope(bundle: Bundle, waveformId: number): Promise<Envelope> {
  const entry = entryFor(bundle, waveformId);
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
export async function fetchRunEnvelopes(bundle: Bundle, runId: number): Promise<Envelope[]> {
  const first = bundle.waveforms.run_first[String(runId)];
  const count = bundle.waveforms.run_count[String(runId)];
  const entries = bundle.byRun.get(runId);
  if (first === undefined || count === undefined || !entries) {
    throw new Error(`no waveforms for run ${runId}`);
  }
  const envLen = bundle.waveforms.env_len;
  const base = first * envLen;
  const length = count * envLen;
  const buffer = await fetchSlice(`${bundle.baseUrl}/envelopes.bin${bundle.version}`, base, length);

  return entries.map((entry) => {
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
export async function fetchSamples(bundle: Bundle, waveformId: number): Promise<Samples> {
  const entry = entryFor(bundle, waveformId);
  const [offset, length] = entry.raw;
  const frame = await fetchSlice(`${bundle.baseUrl}/samples.bin${bundle.version}`, offset, length);
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

export interface Frame {
  values: Float32Array;
  scale: number;
  n: number;
}

export function decodeFrame(
  buffer: ArrayBufferLike,
  byteOffset = 0,
  byteLength: number | null = null,
): Frame {
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
  const readBits = (width: number) => {
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

export function toDb(pa: number, reference = P0): number {
  return 20 * Math.log10(Math.abs(pa) / reference);
}

/** Cumulative trapezoidal integral of pressure, in Pa*ms. */
export function impulse(samples: ArrayLike<number>, dt: number): Float64Array {
  const stepMs = dt * 1000;
  const out = new Float64Array(samples.length);
  let total = 0;
  for (let i = 1; i < samples.length; i++) {
    total += ((samples[i] + samples[i - 1]) / 2) * stepMs;
    out[i] = total;
  }
  return out;
}

/** Filter coefficients as `[b, a]`, highest power first. */
export type Coefficients = [number[], number[]];

/**
 * IEC 61672 A-weighting, bilinear-transformed to `fs`.
 * Same analog prototype as the Octave `adsgn.m` TBAC publishes.
 */
export function aWeightingCoefficients(fs: number): Coefficients {
  const [f1, f2, f3, f4] = [20.598997, 107.65265, 737.86223, 12194.217];
  const a1000 = 1.9997;
  const conv = (a: number[], b: number[]) => {
    const out = new Array<number>(a.length + b.length - 1).fill(0);
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
function bilinear(b: number[], a: number[], fs: number): Coefficients {
  const n = Math.max(b.length, a.length) - 1;
  const bp = new Array<number>(n + 1).fill(0);
  const ap = new Array<number>(n + 1).fill(0);
  // Pad to a common order, highest power first.
  const bIn = [...new Array<number>(n + 1 - b.length).fill(0), ...b];
  const aIn = [...new Array<number>(n + 1 - a.length).fill(0), ...a];
  const k = 2 * fs;

  // Expand each s^m term as (k*(z-1))^m * (z+1)^(n-m), accumulating in z.
  const binomial = (m: number, j: number) => {
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
export function lfilter(b: number[], a: number[], x: ArrayLike<number>): Float64Array {
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
 *
 * `Leq_fast.m` convolves in the frequency domain, which makes the sum
 * *circular*: the first `tau` seconds average in samples from the tail of the
 * record. The prefix sum is seeded to match rather than ramping up from an
 * empty window, because a ramp is not a level — divide a partial sum by the
 * full width and the opening 10 ms reads as a rise from 0 dB to ambient that
 * no microphone ever heard. The peak search happens tens of milliseconds
 * later either way, so this changes no published figure; it only stops the
 * plotted curve from opening with an artefact.
 */
export function leq(samples: ArrayLike<number>, fs: number, tau = 0.01): Float64Array {
  const width = Math.floor(fs * tau);
  const n = samples.length;
  const out = new Float64Array(n);
  if (width > n) throw new Error('signal is shorter than the integration time');

  let total = 0;
  for (let i = n - width; i < n; i++) total += samples[i] * samples[i];
  for (let i = 0; i < n; i++) {
    total += samples[i] * samples[i];
    total -= i >= width ? samples[i - width] ** 2 : samples[n - width + i] ** 2;
    out[i] = Math.sqrt(Math.max(total, 0) / width);
  }
  return out;
}

/* The bounds the report's method searches within, from `tbacss.analysis`.
 * They are not cosmetic: the peak window keeps a late reflection off the peak
 * and the impulse trough, and the Leq window keeps the search on the shot
 * rather than on whatever rang loudest in the bay afterwards. */
export const PEAK_STOP_S = 0.075; // end of the peak search, from window start
export const LEQ_TRIGGER_PA = 1.0; // shot start = first sample above this
export const LEQ_WIDTH_MS = 25.0; // how far past shot start to look for Leq

/** Peak, impulse and Leq for one window, in the published units. */
export interface Metrics {
  peak_pa: number;
  peak_db: number;
  peak_dba: number;
  impulse_pa_ms: number;
  impulse_db_ms: number;
  peak_leq10ms_dba: number;
}

/** The published figures plus the working behind them; see `analyse`. */
export interface Analysis<S extends ArrayLike<number> = ArrayLike<number>> extends Metrics {
  samples: S;
  /** A-weighted pressure, Pa. */
  weighted: Float64Array;
  /** Cumulative impulse, Pa*ms. */
  integral: Float64Array;
  /** Running A-weighted Leq(10ms) as RMS pressure, Pa. */
  running: Float64Array;
  peakStop: number;
  peakIndex: number;
  trough: number;
  impulseIndex: number;
  leqStart: number;
  leqStop: number;
  leqIndex: number;
  triggered: boolean;
}

/**
 * The published analysis of one record: the curves, and the indices the
 * report's method picks out of them.
 *
 * Returned rather than reduced to numbers so a plot can mark *where* each
 * figure came from. A cumulative-impulse curve on its own is unreadable — it
 * wanders for a hundred milliseconds and ends somewhere arbitrary — because
 * the published impulse is not "the integral", it is the maximum of the
 * integral up to the trough. Without the trough drawn on it, the curve does
 * not show the number it is supposed to explain.
 */
export function analyse<S extends ArrayLike<number>>(samples: S, dt: number, fs = 1 / dt): Analysis<S> {
  const [b, a] = aWeightingCoefficients(fs);
  const weighted = lfilter(b, a, samples);
  const integral = impulse(samples, dt);
  const running = leq(weighted, fs);
  const n = samples.length;

  // Octave rounds half away from zero; for a positive product that is floor+0.5.
  const peakStop = Math.min(Math.floor(PEAK_STOP_S * fs + 0.5), n);

  let peak = -Infinity;
  let peakIndex = 0;
  let peakA = -Infinity;
  for (let i = 0; i < peakStop; i++) {
    if (samples[i] > peak) { peak = samples[i]; peakIndex = i; }
    if (weighted[i] > peakA) peakA = weighted[i];
  }

  let trough = 0;
  for (let i = 1; i < peakStop; i++) if (integral[i] < integral[trough]) trough = i;
  let impulseIndex = 0;
  for (let i = 1; i <= trough; i++) if (integral[i] > integral[impulseIndex]) impulseIndex = i;
  const peakImpulse = Math.max(integral[impulseIndex], 0);

  // Shot start is the first sample over the trigger, and the Leq peak is looked
  // for in the 25 ms after it. Records that never break 1 Pa do exist in
  // principle; fall back to the whole record rather than throwing at a reader.
  let leqStart = -1;
  for (let i = 0; i < n; i++) {
    if (samples[i] > LEQ_TRIGGER_PA) { leqStart = i; break; }
  }
  const triggered = leqStart >= 0;
  if (!triggered) leqStart = 0;
  const leqStop = triggered
    ? Math.min(leqStart + Math.floor((LEQ_WIDTH_MS * fs) / 1000 + 0.5), n - 1)
    : n - 1;

  let peakLeq = 0;
  let leqIndex = leqStart;
  for (let i = leqStart; i <= leqStop; i++) {
    if (running[i] > peakLeq) { peakLeq = running[i]; leqIndex = i; }
  }

  return {
    samples, weighted, integral, running,
    peakStop, peakIndex, trough, impulseIndex, leqStart, leqStop, leqIndex, triggered,
    peak_pa: peak,
    peak_db: toDb(peak),
    peak_dba: toDb(peakA),
    impulse_pa_ms: peakImpulse,
    impulse_db_ms: toDb(peakImpulse),
    peak_leq10ms_dba: toDb(peakLeq),
  };
}

/** Peak, impulse and Leq for one window, in the published units. */
export function metrics(samples: ArrayLike<number>, dt: number, fs = 1 / dt): Metrics {
  const {
    peak_pa, peak_db, peak_dba, impulse_pa_ms, impulse_db_ms, peak_leq10ms_dba,
  } = analyse(samples, dt, fs);
  return { peak_pa, peak_db, peak_dba, impulse_pa_ms, impulse_db_ms, peak_leq10ms_dba };
}

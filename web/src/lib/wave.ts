/**
 * Fetching and framing one run's waveforms.
 *
 * The stored window runs from 1 ms to 99 or 124 ms, but the rig pre-triggers
 * and every shot in the archive arrives between about 47 and 56 ms. Framing the
 * whole window spends two fifths of the plot on guaranteed silence, so a run
 * opens on the arrival, the peak behind it and the trough after that.
 */

import { LEQ_TRIGGER_PA, analyse, fetchRunEnvelopes, fetchSamples } from '../tbacss.ts';
import type { Analysis, Bands, Bundle, Envelope, WaveformEntry } from '../tbacss.ts';
import type { Domain } from './plot.ts';

export const VIEW_LEAD_MS = 1.5; // shown ahead of the first arrival
export const VIEW_SPAN_MS = 24; // holds the trough for ~95% of records
export const MIN_SPAN_MS = 0.05; // ~13 samples; past this nothing is left to resolve
const MARK_MARGIN_MS = 2;

/** [start, end] of one record, in ms. */
export function recordSpan(bundle: Bundle, entry: WaveformEntry): Domain {
  const t0 = bundle.waveforms.window_start_s * 1000;
  return [t0, t0 + entry.n * entry.dt * 1000];
}

/** Every record's span together. Runs mix 99 ms and 124 ms windows. */
export function fullSpan(bundle: Bundle, records: Envelope[]): Domain {
  let lo = Infinity;
  let hi = -Infinity;
  for (const record of records) {
    const [a, b] = recordSpan(bundle, record.entry);
    lo = Math.min(lo, a);
    hi = Math.max(hi, b);
  }
  return [lo, hi];
}

/**
 * Where the shot starts in one record, from its envelope: the published 1 Pa
 * trigger at bucket resolution, or a fifth of the peak for a record too quiet
 * to cross it.
 */
function envelopeTrigger(bundle: Bundle, record: Envelope): number | null {
  const { values, buckets, entry } = record;
  const [t0, t1] = recordSpan(bundle, entry);
  const width = (t1 - t0) / buckets;
  let peak = 0;
  for (let b = 0; b < buckets; b++) peak = Math.max(peak, values[b * 2 + 1]);
  if (!(peak > 0)) return null;
  const threshold = Math.min(LEQ_TRIGGER_PA, peak * 0.2);
  for (let b = 0; b < buckets; b++) if (values[b * 2 + 1] > threshold) return t0 + b * width;
  return null;
}

/** The opening view: from just before the earliest arrival. */
export function autoWindow(bundle: Bundle, records: Envelope[]): Domain {
  const [lo, hi] = fullSpan(bundle, records);
  let first = Infinity;
  for (const record of records) {
    const t = envelopeTrigger(bundle, record);
    if (t !== null) first = Math.min(first, t);
  }
  if (!Number.isFinite(first)) return [lo, hi];
  const start = Math.max(lo, first - VIEW_LEAD_MS);
  return [start, Math.min(hi, start + VIEW_SPAN_MS)];
}

/** Hold a view inside `full`, and refuse to zoom past the samples. */
export function clampDomain([t0, t1]: Domain, [lo, hi]: Domain): Domain {
  const span = Math.min(Math.max(t1 - t0, MIN_SPAN_MS), hi - lo);
  const start = Math.min(Math.max(t0, lo), hi - span);
  return [start, start + span];
}

/** Stretch a framing to reach marks that landed outside it. */
export function widenFor(view: Domain, full: Domain, times: number[]): Domain {
  let [lo, hi] = view;
  for (const t of times) {
    if (!Number.isFinite(t)) continue;
    lo = Math.min(lo, t - MARK_MARGIN_MS);
    hi = Math.max(hi, t + MARK_MARGIN_MS);
  }
  return clampDomain([lo, hi], full);
}

/* ---------------------------------------------------------------- caching
 *
 * A run's envelopes are one Range request and a shot's samples another. Both
 * are asked for from several places -- the article, the compare page, the
 * Listen button -- so they are fetched once and shared.
 */

const envelopes = new Map<number, Promise<Envelope[]>>();
const samples = new Map<number, Promise<FullRate>>();

export interface FullRate {
  entry: WaveformEntry;
  values: Float32Array;
  dt: number;
  analysis: Analysis<Float32Array>;
}

export function runEnvelopes(bundle: Bundle, runId: number): Promise<Envelope[]> {
  let found = envelopes.get(runId);
  if (!found) {
    found = fetchRunEnvelopes(bundle, runId);
    found.catch(() => envelopes.delete(runId));
    envelopes.set(runId, found);
  }
  return found;
}

/** A shot at full rate, with the report's analysis run over it. */
export function fullRate(bundle: Bundle, entry: WaveformEntry): Promise<FullRate> {
  let found = samples.get(entry.id);
  if (!found) {
    found = fetchSamples(bundle, entry.id).then(({ values, dt }) => ({
      entry,
      values,
      dt,
      analysis: analyse(values, dt),
    }));
    found.catch(() => samples.delete(entry.id));
    samples.set(entry.id, found);
  }
  return found;
}

/** The mics a run was recorded at, in the order the page offers them. */
export function micsOf(bundle: Bundle, runId: number): string[] {
  const order = ['SE', 'ML', 'MR', '225'];
  const mics = new Set((bundle.byRun.get(runId) ?? []).map((e) => e.mic ?? ''));
  return [...mics].sort((a, b) => (order.indexOf(a) + 99) % 99 - (order.indexOf(b) + 99) % 99);
}

/** One run's records at one mic, spares last. */
export function shotsOf(bundle: Bundle, runId: number, mic: string): WaveformEntry[] {
  return (bundle.byRun.get(runId) ?? [])
    .filter((e) => e.mic === mic)
    .sort((a, b) => Number(a.excluded) - Number(b.excluded) || a.shot - b.shot);
}

let bandsPromise: Promise<Bands | null> | null = null;

/** The one-third-octave spectra, fetched on first use. */
export function loadBands(bundle: Bundle): Promise<Bands | null> {
  bandsPromise ??= fetch(`${bundle.baseUrl}/bands.json${bundle.version}`)
    .then((r) => (r.ok ? (r.json() as Promise<Bands>) : null))
    .catch(() => null);
  return bandsPromise;
}

/**
 * Spectrum levels per Hz. Third-octave bands widen with frequency, so raw band
 * levels climb about 1 dB a band on a flat signal; dividing out the width gives
 * the shape a reader thinks they are looking at.
 */
export function perHz(levels: (number | null)[], centres: number[]): (number | null)[] {
  const ratio = 2 ** (1 / 6) - 2 ** (-1 / 6);
  return levels.map((v, i) => (v === null ? null : v - 10 * Math.log10(centres[i] * ratio)));
}

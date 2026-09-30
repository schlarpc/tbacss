/**
 * What the explorer shows, as plain functions of the catalog.
 *
 * No DOM and no Svelte here, so every rule the page applies -- which runs a
 * filter keeps, which are on the frontier, which are tied with which, how the
 * hosts are grouped -- runs under `node --test` against a hand-built catalog.
 */

import { paretoFront, rows as maskRows, selection } from '../tbacss.ts';
import type { Catalog, Direction, Range, Spec } from '../tbacss.ts';
import { measure } from './measures.ts';

/** The subset of the catalog the page reads. Tests build one by hand. */
export type Cat = Pick<Catalog, 'n' | 'ids' | 'columns' | 'dictionaries' | 'hosts' | 'cans'>;

export interface Filters {
  /** A host code, or null for every host at once. */
  host: string | null;
  /** Empty means every year. */
  years: number[];
  calibers: string[];
  /** Makers by their settled name (`cans[...].maker`). */
  makers: string[];
  weight: Range | null;
  length: Range | null;
}

export const NO_FILTERS: Filters = {
  host: null,
  years: [],
  calibers: [],
  makers: [],
  weight: null,
  length: null,
};

/* ------------------------------------------------------------- lookups */

/** A dictionary column's string for row `i`, or null. */
export function text(cat: Cat, column: string, i: number): string | null {
  const codes = cat.columns[column];
  const dictionary = cat.dictionaries[column];
  if (!codes || !dictionary) return null;
  return dictionary[codes[i]] ?? null;
}

/** A numeric column's value for row `i`; NaN when missing or absent. */
export function num(cat: Cat, column: string, i: number): number {
  const values = cat.columns[column];
  return values ? values[i] : NaN;
}

/** The can key for a row, falling back to the raw strings for an older bundle. */
export function canOf(cat: Cat, i: number): string {
  return text(cat, 'can', i) ?? `${text(cat, 'manufacturer', i)}/${text(cat, 'suppressor', i)}`;
}

/** Maker and model under their settled spellings. */
export function nameOf(cat: Cat, i: number): { maker: string; model: string } {
  const can = cat.cans[canOf(cat, i)];
  return can ?? { maker: text(cat, 'manufacturer', i) ?? '', model: text(cat, 'suppressor', i) ?? '' };
}

/** "Maker Model", without doubling a maker TBAC also wrote into the model. */
export function fullName(name: { maker: string; model: string }): string {
  return name.model.toLowerCase().startsWith(name.maker.toLowerCase()) ? name.model : `${name.maker} ${name.model}`;
}

export const hostOf = (cat: Cat, i: number) => text(cat, 'cartridge', i) ?? '';
export const yearOf = (cat: Cat, i: number) => num(cat, 'year', i);
export const isBaseline = (cat: Cat, i: number) => num(cat, 'is_baseline', i) === 1;

/** The row index of a test_run id, or -1. */
export const indexOfRun = (cat: Cat, id: number) => cat.ids.indexOf(id);

/** Standard error of a shot-averaged measure, when the bundle has one. */
export function semOf(cat: Cat, key: string, i: number): number | null {
  const value = num(cat, `${key}_sem`, i);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/* ------------------------------------------------------------- filters */

/** Rows the filters keep. Bare-muzzle reference runs are never results. */
export function visibleRows(cat: Cat, filters: Filters): number[] {
  const spec: Spec = {};
  if (filters.host) spec.cartridge = new Set([filters.host]);
  if (filters.calibers.length) spec.caliber = new Set(filters.calibers);
  if (filters.weight) spec.weight_oz = filters.weight;
  if (filters.length) spec.length_in = filters.length;
  const mask = selection(cat, spec);

  const years = new Set(filters.years);
  const makers = new Set(filters.makers);
  for (let i = 0; i < cat.n; i++) {
    if (!mask[i]) continue;
    if (isBaseline(cat, i)) mask[i] = 0;
    else if (years.size && !years.has(yearOf(cat, i))) mask[i] = 0;
    else if (makers.size && !makers.has(nameOf(cat, i).maker)) mask[i] = 0;
  }
  return maskRows(cat, mask);
}

/** The distinct years among `rows`, ascending. */
export function yearsIn(cat: Cat, rows: number[]): number[] {
  return [...new Set(rows.map((i) => yearOf(cat, i)))].sort((a, b) => a - b);
}

/** Smallest and largest finite value of a column over `rows`. */
export function extentOf(cat: Cat, column: string, rows: number[]): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const i of rows) {
    const v = num(cat, column, i);
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return lo <= hi ? [lo, hi] : null;
}

/* ------------------------------------------------------------- ranking */

/** Rows with a value for `key`, best first. Equal values keep id order. */
export function rankOrder(cat: Cat, rows: number[], key: string): number[] {
  const direction = measure(key).better === 'max' ? -1 : 1;
  return rows
    .filter((i) => Number.isFinite(num(cat, key, i)))
    .sort((a, b) => direction * (num(cat, key, a) - num(cat, key, b)) || cat.ids[a] - cat.ids[b]);
}

/**
 * Whether two means are closer than the measurement can resolve: errors add in
 * quadrature, and 2 sigma is conservative on purpose, because what this guards
 * against is reading a 0.2 dB gap as a ranking.
 */
export function indistinguishable(a: number, aSem: number | null, b: number, bSem: number | null): boolean {
  if (aSem === null || bSem === null) return false;
  return Math.abs(a - b) < 2 * Math.hypot(aSem, bSem);
}

/** The rows among `rows` that `i` cannot be told apart from on `key`. */
export function tiedWith(cat: Cat, rows: number[], key: string, i: number): number[] {
  const value = num(cat, key, i);
  const sem = semOf(cat, key, i);
  if (sem === null || !Number.isFinite(value)) return [];
  return rows.filter(
    (j) => j !== i && indistinguishable(value, sem, num(cat, key, j), semOf(cat, key, j)),
  );
}

/**
 * How far down a ranking the tie with the leader reaches: the last position
 * (0-based) holding a run that cannot be told apart from No. 1, or 0.
 */
export function leaderTieDepth(cat: Cat, ranked: number[], key: string): number {
  if (!ranked.length) return 0;
  const tied = new Set(tiedWith(cat, ranked, key, ranked[0]));
  let depth = 0;
  ranked.forEach((i, position) => {
    if (tied.has(i)) depth = position;
  });
  return depth;
}

/* ------------------------------------------------------------ frontier */

/**
 * Runs no other run beats on every objective among `keys`. Dimensions (a
 * measure with no better direction) drop out rather than cancelling the
 * frontier, and a run missing any plotted value is not on this plot at all.
 */
export function frontierOf(cat: Cat, rows: number[], keys: string[]): Set<number> {
  const objectives = keys.flatMap((key) => {
    const better = measure(key).better;
    return better ? [{ column: key, direction: better as Direction }] : [];
  });
  if (!objectives.length) return new Set();
  const plottable = new Uint8Array(cat.n);
  for (const i of rows) {
    if (keys.every((key) => Number.isFinite(num(cat, key, i)))) plottable[i] = 1;
  }
  return new Set(paretoFront(cat, objectives, plottable));
}

/** Frontier rows in the order the step line visits them: along the x axis. */
export function frontierPath(cat: Cat, frontier: Set<number>, xKey: string): number[] {
  return [...frontier].sort((a, b) => num(cat, xKey, a) - num(cat, xKey, b));
}

/* --------------------------------------------------------------- hosts */

export interface HostSummary {
  code: string;
  label: string;
  description: string;
  kind: string;
  runs: number;
  years: number[];
  /** A 2023-only host that is the same setup under an older code. */
  earlier: { code: string; runs: number } | null;
}

export interface HostTiers {
  /** Tested in more than one year: the Summit's regular guns. */
  regular: HostSummary[];
  /** Only ever tested in 2023, when the host list was different. */
  y2023: HostSummary[];
  /** Everything else: mostly guns a maker brought along. */
  other: HostSummary[];
}

export function hostTiers(cat: Cat): HostTiers {
  const runs = new Map<string, number>();
  const years = new Map<string, Set<number>>();
  for (let i = 0; i < cat.n; i++) {
    if (isBaseline(cat, i)) continue;
    const code = hostOf(cat, i);
    runs.set(code, (runs.get(code) ?? 0) + 1);
    let set = years.get(code);
    if (!set) years.set(code, (set = new Set()));
    set.add(yearOf(cat, i));
  }
  const summary = (code: string): HostSummary => {
    const host = cat.hosts[code];
    return {
      code,
      label: host?.label ?? code,
      description: host?.description ?? '',
      kind: host?.platform ?? host?.cycling ?? '',
      runs: runs.get(code) ?? 0,
      years: [...(years.get(code) ?? [])].sort((a, b) => a - b),
      earlier: null,
    };
  };
  const all = [...runs.keys()].map(summary);
  const byCount = (a: HostSummary, b: HostSummary) =>
    b.runs - a.runs || a.label.localeCompare(b.label, undefined, { numeric: true });

  const regular = all.filter((h) => h.years.length > 1).sort(byCount);
  const y2023 = all.filter((h) => h.years.length === 1 && h.years[0] === 2023).sort(byCount);
  const other = all.filter((h) => h.years.length === 1 && h.years[0] !== 2023).sort(byCount);

  // hosts.py labels a code reused across a change of setup with its year, so
  // the older one can sit under the newer card instead of looking unrelated.
  for (const old of y2023) {
    const base = old.label.replace(/ \(2023\)$/, '');
    const current = base !== old.label ? regular.find((h) => h.label === base) : undefined;
    if (current) current.earlier = { code: old.code, runs: old.runs };
  }
  return { regular, y2023, other };
}

/** "2024–26" or "2023". */
export function yearSpan(years: number[]): string {
  if (!years.length) return '';
  const first = years[0];
  const last = years[years.length - 1];
  return first === last ? String(first) : `${first}–${String(last).slice(2)}`;
}

/* ---------------------------------------------------------------- cans */

/** Every non-reference run of one can, oldest first. */
export function runsOfCan(cat: Cat, key: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < cat.n; i++) {
    if (!isBaseline(cat, i) && canOf(cat, i) === key) out.push(i);
  }
  return out.sort((a, b) => yearOf(cat, a) - yearOf(cat, b) || cat.ids[a] - cat.ids[b]);
}

/** A run's position on its own host, among every run tested there. */
export function rankOnHost(cat: Cat, i: number, key: string): { rank: number; of: number } | null {
  const host = hostOf(cat, i);
  const field: number[] = [];
  for (let j = 0; j < cat.n; j++) {
    if (!isBaseline(cat, j) && hostOf(cat, j) === host) field.push(j);
  }
  const order = rankOrder(cat, field, key);
  const rank = order.indexOf(i);
  return rank < 0 ? null : { rank: rank + 1, of: order.length };
}

/** Suppressors whose maker or model contains every word of `query`. */
export function searchCans(cat: Cat, query: string, limit = 8): { key: string; maker: string; model: string; runs: number }[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const counts = new Map<string, number>();
  for (let i = 0; i < cat.n; i++) {
    if (isBaseline(cat, i)) continue;
    const key = canOf(cat, i);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const hits: { key: string; maker: string; model: string; runs: number }[] = [];
  for (const [key, runs] of counts) {
    const can = cat.cans[key];
    if (!can) continue;
    const hay = `${can.maker} ${can.model}`.toLowerCase();
    if (words.every((word) => hay.includes(word))) hits.push({ key, ...can, runs });
  }
  // Model-name hits first, then the most-tested: someone typing "ultra" wants
  // the Ultra cans before a maker that happens to contain the word.
  const modelHit = (h: { model: string }) =>
    words.some((word) => h.model.toLowerCase().startsWith(word)) ? 0 : 1;
  return hits
    .sort((a, b) => modelHit(a) - modelHit(b) || b.runs - a.runs || a.model.localeCompare(b.model))
    .slice(0, limit);
}

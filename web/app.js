/**
 * Silencer Summit explorer.
 *
 * Everything runs against the static bundle from `python -m tbacss publish`:
 * a columnar catalog held in typed arrays, and waveforms pulled by HTTP Range
 * when something needs to draw them. No query engine, no chart library.
 */

import {
  loadBundle,
  selection,
  rows as maskRows,
  paretoFront,
  fetchRunEnvelopes,
  fetchSamples,
  analyse,
  toDb,
  LEQ_TRIGGER_PA,
} from './tbacss.js';

const $ = (id) => document.getElementById(id);
const P0 = 20e-6;

/**
 * Numeric columns offered on the axes: `[column, label, better]`.
 *
 * `better` is which way is desirable and belongs to the measure itself, not to
 * the reader -- there is one right answer per column, so the frontier needs no
 * configuring. Today every measure is a sound level or a physical dimension
 * and they all minimise; a column where more is better (net reduction against
 * the bare-muzzle baseline, say) is added with `'max'` and everything
 * downstream follows.
 *
 * `null` means the column is a dimension rather than an objective. `year` is
 * the one so far: a newer test is not a better one, so putting it on an axis
 * switches the frontier off rather than pretending 2026 dominates 2023.
 */
const MINIMISE = 'min';
const MAXIMISE = 'max';

/** Starting yaw/pitch for the 3D view, in radians. */
const DEFAULT_VIEW_INIT = { yaw: -0.62, pitch: 0.42 };

/**
 * `[key, label, better, group]`.
 *
 * `label` is the full name and is what axis titles, hints and the readout use,
 * where the measure appears on its own and has to say where it was measured.
 * `group` sorts the axis menus: two dozen measures in one flat list is a wall
 * of near-identical strings, and four of every five characters in it are a mic
 * name repeated. The menu prints the group once as a heading and strips it off
 * the options underneath, so what remains is the part that differs.
 */
const MEASURES = [
  ['se_peak_dba', "shooter's ear, peak dBA", MINIMISE, "Shooter's ear"],
  ['se_peak_db', "shooter's ear, peak dB", MINIMISE, "Shooter's ear"],
  ['se_peak_leq10ms_dba', "shooter's ear, Leq(10ms) dBA", MINIMISE, "Shooter's ear"],
  ['se_impulse_db_ms', "shooter's ear, impulse dB·ms", MINIMISE, "Shooter's ear"],
  // How much quieter than the bare muzzle. The one measure here where more
  // is better, and the number most readers actually want.
  ['se_reduction_dba', "shooter's ear, reduction dBA", MAXIMISE, "Shooter's ear"],
  // Shot one minus the rest. Less is better: the first round is the one that
  // matters, and a can that pops is a can that is inconsistent.
  ['se_first_round_pop', "shooter's ear, first-round pop dBA", MINIMISE, "Shooter's ear"],
  // Spectral shape. Low-frequency energy is the thump a dBA figure hides, and
  // less of it is better. The centroid is a character descriptor, not a score,
  // so it carries no direction.
  ['se_low_freq_db', "shooter's ear, energy below 250 Hz, dB", MINIMISE, "Shooter's ear"],
  ['se_centroid_hz', "shooter's ear, spectral centroid, Hz", null, "Shooter's ear"],

  ['ml_peak_dba', 'mil left, peak dBA', MINIMISE, 'Mil left'],
  ['ml_peak_db', 'mil left, peak dB', MINIMISE, 'Mil left'],
  ['ml_peak_leq10ms_dba', 'mil left, Leq(10ms) dBA', MINIMISE, 'Mil left'],
  ['ml_reduction_db', 'mil left, reduction dB', MAXIMISE, 'Mil left'],
  ['ml_first_round_pop', 'mil left, first-round pop dBA', MINIMISE, 'Mil left'],
  ['ml_low_freq_db', 'mil left, energy below 250 Hz, dB', MINIMISE, 'Mil left'],

  ['mr_peak_dba', 'mil right, peak dBA', MINIMISE, 'Mil right'],
  ['mr_peak_db', 'mil right, peak dB', MINIMISE, 'Mil right'],

  ['p225_peak_dba', '225°, peak dBA', MINIMISE, '225°'],
  ['p225_peak_db', '225°, peak dB', MINIMISE, '225°'],

  ['weight_oz', 'weight, oz', MINIMISE, 'Size'],
  ['length_in', 'length, in', MINIMISE, 'Size'],
  ['max_diameter_in', 'max diameter, in', MINIMISE, 'Size'],
  ['vol_cuin', 'volume, cu in', MINIMISE, 'Size'],

  // Conditions the test was run under rather than properties of the
  // suppressor, so none is an objective -- you control for a barrel length,
  // you do not minimise it.
  ['host_barrel_in', 'host barrel, in', null, 'Test conditions'],
  ['host_grains', 'bullet, grains', null, 'Test conditions'],
  ['year', 'year', null, 'Test conditions'],
];
const MEASURE_LABEL = new Map(MEASURES.map(([key, label]) => [key, label]));
const BETTER = new Map(MEASURES.map(([key, , better]) => [key, better]));

const MEASURE_GROUP = new Map(MEASURES.map(([key, , , group]) => [key, group]));

/** The part of a label the group heading above it does not already say. */
function shortLabel(label, group) {
  const prefix = `${group.toLowerCase()}, `;
  return label.toLowerCase().startsWith(prefix) ? label.slice(prefix.length) : label;
}

/**
 * Short names in the open list, the full name on whichever option is selected.
 *
 * A closed `select` shows only its selected option, with no group heading above
 * it to say which mic that was -- and X and Y are frequently the same measure
 * at two different mics, so "peak dBA" on both would be worse than useless.
 * There is no way to style the two states apart, so the text moves instead.
 */
function syncAxisLabels(select) {
  for (const option of select.options) {
    const full = MEASURE_LABEL.get(option.value);
    if (!full) continue; // the Z axis's "(none)"
    option.textContent = option.selected
      ? full
      : shortLabel(full, MEASURE_GROUP.get(option.value));
  }
}

/** How to say a direction in a sentence. */
const comparative = (key) => (BETTER.get(key) === MAXIMISE ? 'higher' : 'lower');

// [key, header, numeric, optional] -- optional columns are hidden by CSS on a
// narrow screen rather than forcing a twelve-column horizontal scroll.
const TABLE_COLUMNS = [
  ['year', 'Year', true, false],
  ['manufacturer', 'Maker', false, false],
  ['suppressor', 'Model', false, false],
  ['caliber', 'Cal', false, true],
  ['cartridge', 'Host', false, true],
  ['se_peak_dba', 'SE dBA', true, false],
  ['se_peak_db', 'SE dB', true, true],
  ['se_peak_leq10ms_dba', 'SE Leq', true, true],
  ['ml_peak_db', 'ML dB', true, true],
  ['weight_oz', 'oz', true, false],
  ['length_in', 'in', true, true],
  ['vol_cuin', 'cu in', true, true],
];
const MAX_TABLE_ROWS = 400;

const state = {
  bundle: null,
  mask: null,
  visible: [],
  frontier: new Set(),
  selectedRun: null,
  selectedWaveform: null,
  envelopes: null,
  sort: { column: 'se_peak_dba', direction: 1 },
  frontierFirst: true,
  hover: null,
  /**
   * The run whose readout was summoned by a tap or click, as opposed to hover.
   * A hover readout follows the cursor and dies with it; a pinned one stays put
   * and needs dismissing, so it carries a close button. Distinct from
   * `selectedRun`: dismissing the readout must not throw away the traces the
   * click loaded.
   */
  pinned: null,
  filtersOpen: false,
  zKey: null,
  view: { ...DEFAULT_VIEW_INIT },

  /**
   * The waveform card's own view state.
   *
   * `view` is the reader's zoom and holds until they clear it; `auto` is the
   * framing the run was opened with. Keeping them apart is what lets a change
   * of shot redraw without throwing away a zoom, while a change of *run* --
   * whose shot arrives at a different millisecond -- reframes.
   */
  wave: {
    view: null, // [t0, t1] ms, or null to use `auto`
    auto: null, // [t0, t1] ms derived from the run's envelopes
    full: null, // [t0, t1] ms, the whole stored window
    hover: null, // ms under the cursor
    pinned: null, // ms of a tapped or clicked readout
    record: null, // full-rate samples and analysis for the selected shot
    box: null, // plot rectangle of the last paint, for hit-testing
    lastX: null, // where the readout was last summoned, for placing it
    lastY: null,
  },
};

/* ------------------------------------------------------------------ helpers */

const css = (name) => getComputedStyle(document.body).getPropertyValue(name).trim();

/** Standard error of a published mean, if the per-shot figures give one. */
function semOf(key, index) {
  const column = state.bundle.catalog.columns[`${key}_sem`];
  if (!column) return null;
  const value = column[index];
  return Number.isNaN(value) ? null : value;
}

/**
 * Whether two means are closer together than the measurement can resolve.
 *
 * Two-sample, so the errors add in quadrature; 2 sigma is deliberately
 * conservative because the failure this prevents is reading a 0.2 dB gap as a
 * ranking.
 */
function indistinguishable(aMean, aSem, bMean, bSem, sigma = 2) {
  if (aSem === null || bSem === null) return false;
  return Math.abs(aMean - bMean) < sigma * Math.hypot(aSem, bSem);
}

function fmt(value, digits = 2) {
  return value === null || Number.isNaN(value) ? '—' : value.toFixed(digits);
}

/**
 * A readable name for a host code.
 *
 * The codes are prose in each year's report rather than anything in all.csv,
 * so `publish` ships the transcription and this reads it. An undocumented code
 * falls back to itself rather than inventing a name.
 */
function hostLabel(code) {
  return state.bundle?.catalog.hosts?.[code]?.label ?? String(code);
}

/**
 * TBAC's own warning about a run's numbers, if there is one.
 *
 * Published in report prose rather than the CSV, so a tool built on the CSV
 * alone would rank suppressors on figures TBAC says to disregard.
 */
function caveatFor(index) {
  const { catalog } = state.bundle;
  const code = catalog.columns.caveat?.[index];
  return code === undefined || code < 0
    ? null
    : catalog.dictionaries.caveat[code] ?? null;
}

function hostDescription(code) {
  return state.bundle?.catalog.hosts?.[code]?.description ?? null;
}

function runLabel(index) {
  const c = state.bundle.catalog;
  const maker = c.dictionaries.manufacturer[c.columns.manufacturer[index]];
  const model = c.dictionaries.suppressor[c.columns.suppressor[index]];
  return `${maker} ${model}`;
}

const NARROW = '(max-width: 720px)';
const isNarrow = () => window.matchMedia(NARROW).matches;

/** Plot heights shrink on a phone so a chart still fits a screen. */
const PLOT_HEIGHTS = {
  scatter: [420, 300],
  spectrum: [170, 140],
  wave: [300, 210],
  impulse: [150, 120],
  leq: [150, 120],
};

/** Size a canvas to its layout box at device pixel ratio. */
function prepare(canvas) {
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const sizes = PLOT_HEIGHTS[canvas.id];
  const height = sizes ? sizes[isNarrow() ? 1 : 0] : Number(canvas.getAttribute('height'));
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return { ctx, width, height };
}

/** Nice round tick positions covering [lo, hi]. */
function ticks(lo, hi, count = 5) {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= raw) ?? magnitude * 10;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(v);
  return out;
}

/**
 * Axes, hairline grid and labels shared by every plot here.
 * Gridlines and rules are solid hairlines one shade off the surface.
 */
function axes(ctx, box, xDomain, yDomain, xLabel, yLabel, xDigits = 0, yDigits = 0) {
  const { left, top, right, bottom } = box;
  ctx.save();
  ctx.font = '11px system-ui, -apple-system, "Segoe UI", sans-serif';
  ctx.lineWidth = 1;

  const xs = ticks(xDomain[0], xDomain[1]);
  const ys = ticks(yDomain[0], yDomain[1]);
  const px = (v) => left + ((v - xDomain[0]) / (xDomain[1] - xDomain[0])) * (right - left);
  const py = (v) => bottom - ((v - yDomain[0]) / (yDomain[1] - yDomain[0])) * (bottom - top);

  ctx.strokeStyle = css('--grid');
  ctx.beginPath();
  for (const v of ys) {
    const y = Math.round(py(v)) + 0.5;
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
  }
  for (const v of xs) {
    const x = Math.round(px(v)) + 0.5;
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
  }
  ctx.stroke();

  ctx.strokeStyle = css('--axis');
  ctx.beginPath();
  ctx.moveTo(left, Math.round(bottom) + 0.5);
  ctx.lineTo(right, Math.round(bottom) + 0.5);
  ctx.stroke();

  ctx.fillStyle = css('--text-muted');
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const v of xs) ctx.fillText(v.toFixed(xDigits), px(v), bottom + 6);
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const v of ys) ctx.fillText(v.toFixed(yDigits), left - 7, py(v));

  ctx.fillStyle = css('--text-secondary');
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  ctx.fillText(xLabel, right, bottom + 30);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(yLabel, left - 44, top - 16);
  ctx.restore();
  return { px, py };
}

/* ------------------------------------------------------------------ filters */

function buildFacet(id, values, counts, describe = null) {
  const host = $(id);
  host.textContent = '';
  for (const value of values) {
    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.value = value;
    box.addEventListener('change', refilter);

    const shown = describe ? describe(value) : String(value);
    label.append(
      box,
      document.createTextNode(counts ? `${shown} (${counts.get(value) ?? 0})` : shown),
    );
    // The raw code stays reachable, since it is what the report prints.
    if (describe && shown !== String(value)) label.title = String(value);
    host.append(label);
  }
}

const checked = (id) =>
  [...$(id).querySelectorAll('input:checked')].map((box) => box.value);

function numberOr(id, fallback) {
  const value = Number.parseFloat($(id).value);
  return Number.isFinite(value) ? value : fallback;
}

function currentSpec() {
  const spec = {};
  const years = checked('facet-year').map(Number);
  if (years.length) spec.year = [Math.min(...years), Math.max(...years)];

  for (const [column, id] of FACETS) {
    if (column === 'year') continue; // handled as a set below
    const picked = checked(id);
    if (picked.length) spec[column] = new Set(picked);
  }

  const weight = [numberOr('min-weight', null), numberOr('max-weight', null)];
  if (weight[0] !== null || weight[1] !== null) spec.weight_oz = weight;
  const length = [numberOr('min-length', null), numberOr('max-length', null)];
  if (length[0] !== null || length[1] !== null) spec.length_in = length;
  return spec;
}

const FACETS = [
  ['year', 'facet-year', 'count-year'],
  ['caliber', 'facet-caliber', 'count-caliber'],
  ['cartridge', 'facet-cartridge', 'count-cartridge'],
  ['manufacturer', 'facet-manufacturer', 'count-manufacturer'],
  ['host_cycling', 'facet-host_cycling', 'count-host_cycling'],
  ['host_ammo', 'facet-host_ammo', 'count-host_ammo'],
];

/**
 * Show how many boxes are ticked per dimension, and in total on the collapsed
 * toggle -- otherwise a phone user cannot tell a filtered view from a full one.
 */
function updateFilterBadges() {
  let total = 0;
  for (const [, facetId, countId] of FACETS) {
    const count = checked(facetId).length;
    total += count;
    const badge = $(countId);
    badge.textContent = String(count);
    badge.hidden = count === 0;
  }
  for (const id of ['q', 'min-weight', 'max-weight', 'min-length', 'max-length']) {
    if ($(id).value.trim()) total++;
  }
  if ($('baselines').value !== 'hide') total++;

  const badge = $('filter-count');
  badge.textContent = String(total);
  badge.hidden = total === 0;
}

function refilter() {
  const { catalog } = state.bundle;
  const spec = currentSpec();

  // A multi-year selection is not a range, so apply years as a set test after
  // the generic pass rather than pretending [min,max] covers it.
  let mask = selection(catalog, spec);

  const years = checked('facet-year').map(Number);
  if (years.length) {
    const allowed = new Set(years);
    for (let i = 0; i < catalog.n; i++) {
      if (mask[i] && !allowed.has(catalog.columns.year[i])) mask[i] = 0;
    }
  }

  const baselines = $('baselines').value;
  if (baselines !== 'show') {
    const want = baselines === 'only' ? 1 : 0;
    for (let i = 0; i < catalog.n; i++) {
      if (mask[i] && catalog.columns.is_baseline[i] !== want) mask[i] = 0;
    }
  }

  const query = $('q').value.trim().toLowerCase();
  if (query) {
    for (let i = 0; i < catalog.n; i++) {
      if (mask[i] && !runLabel(i).toLowerCase().includes(query)) mask[i] = 0;
    }
  }

  state.mask = mask;
  state.visible = maskRows(catalog, mask);

  // Each measure knows which way is better, so there is nothing to configure.
  // Axes that are dimensions rather than objectives -- year, host barrel --
  // drop out of the frontier instead of cancelling it, so plotting against one
  // still answers "which of these is not beaten on the rest".
  const active = [$('axis-x').value, $('axis-y').value];
  if (state.zKey) active.push(state.zKey);
  const objectives = active.filter((key) => BETTER.get(key));
  const dimensions = active.filter((key) => !BETTER.get(key));

  // Restrict to rows the chart can actually draw, so the ringed points, the
  // tile count and the table all agree. A run with no recorded barrel is not
  // on this plot, so it is not "on this plot's frontier" either.
  const plottable = Uint8Array.from(mask);
  for (const key of active) {
    const column = catalog.columns[key];
    for (let i = 0; i < catalog.n; i++) {
      if (plottable[i] && Number.isNaN(column[i])) plottable[i] = 0;
    }
  }

  state.frontier = objectives.length
    ? new Set(
        paretoFront(
          catalog,
          objectives.map((key) => ({ column: key, direction: BETTER.get(key) })),
          plottable,
        ),
      )
    : new Set();

  const phrase = objectives
    .map((key) => `a ${comparative(key)} ${MEASURE_LABEL.get(key)}`)
    .join(', ');
  const ignored = dimensions.map((key) => MEASURE_LABEL.get(key)).join(' and ');
  $('scatter-hint').textContent = objectives.length
    ? 'Points are test runs. Ringed points are on the Pareto frontier — nothing '
      + `shown has all of ${phrase}.`
      + (ignored
        ? ` ${ignored} ${dimensions.length > 1 ? 'are dimensions' : 'is a dimension'},`
          + ' so it does not constrain the frontier.'
        : '')
    : `Points are test runs. No frontier here: ${ignored} `
      + `${dimensions.length > 1 ? 'are dimensions' : 'is a dimension'}, `
      + 'not something to optimise.';

  updateFilterBadges();
  renderTiles();
  renderScatter();
  renderTable();
}

/* -------------------------------------------------------------------- tiles */

function renderTiles() {
  const { catalog } = state.bundle;
  const makers = new Set();
  let withWaveforms = 0;
  for (const i of state.visible) {
    makers.add(catalog.columns.manufacturer[i]);
    if (catalog.columns.waveform_count[i] > 0) withWaveforms++;
  }
  const tiles = [
    [state.visible.length.toLocaleString(), 'runs shown'],
    [String(state.frontier.size), 'on the frontier'],
    [String(makers.size), 'manufacturers'],
    [withWaveforms.toLocaleString(), 'with waveforms'],
  ];
  $('tiles').innerHTML = tiles
    .map(([value, label]) => `<div class="tile"><div class="value">${value}</div><div class="label">${label}</div></div>`)
    .join('');
}

/* ------------------------------------------------------------------ scatter */

let scatterPoints = [];

/** Smallest and largest actual values of a column over the visible rows. */
function range(values, rows) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const i of rows) {
    if (values[i] < lo) lo = values[i];
    if (values[i] > hi) hi = values[i];
  }
  return [lo, hi];
}

/** The same, padded so marks do not sit on the frame. */
function extent(values, rows) {
  const [lo, hi] = range(values, rows);
  const span = hi - lo || Math.abs(hi) || 1;
  return [lo - span * 0.06, hi + span * 0.06];
}

/**
 * Draw text with a surface-coloured halo.
 *
 * A 3D axis label has no margin to live in -- the cloud is behind it wherever
 * it goes -- so it gets an outline in the surface colour instead of being
 * moved somewhere it no longer points at.
 */
function haloText(ctx, text, x, y) {
  ctx.lineJoin = 'round';
  ctx.lineWidth = 3;
  ctx.strokeStyle = css('--surface-1');
  ctx.strokeText(text, x, y);
  ctx.fillText(text, x, y);
}

/**
 * Orthographic projection of a unit cube, yawed then pitched.
 *
 * Returns screen offsets plus a depth, so points can be drawn back to front
 * and dimmed with distance -- without that the cloud reads as flat.
 */
function project(x, y, z, view) {
  const cy = Math.cos(view.yaw);
  const sy = Math.sin(view.yaw);
  const cp = Math.cos(view.pitch);
  const sp = Math.sin(view.pitch);
  const rx = x * cy + z * sy;
  const rz = -x * sy + z * cy;
  return { x: rx, y: y * cp - rz * sp, depth: y * sp + rz * cp };
}

const CUBE_EDGES = [
  [0, 1], [1, 3], [3, 2], [2, 0],
  [4, 5], [5, 7], [7, 6], [6, 4],
  [0, 4], [1, 5], [2, 6], [3, 7],
];
const CUBE_CORNERS = [
  [-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [-0.5, 0.5, -0.5], [0.5, 0.5, -0.5],
  [-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [-0.5, 0.5, 0.5], [0.5, 0.5, 0.5],
];

function renderScatter() {
  const canvas = $('scatter');
  const { ctx, width, height } = prepare(canvas);
  const { catalog } = state.bundle;
  const xKey = $('axis-x').value;
  const yKey = $('axis-y').value;
  const zKey = state.zKey;

  const columns = [catalog.columns[xKey], catalog.columns[yKey]];
  if (zKey) columns.push(catalog.columns[zKey]);
  const usable = state.visible.filter((i) => columns.every((c) => !Number.isNaN(c[i])));

  scatterPoints = [];
  canvas.classList.toggle('rotatable', Boolean(zKey));
  if (!usable.length) {
    ctx.fillStyle = css('--text-muted');
    ctx.font = '13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No runs match these filters.', width / 2, height / 2);
    syncPinned(); // nothing left to anchor to
    return;
  }

  if (zKey) renderScatter3D(ctx, width, height, usable, [xKey, yKey, zKey]);
  else renderScatter2D(ctx, width, height, usable, [xKey, yKey]);

  if (state.hover !== null) {
    const point = scatterPoints.find((p) => p.i === state.hover);
    if (point) {
      ctx.beginPath();
      ctx.arc(point.x, point.y, 9, 0, Math.PI * 2);
      ctx.strokeStyle = css('--series-1');
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  // Points move when the slice changes; a pinned readout follows its own.
  syncPinned();
}

/**
 * Draw one point.
 *
 * The frontier is an outline in the series hue and everything else an outline
 * in muted ink; a *filled* mark means selected, and nothing else. Emphasis
 * rather than identity, so filtering never repaints a survivor.
 */
function drawPoint(ctx, x, y, { frontier, selected, scale = 1, alpha = 1 }) {
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.arc(x, y, (selected ? 6 : frontier ? 4.5 : 3) * scale, 0, Math.PI * 2);
  if (selected) {
    ctx.fillStyle = css('--series-2');
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = css('--surface-1');
    ctx.stroke();
  } else {
    ctx.strokeStyle = css(frontier ? '--series-1' : '--dot-strong');
    ctx.lineWidth = frontier ? 2 : 1.2;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

const axisDigits = (key) =>
  key === 'year' ? 0 : key.includes('_in') || key === 'weight_oz' ? 1 : 0;

function renderScatter2D(ctx, width, height, usable, [xKey, yKey]) {
  const { catalog } = state.bundle;
  const xs = catalog.columns[xKey];
  const ys = catalog.columns[yKey];
  const box = { left: 54, top: 22, right: width - 12, bottom: height - 34 };
  const { px, py } = axes(
    ctx, box, extent(xs, usable), extent(ys, usable),
    MEASURE_LABEL.get(xKey), MEASURE_LABEL.get(yKey),
    axisDigits(xKey), axisDigits(yKey),
  );

  // Error bars first, so marks sit on top of them. Only drawn when the plot
  // is sparse enough to read -- at 1000 points they are a grey fog.
  // Sparse is necessary but not sufficient: derived measures like net reduction
  // and spectral centroid carry no per-shot spread, so nothing gets drawn and
  // the legend must not claim otherwise.
  let bars = false;
  if (usable.length <= 220) {
    ctx.strokeStyle = css('--dot');
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const i of usable) {
      const x = px(xs[i]);
      const ySem = semOf(yKey, i);
      if (ySem) {
        ctx.moveTo(x, py(ys[i] - ySem));
        ctx.lineTo(x, py(ys[i] + ySem));
        bars = true;
      }
      const xSem = semOf(xKey, i);
      if (xSem) {
        const y = py(ys[i]);
        ctx.moveTo(px(xs[i] - xSem), y);
        ctx.lineTo(px(xs[i] + xSem), y);
        bars = true;
      }
    }
    ctx.stroke();
  }
  $('bar-legend').hidden = !bars;

  for (const i of usable) {
    const x = px(xs[i]);
    const y = py(ys[i]);
    scatterPoints.push({ i, x, y });
    drawPoint(ctx, x, y, {
      frontier: state.frontier.has(i),
      selected: state.selectedRun === i,
    });
  }
  state.showingBars = bars;
}

function renderScatter3D(ctx, width, height, usable, keys) {
  // A bar along one of three projected axes reads as a stray line segment, so
  // the 3D view has none -- and must not keep the 2D view's legend entry.
  state.showingBars = false;
  $('bar-legend').hidden = true;
  const { catalog } = state.bundle;
  const cols = keys.map((k) => catalog.columns[k]);
  const domains = cols.map((c) => extent(c, usable));
  const ranges = cols.map((c) => range(c, usable));
  const unit = (value, [lo, hi]) => (value - lo) / (hi - lo) - 0.5;

  const centreX = width / 2;
  const centreY = height / 2 - 6;
  const scale = Math.min(width, height) * 0.62;
  const toScreen = (p) => ({ x: centreX + p.x * scale, y: centreY - p.y * scale });

  // Cube first, so points sit on top of the frame.
  const corners = CUBE_CORNERS.map(([x, y, z]) =>
    toScreen(project(x, y, z, state.view)),
  );
  ctx.strokeStyle = css('--grid');
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const [a, b] of CUBE_EDGES) {
    ctx.moveTo(corners[a].x, corners[a].y);
    ctx.lineTo(corners[b].x, corners[b].y);
  }
  ctx.stroke();

  // One label per axis, at the midpoint of a leading edge, with its range.
  ctx.font = '11px system-ui, -apple-system, "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const axisEdges = [
    [0, 1, 0], // x along the bottom front edge
    [0, 2, 1], // y up the left front edge
    [0, 4, 2], // z into the scene
  ];
  for (const [a, b, axis] of axisEdges) {
    const mid = {
      x: (corners[a].x + corners[b].x) / 2,
      y: (corners[a].y + corners[b].y) / 2,
    };
    const away = {
      x: mid.x - centreX,
      y: mid.y - centreY,
    };
    const length = Math.hypot(away.x, away.y) || 1;
    const lx = mid.x + (away.x / length) * 34;
    const ly = mid.y + (away.y / length) * 34;
    ctx.fillStyle = css('--text-secondary');
    haloText(ctx, MEASURE_LABEL.get(keys[axis]), lx, ly);
    // Quote the data's own range, not the padded drawing domain -- padding a
    // weight down to -1.8 oz reads as a measurement, and it is not one.
    ctx.fillStyle = css('--text-muted');
    const [lo, hi] = ranges[axis];
    const digits = axisDigits(keys[axis]);
    haloText(ctx, `${lo.toFixed(digits)} → ${hi.toFixed(digits)}`, lx, ly + 13);
  }

  // Painter's algorithm: far points first, dimmer and smaller.
  const projected = usable.map((i) => {
    const p = project(
      unit(cols[0][i], domains[0]),
      unit(cols[1][i], domains[1]),
      unit(cols[2][i], domains[2]),
      state.view,
    );
    const screen = toScreen(p);
    return { i, x: screen.x, y: screen.y, depth: p.depth };
  });
  projected.sort((a, b) => a.depth - b.depth);

  for (const point of projected) {
    scatterPoints.push(point);
    // depth runs about -0.87..0.87 for a unit cube; map to a gentle cue.
    const near = (point.depth + 0.9) / 1.8;
    drawPoint(ctx, point.x, point.y, {
      frontier: state.frontier.has(point.i),
      selected: state.selectedRun === point.i,
      scale: 0.78 + near * 0.44,
      alpha: 0.45 + near * 0.55,
    });
  }
}

/**
 * Fill and place the scatter tooltip.
 *
 * Names come from the published bundle, which is ultimately somebody's CSV, so
 * they are inserted as text and never as markup.
 */
function showTooltip(tip, canvas, point, pinned = false) {
  const { catalog } = state.bundle;
  const i = point.i;
  const xKey = $('axis-x').value;
  const yKey = $('axis-y').value;
  const dict = (name) => catalog.dictionaries[name][catalog.columns[name][i]] ?? '—';

  tip.textContent = '';
  tip.classList.toggle('pinned', pinned);
  // A hover readout is dismissed by moving the cursor. A pinned one has no such
  // gesture -- on touch there is no cursor at all -- so it gets a real control.
  if (pinned) {
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'tip-close';
    close.setAttribute('aria-label', 'Dismiss readout');
    close.textContent = '×';
    tip.append(close);
  }
  const title = document.createElement('strong');
  title.textContent = runLabel(i);
  const code = dict('cartridge');
  const context = document.createElement('div');
  context.className = 'dim';
  context.textContent =
    `${dict('caliber')} on ${hostLabel(code)} · ${catalog.columns.year[i]}`;
  tip.append(title, context);

  const description = hostDescription(code);
  if (description) {
    const gun = document.createElement('div');
    gun.className = 'dim';
    const host = state.bundle.catalog.hosts?.[code] ?? {};
    // Say when a barrel length is the model's published spec rather than
    // something TBAC wrote down, so it is not mistaken for a measurement.
    const barrel =
      host.barrel_source === 'model' ? ` (${host.barrel_in}" barrel, model spec)` : '';
    gun.textContent = description + barrel;
    tip.append(gun);
  }

  const keys = [xKey, yKey];
  if (state.zKey) keys.push(state.zKey);
  for (const key of keys) {
    const line = document.createElement('div');
    line.append(document.createTextNode(`${MEASURE_LABEL.get(key)}: `));
    const value = document.createElement('strong');
    value.textContent = fmt(catalog.columns[key][i]);
    line.append(value);
    const sem = semOf(key, i);
    if (sem !== null) {
      const error = document.createElement('span');
      error.className = 'dim';
      error.textContent = ` ± ${sem.toFixed(2)}`;
      line.append(error);
    }
    tip.append(line);
  }

  // The point of the error bars: say how many other runs on screen this one
  // cannot actually be separated from.
  const ySem = semOf(yKey, i);
  if (ySem !== null) {
    const column = catalog.columns[yKey];
    let ties = 0;
    for (const j of state.visible) {
      if (j !== i && indistinguishable(column[i], ySem, column[j], semOf(yKey, j))) {
        ties++;
      }
    }
    const note = document.createElement('div');
    note.className = 'dim';
    note.textContent = ties
      ? `${ties} shown run${ties === 1 ? '' : 's'} not distinguishable from this`
      : 'separable from every run shown';
    tip.append(note);
  }
  const caveat = caveatFor(i);
  if (caveat) {
    const warn = document.createElement('div');
    warn.className = 'warn';
    warn.textContent = `⚠ ${caveat}`;
    tip.append(warn);
  }
  if (state.frontier.has(i)) {
    const note = document.createElement('div');
    note.className = 'dim';
    note.textContent = 'on the frontier';
    tip.append(note);
  }

  tip.hidden = false;
  const wrap = canvas.parentElement.getBoundingClientRect();
  tip.style.left = `${Math.max(4, Math.min(point.x + 14, wrap.width - tip.offsetWidth - 6))}px`;
  tip.style.top = `${Math.max(4, Math.min(point.y - 10, wrap.height - tip.offsetHeight - 4))}px`;
}

/**
 * Put the readout away without touching the selection.
 *
 * Changing an axis moves every point, so a readout anchored to where a point
 * used to be is pointing at nothing. The traces below it are still the ones the
 * reader asked for, though, so the selection survives.
 */
function dismissTooltip() {
  state.pinned = null;
  const tip = $('scatter-tip');
  tip.hidden = true;
  tip.classList.remove('pinned');
}

/**
 * Re-anchor a pinned readout after the plot redraws, or drop it if its run left
 * the slice. Hover owns the readout while the cursor is over a point, so this
 * stays out of the way until the cursor is gone.
 */
function syncPinned() {
  if (state.pinned === null || state.hover !== null) return;
  const point = scatterPoints.find((p) => p.i === state.pinned);
  if (point) showTooltip($('scatter-tip'), $('scatter'), point, true);
  else dismissTooltip();
}

function nearestPoint(event) {
  const rect = $('scatter').getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  let best = null;
  const reach = isNarrow() ? 34 : 26; // generous hit area, not a pinpoint target
  let bestDistance = reach * reach;
  for (const point of scatterPoints) {
    const distance = (point.x - x) ** 2 + (point.y - y) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = point;
    }
  }
  return best;
}

function bindScatter() {
  const canvas = $('scatter');
  const tip = $('scatter-tip');

  // The close button lives inside the readout, which is redrawn from scratch on
  // every hover, so the listener goes on the container once rather than on a
  // button that will not exist a moment later.
  tip.addEventListener('click', (event) => {
    if (!event.target.closest('.tip-close')) return;
    dismissTooltip();
    renderScatter();
  });

  // Touch has no hover, so a tap does both jobs: it selects the run and pins
  // the readout, which then stays until it is dismissed.
  canvas.addEventListener('pointerup', (event) => {
    if (event.pointerType !== 'touch') return;
    if (bindRotation.isDragging?.()) return;
    const point = nearestPoint(event);
    if (!point) {
      dismissTooltip();
      return;
    }
    state.pinned = point.i;
    showTooltip(tip, canvas, point, true);
    selectRun(point.i);
  });

  canvas.addEventListener('pointermove', (event) => {
    if (event.pointerType === 'touch' || bindRotation.isDragging?.()) return;
    const point = nearestPoint(event);
    state.hover = point ? point.i : null;
    if (point) showTooltip(tip, canvas, point, point.i === state.pinned);
    else if (state.pinned !== null) syncPinned();
    else tip.hidden = true;
    renderScatter();
  });

  canvas.addEventListener('pointerleave', (event) => {
    // A touch pointer is destroyed on lift, which fires pointerleave straight
    // after the tap; a pinned readout has to outlive that.
    if (event.pointerType === 'touch') return;
    state.hover = null;
    if (state.pinned !== null) syncPinned();
    else tip.hidden = true;
    renderScatter();
  });

  canvas.addEventListener('click', (event) => {
    // Touch already handled this on pointerup, and a drag is not a click.
    if (event.pointerType === 'touch') return;
    if (bindRotation.isDragging?.()) return;
    const point = nearestPoint(event);
    if (!point) {
      dismissTooltip();
      return;
    }
    state.pinned = point.i;
    showTooltip(tip, canvas, point, true);
    selectRun(point.i);
  });
}

/* -------------------------------------------------------------------- table */

function renderTable() {
  const { catalog } = state.bundle;
  const head = $('table-head');
  head.textContent = '';
  for (const [key, label, numeric, optional] of TABLE_COLUMNS) {
    const th = document.createElement('th');
    th.scope = 'col';
    if (numeric) th.className = 'num';
    if (optional) th.dataset.optional = '';
    th.dataset.key = key;
    th.textContent =
      label + (state.sort.column === key ? (state.sort.direction > 0 ? ' ▲' : ' ▼') : '');
    th.addEventListener('click', () => {
      state.sort = {
        column: key,
        direction: state.sort.column === key ? -state.sort.direction : 1,
      };
      renderTable();
    });
    head.append(th);
  }

  const key = state.sort.column;
  const column = catalog.columns[key];
  const dictionary = catalog.dictionaries[key];

  /** The chosen column, ignoring the frontier grouping. */
  const byColumn = (a, b) => {
    let left = column[a];
    let right = column[b];
    if (dictionary) {
      left = key === 'cartridge' ? hostLabel(dictionary[left] ?? '') : dictionary[left] ?? '';
      right = key === 'cartridge' ? hostLabel(dictionary[right] ?? '') : dictionary[right] ?? '';
      return state.sort.direction * String(left).localeCompare(String(right));
    }
    // A missing value sorts last either way; it is not a small number.
    if (Number.isNaN(left)) return 1;
    if (Number.isNaN(right)) return -1;
    return state.sort.direction * (left - right);
  };

  const order = [...state.visible].sort((a, b) => {
    if (state.frontierFirst) {
      const rank = Number(state.frontier.has(b)) - Number(state.frontier.has(a));
      if (rank) return rank;
    }
    return byColumn(a, b);
  });

  const shown = order.slice(0, MAX_TABLE_ROWS);
  const flagged = state.visible.filter((i) => caveatFor(i)).length;
  const warning = flagged
    ? `${flagged} run${flagged === 1 ? '' : 's'} shown carry a TBAC advisory (⚠), `
      + 'hover for it. '
    : '';
  const grouped =
    state.frontierFirst && state.frontier.size
      ? `Frontier runs first (${state.frontier.size}), then ${MEASURE_LABEL.get(key) ?? key}. `
      : '';
  $('table-hint').textContent =
    `The table view: every value on the chart, readable without colour. ${warning}${grouped}` +
    (shown.length < order.length
      ? `Showing the first ${shown.length} of ${order.length} matching runs — narrow the filters to see the rest.`
      : '');

  const body = $('table-body');
  body.textContent = '';
  for (const i of shown) {
    const tr = document.createElement('tr');
    if (state.frontier.has(i)) tr.className = 'frontier';
    const caveat = caveatFor(i);
    if (caveat) {
      tr.classList.add('caveated');
      tr.title = `⚠ ${caveat}`;
    }
    if (state.selectedRun === i) tr.setAttribute('aria-selected', 'true');
    tr.addEventListener('click', () => selectRun(i));

    for (const [columnKey, , numeric, optional] of TABLE_COLUMNS) {
      const td = document.createElement('td');
      if (numeric) td.className = 'num';
      if (optional) td.dataset.optional = '';
      const dict = catalog.dictionaries[columnKey];
      const raw = catalog.columns[columnKey][i];
      if (dict) {
        const value = dict[raw] ?? '—';
        td.textContent = columnKey === 'cartridge' ? hostLabel(value) : value;
        if (columnKey === 'cartridge') td.title = value;
      } else {
        td.textContent = columnKey === 'year' ? String(raw) : fmt(raw);
      }
      tr.append(td);
    }
    body.append(tr);
  }
}

/* ---------------------------------------------------------------- waveforms */

/**
 * Spectra live in their own file and are only fetched when something needs to
 * draw one, so they cost nothing on first load.
 */
async function loadBands(bundle) {
  if (bundle.bands !== undefined) return bundle.bands;
  try {
    const version = bundle.version ?? '';
    bundle.bands = await (await fetch(`${bundle.baseUrl}/bands.json${version}`)).json();
  } catch {
    bundle.bands = null; // published without a band pass
  }
  return bundle.bands;
}

async function renderSpectrum(runId) {
  const wrap = $('spectrum-wrap');
  const bands = await loadBands(state.bundle);
  const spectra = bands?.runs?.[String(runId)];
  if (!spectra) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;

  const { ctx, width, height } = prepare($('spectrum'));
  const centres = bands.centres;
  const mics = Object.keys(spectra).sort();

  // Proportional-bandwidth bands get wider as they climb -- the 20 kHz band is
  // 500x the width of the 40 Hz one -- so a plot of raw band levels rises about
  // 1 dB per band on a spectrally flat signal and reads as "it's all treble"
  // regardless of content. Dividing out the width gives energy per Hz, which is
  // the shape a reader thinks they are looking at. The stored levels are
  // untouched: low_frequency_db and the like are energy sums and want widths in.
  const WIDTH_RATIO = 2 ** (1 / 6) - 2 ** (-1 / 6);
  const perHz = (value, index) =>
    value === null ? null : value - 10 * Math.log10(centres[index] * WIDTH_RATIO);
  const density = new Map(mics.map((mic) => [mic, spectra[mic].map(perHz)]));

  let lo = Infinity;
  let hi = -Infinity;
  for (const mic of mics) {
    for (const value of density.get(mic)) {
      if (value === null) continue;
      if (value < lo) lo = value;
      if (value > hi) hi = value;
    }
  }
  if (!(hi > lo)) { wrap.hidden = true; return; }

  const box = { left: 46, top: 16, right: width - 12, bottom: height - 32 };
  // Log frequency: a third-octave scale is geometric, so equal spacing here
  // means equal spacing on screen.
  const logs = centres.map(Math.log10);
  const { py } = axes(
    ctx, box, [logs[0], logs.at(-1)], [lo - 4, hi + 4],
    'frequency, Hz', 'energy density, dB per Hz', 0, 0,
  );
  // Redraw x labels as frequencies rather than logarithms.
  ctx.fillStyle = css('--surface-1');
  ctx.fillRect(box.left - 30, box.bottom + 2, width, 16);
  ctx.fillStyle = css('--text-muted');
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const px = (l) =>
    box.left + ((l - logs[0]) / (logs.at(-1) - logs[0])) * (box.right - box.left);
  for (const f of [31.5, 125, 500, 2000, 8000]) {
    ctx.fillText(f >= 1000 ? `${f / 1000}k` : String(f), px(Math.log10(f)), box.bottom + 6);
  }

  for (const mic of mics) {
    ctx.beginPath();
    ctx.strokeStyle = css(MIC_COLOR[mic] ?? '--series-1');
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    let started = false;
    density.get(mic).forEach((value, index) => {
      if (value === null) return;
      const x = px(logs[index]);
      const y = py(value);
      if (started) ctx.lineTo(x, y);
      else { ctx.moveTo(x, y); started = true; }
    });
    ctx.stroke();
  }

  const legend = $('spectrum-legend');
  legend.textContent = '';
  for (const mic of mics) {
    const item = document.createElement('span');
    item.className = 'item';
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = `var(${MIC_COLOR[mic] ?? '--series-1'})`;
    item.append(swatch, document.createTextNode(mic));
    legend.append(item);
  }
}

/** A quiet centred message on an otherwise empty plot. */
function drawPlaceholder(canvas, message) {
  const { ctx, width, height } = prepare(canvas);
  ctx.fillStyle = css('--text-muted');
  ctx.font = '13px system-ui, -apple-system, "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(message, width / 2, height / 2);
}

const MIC_COLOR = { ML: '--series-1', MR: '--series-2', SE: '--series-3', 225: '--series-2' };

/* ------------------------------------------------------------- wave framing
 *
 * The stored analysis window runs 1 ms to 125 ms, but the rig pre-triggers and
 * every shot in the archive arrives between about 47 and 56 ms. Framing the
 * whole window therefore spends two fifths of the plot on guaranteed silence
 * and leaves the blast a handful of pixels wide. What is worth looking at is
 * the arrival, the peak a millisecond or two behind it, and the trough seven
 * to thirteen milliseconds after that -- so the card opens on that, and the
 * reader zooms out to the tail if they want it.
 */

const VIEW_LEAD_MS = 1.5; // shown ahead of the first arrival
const VIEW_SPAN_MS = 24; // holds the trough for ~95% of records; the rest widen on demand
const MIN_SPAN_MS = 0.05; // ~13 samples at 262 kHz; past this there is nothing left to resolve
const MARK_MARGIN_MS = 2; // breathing room when a view is widened to reach a marker

/** [start, end] of one record, in ms. */
function recordSpan(entry) {
  const t0 = state.bundle.waveforms.window_start_s * 1000;
  return [t0, t0 + entry.n * entry.dt * 1000];
}

/** The union of every record's span, in ms. Runs mix 99 ms and 124 ms windows. */
function fullSpan(records) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const record of records) {
    const [a, b] = recordSpan(record.entry);
    lo = Math.min(lo, a);
    hi = Math.max(hi, b);
  }
  return [lo, hi];
}

/**
 * Where the shot starts in one record, in ms, judged from the overview
 * envelope. The same 1 Pa trigger the published Leq search uses, at bucket
 * resolution -- which is coarse, but framing a view does not need better. A
 * record that never breaks 1 Pa (a very quiet can at the shooter's ear) falls
 * back to a fraction of its own peak so the framing still lands on the event.
 */
function envelopeTrigger(record) {
  const { values, buckets, entry } = record;
  const [t0, t1] = recordSpan(entry);
  const width = (t1 - t0) / buckets;
  let peak = 0;
  for (let b = 0; b < buckets; b++) peak = Math.max(peak, values[b * 2 + 1]);
  if (!(peak > 0)) return null;
  const threshold = Math.min(LEQ_TRIGGER_PA, peak * 0.2);
  for (let b = 0; b < buckets; b++) if (values[b * 2 + 1] > threshold) return t0 + b * width;
  return null;
}

/** Opening view for a run: from just before the earliest arrival across its mics. */
function autoWindow(records) {
  const [lo, hi] = fullSpan(records);
  let first = Infinity;
  for (const record of records) {
    const t = envelopeTrigger(record);
    if (t !== null) first = Math.min(first, t);
  }
  if (!Number.isFinite(first)) return [lo, hi];
  const start = Math.max(lo, first - VIEW_LEAD_MS);
  return [start, Math.min(hi, start + VIEW_SPAN_MS)];
}

const waveDomain = () => state.wave.view ?? state.wave.auto ?? [0, 1];

/**
 * Stretch the opening view to reach a figure that landed outside it.
 *
 * The trough sits 11 ms behind the shot for a median record but 29 ms behind
 * the slowest, so no fixed span holds every one. Rather than leave a marker
 * silently off the edge -- a plot that quietly omits the thing it is annotating
 * is worse than one that never annotated -- the run's own framing grows to fit
 * it. A view the reader set is theirs and is left alone.
 */
function widenAutoFor(times) {
  if (state.wave.view !== null || !state.wave.auto) return;
  let [lo, hi] = state.wave.auto;
  for (const t of times) {
    if (!Number.isFinite(t)) continue;
    lo = Math.min(lo, t - MARK_MARGIN_MS);
    hi = Math.max(hi, t + MARK_MARGIN_MS);
  }
  state.wave.auto = clampDomain([lo, hi]);
}

/** Hold a view inside the stored window, and refuse to zoom past the samples. */
function clampDomain([t0, t1]) {
  const [lo, hi] = state.wave.full ?? [t0, t1];
  let span = Math.min(Math.max(t1 - t0, MIN_SPAN_MS), hi - lo);
  let start = Math.min(Math.max(t0, lo), hi - span);
  return [start, start + span];
}

/** Adopt a view, or `null` to fall back to the run's own framing. */
function setWaveView(domain) {
  const next = domain === null ? null : clampDomain(domain);
  // Snapping back to exactly the auto window counts as not having zoomed, so
  // the reset control goes away rather than lingering with nothing to undo.
  state.wave.view = next;
  $('wave-reset').hidden = next === null;
  renderWave();
  renderDerived();
}

/* --------------------------------------------------------- wave decimation
 *
 * Every trace is reduced to one [min, max] pair per pixel column before it is
 * drawn. Min/max rather than every nth sample: a blast is a very short
 * excursion inside a long quiet record, so stride-sampling 262 kHz onto 600
 * pixels steps straight over the peak nearly every time. Keeping both extremes
 * per column makes the drawn shape an honest bound on what is underneath it.
 */

/**
 * Reduce a source of `count` elements spanning `[s0, s1]` ms to `cols` columns
 * over `domain`. `lo(i)` and `hi(i)` read one element. Columns with no element
 * under them are left unset, which is how a 99 ms record stops rather than
 * being stretched across a 124 ms axis.
 */
function decimate(count, s0, s1, lo, hi, domain, cols) {
  const outLo = new Float32Array(cols);
  const outHi = new Float32Array(cols);
  const seen = new Uint8Array(cols);
  const width = (s1 - s0) / count;
  const step = (domain[1] - domain[0]) / cols;
  for (let c = 0; c < cols; c++) {
    const a = domain[0] + c * step;
    let i0 = Math.floor((a - s0) / width);
    let i1 = Math.ceil((a + step - s0) / width);
    if (i1 <= 0 || i0 >= count) continue;
    i0 = Math.max(0, i0);
    i1 = Math.min(count, Math.max(i1, i0 + 1));
    let min = Infinity;
    let max = -Infinity;
    for (let i = i0; i < i1; i++) {
      // A derived curve can be undefined in places -- a running level is NaN
      // wherever the RMS is exactly zero -- so a gap has to stay a gap rather
      // than poisoning the column's extremes.
      const l = lo(i);
      const h = hi(i);
      if (l < min) min = l;
      if (h > max) max = h;
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) continue;
    outLo[c] = min;
    outHi[c] = max;
    seen[c] = 1;
  }
  return { lo: outLo, hi: outHi, seen };
}

function envelopeColumns(record, domain, cols) {
  const { values, buckets, entry } = record;
  const [s0, s1] = recordSpan(entry);
  return decimate(
    buckets, s0, s1, (i) => values[i * 2], (i) => values[i * 2 + 1], domain, cols,
  );
}

function sampleColumns(values, entry, domain, cols) {
  const [s0, s1] = recordSpan(entry);
  return decimate(values.length, s0, s1, (i) => values[i], (i) => values[i], domain, cols);
}

/** The across-shot min/max for one mic: the spread, as one shape. */
function micBand(group, domain, cols) {
  const lo = new Float32Array(cols).fill(Infinity);
  const hi = new Float32Array(cols).fill(-Infinity);
  const seen = new Uint8Array(cols);
  for (const record of group) {
    const part = envelopeColumns(record, domain, cols);
    for (let c = 0; c < cols; c++) {
      if (!part.seen[c]) continue;
      if (part.lo[c] < lo[c]) lo[c] = part.lo[c];
      if (part.hi[c] > hi[c]) hi[c] = part.hi[c];
      seen[c] = 1;
    }
  }
  return { lo, hi, seen };
}

/** Fill between `lo` and `hi`, breaking the path wherever the data stops. */
function fillBand(ctx, band, cols, py, colX) {
  for (let c = 0; c < cols; ) {
    if (!band.seen[c]) { c++; continue; }
    let end = c;
    while (end < cols && band.seen[end]) end++;
    ctx.beginPath();
    for (let i = c; i < end; i++) ctx.lineTo(colX(i), py(band.hi[i]));
    for (let i = end - 1; i >= c; i--) ctx.lineTo(colX(i), py(band.lo[i]));
    ctx.closePath();
    ctx.fill();
    c = end;
  }
}

/**
 * Draw a decimated trace: one continuous path that walks each column's
 * extremes.
 *
 * Continuous rather than a separate vertical per column, because detached
 * verticals read as a bar chart of unrelated values. Threading them keeps the
 * shape of the signal at any zoom, and once the reader is in far enough that a
 * column holds one sample the same path is simply the waveform.
 */
function strokeColumns(ctx, band, cols, py, colX) {
  ctx.beginPath();
  let open = false;
  for (let c = 0; c < cols; c++) {
    if (!band.seen[c]) { open = false; continue; }
    const x = colX(c);
    const top = py(band.hi[c]);
    const bottom = py(band.lo[c]);
    if (open) ctx.lineTo(x, top);
    else { ctx.moveTo(x, top); open = true; }
    // A column whose extremes coincide would stroke nothing, so give it a hair.
    ctx.lineTo(x, bottom === top ? bottom + 0.6 : bottom);
  }
  ctx.stroke();
}

/** One edge of a band: a plain line through a single value per column. */
function strokeSeries(ctx, values, seen, cols, py, colX) {
  ctx.beginPath();
  let open = false;
  for (let c = 0; c < cols; c++) {
    if (!seen[c]) { open = false; continue; }
    const x = colX(c);
    const y = py(values[c]);
    if (open) ctx.lineTo(x, y);
    else { ctx.moveTo(x, y); open = true; }
  }
  ctx.stroke();
}

/* -------------------------------------------------------------- wave render */

async function selectRun(index, { updateHash = true } = {}) {
  state.selectedRun = index;
  state.selectedWaveform = null;
  state.wave.record = null;
  // A new run arrives at a different millisecond, so a zoom carried over from
  // the last one would be pointing at the wrong part of the record.
  state.wave.view = null;
  state.wave.hover = null;
  state.wave.pinned = null;
  dismissWaveTip();
  $('wave-reset').hidden = true;
  // Deep link, so a particular run is shareable and reloadable.
  if (updateHash) {
    const id = state.bundle.catalog.ids[index];
    history.replaceState(null, '', `#run=${id}`);
  }
  renderScatter();
  renderTable();

  const { catalog } = state.bundle;
  const runId = catalog.ids[index];
  $('wave-title').textContent = runLabel(index);
  $('derived').hidden = true;
  $('shots').innerHTML = '';

  renderSpectrum(runId).catch((error) => console.error(error));

  if (!catalog.columns.waveform_count[index]) {
    state.envelopes = null;
    state.wave.auto = state.wave.full = null;
    $('wave-hint').textContent =
      'No waveforms for this run — a handful of runs across the release sets ' +
      'have no capture in the archive, either never recorded or set aside.';
    drawPlaceholder($('wave'), 'No waveforms released for this run');
    clearLegend($('wave-legend'));
    return;
  }

  $('wave-hint').textContent = 'Loading traces…';
  try {
    // One coalesced Range request for the whole run.
    state.envelopes = await fetchRunEnvelopes(state.bundle, runId);
  } catch (error) {
    $('wave-hint').textContent = `Could not load waveforms: ${error.message}`;
    return;
  }
  state.wave.full = fullSpan(state.envelopes);
  state.wave.auto = autoWindow(state.envelopes);
  describeWave();
  renderWave();
  renderShotButtons();
}

/** The line under the title: what is on screen, and how to move it. */
function describeWave() {
  const records = state.envelopes;
  if (!records) return;
  const selected = state.wave.record;
  const [t0, t1] = waveDomain();
  const [f0, f1] = state.wave.full;
  const framing = `${t0.toFixed(1)}–${t1.toFixed(1)} ms of the stored ` +
    `${f0.toFixed(0)}–${f1.toFixed(0)} ms window`;

  if (selected) {
    const { entry, analysis } = selected;
    $('wave-hint').textContent =
      `${entry.mic} shot ${entry.shot} at full rate, ${entry.n.toLocaleString()} samples · ` +
      `peak ${analysis.peak_pa.toFixed(1)} Pa (${analysis.peak_db.toFixed(2)} dB) · ` +
      `impulse ${analysis.impulse_pa_ms.toFixed(2)} Pa·ms · ` +
      `Leq(10ms) ${analysis.peak_leq10ms_dba.toFixed(2)} dBA. ` +
      `Showing ${framing}.` +
      (entry.overload ? ' DAQ flagged an overload on this record.' : '');
    return;
  }
  const shots = new Set(records.map((e) => e.entry.shot)).size;
  const mics = new Set(records.map((e) => e.entry.mic)).size;
  $('wave-hint').textContent =
    `${shots} shots × ${mics} mics as a min/max band per mic — the width of a ` +
    `band is the shot-to-shot spread. Showing ${framing}; scroll or pinch to ` +
    `zoom, drag to pan, pick a shot below for its full-rate trace.`;
}

function renderWave() {
  const canvas = $('wave');
  const { ctx, width, height } = prepare(canvas);
  const records = state.envelopes;
  if (!records || !records.length) return;

  const domain = waveDomain();
  const box = { left: 54, top: 20, right: width - 42, bottom: height - 34 };
  const cols = Math.max(1, Math.round(box.right - box.left));
  const colX = (c) => box.left + ((c + 0.5) / cols) * (box.right - box.left);
  state.wave.box = box;

  const byMic = new Map();
  for (const record of records) {
    if (!byMic.has(record.entry.mic)) byMic.set(record.entry.mic, []);
    byMic.get(record.entry.mic).push(record);
  }

  const bands = new Map();
  for (const [mic, group] of byMic) bands.set(mic, micBand(group, domain, cols));

  const selected = state.wave.record;
  const trace = selected
    ? sampleColumns(selected.values, selected.entry, domain, cols)
    : null;

  // Scale to what is on screen, not to the whole record. Keeping the full
  // record's range would undo the zoom: the peak is 20x the rest of the trace,
  // so anything but the peak stays pressed flat against the axis.
  let lo = Infinity;
  let hi = -Infinity;
  const consider = (band) => {
    for (let c = 0; c < cols; c++) {
      if (!band.seen[c]) continue;
      if (band.lo[c] < lo) lo = band.lo[c];
      if (band.hi[c] > hi) hi = band.hi[c];
    }
  };
  for (const band of bands.values()) consider(band);
  if (trace) consider(trace);
  if (!Number.isFinite(lo)) { lo = -1; hi = 1; }
  const span = hi - lo || 1;

  const { px, py } = axes(
    ctx, box, domain, [lo - span * 0.06, hi + span * 0.06],
    'time, ms', 'pressure, Pa', domain[1] - domain[0] < 5 ? 1 : 0, 0,
  );

  ctx.save();
  ctx.beginPath();
  ctx.rect(box.left, box.top, box.right - box.left, box.bottom - box.top);
  ctx.clip();

  for (const [mic, band] of bands) {
    const colour = css(MIC_COLOR[mic] ?? '--series-1');
    // A selected shot owns the foreground; its neighbours drop back to context.
    // Fifteen traces at equal weight is what made this a block of colour.
    ctx.globalAlpha = selected ? 0.11 : 0.32;
    ctx.fillStyle = colour;
    fillBand(ctx, band, cols, py, colX);
    // The band's edges get an outline only when they are the subject. Eight
    // hundred columns of noisy edge at any real opacity is a wall, not a line.
    if (!selected) {
      ctx.globalAlpha = 0.7;
      ctx.strokeStyle = colour;
      ctx.lineWidth = 1;
      strokeSeries(ctx, band.hi, band.seen, cols, py, colX);
      strokeSeries(ctx, band.lo, band.seen, cols, py, colX);
    }
  }
  ctx.globalAlpha = 1;

  if (trace) {
    ctx.strokeStyle = css(MIC_COLOR[selected.entry.mic] ?? '--series-1');
    ctx.lineWidth = 1.4;
    strokeColumns(ctx, trace, cols, py, colX);
  }

  drawWaveCrosshair(ctx, box, px);
  ctx.restore();

  // Direct labels at the right edge: light-mode aqua is under 3:1 on the
  // surface, so identity never rests on colour alone.
  ctx.fillStyle = css('--text-secondary');
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const taken = [];
  for (const [mic, band] of bands) {
    let best = -Infinity;
    for (let c = 0; c < cols; c++) if (band.seen[c] && band.hi[c] > best) best = band.hi[c];
    if (!Number.isFinite(best)) continue;
    // Nudge apart so two quiet mics do not print on top of each other.
    let y = Math.min(Math.max(py(best), box.top + 6), box.bottom - 6);
    while (taken.some((other) => Math.abs(other - y) < 13)) y += 13;
    taken.push(y);
    ctx.fillText(mic, box.right + 6, y);
  }

  const legend = clearLegend($('wave-legend'));
  const reset = $('wave-reset');
  for (const mic of bands.keys()) {
    const item = document.createElement('span');
    item.className = 'item';
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = `var(${MIC_COLOR[mic] ?? '--series-1'})`;
    if (selected && selected.entry.mic !== mic) item.classList.add('dim');
    item.append(swatch, document.createTextNode(mic));
    // The reset control lives in the legend and stays at its end, so swatches
    // go in ahead of it rather than being appended after.
    legend.insertBefore(item, reset);
  }
}

/** Empty a legend of its swatches without evicting the controls parked in it. */
function clearLegend(legend) {
  for (const item of [...legend.querySelectorAll('.item')]) item.remove();
  return legend;
}

function drawWaveCrosshair(ctx, box, px) {
  const t = state.wave.hover ?? state.wave.pinned;
  if (t === null || t === undefined) return;
  const x = Math.round(px(t)) + 0.5;
  if (x < box.left || x > box.right) return;
  ctx.save();
  ctx.strokeStyle = css('--text-muted');
  ctx.globalAlpha = 0.65;
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(x, box.top);
  ctx.lineTo(x, box.bottom);
  ctx.stroke();
  ctx.restore();
}

/* ------------------------------------------------------------- wave readout */

/** Sample index of `t` ms within a record, or null if `t` is outside it. */
function indexAt(entry, t) {
  const [s0, s1] = recordSpan(entry);
  if (t < s0 || t > s1) return null;
  const i = Math.round((t - s0) / (entry.dt * 1000));
  return i >= 0 && i < entry.n ? i : null;
}

function showWaveTip(t, pinned) {
  const tip = $('wave-tip');
  const box = state.wave.box;
  if (!box || !state.envelopes) return;

  tip.textContent = '';
  tip.classList.toggle('pinned', pinned);
  if (pinned) {
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'tip-close';
    close.setAttribute('aria-label', 'Dismiss readout');
    close.textContent = '×';
    tip.append(close);
  }

  const title = document.createElement('strong');
  title.textContent = `${t.toFixed(3)} ms`;
  tip.append(title);

  const selected = state.wave.record;
  const trigger = selected?.analysis.triggered
    ? recordSpan(selected.entry)[0] + selected.analysis.leqStart * selected.entry.dt * 1000
    : null;
  if (trigger !== null) {
    const rel = document.createElement('div');
    rel.className = 'dim';
    const d = t - trigger;
    rel.textContent = `${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(3)} ms from shot start`;
    tip.append(rel);
  }

  if (selected) {
    const i = indexAt(selected.entry, t);
    const line = document.createElement('div');
    line.append(document.createTextNode(`${selected.entry.mic} shot ${selected.entry.shot}: `));
    const value = document.createElement('strong');
    if (i === null) {
      value.textContent = '—';
    } else {
      const pa = selected.values[i];
      value.textContent = `${pa.toFixed(2)} Pa`;
    }
    line.append(value);
    if (i !== null) {
      const level = document.createElement('span');
      level.className = 'dim';
      const pa = Math.abs(selected.values[i]);
      level.textContent = pa > 0 ? ` (${toDb(pa).toFixed(1)} dB)` : '';
      line.append(level);
    }
    tip.append(line);
  }

  // Band readouts: the extremes across that mic's shots at this instant, which
  // is the thing the band is drawing.
  const byMic = new Map();
  for (const record of state.envelopes) {
    if (!byMic.has(record.entry.mic)) byMic.set(record.entry.mic, []);
    byMic.get(record.entry.mic).push(record);
  }
  for (const [mic, group] of byMic) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const record of group) {
      const [s0, s1] = recordSpan(record.entry);
      const b = Math.floor(((t - s0) / (s1 - s0)) * record.buckets);
      if (b < 0 || b >= record.buckets) continue;
      lo = Math.min(lo, record.values[b * 2]);
      hi = Math.max(hi, record.values[b * 2 + 1]);
    }
    if (!Number.isFinite(lo)) continue;
    const line = document.createElement('div');
    line.className = 'dim';
    line.textContent =
      `${mic}: ${lo.toFixed(1)} … ${hi.toFixed(1)} Pa over ${group.length} shot` +
      (group.length === 1 ? '' : 's');
    tip.append(line);
  }

  tip.hidden = false;
  const wrap = $('wave').parentElement.getBoundingClientRect();
  const x = state.wave.lastX ?? box.left;
  const y = state.wave.lastY ?? box.top;
  tip.style.left = `${Math.max(4, Math.min(x + 14, wrap.width - tip.offsetWidth - 6))}px`;
  tip.style.top = `${Math.max(4, Math.min(y - 10, wrap.height - tip.offsetHeight - 4))}px`;
}

function dismissWaveTip() {
  state.wave.pinned = null;
  const tip = $('wave-tip');
  tip.hidden = true;
  tip.classList.remove('pinned');
}

/* --------------------------------------------------------- wave interaction */

/** Time in ms under a pointer, or null if it is outside the plot. */
function waveTimeAt(event) {
  const box = state.wave.box;
  if (!box) return null;
  const rect = $('wave').getBoundingClientRect();
  const x = event.clientX - rect.left;
  state.wave.lastX = x;
  state.wave.lastY = event.clientY - rect.top;
  if (x < box.left || x > box.right) return null;
  const [t0, t1] = waveDomain();
  return t0 + ((x - box.left) / (box.right - box.left)) * (t1 - t0);
}

/** Zoom by `factor` about `anchor` ms, so whatever is under the cursor stays put. */
function zoomWave(factor, anchor) {
  const [t0, t1] = waveDomain();
  const at = anchor ?? (t0 + t1) / 2;
  setWaveView([at - (at - t0) * factor, at + (t1 - at) * factor]);
}

function bindWave() {
  const canvas = $('wave');
  const tip = $('wave-tip');
  const pointers = new Map();
  let dragFrom = null; // {x, domain} while panning
  let dragged = false;
  let pinchFrom = null; // {distance, domain} while pinching

  tip.addEventListener('click', (event) => {
    if (!event.target.closest('.tip-close')) return;
    dismissWaveTip();
    renderWave();
  });

  $('wave-reset').addEventListener('click', () => {
    setWaveView(null);
    describeWave();
  });

  canvas.addEventListener('pointerdown', (event) => {
    // Nothing loaded means nothing to pan, zoom or read out; the placeholder is
    // not a plot and `state.wave.box` would be whichever run was last drawn.
    if (!state.envelopes) return;
    pointers.set(event.pointerId, event);
    canvas.setPointerCapture(event.pointerId);
    dragged = false;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchFrom = { distance: Math.abs(a.clientX - b.clientX) || 1, domain: waveDomain() };
      dragFrom = null;
    } else if (pointers.size === 1) {
      dragFrom = { x: event.clientX, domain: waveDomain() };
    }
  });

  canvas.addEventListener('pointermove', (event) => {
    if (!state.envelopes) return;
    if (pointers.has(event.pointerId)) pointers.set(event.pointerId, event);

    if (pinchFrom && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const distance = Math.abs(a.clientX - b.clientX) || 1;
      const [t0, t1] = pinchFrom.domain;
      const mid = (t0 + t1) / 2;
      const half = ((t1 - t0) / 2) * (pinchFrom.distance / distance);
      dragged = true;
      setWaveView([mid - half, mid + half]);
      return;
    }

    if (dragFrom) {
      const box = state.wave.box;
      const [t0, t1] = dragFrom.domain;
      const shift = ((dragFrom.x - event.clientX) / (box.right - box.left)) * (t1 - t0);
      if (Math.abs(dragFrom.x - event.clientX) > 3) dragged = true;
      if (dragged) {
        setWaveView([t0 + shift, t1 + shift]);
        describeWave();
      }
      return;
    }

    // Hover has no meaning on touch, where the finger is the thing being
    // pointed with; a tap pins instead.
    if (event.pointerType === 'touch') return;
    const t = waveTimeAt(event);
    state.wave.hover = t;
    if (t !== null) showWaveTip(t, state.wave.pinned !== null);
    else if (state.wave.pinned !== null) showWaveTip(state.wave.pinned, true);
    else tip.hidden = true;
    renderWave();
  });

  const release = (event) => {
    pointers.delete(event.pointerId);
    if (pointers.size < 2) pinchFrom = null;
    if (pointers.size === 0) {
      // A drag is a pan, not a pick: only a still pointer pins a readout.
      if (!dragged) {
        const t = waveTimeAt(event);
        if (t === null) {
          dismissWaveTip();
        } else {
          state.wave.pinned = t;
          showWaveTip(t, true);
        }
        renderWave();
      }
      dragFrom = null;
    }
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);

  canvas.addEventListener('pointerleave', (event) => {
    if (event.pointerType === 'touch' || dragFrom) return;
    state.wave.hover = null;
    if (state.wave.pinned !== null) showWaveTip(state.wave.pinned, true);
    else tip.hidden = true;
    renderWave();
  });

  canvas.addEventListener(
    'wheel',
    (event) => {
      if (!state.envelopes) return;
      event.preventDefault();
      zoomWave(Math.exp(event.deltaY * 0.002), waveTimeAt(event));
      describeWave();
    },
    { passive: false },
  );

  canvas.addEventListener('dblclick', () => {
    setWaveView(null);
    describeWave();
  });

  // Keyboard equivalents, because zoom that only answers to a wheel or two
  // fingers is zoom that some readers do not have.
  canvas.tabIndex = 0;
  canvas.addEventListener('keydown', (event) => {
    if (!state.envelopes || !state.wave.full) return;
    const [t0, t1] = waveDomain();
    const step = (t1 - t0) * 0.2;
    const moves = {
      ArrowLeft: () => setWaveView([t0 - step, t1 - step]),
      ArrowRight: () => setWaveView([t0 + step, t1 + step]),
      '+': () => zoomWave(1 / 1.4, null),
      '=': () => zoomWave(1 / 1.4, null),
      '-': () => zoomWave(1.4, null),
      Escape: () => { dismissWaveTip(); setWaveView(null); },
    };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    move();
    describeWave();
  });
}

/* ---------------------------------------------------------------- shot picks */

function renderShotButtons() {
  const host = $('shots');
  host.innerHTML = '';

  // A way back to the overview. Without it, picking a shot was a one-way door:
  // nothing on the card returned to the all-shots view.
  const all = document.createElement('button');
  all.type = 'button';
  all.textContent = 'all shots';
  all.setAttribute('aria-pressed', String(state.selectedWaveform === null));
  all.addEventListener('click', () => clearFullRate());
  host.append(all);

  const seen = new Map();
  for (const record of state.envelopes) {
    seen.set(`${record.entry.mic}/${record.entry.shot}`, record.entry);
  }
  for (const [key, entry] of seen) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = key + (entry.excluded ? ' (spare)' : '');
    button.setAttribute('aria-pressed', String(state.selectedWaveform === entry.id));
    button.addEventListener('click', () => loadFullRate(entry));
    host.append(button);
  }
}

/** Back to the band view, keeping whatever zoom the reader had set. */
function clearFullRate() {
  state.selectedWaveform = null;
  state.wave.record = null;
  $('derived').hidden = true;
  const run = state.bundle.catalog.ids[state.selectedRun];
  history.replaceState(null, '', `#run=${run}`);
  renderShotButtons();
  describeWave();
  renderWave();
}

async function loadFullRate(entry, { updateHash = true } = {}) {
  state.selectedWaveform = entry.id;
  renderShotButtons();
  if (updateHash) {
    const run = state.bundle.catalog.ids[state.selectedRun];
    history.replaceState(null, '', `#run=${run}&shot=${entry.id}`);
  }
  const { values, dt } = await fetchSamples(state.bundle, entry.id);
  // Raced ahead: the reader picked something else while this was in flight.
  if (state.selectedWaveform !== entry.id) return;

  // Derived here, not published: the same analysis `tbacss.analysis` runs, so
  // the curves and the figures marked on them are the published ones.
  const analysis = analyse(values, dt);
  state.wave.record = { entry, values, dt, analysis };

  const [s0] = recordSpan(entry);
  const at = (i) => s0 + i * dt * 1000;
  widenAutoFor([at(analysis.trough), at(analysis.impulseIndex), at(analysis.leqIndex)]);

  $('derived').hidden = false;
  describeWave();
  renderWave();
  renderDerived();
}

/* -------------------------------------------------------------- derived plots */

/**
 * One curve on the shared time axis, with the region and the instant that a
 * published figure was taken from marked on it.
 */
function drawCurve(canvas, { values, entry, label, colorVar, digits = 0, shade, marks = [] }) {
  const { ctx, width, height } = prepare(canvas);
  const domain = waveDomain();
  const box = { left: 54, top: 18, right: width - 42, bottom: height - 30 };
  const cols = Math.max(1, Math.round(box.right - box.left));
  const colX = (c) => box.left + ((c + 0.5) / cols) * (box.right - box.left);
  const band = sampleColumns(values, entry, domain, cols);

  let lo = Infinity;
  let hi = -Infinity;
  for (let c = 0; c < cols; c++) {
    if (!band.seen[c]) continue;
    if (band.lo[c] < lo) lo = band.lo[c];
    if (band.hi[c] > hi) hi = band.hi[c];
  }
  if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
  const span = hi - lo || 1;

  const { px, py } = axes(
    ctx, box, domain, [lo - span * 0.08, hi + span * 0.08],
    'time, ms', label, domain[1] - domain[0] < 5 ? 1 : 0, digits,
  );

  ctx.save();
  ctx.beginPath();
  ctx.rect(box.left, box.top, box.right - box.left, box.bottom - box.top);
  ctx.clip();

  if (shade) {
    ctx.fillStyle = css(colorVar);
    ctx.globalAlpha = 0.1;
    const a = Math.max(px(shade.from), box.left);
    const b = Math.min(px(shade.to), box.right);
    if (b > a) ctx.fillRect(a, box.top, b - a, box.bottom - box.top);
    ctx.globalAlpha = 1;
  }

  ctx.strokeStyle = css(colorVar);
  ctx.lineWidth = 1.6;
  ctx.lineJoin = 'round';
  strokeColumns(ctx, band, cols, py, colX);
  ctx.restore();

  ctx.font = '11px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  for (const mark of marks) {
    const raw = px(mark.t);
    // A marker the reader has zoomed past is pulled to the edge and flagged
    // rather than dropped: silently omitting it would read as "no such point".
    const offLeft = raw < box.left;
    const offRight = raw > box.right;
    const off = offLeft || offRight;
    const x = Math.min(Math.max(raw, box.left), box.right);
    const y = Math.min(Math.max(py(mark.v), box.top + 4), box.bottom - 4);

    if (!off) {
      ctx.save();
      ctx.strokeStyle = css('--text-muted');
      ctx.setLineDash([2, 3]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, box.top);
      ctx.lineTo(Math.round(x) + 0.5, box.bottom);
      ctx.stroke();
      ctx.restore();
    }

    // Off-screen markers get the label but no dot: a dot pinned to the edge
    // would claim a position on the curve that is not where the figure was
    // taken from. The time in the label says where that actually was.
    if (!off) {
      ctx.fillStyle = css(colorVar);
      ctx.beginPath();
      ctx.arc(x, y, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }

    const text = off
      ? `${offLeft ? '‹ ' : ''}${mark.text} at ${mark.t.toFixed(1)} ms${offRight ? ' ›' : ''}`
      : mark.text;
    // Flip the label inboard near the right edge so it is never clipped.
    const room = box.right - x;
    ctx.textAlign = room < ctx.measureText(text).width + 12 ? 'right' : 'left';
    haloText(ctx, text, x + (ctx.textAlign === 'right' ? -7 : 7), y);
  }
}

function renderDerived() {
  const selected = state.wave.record;
  if (!selected || $('derived').hidden) return;
  const { entry, values, dt, analysis } = selected;
  const [s0] = recordSpan(entry);
  const stepMs = dt * 1000;
  const at = (i) => s0 + i * stepMs;

  drawCurve($('impulse'), {
    values: analysis.integral,
    entry,
    label: 'cumulative impulse, Pa·ms',
    colorVar: '--series-1',
    digits: 0,
    // The published impulse is not the whole integral, it is the largest value
    // the integral reaches before the trough. Shading that stretch and marking
    // its maximum is what turns a wandering curve into the number it explains.
    // From the shot rather than from the start of the capture: the fifty
    // milliseconds of pre-trigger silence contribute nothing to the integral
    // and shading them says the opposite.
    shade: {
      from: at(analysis.triggered ? analysis.leqStart : 0),
      to: at(analysis.trough),
    },
    marks: [
      {
        t: at(analysis.impulseIndex),
        v: analysis.integral[analysis.impulseIndex],
        text: `impulse ${analysis.impulse_pa_ms.toFixed(2)} Pa·ms`,
      },
      {
        t: at(analysis.trough),
        v: analysis.integral[analysis.trough],
        text: 'trough',
      },
    ],
  });

  const levels = new Float64Array(analysis.running.length);
  for (let i = 0; i < levels.length; i++) {
    levels[i] = analysis.running[i] > 0 ? toDb(analysis.running[i], P0) : NaN;
  }
  drawCurve($('leq'), {
    values: levels,
    entry,
    label: 'Leq(10ms), dBA',
    colorVar: '--series-3',
    digits: 0,
    shade: analysis.triggered
      ? { from: at(analysis.leqStart), to: at(analysis.leqStop) }
      : null,
    marks: [
      {
        t: at(analysis.leqIndex),
        v: levels[analysis.leqIndex],
        text: `peak ${analysis.peak_leq10ms_dba.toFixed(2)} dBA`,
      },
    ],
  });
}

/* --------------------------------------------------------------------- boot */

/**
 * Stamp a theme and redraw. Canvas colours are read at paint time, so every
 * plot has to be re-rendered rather than restyled.
 */
/** Repaint every canvas; they read colours and sizes at paint time. */
function redraw() {
  renderScatter();
  if (state.envelopes) {
    // Column count follows the canvas width, so a resize really does have to
    // re-decimate rather than rescale what was already drawn.
    renderWave();
    renderDerived();
    describeWave();
  } else {
    drawPlaceholder($('wave'), 'Pick a run from the chart or table');
  }
}

function applyTheme(theme) {
  if (theme) {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('tbacss-theme', theme);
    } catch {
      // Private mode or a blocked origin; the stamp still applies for this view.
    }
  }
  redraw();
}

/** `?theme=light|dark` wins over the stored choice, which wins over the OS. */
function initialTheme() {
  const requested = new URLSearchParams(location.search).get('theme');
  if (requested === 'light' || requested === 'dark') return requested;
  try {
    const stored = localStorage.getItem('tbacss-theme');
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    // ignore
  }
  return null;
}

function fillAxisMenus() {
  const { catalog } = state.bundle;
  const available = MEASURES.filter(([key]) => {
    const column = catalog.columns[key];
    return column && [...column].some((v) => !Number.isNaN(v));
  });
  for (const [id, initial] of [
    ['axis-x', 'weight_oz'],
    ['axis-y', 'se_peak_dba'],
    ['axis-z', ''],
  ]) {
    const select = $(id);
    select.textContent = '';
    if (id === 'axis-z') {
      const none = document.createElement('option');
      none.value = '';
      none.textContent = '(none — keep it 2D)';
      select.append(none);
    }
    let group = null;
    let target = select;
    for (const [key, label, , name] of available) {
      if (name !== group) {
        group = name;
        target = document.createElement('optgroup');
        target.label = name;
        select.append(target);
      }
      const option = document.createElement('option');
      option.value = key;
      option.textContent = shortLabel(label, name);
      // The collapsed control shows only the chosen option, with no heading
      // above it to supply the context, so it keeps the full name.
      option.title = label;
      target.append(option);
    }
    select.value = initial;
    syncAxisLabels(select);
    select.addEventListener('change', () => {
      syncAxisLabels(select);
      if (id === 'axis-z') {
        state.zKey = select.value || null;
        state.view = { ...DEFAULT_VIEW_INIT };
        $('reset-view').hidden = !state.zKey;
      }
      // The readout quotes the axes it was opened against, and its anchor point
      // is about to move. Put it away -- but leave the run selected, so the
      // traces below do not vanish for the sake of a tooltip.
      dismissTooltip();
      refilter();
    });
  }
}

/**
 * Drag to rotate the 3D view.
 *
 * A drag and a tap start the same way, so a pointer that moves less than a few
 * pixels is still treated as a selection rather than a rotation nobody asked
 * for.
 */
function bindRotation() {
  const canvas = $('scatter');
  let dragging = null;

  canvas.addEventListener('pointerdown', (event) => {
    bindRotation.wasDrag = false;
    if (!state.zKey) return;
    dragging = { x: event.clientX, y: event.clientY, moved: 0, view: { ...state.view } };
    canvas.setPointerCapture(event.pointerId);
  });

  canvas.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    const dx = event.clientX - dragging.x;
    const dy = event.clientY - dragging.y;
    dragging.moved = Math.max(dragging.moved, Math.hypot(dx, dy));
    if (dragging.moved < 4) return;
    state.view = {
      yaw: dragging.view.yaw + dx * 0.008,
      // Stop short of the poles, where the cube degenerates to a line.
      pitch: Math.max(-1.45, Math.min(1.45, dragging.view.pitch + dy * 0.008)),
    };
    renderScatter();
  });

  const release = (event) => {
    if (!dragging) return;
    // This listener runs before the selection handlers, so clearing `dragging`
    // here would let the pointerup that ended a rotation also select a run.
    // The verdict has to outlive the gesture; the next pointerdown resets it.
    bindRotation.wasDrag = dragging.moved >= 4;
    dragging = null;
    if (canvas.hasPointerCapture?.(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);

  $('reset-view').addEventListener('click', () => {
    state.view = { ...DEFAULT_VIEW_INIT };
    renderScatter();
  });

  /** True during a rotation, or for the gesture that just ended in one. */
  bindRotation.isDragging = () =>
    (Boolean(dragging) && dragging.moved >= 4) || bindRotation.wasDrag === true;
}

function countsFor(column) {
  const { catalog } = state.bundle;
  const dictionary = catalog.dictionaries[column];
  const counts = new Map();
  for (let i = 0; i < catalog.n; i++) {
    const name = dictionary[catalog.columns[column][i]];
    if (name !== undefined) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

async function main() {
  const theme = initialTheme();
  if (theme) document.documentElement.dataset.theme = theme;

  state.bundle = await loadBundle('data');
  const { catalog } = state.bundle;

  const years = [...new Set([...catalog.columns.year])].sort();
  buildFacet('facet-year', years, null);

  // Calibers are a short list where volume is the useful ordering. Makers and
  // hosts are long lists somebody looks a specific name up in, so those go
  // A-Z -- and hosts sort by the name actually displayed, since sorting by the
  // raw code would leave the rendered list looking unsorted.
  for (const [id, column, order] of [
    ['facet-caliber', 'caliber', 'count'],
    ['facet-cartridge', 'cartridge', 'name'],
    ['facet-manufacturer', 'manufacturer', 'name'],
    ['facet-host_cycling', 'host_cycling', 'count'],
    ['facet-host_ammo', 'host_ammo', 'count'],
  ]) {
    const counts = countsFor(column);
    const describe = column === 'cartridge' ? hostLabel : String;
    const collate = (a, b) =>
      describe(a).localeCompare(describe(b), undefined, {
        sensitivity: 'base',
        numeric: true,
      });
    const values = [...counts.keys()].sort((a, b) =>
      order === 'name' ? collate(a, b) : counts.get(b) - counts.get(a) || collate(a, b),
    );
    buildFacet(id, values, counts, column === 'cartridge' ? hostLabel : null);
  }

  fillAxisMenus();
  bindRotation();
  bindScatter();
  bindWave();

  $('frontier-first').addEventListener('change', (event) => {
    state.frontierFirst = event.target.checked;
    renderTable();
  });

  for (const id of ['q', 'min-weight', 'max-weight', 'min-length', 'max-length', 'baselines']) {
    $(id).addEventListener('input', refilter);
    $(id).addEventListener('change', refilter);
  }
  $('reset').addEventListener('click', () => {
    for (const box of document.querySelectorAll('.facet input:checked')) box.checked = false;
    for (const id of ['q', 'min-weight', 'max-weight', 'min-length', 'max-length']) $(id).value = '';
    $('baselines').value = 'hide';
    refilter();
  });

  const datasets = [...(catalog.datasets ?? [])].sort((a, b) => a.year - b.year);
  const covered = datasets.map((d) => d.year);
  $('coverage').textContent =
    `${catalog.n.toLocaleString()} test runs · ${covered[0]}–${covered.at(-1)}`;

  // The attribution has to name the years anyway, so each year *is* its link
  // rather than repeating them in a second "2023 report · 2024 report" list.
  const footnote = $('footnote');
  footnote.textContent = 'Sound data from the ';
  datasets.forEach((dataset, position) => {
    if (position) {
      footnote.append(
        document.createTextNode(position === datasets.length - 1 ? ' and ' : ', '),
      );
    }
    const url = String(dataset.report_url ?? '');
    if (/^https?:\/\//i.test(url)) {
      const link = document.createElement('a');
      // href is set as a property and only for http(s), so a hostile bundle
      // cannot smuggle in a javascript: URL.
      link.href = url;
      link.rel = 'noreferrer';
      link.title = `${dataset.year} Silencer Summit results`;
      link.textContent = String(dataset.year);
      footnote.append(link);
    } else {
      footnote.append(document.createTextNode(String(dataset.year)));
    }
  });
  footnote.append(
    document.createTextNode(
      ' TBAC Silencer Summits, Thunder Beast Arms Corporation.',
    ),
  );

  $('theme').addEventListener('click', () => {
    const root = document.documentElement;
    const dark = getComputedStyle(root).colorScheme === 'dark';
    applyTheme(dark ? 'light' : 'dark');
  });

  // The filter panel starts collapsed on a phone so the data is above the
  // fold, and is always open on a wide screen where it costs one row.
  const narrow = window.matchMedia(NARROW);
  const applyLayout = () => {
    const small = narrow.matches;
    $('filters').hidden = small && !state.filtersOpen;
    $('filter-toggle').setAttribute('aria-expanded', String(!small || state.filtersOpen));
    for (const [, facetId] of FACETS) {
      $(facetId).closest('details').open = !small;
    }
  };
  $('filter-toggle').addEventListener('click', () => {
    state.filtersOpen = !state.filtersOpen;
    applyLayout();
  });
  narrow.addEventListener('change', () => {
    state.filtersOpen = false;
    applyLayout();
    redraw();
  });
  applyLayout();

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(redraw, 120);
  });

  drawPlaceholder($('wave'), 'Pick a run from the chart or table');
  refilter();

  await applyDeepLink();
  // A pasted #run= link on an already-open page is a navigation too.
  window.addEventListener('hashchange', () => {
    applyDeepLink().catch((error) => console.error(error));
  });
}

/** Select whatever `#run=…&shot=…` names, if anything. */
async function applyDeepLink() {
  const params = new URLSearchParams(location.hash.slice(1));
  const requested = params.get('run');
  if (requested === null) return;

  const index = state.bundle.catalog.ids.indexOf(Number(requested));
  if (index < 0) return;
  if (index === state.selectedRun && !params.get('shot')) return;

  // A deep-linked run may sit outside the current slice, so widen enough to
  // show it rather than selecting something invisible.
  if (!state.mask[index]) {
    $('baselines').value = 'show';
    refilter();
  }
  await selectRun(index, { updateHash: false });

  const shot = params.get('shot');
  if (shot !== null) {
    const entry = state.bundle.byId.get(Number(shot));
    if (entry) await loadFullRate(entry, { updateHash: false });
  }
}

main().catch((error) => {
  const main = document.querySelector('main');
  main.textContent = '';
  const card = document.createElement('div');
  card.className = 'card';
  const title = document.createElement('h2');
  title.textContent = 'Could not load the bundle';
  const detail = document.createElement('p');
  detail.className = 'hint';
  detail.textContent = error.message;
  const fix = document.createElement('p');
  fix.className = 'hint';
  fix.textContent = 'Run `python -m tbacss publish tbacss.db web/data` first.';
  card.append(title, detail, fix);
  main.append(card);
  console.error(error);
});

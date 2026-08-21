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
  impulse as cumulativeImpulse,
  leq as runningLeq,
  aWeightingCoefficients,
  lfilter,
  toDb,
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

const MEASURES = [
  ['se_peak_dba', "shooter's ear, peak dBA", MINIMISE],
  ['se_peak_db', "shooter's ear, peak dB", MINIMISE],
  ['se_peak_leq10ms_dba', "shooter's ear, Leq(10ms) dBA", MINIMISE],
  ['se_impulse_db_ms', "shooter's ear, impulse dB·ms", MINIMISE],
  ['ml_peak_db', 'mil left, peak dB', MINIMISE],
  ['ml_peak_dba', 'mil left, peak dBA', MINIMISE],
  ['ml_peak_leq10ms_dba', 'mil left, Leq(10ms) dBA', MINIMISE],
  ['mr_peak_db', 'mil right, peak dB', MINIMISE],
  ['mr_peak_dba', 'mil right, peak dBA', MINIMISE],
  ['p225_peak_db', '225°, peak dB', MINIMISE],
  ['p225_peak_dba', '225°, peak dBA', MINIMISE],
  ['weight_oz', 'weight, oz', MINIMISE],
  ['length_in', 'length, in', MINIMISE],
  ['max_diameter_in', 'max diameter, in', MINIMISE],
  ['vol_cuin', 'volume, cu in', MINIMISE],
  // Host attributes. Both are conditions the test was run under rather than
  // properties of the suppressor, so neither is an objective -- you control
  // for a barrel length, you do not minimise it.
  ['host_barrel_in', 'host barrel, in', null],
  ['host_grains', 'bullet, grains', null],
  ['year', 'year', null],
];
const MEASURE_LABEL = new Map(MEASURES.map(([key, label]) => [key, label]));
const BETTER = new Map(MEASURES.map(([key, , better]) => [key, better]));

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
  filtersOpen: false,
  zKey: null,
  view: { ...DEFAULT_VIEW_INIT },
};

/* ------------------------------------------------------------------ helpers */

const css = (name) => getComputedStyle(document.body).getPropertyValue(name).trim();

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

  for (const i of usable) {
    const x = px(xs[i]);
    const y = py(ys[i]);
    scatterPoints.push({ i, x, y });
    drawPoint(ctx, x, y, {
      frontier: state.frontier.has(i),
      selected: state.selectedRun === i,
    });
  }
}

function renderScatter3D(ctx, width, height, usable, keys) {
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
function showTooltip(tip, canvas, point) {
  const { catalog } = state.bundle;
  const i = point.i;
  const xKey = $('axis-x').value;
  const yKey = $('axis-y').value;
  const dict = (name) => catalog.dictionaries[name][catalog.columns[name][i]] ?? '—';

  tip.textContent = '';
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
    tip.append(line);
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

  // Touch has no hover, so a tap does both jobs: it selects the run and leaves
  // the readout on screen until the next tap.
  canvas.addEventListener('pointerup', (event) => {
    if (event.pointerType !== 'touch') return;
    if (bindRotation.isDragging?.()) return;
    const point = nearestPoint(event);
    if (!point) {
      tip.hidden = true;
      return;
    }
    state.hover = point.i;
    showTooltip(tip, canvas, point);
    selectRun(point.i);
  });

  canvas.addEventListener('pointermove', (event) => {
    if (event.pointerType === 'touch' || bindRotation.isDragging?.()) return;
    const point = nearestPoint(event);
    state.hover = point ? point.i : null;
    if (!point) {
      tip.hidden = true;
      renderScatter();
      return;
    }
    showTooltip(tip, canvas, point);
    renderScatter();
  });

  canvas.addEventListener('pointerleave', (event) => {
    // A touch pointer is destroyed on lift, which fires pointerleave straight
    // after the tap. Keeping the readout up until the next tap is the point.
    if (event.pointerType === 'touch') return;
    state.hover = null;
    tip.hidden = true;
    renderScatter();
  });

  canvas.addEventListener('click', (event) => {
    // Touch already handled this on pointerup, and a drag is not a click.
    if (event.pointerType === 'touch') return;
    if (bindRotation.isDragging?.()) return;
    const point = nearestPoint(event);
    if (point) selectRun(point.i);
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

/** A quiet centred message on an otherwise empty plot. */
function drawPlaceholder(canvas, message) {
  const { ctx, width, height } = prepare(canvas);
  ctx.fillStyle = css('--text-muted');
  ctx.font = '13px system-ui, -apple-system, "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(message, width / 2, height / 2);
}

async function selectRun(index, { updateHash = true } = {}) {
  state.selectedRun = index;
  state.selectedWaveform = null;
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

  if (!catalog.columns.waveform_count[index]) {
    state.envelopes = null;
    $('wave-hint').textContent =
      'No waveforms for this run — 2026 is published as tables only, and a ' +
      'handful of runs across the other years were never released.';
    drawPlaceholder($('wave'), 'No waveforms released for this run');
    $('wave-legend').innerHTML = '';
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
  const shots = new Set(state.envelopes.map((e) => e.entry.shot));
  $('wave-hint').textContent =
    `${state.envelopes.length} records · ${shots.size} shots × ${
      new Set(state.envelopes.map((e) => e.entry.mic)).size
    } mics. Min/max envelope over 2048 buckets; pick a shot for full rate.`;
  renderEnvelopes();
  renderShotButtons();
}

const MIC_COLOR = { ML: '--series-1', MR: '--series-2', SE: '--series-3', 225: '--series-2' };

function renderEnvelopes() {
  const canvas = $('wave');
  const { ctx, width, height } = prepare(canvas);
  const records = state.envelopes;
  if (!records || !records.length) return;

  let lo = Infinity;
  let hi = -Infinity;
  for (const record of records) {
    for (const value of record.values) {
      if (value < lo) lo = value;
      if (value > hi) hi = value;
    }
  }
  const span = hi - lo || 1;
  const box = { left: 54, top: 20, right: width - 42, bottom: height - 34 };
  const buckets = records[0].buckets;
  const t0 = state.bundle.waveforms.window_start_s * 1000;
  const dt = records[0].entry.dt * 1000;
  const tEnd = t0 + records[0].entry.n * dt;

  const { px, py } = axes(
    ctx, box, [t0, tEnd], [lo - span * 0.05, hi + span * 0.05],
    'time, ms', 'pressure, Pa', 0, 0,
  );

  const byMic = new Map();
  for (const record of records) {
    if (!byMic.has(record.entry.mic)) byMic.set(record.entry.mic, []);
    byMic.get(record.entry.mic).push(record);
  }

  for (const [mic, group] of byMic) {
    ctx.strokeStyle = css(MIC_COLOR[mic] ?? '--series-1');
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.55;
    for (const record of group) {
      ctx.beginPath();
      for (let b = 0; b < buckets; b++) {
        const x = px(t0 + ((b + 0.5) / buckets) * (tEnd - t0));
        ctx.moveTo(x, py(record.values[b * 2]));
        ctx.lineTo(x, py(record.values[b * 2 + 1]));
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Direct label at the trace's right edge. Light-mode aqua is below 3:1 on
    // the surface, so identity never rests on colour alone.
    const last = group[0];
    let peak = -Infinity;
    for (let b = 0; b < buckets; b++) peak = Math.max(peak, last.values[b * 2 + 1]);
    ctx.fillStyle = css('--text-secondary');
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(mic, box.right + 6, py(peak));
  }

  const legend = $('wave-legend');
  legend.textContent = '';
  for (const mic of byMic.keys()) {
    const item = document.createElement('span');
    item.className = 'item';
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = `var(${MIC_COLOR[mic] ?? '--series-1'})`;
    item.append(swatch, document.createTextNode(mic));
    legend.append(item);
  }
}

function renderShotButtons() {
  const host = $('shots');
  host.innerHTML = '';
  const seen = new Map();
  for (const record of state.envelopes) {
    const key = `${record.entry.mic}/${record.entry.shot}`;
    seen.set(key, record.entry);
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

async function loadFullRate(entry, { updateHash = true } = {}) {
  state.selectedWaveform = entry.id;
  renderShotButtons();
  if (updateHash) {
    const run = state.bundle.catalog.ids[state.selectedRun];
    history.replaceState(null, '', `#run=${run}&shot=${entry.id}`);
  }
  const { values, dt } = await fetchSamples(state.bundle, entry.id);
  const rate = 1 / dt;
  const t0 = state.bundle.waveforms.window_start_s * 1000;

  // Derived here, not published: a cumulative trapezoid and a six-coefficient
  // IIR are cheap, and computing them client-side keeps the window editable.
  const integral = cumulativeImpulse(values, dt);
  const [b, a] = aWeightingCoefficients(rate);
  const weighted = lfilter(b, a, values);
  const running = runningLeq(weighted, rate);

  $('derived').hidden = false;
  drawSeries($('impulse'), values.length, t0, dt * 1000, integral, 'impulse, Pa·ms', '--series-1');
  const levels = new Float64Array(running.length);
  for (let i = 0; i < running.length; i++) {
    levels[i] = running[i] > 0 ? toDb(running[i], P0) : 0;
  }
  drawSeries($('leq'), values.length, t0, dt * 1000, levels, 'Leq(10ms), dBA', '--series-3');

  const peak = Math.max(...values);
  $('wave-hint').textContent =
    `${entry.mic} shot ${entry.shot}: ${values.length.toLocaleString()} samples at full rate, ` +
    `peak ${peak.toFixed(2)} Pa (${toDb(peak, P0).toFixed(2)} dB).` +
    (entry.overload ? ' DAQ flagged an overload on this record.' : '');
}

function drawSeries(canvas, count, t0, stepMs, values, label, colorVar) {
  const { ctx, width, height } = prepare(canvas);
  let lo = Infinity;
  let hi = -Infinity;
  for (const value of values) {
    if (value < lo) lo = value;
    if (value > hi) hi = value;
  }
  const span = hi - lo || 1;
  const box = { left: 54, top: 18, right: width - 12, bottom: height - 30 };
  const { px, py } = axes(
    ctx, box, [t0, t0 + count * stepMs], [lo - span * 0.05, hi + span * 0.05],
    'time, ms', label, 0, 0,
  );

  ctx.beginPath();
  ctx.strokeStyle = css(colorVar);
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  const stride = Math.max(1, Math.floor(count / (box.right - box.left) / 2));
  for (let i = 0; i < count; i += stride) {
    const x = px(t0 + i * stepMs);
    const y = py(values[i]);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

/* --------------------------------------------------------------------- boot */

/**
 * Stamp a theme and redraw. Canvas colours are read at paint time, so every
 * plot has to be re-rendered rather than restyled.
 */
/** Repaint every canvas; they read colours and sizes at paint time. */
function redraw() {
  renderScatter();
  if (state.envelopes) renderEnvelopes();
  else drawPlaceholder($('wave'), 'Pick a run from the chart or table');
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
    for (const [key, label] of available) {
      const option = document.createElement('option');
      option.value = key;
      option.textContent = label;
      select.append(option);
    }
    select.value = initial;
    select.addEventListener('change', () => {
      if (id === 'axis-z') {
        state.zKey = select.value || null;
        state.view = { ...DEFAULT_VIEW_INIT };
        $('reset-view').hidden = !state.zKey;
      }
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

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

/** Numeric columns offered on the axes, in the order they appear in menus. */
const MEASURES = [
  ['se_peak_dba', "shooter's ear, peak dBA"],
  ['se_peak_db', "shooter's ear, peak dB"],
  ['se_peak_leq10ms_dba', "shooter's ear, Leq(10ms) dBA"],
  ['se_impulse_db_ms', "shooter's ear, impulse dB·ms"],
  ['ml_peak_db', 'mil left, peak dB'],
  ['ml_peak_dba', 'mil left, peak dBA'],
  ['ml_peak_leq10ms_dba', 'mil left, Leq(10ms) dBA'],
  ['mr_peak_db', 'mil right, peak dB'],
  ['mr_peak_dba', 'mil right, peak dBA'],
  ['p225_peak_db', '225°, peak dB'],
  ['p225_peak_dba', '225°, peak dBA'],
  ['weight_oz', 'weight, oz'],
  ['length_in', 'length, in'],
  ['max_diameter_in', 'max diameter, in'],
  ['vol_cuin', 'volume, cu in'],
  ['year', 'year'],
];
const MEASURE_LABEL = new Map(MEASURES);

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
  hover: null,
  filtersOpen: false,
};

/* ------------------------------------------------------------------ helpers */

const css = (name) => getComputedStyle(document.body).getPropertyValue(name).trim();

function fmt(value, digits = 2) {
  return value === null || Number.isNaN(value) ? '—' : value.toFixed(digits);
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

function buildFacet(id, values, counts) {
  const host = $(id);
  host.innerHTML = '';
  for (const value of values) {
    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.value = value;
    box.addEventListener('change', refilter);
    label.append(box, document.createTextNode(
      counts ? `${value} (${counts.get(value) ?? 0})` : String(value),
    ));
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

  for (const [id, column] of [
    ['facet-caliber', 'caliber'],
    ['facet-cartridge', 'cartridge'],
    ['facet-manufacturer', 'manufacturer'],
  ]) {
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

  const [xDir, yDir] = $('frontier-dir').value.split(',');
  state.frontier = new Set(
    paretoFront(
      catalog,
      [
        { column: $('axis-x').value, direction: xDir },
        { column: $('axis-y').value, direction: yDir },
      ],
      mask,
    ),
  );

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

function renderScatter() {
  const canvas = $('scatter');
  const { ctx, width, height } = prepare(canvas);
  const { catalog } = state.bundle;
  const xKey = $('axis-x').value;
  const yKey = $('axis-y').value;
  const xs = catalog.columns[xKey];
  const ys = catalog.columns[yKey];

  const usable = state.visible.filter((i) => !Number.isNaN(xs[i]) && !Number.isNaN(ys[i]));
  scatterPoints = [];
  if (!usable.length) {
    ctx.fillStyle = css('--text-muted');
    ctx.font = '13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No runs match these filters.', width / 2, height / 2);
    return;
  }

  const pad = (values) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const i of usable) {
      lo = Math.min(lo, values[i]);
      hi = Math.max(hi, values[i]);
    }
    const span = hi - lo || Math.abs(hi) || 1;
    return [lo - span * 0.06, hi + span * 0.06];
  };

  const box = { left: 54, top: 22, right: width - 12, bottom: height - 34 };
  const digits = (key) => (key === 'year' ? 0 : key.includes('_in') || key === 'weight_oz' ? 1 : 0);
  const { px, py } = axes(
    ctx, box, pad(xs), pad(ys),
    MEASURE_LABEL.get(xKey), MEASURE_LABEL.get(yKey),
    digits(xKey), digits(yKey),
  );

  // Bulk points recede; the frontier is the story, so it gets the one hue.
  // Emphasis, not identity — filtering never repaints a survivor.
  for (const i of usable) {
    const onFrontier = state.frontier.has(i);
    const selected = state.selectedRun === i;
    const x = px(xs[i]);
    const y = py(ys[i]);
    scatterPoints.push({ i, x, y });

    ctx.beginPath();
    ctx.arc(x, y, selected ? 6 : onFrontier ? 4.5 : 3, 0, Math.PI * 2);
    if (selected) {
      ctx.fillStyle = css('--series-2');
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = css('--surface-1');
      ctx.stroke();
    } else if (onFrontier) {
      ctx.fillStyle = css('--series-1');
      ctx.fill();
    } else {
      ctx.strokeStyle = css('--dot-strong');
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }
  }

  if (state.hover !== null) {
    const point = scatterPoints.find((p) => p.i === state.hover);
    if (point) {
      ctx.beginPath();
      ctx.arc(point.x, point.y, 8, 0, Math.PI * 2);
      ctx.strokeStyle = css('--series-1');
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
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
  const context = document.createElement('div');
  context.className = 'dim';
  context.textContent =
    `${dict('caliber')} on ${dict('cartridge')} · ${catalog.columns.year[i]}`;
  tip.append(title, context);

  for (const key of [xKey, yKey]) {
    const line = document.createElement('div');
    line.append(document.createTextNode(`${MEASURE_LABEL.get(key)}: `));
    const value = document.createElement('strong');
    value.textContent = fmt(catalog.columns[key][i]);
    line.append(value);
    tip.append(line);
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
  canvas.addEventListener('pointerdown', (event) => {
    if (event.pointerType !== 'touch') return;
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
    if (event.pointerType === 'touch') return;
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
    // Touch already handled this on pointerdown.
    if (event.pointerType === 'touch') return;
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
  const order = [...state.visible].sort((a, b) => {
    let left = column[a];
    let right = column[b];
    if (dictionary) {
      left = dictionary[left] ?? '';
      right = dictionary[right] ?? '';
      return state.sort.direction * String(left).localeCompare(String(right));
    }
    if (Number.isNaN(left)) return 1;
    if (Number.isNaN(right)) return -1;
    return state.sort.direction * (left - right);
  });

  const shown = order.slice(0, MAX_TABLE_ROWS);
  $('table-hint').textContent =
    shown.length < order.length
      ? `The table view: every value on the chart, readable without colour. Showing the first ${shown.length} of ${order.length} matching runs — narrow the filters to see the rest.`
      : 'The table view: every value on the chart, readable without colour.';

  const body = $('table-body');
  body.textContent = '';
  for (const i of shown) {
    const tr = document.createElement('tr');
    if (state.frontier.has(i)) tr.className = 'frontier';
    if (state.selectedRun === i) tr.setAttribute('aria-selected', 'true');
    tr.addEventListener('click', () => selectRun(i));

    for (const [columnKey, , numeric, optional] of TABLE_COLUMNS) {
      const td = document.createElement('td');
      if (numeric) td.className = 'num';
      if (optional) td.dataset.optional = '';
      const dict = catalog.dictionaries[columnKey];
      const raw = catalog.columns[columnKey][i];
      td.textContent = dict
        ? dict[raw] ?? '—'
        : columnKey === 'year'
          ? String(raw)
          : fmt(raw);
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
  for (const [id, initial] of [['axis-x', 'weight_oz'], ['axis-y', 'se_peak_dba']]) {
    const select = $(id);
    select.innerHTML = available
      .map(([key, label]) => `<option value="${key}">${label}</option>`)
      .join('');
    select.value = initial;
    select.addEventListener('change', refilter);
  }
  $('frontier-dir').addEventListener('change', refilter);
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
  for (const [id, column] of [
    ['facet-caliber', 'caliber'],
    ['facet-cartridge', 'cartridge'],
    ['facet-manufacturer', 'manufacturer'],
  ]) {
    const counts = countsFor(column);
    const values = [...counts.keys()].sort((a, b) =>
      counts.get(b) - counts.get(a) || String(a).localeCompare(String(b)),
    );
    buildFacet(id, values, counts);
  }

  fillAxisMenus();
  bindScatter();

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

  const datasets = catalog.datasets ?? [];
  const yearsCovered = datasets.map((d) => d.year).sort();
  $('coverage').textContent =
    `${catalog.n.toLocaleString()} test runs · ${yearsCovered[0]}–${yearsCovered.at(-1)}`;
  const footnote = $('footnote');
  footnote.textContent =
    `Sound data from the ${yearsCovered.join(', ')} TBAC Silencer Summits, ` +
    'Thunder Beast Arms Corporation. ';
  datasets.forEach((dataset, position) => {
    if (position) footnote.append(document.createTextNode(' · '));
    const link = document.createElement('a');
    // href is set as a property, and only for http(s), so a hostile bundle
    // cannot smuggle in a javascript: URL.
    const url = String(dataset.report_url ?? '');
    if (/^https?:\/\//i.test(url)) link.href = url;
    link.rel = 'noreferrer';
    link.textContent = `${dataset.year} report`;
    footnote.append(link);
  });

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

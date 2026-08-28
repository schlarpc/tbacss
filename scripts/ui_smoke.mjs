/**
 * Drive the explorer in a real browser and assert it responds.
 *
 *   python3 scripts/serve.py &
 *   chromium --headless --remote-debugging-port=9222 --no-sandbox about:blank &
 *   node scripts/ui_smoke.mjs [url] [width] [height]
 *
 * Screenshots prove the page renders; this proves it *works* — that the filter
 * toggle opens, that ticking a facet narrows the slice, that a tap selects a
 * run and loads its traces. Uses CDP directly so there is no test-runner
 * dependency to install.
 */

const [, , base = 'http://127.0.0.1:8765/index.html', width = 390, height = 844] =
  process.argv;

const endpoint = await (await fetch('http://127.0.0.1:9222/json/version')).json();
const socket = new WebSocket(endpoint.webSocketDebuggerUrl);
await new Promise((resolve) => socket.addEventListener('open', resolve));

let nextId = 1;
const pending = new Map();
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    message.error ? reject(new Error(message.error.message)) : resolve(message.result);
  }
});

function send(method, params = {}, sessionId) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params, sessionId }));
  });
}

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const call = (method, params) => send(method, params, sessionId);

await call('Emulation.setDeviceMetricsOverride', {
  width: Number(width),
  height: Number(height),
  deviceScaleFactor: 2,
  mobile: true,
  screenWidth: Number(width),
  screenHeight: Number(height),
});
await call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await call('Page.enable');
// The dev server sends no-store, but a browser started before that change can
// still be holding a cached bundle. Never test against yesterday's data.
await call('Network.enable');
await call('Network.setCacheDisabled', { cacheDisabled: true });

async function evaluate(expression) {
  const { result, exceptionDetails } = await call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (exceptionDetails) throw new Error(exceptionDetails.text ?? 'evaluation failed');
  return result.value;
}

/** Tap the centre of an element, as a finger would. */
async function tap(selector) {
  const box = await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  if (!box) throw new Error(`no element ${selector}`);
  const touchPoints = [{ x: box.x, y: box.y }];
  await call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints });
  await call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await new Promise((r) => setTimeout(r, 350));
}

let failures = 0;
function check(name, condition, detail = '') {
  const status = condition ? 'ok  ' : 'FAIL';
  if (!condition) failures++;
  console.log(`  ${status} ${name}${detail ? ` — ${detail}` : ''}`);
}

console.log(`driving ${base} at ${width}x${height}, touch emulated\n`);
await call('Page.navigate', { url: base });
await new Promise((r) => setTimeout(r, 3500));

// 1. The page loaded its bundle.
const runs = await evaluate("document.querySelector('.tile .value')?.textContent ?? ''");
check('bundle loaded', /\d/.test(runs), `${runs} runs`);

// 2. Filters collapse behind a toggle on a phone, and are always open wide.
const narrow = await evaluate("window.matchMedia('(max-width: 720px)').matches");
if (narrow) {
  check(
    'filters collapsed on load',
    await evaluate("document.getElementById('filters').hidden === true"),
  );
  await tap('#filter-toggle');
  check(
    'toggle opens the panel',
    await evaluate("document.getElementById('filters').hidden === false"),
  );
} else {
  check(
    'filters always visible on a wide screen',
    await evaluate("document.getElementById('filters').hidden === false"),
  );
}

// 3. A facet disclosure opens and ticking a box narrows the slice.
if (narrow) await tap('#det-year summary');
check(
  'facet disclosure open',
  await evaluate("document.getElementById('det-year').open === true"),
);
const before = await evaluate("document.querySelector('.tile .value').textContent");
await tap("#facet-year input[value='2023']");
const after = await evaluate("document.querySelector('.tile .value').textContent");
check('ticking a year refilters', before !== after, `${before} → ${after}`);
check(
  'badge shows the active count',
  await evaluate("document.getElementById('count-year').hidden === false"),
);

// 4. Clear filters puts it back.
await tap('#reset');
const cleared = await evaluate("document.querySelector('.tile .value').textContent");
check('clear filters restores the slice', cleared === before, cleared);

// 5. A tap on the scatter selects a run and shows its readout. Scroll it into
// view first: a coordinate outside the viewport lands nowhere, and the filter
// row is tall enough to push the plot below the fold.
if (narrow) await evaluate("document.getElementById('filters').hidden = true");
const tapped = await evaluate(`(() => {
  const c = document.getElementById('scatter');
  c.scrollIntoView({ block: 'center' });
  const r = c.getBoundingClientRect();
  return { x: r.left + r.width * 0.5, y: r.top + r.height * 0.5, w: r.width };
})()`);
await call('Input.dispatchTouchEvent', {
  type: 'touchStart',
  touchPoints: [{ x: tapped.x, y: tapped.y }],
});
await call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await new Promise((r) => setTimeout(r, 2500));

check(
  'tap selects a run',
  await evaluate("!/^Waveforms$/.test(document.getElementById('wave-title').textContent)"),
  await evaluate("document.getElementById('wave-title').textContent"),
);
check(
  'tap shows the readout (no hover on touch)',
  await evaluate("document.getElementById('scatter-tip').hidden === false"),
);

// 5b. A readout summoned by a tap is pinned: it has a dismiss control, an axis
// change puts it away without dropping the run, and the × does the same.
check(
  'a tapped readout carries a dismiss button',
  await evaluate("document.querySelectorAll('#scatter-tip .tip-close').length === 1"),
);
const beforeAxis = await evaluate("document.getElementById('wave-title').textContent");
await evaluate(`(() => {
  const y = document.getElementById('axis-y');
  y.value = y.value === 'se_peak_dba' ? 'ml_peak_dba' : 'se_peak_dba';
  y.dispatchEvent(new Event('change'));
})()`);
await new Promise((r) => setTimeout(r, 600));
check(
  'changing a dimension dismisses the readout',
  await evaluate("document.getElementById('scatter-tip').hidden === true"),
);
check(
  'but the run stays selected',
  (await evaluate("document.getElementById('wave-title').textContent")) === beforeAxis,
  beforeAxis,
);

// The × dismisses without unselecting either.
await tap('#scatter');
if (await evaluate("document.querySelectorAll('#scatter-tip .tip-close').length === 1")) {
  const pinnedRun = await evaluate("document.getElementById('wave-title').textContent");
  // Aim just outside the visible button: on a phone the target is grown with a
  // negatively-inset ::after, and a hit area nothing dispatches to is no target.
  const edge = await evaluate(`(() => {
    const r = document.querySelector('#scatter-tip .tip-close').getBoundingClientRect();
    const el = document.elementFromPoint(r.left - 6, r.top + r.height / 2);
    return el ? el.closest('.tip-close') !== null : false;
  })()`);
  check('the grown hit area is what a near-miss lands on', narrow ? edge : true);
  await tap('#scatter-tip .tip-close');
  check(
    'the dismiss button closes the readout',
    await evaluate("document.getElementById('scatter-tip').hidden === true"),
  );
  check(
    'and leaves the run selected',
    (await evaluate("document.getElementById('wave-title').textContent")) === pinnedRun,
    pinnedRun,
  );
} else {
  check('the dismiss button closes the readout', false, 'no point under the tap');
}

// 6. Traces and full rate, on a run known to have waveforms — a tap lands
// wherever it lands, and not every run has a capture in the release set.
await call('Page.navigate', { url: `${base}#run=20` });
await new Promise((r) => setTimeout(r, 3500));
check(
  'traces load for a run that has them',
  await evaluate("document.querySelectorAll('#shots button').length > 0"),
  `${await evaluate("document.querySelectorAll('#shots button').length")} shot buttons`,
);
// The card opens framed on the blast, not on the whole 125 ms capture: the rig
// pre-triggers, so a full-window view is two fifths dead air.
const framing = await evaluate(`(() => {
  const m = document.getElementById('wave-hint').textContent.match(/([\\d.]+)–([\\d.]+) ms/);
  return m ? { from: +m[1], to: +m[2] } : null;
})()`);
check(
  'the view opens on the blast, not the whole window',
  framing && framing.to - framing.from < 40 && framing.from > 20,
  framing ? `${framing.from}–${framing.to} ms` : 'no framing in the hint',
);

// The first button is the way back to the overview, so pick a real shot.
await tap('#shots button:nth-child(2)');
check(
  'a shot loads at full rate',
  await evaluate("document.getElementById('derived').hidden === false"),
  await evaluate("document.getElementById('wave-hint').textContent.slice(0, 60)"),
);
check(
  'the hint reports the published figures for that shot',
  await evaluate(
    "/peak [\\d.]+ Pa .* impulse [\\d.]+ Pa·ms .* Leq\\(10ms\\) [\\d.]+ dBA/" +
      ".test(document.getElementById('wave-hint').textContent)",
  ),
  await evaluate("document.getElementById('wave-hint').textContent.slice(0, 90)"),
);

// A tap on the trace pins a readout, the same gesture the scatter uses.
await tap('#wave');
check(
  'a tap on the trace pins a readout',
  await evaluate("!document.getElementById('wave-tip').hidden"),
  (await evaluate("document.getElementById('wave-tip').innerText")).split('\n')[0],
);
await tap('#wave-tip .tip-close');
check(
  'the readout can be dismissed',
  await evaluate("document.getElementById('wave-tip').hidden"),
);

// Zooming is reversible, and the control only exists once there is a zoom.
check(
  'no reset control before anything is zoomed',
  await evaluate("document.getElementById('wave-reset').hidden"),
);
// Read the framing again rather than reusing the overview's: loading a shot may
// have widened the run's own view to reach a trough that fell outside it.
const framed = await evaluate(`(() => {
  const m = document.getElementById('wave-hint').textContent.match(/([\\d.]+)–([\\d.]+) ms/);
  return m ? +m[2] - +m[1] : null;
})()`);
const zoomed = await evaluate(`(() => {
  const c = document.getElementById('wave');
  c.scrollIntoView({ block: 'center' });
  const r = c.getBoundingClientRect();
  c.focus();
  for (let i = 0; i < 3; i++) {
    c.dispatchEvent(new KeyboardEvent('keydown', { key: '+', bubbles: true, cancelable: true }));
  }
  const m = document.getElementById('wave-hint').textContent.match(/([\\d.]+)–([\\d.]+) ms/);
  return m ? +m[2] - +m[1] : null;
})()`);
check(
  'the keyboard zooms in',
  framed !== null && zoomed !== null && zoomed < framed,
  `${framed?.toFixed(1)} → ${zoomed?.toFixed(1)} ms`,
);
await tap('#wave-reset');
check(
  'reset zoom restores the run framing',
  await evaluate(`(() => {
    const m = document.getElementById('wave-hint').textContent.match(/([\\d.]+)–([\\d.]+) ms/);
    return !!m && Math.abs((+m[2] - +m[1]) - ${framed}) < 0.2;
  })()`),
  await evaluate("document.getElementById('wave-hint').textContent.match(/[\\d.]+–[\\d.]+ ms/)[0]"),
);

// Picking a shot used to be a one-way door: nothing on the card went back.
await tap('#shots button:first-child');
check(
  'all shots returns to the overview',
  await evaluate(
    "document.getElementById('derived').hidden === true && " +
      "/min\\/max band per mic/.test(document.getElementById('wave-hint').textContent)",
  ),
);

// 7. The Z axis punches it into 3D and widens the frontier.
const frontier2D = await evaluate(
  "document.querySelectorAll('.tile')[1].querySelector('.value').textContent",
);
await evaluate(`(() => {
  const z = document.getElementById('axis-z');
  z.value = 'length_in';
  z.dispatchEvent(new Event('change'));
})()`);
await new Promise((r) => setTimeout(r, 600));
const frontier3D = await evaluate(
  "document.querySelectorAll('.tile')[1].querySelector('.value').textContent",
);
check(
  'a third objective can only grow the frontier',
  Number(frontier3D) >= Number(frontier2D),
  `${frontier2D} → ${frontier3D}`,
);
check(
  'the plot becomes rotatable',
  await evaluate("document.getElementById('scatter').classList.contains('rotatable')"),
);

// Dragging rotates rather than selecting.
const centre = await evaluate(`(() => {
  const c = document.getElementById('scatter');
  c.scrollIntoView({ block: 'center' });
  const r = c.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`);
const before3D = await evaluate("document.getElementById('wave-title').textContent");
await call('Input.dispatchTouchEvent', {
  type: 'touchStart',
  touchPoints: [{ x: centre.x, y: centre.y }],
});
for (const step of [12, 26, 44]) {
  await call('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: centre.x + step, y: centre.y + step / 2 }],
  });
}
await call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await new Promise((r) => setTimeout(r, 500));
check(
  'a drag rotates instead of selecting',
  (await evaluate("document.getElementById('wave-title').textContent")) === before3D,
);

await evaluate(`(() => {
  const z = document.getElementById('axis-z');
  z.value = '';
  z.dispatchEvent(new Event('change'));
})()`);
await new Promise((r) => setTimeout(r, 400));
check(
  'clearing Z returns to 2D',
  !(await evaluate("document.getElementById('scatter').classList.contains('rotatable')")),
);

// 8. The table groups frontier runs first, and the toggle turns it off.
const frontierRanks = async () =>
  evaluate(`[...document.querySelectorAll('#table-body tr')]
    .map((tr) => tr.classList.contains('frontier') ? 1 : 0)`);
let ranks = await frontierRanks();
const firstPlain = ranks.indexOf(0);
check(
  'frontier runs are listed first',
  firstPlain === -1 || !ranks.slice(firstPlain).includes(1),
  `${ranks.filter(Boolean).length} frontier rows, first plain row at ${firstPlain}`,
);

// Turning the grouping off must change the order. Checking "row 0 is no
// longer a frontier run" would be wrong: sorted by SE dBA the quietest run is
// legitimately on the frontier either way.
const rowOrder = () =>
  evaluate(`[...document.querySelectorAll('#table-body tr')]
    .slice(0, 12).map((tr) => tr.cells[2].textContent).join('|')`);
const groupedOrder = await rowOrder();
await tap('#frontier-first');
const plainOrder = await rowOrder();
check('the toggle turns the grouping off', groupedOrder !== plainOrder);
await tap('#frontier-first');
check(
  'turning it back on restores the grouping',
  (await rowOrder()) === groupedOrder,
);

// Hosts are listed by the name shown, not the raw code.
const hostNames = await evaluate(`[...document.querySelectorAll('#facet-cartridge label')]
  .map((l) => l.textContent.replace(/ \\(\\d+\\)$/, ''))`);
const sortedHosts = [...hostNames].sort((a, b) =>
  a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }),
);
check(
  'hosts sort by their displayed name',
  JSON.stringify(hostNames) === JSON.stringify(sortedHosts),
  hostNames.slice(0, 3).join(' | '),
);

// 9. Host attributes are filterable and plottable.
if (narrow) {
  await evaluate("document.getElementById('filters').hidden = false");
  await tap('#det-host_cycling summary');
}
const allRuns = await evaluate("document.querySelector('.tile .value').textContent");
await tap("#facet-host_cycling input[value='manual']");
const manualOnly = await evaluate("document.querySelector('.tile .value').textContent");
check(
  'action filters the slice',
  manualOnly !== allRuns && Number(manualOnly.replace(/,/g, '')) > 0,
  `${allRuns} → ${manualOnly} manual-action runs`,
);
await tap("#facet-host_cycling input[value='manual']");

// The axis menus carry two dozen measures; grouped, with the mic name said once
// per heading instead of on every line.
const menu = await evaluate(`(() => {
  const s = document.getElementById('axis-y');
  return {
    groups: s.querySelectorAll('optgroup').length,
    loose: [...s.children].filter((c) => c.tagName === 'OPTION').length,
    options: s.options.length,
    repeats: [...s.options].filter((o) => !o.selected && /^shooter's ear, /.test(o.textContent)).length,
  };
})()`);
check('axis measures are grouped', menu.groups >= 4 && menu.loose === 0,
  `${menu.options} measures in ${menu.groups} groups`);
check('the group heading is not repeated on every option', menu.repeats === 0);
// A collapsed select shows the selected option alone, with no heading over it,
// so that one keeps the group in its text while its siblings drop it.
const closed = await evaluate(`(() => {
  const o = document.getElementById('axis-y').selectedOptions[0];
  const group = o.parentElement.label;
  return { text: o.textContent, group, names: o.textContent.toLowerCase().startsWith(group.toLowerCase()) };
})()`);
check('the closed control still names the mic', closed.names, closed.text);

check(
  'barrel length is offered as an axis',
  await evaluate(`[...document.querySelectorAll('#axis-x option')]
    .some((o) => o.value === 'host_barrel_in')`),
);

const setAxis = async (id, value) => {
  await evaluate(`(() => {
    const s = document.getElementById(${JSON.stringify(id)});
    s.value = ${JSON.stringify(value)};
    s.dispatchEvent(new Event('change'));
  })()`);
  await new Promise((r) => setTimeout(r, 500));
};
const frontierCount = () =>
  evaluate("document.querySelectorAll('.tile')[1].querySelector('.value').textContent");
const hint = () => evaluate("document.getElementById('scatter-hint').textContent");

// One dimension on an axis drops out of the frontier rather than cancelling
// it: the remaining objective still has a frontier.
await setAxis('axis-x', 'host_barrel_in');
check(
  'a dimension drops out, leaving a frontier over the rest',
  Number(await frontierCount()) > 0,
  `${await frontierCount()} on the frontier over the objective axis alone`,
);
check(
  'and the hint says the dimension is not constraining it',
  (await hint()).includes('does not constrain the frontier'),
);

// A dimension on every axis leaves nothing to optimise.
await setAxis('axis-y', 'year');
check(
  'all-dimension axes have no frontier',
  (await frontierCount()) === '0' && (await hint()).includes('No frontier here'),
);

await setAxis('axis-y', 'se_peak_dba');
await setAxis('axis-x', 'weight_oz');

// 10. The four derived analyses are present and behave.
await setAxis('axis-y', 'se_reduction_dba');
check(
  'net reduction is a maximise measure',
  (await hint()).includes('a higher'),
  (await hint()).slice(-72),
);
await setAxis('axis-y', 'se_first_round_pop');
check('first-round pop is offered and minimises', (await hint()).includes('a lower'));
await setAxis('axis-y', 'se_peak_dba');

// Uncertainty reaches the tooltip.
await evaluate(`(() => {
  const c = document.getElementById('scatter');
  c.scrollIntoView({ block: 'center' });
})()`);
const withError = await evaluate(`(() => {
  const rows = document.querySelectorAll('#table-body tr');
  rows[0].click();
  return true;
})()`);
await new Promise((r) => setTimeout(r, 1200));
check(
  'a spectrum is drawn for the selected run',
  await evaluate("document.getElementById('spectrum-wrap').hidden === false"),
);
check(
  'the spectrum names its mics',
  (await evaluate("document.querySelectorAll('#spectrum-legend .item').length")) > 0,
);
// Raw third-octave levels climb ~1 dB per band from bandwidth alone, so the
// plotted curve must be per-Hz or it slopes up regardless of the sound.
const density = await evaluate(`(async () => {
  const bands = await (await fetch('data/bands.json')).json();
  const levels = Object.values(Object.values(bands.runs)[0])[0];
  const w = 2 ** (1 / 6) - 2 ** (-1 / 6);
  const at = (i) => levels[i] - 10 * Math.log10(bands.centres[i] * w);
  const raw = levels.at(-1) - levels[0];
  return { raw, perHz: at(levels.length - 1) - at(0) };
})()`);
// Raw levels climb because bands widen; per-Hz must not inherit that slope.
check(
  'the spectrum is plotted per Hz, not as raw band levels',
  density.perHz < density.raw - 20,
  `raw ${density.raw.toFixed(0)} dB top-to-bottom, per Hz ${density.perHz.toFixed(0)} dB`,
);
check(
  'the caption explains the per-Hz conversion',
  (await evaluate("document.getElementById('spectrum-wrap').textContent")).replace(/\s+/g, ' ').includes('per Hz'),
);

// Error bars: the standard error of a five-shot mean is the whole point of the
// uncertainty pass, so a sparse plot has to actually draw them. The full 1,176
// runs are deliberately over the threshold, so narrow to one host first.
const sparse = await evaluate(`(() => {
  const tick = (facet, value) => {
    const box = [...document.querySelectorAll(facet + ' input')].find((i) => i.value === value);
    box.checked = true;
    box.dispatchEvent(new Event('change'));
  };
  tick('#facet-cartridge', '5.56-16AR');
  tick('#facet-year', '2024');
  return Number(document.querySelector('.tile .value').textContent.replace(/,/g, ''));
})()`);
await new Promise((r) => setTimeout(r, 400));
check('narrowed below the error-bar threshold', sparse <= 220, `${sparse} runs`);

const setY = async (key) => {
  await evaluate(`(() => {
    const y = document.getElementById('axis-y');
    y.value = ${JSON.stringify(key)};
    y.dispatchEvent(new Event('change'));
  })()`);
  await new Promise((r) => setTimeout(r, 400));
  return evaluate("document.getElementById('bar-legend').hidden === false");
};
check('a sparse plot draws error bars', await setY('se_peak_dba'));
// Net reduction is derived from two shot-averaged means, so it has no spread of
// its own; claiming a standard error there would be inventing one.
check('a measure without a standard error draws none', !(await setY('se_reduction_dba')));

// 11. Nothing overflows the viewport horizontally.
const overflow = await evaluate(
  'document.documentElement.scrollWidth - document.documentElement.clientWidth',
);
check('no horizontal overflow', overflow <= 0, `${overflow}px`);

// 12. Touch targets are big enough to hit.
const small = await evaluate(`(() => {
  // A control may keep a small border box and grow its hit area with a
  // negatively-inset ::after, so measure what a finger actually lands on.
  const reach = (el) => {
    const after = getComputedStyle(el, '::after');
    if (after.content === 'none' || after.position !== 'absolute') return 0;
    const grow = (v) => Math.max(0, -parseFloat(v) || 0);
    return grow(after.top) + grow(after.bottom);
  };
  const bad = [];
  for (const el of document.querySelectorAll('button, select, input, summary')) {
    if (el.offsetParent === null) continue;
    const r = el.getBoundingClientRect();
    const h = r.height + reach(el);
    if (r.height > 0 && h < 32) bad.push((el.id || el.className || el.tagName) + ':' + Math.round(h));
  }
  return bad;
})()`);
check('touch targets at least 32px tall', small.length === 0, small.join(', '));

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
socket.close();
process.exit(failures ? 1 : 0);

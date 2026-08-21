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

// 5. A tap on the scatter selects a run and shows its readout.
if (narrow) await evaluate("document.getElementById('filters').hidden = true");
const tapped = await evaluate(`(() => {
  const c = document.getElementById('scatter');
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

// 6. Traces and full rate, on a run known to have waveforms — a tap lands
// wherever it lands, and 2026 is published as tables only.
await call('Page.navigate', { url: `${base}#run=20` });
await new Promise((r) => setTimeout(r, 3500));
check(
  'traces load for a run that has them',
  await evaluate("document.querySelectorAll('#shots button').length > 0"),
  `${await evaluate("document.querySelectorAll('#shots button').length")} shot buttons`,
);
await tap('#shots button');
check(
  'a shot loads at full rate',
  await evaluate("document.getElementById('derived').hidden === false"),
  await evaluate("document.getElementById('wave-hint').textContent.slice(0, 60)"),
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
  const r = document.getElementById('scatter').getBoundingClientRect();
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

// 8. Nothing overflows the viewport horizontally.
const overflow = await evaluate(
  'document.documentElement.scrollWidth - document.documentElement.clientWidth',
);
check('no horizontal overflow', overflow <= 0, `${overflow}px`);

// 9. Touch targets are big enough to hit.
const small = await evaluate(`(() => {
  const bad = [];
  for (const el of document.querySelectorAll('button, select, input, summary')) {
    if (el.offsetParent === null) continue;
    const r = el.getBoundingClientRect();
    if (r.height > 0 && r.height < 32) bad.push((el.id || el.tagName) + ':' + Math.round(r.height));
  }
  return bad;
})()`);
check('touch targets at least 32px tall', small.length === 0, small.join(', '));

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
socket.close();
process.exit(failures ? 1 : 0);

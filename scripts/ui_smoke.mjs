/**
 * Drive the explorer in a real browser and assert it responds.
 *
 *   npm run build && ln -s ../web/data dist/data
 *   python3 scripts/serve.py --directory dist &
 *   chromium --headless --remote-debugging-port=9222 --no-sandbox about:blank &
 *   node scripts/ui_smoke.mjs [url] [width] [height]
 *
 * Screenshots prove the page renders; this proves it *works* — that the host
 * picker changes the field, that a filter narrows it, that a tap opens a run
 * and loads its traces, that compare and the can page hold together, and that
 * the URL carries all of it. Uses CDP directly so there is no test-runner
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
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent?.trim() ?? ''`);
const count = (selector) => evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
const hash = () => evaluate('location.hash');
const go = async (fragment) => {
  await evaluate(`location.hash = ${JSON.stringify(fragment)}`);
  await wait(900);
};
const narrow = Number(width) <= 760;

// 1. It opens on the default host, ranked, with a real field.
const title = await text('h1');
check('opens on 5.56, 16" AR', title.includes('5.56, 16" AR'), title);
const rows = await count('.ranked ol li');
check('the ranked list has rows', rows >= 10, `${rows} rows`);
check('the leader is bracketed as a tie', narrow || (await count('.bracket')) === 1);
check('the year flag is up for a mixed field', (await text('.flag')).includes('years mixed'));

// 2. The host picker changes the field and says so in the URL.
await tap('h1 button');
check('the host picker opens', await evaluate("document.querySelector('dialog[aria-labelledby=host-title]').open"));
const hosts = await count('dialog .card, dialog .row');
check('every host is listed, none hidden', hosts >= 50, `${hosts} hosts`);
await evaluate(`[...document.querySelectorAll('dialog .card')].find((c) => c.textContent.includes('.308, 20" bolt')).click()`);
await wait(600);
check('picking a host retitles the page', (await text('h1')).includes('.308, 20" bolt'));
check('and puts it in the URL', (await hash()).includes('host=.308-20BA'), await hash());

// 3. A year filter narrows the field, and Clear puts it back.
const before = await count('.ranked ol li');
const total = await text('.more .dim');
if (narrow) await tap('.bar .toggle');
await tap('.filters .pill[aria-pressed="true"]');
const narrowed = await text('.more .dim');
check('a year pill narrows the field', narrowed !== total, `${total} → ${narrowed}`);
check('the filter lands in the URL', (await hash()).includes('years='), await hash());
await evaluate("document.querySelector('.clear')?.click()");
await wait(400);
check('clear restores the field', (await text('.more .dim')) === total && before > 0);

// 4. Picking a run writes it up and loads its traces.
await tap('.ranked ol li:nth-child(2) button');
await wait(1500);
const article = await text('article h2');
check('a tap opens the run', article.length > 0, article);
check('the run is in the URL', /run=\d+/.test(await hash()), await hash());
const drawn = await evaluate(`(() => {
  const c = document.querySelector('article canvas');
  if (!c) return 0;
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let inked = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 0) inked++;
  return inked;
})()`);
check('the waveform draws', drawn > 1000, `${drawn} px`);
check('the spectrum draws', (await count('article figure svg path')) >= 1);

// 5. Listen plays. A shot is ~125 ms of sound, over before any poll would
// catch it, so watch for the button ever reporting that it is playing.
await evaluate(`(() => {
  const button = document.querySelector('article .actions .btn.solid');
  window.__played = false;
  new MutationObserver(() => {
    if (button.getAttribute('aria-pressed') === 'true') window.__played = true;
  }).observe(button, { attributes: true });
})()`);
await tap('article .actions .btn.solid');
await wait(2500);
check('Listen plays the shot', await evaluate('window.__played'));

// 6. Compare: two runs from the list, the tray, the page.
await tap('article .actions .btn:not(.solid)');
if (narrow) await tap('article .close');
await tap('.ranked ol li:nth-child(1) button');
await wait(600);
await tap('article .actions .btn:not(.solid)');
if (narrow) await tap('article .close');
check('the compare tray shows the set', (await count('.tray li')) === 2);
await tap('.tray .btn');
await wait(1500);
check('the compare page opens', (await hash()).includes('page=compare'));
check('it tabulates both', (await count('thead th[scope=col]')) === 2);
check('best values are marked', (await count('td.best')) > 0);

// 7. A can's page gathers every host it was tested on.
await go('#can=otter-creek-labs/hydrogenl');
check('the can page names the can', (await text('h1')).includes('Hydrogen L'));
check('it lists all six hosts', (await count('tbody tr')) === 6);
check('and notes the merged spellings', (await text('aside')).includes('merged'));

// 8. Links from the old explorer still land on their run.
await go('#run=20&shot=296');
const old = await text('article h2');
check('an old #run= link opens its run', old.length > 0, old);

// 9. Trade-off: axes in the URL, a frontier, and a 3D mode.
await go('#view=trade');
check('the trade-off view draws a frontier', (await count('aside ol li')) > 0);
await go('#view=trade&y=se_reduction_dba');
check('a maximise measure keeps a frontier', (await count('aside ol li')) > 0);
await go('#view=trade&x=year');
// Year is a condition, not an objective: it drops out and the frontier is
// over the other axis alone, which one run wins.
check('a dimension on an axis drops out of the frontier', (await count('aside ol li')) === 1);
await go('#view=trade&z=length_in');
check('a third axis rotates', await evaluate("document.querySelector('canvas.rotatable') !== null"));

// 10. Search goes straight to a can.
await go('');
await evaluate(`(() => {
  const input = document.querySelector('input[aria-label="Find a suppressor"]');
  input.focus();
  input.value = 'hydrogen';
  input.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
await wait(300);
check('search suggests cans', (await count('#can-hits li')) > 0);

// 11. Nothing overflows the viewport horizontally.
await go('');
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
    if (el.offsetParent === null || el.closest('dialog:not([open])')) continue;
    const r = el.getBoundingClientRect();
    const h = r.height + reach(el);
    if (r.height > 0 && h < 32) bad.push((el.getAttribute('aria-label') || el.textContent.trim().slice(0, 20) || el.tagName) + ':' + Math.round(h));
  }
  return bad;
})()`);
check('touch targets at least 32px tall', !narrow || small.length === 0, small.join(', '));

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
socket.close();
process.exit(failures ? 1 : 0);

/**
 * Unit tests for the browser-side catalog helpers.
 *
 *   node web/test.mjs
 *
 * These cover the parts a UI leans on hardest -- filtering and Pareto search --
 * with hand-checked cases, including the null handling that decides whether a
 * suppressor with no recorded weight quietly wins every frontier.
 */

import assert from 'node:assert/strict';
import { selection, rows, paretoFront } from './tbacss.js';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (error) {
    console.error(`FAIL ${name}\n  ${error.message}`);
    process.exitCode = 1;
  }
}

/** Minimal stand-in for a loaded catalog. */
function table(columns, dictionaries = {}) {
  const n = Object.values(columns)[0].length;
  const typed = {};
  for (const [name, values] of Object.entries(columns)) {
    typed[name] = dictionaries[name]
      ? Int32Array.from(values)
      : Float64Array.from(values, (v) => (v === null ? NaN : v));
  }
  return { n, columns: typed, dictionaries };
}

const CATALOG = table(
  {
    manufacturer: [0, 1, 0, 2, 1],
    se_peak_dba: [140.0, 138.5, 141.2, 138.5, 139.0],
    weight_oz: [16.0, 22.0, 12.0, 20.0, null],
    length_in: [6.0, 7.5, 5.0, 7.0, 6.5],
  },
  { manufacturer: ['TBAC', 'FCA', 'Banish'] },
);

test('range filter keeps rows inside the bounds', () => {
  const mask = selection(CATALOG, { se_peak_dba: [null, 139.0] });
  assert.deepEqual(rows(CATALOG, mask), [1, 3, 4]);
});

test('range filter drops rows whose value is null', () => {
  const mask = selection(CATALOG, { weight_oz: [0, 100] });
  assert.deepEqual(rows(CATALOG, mask), [0, 1, 2, 3]);
});

test('dictionary filter matches by string, not code', () => {
  const mask = selection(CATALOG, { manufacturer: new Set(['FCA']) });
  assert.deepEqual(rows(CATALOG, mask), [1, 4]);
});

test('filters compose', () => {
  const mask = selection(CATALOG, {
    manufacturer: new Set(['TBAC', 'Banish']),
    se_peak_dba: [null, 140.5],
  });
  assert.deepEqual(rows(CATALOG, mask), [0, 3]);
});

test('an unknown column is an error, not a silent pass', () => {
  assert.throws(() => selection(CATALOG, { nope: [0, 1] }), /no column nope/);
});

test('pareto front on quiet-and-light', () => {
  // rows: (dBA, oz) = 0:(140,16) 1:(138.5,22) 2:(141.2,12) 3:(138.5,20) 4:(139,null)
  // Row 4 is excluded for the null. Row 1 is dominated by row 3 (same dBA,
  // lighter). Row 0 is dominated by nothing quieter *and* lighter. Row 2 is
  // the lightest, row 3 the quietest.
  const front = paretoFront(CATALOG, [
    { column: 'se_peak_dba', direction: 'min' },
    { column: 'weight_oz', direction: 'min' },
  ]);
  assert.deepEqual(front, [0, 2, 3]);
});

test('pareto excludes rows with a null objective', () => {
  const front = paretoFront(CATALOG, [
    { column: 'weight_oz', direction: 'min' },
  ]);
  assert.ok(!front.includes(4), 'row with null weight must not win the frontier');
});

test('pareto honours direction', () => {
  const heaviest = paretoFront(CATALOG, [
    { column: 'weight_oz', direction: 'max' },
  ]);
  assert.deepEqual(heaviest, [1]);
});

test('pareto respects an incoming mask', () => {
  const mask = selection(CATALOG, { manufacturer: new Set(['TBAC']) });
  const front = paretoFront(
    CATALOG,
    [
      { column: 'se_peak_dba', direction: 'min' },
      { column: 'weight_oz', direction: 'min' },
    ],
    mask,
  );
  assert.deepEqual(front, [0, 2]);
});

test('a single objective yields the minimum', () => {
  const front = paretoFront(CATALOG, [
    { column: 'se_peak_dba', direction: 'min' },
  ]);
  assert.deepEqual(front, [1, 3]); // tie at 138.5, neither dominates
});

test('pareto over three objectives stays consistent', () => {
  const front = paretoFront(CATALOG, [
    { column: 'se_peak_dba', direction: 'min' },
    { column: 'weight_oz', direction: 'min' },
    { column: 'length_in', direction: 'min' },
  ]);
  // Adding an objective can only grow the frontier.
  const two = paretoFront(CATALOG, [
    { column: 'se_peak_dba', direction: 'min' },
    { column: 'weight_oz', direction: 'min' },
  ]);
  assert.ok(two.every((i) => front.includes(i)));
});

console.log(`${passed} passed`);

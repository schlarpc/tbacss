/**
 * The explorer's rules, against a hand-built catalog small enough to check by
 * eye: which runs a filter keeps, who is tied with whom, what the frontier is,
 * how hosts are grouped, and how the URL round-trips.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Columns, Host } from '../../web/src/tbacss.ts';
import {
  NO_FILTERS,
  frontierOf,
  hostTiers,
  leaderTieDepth,
  nameOf,
  rankOnHost,
  rankOrder,
  runsOfCan,
  searchCans,
  tiedWith,
  visibleRows,
  yearSpan,
  yearsIn,
} from '../../web/src/lib/explore.ts';
import type { Cat } from '../../web/src/lib/explore.ts';
import { DEFAULTS, formatRoute, parseRoute } from '../../web/src/lib/route.ts';
import { fmt } from '../../web/src/lib/measures.ts';

const host = (label: string, platform = 'AR'): Host => ({
  label,
  description: '',
  barrel_in: null,
  barrel_source: null,
  cycling: null,
  platform,
  integral: false,
  subsonic: null,
  grains: null,
});

function catalog(): Cat {
  const raw: Record<string, (number | null)[]> = {
    //                 0      1      2      3      4      5      6
    cartridge: [0, 0, 0, 1, 2, 0, 1],
    can: [0, 1, 2, 0, 3, 4, 1],
    manufacturer: [0, 1, 1, 0, 2, 3, 1],
    caliber: [0, 0, 1, 0, 1, 0, 0],
    year: [2024, 2024, 2025, 2024, 2023, 2024, 2025],
    is_baseline: [0, 0, 0, 0, 0, 1, 0],
    se_peak_dba: [137.0, 137.6, 140.0, 125.0, 121.0, 156.0, 130.0],
    se_peak_dba_sem: [0.5, 0.2, 0.1, 0.4, 0.3, null, 0.5],
    weight_oz: [18.9, 12.7, 3.8, 18.9, 13.9, null, 12.7],
  };
  const dictionaries: Record<string, string[]> = {
    cartridge: ['5.56-16AR', '.308-20BA', '.308'],
    can: ['rd/ls5ti', 'silencerco/velos', 'silencerco/nano', 'x/y', 'bare-muzzle/bare'],
    manufacturer: ['RD', 'Silencer Co', 'X', 'Bare'],
    caliber: ['.223', '.30'],
  };
  const columns: Columns = {};
  for (const [name, values] of Object.entries(raw)) {
    columns[name] = dictionaries[name]
      ? Int32Array.from(values, (v) => v ?? -1)
      : Float64Array.from(values, (v) => (v === null ? NaN : v));
  }
  return {
    n: 7,
    ids: [10, 11, 12, 13, 14, 15, 16],
    columns: columns as Cat['columns'],
    dictionaries,
    hosts: {
      '5.56-16AR': host('5.56, 16" AR'),
      '.308-20BA': host('.308, 20" bolt', 'bolt'),
      '.308': host('.308, 20" bolt (2023)', 'bolt'),
    },
    cans: {
      'rd/ls5ti': { maker: 'RD', model: 'LS5TI' },
      'silencerco/velos': { maker: 'SilencerCo', model: 'Velos' },
      'silencerco/nano': { maker: 'SilencerCo', model: 'Nano' },
      'x/y': { maker: 'X', model: 'Y' },
      'bare-muzzle/bare': { maker: 'Bare Muzzle', model: 'Bare' },
    },
  };
}

const CAT = catalog();

test('reference runs are never results', () => {
  assert.deepEqual(visibleRows(CAT, NO_FILTERS), [0, 1, 2, 3, 4, 6]);
});

test('a host filter keeps only that host', () => {
  assert.deepEqual(visibleRows(CAT, { ...NO_FILTERS, host: '5.56-16AR' }), [0, 1, 2]);
});

test('years are a set, not a range', () => {
  const kept = visibleRows(CAT, { ...NO_FILTERS, years: [2023, 2025] });
  assert.deepEqual(yearsIn(CAT, kept), [2023, 2025]);
});

test('makers filter on the settled name, not the spelling in the row', () => {
  assert.deepEqual(visibleRows(CAT, { ...NO_FILTERS, makers: ['SilencerCo'] }), [1, 2, 6]);
  assert.deepEqual(nameOf(CAT, 1), { maker: 'SilencerCo', model: 'Velos' });
});

test('weight ranges are inclusive and drop missing weights', () => {
  assert.deepEqual(visibleRows(CAT, { ...NO_FILTERS, weight: [12.7, 13.9] }), [1, 4, 6]);
});

test('ranking is best first and skips missing values', () => {
  assert.deepEqual(rankOrder(CAT, [0, 1, 2], 'se_peak_dba'), [0, 1, 2]);
});

test('ties use both errors in quadrature at 2 sigma', () => {
  // |137.0 - 137.6| = 0.6 < 2 * hypot(0.5, 0.2) = 1.08; 140.0 is well clear.
  assert.deepEqual(tiedWith(CAT, [0, 1, 2], 'se_peak_dba', 0), [1]);
  assert.equal(leaderTieDepth(CAT, [0, 1, 2], 'se_peak_dba'), 1);
});

test('a measure with no error bar ties with nothing', () => {
  assert.deepEqual(tiedWith(CAT, [0, 1, 2], 'weight_oz', 0), []);
});

test('the frontier drops dimensions instead of cancelling', () => {
  const rows = [0, 1, 2];
  assert.deepEqual([...frontierOf(CAT, rows, ['weight_oz', 'se_peak_dba'])].sort(), [0, 1, 2]);
  assert.deepEqual([...frontierOf(CAT, rows, ['year', 'se_peak_dba'])], [0]);
  assert.equal(frontierOf(CAT, rows, ['year']).size, 0);
});

test('hosts are tiered, and a 2023 code sits under its successor', () => {
  const tiers = hostTiers(CAT);
  assert.deepEqual(tiers.regular.map((h) => h.code), ['5.56-16AR', '.308-20BA']);
  assert.deepEqual(tiers.y2023.map((h) => h.code), ['.308']);
  assert.deepEqual(tiers.regular[1].earlier, { code: '.308', runs: 1 });
});

test('year spans read like the design', () => {
  assert.equal(yearSpan([2024, 2025, 2026]), '2024–26');
  assert.equal(yearSpan([2023]), '2023');
});

test('a can gathers its runs across hosts, and ranks within each', () => {
  assert.deepEqual(runsOfCan(CAT, 'silencerco/velos'), [1, 6]);
  assert.deepEqual(rankOnHost(CAT, 1, 'se_peak_dba'), { rank: 2, of: 3 });
  assert.deepEqual(rankOnHost(CAT, 6, 'se_peak_dba'), { rank: 2, of: 2 });
});

test('search finds cans by any word, model hits first', () => {
  assert.deepEqual(searchCans(CAT, 'silencerco').map((h) => h.model).sort(), ['Nano', 'Velos']);
  assert.equal(searchCans(CAT, 'vel')[0].model, 'Velos');
  assert.deepEqual(searchCans(CAT, ''), []);
});

test('numbers print with a real minus sign', () => {
  assert.equal(fmt(-0.05, 2), '−0.05');
  assert.equal(fmt(1.03, 2, { sign: true }), '+1.03');
  assert.equal(fmt(NaN), '—');
});

test('the default route has an empty hash', () => {
  assert.equal(formatRoute(DEFAULTS), '');
});

test('a route round-trips through the hash', () => {
  const route = {
    ...DEFAULTS,
    host: '5.56-16AR',
    view: 'trade' as const,
    years: [2024, 2025],
    makers: ['SilencerCo'],
    weight: [3.8, null] as [number, null],
    z: 'length_in',
    run: 1853,
    shot: 296,
  };
  assert.deepEqual(parseRoute(formatRoute(route)), route);
});

test('links from the previous explorer still parse', () => {
  const route = parseRoute('#run=20&shot=296');
  assert.equal(route.page, 'explore');
  assert.equal(route.run, 20);
  assert.equal(route.shot, 296);
  assert.equal(route.host, null);
});

test('can and compare pages have their own routes', () => {
  assert.equal(parseRoute('#can=otter-creek-labs/hydrogenl').page, 'can');
  const compare = parseRoute('#page=compare&cmp=1,2,3,4,5');
  assert.equal(compare.page, 'compare');
  assert.deepEqual(compare.compare, [1, 2, 3, 4]);
});

test('an unknown measure in a link falls back rather than breaking the page', () => {
  assert.equal(parseRoute('#x=bogus').x, DEFAULTS.x);
});

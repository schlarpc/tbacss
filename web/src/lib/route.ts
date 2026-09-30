/**
 * The URL hash is the page's whole state, so any view can be linked.
 *
 *   #host=5.56-16AR&view=trade&x=weight_oz&run=1853&shot=296
 *   #page=compare&cmp=1853,1810,1690
 *   #can=otter-creek-labs/hydrogenl
 *
 * Defaults are left out, so the plain page has a plain URL. Links from the
 * previous explorer (`#run=20&shot=296`) are a subset of this and still work.
 */

import type { Range } from '../tbacss.ts';
import { isMeasure } from './measures.ts';

export type Page = 'explore' | 'compare' | 'can';
export type View = 'rank' | 'trade';

export interface Route {
  page: Page;
  /** A host code, 'all', or null for "not said" (the page picks one). */
  host: string | null;
  view: View;
  years: number[];
  calibers: string[];
  makers: string[];
  weight: Range | null;
  length: Range | null;
  /** The measure the ranked list is ordered by. */
  by: string;
  x: string;
  y: string;
  z: string | null;
  run: number | null;
  shot: number | null;
  compare: number[];
  can: string | null;
}

export const DEFAULTS: Route = {
  page: 'explore',
  host: null,
  view: 'rank',
  years: [],
  calibers: [],
  makers: [],
  weight: null,
  length: null,
  by: 'se_peak_dba',
  x: 'weight_oz',
  y: 'se_peak_dba',
  z: null,
  run: null,
  shot: null,
  compare: [],
  can: null,
};

const list = (value: string | null) => (value ? value.split(',').filter(Boolean) : []);
const ints = (value: string | null) => list(value).map(Number).filter(Number.isInteger);

function range(value: string | null): Range | null {
  if (!value) return null;
  const [a, b] = value.split('~');
  const lo = a === '' || a === undefined ? null : Number(a);
  const hi = b === '' || b === undefined ? null : Number(b);
  if ((lo !== null && !Number.isFinite(lo)) || (hi !== null && !Number.isFinite(hi))) return null;
  return lo === null && hi === null ? null : [lo, hi];
}

const intOrNull = (value: string | null) =>
  value !== null && Number.isInteger(Number(value)) ? Number(value) : null;

const measureOr = (value: string | null, fallback: string) => (isMeasure(value) ? value : fallback);

export function parseRoute(hash: string): Route {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const can = params.get('can');
  const page: Page = can ? 'can' : params.get('page') === 'compare' ? 'compare' : 'explore';
  return {
    page,
    host: params.get('host'),
    view: params.get('view') === 'trade' ? 'trade' : 'rank',
    years: ints(params.get('years')),
    calibers: list(params.get('cal')),
    makers: list(params.get('maker')),
    weight: range(params.get('w')),
    length: range(params.get('l')),
    by: measureOr(params.get('by'), DEFAULTS.by),
    x: measureOr(params.get('x'), DEFAULTS.x),
    y: measureOr(params.get('y'), DEFAULTS.y),
    z: isMeasure(params.get('z')) ? params.get('z') : null,
    run: intOrNull(params.get('run')),
    shot: intOrNull(params.get('shot')),
    compare: ints(params.get('cmp')).slice(0, 4),
    can,
  };
}

const rangeText = ([lo, hi]: Range) => `${lo ?? ''}~${hi ?? ''}`;

export function formatRoute(route: Route): string {
  const params = new URLSearchParams();
  const put = (key: string, value: string | null | undefined) => {
    if (value) params.set(key, value);
  };
  if (route.page === 'can') put('can', route.can);
  if (route.page === 'compare') put('page', 'compare');
  put('host', route.host);
  if (route.view !== DEFAULTS.view) put('view', route.view);
  put('years', route.years.join(','));
  put('cal', route.calibers.join(','));
  put('maker', route.makers.join(','));
  if (route.weight) put('w', rangeText(route.weight));
  if (route.length) put('l', rangeText(route.length));
  if (route.by !== DEFAULTS.by) put('by', route.by);
  if (route.x !== DEFAULTS.x) put('x', route.x);
  if (route.y !== DEFAULTS.y) put('y', route.y);
  put('z', route.z);
  if (route.run !== null) put('run', String(route.run));
  if (route.shot !== null) put('shot', String(route.shot));
  put('cmp', route.compare.join(','));
  // URLSearchParams escapes "/" and "," which are safe in a fragment and much
  // easier to read in a pasted link.
  const text = params.toString().replaceAll('%2F', '/').replaceAll('%2C', ',').replaceAll('%7E', '~');
  return text ? `#${text}` : '';
}

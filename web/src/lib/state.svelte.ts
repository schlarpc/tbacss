/**
 * The page's state. The route -- the URL hash -- is the source of truth, and
 * everything the page shows is derived from it and the loaded bundle, so any
 * view is a link and the back button does what it says.
 */

import { loadBundle } from '../tbacss.ts';
import type { Bundle } from '../tbacss.ts';
import {
  NO_FILTERS,
  frontierOf,
  hostOf,
  indexOfRun,
  rankOrder,
  visibleRows,
  yearsIn,
} from './explore.ts';
import type { Filters } from './explore.ts';
import { DEFAULTS, formatRoute, parseRoute } from './route.ts';
import type { Route } from './route.ts';
import type { Playing } from './audio.ts';

/** What a first visit opens on: the biggest regular host, removable. */
export const DEFAULT_HOST = '5.56-16AR';
export const MAX_COMPARE = 4;

function storedRate(): number {
  try {
    const value = Number(localStorage.getItem('tbacss-rate'));
    return [1, 1 / 4, 1 / 16, 1 / 64].includes(value) ? value : 1;
  } catch {
    return 1;
  }
}

class AppState {
  bundle = $state.raw<Bundle | null>(null);
  error = $state<string | null>(null);
  route = $state<Route>(parseRoute(location.hash));
  hostPickerOpen = $state(false);
  glossaryOpen = $state(false);
  /** The clip Listen is playing, for a playhead. */
  playing = $state<Playing | null>(null);
  /** Playback speed: 1 is real time; slower also lowers the pitch. */
  rate = $state(storedRate());

  cat = $derived(this.bundle?.catalog ?? null);

  /** The selected run's row, or null. */
  selected = $derived.by(() => {
    if (!this.cat || this.route.run === null) return null;
    const i = indexOfRun(this.cat, this.route.run);
    return i < 0 ? null : i;
  });

  /**
   * The host in view: what the link says, else the selected run's own host
   * (so an old `#run=` link lands among its peers), else the default. 'all'
   * is every host at once.
   */
  host = $derived.by((): string | null => {
    const asked = this.route.host;
    if (asked === 'all') return null;
    if (asked && this.cat?.hosts[asked]) return asked;
    if (this.cat && this.selected !== null) return hostOf(this.cat, this.selected);
    return this.cat?.hosts[DEFAULT_HOST] ? DEFAULT_HOST : null;
  });

  /** Every run on the host in view, before any other filter. */
  field = $derived(this.cat ? visibleRows(this.cat, { ...NO_FILTERS, host: this.host }) : []);
  hostYears = $derived(this.cat ? yearsIn(this.cat, this.field) : []);
  /**
   * The year filter as it applies to this host. A year the host was never
   * tested in drops out rather than emptying the page -- a link or a host
   * change can carry one over -- and none left means every year.
   */
  activeYears = $derived(this.route.years.filter((y) => this.hostYears.includes(y)));

  filters = $derived<Filters>({
    ...NO_FILTERS,
    host: this.host,
    years: this.activeYears,
    calibers: this.route.calibers,
    makers: this.route.makers,
    weight: this.route.weight,
    length: this.route.length,
  });

  /** Filters beyond the host, for the phone's "Filters · n" badge. */
  filterCount = $derived(
    this.activeYears.length +
      this.route.calibers.length +
      this.route.makers.length +
      (this.route.weight ? 1 : 0) +
      (this.route.length ? 1 : 0),
  );

  visible = $derived(this.cat ? visibleRows(this.cat, this.filters) : []);
  years = $derived(this.cat ? yearsIn(this.cat, this.visible) : []);
  ranked = $derived(this.cat ? rankOrder(this.cat, this.visible, this.route.by) : []);

  axisKeys = $derived(
    this.route.z ? [this.route.x, this.route.y, this.route.z] : [this.route.x, this.route.y],
  );
  /** No frontier across hosts: numbers from different guns do not compare. */
  frontier = $derived(
    this.cat && this.host ? frontierOf(this.cat, this.visible, this.axisKeys) : new Set<number>(),
  );

  /** Compared runs as row indices, in the order they were added. */
  compared = $derived(
    this.cat ? this.route.compare.map((id) => indexOfRun(this.cat!, id)).filter((i) => i >= 0) : [],
  );

  constructor() {
    window.addEventListener('hashchange', () => {
      this.route = parseRoute(location.hash);
    });
  }

  async load(baseUrl = 'data') {
    try {
      this.bundle = await loadBundle(baseUrl);
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
  }

  /**
   * Change the route. A new page is a history entry, so Back returns to it; a
   * tweak to the page in view (a filter, an axis) replaces the entry instead of
   * burying Back under a hundred slider positions.
   */
  go(patch: Partial<Route>, { push = false } = {}) {
    const next: Route = { ...this.route, ...patch };
    const hash = formatRoute(next) || '#';
    const newPage = next.page !== this.route.page || next.can !== this.route.can;
    this.route = next;
    const url = `${location.pathname}${location.search}${hash === '#' ? '' : hash}`;
    if (push || newPage) history.pushState(null, '', url);
    else history.replaceState(null, '', url);
  }

  /** Clear everything but the host. */
  resetFilters() {
    this.go({ years: [], calibers: [], makers: [], weight: null, length: null });
  }

  selectRun(i: number | null, { push = false } = {}) {
    const id = i === null || !this.cat ? null : this.cat.ids[i];
    this.go({ run: id, shot: null }, { push });
  }

  /**
   * The colour token a run is drawn in, or null for an ordinary run: the
   * selected run in oxblood, the others being compared in ink blue, ochre,
   * violet and teal, in the order they were added.
   */
  colourOf = (i: number): string | null => {
    if (i === this.selected) return '--sel';
    const others = this.compared.filter((j) => j !== this.selected);
    const n = others.indexOf(i);
    return n >= 0 ? COMPARE_COLOURS[1 + (n % 4)] : null;
  };

  setRate(rate: number) {
    this.rate = rate;
    try {
      localStorage.setItem('tbacss-rate', String(rate));
    } catch {
      // private mode: the choice holds for this visit
    }
  }

  isCompared = (i: number) => this.cat !== null && this.route.compare.includes(this.cat.ids[i]);

  toggleCompare(i: number) {
    if (!this.cat) return;
    const id = this.cat.ids[i];
    const current = this.route.compare;
    if (current.includes(id)) this.go({ compare: current.filter((x) => x !== id) });
    else if (current.length < MAX_COMPARE) this.go({ compare: [...current, id] });
  }

  openCan(key: string) {
    this.go({ page: 'can', can: key }, { push: true });
  }

  openCompare() {
    this.go({ page: 'compare', can: null }, { push: true });
  }

  openExplore(patch: Partial<Route> = {}) {
    this.go({ page: 'explore', can: null, ...patch }, { push: true });
  }

  pickHost(code: string | null) {
    this.hostPickerOpen = false;
    // A new host is a new field: the selected run and the filters -- years,
    // makers, size ranges -- were chosen against the old one.
    this.go(
      {
        page: 'explore',
        can: null,
        host: code ?? 'all',
        run: null,
        shot: null,
        years: [],
        calibers: [],
        makers: [],
        weight: null,
        length: null,
      },
      { push: true },
    );
  }
}

export const app = new AppState();

/** The selected run's colour, then one per other compared run. */
export const COMPARE_COLOURS = ['--sel', '--cmp-1', '--cmp-2', '--cmp-3', '--cmp-4'];

export { DEFAULTS };

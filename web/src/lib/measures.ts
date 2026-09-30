/**
 * Every number a run can be ranked or plotted by, and which way is better.
 *
 * `better` is a property of the measure rather than a control: everything here
 * is a sound level or a physical dimension, so less is better unless the entry
 * says `max`. `null` means a dimension -- a test condition like barrel length or
 * year -- which is controlled for, not optimised, so putting one on an axis
 * drops it from the frontier instead of pretending 2026 dominates 2023.
 */

import type { Direction } from '../tbacss.ts';

export interface Measure {
  key: string;
  /** Full name, for anywhere the measure appears on its own. */
  label: string;
  /** What the menus print under the group heading. */
  short: string;
  unit: string;
  better: Direction | null;
  group: string;
  /** Decimal places when shown. */
  digits: number;
}

const m = (
  key: string,
  group: string,
  short: string,
  unit: string,
  better: Direction | null,
  digits = 2,
): Measure => ({
  key,
  group,
  short,
  unit,
  better,
  digits,
  label: group === 'Size' || group === 'Test conditions' ? short : `${group.toLowerCase()}, ${short}`,
});

export const MEASURES: Measure[] = [
  m('se_peak_dba', "Shooter's ear", 'peak dBA', 'dBA', 'min'),
  m('se_peak_db', "Shooter's ear", 'peak dB', 'dB', 'min'),
  m('se_peak_leq10ms_dba', "Shooter's ear", 'Leq 10 ms', 'dBA', 'min'),
  m('se_impulse_db_ms', "Shooter's ear", 'impulse', 'dB·ms', 'min'),
  m('se_reduction_dba', "Shooter's ear", 'reduction vs bare muzzle', 'dBA', 'max', 1),
  m('se_first_round_pop', "Shooter's ear", 'first-round pop', 'dBA', 'min'),
  m('se_low_freq_db', "Shooter's ear", 'energy below 250 Hz', 'dB', 'min'),
  m('se_centroid_hz', "Shooter's ear", 'spectral centroid', 'Hz', null, 0),

  m('ml_peak_dba', 'Mil left', 'peak dBA', 'dBA', 'min'),
  m('ml_peak_db', 'Mil left', 'peak dB', 'dB', 'min'),
  m('ml_peak_leq10ms_dba', 'Mil left', 'Leq 10 ms', 'dBA', 'min'),
  m('ml_reduction_db', 'Mil left', 'reduction vs bare muzzle', 'dB', 'max', 1),
  m('ml_first_round_pop', 'Mil left', 'first-round pop', 'dBA', 'min'),
  m('ml_low_freq_db', 'Mil left', 'energy below 250 Hz', 'dB', 'min'),

  m('mr_peak_dba', 'Mil right', 'peak dBA', 'dBA', 'min'),
  m('mr_peak_db', 'Mil right', 'peak dB', 'dB', 'min'),

  m('p225_peak_dba', '225°', 'peak dBA', 'dBA', 'min'),
  m('p225_peak_db', '225°', 'peak dB', 'dB', 'min'),

  m('weight_oz', 'Size', 'weight', 'oz', 'min', 1),
  m('length_in', 'Size', 'length', 'in', 'min', 2),
  m('max_diameter_in', 'Size', 'diameter', 'in', 'min', 2),
  m('vol_cuin', 'Size', 'volume', 'cu in', 'min', 1),

  m('host_barrel_in', 'Test conditions', 'host barrel', 'in', null, 1),
  m('host_grains', 'Test conditions', 'bullet', 'gr', null, 0),
  m('year', 'Test conditions', 'year', '', null, 0),
];

const BY_KEY = new Map(MEASURES.map((measure) => [measure.key, measure]));

export function measure(key: string): Measure {
  const found = BY_KEY.get(key);
  if (!found) throw new Error(`unknown measure ${key}`);
  return found;
}

export const isMeasure = (key: string | null | undefined): key is string =>
  key != null && BY_KEY.has(key);

/** "lower" or "higher", for a sentence about which way is better. */
export const comparative = (key: string) => (measure(key).better === 'max' ? 'higher' : 'lower');

/** A number as the page prints it: fixed places, a real minus sign, a dash for missing. */
export function fmt(value: number | null | undefined, digits = 2, { sign = false } = {}): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const text = Math.abs(value).toFixed(digits);
  if (value < 0 && Number(text) !== 0) return `−${text}`;
  return sign && Number(text) !== 0 ? `+${text}` : text;
}

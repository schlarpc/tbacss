/**
 * Listen's downsampling: 262 kHz captures reduced 5:1 for Web Audio. What
 * matters is that audible content survives and that the ultrasonic part of a
 * blast does not fold back down into the audible band as an artefact.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DECIMATE, downsample, lowpass, peakOf } from '../../web/src/lib/audio.ts';

const FS = 262144;
const tone = (hz: number, n = 32768) => Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * hz * i) / FS));
/** Peak of the middle of a signal, away from the filter's edge effects. */
const middle = (x: Float32Array) => peakOf(x.subarray(Math.floor(x.length / 4), Math.floor((3 * x.length) / 4)));

test('the filter has unit gain at DC', () => {
  const sum = lowpass(0.08).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
});

test('audible tones pass through intact', () => {
  for (const hz of [100, 1000, 10000]) {
    const out = downsample(tone(hz));
    assert.equal(out.length, Math.floor(32768 / DECIMATE));
    assert.ok(Math.abs(middle(out) - 1) < 0.02, `${hz} Hz came out at ${middle(out)}`);
  }
});

test('ultrasound does not alias into the audible band', () => {
  // 40 kHz would fold to |40 - 52.4| = 12.4 kHz without the filter.
  assert.ok(middle(downsample(tone(40000))) < 0.01);
});

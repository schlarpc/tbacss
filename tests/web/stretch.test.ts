/**
 * Pitch-preserving slow-down (web/src/lib/stretch.ts), measured on signals
 * whose right answer is known: a tone must keep its pitch and level, an
 * impulse must come out once, sharp, at alpha times its time, noise must keep
 * its energy -- and on a crack with a ring behind it, the method must beat
 * plain phase-gradient PVDR on pre-echo, which is what it adds.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fft, stretch } from '../../web/src/lib/stretch.ts';

const FS = 262144 / 5;
const seeded = (seed: number) => () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const rms = (x: ArrayLike<number>, a = 0, b = x.length) => {
  let s = 0;
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return Math.sqrt(s / (b - a));
};
const peakAt = (x: ArrayLike<number>) => {
  let at = 0;
  for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > Math.abs(x[at])) at = i;
  return at;
};

test('the FFT round-trips', () => {
  const re = Float64Array.from({ length: 64 }, (_, i) => Math.sin(i) + i / 10);
  const im = new Float64Array(64);
  const copy = Float64Array.from(re);
  fft(re, im, -1);
  fft(re, im, 1);
  for (let i = 0; i < 64; i++) assert.ok(Math.abs(re[i] / 64 - copy[i]) < 1e-9);
});

for (const alpha of [4, 16]) {
  test(`a tone keeps its pitch and level at ${alpha}x`, () => {
    const tone = Float64Array.from({ length: 8000 }, (_, i) => Math.sin((2 * Math.PI * 1000 * i) / FS));
    const out = stretch(tone, FS, alpha, { random: seeded(1) });
    assert.equal(out.length, 8000 * alpha);
    const a = Math.floor(out.length * 0.3);
    const b = Math.floor(out.length * 0.7);
    let crossings = 0;
    for (let i = a + 1; i < b; i++) if (out[i - 1] < 0 !== out[i] < 0) crossings++;
    const hz = crossings / 2 / ((b - a) / FS);
    assert.ok(Math.abs(hz - 1000) < 5, `${hz} Hz`);
    assert.ok(Math.abs(rms(out, a, b) - Math.SQRT1_2) < 0.02, `rms ${rms(out, a, b)}`);
  });
}

test('an impulse comes out once, sharp, at alpha times its time', () => {
  for (const alpha of [16, 64]) {
    const impulse = new Float64Array(5000);
    impulse[2000] = 1;
    const out = stretch(impulse, FS, alpha, { random: seeded(2) });
    const at = peakAt(out);
    assert.ok(Math.abs(at - 2000 * alpha) <= alpha, `${alpha}x: peak at ${at}`);
    let near = 0;
    let total = 0;
    for (let i = 0; i < out.length; i++) {
      total += out[i] ** 2;
      if (Math.abs(i - at) <= 64) near += out[i] ** 2;
    }
    assert.ok(near / total > 0.95, `${alpha}x: ${((near / total) * 100).toFixed(1)}% near the peak`);
  }
});

test('stretched noise keeps its energy', () => {
  const random = seeded(3);
  const noise = Float64Array.from({ length: 6000 }, () => random() * 2 - 1);
  const out = stretch(noise, FS, 16, { random: seeded(4) });
  const ratio = rms(out, out.length * 0.2, out.length * 0.8) / rms(noise);
  assert.ok(Math.abs(20 * Math.log10(ratio)) < 1.5, `${(20 * Math.log10(ratio)).toFixed(2)} dB`);
});

test('a crack with a ring behind it: placed exactly, and no pre-echo', () => {
  const shot = () => {
    const random = seeded(7);
    const x = new Float64Array(5000);
    x[2000] = 1;
    for (let i = 2001; i < 5000; i++) x[i] = (random() - 0.5) * 0.3 * Math.exp(-(i - 2000) / 300);
    return x;
  };
  const preEcho = (out: Float32Array, alpha: number) => {
    let pre = 0;
    let total = 0;
    for (let i = 0; i < out.length; i++) {
      total += out[i] ** 2;
      if (i < 2000 * alpha - 512) pre += out[i] ** 2;
    }
    return pre / total;
  };
  let events: number[] = [];
  const ours = stretch(shot(), FS, 16, { random: seeded(5), inspect: (info) => (events = info.events) });
  const plain = stretch(shot(), FS, 16, { random: seeded(5), plain: true });
  assert.deepEqual(events, [2000]);
  assert.ok(Math.abs(peakAt(ours) - 32000) <= 16, `peak at ${peakAt(ours)}`);
  assert.ok(preEcho(ours, 16) < 0.01, `pre-echo ${(preEcho(ours, 16) * 100).toFixed(2)}%`);
  assert.ok(preEcho(ours, 16) < preEcho(plain, 16) / 5, 'well below plain PVDR');
});

/**
 * Cross-check the browser-side maths against the Python implementation.
 *
 *   python3 scripts/make_js_fixture.py tbacss.db tests/fixture
 *   npm test
 *
 * The fixture holds analysis windows encoded exactly as `publish` encodes them
 * -- `fixed2-rice-v1` frames -- alongside the metrics `tbacss.analysis`
 * produces from the same decoded samples. Agreeing to well under the 0.01 dB the published
 * tables are rounded to is what makes it safe to derive figures in the browser
 * rather than shipping precomputed curves.
 *
 * `TBACSS_FIXTURE=<dir>` points it at a fixture somewhere else.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { metrics, aWeightingCoefficients, decodeFrame } from '../../web/src/tbacss.ts';
import type { Metrics } from '../../web/src/tbacss.ts';

const TOLERANCE_DB = 0.005;

/** `meta.json`, as scripts/make_js_fixture.py writes it. */
interface FixtureMeta {
  sample_rate_hz: number;
  a_weighting: { b: number[]; a: number[] };
  sample_bits: number;
  codec: string;
  records: {
    file: string;
    label: string;
    dt: number;
    n: number;
    expected: Metrics;
  }[];
}

const dir =
  process.env.TBACSS_FIXTURE ?? path.join(import.meta.dirname, '..', 'fixture');
const meta = JSON.parse(
  fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'),
) as FixtureMeta;

// 1. The A-weighting filter itself.
test('A-weighting coefficients match scipy', () => {
  const [b, a] = aWeightingCoefficients(meta.sample_rate_hz);
  const coefficientError = Math.max(
    ...b.map((v, i) => Math.abs(v - meta.a_weighting.b[i])),
    ...a.map((v, i) => Math.abs(v - meta.a_weighting.a[i])),
  );
  console.log(`A-weighting coefficients   max abs error ${coefficientError.toExponential(2)}`);
  assert.ok(coefficientError < 1e-9, 'A-weighting coefficients disagree with scipy');
});

// 2. Metrics recomputed from the published frames.
for (const record of meta.records) {
  test(record.label, () => {
    const buffer = fs.readFileSync(path.join(dir, record.file));
    const frame = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length);
    const { values: pa, n } = decodeFrame(frame);
    assert.equal(n, record.n, `${record.label}: decoded ${n} samples, expected ${record.n}`);

    const got = metrics(pa, record.dt, 1 / record.dt);
    const failed: string[] = [];
    const lines = [record.label];
    for (const [name, expected] of Object.entries(record.expected) as [keyof Metrics, number][]) {
      const delta = got[name] - expected;
      const limit = name.endsWith('_pa') || name.endsWith('_pa_ms') ? Infinity : TOLERANCE_DB;
      const ok = Math.abs(delta) <= limit;
      if (!ok) failed.push(name);
      lines.push(
        `  ${name.padEnd(20)} ${expected.toFixed(4).padStart(11)} ` +
          `${got[name].toFixed(4).padStart(11)} ${delta.toFixed(5).padStart(10)} ` +
          `${ok ? '' : '  <-- FAIL'}`,
      );
    }
    console.log(lines.join('\n'));
    assert.deepEqual(failed, [], `${failed.join(', ')} off by more than ${TOLERANCE_DB} dB`);
  });
}

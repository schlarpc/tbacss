<script lang="ts">
  import { toDb } from '../tbacss.ts';
  import { SANS, axes, color, decimate, haloText, observeWidth, prepare, strokeColumns } from '../lib/plot.ts';
  import type { Domain } from '../lib/plot.ts';
  import { app } from '../lib/state.svelte.ts';
  import { recordSpan } from '../lib/wave.ts';
  import type { FullRate } from '../lib/wave.ts';

  // Impulse and Leq are not in the bundle: they are computed here from the
  // full-rate samples by the report's own method, and this shows where each
  // figure is taken from -- the impulse is the most the running integral
  // reaches before the trough, the Leq peak is sought in the 25 ms after the
  // shot starts.
  let { record, domain }: { record: FullRate; domain: Domain } = $props();
  let open = $state(false);
  let impulse = $state<HTMLCanvasElement>();
  let leq = $state<HTMLCanvasElement>();
  const bundle = $derived(app.bundle!);

  interface Mark {
    t: number;
    v: number;
    text: string;
  }

  function curve(
    canvas: HTMLCanvasElement,
    values: ArrayLike<number>,
    shade: [number, number] | null,
    marks: Mark[],
    title: string,
  ) {
    const height = 120;
    const { ctx, width } = prepare(canvas, height);
    const box = { left: 44, top: 22, right: width - 8, bottom: height - 24 };
    const cols = Math.max(1, Math.round(box.right - box.left));
    const colX = (c: number) => box.left + ((c + 0.5) / cols) * (box.right - box.left);
    const [s0, s1] = recordSpan(bundle, record.entry);
    const band = decimate(values.length, s0, s1, (i) => values[i], (i) => values[i], domain, cols);
    let lo = Infinity;
    let hi = -Infinity;
    for (let c = 0; c < cols; c++) {
      if (!band.seen[c]) continue;
      lo = Math.min(lo, band.lo[c]);
      hi = Math.max(hi, band.hi[c]);
    }
    if (!(hi > lo)) [lo, hi] = [0, 1];
    const pad = (hi - lo) * 0.1;
    const { px, py } = axes(ctx, box, domain, [lo - pad, hi + pad], { xFormat: () => '' });
    ctx.font = `11px ${SANS}`;
    ctx.fillStyle = color('--tick');
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(title, box.left, 2);

    const ink = color('--sel');
    ctx.save();
    ctx.beginPath();
    ctx.rect(box.left, box.top, box.right - box.left, box.bottom - box.top);
    ctx.clip();
    if (shade) {
      ctx.fillStyle = ink;
      ctx.globalAlpha = 0.1;
      const a = Math.max(px(shade[0]), box.left);
      const b = Math.min(px(shade[1]), box.right);
      if (b > a) ctx.fillRect(a, box.top, b - a, box.bottom - box.top);
      ctx.globalAlpha = 1;
    }
    ctx.strokeStyle = ink;
    ctx.lineWidth = 1.5;
    strokeColumns(ctx, band, py, colX);
    ctx.restore();

    ctx.font = `11px ${SANS}`;
    ctx.textBaseline = 'middle';
    for (const mark of marks) {
      const raw = px(mark.t);
      const off = raw < box.left || raw > box.right;
      const x = Math.min(Math.max(raw, box.left), box.right);
      const y = Math.min(Math.max(py(mark.v), box.top + 4), box.bottom - 4);
      if (!off) {
        ctx.fillStyle = ink;
        ctx.beginPath();
        ctx.arc(x, y, 3.5, 0, Math.PI * 2);
        ctx.fill();
      }
      // A mark zoomed past keeps its label, pulled to the edge with its time,
      // rather than vanishing as though there were no such point.
      const label = off ? `${raw < box.left ? '‹ ' : ''}${mark.text} at ${mark.t.toFixed(1)} ms${raw > box.right ? ' ›' : ''}` : mark.text;
      ctx.fillStyle = color('--ink');
      ctx.textAlign = box.right - x < ctx.measureText(label).width + 12 ? 'right' : 'left';
      haloText(ctx, label, x + (ctx.textAlign === 'right' ? -7 : 7), y);
    }
  }

  function draw() {
    if (!open || !impulse || !leq) return;
    const { analysis, dt } = record;
    const [s0] = recordSpan(bundle, record.entry);
    const at = (i: number) => s0 + i * dt * 1000;
    curve(
      impulse,
      analysis.integral,
      [at(analysis.triggered ? analysis.leqStart : 0), at(analysis.trough)],
      [
        { t: at(analysis.impulseIndex), v: analysis.integral[analysis.impulseIndex], text: `impulse ${analysis.impulse_pa_ms.toFixed(2)} Pa·ms` },
        { t: at(analysis.trough), v: analysis.integral[analysis.trough], text: 'trough' },
      ],
      'cumulative impulse, Pa·ms',
    );
    const levels = Float64Array.from(analysis.running, (v) => (v > 0 ? toDb(v) : NaN));
    curve(
      leq,
      levels,
      analysis.triggered ? [at(analysis.leqStart), at(analysis.leqStop)] : null,
      [{ t: at(analysis.leqIndex), v: levels[analysis.leqIndex], text: `peak ${analysis.peak_leq10ms_dba.toFixed(2)} dBA` }],
      'Leq 10 ms, dBA',
    );
  }

  $effect(() => {
    void [record, domain, open];
    draw();
  });
  $effect(() => (impulse ? observeWidth(impulse, draw) : undefined));
</script>

<details bind:open>
  <summary>How impulse and Leq are taken from this shot</summary>
  <canvas bind:this={impulse}></canvas>
  <canvas bind:this={leq}></canvas>
</details>

<style>
  details {
    margin-top: 8px;
    font-size: 13px;
  }
  summary {
    cursor: pointer;
    color: var(--muted);
  }
  canvas {
    display: block;
    width: 100%;
    margin-top: 6px;
  }
</style>

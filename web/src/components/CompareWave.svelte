<script lang="ts">
  import type { WaveformEntry } from '../tbacss.ts';
  import { position } from '../lib/audio.ts';
  import { axes, color, decimate, observeWidth, placeholder, prepare, strokeColumns } from '../lib/plot.ts';
  import type { Domain } from '../lib/plot.ts';
  import { app } from '../lib/state.svelte.ts';
  import { fullRate, recordSpan } from '../lib/wave.ts';
  import type { FullRate } from '../lib/wave.ts';

  // Several runs' shots on one axis, each aligned at its own shot start (the
  // report's 1 Pa trigger) -- they arrive at different milliseconds, and an
  // unaligned overlay compares the rig's timing rather than the cans.
  let { shots, height = 250 }: { shots: { entry: WaveformEntry; colour: string }[]; height?: number } = $props();
  let canvas: HTMLCanvasElement;
  let records = $state.raw<(FullRate | null)[]>([]);
  const WINDOW: Domain = [-1.5, 22.5];

  $effect(() => {
    const wanted = shots;
    records = wanted.map(() => null);
    wanted.forEach((s, n) =>
      fullRate(app.bundle!, s.entry).then((r) => {
        if (shots !== wanted) return;
        records = records.map((old, k) => (k === n ? r : old));
      }),
    );
  });

  const startOf = (r: FullRate) =>
    recordSpan(app.bundle!, r.entry)[0] + (r.analysis.triggered ? r.analysis.leqStart : 0) * r.dt * 1000;

  function draw() {
    if (!canvas) return;
    const { ctx, width } = prepare(canvas, height);
    const ready = records.filter((r): r is FullRate => r !== null);
    if (!ready.length) return placeholder(ctx, width, height, 'Loading traces…');
    const box = { left: 44, top: 10, right: width - 8, bottom: height - 26 };
    const cols = Math.max(1, Math.round(box.right - box.left));
    const colX = (c: number) => box.left + ((c + 0.5) / cols) * (box.right - box.left);
    const traces = records.map((r) => {
      if (!r) return null;
      const [s0, s1] = recordSpan(app.bundle!, r.entry);
      const shift = startOf(r);
      return decimate(r.values.length, s0 - shift, s1 - shift, (i) => r.values[i], (i) => r.values[i], WINDOW, cols);
    });
    let peak = 1;
    for (const t of traces) if (t) for (let c = 0; c < cols; c++) if (t.seen[c]) peak = Math.max(peak, -t.lo[c], t.hi[c]);
    const { px, py } = axes(ctx, box, WINDOW, [-peak * 1.06, peak * 1.06], { xFormat: (v) => `${v.toFixed(0)} ms` });
    ctx.save();
    ctx.beginPath();
    ctx.rect(box.left, box.top, box.right - box.left, box.bottom - box.top);
    ctx.clip();
    // First (the selected run) drawn last, so it sits on top.
    for (let n = traces.length - 1; n >= 0; n--) {
      const t = traces[n];
      if (!t) continue;
      ctx.strokeStyle = color(shots[n].colour);
      ctx.globalAlpha = n === 0 ? 1 : 0.8;
      ctx.lineWidth = n === 0 ? 1.4 : 1.1;
      strokeColumns(ctx, t, py, colX);
    }
    ctx.globalAlpha = 1;
    const playing = app.playing;
    const r = playing && ready.find((x) => x.entry.id === playing.id);
    if (playing && r) {
      const x = px(position(playing) - startOf(r));
      ctx.strokeStyle = color('--ink');
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, box.top);
      ctx.lineTo(x, box.bottom);
      ctx.stroke();
    }
    ctx.restore();
  }

  $effect(() => {
    void records;
    draw();
  });
  $effect(() => {
    if (!app.playing) return;
    let frame = requestAnimationFrame(function tick() {
      draw();
      frame = requestAnimationFrame(tick);
    });
    return () => {
      cancelAnimationFrame(frame);
      draw();
    };
  });
  $effect(() => observeWidth(canvas, draw));
  $effect(() => {
    window.addEventListener('themechange', draw);
    return () => window.removeEventListener('themechange', draw);
  });
</script>

<canvas bind:this={canvas} aria-label="Shot 1 of each compared can at the shooter's ear, overlaid and aligned at the shot's start"></canvas>

<style>
  canvas {
    display: block;
    width: 100%;
  }
</style>

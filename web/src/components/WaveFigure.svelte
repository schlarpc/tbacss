<script lang="ts">
  import { toDb } from '../tbacss.ts';
  import type { Envelope, WaveformEntry } from '../tbacss.ts';
  import { elapsed } from '../lib/audio.ts';
  import {
    axes,
    bandExtent,
    color,
    decimate,
    fillBand,
    observeWidth,
    placeholder,
    prepare,
    strokeColumns,
    union,
  } from '../lib/plot.ts';
  import type { Box, ColumnBand, Domain } from '../lib/plot.ts';
  import { app } from '../lib/state.svelte.ts';
  import { VIEW_LEAD_MS, autoWindow, clampDomain, fullRate, fullSpan, recordSpan, runEnvelopes, widenFor } from '../lib/wave.ts';
  import type { FullRate } from '../lib/wave.ts';
  import DerivedCurves from './DerivedCurves.svelte';

  // One run's pressure trace at one mic: every shot as a min/max band (its width
  // is the shot-to-shot spread), or one shot at full rate on top of it. Opens
  // framed on the blast; scroll, pinch, drag or the arrow keys move the view.
  let { runId, mic, shot, height = 200, figure = 'Fig. 1', onshot }: {
    runId: number;
    mic: string;
    shot: WaveformEntry | null;
    height?: number;
    figure?: string;
    onshot?: (entry: WaveformEntry | null) => void;
  } = $props();

  const bundle = $derived(app.bundle!);
  let canvas: HTMLCanvasElement;
  let records = $state.raw<Envelope[] | null>(null);
  let record = $state.raw<FullRate | null>(null);
  let failed = $state<string | null>(null);
  let view = $state<Domain | null>(null);
  let auto = $state<Domain | null>(null);
  /** First arrival, ms: the axis counts from here, so "0 ms" is the shot. */
  let arrival = $state(0);
  let hover = $state<number | null>(null);
  let box: Box | null = null;
  let frame = 0;

  const group = $derived(records?.filter((r) => r.entry.mic === mic) ?? []);
  const full = $derived(records ? fullSpan(bundle, records) : null);
  const domain = $derived<Domain>(view ?? auto ?? [0, 1]);

  // A new run arrives at a different millisecond, so its own framing replaces
  // any zoom carried over from the last one.
  $effect(() => {
    const id = runId;
    records = null;
    record = null;
    view = null;
    failed = null;
    runEnvelopes(bundle, id).then(
      (found) => {
        if (id !== runId) return;
        records = found;
        auto = autoWindow(bundle, found);
        arrival = auto[0] + VIEW_LEAD_MS;
      },
      (error: unknown) => (failed = error instanceof Error ? error.message : String(error)),
    );
  });

  $effect(() => {
    const entry = shot;
    record = null;
    if (!entry) return;
    fullRate(bundle, entry).then((found) => {
      if (shot?.id !== entry.id) return;
      record = found;
      // Stretch the run's framing to reach the marks the analysis sets, rather
      // than leave one silently off the edge. A view the reader set is theirs.
      if (auto && full) {
        const [s0] = recordSpan(bundle, entry);
        const at = (i: number) => s0 + i * found.dt * 1000;
        const a = found.analysis;
        auto = widenFor(auto, full, [at(a.trough), at(a.impulseIndex), at(a.leqIndex)]);
      }
    });
  });

  function draw() {
    if (!canvas) return;
    const { ctx, width } = prepare(canvas, height);
    if (failed) return placeholder(ctx, width, height, `Could not load waveforms: ${failed}`);
    if (!records) return placeholder(ctx, width, height, 'Loading traces…');
    if (!group.length) return placeholder(ctx, width, height, `No ${mic} recording for this run`);

    const inner: Box = { left: 44, top: 10, right: width - 8, bottom: height - 26 };
    box = inner;
    const cols = Math.max(1, Math.round(inner.right - inner.left));
    const colX = (c: number) => inner.left + ((c + 0.5) / cols) * (inner.right - inner.left);

    const band = union(
      group.map((r) => {
        const [s0, s1] = recordSpan(bundle, r.entry);
        return decimate(r.buckets, s0, s1, (i) => r.values[i * 2], (i) => r.values[i * 2 + 1], domain, cols);
      }),
      cols,
    );
    let trace: ColumnBand | null = null;
    if (record) {
      const [s0, s1] = recordSpan(bundle, record.entry);
      const values = record.values;
      trace = decimate(values.length, s0, s1, (i) => values[i], (i) => values[i], domain, cols);
    }
    // Scale to what is on screen, or the zoom does nothing: the peak is twenty
    // times the rest of the trace.
    const [lo, hi] = bandExtent(trace ? [band, trace] : [band], cols) ?? [-1, 1];
    const pad = (hi - lo) * 0.06 || 1;
    // Ticks in time since the shot, so they land on round milliseconds.
    const rel: Domain = [domain[0] - arrival, domain[1] - arrival];
    const scales = axes(ctx, inner, rel, [lo - pad, hi + pad], {
      xFormat: (v) => `${v.toFixed(rel[1] - rel[0] < 5 ? 1 : 0)} ms`,
    });
    const px = (t: number) => scales.px(t - arrival);
    const py = scales.py;

    ctx.save();
    ctx.beginPath();
    ctx.rect(inner.left, inner.top, inner.right - inner.left, inner.bottom - inner.top);
    ctx.clip();
    const ink = color('--sel');
    ctx.fillStyle = ink;
    ctx.globalAlpha = trace ? 0.16 : 0.6;
    fillBand(ctx, band, py, colX);
    ctx.globalAlpha = 1;
    if (trace) {
      ctx.strokeStyle = ink;
      ctx.lineWidth = 1.3;
      strokeColumns(ctx, trace, py, colX);
    }

    // Playhead while Listen is playing this run's clip.
    const playing = app.playing;
    const clip = playing && group.find((r) => r.entry.id === playing.id);
    if (playing && clip) {
      const t = recordSpan(bundle, clip.entry)[0] + elapsed(playing) * 1000;
      const x = px(t);
      ctx.fillStyle = color('--ink');
      ctx.globalAlpha = 0.05;
      ctx.fillRect(inner.left, inner.top, Math.max(0, x - inner.left), inner.bottom - inner.top);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = color('--ink');
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, inner.top);
      ctx.lineTo(x, inner.bottom);
      ctx.stroke();
    }

    if (hover !== null) {
      const x = Math.round(px(hover)) + 0.5;
      ctx.strokeStyle = color('--muted');
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x, inner.top);
      ctx.lineTo(x, inner.bottom);
      ctx.stroke();
    }
    ctx.restore();
  }

  // Repaint on any change the drawing reads.
  $effect(() => {
    void [records, record, domain, hover, mic, height, failed];
    draw();
  });

  // While a clip plays, animate the playhead.
  $effect(() => {
    if (!app.playing) {
      draw();
      return;
    }
    const tick = () => {
      draw();
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  });

  $effect(() => observeWidth(canvas, draw));
  $effect(() => {
    const repaint = () => draw();
    window.addEventListener('themechange', repaint);
    const media = matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', repaint);
    return () => {
      window.removeEventListener('themechange', repaint);
      media.removeEventListener('change', repaint);
    };
  });

  /* ---------------------------------------------------------- interaction */

  function setView(next: Domain | null) {
    if (!full) return;
    view = next === null ? null : clampDomain(next, full);
  }
  function timeAt(event: MouseEvent): number | null {
    if (!box) return null;
    const x = event.clientX - canvas.getBoundingClientRect().left;
    if (x < box.left || x > box.right) return null;
    return domain[0] + ((x - box.left) / (box.right - box.left)) * (domain[1] - domain[0]);
  }
  function zoom(factor: number, anchor: number | null) {
    const [t0, t1] = domain;
    const at = anchor ?? (t0 + t1) / 2;
    setView([at - (at - t0) * factor, at + (t1 - at) * factor]);
  }

  const pointers = new Map<number, PointerEvent>();
  let dragFrom: { x: number; domain: Domain } | null = null;
  let pinchFrom: { distance: number; domain: Domain } | null = null;

  function down(event: PointerEvent) {
    if (!records) return;
    pointers.set(event.pointerId, event);
    canvas.setPointerCapture(event.pointerId);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchFrom = { distance: Math.abs(a.clientX - b.clientX) || 1, domain };
      dragFrom = null;
    } else dragFrom = { x: event.clientX, domain };
  }
  function move(event: PointerEvent) {
    if (!records) return;
    if (pointers.has(event.pointerId)) pointers.set(event.pointerId, event);
    if (pinchFrom && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const [t0, t1] = pinchFrom.domain;
      const half = ((t1 - t0) / 2) * (pinchFrom.distance / (Math.abs(a.clientX - b.clientX) || 1));
      setView([(t0 + t1) / 2 - half, (t0 + t1) / 2 + half]);
      return;
    }
    if (dragFrom && box && Math.abs(dragFrom.x - event.clientX) > 3) {
      const [t0, t1] = dragFrom.domain;
      const shift = ((dragFrom.x - event.clientX) / (box.right - box.left)) * (t1 - t0);
      setView([t0 + shift, t1 + shift]);
      return;
    }
    if (event.pointerType !== 'touch') hover = timeAt(event);
  }
  function up(event: PointerEvent) {
    pointers.delete(event.pointerId);
    if (pointers.size < 2) pinchFrom = null;
    if (!pointers.size) dragFrom = null;
  }
  function wheel(event: WheelEvent) {
    if (!records) return;
    event.preventDefault();
    zoom(Math.exp(event.deltaY * 0.002), timeAt(event));
  }
  function key(event: KeyboardEvent) {
    const [t0, t1] = domain;
    const step = (t1 - t0) * 0.2;
    const moves: Record<string, () => void> = {
      ArrowLeft: () => setView([t0 - step, t1 - step]),
      ArrowRight: () => setView([t0 + step, t1 + step]),
      '+': () => zoom(1 / 1.4, null),
      '=': () => zoom(1 / 1.4, null),
      '-': () => zoom(1.4, null),
      Escape: () => setView(null),
    };
    const run = moves[event.key];
    if (!run) return;
    event.preventDefault();
    run();
  }

  /** What is under the crosshair, for the caption. */
  const readout = $derived.by(() => {
    if (hover === null || !record) return null;
    const [s0] = recordSpan(bundle, record.entry);
    const i = Math.round((hover - s0) / (record.dt * 1000));
    if (i < 0 || i >= record.values.length) return null;
    const pa = record.values[i];
    const shotStart = record.analysis.triggered ? s0 + record.analysis.leqStart * record.dt * 1000 : null;
    const rel = shotStart === null ? '' : `${hover - shotStart >= 0 ? '+' : '−'}${Math.abs(hover - shotStart).toFixed(2)} ms from shot start · `;
    return `${rel}${pa.toFixed(1)} Pa${pa ? ` (${toDb(Math.abs(pa)).toFixed(1)} dB)` : ''}`;
  });

  const shots = $derived(group.map((r) => r.entry).sort((a, b) => Number(a.excluded) - Number(b.excluded) || a.shot - b.shot));
</script>

<figure>
  <div class="plot">
    <canvas
      bind:this={canvas}
      tabindex="0"
      aria-label={`Pressure at ${mic}. Scroll or pinch to zoom, drag or arrow keys to pan, Escape to reset.`}
      onpointerdown={down}
      onpointermove={move}
      onpointerup={up}
      onpointercancel={up}
      onpointerleave={() => (hover = null)}
      onwheel={wheel}
      ondblclick={() => setView(null)}
      onkeydown={key}
    ></canvas>
  </div>
  <figcaption>
    <span class="dim">
      {#if readout}{readout}{:else}{figure} — {shot ? `shot ${shot.shot}` : `all ${shots.length} shots`} at {mic === 'SE' ? "the shooter's ear" : mic}, Pa{#if record} · peak {record.analysis.peak_db.toFixed(1)} dB{/if}{/if}
    </span>
    <span class="controls">
      {#if view}<button type="button" class="linkish" onclick={() => setView(null)}>Reset zoom</button>{/if}
      <label class="shot">
        <span class="visually-hidden">Shot</span>
        <select value={shot?.id ?? ''} onchange={(e) => onshot?.(shots.find((s) => s.id === Number(e.currentTarget.value)) ?? null)}>
          <option value="">all shots</option>
          {#each shots as s (s.id)}
            <option value={s.id}>shot {s.shot}{s.excluded ? ' (spare)' : ''}</option>
          {/each}
        </select>
      </label>
    </span>
  </figcaption>
</figure>
{#if record}
  <DerivedCurves {record} {domain} />
{/if}

<style>
  figure {
    margin: 0;
  }
  .plot {
    border: 1px solid var(--rule);
    border-radius: 6px;
    background: var(--paper-2);
    padding: 6px 4px 0;
  }
  canvas {
    display: block;
    width: 100%;
    touch-action: pan-y;
    cursor: crosshair;
  }
  figcaption {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 6px;
    font-size: 12.5px;
    min-height: 28px;
  }
  figcaption > .dim {
    flex: 1;
    min-width: 0;
  }
  .controls {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .shot select {
    height: 26px;
    padding: 0 8px;
    border: none;
    border-radius: 999px;
    background: var(--paper-3);
    font-size: 13px;
    cursor: pointer;
  }
  .linkish {
    font-size: 12.5px;
  }
</style>

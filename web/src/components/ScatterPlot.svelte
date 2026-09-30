<script lang="ts">
  import { canOf, frontierPath, nameOf, num, semOf, tiedWith, yearOf } from '../lib/explore.ts';
  import { fmt, measure } from '../lib/measures.ts';
  import { SERIF, SANS, axes, color, haloText, observeWidth, placeholder, prepare } from '../lib/plot.ts';
  import type { Domain } from '../lib/plot.ts';
  import { app } from '../lib/state.svelte.ts';
  import Icon from './Icon.svelte';

  // Every run in the field on two measures (or three, rotatable). The
  // frontier is a stepped olive line through numbered points; a run's year is
  // its mark's shape, so colour is left for the runs being looked at.
  let { height = 560 }: { height?: number } = $props();

  let canvas: HTMLCanvasElement;
  let wrap = $state<HTMLDivElement>();
  let hover = $state<number | null>(null);
  let pinned = $state<number | null>(null);
  let view = $state({ yaw: -0.62, pitch: 0.42 });
  let points: { i: number; x: number; y: number }[] = [];

  const cat = $derived(app.cat!);
  const xKey = $derived(app.route.x);
  const yKey = $derived(app.route.y);
  const zKey = $derived(app.route.z);
  const keys = $derived(zKey ? [xKey, yKey, zKey] : [xKey, yKey]);
  const usable = $derived(app.visible.filter((i) => keys.every((k) => Number.isFinite(num(cat, k, i)))));
  const path = $derived(frontierPath(cat, app.frontier, xKey));

  const SHAPES = ['disc', 'ring', 'square', 'diamond'] as const;
  const shapeOf = $derived(new Map(app.years.map((y, n) => [y, SHAPES[n % SHAPES.length]])));

  function extent(key: string): Domain {
    let lo = Infinity;
    let hi = -Infinity;
    for (const i of usable) {
      const v = num(cat, key, i);
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    const pad = (hi - lo) * 0.06 || 1;
    return [lo - pad, hi + pad];
  }

  function mark(ctx: CanvasRenderingContext2D, x: number, y: number, shape: string, r: number, ink: string) {
    ctx.beginPath();
    if (shape === 'square') ctx.rect(x - r, y - r, r * 2, r * 2);
    else if (shape === 'diamond') {
      ctx.moveTo(x, y - r * 1.3);
      ctx.lineTo(x + r * 1.3, y);
      ctx.lineTo(x, y + r * 1.3);
      ctx.lineTo(x - r * 1.3, y);
      ctx.closePath();
    } else ctx.arc(x, y, r, 0, Math.PI * 2);
    if (shape === 'disc') {
      ctx.fillStyle = ink;
      ctx.fill();
    } else {
      ctx.strokeStyle = ink;
      ctx.lineWidth = 1.3;
      ctx.stroke();
    }
  }

  function emphasis(ctx: CanvasRenderingContext2D, x: number, y: number, fill: string, r: number) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = color('--paper');
    ctx.stroke();
  }

  const accent = (i: number): string | null => {
    const token = app.colourOf(i);
    return token ? color(token) : null;
  };

  function draw2d(ctx: CanvasRenderingContext2D, width: number) {
    const box = { left: 52, top: 16, right: width - 12, bottom: height - 40 };
    const xd = extent(xKey);
    const yd = extent(yKey);
    const { px, py } = axes(ctx, box, xd, yd, { xTitle: `${measure(xKey).label}${measure(xKey).unit ? `, ${measure(xKey).unit}` : ''}` });
    points = [];

    // Error bars only where they can be read: at a thousand points they are fog.
    if (usable.length <= 220) {
      ctx.strokeStyle = color('--dot-soft');
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const i of usable) {
        const x = px(num(cat, xKey, i));
        const y = py(num(cat, yKey, i));
        const ys = semOf(cat, yKey, i);
        if (ys) {
          ctx.moveTo(x, py(num(cat, yKey, i) - ys));
          ctx.lineTo(x, py(num(cat, yKey, i) + ys));
        }
        const xs = semOf(cat, xKey, i);
        if (xs) {
          ctx.moveTo(px(num(cat, xKey, i) - xs), y);
          ctx.lineTo(px(num(cat, xKey, i) + xs), y);
        }
      }
      ctx.stroke();
    }

    const dot = color('--dot');
    for (const i of usable) {
      const x = px(num(cat, xKey, i));
      const y = py(num(cat, yKey, i));
      points.push({ i, x, y });
      if (app.frontier.has(i) || accent(i)) continue;
      mark(ctx, x, y, app.years.length > 1 ? (shapeOf.get(yearOf(cat, i)) ?? 'disc') : 'disc', 3.2, dot);
    }

    // The frontier as a staircase: each step is what the next can gives up.
    const both = measure(xKey).better && measure(yKey).better;
    if (path.length && both) {
      const xUp = measure(xKey).better === 'max';
      const yUp = measure(yKey).better === 'max';
      const ordered = xUp ? [...path].reverse() : path;
      ctx.strokeStyle = color('--frontier');
      ctx.lineWidth = 2;
      ctx.beginPath();
      ordered.forEach((i, n) => {
        const x = px(num(cat, xKey, i));
        const y = py(num(cat, yKey, i));
        if (n === 0) ctx.moveTo(x, yUp ? box.bottom : box.top);
        else ctx.lineTo(x, py(num(cat, yKey, ordered[n - 1])));
        ctx.lineTo(x, y);
      });
      const last = ordered[ordered.length - 1];
      ctx.lineTo(xUp ? box.left : box.right, py(num(cat, yKey, last)));
      ctx.stroke();
    }
    ctx.font = `italic 15px ${SERIF}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'alphabetic';
    path.forEach((i, n) => {
      const x = px(num(cat, xKey, i));
      const y = py(num(cat, yKey, i));
      const ink = accent(i);
      emphasis(ctx, x, y, ink ?? color('--ink'), ink ? 7 : 5.5);
      ctx.fillStyle = ink ?? color('--ink');
      // Below-left: the staircase leaves each point up and to the right, so
      // this corner is always clear of it.
      haloText(ctx, String(n + 1), x - 9, y + 18);
    });
    for (const i of usable) {
      const ink = accent(i);
      if (!ink || app.frontier.has(i)) continue;
      const x = px(num(cat, xKey, i));
      const y = py(num(cat, yKey, i));
      emphasis(ctx, x, y, ink, 7);
    }
  }

  function project(x: number, y: number, z: number) {
    const cy = Math.cos(view.yaw);
    const sy = Math.sin(view.yaw);
    const cp = Math.cos(view.pitch);
    const sp = Math.sin(view.pitch);
    const rx = x * cy + z * sy;
    const rz = -x * sy + z * cy;
    return { x: rx, y: y * cp - rz * sp, depth: y * sp + rz * cp };
  }

  function draw3d(ctx: CanvasRenderingContext2D, width: number) {
    const domains = keys.map(extent);
    const cx = width / 2;
    const cy = height / 2 - 6;
    const scale = Math.min(width, height) * 0.6;
    const screen = (p: { x: number; y: number }) => ({ x: cx + p.x * scale, y: cy - p.y * scale });
    const unit = (v: number, [lo, hi]: Domain) => (v - lo) / (hi - lo) - 0.5;
    const corners = [
      [-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [-0.5, 0.5, -0.5], [0.5, 0.5, -0.5],
      [-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [-0.5, 0.5, 0.5], [0.5, 0.5, 0.5],
    ].map(([x, y, z]) => screen(project(x, y, z)));
    const edges = [[0, 1], [1, 3], [3, 2], [2, 0], [4, 5], [5, 7], [7, 6], [6, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
    ctx.strokeStyle = color('--grid');
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const [a, b] of edges) {
      ctx.moveTo(corners[a].x, corners[a].y);
      ctx.lineTo(corners[b].x, corners[b].y);
    }
    ctx.stroke();
    ctx.font = `11px ${SANS}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = color('--tick');
    for (const [a, b, axis] of [[0, 1, 0], [0, 2, 1], [0, 4, 2]]) {
      const mx = (corners[a].x + corners[b].x) / 2;
      const my = (corners[a].y + corners[b].y) / 2;
      const d = Math.hypot(mx - cx, my - cy) || 1;
      haloText(ctx, measure(keys[axis]).label, mx + ((mx - cx) / d) * 30, my + ((my - cy) / d) * 30);
    }
    const projected = usable
      .map((i) => {
        const p = project(unit(num(cat, keys[0], i), domains[0]), unit(num(cat, keys[1], i), domains[1]), unit(num(cat, keys[2], i), domains[2]));
        return { i, ...screen(p), depth: p.depth };
      })
      .sort((a, b) => a.depth - b.depth);
    points = projected;
    const dot = color('--dot');
    for (const p of projected) {
      const near = (p.depth + 0.9) / 1.8;
      ctx.globalAlpha = 0.4 + near * 0.6;
      const ink = accent(p.i);
      if (ink) emphasis(ctx, p.x, p.y, ink, 7);
      else if (app.frontier.has(p.i)) emphasis(ctx, p.x, p.y, color('--frontier'), 4.5);
      else mark(ctx, p.x, p.y, 'disc', 2.4 + near * 1.4, dot);
    }
    ctx.globalAlpha = 1;
  }

  function draw() {
    if (!canvas || !app.cat) return;
    const { ctx, width } = prepare(canvas, height);
    if (!usable.length) return placeholder(ctx, width, height, 'No runs match these filters.');
    if (zKey) draw3d(ctx, width);
    else draw2d(ctx, width);
    const ring = hover ?? pinned;
    const p = points.find((q) => q.i === ring);
    if (p) {
      ctx.strokeStyle = color('--ink');
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 10, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  $effect(() => {
    void [usable, app.frontier, app.selected, app.compared, hover, pinned, view, height, xKey, yKey, zKey];
    draw();
  });
  $effect(() => observeWidth(canvas, draw));
  $effect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    window.addEventListener('themechange', draw);
    media.addEventListener('change', draw);
    return () => {
      window.removeEventListener('themechange', draw);
      media.removeEventListener('change', draw);
    };
  });
  // Axes changed: the readout's point is somewhere else now.
  $effect(() => {
    void keys;
    pinned = null;
  });

  function nearest(event: MouseEvent): number | null {
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    let best: number | null = null;
    let bestD = 26 * 26;
    for (const p of points) {
      const d = (p.x - x) ** 2 + (p.y - y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = p.i;
      }
    }
    return best;
  }

  let drag: { x: number; y: number; moved: number; view: typeof view } | null = null;
  function down(event: PointerEvent) {
    if (!zKey) return;
    drag = { x: event.clientX, y: event.clientY, moved: 0, view: { ...view } };
    canvas.setPointerCapture(event.pointerId);
  }
  function move(event: PointerEvent) {
    if (drag) {
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      drag.moved = Math.max(drag.moved, Math.hypot(dx, dy));
      if (drag.moved >= 4) {
        view = { yaw: drag.view.yaw + dx * 0.008, pitch: Math.max(-1.45, Math.min(1.45, drag.view.pitch + dy * 0.008)) };
        return;
      }
    }
    if (event.pointerType !== 'touch') hover = nearest(event);
  }
  function up(event: PointerEvent) {
    const wasDrag = drag !== null && drag.moved >= 4;
    drag = null;
    if (wasDrag) return;
    const i = nearest(event);
    pinned = i;
    if (i !== null) app.selectRun(i);
  }

  const shown = $derived(hover ?? pinned);
  const readout = $derived.by(() => {
    const p = points.find((q) => q.i === shown);
    if (shown === null || !p) return null;
    const ties = tiedWith(cat, app.visible, yKey, shown).length;
    return { i: shown, x: p.x, y: p.y, ties };
  });
</script>

<div class="plot" bind:this={wrap}>
  <canvas
    bind:this={canvas}
    class:rotatable={zKey}
    aria-label={`Scatter of ${measure(yKey).label} against ${measure(xKey).label}. The ranked list has the same runs.`}
    onpointerdown={down}
    onpointermove={move}
    onpointerup={up}
    onpointerleave={() => (hover = null)}
  ></canvas>
  {#if readout}
    {@const name = nameOf(cat, readout.i)}
    <div
      class="readout"
      role="status"
      style:left={`${Math.min(readout.x + 16, (wrap?.clientWidth ?? 600) - 270)}px`}
      style:top={`${Math.max(8, readout.y - 110)}px`}
    >
      {#if pinned === readout.i}
        <button type="button" class="x" aria-label="Dismiss" onclick={() => (pinned = null)}><Icon name="x" size={10} /></button>
      {/if}
      <div><b>{name.maker}</b> <span class="serif model">{name.model}</span> <span class="dim">· {yearOf(cat, readout.i)}</span></div>
      <div class="num">
        {fmt(num(cat, yKey, readout.i), measure(yKey).digits)}{#if semOf(cat, yKey, readout.i)} ± {fmt(semOf(cat, yKey, readout.i))}{/if}
        {measure(yKey).unit} · {fmt(num(cat, xKey, readout.i), measure(xKey).digits)} {measure(xKey).unit}
      </div>
      {#if semOf(cat, yKey, readout.i)}
        <div class="dim">{readout.ties ? `Within error of ${readout.ties} others shown` : 'Separable from every run shown'}</div>
      {/if}
      {#if pinned === readout.i}
        <div class="acts">
          <button type="button" class="linkish" onclick={() => app.toggleCompare(readout.i)}>{app.isCompared(readout.i) ? 'Remove from compare' : 'Compare'}</button>
          <button type="button" class="linkish" onclick={() => app.openCan(canOf(cat, readout.i))}>Can page</button>
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .plot {
    position: relative;
  }
  canvas {
    display: block;
    width: 100%;
    cursor: pointer;
    touch-action: pan-y;
  }
  canvas.rotatable {
    cursor: grab;
    touch-action: none;
  }
  .readout {
    position: absolute;
    width: 256px;
    padding: 10px 12px;
    border: 1px solid var(--ink);
    border-radius: 6px;
    background: var(--paper-2);
    font-size: 13px;
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.12);
    pointer-events: none;
  }
  .readout:has(.acts) {
    pointer-events: auto;
  }
  .model {
    font-size: 16px;
  }
  .acts {
    display: flex;
    gap: 14px;
    margin-top: 8px;
    font-size: 13px;
  }
  .x {
    position: absolute;
    top: 6px;
    right: 6px;
    border: none;
    background: none;
    cursor: pointer;
    color: var(--muted);
  }
</style>

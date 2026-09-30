<script lang="ts">
  import type { Bands } from '../tbacss.ts';
  import { app } from '../lib/state.svelte.ts';
  import { loadBands, perHz } from '../lib/wave.ts';

  // One-third-octave energy per Hz at one mic, for one run or several. The band
  // below 250 Hz is shaded: that is the thump dBA discounts, and where two cans
  // with the same dBA figure differ.
  let { runs, mic = 'SE', height = 120, caption = '' }: {
    runs: { id: number; colour: string }[];
    mic?: string;
    height?: number;
    caption?: string;
  } = $props();

  let bands = $state.raw<Bands | null>(null);
  let width = $state(560);
  $effect(() => {
    if (app.bundle) loadBands(app.bundle).then((b) => (bands = b));
  });

  const L = 34;
  const R = 6;
  const T = 8;
  const B = 20;
  const series = $derived.by(() => {
    if (!bands) return [];
    return runs.flatMap(({ id, colour }) => {
      const levels = bands!.runs[String(id)]?.[mic];
      return levels ? [{ id, colour, values: perHz(levels, bands!.centres) }] : [];
    });
  });
  const domain = $derived.by((): [number, number] => {
    const all = series.flatMap((s) => s.values.filter((v): v is number => v !== null));
    if (!all.length) return [40, 90];
    return [Math.floor(Math.min(...all) / 5) * 5 - 2, Math.ceil(Math.max(...all) / 5) * 5 + 2];
  });
  const n = $derived(bands?.centres.length ?? 30);
  const logs = $derived((bands?.centres ?? []).map(Math.log10));
  const x = (k: number) => L + ((logs[k] - logs[0]) / (logs[n - 1] - logs[0] || 1)) * (width - L - R);
  const xf = (f: number) => L + ((Math.log10(f) - logs[0]) / (logs[n - 1] - logs[0] || 1)) * (width - L - R);
  const y = (v: number) => T + (1 - (v - domain[0]) / (domain[1] - domain[0])) * (height - T - B);
  const path = (values: (number | null)[]) =>
    values.map((v, k) => (v === null ? '' : `${k && values[k - 1] !== null ? 'L' : 'M'}${x(k).toFixed(1)},${y(v).toFixed(1)}`)).join('');
  const yTicks = $derived([domain[0] + 2, Math.round((domain[0] + domain[1]) / 2), domain[1] - 2]);
</script>

{#if series.length}
  <figure bind:clientWidth={width}>
    <svg {width} {height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Spectrum at ${mic}, dB per Hz`}>
      <rect x={L} y={T} width={Math.max(0, xf(250) - L)} height={height - T - B} fill="var(--ink)" opacity="0.045" />
      {#each [40, 200, 1000, 5000, 20000] as f (f)}
        <line x1={xf(f)} y1={T} x2={xf(f)} y2={height - B} stroke="var(--grid)" />
        <text x={xf(f)} y={height - 5} text-anchor={f === 20000 ? 'end' : 'middle'} class="tick">{f >= 1000 ? `${f / 1000}k` : f}{f === 20000 ? ' Hz' : ''}</text>
      {/each}
      {#each yTicks as v (v)}
        <text x={L - 6} y={y(v) + 3} text-anchor="end" class="tick">{v}</text>
      {/each}
      {#each [...series].reverse() as s (s.id)}
        <path d={path(s.values)} fill="none" stroke={`var(${s.colour})`} stroke-width="2" stroke-linejoin="round" />
      {/each}
    </svg>
    <figcaption class="dim">{caption || `Spectrum at ${mic === 'SE' ? "the shooter's ear" : mic}, dB per Hz. Shaded: below 250 Hz, the thump dBA discounts.`}</figcaption>
  </figure>
{/if}

<style>
  figure {
    margin: 0;
  }
  svg {
    display: block;
    overflow: visible;
  }
  .tick {
    font: 10px var(--sans);
    fill: var(--tick);
  }
  figcaption {
    margin-top: 4px;
    font-size: 12.5px;
  }
</style>

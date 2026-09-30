<script lang="ts">
  import type { Range } from '../tbacss.ts';

  // A two-handle slider with a typed number at each end. The slider is for
  // sweeping, the numbers for "under 16 oz" -- either one drives the other.
  let { label, unit, extent, value, step = 0.1, width = 120, onchange }: {
    label: string;
    unit: string;
    extent: [number, number];
    value: Range | null;
    step?: number;
    width?: number;
    onchange: (value: Range | null) => void;
  } = $props();

  const lo = $derived(value?.[0] ?? extent[0]);
  const hi = $derived(value?.[1] ?? extent[1]);
  const pct = (v: number) => ((v - extent[0]) / (extent[1] - extent[0] || 1)) * 100;
  const id = `range-${Math.random().toString(36).slice(2, 8)}`;

  function commit(a: number, b: number) {
    if (!Number.isFinite(a)) a = extent[0];
    if (!Number.isFinite(b)) b = extent[1];
    if (a > b) [a, b] = [b, a];
    const atLo = a <= extent[0] + step / 2;
    const atHi = b >= extent[1] - step / 2;
    onchange(atLo && atHi ? null : [atLo ? null : round(a), atHi ? null : round(b)]);
  }
  const round = (v: number) => Math.round(v / step) * step;
</script>

<div class="range" role="group" aria-labelledby={id}>
  <span class="cap" {id}>{label}</span>
  <input
    class="field num"
    type="number"
    inputmode="decimal"
    {step}
    value={lo.toFixed(1)}
    aria-label={`Minimum ${label.toLowerCase()}, ${unit}`}
    onchange={(e) => commit(Number(e.currentTarget.value), hi)}
  />
  <div class="track" style:width={`${width}px`} style:--a={`${pct(lo)}%`} style:--b={`${pct(hi)}%`}>
    <input type="range" min={extent[0]} max={extent[1]} {step} value={lo} aria-label={`Minimum ${label.toLowerCase()}`}
      oninput={(e) => commit(Math.min(Number(e.currentTarget.value), hi), hi)} />
    <input type="range" min={extent[0]} max={extent[1]} {step} value={hi} aria-label={`Maximum ${label.toLowerCase()}`}
      oninput={(e) => commit(lo, Math.max(Number(e.currentTarget.value), lo))} />
  </div>
  <input
    class="field num"
    type="number"
    inputmode="decimal"
    {step}
    value={hi.toFixed(1)}
    aria-label={`Maximum ${label.toLowerCase()}, ${unit}`}
    onchange={(e) => commit(lo, Number(e.currentTarget.value))}
  />
  <span class="unit dim">{unit}</span>
</div>

<style>
  .range {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .field {
    width: 54px;
    height: 28px;
    padding: 0 6px;
    font-size: 13px;
    text-align: right;
    appearance: textfield;
    -moz-appearance: textfield;
  }
  .field::-webkit-inner-spin-button {
    display: none;
  }
  .unit {
    font-size: 13px;
  }
  .track {
    position: relative;
    height: 20px;
    flex-shrink: 0;
  }
  @media (max-width: 760px) {
    .range {
      flex-wrap: wrap;
      width: 100%;
    }
    .range > .cap {
      flex-basis: 100%;
    }
    .track {
      flex: 1;
      width: auto !important;
      height: 34px;
    }
    .track::before {
      top: 16px;
    }
    .track::after {
      top: 15.5px;
    }
    .field {
      height: 34px;
    }
  }
  .track::before,
  .track::after {
    content: '';
    position: absolute;
    top: 9px;
    height: 2px;
    border-radius: 2px;
  }
  .track::before {
    left: 0;
    right: 0;
    background: var(--rule-strong);
  }
  .track::after {
    left: var(--a);
    right: calc(100% - var(--b));
    height: 3px;
    top: 8.5px;
    background: var(--ink);
  }
  /* Two range inputs stacked; only their thumbs take the pointer. */
  input[type='range'] {
    position: absolute;
    inset: 0;
    width: 100%;
    margin: 0;
    background: none;
    pointer-events: none;
    appearance: none;
    z-index: 1;
  }
  input[type='range']::-webkit-slider-thumb {
    appearance: none;
    width: 15px;
    height: 15px;
    border: 2px solid var(--ink);
    border-radius: 50%;
    background: var(--paper);
    pointer-events: auto;
    cursor: grab;
  }
  input[type='range']::-moz-range-thumb {
    width: 11px;
    height: 11px;
    border: 2px solid var(--ink);
    border-radius: 50%;
    background: var(--paper);
    pointer-events: auto;
    cursor: grab;
  }
  input[type='range']::-webkit-slider-runnable-track {
    background: none;
  }
  input[type='range']::-moz-range-track {
    background: none;
  }
</style>

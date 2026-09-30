<script lang="ts">
  // One value on a shared scale with its ±1 standard error: the row-by-row
  // picture of how much the ranking can actually be trusted.
  let { value, sem, lo, hi, width = 120, selected = false }: {
    value: number;
    sem: number | null;
    lo: number;
    hi: number;
    width?: number;
    selected?: boolean;
  } = $props();
  const x = (v: number) => Math.max(0, Math.min(width, ((v - lo) / (hi - lo || 1)) * width));
</script>

<svg {width} height="16" viewBox={`0 0 ${width} 16`} aria-hidden="true">
  <line x1="0" y1="8" x2={width} y2="8" stroke="var(--grid)" />
  {#if sem !== null}
    <rect x={x(value - sem)} y="5" width={Math.max(1, x(value + sem) - x(value - sem))} height="6" fill="var(--ci)" />
  {/if}
  <circle cx={x(value)} cy="8" r="3.5" fill={selected ? 'var(--sel)' : 'var(--sel)'} />
</svg>

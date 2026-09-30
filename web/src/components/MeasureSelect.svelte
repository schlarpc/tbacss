<script lang="ts">
  import { MEASURES, measure } from '../lib/measures.ts';
  import { app } from '../lib/state.svelte.ts';

  // A native select dressed as a dotted phrase inside a sentence ("Ranked by
  // shooter's ear, peak dBA ▾"). Grouped by mic; only measures this bundle has.
  let { value, onchange, label, none = null, objectivesOnly = false }: {
    value: string | null;
    onchange: (key: string | null) => void;
    label: string;
    none?: string | null;
    objectivesOnly?: boolean;
  } = $props();

  const available = $derived(
    MEASURES.filter((m) => {
      if (objectivesOnly && !m.better) return false;
      const column = app.cat?.columns[m.key];
      return column && column.some((v) => !Number.isNaN(v));
    }),
  );
  const groups = $derived([...new Set(available.map((m) => m.group))]);
  const shown = $derived(value ? measure(value).label : (none ?? ''));
</script>

<span class="wrap">
  <span class="face" aria-hidden="true">{shown} <span class="caret">▾</span></span>
  <select aria-label={label} value={value ?? ''} onchange={(e) => onchange(e.currentTarget.value || null)}>
    {#if none}<option value="">{none}</option>{/if}
    {#each groups as group (group)}
      <optgroup label={group}>
        {#each available.filter((m) => m.group === group) as m (m.key)}
          <option value={m.key}>{m.short}</option>
        {/each}
      </optgroup>
    {/each}
  </select>
</span>

<style>
  .wrap {
    position: relative;
    display: inline-block;
    white-space: nowrap;
  }
  .face {
    border-bottom: 1px dotted currentColor;
  }
  .caret {
    font-size: 0.7em;
  }
  select {
    position: absolute;
    inset: 0;
    width: 100%;
    opacity: 0;
    cursor: pointer;
    font-size: 14px;
  }
  .wrap:has(select:focus-visible) .face {
    outline: 2px solid var(--sel);
    outline-offset: 2px;
  }
</style>

<script lang="ts">
  import type { Snippet } from 'svelte';
  import { extentOf, nameOf, text } from '../lib/explore.ts';
  import { app } from '../lib/state.svelte.ts';
  import ChipCombo from './ChipCombo.svelte';
  import Menu from './Menu.svelte';
  import RangeField from './RangeField.svelte';

  // Everything that narrows the field within one host. Choices and slider
  // ends come from the whole host, not the current slice, so narrowing one
  // filter never makes another's options vanish under the pointer.
  let { trailing }: { trailing?: Snippet } = $props();
  let open = $state(false);

  const field = $derived(app.field);
  const years = $derived(app.hostYears);

  function counts(read: (i: number) => string | null) {
    const out = new Map<string, number>();
    for (const i of field) {
      const value = read(i);
      if (value) out.set(value, (out.get(value) ?? 0) + 1);
    }
    return out;
  }
  const calibers = $derived(
    app.cat ? [...counts((i) => text(app.cat!, 'caliber', i))].sort((a, b) => b[1] - a[1]) : [],
  );
  const makers = $derived(
    app.cat
      ? [...counts((i) => nameOf(app.cat!, i).maker)]
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([value, count]) => ({ value, count }))
      : [],
  );
  const weight = $derived(app.cat ? extentOf(app.cat, 'weight_oz', field) : null);
  const length = $derived(app.cat ? extentOf(app.cat, 'length_in', field) : null);

  /** All years pressed means no year filter; unpressing one keeps the rest. */
  function toggleYear(year: number) {
    const current = app.activeYears.length ? app.activeYears : years;
    const next = current.includes(year) ? current.filter((y) => y !== year) : [...current, year].sort();
    app.go({ years: next.length === years.length || !next.length ? [] : next });
  }
  const yearOn = (year: number) => !app.activeYears.length || app.activeYears.includes(year);

  function toggleCaliber(value: string) {
    const current = app.route.calibers;
    app.go({ calibers: current.includes(value) ? current.filter((c) => c !== value) : [...current, value] });
  }
  const floor = (v: number) => Math.floor(v * 10) / 10;
  const ceil = (v: number) => Math.ceil(v * 10) / 10;
</script>

<div class="bar">
  <button type="button" class="btn toggle" aria-expanded={open} aria-controls="filters" onclick={() => (open = !open)}>
    Filters{app.filterCount ? ` · ${app.filterCount}` : ''}
  </button>
  <section id="filters" class="filters" class:open aria-label="Filters">
    {#if years.length > 1}
      <div class="group" role="group" aria-label="Year">
        {#each years as year (year)}
          <button type="button" class="pill" aria-pressed={yearOn(year)} onclick={() => toggleYear(year)}>{year}</button>
        {/each}
      </div>
    {/if}
    {#if calibers.length > 1}
      <Menu label={app.route.calibers.length ? `Caliber: ${app.route.calibers.join(', ')}` : 'Caliber: any'} pressed={app.route.calibers.length > 0}>
        {#each calibers as [value, count] (value)}
          <label class="check">
            <input type="checkbox" checked={app.route.calibers.includes(value)} onchange={() => toggleCaliber(value)} />
            <span>{value}</span><span class="num dim">{count}</span>
          </label>
        {/each}
      </Menu>
    {/if}
    <ChipCombo label="Add a maker" placeholder="+ maker…" options={makers} selected={app.route.makers} onchange={(v) => app.go({ makers: v })} />
    {#if weight && weight[1] > weight[0]}
      <RangeField label="Weight" unit="oz" extent={[floor(weight[0]), ceil(weight[1])]} value={app.route.weight} onchange={(v) => app.go({ weight: v })} />
    {/if}
    {#if length && length[1] > length[0]}
      <RangeField label="Length" unit="in" width={90} extent={[floor(length[0]), ceil(length[1])]} value={app.route.length} onchange={(v) => app.go({ length: v })} />
    {/if}
    {#if app.filterCount}
      <button type="button" class="linkish clear" onclick={() => app.resetFilters()}>Clear</button>
    {/if}
  </section>
  <div class="trailing">{#if trailing}{@render trailing()}{/if}</div>
</div>

<style>
  .bar {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 14px 0;
    border-bottom: 1px solid var(--rule);
  }
  .filters {
    display: flex;
    align-items: center;
    gap: 12px 16px;
    flex-wrap: wrap;
    flex: 1;
    min-width: 0;
  }
  .group {
    display: flex;
    gap: 6px;
  }
  .trailing {
    margin-left: auto;
    flex-shrink: 0;
  }
  .toggle {
    display: none;
  }
  .check {
    display: grid;
    grid-template-columns: auto 1fr auto;
    gap: 8px;
    align-items: center;
    padding: 5px 4px;
    font-size: 13px;
    cursor: pointer;
  }
  .clear {
    font-size: 13px;
  }
  @media (max-width: 760px) {
    .bar {
      flex-wrap: wrap;
    }
    .toggle {
      display: inline-flex;
    }
    .filters {
      display: none;
      order: 3;
      flex-basis: 100%;
      flex-direction: column;
      align-items: flex-start;
    }
    .filters.open {
      display: flex;
    }
  }
</style>

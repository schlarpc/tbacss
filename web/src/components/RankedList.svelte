<script lang="ts">
  import { leaderTieDepth, nameOf, num, semOf, tiedWith, yearOf, hostOf } from '../lib/explore.ts';
  import { fmt, measure } from '../lib/measures.ts';
  import { app } from '../lib/state.svelte.ts';
  import ErrorBar from './ErrorBar.svelte';
  import FrontierTag from './FrontierTag.svelte';
  import Info from './Info.svelte';
  import MeasureSelect from './MeasureSelect.svelte';
  import YearFlag from './YearFlag.svelte';

  // The ranked field, with the uncertainty drawn on every row and the leader's
  // statistical tie bracketed -- so a 0.2 dB gap is not read as a ranking.
  const PAGE = 10;
  let shown = $state(PAGE);
  $effect(() => {
    // A different field starts from the top.
    void app.ranked;
    shown = PAGE;
  });

  const cat = $derived(app.cat!);
  const by = $derived(measure(app.route.by));
  const across = $derived(app.host === null);
  const rows = $derived(app.ranked.slice(0, shown));

  /** Two context columns after the ranking one, whichever it is. */
  const extra = $derived(
    ['ml_peak_db', 'se_reduction_dba', 'weight_oz'].filter((k) => k !== by.key).slice(0, 2).map(measure),
  );

  const scale = $derived.by((): [number, number] => {
    const values = rows.map((i) => num(cat, by.key, i));
    const sems = rows.map((i) => semOf(cat, by.key, i) ?? 0);
    const lo = Math.min(...values.map((v, n) => v - sems[n]));
    const hi = Math.max(...values.map((v, n) => v + sems[n]));
    const pad = (hi - lo) * 0.08 || 0.5;
    return [lo - pad, hi + pad];
  });

  const depth = $derived(across ? 0 : leaderTieDepth(cat, app.ranked, by.key));
  const tied = $derived(across || !app.ranked.length ? 0 : tiedWith(cat, app.ranked, by.key, app.ranked[0]).length);
</script>

<section class="ranked">
  <div class="head">
    <h2>
      {across ? 'Sorted' : 'Ranked'} by
      <MeasureSelect label="Rank by" value={app.route.by} objectivesOnly onchange={(k) => k && app.go({ by: k })} />
    </h2>
    <span class="dim">
      {by.better === 'max' ? 'higher' : 'lower'} is better · {app.ranked.length.toLocaleString()} runs
    </span>
  </div>

  {#if across}
    <p class="note dim">Every host at once: guns differ, so this is a list, not a ranking.</p>
  {:else}
    <div class="flag">
      <YearFlag years={app.years} action="Rank one year at a time" onaction={() => app.go({ years: [app.years[app.years.length - 1]] })} />
    </div>
  {/if}

  <div class="row header" aria-hidden="true">
    <span></span><span class="cap">Suppressor</span><span class="cap">±1 std. error</span>
    <span class="cap r">{by.group === 'Size' ? by.short : by.group === "Shooter's ear" ? 'Ear' : by.group} <span class="unit">{by.unit}</span></span>
    {#each extra as m (m.key)}<span class="cap r">{m.key === 'se_reduction_dba' ? 'vs bare' : m.key === 'ml_peak_db' ? 'Muzzle' : m.short} <span class="unit">{m.key === 'se_reduction_dba' ? '' : m.unit}</span></span>{/each}
  </div>

  <div class="list">
  {#if depth > 0 && rows.length > 1}
    <div class="bracket" aria-hidden="true" style:--rows={Math.min(depth, rows.length - 1) + 1}>
      <span class="cap">statistical tie</span>
    </div>
  {/if}
  <ol>
    {#each rows as i, n (i)}
      {@const name = nameOf(cat, i)}
      <li>
        <button type="button" class="row" class:selected={app.selected === i} aria-current={app.selected === i ? 'true' : undefined} onclick={() => app.selectRun(i)}>
          <span class="rank serif num" class:lead={n === 0 && !across}>{across ? '' : n + 1}</span>
          <span class="who">
            <span class="line"><span class="model serif">{name.model}</span>{#if app.frontier.has(i)}<FrontierTag />{/if}</span>
            <span class="meta dim">
              {name.maker} · {fmt(num(cat, 'weight_oz', i), 1)} oz · {yearOf(cat, i)}{#if across} · {cat.hosts[hostOf(cat, i)]?.label ?? hostOf(cat, i)}{/if}
            </span>
          </span>
          <span class="bar"><ErrorBar value={num(cat, by.key, i)} sem={semOf(cat, by.key, i)} lo={scale[0]} hi={scale[1]} /></span>
          <span class="value num r">{fmt(num(cat, by.key, i), by.digits)}</span>
          {#each extra as m (m.key)}
            <span class="num dim r">{m.key === 'se_reduction_dba' ? fmt(-num(cat, m.key, i), 1) : fmt(num(cat, m.key, i), 1)}</span>
          {/each}
        </button>
      </li>
    {/each}
  </ol>
  </div>

  {#if tied > 0}
    <p class="note dim">
      {tied} other {tied === 1 ? 'can' : 'cans'} here {tied === 1 ? 'is' : 'are'} within measurement error of No. 1 — the order at the top is mostly noise.<Info term="tie" />
    </p>
  {/if}
  <div class="more">
    <span class="dim">1–{rows.length} of {app.ranked.length.toLocaleString()}</span>
    {#if shown < app.ranked.length}
      <button type="button" class="linkish" onclick={() => (shown += 25)}>Show 25 more</button>
    {/if}
  </div>
</section>

<style>
  .head {
    display: flex;
    align-items: baseline;
    gap: 12px;
    flex-wrap: wrap;
  }
  h2 {
    font-size: 24px;
  }
  .flag {
    margin: 12px 0 6px;
  }
  .note {
    margin-top: 10px;
    font-size: 13px;
  }
  .list {
    position: relative;
  }
  ol {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .row {
    display: grid;
    grid-template-columns: 36px minmax(0, 1fr) 120px 76px 58px 58px;
    align-items: center;
    gap: 12px;
    width: 100%;
    min-height: 47px;
    padding: 4px 0;
    border: none;
    border-bottom: 1px solid var(--rule);
    background: none;
    text-align: left;
    cursor: pointer;
  }
  .row.header {
    min-height: 30px;
    cursor: default;
  }
  button.row:hover {
    background: color-mix(in srgb, var(--paper-3) 45%, transparent);
  }
  .row.selected {
    margin: 0 -12px;
    padding-inline: 12px;
    width: calc(100% + 24px);
    background: var(--sel-soft);
  }
  .rank {
    font-size: 24px;
    color: var(--dot);
  }
  .rank.lead {
    color: var(--sel);
  }
  .who {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .line {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .model {
    font-size: 18px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .meta {
    font-size: 12px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .value {
    font-size: 17px;
    font-weight: 600;
  }
  .r {
    text-align: right;
  }
  .header .cap {
    white-space: nowrap;
  }
  .unit {
    text-transform: none;
    letter-spacing: 0;
  }
  .bracket {
    position: absolute;
    left: -26px;
    top: 4px;
    height: calc(var(--rows) * 48px - 8px);
    width: 10px;
    border: 2px solid var(--sel);
    border-right: none;
    border-radius: 4px 0 0 4px;
  }
  .bracket .cap {
    position: absolute;
    left: -16px;
    top: 50%;
    color: var(--sel);
    white-space: nowrap;
    transform: rotate(-90deg) translateX(-50%);
    transform-origin: left top;
  }
  .more {
    display: flex;
    justify-content: space-between;
    padding: 12px 0;
    font-size: 13px;
  }
  @media (max-width: 1100px) {
    .row {
      grid-template-columns: 30px minmax(0, 1fr) 90px 64px;
    }
    .row > :nth-child(n + 5) {
      display: none;
    }
    .bar :global(svg) {
      width: 90px;
    }
  }
  @media (max-width: 760px) {
    .row {
      grid-template-columns: 26px minmax(0, 1fr) 64px;
    }
    .row > .bar,
    .row.header > :nth-child(3) {
      display: none;
    }
    .bracket {
      display: none;
    }
    .row.selected {
      margin: 0 -16px;
      padding-inline: 16px;
      width: calc(100% + 32px);
    }
  }
</style>

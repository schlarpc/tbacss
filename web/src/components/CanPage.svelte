<script lang="ts">
  import { hostOf, nameOf, num, rankOnHost, runsOfCan, semOf, text, yearOf } from '../lib/explore.ts';
  import { fmt } from '../lib/measures.ts';
  import { app } from '../lib/state.svelte.ts';
  import Icon from './Icon.svelte';
  import Info from './Info.svelte';
  import Masthead from './Masthead.svelte';

  // One suppressor across every host it was tested on. The rank strip puts
  // each result in its own host's field, because the dBA figures across rows
  // are different guns and do not compare.
  const cat = $derived(app.cat!);
  const key = $derived(app.route.can ?? '');
  const runs = $derived(runsOfCan(cat, key));
  const name = $derived(runs.length ? nameOf(cat, runs[0]) : (cat.cans[key] ?? { maker: '', model: key }));
  const years = $derived([...new Set(runs.map((i) => yearOf(cat, i)))].sort());
  const hosts = $derived(new Set(runs.map((i) => hostOf(cat, i))).size);
  const spellings = $derived([...new Set(runs.map((i) => text(cat, 'suppressor', i) ?? ''))]);
  const latest = $derived(runs.length ? runs[runs.length - 1] : null);

  const rows = $derived(
    runs
      .map((i) => ({ i, rank: rankOnHost(cat, i, 'se_peak_dba') }))
      .sort((a, b) => (a.rank && b.rank ? a.rank.rank / a.rank.of - b.rank.rank / b.rank.of : 0)),
  );
  const cycling = (i: number) => text(cat, 'host_cycling', i);
  const W = 240;
  const strip = (rank: number, of: number) => 8 + ((rank - 1) / Math.max(1, of - 1)) * (W - 16);
</script>

<div class="page">
  <Masthead>
    {#snippet eyebrow()}
      {name.maker}{#if latest !== null}{' · '}{text(cat, 'caliber', latest)} · {fmt(num(cat, 'weight_oz', latest), 1)} oz · {fmt(num(cat, 'length_in', latest), 2)} in{/if}
    {/snippet}
    {name.model}
  </Masthead>

  {#if !runs.length}
    <p class="empty serif">No suppressor by that name. <button type="button" class="linkish" onclick={() => app.openExplore()}>Back to the list</button></p>
  {:else}
    <div class="grid">
      <section>
        <div class="scroll">
        <table>
          <thead>
            <tr>
              <th class="cap">Host</th>
              <th class="cap nowrap">← quieter · rank at the ear<Info term="se" /></th>
              <th class="cap r">Rank</th>
              <th class="cap r">SE dBA</th>
              <th class="cap r">ML dB</th>
              <th class="cap r nowrap">vs bare</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {#each rows as { i, rank } (i)}
              <tr>
                <th scope="row">
                  <div class="serif host">{cat.hosts[hostOf(cat, i)]?.label ?? hostOf(cat, i)}</div>
                  <div class="cap">{cycling(i) ?? ''} · {yearOf(cat, i)}</div>
                </th>
                <td>
                  {#if rank}
                    <svg width={W} height="26" viewBox={`0 0 ${W} 26`} role="img" aria-label={`Rank ${rank.rank} of ${rank.of}`}>
                      <line x1="8" y1="13" x2={W - 8} y2="13" stroke="var(--rule-strong)" stroke-width="6" stroke-linecap="round" />
                      <line x1="8" y1="13" x2={(W - 16) / 4 + 8} y2="13" stroke="var(--dot)" stroke-width="6" stroke-linecap="round" />
                      <circle cx={strip(rank.rank, rank.of)} cy="13" r="7" fill={cycling(i) === 'manual' ? 'var(--sel)' : 'var(--cmp-1)'} stroke="var(--paper)" stroke-width="2" />
                    </svg>
                  {/if}
                </td>
                <td class="num r">{#if rank}<b class="rank">#{rank.rank}</b> <span class="dim">of {rank.of}</span>{/if}</td>
                <td class="num r val">{fmt(num(cat, 'se_peak_dba', i))}{#if semOf(cat, 'se_peak_dba', i)}<span class="dim sem"> ±{fmt(semOf(cat, 'se_peak_dba', i))}</span>{/if}</td>
                <td class="num r dim">{fmt(num(cat, 'ml_peak_db', i), 1)}</td>
                <td class="num r dim">{fmt(-num(cat, 'se_reduction_dba', i), 1)}</td>
                <td class="r acts">
                  <button type="button" class="linkish" onclick={() => app.openExplore({ host: hostOf(cat, i), run: cat.ids[i], shot: null, view: 'rank', years: [], calibers: [], makers: [], weight: null, length: null })}>Open run</button>
                  <button type="button" class="add" aria-label="Compare" aria-pressed={app.isCompared(i)} onclick={() => app.toggleCompare(i)}><Icon name={app.isCompared(i) ? 'check' : 'plus'} size={12} /></button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
        </div>
        <p class="dim foot">Shaded quarter of each strip = the top 25%. Ranks are among every can tested on that host; don't compare dBA across rows — they are different guns.</p>
      </section>
      <aside>
        <div class="block strong">
          <div class="cap">Tested</div>
          <div class="serif big">{runs.length} {runs.length === 1 ? 'time' : 'times'}, {years.length > 1 ? `${years[0]}–${String(years[years.length - 1]).slice(2)}` : years[0]}</div>
          <div class="dim">on {hosts} {hosts === 1 ? 'host' : 'hosts'}</div>
        </div>
        {#if spellings.length > 1}
          <div class="block">
            <div class="cap">Listed by TBAC as</div>
            <p>{spellings.map((s) => `“${s}”`).join(' and ')} — merged here.</p>
          </div>
        {/if}
        <div class="block">
          <div class="cap">Legend</div>
          <p><span style:color="var(--sel)">●</span> bolt or manual action · <span style:color="var(--cmp-1)">●</span> self-loading, where action noise can dominate</p>
        </div>
      </aside>
    </div>
  {/if}
</div>

<style>
  .empty {
    padding: 40px 0;
    font-size: 20px;
  }
  .grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 300px;
    gap: 56px;
    padding: 26px 0 40px;
  }
  section {
    min-width: 0;
  }
  .scroll {
    overflow-x: auto;
  }
  table {
    width: 100%;
    border-collapse: collapse;
  }
  thead tr {
    border-bottom: 2px solid var(--ink);
  }
  thead th {
    padding: 0 10px 6px;
    text-align: left;
  }
  thead th:first-child {
    padding-left: 0;
  }
  tbody tr {
    border-bottom: 1px solid var(--rule);
  }
  tbody th {
    padding: 10px 0;
    text-align: left;
    font-weight: 400;
  }
  .host {
    font-size: 19px;
    white-space: nowrap;
  }
  td {
    padding: 0 10px;
  }
  .r {
    text-align: right;
  }
  .nowrap {
    white-space: nowrap;
  }
  .rank {
    font-size: 17px;
  }
  .val {
    font-size: 16px;
  }
  .sem {
    font-size: 11.5px;
  }
  .acts {
    white-space: nowrap;
  }
  .add {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    margin-left: 8px;
    border: 1px solid var(--ink);
    border-radius: 50%;
    background: none;
    vertical-align: middle;
    cursor: pointer;
  }
  .foot {
    margin-top: 12px;
    font-size: 13px;
  }
  aside {
    display: flex;
    flex-direction: column;
    gap: 18px;
  }
  .block {
    padding-top: 12px;
    border-top: 1px solid var(--rule);
    font-size: 14px;
  }
  .block.strong {
    border-top: 4px solid var(--ink);
  }
  .big {
    margin-top: 6px;
    font-size: 30px;
    line-height: 1.1;
  }
  .block p {
    margin-top: 4px;
  }
  @media (max-width: 1100px) {
    .grid {
      grid-template-columns: 1fr;
    }
  }
  /* Phones: each host a small card -- name and rank, the strip full width,
     then the figure and the actions. */
  @media (max-width: 760px) {
    table,
    tbody,
    tr,
    th,
    td {
      display: block;
    }
    thead {
      display: none;
    }
    tbody tr {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 4px 12px;
      padding: 12px 0;
    }
    tbody th {
      padding: 0;
    }
    td {
      padding: 0;
    }
    td:nth-child(2) {
      grid-column: 1 / -1;
      grid-row: 2;
    }
    td:nth-child(2) svg {
      width: 100%;
      height: auto;
    }
    td:nth-child(3) {
      grid-column: 2;
      grid-row: 1;
      align-self: center;
    }
    td:nth-child(4) {
      grid-column: 1;
      text-align: left;
    }
    td:nth-child(5),
    td:nth-child(6) {
      display: none;
    }
    td:nth-child(7) {
      grid-column: 2;
      align-self: center;
    }
    .host {
      white-space: normal;
    }
  }
</style>

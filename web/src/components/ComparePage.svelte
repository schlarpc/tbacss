<script lang="ts">
  import { canOf, hostOf, nameOf, num, semOf, text, yearOf } from '../lib/explore.ts';
  import { fmt } from '../lib/measures.ts';
  import { app } from '../lib/state.svelte.ts';
  import { shotsOf } from '../lib/wave.ts';
  import CompareWave from './CompareWave.svelte';
  import Icon from './Icon.svelte';
  import Info from './Info.svelte';
  import ListenButton from './ListenButton.svelte';
  import SpeedSelect from './SpeedSelect.svelte';
  import Masthead from './Masthead.svelte';
  import SpectrumFigure from './SpectrumFigure.svelte';
  import YearFlag from './YearFlag.svelte';

  // Two to four runs side by side: every number with the best in each row
  // marked, their first shots overlaid and aligned, and played in turn.
  const cat = $derived(app.cat!);
  const runs = $derived(app.compared);
  const tone = (i: number) => app.colourOf(i) ?? '--ink';
  const hosts = $derived([...new Set(runs.map((i) => hostOf(cat, i)))]);
  const years = $derived([...new Set(runs.map((i) => yearOf(cat, i)))].sort());
  const hostLabel = (code: string) => cat.hosts[code]?.label ?? code;

  const ROWS: { key: string; label: string; unit: string; digits: number; better: 'min' | 'max'; term?: string; sign?: boolean }[] = [
    { key: 'se_peak_dba', label: "Shooter's ear, peak", unit: 'dBA', digits: 2, better: 'min', term: 'se' },
    { key: 'se_peak_leq10ms_dba', label: "Shooter's ear, Leq 10 ms", unit: 'dBA', digits: 2, better: 'min', term: 'leq' },
    { key: 'se_impulse_db_ms', label: "Shooter's ear, impulse", unit: 'dB·ms', digits: 2, better: 'min', term: 'impulse' },
    { key: 'se_low_freq_db', label: 'Below 250 Hz at the ear', unit: 'dB', digits: 2, better: 'min', term: 'low' },
    { key: 'ml_peak_db', label: 'Muzzle, mil left, peak', unit: 'dB', digits: 2, better: 'min', term: 'ml' },
    { key: 'se_first_round_pop', label: 'First-round pop', unit: 'dBA', digits: 2, better: 'min', term: 'pop', sign: true },
    { key: 'se_reduction_dba', label: 'Vs bare muzzle', unit: 'dBA', digits: 1, better: 'max', term: 'reduction' },
    { key: 'weight_oz', label: 'Weight', unit: 'oz', digits: 1, better: 'min' },
    { key: 'length_in', label: 'Length', unit: 'in', digits: 2, better: 'min' },
    { key: 'max_diameter_in', label: 'Diameter', unit: 'in', digits: 2, better: 'min' },
  ];
  const best = (key: string, better: 'min' | 'max') => {
    const values = runs.map((i) => num(cat, key, i)).filter(Number.isFinite);
    return values.length > 1 ? (better === 'min' ? Math.min(...values) : Math.max(...values)) : NaN;
  };
  const firstShot = (i: number) => shotsOf(app.bundle!, cat.ids[i], 'SE').find((s) => !s.excluded) ?? null;
  const shots = $derived(runs.flatMap((i) => {
    const s = firstShot(i);
    return s ? [{ entry: s, colour: tone(i) }] : [];
  }));
  const title = $derived(
    runs.length < 2 ? 'Compare cans' : hosts.length === 1 ? `${['', '', 'Two', 'Three', 'Four'][runs.length]} cans, one rifle` : `${runs.length} cans, ${hosts.length} guns`,
  );
</script>

<div class="page">
  <Masthead>
    {#snippet eyebrow()}
      <button type="button" class="back" onclick={() => app.openExplore()}>← {app.host ? `The field on a ${hostLabel(app.host)}` : 'Back to the field'}</button>
    {/snippet}
    {title}
  </Masthead>

  {#if runs.length < 2}
    <p class="empty serif">
      {runs.length ? 'Add at least one more can' : 'Nothing to compare yet'} — pick <b>Compare</b> on any run, from the list, the plot or a can's page.
      <button type="button" class="linkish" onclick={() => app.openExplore()}>Back to the list</button>
    </p>
  {:else}
    <div class="notes">
      {#if hosts.length > 1}
        <YearFlag years={[0, 1]}>
          <b>Different guns:</b> {hosts.map(hostLabel).join(', ')}. Numbers only compare on the same host, so the best marks are left off.
        </YearFlag>
      {/if}
      {#if years.length > 1}
        <YearFlag {years}>
          <b>Tested in {years.join(' and ')}.</b> The test setup differs between Summits: cans tested in more than one year have measured up to 5 dB apart, so read gaps of a few dB with that in mind.
        </YearFlag>
      {/if}
    </div>

    <div class="grid">
      <div class="scroll">
      <table>
        <thead>
          <tr>
            <th class="label-col"></th>
            {#each runs as i (i)}
              {@const name = nameOf(cat, i)}
              <th scope="col" style:border-top-color={`var(${tone(i)})`}>
                <div class="cap">{name.maker} · {yearOf(cat, i)} · {text(cat, 'caliber', i)}</div>
                <button type="button" class="name serif" onclick={() => app.openCan(canOf(cat, i))}>{name.model}</button>
                <div class="acts">
                  <ListenButton shots={firstShot(i) ? [firstShot(i)!] : []} solid={false} small />
                  <button type="button" class="x" aria-label={`Remove ${name.model}`} onclick={() => app.toggleCompare(i)}><Icon name="x" size={10} /></button>
                </div>
              </th>
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each ROWS as row (row.key)}
            {@const top = hosts.length === 1 ? best(row.key, row.better) : NaN}
            <tr>
              <th scope="row">{row.label} <span class="dim unit">{row.unit}</span>{#if row.term}<Info term={row.term} />{/if}</th>
              {#each runs as i (i)}
                {@const v = num(cat, row.key, i)}
                {@const sem = semOf(cat, row.key, i)}
                <td class="num" class:best={v === top}>
                  {#if Number.isFinite(v)}
                    {#if v === top}<span class="dot" aria-label="best">●</span>{/if}{fmt(v, row.digits, { sign: row.sign })}{#if sem}<span class="dim sem">{' ±'}{fmt(sem)}</span>{/if}
                  {:else}
                    <span class="dim small">{row.key.includes('reduction') ? `no bare run in ${yearOf(cat, i)}` : '—'}</span>
                  {/if}
                </td>
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
      </div>

      <div class="figures">
        <div class="player">
          <ListenButton shots={shots.map((s) => s.entry)} label="Play in turn" />
          <SpeedSelect />
          <span class="serif order">
            {#each runs as i, n (i)}{#if n}<span class="dim">{' → '}</span>{/if}<span style:color={`var(${tone(i)})`}>{nameOf(cat, i).model}</span>{/each}
          </span>
          <p class="dim small">Shot 1 at the shooter's ear. Relative levels kept, scaled so the loudest plays at a safe volume.</p>
        </div>
        <figure>
          <CompareWave {shots} />
          <figcaption class="dim">Fig. 1 — shot 1 at the shooter's ear, aligned at the shot's start, Pa</figcaption>
        </figure>
        <SpectrumFigure runs={runs.map((i) => ({ id: cat.ids[i], colour: tone(i) }))} height={170} caption="Fig. 2 — spectrum at the shooter's ear, dB per Hz. Shaded: below 250 Hz, the thump dBA discounts." />
      </div>
    </div>
  {/if}
</div>

<style>
  .back {
    border: none;
    background: none;
    padding: 0;
    font: inherit;
    letter-spacing: inherit;
    text-transform: inherit;
    color: inherit;
    cursor: pointer;
  }
  .empty {
    padding: 40px 0;
    font-size: 20px;
  }
  .notes {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 18px;
  }
  .grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 560px);
    gap: 44px;
    padding: 18px 0 40px;
  }
  .scroll,
  .figures {
    min-width: 0;
  }
  .scroll {
    overflow-x: auto;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    table-layout: fixed;
  }
  thead th.label-col {
    width: 210px;
    border-top: none;
  }
  thead th {
    padding: 12px 14px 14px;
    border-top: 5px solid;
    text-align: right;
    vertical-align: top;
  }
  thead .cap {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .name {
    display: flex;
    align-items: flex-start;
    justify-content: flex-end;
    width: 100%;
    min-height: 51px;
    margin-top: 4px;
    padding: 0;
    border: none;
    background: none;
    font-size: 22px;
    font-weight: 500;
    line-height: 1.15;
    text-align: right;
    cursor: pointer;
  }
  .name:hover {
    text-decoration: underline;
  }
  .acts {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
    margin-top: 8px;
  }
  .x {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border: 1px solid var(--ink);
    border-radius: 50%;
    background: none;
    cursor: pointer;
  }
  tbody th {
    height: 42px;
    font-weight: 600;
    text-align: left;
    font-size: 14px;
  }
  tbody tr {
    border-bottom: 1px solid var(--rule);
  }
  td {
    padding: 0 14px;
    text-align: right;
    font-size: 16px;
  }
  td.best {
    font-weight: 700;
  }
  .dot {
    margin-right: 4px;
    font-size: 10px;
    vertical-align: 2px;
  }
  .sem,
  .unit {
    font-size: 12px;
    font-weight: 400;
  }
  .small {
    font-size: 11.5px;
  }
  .figures {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .player {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px 12px;
    padding: 14px 16px;
    border: 1px solid var(--ink);
    border-radius: 8px;
    background: var(--paper-2);
  }
  .player p {
    flex-basis: 100%;
  }
  .order {
    min-width: 0;
    font-size: 17px;
  }
  figure {
    margin: 0;
  }
  figcaption {
    margin-top: 4px;
    font-size: 12.5px;
  }
  @media (max-width: 1100px) {
    .grid {
      grid-template-columns: 1fr;
    }
  }
  @media (max-width: 760px) {
    table {
      min-width: 540px;
    }
    /* The measure names stay put while the cans scroll past. */
    tbody th,
    thead th.label-col {
      position: sticky;
      left: 0;
      z-index: 1;
      background: var(--paper);
    }
    thead th.label-col {
      width: 120px;
    }
    tbody th {
      font-size: 12.5px;
    }
    td {
      padding: 0 6px;
      font-size: 14px;
    }
    thead th {
      padding: 10px 6px;
    }
    .name {
      font-size: 17px;
    }
    .sem {
      display: none;
    }
  }
</style>

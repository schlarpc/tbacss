<script lang="ts">
  import type { WaveformEntry } from '../tbacss.ts';
  import { canOf, hostOf, nameOf, num, runsOfCan, semOf, text, tiedWith, yearOf } from '../lib/explore.ts';
  import { fmt, measure } from '../lib/measures.ts';
  import { app } from '../lib/state.svelte.ts';
  import { micsOf, shotsOf } from '../lib/wave.ts';
  import Icon from './Icon.svelte';
  import Info from './Info.svelte';
  import ListenButton from './ListenButton.svelte';
  import SpeedSelect from './SpeedSelect.svelte';
  import SpectrumFigure from './SpectrumFigure.svelte';
  import WaveFigure from './WaveFigure.svelte';

  // One run, written up: what it measured, where that puts it on its host,
  // what it sounds like, and the trace and spectrum behind the numbers.
  let { index, onclose = null }: { index: number; onclose?: (() => void) | null } = $props();

  const cat = $derived(app.cat!);
  const bundle = $derived(app.bundle!);
  const runId = $derived(cat.ids[index]);
  const name = $derived(nameOf(cat, index));
  const host = $derived(cat.hosts[hostOf(cat, index)]);
  const year = $derived(yearOf(cat, index));
  const by = $derived(measure(app.route.by));

  const rank = $derived(app.host ? app.ranked.indexOf(index) : -1);
  const ties = $derived(rank >= 0 ? tiedWith(cat, app.ranked, by.key, index).length : 0);
  const hosts = $derived(new Set(runsOfCan(cat, canOf(cat, index)).map((i) => hostOf(cat, i))).size);
  const report = $derived(cat.datasets?.find((d) => d.year === year)?.report_url ?? null);
  const caveat = $derived(text(cat, 'caveat', index));

  const mics = $derived(micsOf(bundle, runId));
  let mic = $state('SE');
  $effect(() => {
    if (!mics.includes(mic)) mic = mics[0] ?? 'SE';
  });
  const shots = $derived(shotsOf(bundle, runId, mic));
  const shot = $derived<WaveformEntry | null>(
    app.route.shot !== null ? (shots.find((s) => s.id === app.route.shot) ?? null) : null,
  );
  // Listen plays the string -- the scored shots in order, from the one on
  // screen (or the first) to the last -- so first-round pop is audible.
  const string = $derived(shots.filter((s) => !s.excluded));
  const listenTo = $derived(shot && !shot.excluded ? string.filter((s) => s.shot >= shot.shot) : shot ? [shot] : string);

  const se = $derived(num(cat, 'se_peak_dba', index));
  const reduction = $derived(num(cat, 'se_reduction_dba', index));
  const ordinal = (n: number) => `No. ${n}`;
</script>

<article>
  <header>
    <div class="title">
      <div class="cap">
        {#if rank >= 0}{ordinal(rank + 1)}{#if ties}, tied with {ties}{/if}{' · '}{/if}{name.maker} · {year} · {text(cat, 'caliber', index)}
      </div>
      <h2>{name.model}</h2>
    </div>
    <div class="actions">
      <ListenButton shots={listenTo} label={listenTo.length > 1 ? `Listen · ${listenTo.length} shots` : 'Listen'} />
      <SpeedSelect />
      <button type="button" class="btn" aria-pressed={app.isCompared(index)} onclick={() => app.toggleCompare(index)} disabled={!app.isCompared(index) && app.route.compare.length >= 4}>
        <Icon name={app.isCompared(index) ? 'check' : 'plus'} />{app.isCompared(index) ? 'Comparing' : 'Compare'}
      </button>
      {#if onclose}
        <button type="button" class="close" aria-label="Close" onclick={onclose}><Icon name="x" /></button>
      {/if}
    </div>
  </header>

  <p class="lede">
    {#if Number.isFinite(se)}
      Measured <b class="num">{fmt(se, 1)} dBA</b> at the shooter's ear{#if Number.isFinite(reduction)}, <b class="num">{fmt(reduction, 1)} dBA</b> quieter than the bare muzzle{/if}.
    {/if}
    {#if rank >= 0}
      No. {rank + 1} of {app.ranked.length} on the {host?.label ?? 'host'} by {by.label}{#if ties}, but within measurement error of {ties} {ties === 1 ? 'other' : 'others'}{/if}.
    {/if}
  </p>

  {#if caveat}
    <p class="caveat"><Icon name="flag" /> TBAC: {caveat}</p>
  {/if}

  <dl>
    <div><dt class="cap">Leq 10 ms<Info term="leq" /></dt><dd class="num">{fmt(num(cat, 'se_peak_leq10ms_dba', index))} <span>dBA</span></dd></div>
    <div><dt class="cap">Muzzle, ML<Info term="ml" /></dt><dd class="num">{fmt(num(cat, 'ml_peak_db', index))} <span>dB</span></dd></div>
    <div><dt class="cap">First-round pop<Info term="pop" /></dt><dd class="num">{fmt(num(cat, 'se_first_round_pop', index), 2, { sign: true })} <span>dBA</span></dd></div>
    <div><dt class="cap">Size</dt><dd class="num">{fmt(num(cat, 'weight_oz', index), 1)} <span>oz</span> · {fmt(num(cat, 'length_in', index), 2)} <span>in</span></dd></div>
  </dl>

  {#if bundle.byRun.get(runId)?.length}
    <div class="mics" role="group" aria-label="Microphone">
      {#each mics as m (m)}
        <button type="button" class="pill" aria-pressed={m === mic} onclick={() => {
          mic = m;
          app.go({ shot: null });
        }}>{m}</button>
      {/each}
      {#if semOf(cat, 'se_peak_dba', index) !== null}<span class="dim spread">±{fmt(semOf(cat, 'se_peak_dba', index))} dBA shot to shot</span>{/if}
    </div>
    <WaveFigure {runId} {mic} {shot} onshot={(entry) => app.go({ shot: entry?.id ?? null })} />
    <SpectrumFigure runs={[{ id: runId, colour: '--sel' }]} {mic} />
  {:else}
    <p class="dim">No waveforms were released for this run.</p>
  {/if}

  <footer>
    <button type="button" class="linkish" onclick={() => app.openCan(canOf(cat, index))}>
      {hosts > 1 ? `Every host this can was tested on (${hosts}) →` : 'This can’s page →'}
    </button>
    <span class="dim host">{host?.description ?? ''}</span>
    {#if report}<a href={report} rel="noreferrer">{year} report</a>{/if}
  </footer>
</article>

<style>
  article {
    display: flex;
    flex-direction: column;
    gap: 14px;
    border-top: 4px solid var(--sel);
    padding-top: 12px;
  }
  header {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 10px;
  }
  /* The controls wrap under the name before the name gets squeezed. */
  .title {
    flex: 1 1 240px;
    min-width: 0;
  }
  h2 {
    margin-top: 2px;
    font-size: 40px;
    line-height: 1.05;
  }
  .actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    justify-content: flex-end;
  }
  .close {
    display: none;
    width: 34px;
    height: 34px;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--rule-strong);
    border-radius: 50%;
    background: none;
    cursor: pointer;
  }
  .lede {
    font-family: var(--serif);
    font-size: 18px;
    line-height: 1.45;
    color: var(--ink-2);
  }
  .caveat {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    padding: 8px 12px;
    border-radius: 6px;
    background: var(--flag);
    color: var(--flag-ink);
    font-size: 13px;
  }
  dl {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    margin: 0;
    border-top: 1px solid var(--rule);
    border-bottom: 1px solid var(--rule);
  }
  dl > div {
    padding: 8px 0;
  }
  dd {
    margin: 2px 0 0;
    font-size: 17px;
  }
  dd span {
    font-size: 12px;
    color: var(--muted);
  }
  .mics {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .spread {
    margin-left: auto;
    font-size: 12.5px;
  }
  footer {
    display: flex;
    align-items: baseline;
    gap: 16px;
    padding-top: 10px;
    border-top: 1px solid var(--rule);
    font-size: 13px;
  }
  .host {
    flex: 1;
    font-size: 12.5px;
  }
  footer a {
    font-weight: 600;
    white-space: nowrap;
  }
  @media (max-width: 760px) {
    h2 {
      font-size: 34px;
    }
    header {
      flex-wrap: wrap;
    }
    .actions {
      width: 100%;
      justify-content: flex-start;
    }
    .close {
      display: inline-flex;
      margin-left: auto;
    }
    dl {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    footer {
      flex-wrap: wrap;
    }
    .host {
      flex-basis: 100%;
      order: 3;
    }
  }
</style>

<script lang="ts">
  import { hostTiers, yearSpan } from '../lib/explore.ts';
  import type { HostSummary } from '../lib/explore.ts';
  import { app } from '../lib/state.svelte.ts';
  import Icon from './Icon.svelte';

  // "Which gun?" Every host, nothing hidden: the regular guns as cards, then
  // every 2023 and one-off host as a list. Hosts with too few runs to rank are
  // greyed, not removed.
  let dialog: HTMLDialogElement;
  let query = $state('');
  const tiers = $derived(app.cat ? hostTiers(app.cat) : { regular: [], y2023: [], other: [] });
  const total = $derived(tiers.regular.length + tiers.y2023.length + tiers.other.length);
  const match = (h: HostSummary) => !query.trim() || `${h.label} ${h.description}`.toLowerCase().includes(query.trim().toLowerCase());

  $effect(() => {
    if (app.hostPickerOpen && !dialog.open) dialog.showModal();
    if (!app.hostPickerOpen && dialog.open) dialog.close();
  });
  const half = $derived(Math.ceil(tiers.other.filter(match).length / 2));
</script>

<dialog bind:this={dialog} onclose={() => (app.hostPickerOpen = false)} aria-labelledby="host-title" onclick={(e) => e.target === dialog && dialog.close()}>
  <div class="inner">
    <header>
      <h2 id="host-title">Which gun?</h2>
      <p class="dim">A can's numbers only compare on the same host. {total} hosts, {app.cat?.n.toLocaleString()} runs.</p>
      <input class="field" type="search" placeholder="Filter hosts" aria-label="Filter hosts" bind:value={query} />
      <button type="button" class="close" aria-label="Close" onclick={() => dialog.close()}><Icon name="x" /></button>
    </header>

    <div class="cap rule">Regular hosts · tested in more than one year</div>
    <div class="cards">
      {#each tiers.regular.filter(match) as h (h.code)}
        <button type="button" class="card" class:on={h.code === app.host} onclick={() => app.pickHost(h.code)}>
          <span class="top"><span class="serif name">{h.label}</span><span class="num count">{h.runs}</span></span>
          <span class="desc">{h.description}</span>
          <span class="cap kind">{h.kind} · {yearSpan(h.years)}</span>
          {#if h.earlier}
            <span class="earlier">+ {h.earlier.runs} runs from 2023, listed separately <span class="dim">— different setup</span></span>
          {/if}
        </button>
      {/each}
    </div>

    <div class="lists">
      <div>
        <div class="cap rule">2023 hosts · {tiers.y2023.length}</div>
        <ul>{#each tiers.y2023.filter(match) as h (h.code)}{@render row(h, false)}{/each}</ul>
      </div>
      <div class="wide">
        <div class="cap rule split"><span>Other hosts · {tiers.other.length}</span><span class="note">grey = fewer than 4 runs, too few to rank</span></div>
        <div class="cols">
          <ul>{#each tiers.other.filter(match).slice(0, half) as h (h.code)}{@render row(h, true)}{/each}</ul>
          <ul>{#each tiers.other.filter(match).slice(half) as h (h.code)}{@render row(h, true)}{/each}</ul>
        </div>
      </div>
    </div>

    <footer>
      <button type="button" class="btn" onclick={() => app.pickHost(null)}>Every host at once</button>
      <span class="dim">No frontier or ranking there — numbers across guns don't compare.</span>
    </footer>
  </div>
</dialog>

{#snippet row(h: HostSummary, withYear: boolean)}
  <li>
    <button type="button" class="row" class:few={h.runs < 4} class:on={h.code === app.host} onclick={() => app.pickHost(h.code)} title={h.description}>
      <span class="label">{h.label}</span>
      <span class="num meta">{#if withYear}<span class="dim">{yearSpan(h.years)}</span>{/if}<b>{h.runs}</b></span>
    </button>
  </li>
{/snippet}

<style>
  dialog {
    width: min(1200px, calc(100vw - 32px));
    max-height: calc(100vh - 64px);
    overflow: auto;
    padding: 0;
    border: none;
    border-radius: 10px;
    background: var(--paper);
    color: var(--ink);
    box-shadow: var(--shadow);
  }
  dialog::backdrop {
    background: var(--scrim);
  }
  .inner {
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 30px 40px;
  }
  header {
    display: flex;
    align-items: flex-end;
    gap: 20px;
  }
  h2 {
    font-size: 40px;
    line-height: 1;
  }
  header p {
    flex: 1;
    padding-bottom: 4px;
  }
  header .field {
    width: 220px;
  }
  .close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 34px;
    height: 34px;
    border: 1px solid var(--ink);
    border-radius: 50%;
    background: none;
    cursor: pointer;
  }
  .rule {
    padding-bottom: 6px;
    border-bottom: 2px solid var(--ink);
  }
  .split {
    display: flex;
    justify-content: space-between;
  }
  .note {
    font-weight: 400;
    text-transform: none;
    letter-spacing: 0;
  }
  .cards {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 12px;
  }
  .card {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 3px;
    padding: 12px 16px;
    border: 1px solid var(--rule-strong);
    border-radius: 8px;
    background: var(--paper-2);
    text-align: left;
    cursor: pointer;
  }
  .card:hover {
    border-color: var(--ink);
  }
  .card.on {
    background: var(--ink);
    border-color: var(--ink);
    color: var(--paper);
  }
  .card.on .cap {
    color: inherit;
  }
  .top {
    display: flex;
    width: 100%;
    align-items: baseline;
    gap: 8px;
  }
  .name {
    font-size: 20px;
  }
  .count {
    margin-left: auto;
    font-weight: 700;
  }
  .desc {
    font-size: 12.5px;
    opacity: 0.75;
  }
  .kind {
    opacity: 0.8;
  }
  .earlier {
    width: 100%;
    margin-top: 4px;
    padding-top: 6px;
    border-top: 1px solid var(--rule-strong);
    font-size: 12px;
  }
  .lists {
    display: grid;
    grid-template-columns: 1fr 2fr;
    gap: 36px;
  }
  .cols {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 36px;
  }
  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .row {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    width: 100%;
    height: 28px;
    padding: 0 2px;
    border: none;
    border-bottom: 1px solid var(--rule);
    background: none;
    font-size: 13.5px;
    cursor: pointer;
    text-align: left;
  }
  .row:hover .label {
    text-decoration: underline;
  }
  .row.on {
    font-weight: 700;
  }
  .label {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .meta {
    display: flex;
    gap: 10px;
    flex-shrink: 0;
  }
  .meta b {
    min-width: 22px;
    text-align: right;
  }
  .row.few .meta b {
    font-weight: 400;
    color: var(--muted);
  }
  footer {
    display: flex;
    align-items: center;
    gap: 14px;
    padding-top: 12px;
    border-top: 1px solid var(--rule);
    font-size: 13px;
  }
  @media (max-width: 760px) {
    .inner {
      padding: 20px 16px;
    }
    header {
      flex-wrap: wrap;
    }
    h2 {
      font-size: 30px;
    }
    header p {
      flex-basis: 100%;
      order: 3;
    }
    header .field {
      flex: 1;
    }
    .cards,
    .lists,
    .cols {
      grid-template-columns: 1fr;
    }
    .lists {
      gap: 20px;
    }
    .cols {
      gap: 0;
    }
    footer {
      flex-wrap: wrap;
    }
  }
</style>

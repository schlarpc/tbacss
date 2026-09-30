<script lang="ts">
  import { measure } from '../lib/measures.ts';
  import { app } from '../lib/state.svelte.ts';
  import FilterBar from './FilterBar.svelte';
  import Masthead from './Masthead.svelte';
  import RankedList from './RankedList.svelte';
  import RunArticle from './RunArticle.svelte';
  import Tradeoff from './Tradeoff.svelte';

  // The main page: one host's field, ranked or plotted, with a run written up
  // beside it. On a phone the write-up replaces the list rather than sitting
  // under it.
  let width = $state(1440);
  const narrow = $derived(width <= 760);
  const hostLabel = $derived(app.host ? (app.cat?.hosts[app.host]?.label ?? app.host) : 'every host');

  /** "The quietest cans on a …", worded for the measure doing the ranking. */
  const lead = $derived.by(() => {
    const m = measure(app.route.by);
    const words: Record<string, string> = { weight_oz: 'lightest', length_in: 'shortest', max_diameter_in: 'slimmest', vol_cuin: 'smallest' };
    if (m.key.includes('reduction')) return 'The biggest reductions on';
    if (m.key.includes('first_round_pop')) return 'The steadiest first shots on';
    return `The ${words[m.key] ?? 'quietest'} cans on`;
  });

  // Nothing picked: the leader is written up, without claiming the URL.
  const shown = $derived(app.selected ?? (narrow ? null : (app.ranked[0] ?? null)));
</script>

<svelte:window bind:innerWidth={width} />

{#if narrow && app.selected !== null}
  <div class="page phone-article">
    <button type="button" class="back cap" onclick={() => app.selectRun(null)}>← {hostLabel}</button>
    <RunArticle index={app.selected} onclose={() => app.selectRun(null)} />
  </div>
{:else}
  <div class="page">
    <Masthead>
      {#if app.host}
        {lead} a <button type="button" class="host" onclick={() => (app.hostPickerOpen = true)}>{hostLabel}<span class="caret">▾</span></button>
      {:else}
        Every can, on <button type="button" class="host" onclick={() => (app.hostPickerOpen = true)}>every host<span class="caret">▾</span></button>
      {/if}
    </Masthead>
    <FilterBar>
      {#snippet trailing()}
        <div class="seg" role="group" aria-label="View">
          <button type="button" aria-pressed={app.route.view === 'rank'} onclick={() => app.go({ view: 'rank' })}>Ranked</button>
          <button type="button" aria-pressed={app.route.view === 'trade'} onclick={() => app.go({ view: 'trade' })}>Trade-off</button>
        </div>
      {/snippet}
    </FilterBar>

    {#if app.route.view === 'trade'}
      <div class="body">
        <Tradeoff {narrow} />
      </div>
    {:else}
      <div class="body split">
        <RankedList />
        {#if shown !== null && !narrow}
          <RunArticle index={shown} />
        {/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  .body {
    padding: 22px 0 40px;
  }
  .split {
    display: grid;
    grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr);
    gap: 48px;
    align-items: start;
  }
  .split > :global(article) {
    position: sticky;
    top: 16px;
  }
  .host {
    display: inline;
    padding: 0 2px;
    border: none;
    border-bottom: 2px solid var(--sel);
    background: none;
    font: inherit;
    font-style: italic;
    letter-spacing: inherit;
    cursor: pointer;
    white-space: nowrap;
  }
  .caret {
    margin-left: 4px;
    font-size: 0.5em;
    font-style: normal;
    color: var(--sel);
    vertical-align: middle;
  }
  .seg {
    display: flex;
    border: 1px solid var(--ink);
    border-radius: 999px;
    overflow: hidden;
    height: 32px;
  }
  .seg button {
    padding: 0 14px;
    border: none;
    background: none;
    font-size: 13px;
    font-weight: 600;
    white-space: nowrap;
    cursor: pointer;
  }
  .seg button[aria-pressed='true'] {
    background: var(--ink);
    color: var(--paper);
  }
  @media (max-width: 760px) {
    .seg {
      height: 36px;
    }
  }
  .phone-article {
    padding-top: 14px;
    padding-bottom: 40px;
  }
  .back {
    border: none;
    background: none;
    padding: 0 0 10px;
    cursor: pointer;
  }
  @media (max-width: 1100px) {
    .split {
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: 32px;
    }
  }
  @media (max-width: 760px) {
    .split {
      grid-template-columns: 1fr;
    }
    .body {
      padding-top: 12px;
    }
  }
</style>

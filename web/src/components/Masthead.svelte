<script lang="ts">
  import type { Snippet } from 'svelte';
  import { app } from '../lib/state.svelte.ts';
  import CanSearch from './CanSearch.svelte';
  import ThemeToggle from './ThemeToggle.svelte';

  // The page head: an eyebrow saying what the data is, a serif headline the
  // page supplies, and the two global tools -- search and theme.
  let { eyebrow = null, children, actions = undefined }: { eyebrow?: Snippet | null; children: Snippet; actions?: Snippet } = $props();
  const runs = $derived(app.cat ? app.cat.n : 0);
</script>

<header>
  <div class="head">
    <div class="eyebrow cap">
      {#if eyebrow}{@render eyebrow()}{:else}
        <button type="button" class="home" onclick={() => app.openExplore()}>TBAC Silencer Summit</button>
        · 2023–2026 · {runs.toLocaleString()} runs
      {/if}
    </div>
    <h1>{@render children()}</h1>
  </div>
  <div class="tools">
    {#if actions}{@render actions()}{/if}
    <CanSearch />
    <ThemeToggle />
  </div>
</header>

<style>
  header {
    display: flex;
    align-items: flex-end;
    gap: 24px;
    padding: 30px 0 18px;
    border-bottom: 2px solid var(--ink);
  }
  .head {
    flex: 1;
    min-width: 0;
  }
  h1 {
    margin-top: 6px;
    font-size: 46px;
    line-height: 1.02;
    letter-spacing: -0.02em;
  }
  .home {
    border: none;
    background: none;
    padding: 0;
    font: inherit;
    letter-spacing: inherit;
    text-transform: inherit;
    color: inherit;
    cursor: pointer;
  }
  .home {
    position: relative;
  }
  .home::after {
    content: '';
    position: absolute;
    inset: -10px -4px;
  }
  .home:hover {
    color: var(--ink);
  }
  .tools {
    display: flex;
    align-items: center;
    gap: 12px;
    padding-bottom: 4px;
  }
  @media (max-width: 760px) {
    header {
      flex-direction: column;
      align-items: stretch;
      gap: 12px;
      padding: 18px 0 12px;
    }
    h1 {
      font-size: 30px;
    }
    .tools {
      order: -1;
    }
  }
</style>

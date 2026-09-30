<script lang="ts">
  import { GLOSSARY } from '../lib/glossary.ts';
  import { app } from '../lib/state.svelte.ts';
  import Icon from './Icon.svelte';

  let dialog: HTMLDialogElement;
  $effect(() => {
    if (app.glossaryOpen && !dialog.open) dialog.showModal();
    if (!app.glossaryOpen && dialog.open) dialog.close();
  });
</script>

<dialog bind:this={dialog} onclose={() => (app.glossaryOpen = false)} aria-labelledby="glossary-title" onclick={(e) => e.target === dialog && dialog.close()}>
  <header>
    <h2 id="glossary-title">Glossary</h2>
    <button type="button" class="close" aria-label="Close" onclick={() => dialog.close()}><Icon name="x" /></button>
  </header>
  <dl>
    {#each Object.values(GLOSSARY) as entry (entry.term)}
      <dt class="serif">{entry.term}</dt>
      <dd>{entry.text}</dd>
    {/each}
  </dl>
</dialog>

<style>
  dialog {
    width: min(640px, calc(100vw - 32px));
    padding: 28px 32px;
    border: none;
    border-radius: 10px;
    background: var(--paper);
    color: var(--ink);
    box-shadow: var(--shadow);
  }
  dialog::backdrop {
    background: var(--scrim);
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding-bottom: 10px;
    border-bottom: 2px solid var(--ink);
  }
  h2 {
    font-size: 32px;
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
  dl {
    display: grid;
    grid-template-columns: 170px 1fr;
    gap: 10px 20px;
    margin: 16px 0 0;
  }
  dt {
    font-size: 17px;
  }
  dd {
    margin: 0;
    font-size: 14px;
    color: var(--ink-2);
  }
  @media (max-width: 760px) {
    dl {
      grid-template-columns: 1fr;
      gap: 2px;
    }
    dd {
      margin-bottom: 10px;
    }
  }
</style>

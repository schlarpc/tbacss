<script lang="ts">
  import { nameOf } from '../lib/explore.ts';
  import { app } from '../lib/state.svelte.ts';
  import Icon from './Icon.svelte';

  // The compare set, always in reach while browsing: a bar at the foot of the
  // page once anything is in it.
  const cat = $derived(app.cat!);
</script>

{#if app.compared.length && app.route.page !== 'compare'}
  <aside class="tray" aria-label="Compare">
    <span class="cap">Comparing</span>
    <ul>
      {#each app.compared as i (i)}
        <li style:border-color={`var(${app.colourOf(i) ?? '--ink'})`}>
          <span class="serif">{nameOf(cat, i).model}</span>
          <button type="button" aria-label={`Remove ${nameOf(cat, i).model}`} onclick={() => app.toggleCompare(i)}><Icon name="x" size={10} /></button>
        </li>
      {/each}
    </ul>
    <button type="button" class="btn solid" disabled={app.compared.length < 2} onclick={() => app.openCompare()}>
      {app.compared.length < 2 ? 'Add one more' : 'Open compare →'}
    </button>
  </aside>
{/if}

<style>
  .tray {
    position: sticky;
    bottom: 0;
    z-index: 10;
    display: flex;
    align-items: center;
    gap: 14px;
    max-width: 1440px;
    margin: 0 auto;
    padding: 10px var(--gutter);
    border-top: 1px solid var(--ink);
    background: color-mix(in srgb, var(--paper) 94%, transparent);
    backdrop-filter: blur(6px);
  }
  ul {
    display: flex;
    flex: 1;
    gap: 8px;
    margin: 0;
    padding: 0;
    list-style: none;
    overflow-x: auto;
  }
  li {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 30px;
    padding: 0 6px 0 12px;
    border: 2px solid;
    border-radius: 999px;
    white-space: nowrap;
    font-size: 15px;
  }
  li button {
    display: inline-flex;
    padding: 4px;
    border: none;
    background: none;
    color: var(--muted);
    cursor: pointer;
  }
  @media (max-width: 760px) {
    .cap {
      display: none;
    }
  }
</style>

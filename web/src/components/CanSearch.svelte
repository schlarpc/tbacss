<script lang="ts">
  import { searchCans } from '../lib/explore.ts';
  import { app } from '../lib/state.svelte.ts';
  import Icon from './Icon.svelte';

  // "Find a suppressor": straight to a can's page, whatever host it was on.
  let query = $state('');
  let open = $state(false);
  let active = $state(0);
  const hits = $derived(app.cat ? searchCans(app.cat, query) : []);

  function go(key: string) {
    query = '';
    open = false;
    app.openCan(key);
  }

  function keydown(event: KeyboardEvent) {
    if (event.key === 'ArrowDown') active = Math.min(active + 1, hits.length - 1);
    else if (event.key === 'ArrowUp') active = Math.max(active - 1, 0);
    else if (event.key === 'Enter' && hits[active]) go(hits[active].key);
    else if (event.key === 'Escape') open = false;
    else return;
    event.preventDefault();
  }
</script>

<div class="search">
  <Icon name="search" />
  <input
    class="field"
    type="search"
    role="combobox"
    aria-label="Find a suppressor"
    aria-expanded={open && hits.length > 0}
    aria-controls="can-hits"
    aria-activedescendant={open && hits[active] ? `can-hit-${active}` : undefined}
    autocomplete="off"
    placeholder="Find a suppressor"
    bind:value={query}
    oninput={() => {
      open = true;
      active = 0;
    }}
    onfocus={() => (open = true)}
    onblur={() => setTimeout(() => (open = false), 120)}
    onkeydown={keydown}
  />
  {#if open && hits.length}
    <ul id="can-hits" role="listbox">
      {#each hits as hit, n (hit.key)}
        <li
          id={`can-hit-${n}`}
          role="option"
          aria-selected={n === active}
          class:active={n === active}
          onmousedown={(e) => {
            e.preventDefault();
            go(hit.key);
          }}
        >
          <span><span class="serif model">{hit.model}</span> <span class="dim">{hit.maker}</span></span>
          <span class="num dim">{hit.runs} {hit.runs === 1 ? 'test' : 'tests'}</span>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .search {
    position: relative;
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--muted);
  }
  .field {
    width: 240px;
    color: var(--ink);
  }
  ul {
    position: absolute;
    z-index: 30;
    top: calc(100% + 6px);
    right: 0;
    width: 340px;
    margin: 0;
    padding: 4px;
    list-style: none;
    border: 1px solid var(--ink);
    border-radius: 6px;
    background: var(--paper-2);
    color: var(--ink);
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.15);
  }
  li {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    padding: 7px 8px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 13px;
  }
  li.active {
    background: var(--paper-3);
  }
  .model {
    font-size: 16px;
  }
  @media (max-width: 760px) {
    .field {
      width: 100%;
    }
    .search {
      flex: 1;
    }
    ul {
      left: 0;
      width: auto;
    }
  }
</style>

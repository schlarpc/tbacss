<script lang="ts">
  import Icon from './Icon.svelte';

  // Type to find, Enter or click to add as a chip. For long lists -- 90-odd
  // makers -- where a wall of checkboxes is the thing to avoid.
  interface Option {
    value: string;
    count: number;
  }
  let { label, placeholder, options, selected, onchange }: {
    label: string;
    placeholder: string;
    options: Option[];
    selected: string[];
    onchange: (values: string[]) => void;
  } = $props();

  let query = $state('');
  let open = $state(false);
  let active = $state(0);
  const id = `combo-${Math.random().toString(36).slice(2, 8)}`;

  const matches = $derived(
    options
      .filter((o) => !selected.includes(o.value) && o.value.toLowerCase().includes(query.trim().toLowerCase()))
      .slice(0, 8),
  );

  function add(value: string) {
    onchange([...selected, value]);
    query = '';
    active = 0;
  }

  function keydown(event: KeyboardEvent) {
    if (event.key === 'ArrowDown') {
      open = true;
      active = Math.min(active + 1, matches.length - 1);
    } else if (event.key === 'ArrowUp') {
      active = Math.max(active - 1, 0);
    } else if (event.key === 'Enter' && open && matches[active]) {
      add(matches[active].value);
    } else if (event.key === 'Escape') {
      open = false;
    } else if (event.key === 'Backspace' && !query && selected.length) {
      onchange(selected.slice(0, -1));
      return;
    } else return;
    event.preventDefault();
  }
</script>

<div class="combo">
  {#each selected as value (value)}
    <button type="button" class="pill on" onclick={() => onchange(selected.filter((v) => v !== value))} aria-label={`Remove ${value}`}>
      {value} <Icon name="x" size={10} />
    </button>
  {/each}
  <div class="box">
    <input
      class="field"
      role="combobox"
      aria-label={label}
      aria-expanded={open && matches.length > 0}
      aria-controls={id}
      aria-activedescendant={open && matches[active] ? `${id}-${active}` : undefined}
      autocomplete="off"
      {placeholder}
      bind:value={query}
      onfocus={() => (open = true)}
      onblur={() => setTimeout(() => (open = false), 120)}
      oninput={() => {
        open = true;
        active = 0;
      }}
      onkeydown={keydown}
    />
    {#if open && matches.length}
      <ul role="listbox" {id}>
        {#each matches as option, n (option.value)}
          <li
            id={`${id}-${n}`}
            role="option"
            aria-selected={n === active}
            class:active={n === active}
            onmousedown={(e) => {
              e.preventDefault();
              add(option.value);
            }}
          >
            <span>{option.value}</span><span class="num dim">{option.count}</span>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</div>

<style>
  .combo {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .box {
    position: relative;
  }
  .field {
    width: 140px;
    min-height: 28px;
    height: 28px;
    border-radius: 999px;
    font-size: 13px;
  }
  ul {
    position: absolute;
    z-index: 20;
    top: calc(100% + 4px);
    left: 0;
    min-width: 240px;
    margin: 0;
    padding: 4px;
    list-style: none;
    border: 1px solid var(--ink);
    border-radius: 6px;
    background: var(--paper-2);
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.12);
  }
  li {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    padding: 6px 8px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 13px;
  }
  li.active {
    background: var(--paper-3);
  }
</style>

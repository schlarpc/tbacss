<script lang="ts">
  import type { Snippet } from 'svelte';

  // A pill that opens a small native popover of choices.
  let { label, children, pressed = false }: { label: string; children: Snippet; pressed?: boolean } = $props();
  const id = `menu-${Math.random().toString(36).slice(2, 8)}`;
</script>

<button type="button" class="pill" class:on={pressed} popovertarget={id} style:anchor-name={`--${id}`}>{label} ▾</button>
<div {id} popover class="menu" style:position-anchor={`--${id}`}>
  {@render children()}
</div>

<style>
  .menu {
    margin: 0;
    padding: 8px;
    min-width: 180px;
    border: 1px solid var(--ink);
    border-radius: 6px;
    background: var(--paper-2);
    color: var(--ink);
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.12);
  }
  @supports (top: anchor(bottom)) {
    .menu {
      inset: auto;
      top: anchor(bottom);
      left: anchor(left);
      margin-top: 6px;
      position-try-fallbacks: flip-inline;
    }
  }
</style>

<script lang="ts">
  import { GLOSSARY } from '../lib/glossary.ts';
  import Icon from './Icon.svelte';

  // A term's one-line definition in a native popover, next to where it is used.
  let { term }: { term: string } = $props();
  const entry = $derived(GLOSSARY[term]);
  const id = `info-${Math.random().toString(36).slice(2, 8)}`;
</script>

{#if entry}
  <button class="info" type="button" popovertarget={id} aria-label={`What is ${entry.term}?`} style:anchor-name={`--${id}`}>
    <Icon name="info" size={13} />
  </button>
  <div {id} popover class="pop" role="note" style:position-anchor={`--${id}`}>
    <strong>{entry.term}</strong>
    {entry.text}
  </div>
{/if}

<style>
  .info {
    display: inline-flex;
    vertical-align: -1px;
    padding: 2px;
    margin-left: 2px;
    border: none;
    background: none;
    color: var(--muted);
    cursor: help;
    position: relative;
  }
  .info::after {
    content: '';
    position: absolute;
    inset: -10px -6px;
  }
  .info:hover {
    color: var(--ink);
  }
  .pop {
    max-width: 280px;
    margin: 0;
    padding: 10px 12px;
    border: 1px solid var(--ink);
    border-radius: 6px;
    background: var(--paper-2);
    color: var(--ink);
    font: 13px/1.45 var(--sans);
    font-weight: 400;
    letter-spacing: 0;
    text-transform: none;
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.12);
  }
  /* Beside its button where anchoring exists; the UA's centred popover where not. */
  @supports (top: anchor(bottom)) {
    .pop {
      inset: auto;
      top: anchor(bottom);
      left: anchor(left);
      margin-top: 6px;
      position-try-fallbacks: flip-inline, flip-block;
    }
  }
  .pop strong {
    display: block;
    margin-bottom: 2px;
  }
</style>

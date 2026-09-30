<script lang="ts">
  import Icon from './Icon.svelte';

  // Shown whenever a view mixes Summit years. Direction-free on purpose: the
  // same can has measured up to 5 dB apart across years, but there are too few
  // retests to say which way a given year leans.
  let { years, action = null, onaction = () => {}, children = undefined }: {
    years: number[];
    action?: string | null;
    onaction?: () => void;
    children?: import('svelte').Snippet;
  } = $props();
</script>

{#if years.length > 1}
  <div class="flag" role="note">
    <Icon name="flag" />
    <span>
      {#if children}
        {@render children()}
      {:else}
        <b>{years.length === 2 ? 'Two' : years.length === 3 ? 'Three' : years.length} years mixed.</b>
        The test setup differs between Summits — the same can has measured up to 5 dB apart.
      {/if}
      {#if action}<button type="button" class="linkish" onclick={onaction}>{action}</button>{/if}
    </span>
  </div>
{/if}

<style>
  .flag {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    padding: 10px 14px;
    border-radius: 6px;
    background: var(--flag);
    color: var(--flag-ink);
    font-size: 13px;
  }
  .flag :global(svg) {
    flex-shrink: 0;
    margin-top: 2px;
  }
  .linkish {
    font-weight: 400;
    color: inherit;
    margin-left: 4px;
  }
</style>

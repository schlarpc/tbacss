<script lang="ts">
  // Stroke icons drawn for this page; decorative, so hidden from assistive tech.
  let { name, size = 14 }: { name: 'play' | 'pause' | 'plus' | 'x' | 'search' | 'flag' | 'info' | 'check' | 'sun' | 'moon' | 'back'; size?: number } = $props();
</script>

<svg width={size} height={size} viewBox="0 0 14 14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  {#if name === 'play'}
    <path d="M3.5 2 L12 7 L3.5 12 Z" fill="currentColor" stroke="none" />
  {:else if name === 'pause'}
    <path d="M3.5 2h2.5v10H3.5zM8 2h2.5v10H8z" fill="currentColor" stroke="none" />
  {:else if name === 'plus'}
    <path d="M7 2v10M2 7h10" />
  {:else if name === 'x'}
    <path d="M3 3l8 8M11 3l-8 8" />
  {:else if name === 'search'}
    <circle cx="6" cy="6" r="4.3" /><path d="M9.3 9.3 L12.8 12.8" />
  {:else if name === 'flag'}
    <path d="M7 1.5 L13 12.5 H1 Z" /><path d="M7 5.5v3.2M7 10.4v.2" />
  {:else if name === 'info'}
    <circle cx="7" cy="7" r="5.8" /><path d="M7 6.3v3.8M7 4.2v.2" />
  {:else if name === 'check'}
    <path d="M2.5 7.5 L5.5 10.5 L11.5 3.5" />
  {:else if name === 'sun'}
    <circle cx="7" cy="7" r="2.8" /><path d="M7 .8v1.6M7 11.6v1.6M.8 7h1.6M11.6 7h1.6M2.6 2.6l1.1 1.1M10.3 10.3l1.1 1.1M2.6 11.4l1.1-1.1M10.3 3.7l1.1-1.1" />
  {:else if name === 'moon'}
    <path d="M11.8 8.6A5 5 0 0 1 5.4 2.2a5 5 0 1 0 6.4 6.4Z" />
  {:else if name === 'back'}
    <path d="M9 2.5 L4.5 7 L9 11.5" />
  {/if}
</svg>

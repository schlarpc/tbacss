<script lang="ts">
  import Icon from './Icon.svelte';

  // Flip between paper and night paper. The choice is remembered; until one is
  // made the page follows the OS.
  let dark = $state(false);
  const read = () => getComputedStyle(document.documentElement).colorScheme === 'dark';
  $effect(() => {
    dark = read();
  });

  function toggle() {
    const next = read() ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem('tbacss-theme', next);
    } catch {
      // private mode: the switch still holds for this visit
    }
    dark = next === 'dark';
    window.dispatchEvent(new Event('themechange'));
  }
</script>

<button type="button" class="toggle" onclick={toggle} aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'} title="Theme">
  <Icon name={dark ? 'sun' : 'moon'} size={16} />
</button>

<style>
  .toggle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 34px;
    height: 34px;
    border: 1px solid var(--rule-strong);
    border-radius: 50%;
    background: none;
    color: var(--ink);
    cursor: pointer;
  }
</style>

<script lang="ts">
  import { app } from './lib/state.svelte.ts';
  import CanPage from './components/CanPage.svelte';
  import ComparePage from './components/ComparePage.svelte';
  import CompareTray from './components/CompareTray.svelte';
  import Explore from './components/Explore.svelte';
  import Footer from './components/Footer.svelte';
  import Glossary from './components/Glossary.svelte';
  import HostPicker from './components/HostPicker.svelte';

  app.load();

  // A new page starts at its top.
  $effect(() => {
    void [app.route.page, app.route.can];
    window.scrollTo({ top: 0 });
  });
</script>

{#if app.error}
  <main class="page failed">
    <h1>Could not load the data</h1>
    <p class="dim">{app.error}</p>
    <p class="dim">Serving locally? Run <code>python -m tbacss publish tbacss.db web/data</code> first.</p>
  </main>
{:else if !app.cat}
  <main class="page loading" aria-busy="true">
    <p class="cap">TBAC Silencer Summit</p>
    <p class="serif">Loading 1,185 runs…</p>
  </main>
{:else}
  <main>
    {#if app.route.page === 'compare'}
      <ComparePage />
    {:else if app.route.page === 'can'}
      <CanPage />
    {:else}
      <Explore />
    {/if}
  </main>
  <CompareTray />
  <Footer />
  <HostPicker />
  <Glossary />
{/if}

<style>
  main {
    min-height: calc(100vh - 60px);
  }
  .loading,
  .failed {
    padding-top: 60px;
  }
  .loading .serif {
    margin-top: 8px;
    font-size: 32px;
  }
  .failed h1 {
    font-size: 36px;
    margin-bottom: 12px;
  }
</style>

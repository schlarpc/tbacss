<script lang="ts">
  import { app } from '../lib/state.svelte.ts';

  // TBAC's terms ask that the data be footnoted with the Summit it came from,
  // so the footer names the years actually in view, each linking its report.
  const datasets = $derived(
    (app.cat?.datasets ?? [])
      .filter((d) => (app.route.page === 'explore' && app.years.length ? app.years.includes(d.year) : true))
      .sort((a, b) => a.year - b.year),
  );
  const safe = (url: string | null) => (url && /^https?:\/\//i.test(url) ? url : null);
</script>

<footer class="page">
  <span>
    Sound data from the
    {#each datasets as d, n (d.year)}{#if n}{n === datasets.length - 1 ? ' and ' : ', '}{/if}{#if safe(d.report_url)}<a href={safe(d.report_url)} rel="noreferrer">{d.year}</a>{:else}{d.year}{/if}{/each}
    TBAC Silencer {datasets.length === 1 ? 'Summit' : 'Summits'}, Thunder Beast Arms Corporation.
  </span>
  <span class="links">
    <button type="button" class="linkish" onclick={() => (app.glossaryOpen = true)}>Glossary</button>
    <a href="https://github.com/schlarpc/tbacss" rel="noreferrer">Source and data</a>
  </span>
</footer>

<style>
  footer {
    display: flex;
    gap: 18px;
    flex-wrap: wrap;
    padding-top: 14px;
    padding-bottom: 20px;
    border-top: 1px solid var(--rule);
    font-size: 12px;
    color: var(--muted);
  }
  .links {
    display: flex;
    gap: 18px;
    margin-left: auto;
  }
  .linkish,
  a {
    font-weight: 400;
    color: inherit;
  }
</style>

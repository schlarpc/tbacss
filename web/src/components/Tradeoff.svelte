<script lang="ts">
  import { frontierPath, fullName, nameOf, num, yearOf } from '../lib/explore.ts';
  import { fmt, measure } from '../lib/measures.ts';
  import { app } from '../lib/state.svelte.ts';
  import Info from './Info.svelte';
  import MeasureSelect from './MeasureSelect.svelte';
  import ScatterPlot from './ScatterPlot.svelte';
  import YearFlag from './YearFlag.svelte';

  // Any measure against any other, the axes chosen in a sentence. The frontier
  // runs are numbered on the plot and listed beside it.
  let { narrow = false }: { narrow?: boolean } = $props();
  const cat = $derived(app.cat!);
  const x = $derived(measure(app.route.x));
  const y = $derived(measure(app.route.y));
  const path = $derived(frontierPath(cat, app.frontier, x.key));
  const both = $derived(Boolean(x.better && y.better));
  const SHAPE_NAMES = ['●', '○', '□', '◇'];

  /** The last step of the staircase, in words: what the best y costs in x. */
  const step = $derived.by(() => {
    if (!both || app.route.z || path.length < 2) return null;
    const ordered = x.better === 'max' ? [...path].reverse() : path;
    const a = ordered[ordered.length - 2];
    const b = ordered[ordered.length - 1];
    return {
      from: nameOf(cat, a).model,
      to: nameOf(cat, b).model,
      dy: num(cat, y.key, b) - num(cat, y.key, a),
      dx: num(cat, x.key, b) - num(cat, x.key, a),
    };
  });
</script>

<div class="trade">
  <section class="main">
    <h2>
      Plot <MeasureSelect label="Vertical axis" value={app.route.y} onchange={(k) => k && app.go({ y: k })} />
      against <MeasureSelect label="Horizontal axis" value={app.route.x} onchange={(k) => k && app.go({ x: k })} />
      <span class="third dim">— and <MeasureSelect label="Third axis" value={app.route.z} none="a third" onchange={(k) => app.go({ z: k })} /></span>
    </h2>
    <div class="legend dim">
      {#if app.years.length > 1 && !app.route.z}
        {#each app.years as year, n (year)}<span>{SHAPE_NAMES[n % 4]} {year}</span>{/each}
      {/if}
      {#if path.length}
        <span class="front"><svg width="22" height="12" aria-hidden="true"><path d="M1 2 V7 H21" fill="none" stroke="var(--frontier)" stroke-width="2" /></svg>frontier<Info term="frontier" /></span>
      {:else if !app.host}
        <span>No frontier across hosts: numbers from different guns don't compare.</span>
      {:else}
        <span>No frontier: {[x, y].filter((m) => !m.better).map((m) => m.label).join(' and ')} is a condition, not something to optimise.</span>
      {/if}
      <span class="dir">{y.label} · {y.better === 'max' ? '↑' : '↓'} better</span>
    </div>
    <ScatterPlot height={narrow ? 340 : 560} />
    {#if app.route.z}<p class="dim hint">Drag to rotate. <button type="button" class="linkish" onclick={() => app.go({ z: null })}>Back to 2D</button></p>{/if}
    <YearFlag years={app.years} action="Plot one year at a time" onaction={() => app.go({ years: [app.years[app.years.length - 1]] })} />
  </section>
  {#if path.length}
    <aside>
      <div class="cap head">On the frontier · {path.length}</div>
      <ol>
        {#each path as i, n (i)}
          {@const name = nameOf(cat, i)}
          {@const tone = app.colourOf(i)}
          <li>
            <button type="button" onclick={() => app.selectRun(i)} style:color={tone ? `var(${tone})` : undefined}>
              <span class="n serif">{n + 1}</span>
              <span class="who"><b>{fullName(name)}</b><span class="dim">{yearOf(cat, i)}</span></span>
              <span class="num r">{fmt(num(cat, x.key, i), x.digits)} {x.unit}<br /><b>{fmt(num(cat, y.key, i), y.digits)}</b></span>
            </button>
          </li>
        {/each}
      </ol>
      {#if step}
        <p class="dim note">
          Each step trades one for the other. <span class="ink">{step.from} → {step.to}</span>:
          {fmt(step.dy, y.digits, { sign: true })} {y.unit} for {fmt(step.dx, x.digits, { sign: true })} {x.unit}.
        </p>
      {/if}
    </aside>
  {/if}
</div>

<style>
  .trade {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 300px;
    gap: 40px;
  }
  .main {
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-width: 0;
  }
  h2 {
    font-size: 26px;
    line-height: 1.3;
  }
  .third {
    font-size: 18px;
  }
  .legend {
    display: flex;
    gap: 16px;
    flex-wrap: wrap;
    align-items: center;
    font-size: 13px;
  }
  .front {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--ink);
  }
  .dir {
    margin-left: auto;
  }
  .hint {
    font-size: 13px;
  }
  .head {
    padding-bottom: 6px;
    border-bottom: 2px solid var(--frontier);
    color: var(--frontier);
  }
  ol {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  li button {
    display: grid;
    grid-template-columns: 22px minmax(0, 1fr) auto;
    gap: 8px;
    width: 100%;
    padding: 9px 0;
    border: none;
    border-bottom: 1px solid var(--rule);
    background: none;
    text-align: left;
    cursor: pointer;
    font-size: 13.5px;
  }
  .n {
    font-style: italic;
    font-size: 17px;
  }
  .who {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .who b {
    font-weight: 600;
  }
  .who .dim {
    font-size: 12px;
  }
  .r {
    text-align: right;
    font-size: 13px;
  }
  .note {
    margin-top: 14px;
    font-size: 13px;
    line-height: 1.5;
  }
  .ink {
    color: var(--ink);
  }
  @media (max-width: 1100px) {
    .trade {
      grid-template-columns: 1fr;
    }
    .dir {
      margin-left: 0;
    }
  }
</style>

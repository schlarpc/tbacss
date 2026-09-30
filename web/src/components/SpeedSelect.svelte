<script lang="ts">
  import { SPEEDS } from '../lib/audio.ts';
  import { app } from '../lib/state.svelte.ts';
</script>

<label class="speed" title="Slower playback lowers the pitch too">
  <span class="visually-hidden">Playback speed</span>
  <select value={app.rate} onchange={(e) => app.setRate(Number(e.currentTarget.value))}>
    {#each SPEEDS as s (s.rate)}
      <option value={s.rate}>{s.label}</option>
    {/each}
  </select>
</label>

<style>
  select {
    height: 34px;
    padding: 0 10px;
    border: 1px solid var(--rule-strong);
    border-radius: 999px;
    background: var(--paper-2);
    font-size: 13px;
    cursor: pointer;
  }
</style>

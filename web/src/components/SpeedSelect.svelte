<script lang="ts">
  import { SPEEDS } from '../lib/audio.ts';
  import { app } from '../lib/state.svelte.ts';

  // Speed, and -- once slowed -- how: let the pitch drop with it, like tape,
  // or stretch the sound at its own pitch.
</script>

<span class="speed">
  <label title="Playback speed">
    <span class="visually-hidden">Playback speed</span>
    <select value={app.rate} onchange={(e) => app.setRate(Number(e.currentTarget.value))}>
      {#each SPEEDS as s (s.rate)}
        <option value={s.rate}>{s.label}</option>
      {/each}
    </select>
  </label>
  {#if app.rate < 1}
    <label title="Slowing a recording lowers its pitch, like tape; stretching keeps it, at the cost of some processing">
      <span class="visually-hidden">When slowed</span>
      <select value={app.keepPitch ? 'keep' : 'lower'} onchange={(e) => app.setKeepPitch(e.currentTarget.value === 'keep')}>
        <option value="lower">lower pitch</option>
        <option value="keep">keep pitch</option>
      </select>
    </label>
  {/if}
</span>

<style>
  .speed {
    display: inline-flex;
    gap: 6px;
  }
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

<script lang="ts">
  import type { WaveformEntry } from '../tbacss.ts';
  import { clipOf, play } from '../lib/audio.ts';
  import { app } from '../lib/state.svelte.ts';
  import { fullRate } from '../lib/wave.ts';
  import Icon from './Icon.svelte';

  // Play one shot, or several in turn. The shots are fetched at full rate
  // (shared with the plots) and played through Web Audio; see lib/audio.ts for
  // the downsampling and why levels are scaled.
  let { shots, label = 'Listen', solid = true, small = false }: {
    shots: WaveformEntry[];
    label?: string;
    solid?: boolean;
    small?: boolean;
  } = $props();

  let loading = $state(false);
  let handle: { stop(): void } | null = null;
  const mine = $derived(app.playing !== null && shots.some((s) => s.id === app.playing?.id));

  async function toggle() {
    if (mine) {
      handle?.stop();
      return;
    }
    loading = true;
    try {
      const records = await Promise.all(shots.map((s) => fullRate(app.bundle!, s)));
      handle = play(
        records.map((r) => clipOf(r.values, r.dt, r.entry.id)),
        (playing) => (app.playing = playing),
      );
    } finally {
      loading = false;
    }
  }
</script>

<button type="button" class="btn" class:solid class:small onclick={toggle} disabled={!shots.length || loading} aria-pressed={mine}>
  <Icon name={mine ? 'pause' : 'play'} />
  {loading ? 'Loading…' : mine ? 'Stop' : label}
</button>

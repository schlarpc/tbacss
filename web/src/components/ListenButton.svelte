<script lang="ts">
  import type { WaveformEntry } from '../tbacss.ts';
  import { clipOf, play } from '../lib/audio.ts';
  import { stretchClip } from '../lib/stretcher.ts';
  import { app } from '../lib/state.svelte.ts';
  import { fullRate, recordSpan } from '../lib/wave.ts';
  import Icon from './Icon.svelte';

  // Play shots one after another -- a run's string, or one shot from each of
  // several cans -- at the chosen speed, with one shared level so a louder
  // shot stays louder. Each clip starts just before its shot rather than
  // carrying the ~48 ms of pre-trigger silence in the capture.
  let { shots, label = 'Listen', solid = true, small = false }: {
    shots: WaveformEntry[];
    label?: string;
    solid?: boolean;
    small?: boolean;
  } = $props();

  const LEAD_MS = 3;
  let loading = $state(false);
  let handle: { stop(): void } | null = null;
  let mine = $state(false);

  async function toggle() {
    if (mine) {
      handle?.stop();
      return;
    }
    loading = true;
    try {
      const records = await Promise.all(shots.map((s) => fullRate(app.bundle!, s)));
      const clips = records.map((r) => {
        const trigger = r.analysis.triggered ? r.analysis.leqStart : 0;
        const start = Math.max(0, trigger - Math.round(LEAD_MS / (r.dt * 1000)));
        return clipOf(r.values, r.dt, r.entry.id, start, recordSpan(app.bundle!, r.entry)[0]);
      });
      mine = true;
      handle = play(
        clips,
        (playing) => {
          app.playing = playing;
          if (!playing) mine = false;
        },
        {
          rate: app.rate,
          // Keeping the pitch means stretching each clip first; the worker
          // does one ahead of playback, and caches it for a replay.
          prepare:
            app.keepPitch && app.rate < 1
              ? (clip) => stretchClip(`${clip.id}:${clip.offsetMs.toFixed(3)}`, clip.values, clip.rate, 1 / app.rate)
              : undefined,
        },
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

/**
 * The main thread's side of the stretch worker: one worker, jobs matched to
 * replies by id, results cached so replaying a string is instant. Falls back
 * to stretching in place where workers are unavailable.
 */

import { stretch } from './stretch.ts';

let worker: Worker | null | undefined;
let next = 0;
const waiting = new Map<number, (out: Float32Array) => void>();
const cache = new Map<string, Promise<Float32Array>>();

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    worker = new Worker(new URL('./stretch.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }: MessageEvent<{ id: number; out: Float32Array }>) => {
      waiting.get(data.id)?.(data.out);
      waiting.delete(data.id);
    };
  } catch {
    worker = null;
  }
  return worker;
}

/** `samples` at `rate` Hz, `alpha` times longer at the same pitch. `key` names it for the cache. */
export function stretchClip(key: string, samples: Float32Array, rate: number, alpha: number): Promise<Float32Array> {
  const name = `${key}@${alpha}`;
  let found = cache.get(name);
  if (!found) {
    const w = getWorker();
    found = w
      ? new Promise<Float32Array>((resolve) => {
          const id = next++;
          waiting.set(id, resolve);
          w.postMessage({ id, samples: samples.slice(), rate, alpha });
        })
      : Promise.resolve(stretch(samples, rate, alpha));
    cache.set(name, found);
  }
  return found;
}

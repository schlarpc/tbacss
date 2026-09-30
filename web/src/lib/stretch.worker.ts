// Stretches clips off the main thread: a 64x string is a few seconds of
// arithmetic that would otherwise freeze the page.
import { stretch } from './stretch.ts';

interface Job {
  id: number;
  samples: Float32Array;
  rate: number;
  alpha: number;
}

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<Job>) => void) | null;
  postMessage(message: unknown, transfer: Transferable[]): void;
};

scope.onmessage = ({ data }) => {
  const out = stretch(data.samples, data.rate, data.alpha);
  scope.postMessage({ id: data.id, out }, [out.buffer]);
};

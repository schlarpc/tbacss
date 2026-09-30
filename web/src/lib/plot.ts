/**
 * Canvas plumbing shared by every plot: sizing at device pixel ratio, colours
 * read from the theme, tick placement, axes, and min/max decimation.
 *
 * Colours come from CSS custom properties at paint time, so a theme switch is a
 * repaint rather than a second palette in code.
 */

export type Domain = [number, number];
export type Scale = (v: number) => number;

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** A theme token's current value, e.g. `color('--ink')`. */
export function color(name: string, element: Element = document.body): string {
  return getComputedStyle(element).getPropertyValue(name).trim();
}

export const SANS = '"Public Sans Variable", "Helvetica Neue", sans-serif';
export const SERIF = '"Newsreader Variable", Georgia, serif';

/** Size a canvas to its CSS box at device pixel ratio and clear it. */
export function prepare(canvas: HTMLCanvasElement, height: number) {
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2D canvas context');
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return { ctx, width, height };
}

/** Round tick positions covering [lo, hi]. */
export function ticks(lo: number, hi: number, count = 5): number[] {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= raw) ?? magnitude * 10;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(v);
  return out;
}

/** Decimal places that make a tick step read cleanly. */
export function tickDigits(values: number[]): number {
  if (values.length < 2) return 0;
  const step = Math.abs(values[1] - values[0]);
  return step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
}

export const linear = (domain: Domain, lo: number, hi: number): Scale => (v) =>
  lo + ((v - domain[0]) / (domain[1] - domain[0] || 1)) * (hi - lo);

/** Grid, tick labels and axis titles. Returns the two scales. */
export function axes(
  ctx: CanvasRenderingContext2D,
  box: Box,
  x: Domain,
  y: Domain,
  { xTitle = '', yTitle = '', xFormat, yFormat }: {
    xTitle?: string;
    yTitle?: string;
    xFormat?: (v: number) => string;
    yFormat?: (v: number) => string;
  } = {},
): { px: Scale; py: Scale } {
  const px = linear(x, box.left, box.right);
  const py = linear(y, box.bottom, box.top);
  const xs = ticks(x[0], x[1], Math.max(3, Math.round((box.right - box.left) / 90)));
  const ys = ticks(y[0], y[1], Math.max(3, Math.round((box.bottom - box.top) / 60)));
  const xd = tickDigits(xs);
  const yd = tickDigits(ys);

  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = color('--grid');
  ctx.beginPath();
  for (const v of ys) {
    const yy = Math.round(py(v)) + 0.5;
    ctx.moveTo(box.left, yy);
    ctx.lineTo(box.right, yy);
  }
  for (const v of xs) {
    const xx = Math.round(px(v)) + 0.5;
    ctx.moveTo(xx, box.top);
    ctx.lineTo(xx, box.bottom);
  }
  ctx.stroke();

  ctx.font = `11px ${SANS}`;
  ctx.fillStyle = color('--tick');
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const v of xs) ctx.fillText(xFormat ? xFormat(v) : v.toFixed(xd), px(v), box.bottom + 6);
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const v of ys) ctx.fillText(yFormat ? yFormat(v) : v.toFixed(yd), box.left - 8, py(v));

  if (xTitle) {
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillText(xTitle, box.right, box.bottom + 34);
  }
  if (yTitle) {
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(yTitle, box.left - 36, box.top - 8);
  }
  ctx.restore();
  return { px, py };
}

/** Text with a halo in the surface colour, for labels drawn over data. */
export function haloText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number): void {
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineWidth = 3;
  ctx.strokeStyle = color('--paper');
  ctx.strokeText(text, x, y);
  ctx.restore();
  ctx.fillText(text, x, y);
}

/** A quiet centred message on an empty plot. */
export function placeholder(ctx: CanvasRenderingContext2D, width: number, height: number, message: string) {
  ctx.fillStyle = color('--muted');
  ctx.font = `13px ${SANS}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(message, width / 2, height / 2);
}

/* -------------------------------------------------------------- decimation
 *
 * Every trace is reduced to one [min, max] pair per pixel column. Min/max rather
 * than every nth sample: a blast is a short excursion in a long quiet record,
 * so stride-sampling 262 kHz onto 600 pixels steps over the peak nearly every
 * time, while keeping both extremes makes the drawing an honest bound.
 */

export interface ColumnBand {
  lo: Float32Array;
  hi: Float32Array;
  seen: Uint8Array;
}

/**
 * Reduce `count` elements spanning `[s0, s1]` to `cols` columns over `domain`.
 * Columns with nothing under them stay unset, so a shorter record stops rather
 * than being stretched across the axis.
 */
export function decimate(
  count: number,
  s0: number,
  s1: number,
  lo: (i: number) => number,
  hi: (i: number) => number,
  domain: Domain,
  cols: number,
): ColumnBand {
  const outLo = new Float32Array(cols);
  const outHi = new Float32Array(cols);
  const seen = new Uint8Array(cols);
  const width = (s1 - s0) / count;
  const step = (domain[1] - domain[0]) / cols;
  for (let c = 0; c < cols; c++) {
    const a = domain[0] + c * step;
    let i0 = Math.floor((a - s0) / width);
    let i1 = Math.ceil((a + step - s0) / width);
    if (i1 <= 0 || i0 >= count) continue;
    i0 = Math.max(0, i0);
    i1 = Math.min(count, Math.max(i1, i0 + 1));
    let min = Infinity;
    let max = -Infinity;
    for (let i = i0; i < i1; i++) {
      const l = lo(i);
      const h = hi(i);
      if (l < min) min = l;
      if (h > max) max = h;
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) continue;
    outLo[c] = min;
    outHi[c] = max;
    seen[c] = 1;
  }
  return { lo: outLo, hi: outHi, seen };
}

/** Merge bands column-wise: the envelope of several traces. */
export function union(bands: ColumnBand[], cols: number): ColumnBand {
  const lo = new Float32Array(cols).fill(Infinity);
  const hi = new Float32Array(cols).fill(-Infinity);
  const seen = new Uint8Array(cols);
  for (const band of bands) {
    for (let c = 0; c < cols; c++) {
      if (!band.seen[c]) continue;
      if (band.lo[c] < lo[c]) lo[c] = band.lo[c];
      if (band.hi[c] > hi[c]) hi[c] = band.hi[c];
      seen[c] = 1;
    }
  }
  return { lo, hi, seen };
}

export function bandExtent(bands: ColumnBand[], cols: number): Domain | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const band of bands) {
    for (let c = 0; c < cols; c++) {
      if (!band.seen[c]) continue;
      if (band.lo[c] < lo) lo = band.lo[c];
      if (band.hi[c] > hi) hi = band.hi[c];
    }
  }
  return lo <= hi ? [lo, hi] : null;
}

/** Fill between `lo` and `hi`, breaking wherever the data stops. */
export function fillBand(ctx: CanvasRenderingContext2D, band: ColumnBand, py: Scale, colX: Scale): void {
  const cols = band.seen.length;
  for (let c = 0; c < cols; ) {
    if (!band.seen[c]) {
      c++;
      continue;
    }
    let end = c;
    while (end < cols && band.seen[end]) end++;
    ctx.beginPath();
    for (let i = c; i < end; i++) ctx.lineTo(colX(i), py(band.hi[i]));
    for (let i = end - 1; i >= c; i--) ctx.lineTo(colX(i), py(band.lo[i]));
    ctx.closePath();
    ctx.fill();
    c = end;
  }
}

/**
 * Stroke a decimated trace as one path walking each column's extremes, so it
 * keeps the signal's shape at any zoom and becomes the plain waveform once a
 * column holds a single sample.
 */
export function strokeColumns(ctx: CanvasRenderingContext2D, band: ColumnBand, py: Scale, colX: Scale): void {
  ctx.beginPath();
  let open = false;
  for (let c = 0; c < band.seen.length; c++) {
    if (!band.seen[c]) {
      open = false;
      continue;
    }
    const x = colX(c);
    const top = py(band.hi[c]);
    const bottom = py(band.lo[c]);
    if (open) ctx.lineTo(x, top);
    else {
      ctx.moveTo(x, top);
      open = true;
    }
    ctx.lineTo(x, bottom === top ? bottom + 0.6 : bottom);
  }
  ctx.stroke();
}

/** Keep a canvas repainting at its current width. Returns a disposer. */
export function observeWidth(element: Element, onResize: () => void): () => void {
  let last = -1;
  const observer = new ResizeObserver(([entry]) => {
    const width = Math.round(entry.contentRect.width);
    if (width !== last) {
      last = width;
      onResize();
    }
  });
  observer.observe(element);
  return () => observer.disconnect();
}

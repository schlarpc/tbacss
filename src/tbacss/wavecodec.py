"""Lossless codec for quantised waveform records.

These captures are audio -- 262 kHz sampling of a signal whose energy sits far
below Nyquist -- so consecutive samples are strongly correlated and the
lossless-audio toolkit applies directly. The scheme here is the cheap tier of
FLAC and Shorten: quantise to integers, take a fixed polynomial difference to
kill the correlation, then Rice-code the residual with a parameter chosen per
block.

Measured over real records (``scripts/bench_encodings.py``), bytes per sample:

    float32 raw                4.000
    float32 + zlib             2.416
    float16 raw / int16 raw    2.000
    int16 + zlib               1.356
    int16 + zstd-19            1.270
    int16 delta + zstd-19      1.130
    int16 + this codec         0.889   <- 2.2x smaller than raw int16
    int24 + this codec         1.887   <- exact metrics, still under raw int16

The win comes from prediction across samples, which no per-sample number
format can capture. float16, bfloat16 and posit16 all sit at 2.0 bytes per
sample because they treat each sample independently; a posit's tapered
precision would also put its accuracy near +-1.0, while every published metric
here is referenced to the peak.

Order 2 -- the second difference -- beat orders 0, 1, 3, 4 on every record
tested, and also beat computed LPC of orders 8, 16 and 32. The signal is
oversampled and smooth enough that a two-tap predictor is already close to
optimal, so the codec never needs a coefficient tier.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass

import numpy as np

__all__ = ["CODEC", "EncodedWaveform", "decode", "encode", "quantize"]

CODEC = "fixed2-rice-v1"

_MAGIC = b"TBW1"
# magic, version, order, bits, block_log2, n_samples, scale.
# The scale is float64: at float32 it would round, and then decoding
# would not reproduce the quantised samples bit for bit.
_HEADER = struct.Struct("<4sBBBBId")
_VERSION = 1
_DEFAULT_ORDER = 2
_DEFAULT_BLOCK_LOG2 = 12  # 4096 residuals
MAX_UNARY = 64
"""Cap on the unary run, so a decoder can bound its inner loop.

k is raised until every quotient in the block fits. That costs a fraction of a
percent and removes the need for an escape code.
"""


@dataclass
class EncodedWaveform:
    payload: bytes
    scale: float
    n_samples: int
    bits: int


def quantize(window: np.ndarray, bits: int = 16) -> tuple[np.ndarray, float]:
    """Peak-referenced integer codes plus the Pa-per-code scale."""
    if bits not in (16, 24):
        raise ValueError("bits must be 16 or 24")
    limit = (1 << (bits - 1)) - 1
    peak = float(np.abs(window).max())
    scale = peak / limit if peak > 0 else 1.0
    codes = np.round(window / scale).astype(np.int64)
    return np.clip(codes, -limit - 1, limit), scale


def _residual(codes: np.ndarray, order: int) -> tuple[np.ndarray, np.ndarray]:
    """Repeated differences, plus the seed needed to undo each one.

    Seed ``i`` is the first element of the i-th difference, which is what a
    cumulative sum needs to climb back one level.
    """
    seeds = []
    out = codes.astype(np.int64)
    for _ in range(order):
        seeds.append(int(out[0]))
        out = np.diff(out)
    return out, np.array(seeds, dtype=np.int64)


def _restore(residual: np.ndarray, seeds: np.ndarray, order: int) -> np.ndarray:
    out = residual.astype(np.int64)
    for step in range(order - 1, -1, -1):
        out = np.concatenate([[seeds[step]], out]).cumsum()
    return out


def _choose_k(zigzag: np.ndarray) -> int:
    """Rice parameter minimising total bits, then raised to bound the unary run."""
    if zigzag.size == 0:
        return 0
    mean = max(float(zigzag.mean()), 1e-9)
    centre = max(0, int(np.log2(mean + 1)))
    best_k, best_bits = 0, None
    for k in range(max(0, centre - 3), centre + 5):
        bits = int((zigzag >> k).sum()) + zigzag.size * (k + 1)
        if best_bits is None or bits < best_bits:
            best_k, best_bits = k, bits
    while int((zigzag >> best_k).max()) > MAX_UNARY and best_k < 40:
        best_k += 1
    return best_k


class _BitWriter:
    __slots__ = ("_acc", "_chunks", "_used")

    def __init__(self) -> None:
        self._chunks = bytearray()
        self._acc = 0
        self._used = 0

    def write(self, value: int, width: int) -> None:
        self._acc = (self._acc << width) | (value & ((1 << width) - 1))
        self._used += width
        while self._used >= 8:
            self._used -= 8
            self._chunks.append((self._acc >> self._used) & 0xFF)
        self._acc &= (1 << self._used) - 1

    def write_unary(self, count: int) -> None:
        while count >= 32:
            self.write((1 << 32) - 1, 32)
            count -= 32
        if count:
            self.write((1 << count) - 1, count)
        self.write(0, 1)

    def finish(self) -> bytes:
        if self._used:
            self._chunks.append((self._acc << (8 - self._used)) & 0xFF)
        return bytes(self._chunks)


class _BitReader:
    __slots__ = ("_data", "_pos")

    def __init__(self, data: bytes) -> None:
        self._data = data
        self._pos = 0

    def read(self, width: int) -> int:
        value = 0
        for _ in range(width):
            byte = self._data[self._pos >> 3]
            value = (value << 1) | ((byte >> (7 - (self._pos & 7))) & 1)
            self._pos += 1
        return value

    def read_unary(self) -> int:
        count = 0
        while self.read(1):
            count += 1
        return count


def encode(
    window: np.ndarray,
    *,
    bits: int = 16,
    order: int = _DEFAULT_ORDER,
    block_log2: int = _DEFAULT_BLOCK_LOG2,
) -> EncodedWaveform:
    """Encode one analysis window."""
    codes, scale = quantize(np.asarray(window, dtype=np.float64), bits)
    if codes.size <= order:
        raise ValueError("record is shorter than the predictor order")

    residual, seeds = _residual(codes, order)
    zigzag = ((residual << 1) ^ (residual >> 63)).astype(np.int64)

    block = 1 << block_log2
    n_blocks = (zigzag.size + block - 1) // block
    parameters = bytearray()
    writer = _BitWriter()
    for index in range(n_blocks):
        chunk = zigzag[index * block : (index + 1) * block]
        k = _choose_k(chunk)
        parameters.append(k)
        for value in chunk.tolist():
            writer.write_unary(value >> k)
            if k:
                writer.write(value, k)

    header = _HEADER.pack(_MAGIC, _VERSION, order, bits, block_log2, codes.size, scale)
    warmup = seeds.astype("<i4").tobytes()
    return EncodedWaveform(
        payload=header + warmup + bytes(parameters) + writer.finish(),
        scale=scale,
        n_samples=int(codes.size),
        bits=bits,
    )


def decode(payload: bytes) -> np.ndarray:
    """Decode back to Pa. Inverse of :func:`encode` up to the quantiser."""
    magic, version, order, bits, block_log2, n, scale = _HEADER.unpack_from(payload)
    if magic != _MAGIC:
        raise ValueError("not a tbacss waveform frame")
    if version != _VERSION:
        raise ValueError(f"unsupported frame version {version}")

    offset = _HEADER.size
    seeds = np.frombuffer(payload, dtype="<i4", count=order, offset=offset).astype(np.int64)
    offset += 4 * order

    block = 1 << block_log2
    count = n - order
    n_blocks = (count + block - 1) // block
    parameters = payload[offset : offset + n_blocks]
    offset += n_blocks

    reader = _BitReader(payload[offset:])
    residual = np.empty(count, dtype=np.int64)
    position = 0
    for index in range(n_blocks):
        k = parameters[index]
        size = min(block, count - position)
        for _ in range(size):
            value = (reader.read_unary() << k) | (reader.read(k) if k else 0)
            residual[position] = (value >> 1) ^ -(value & 1)
            position += 1

    codes = _restore(residual, seeds, order)
    return (codes.astype(np.float64) * scale).astype(np.float32)

#!/usr/bin/env python3
"""Benchmark waveform encodings against the real data.

These records are audio: a 262 kHz capture of a signal whose energy is well
below Nyquist, so consecutive samples are strongly correlated and the standard
lossless-audio toolkit applies. This measures the candidates end to end --
size, and whether the encoding still reproduces the published metrics.

    python3 scripts/bench_encodings.py tbacss.db --limit 24
"""

from __future__ import annotations

import argparse
import bz2
import lzma
import subprocess
import zlib

import numpy as np

from tbacss import SummitDB
from tbacss.analysis import P_0, TIME_START_S, shot_metrics
from tbacss.webexport import _analysis_window


def _window_offset(dt: float) -> int:
    """Index in the full record where the analysis window starts."""
    return int(np.floor(TIME_START_S / dt + 0.5)) - 1


# ---------------------------------------------------------------- quantisers


def to_int16(window: np.ndarray) -> tuple[np.ndarray, float]:
    peak = float(np.abs(window).max()) or 1.0
    scale = peak / 32767.0
    return np.round(window / scale).astype(np.int32), scale


def to_int24(window: np.ndarray) -> tuple[np.ndarray, float]:
    peak = float(np.abs(window).max()) or 1.0
    scale = peak / 8388607.0
    return np.round(window / scale).astype(np.int32), scale


# ------------------------------------------------------------- FLAC-style


def fixed_predictor_residual(codes: np.ndarray, order: int) -> np.ndarray:
    """Residual of FLAC's fixed polynomial predictors (order 0-4).

    Order 1 is plain delta, order 2 is the second difference, and so on. No
    coefficients need storing, which is why FLAC uses these as its cheap tier.
    """
    residual = codes.astype(np.int64)
    for _ in range(order):
        residual = np.diff(residual, prepend=residual[0])
    return residual


def rice_bits(residual: np.ndarray, block: int = 4096) -> int:
    """Exact bit count for Rice coding with a per-block optimal parameter.

    This is the entropy coder FLAC and Shorten use: zigzag the signed residual,
    then split each value into a unary high part and k raw low bits.
    """
    zigzag = (residual << 1) ^ (residual >> 63)
    total = 0
    for start in range(0, zigzag.size, block):
        chunk = zigzag[start : start + block]
        if chunk.size == 0:
            continue
        mean = max(float(chunk.mean()), 1e-9)
        best: int | None = None
        # k near log2(mean) is optimal; check a small window around it.
        centre = max(0, int(np.log2(mean + 1)))
        for k in range(max(0, centre - 3), centre + 4):
            bits = int((chunk >> k).sum()) + chunk.size * (k + 1)
            if best is None or bits < best:
                best = bits
        assert best is not None  # the k window is never empty
        total += best + 8  # 8 bits to store k for the block
    return total


def best_flac_like(codes: np.ndarray) -> tuple[int, int]:
    """Smallest (bytes, order) over FLAC's fixed predictors."""
    best: tuple[int, int] | None = None
    for order in range(5):
        size = (rice_bits(fixed_predictor_residual(codes, order)) + 7) // 8
        if best is None or size < best[0]:
            best = (size, order)
    assert best is not None
    return best


# ------------------------------------------------------------ generic codecs


def zstd(payload: bytes, level: int = 19) -> int:
    out = subprocess.run(
        ["zstd", f"-{level}", "-c", "-q"], input=payload, capture_output=True, check=True
    )
    return len(out.stdout)


def measure(name: str, size: int, samples: int, table: dict) -> None:
    table.setdefault(name, []).append(size / samples)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("database")
    parser.add_argument("--limit", type=int, default=24)
    args = parser.parse_args()

    table: dict[str, list[float]] = {}
    errors: dict[str, dict[str, float]] = {}

    with SummitDB(args.database) as db:
        picks = db.query(
            """SELECT w.id, w.dt_s, r.cartridge, d.year
               FROM waveform w
               JOIN test_run r ON r.id = w.test_run_id
               JOIN dataset d ON d.id = r.dataset_id
               WHERE w.defect_count = 0
               ORDER BY w.id * 7919 % 104729
               LIMIT ?""",
            (args.limit,),
        )
        for row in picks:
            waveform = db.waveform(row["id"])
            window = _analysis_window(
                waveform.samples, row["dt_s"], row["cartridge"], row["year"]
            ).astype(np.float32)
            n = window.size

            reference = shot_metrics(
                waveform.samples,
                dt=row["dt_s"],
                cartridge=row["cartridge"],
                year=row["year"],
            )

            codes16, scale16 = to_int16(window)
            codes24, scale24 = to_int24(window)
            bytes16 = codes16.astype("<i2").tobytes()
            f16 = window.astype(np.float16).tobytes()
            f32 = window.tobytes()

            measure("float32 raw", len(f32), n, table)
            measure("float32 + zlib", len(zlib.compress(f32, 6)), n, table)
            measure("float16 raw", len(f16), n, table)
            measure("float16 + zlib", len(zlib.compress(f16, 6)), n, table)
            measure("int16 raw", len(bytes16), n, table)
            measure("int16 + zlib", len(zlib.compress(bytes16, 9)), n, table)
            measure("int16 + xz", len(lzma.compress(bytes16, preset=6)), n, table)
            measure("int16 + bz2", len(bz2.compress(bytes16, 9)), n, table)
            measure("int16 + zstd-19", zstd(bytes16), n, table)

            delta = np.diff(codes16, prepend=codes16[0]).astype("<i2").tobytes()
            measure("int16 delta + zlib", len(zlib.compress(delta, 9)), n, table)
            measure("int16 delta + zstd-19", zstd(delta), n, table)

            size16, order16 = best_flac_like(codes16)
            measure("int16 FLAC-fixed+Rice", size16, n, table)
            size24, _ = best_flac_like(codes24)
            measure("int24 FLAC-fixed+Rice", size24, n, table)
            table.setdefault("_order16", []).append(order16)

            # Fidelity of each lossy quantiser, in dB on the published metrics.
            # Splice the restored window back where it came from so shot_metrics
            # re-slices exactly the samples we encoded.
            offset = _window_offset(row["dt_s"])
            for name, restored in (
                ("int16", codes16.astype(np.float32) * scale16),
                ("int24", codes24.astype(np.float32) * scale24),
                ("float16", window.astype(np.float16).astype(np.float32)),
            ):
                spliced = waveform.samples.copy()
                spliced[offset : offset + restored.size] = restored
                metrics = shot_metrics(
                    spliced,
                    dt=row["dt_s"],
                    cartridge=row["cartridge"],
                    year=row["year"],
                )
                bucket = errors.setdefault(name, {})
                for field in ("peak_pa", "peak_a_pa", "impulse_pa_ms", "peak_leq_pa"):
                    delta_db = abs(
                        20 * np.log10(getattr(metrics, field) / P_0)
                        - 20 * np.log10(getattr(reference, field) / P_0)
                    )
                    bucket[field] = max(bucket.get(field, 0.0), float(delta_db))

    order_counts = np.bincount(np.array(table.pop("_order16"), dtype=int), minlength=5)
    print(f"{len(picks)} waveforms")
    print(f"\n{'encoding':26}{'bytes/sample':>14}{'vs int16 raw':>14}")
    baseline = float(np.mean(table["int16 raw"]))
    for name, values in table.items():
        mean = float(np.mean(values))
        print(f"{name:26}{mean:14.3f}{mean / baseline:13.2f}x")

    print(f"\nbest fixed-predictor order (int16): {list(order_counts)} for orders 0-4")

    print("\nworst metric error, dB")
    print(f"{'quantiser':12}{'peak':>10}{'peak dBA':>10}{'impulse':>10}{'Leq':>10}")
    for name, bucket in errors.items():
        print(
            f"{name:12}{bucket['peak_pa']:10.5f}{bucket['peak_a_pa']:10.5f}"
            f"{bucket['impulse_pa_ms']:10.5f}{bucket['peak_leq_pa']:10.5f}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

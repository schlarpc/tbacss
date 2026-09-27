"""Run-level statistics the published tables do not carry.

``all.csv`` gives one shot-averaged number per run per mic, printed to two
decimals. Three things are missing from that, and all three change how the
numbers should be read:

**Uncertainty.** The mean of five shots has a standard error, and here it is
around 0.65 dBA. Published figures resolve to 0.01 dB, which invites
comparisons the measurement cannot support -- the eight quietest .223 cans on
``5.56-16AR`` span 1.72 dBA in total, less than three standard errors.

**First-round pop.** Shot one is louder than the rest, by 0.5 to 2.3 dBA
depending on the host, and averaging over five shots hides it entirely. It is
the shot that matters in the field.

**Net reduction.** TBAC fires an unsuppressed reference on most hosts, so
"how much quieter" is computable -- and is what a reader usually wants -- but
subtracting it is left as an exercise.

Everything here is derived from :mod:`tbacss.analysis` output already stored in
``shot_metric``; nothing re-reads a waveform.
"""

from __future__ import annotations

import statistics
from collections import defaultdict
from dataclasses import dataclass

import numpy as np

__all__ = [
    "METRICS",
    "LOW_FREQUENCY_HZ",
    "band_statistics",
    "RunStats",
    "run_statistics",
    "net_reduction",
    "indistinguishable",
]

#: Per-shot column -> the shot-averaged column it corresponds to in all.csv.
METRICS = {
    "peak_db": "peak_db",
    "peak_dba": "peak_dba",
    "impulse_db_ms": "impulse_db_ms",
    "peak_leq10ms_dba": "peak_leq10ms_dba",
}


@dataclass(frozen=True)
class RunStats:
    """Spread of one metric over the shots of one run at one mic."""

    n: int
    mean: float
    sd: float | None
    sem: float | None
    #: Shot one minus the mean of the rest. Positive means the first round was
    #: louder, which is the usual direction.
    first_round_pop: float | None


def _stats(values: list[float]) -> tuple[float, float | None, float | None]:
    mean = statistics.fmean(values)
    if len(values) < 2:
        return mean, None, None
    sd = statistics.stdev(values)
    return mean, sd, sd / len(values) ** 0.5


def run_statistics(db, metric: str = "peak_dba") -> dict[tuple[int, str], RunStats]:
    """Spread of ``metric`` for every (run, mic) that has per-shot figures.

    Spare captures are excluded -- they are duplicates TBAC set aside, and
    counting one twice would understate the spread.
    """
    if metric not in METRICS:
        raise ValueError(f"unknown metric {metric!r}")

    rows = db.query(
        f"""SELECT w.test_run_id, w.mic, w.shot, s.{metric} AS value
            FROM shot_metric s
            JOIN waveform w ON w.id = s.waveform_id
            WHERE w.excluded = 0 AND s.{metric} IS NOT NULL
            ORDER BY w.test_run_id, w.mic, w.shot"""
    )

    grouped: dict[tuple[int, str], list[tuple[int, float]]] = defaultdict(list)
    for row in rows:
        grouped[(row["test_run_id"], row["mic"])].append((row["shot"], row["value"]))

    out: dict[tuple[int, str], RunStats] = {}
    for key, shots in grouped.items():
        shots.sort()
        values = [value for _, value in shots]
        mean, sd, sem = _stats(values)

        pop = None
        if len(shots) >= 2 and shots[0][0] == 1:
            pop = shots[0][1] - statistics.fmean(value for _, value in shots[1:])

        out[key] = RunStats(len(values), mean, sd, sem, pop)
    return out


def net_reduction(db, metric: str = "peak_dba") -> dict[tuple[int, str], float]:
    """How much quieter than the bare muzzle, per (run, mic), in dB.

    Only a reference fired the same year on the same host counts. A 16" AR and
    a 20" bolt gun are different baselines, and so is the same host a year
    later -- TBAC changed the .22 rifle mid-summit once already.
    """
    column = {
        "peak_db": "peak_db",
        "peak_dba": "peak_dba",
        "impulse_db_ms": "impulse_db_ms",
        "peak_leq10ms_dba": "peak_leq10ms_dba",
    }[metric]

    baselines: dict[tuple[int, str, str], float] = {}
    for row in db.query(
        f"""SELECT d.year, r.cartridge, m.mic, m.{column} AS value
            FROM test_run r
            JOIN dataset d ON d.id = r.dataset_id
            JOIN summary_metric m ON m.test_run_id = r.id
            WHERE r.is_baseline = 1 AND m.{column} IS NOT NULL"""
    ):
        baselines[(row["year"], row["cartridge"], row["mic"])] = row["value"]

    out: dict[tuple[int, str], float] = {}
    for row in db.query(
        f"""SELECT r.id, d.year, r.cartridge, m.mic, m.{column} AS value
            FROM test_run r
            JOIN dataset d ON d.id = r.dataset_id
            JOIN summary_metric m ON m.test_run_id = r.id
            WHERE r.is_baseline = 0 AND m.{column} IS NOT NULL"""
    ):
        reference = baselines.get((row["year"], row["cartridge"], row["mic"]))
        if reference is not None:
            out[(row["id"], row["mic"])] = reference - row["value"]
    return out


LOW_FREQUENCY_HZ = 250.0
"""Bands at or below this count as the low-frequency "thump" summary.

A-weighting rolls off hard down here -- about -9 dB at 250 Hz and -26 at 63 --
so energy in these bands is close to invisible in a dBA figure while being
exactly what makes a suppressed shot feel like a punch rather than a crack.
"""


def band_statistics(db, centres) -> dict[tuple[int, str], dict]:
    """Per (run, mic) mean spectrum, plus two scalars worth filtering on.

    Shots are averaged in energy, not in decibels: a mean of logarithms is not
    the logarithm of the mean, and the quantity that adds is power.
    """
    rows = db.query(
        """SELECT w.test_run_id, w.mic, b.levels
           FROM band_level b
           JOIN waveform w ON w.id = b.waveform_id
           WHERE w.excluded = 0"""
    )
    grouped: dict[tuple[int, str], list[np.ndarray]] = defaultdict(list)
    for row in rows:
        grouped[(row["test_run_id"], row["mic"])].append(
            np.frombuffer(row["levels"], dtype="<f4").astype(np.float64)
        )

    frequencies = np.asarray(centres, dtype=np.float64)
    low = frequencies <= LOW_FREQUENCY_HZ
    out: dict[tuple[int, str], dict] = {}
    for key, shots in grouped.items():
        stacked = np.vstack(shots)
        power = np.nan_to_num(10 ** (stacked / 10.0), nan=0.0)
        mean_power = power.mean(axis=0)
        with np.errstate(divide="ignore"):
            levels = np.where(mean_power > 0, 10 * np.log10(mean_power), np.nan)

        total = mean_power.sum()
        out[key] = {
            "levels": levels,
            "low_frequency_db": (
                float(10 * np.log10(mean_power[low].sum()))
                if mean_power[low].sum() > 0
                else None
            ),
            "centroid_hz": (
                float((frequencies * mean_power).sum() / total) if total > 0 else None
            ),
        }
    return out


def indistinguishable(
    a_mean: float,
    a_sem: float | None,
    b_mean: float,
    b_sem: float | None,
    sigma: float = 2.0,
) -> bool:
    """Whether two shot-averaged figures are separated by less than the noise.

    A two-sample comparison, so the errors add in quadrature. ``sigma`` of 2 is
    roughly a 95% interval; the default is deliberately conservative, because
    the failure mode this exists to prevent is a reader treating a 0.2 dB gap
    as a ranking.
    """
    if a_sem is None or b_sem is None:
        return False
    combined = (a_sem**2 + b_sem**2) ** 0.5
    return abs(a_mean - b_mean) < sigma * combined

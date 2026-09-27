"""Reimplementation of TBAC's published post-processing.

This is a port of the Octave the Summit report links from its CODE section --
``process_string_flat.m``, ``adsgn.m`` and ``Leq_fast.m``, kept in
``reference/octave/`` -- so the numbers in ``all.csv`` can be regenerated from
the stored waveforms.  ``python -m tbacss verify`` does exactly that, which is
the check that the archive was parsed correctly.

Metric definitions, from the report::

    peak       maximum of the pressure curve
    impulse    area under the pressure curve up to the "trough", the minimum
               of the running integral inside the peak window
    Leq(10ms)  running 10 ms rectangular RMS of the A-weighted signal
    dB         20*log10(Pa / 2e-5)

Each metric is computed per shot, averaged over the shots **in linear units**,
and only then converted to dB.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.integrate import cumulative_trapezoid
from scipy.signal import bilinear, lfilter

__all__ = [
    "BAND_CENTRES",
    "RunMetrics",
    "ShotMetrics",
    "a_weighting",
    "average_metrics",
    "fill_defects",
    "leq_fast",
    "shot_metrics",
]

P_0 = 20e-6  # Pa at 0 dB
FS = 262144.0  # sample rate the reference code hardcodes
TAU = 0.010  # Leq integration time, seconds
LEQ_WIDTH_MS = 25.0  # how far past shot start to look for the Leq peak
PEAK_STOP_S = 0.075  # end of the peak search window, relative to Time_Start
TIME_START_S = 0.001
TIME_STOP_S = 0.125
TIME_STOP_SHORT_S = 0.100  # .22LR triggers early, so its window is shorter
LEQ_TRIGGER_PA = 1.0  # shot start = first sample above this


MAX_INTERPOLATED_GAP = 8
"""Longest run of NaN samples that :func:`fill_defects` will bridge.

At 262 kHz that is 30 microseconds. The defects in the release sets are single
samples, so anything longer would mean a real dropout rather than a mangled
number, and silently smoothing over it would be dishonest.
"""


def fill_defects(samples: np.ndarray, max_gap: int = MAX_INTERPOLATED_GAP) -> np.ndarray:
    """Linearly interpolate over NaN samples left by unparseable tokens."""
    missing = np.isnan(samples)
    if not missing.any():
        return samples

    # Longest consecutive run of NaNs.
    edges = np.flatnonzero(np.diff(np.concatenate(([0], missing.view(np.int8), [0]))))
    longest = int((edges[1::2] - edges[0::2]).max())
    if longest > max_gap:
        raise ValueError(
            f"{missing.sum()} missing samples with a run of {longest}, "
            f"longer than the {max_gap}-sample limit; not interpolating"
        )
    if missing[0] or missing[-1]:
        raise ValueError("missing samples at the edge of the record; not interpolating")

    filled = samples.astype(np.float64, copy=True)
    present = ~missing
    filled[missing] = np.interp(np.flatnonzero(missing), np.flatnonzero(present), filled[present])
    return filled


def _oct_round(value: float) -> int:
    """Octave's round: half away from zero, unlike Python's banker's rounding."""
    return int(np.floor(value + 0.5) if value >= 0 else np.ceil(value - 0.5))


def is_short_window(cartridge: str, year: int | None = None) -> bool:
    """Whether this run uses the shortened analysis window.

    2024 introduced it -- ``.22LR needs a different interval to prevent
    trigger problems`` -- for any cartridge whose code starts ``.22``.  The
    2023 code has no such branch and always runs to 0.125 s, so passing
    ``year=2023`` reproduces that year's published numbers.
    """
    if year is not None and year < 2024:
        return False
    return cartridge.startswith(".22")


def a_weighting(sample_rate: float = FS) -> tuple[np.ndarray, np.ndarray]:
    """IEC 61672 A-weighting as a digital IIR filter.

    Same analog prototype and bilinear transform as ``adsgn.m``.  Octave's
    ``bilinear`` takes a sampling *period*; scipy's takes a *rate*, hence
    ``1/Fs`` there and ``Fs`` here.
    """
    f1, f2, f3, f4 = 20.598997, 107.65265, 737.86223, 12194.217
    a1000 = 1.9997
    num = np.array([(2 * np.pi * f4) ** 2 * (10 ** (a1000 / 20)), 0, 0, 0, 0])
    den = np.convolve(
        [1, 4 * np.pi * f4, (2 * np.pi * f4) ** 2],
        [1, 4 * np.pi * f1, (2 * np.pi * f1) ** 2],
    )
    den = np.convolve(np.convolve(den, [1, 2 * np.pi * f3]), [1, 2 * np.pi * f2])
    return bilinear(num, den, sample_rate)


def leq_fast(signal: np.ndarray, sample_rate: float = FS, tau: float = TAU) -> np.ndarray:
    """Running RMS over a rectangular window of ``tau`` seconds.

    Ported from ``Leq_fast.m``, including its use of a *circular* FFT
    convolution -- values in the first ``tau`` seconds wrap around the end of
    the record.  That does not matter here because the shot starts well after
    the window length.
    """
    length = int(np.floor(sample_rate * tau))
    if length > signal.size:
        raise ValueError("signal is shorter than the integration time")
    kernel = np.zeros(signal.size)
    kernel[:length] = 1.0
    spectrum = np.fft.fft(signal.astype(np.float64) ** 2) * np.fft.fft(kernel)
    return np.real(np.sqrt(np.fft.ifft(spectrum) / length))


@dataclass
class ShotMetrics:
    """Per-shot values, all in linear units so they can be averaged."""

    peak_pa: float
    peak_a_pa: float
    impulse_pa_ms: float
    peak_leq_pa: float


@dataclass
class RunMetrics:
    """Shot-averaged values, in the units the published table uses."""

    peak_pressure_pa: float
    peak_db: float
    peak_dba: float
    impulse_pa_ms: float
    impulse_db_ms: float
    peak_leq10ms_dba: float
    shots: int


def _to_db(value: float) -> float:
    return float(20.0 * np.log10(value / P_0))


def shot_metrics(
    samples: np.ndarray,
    *,
    dt: float,
    cartridge: str,
    sample_rate: float = FS,
    year: int | None = None,
) -> ShotMetrics:
    """Compute one shot's metrics from its full pressure record."""
    time_stop = TIME_STOP_SHORT_S if is_short_window(cartridge, year) else TIME_STOP_S
    start = _oct_round(TIME_START_S / dt)
    stop = _oct_round(time_stop / dt)
    # Octave slices M(T_Start:T_Stop) inclusive with 1-based indices.
    window = samples[start - 1 : stop].astype(np.float64)
    if window.size < 2:
        raise ValueError("analysis window is empty; check dt and sample count")
    window = fill_defects(window)

    times_ms = (np.arange(window.size) * dt + start * dt) * 1000.0
    peak_stop = _oct_round(PEAK_STOP_S * sample_rate)

    integral = cumulative_trapezoid(window, times_ms, initial=0)
    trough = int(np.argmin(integral[:peak_stop]))
    # Octave's max(Q(1:Imp_Stop_ROW2)) is inclusive of the trough index.
    impulse = float(np.max(integral[: trough + 1]))

    b, a = a_weighting(sample_rate)
    weighted = lfilter(b, a, window)
    peak_a = float(np.max(weighted[:peak_stop]))

    above = np.flatnonzero(window > LEQ_TRIGGER_PA)
    if above.size == 0:
        raise ValueError(f"no sample above {LEQ_TRIGGER_PA} Pa; cannot locate shot start")
    leq_start = int(above[0])
    leq_stop = leq_start + _oct_round(LEQ_WIDTH_MS * sample_rate / 1000.0)
    leq = leq_fast(weighted, sample_rate)
    peak_leq = float(np.max(leq[leq_start : leq_stop + 1]))

    return ShotMetrics(
        peak_pa=float(np.max(window[:peak_stop])),
        peak_a_pa=peak_a,
        impulse_pa_ms=impulse,
        peak_leq_pa=peak_leq,
    )


#: One-third-octave band centres, IEC 61260 preferred numbers, 25 Hz to 20 kHz.
#: The top band is under half the 262 kHz sample rate by a wide margin, so
#: nothing here is fighting the anti-alias filter.
BAND_CENTRES: tuple[float, ...] = tuple(1000.0 * 10 ** (n / 10) for n in range(-16, 14))


def third_octave_levels(
    window: np.ndarray,
    sample_rate: float = FS,
    centres: tuple[float, ...] = BAND_CENTRES,
) -> np.ndarray:
    """Energy in each third-octave band, dB re 20 uPa.

    TBAC publishes peak and A-weighted peak, which say how loud a shot is but
    not what it sounds like. Two cans can land on the same dBA with quite
    different spectra -- one crisp, one a low thump -- and A-weighting
    deliberately discounts exactly the low frequencies that make a suppressed
    shot feel heavy. The waveforms are stored, so the bands are recoverable.

    This is a plain energy sum over an FFT of the whole analysis window, so it
    is the total energy of the event per band, not a running level.
    """
    samples = np.asarray(window, dtype=np.float64)
    spectrum = np.fft.rfft(samples)
    freqs = np.fft.rfftfreq(samples.size, d=1.0 / sample_rate)

    # Parseval: scale so the sum over bins is the mean square of the signal.
    power = (np.abs(spectrum) ** 2) * 2.0 / samples.size**2
    if power.size:
        power[0] /= 2.0  # DC is not mirrored
        if samples.size % 2 == 0:
            power[-1] /= 2.0  # nor is Nyquist

    out = np.empty(len(centres), dtype=np.float64)
    ratio = 2 ** (1 / 6)  # half a third-octave, each way
    for index, centre in enumerate(centres):
        lo, hi = centre / ratio, centre * ratio
        total = power[(freqs >= lo) & (freqs < hi)].sum()
        out[index] = 10.0 * np.log10(total / P_0**2) if total > 0 else np.nan
    return out


def average_metrics(shots: list[ShotMetrics]) -> RunMetrics:
    """Average shots in linear units, then convert, as the reference does."""
    if not shots:
        raise ValueError("no shots to average")
    peak = float(np.mean([s.peak_pa for s in shots]))
    peak_a = float(np.mean([s.peak_a_pa for s in shots]))
    impulse = float(np.mean([s.impulse_pa_ms for s in shots]))
    leq = float(np.mean([s.peak_leq_pa for s in shots]))
    return RunMetrics(
        peak_pressure_pa=peak,
        peak_db=_to_db(peak),
        peak_dba=_to_db(peak_a),
        impulse_pa_ms=impulse,
        impulse_db_ms=_to_db(impulse),
        peak_leq10ms_dba=_to_db(leq),
        shots=len(shots),
    )

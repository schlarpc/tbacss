"""Parser for Bruel & Kjaer PULSE LabShop ASCII time-capture exports.

The TBAC Silencer Summit release sets ship one of these per microphone per
shot, named ``Time Group_Expanded Time(<Signal>) - Input.<n>``.  The layout is::

    Header Size:\t 79\t
    Pulse Version:\t 80\t
    ...
    Date:\t \t8/18/2025
    Time:\t \t15:40:50:041
    1\t  0.0000000000e+00\t  9.54715e-02
    2\t  3.8146973000e-06\t  1.06928e-01
    ...
    131072\t  4.9999618981e-01\t -5.82376e-01
    TagsBegin:\t \t
    OverLoad:\t \tFalse
    TagsEnd:\t \t

Lines are CRLF terminated and latin-1 encoded (the ``PowerUnit`` value is
``Pa^2`` using the superscript-two byte, which is not valid UTF-8).

Only the third data column is retained.  The first is a 1-based sample index
and the second is the sample time, both of which are exactly reproducible from
``t0 + i * dt`` -- see :meth:`PulseWaveform.times`.
"""

from __future__ import annotations

import datetime as _dt
import re
from dataclasses import dataclass, field

import numpy as np

__all__ = ["PulseParseError", "PulseWaveform", "parse_pulse", "parse_pulse_file"]

# First data line: a bare "1" followed by a tab, at the start of a line.
_DATA_START = re.compile(rb"(?m)^1\t")
# First footer line: data lines start with a digit, footer keys with a letter.
_FOOTER_START = re.compile(rb"(?m)^[A-Za-z]")

_ENCODING = "latin-1"

# A well-formed amplitude token. Anything else in the third column is a defect
# in the release set -- see _parse_amplitudes.
_NUMBER = re.compile(rb"^[-+]?[0-9]*\.?[0-9]+([eE][-+]?[0-9]+)?$")


class PulseParseError(ValueError):
    """Raised when a file does not look like a PULSE ASCII export."""


@dataclass
class PulseWaveform:
    """One captured time record from a single microphone."""

    header: dict[str, str]
    tags: dict[str, str]
    samples: np.ndarray
    header_line_count: int = 0
    # Sample indices whose amplitude token was unparseable, with the raw text.
    # Those samples are NaN in `samples`; see `parse_pulse` for what causes it.
    defects: tuple[tuple[int, str], ...] = ()
    # The final row's index column did not equal the number of rows read.
    index_inconsistent: bool = False
    # Undefined rows dropped from the tail: a short capture into a longer buffer.
    dropped_tail: int = 0
    _dtag: dict[str, str] = field(default_factory=dict, repr=False)

    # -- header-derived properties ------------------------------------------

    @property
    def n_samples(self) -> int:
        return int(self.samples.size)

    @property
    def declared_samples(self) -> int | None:
        """Sample count the header claims, which is not always what is there."""
        declared = self.header.get("X-Axis size")
        return int(declared) if declared else None

    @property
    def short_capture(self) -> bool:
        """The DAQ captured less than its buffer held, and said so."""
        return self.dropped_tail > 0

    @property
    def truncated(self) -> bool:
        """Rows are missing outright -- the file itself is short."""
        declared = self.declared_samples
        if declared is None:
            return False
        return declared > self.n_samples + self.dropped_tail

    @property
    def signal(self) -> str | None:
        """Microphone/channel name, e.g. ``Mil Left``."""
        return self.header.get("Signal")

    @property
    def amplitude_unit(self) -> str | None:
        return self.header.get("AmplitudeUnit") or self.header.get("SignalUnit")

    @property
    def sample_rate(self) -> float:
        """Hz.  Prefer the explicit rate; fall back to 1/dt."""
        rate = _as_float(self.header.get("InputSampleFrequency"))
        if rate:
            return rate
        return 1.0 / self.dt

    @property
    def dt(self) -> float:
        """Seconds between samples."""
        delta = _as_float(self.header.get("X-Axis delta"))
        if delta:
            return delta
        rate = _as_float(self.header.get("InputSampleFrequency"))
        if rate:
            return 1.0 / rate
        raise PulseParseError("no X-Axis delta or InputSampleFrequency in header")

    @property
    def t0(self) -> float:
        """Time of the first sample, seconds."""
        return _as_float(self.header.get("X-Axis first value")) or 0.0

    @property
    def input_range(self) -> float | None:
        return _as_float(self.header.get("InputRange"))

    @property
    def dB_reference(self) -> float | None:
        """Pressure corresponding to 0 dB, normally 2e-5 Pa."""
        return _as_float(self.header.get("dBReference"))

    @property
    def overload(self) -> bool | None:
        """Whether the DAQ flagged an input overload for this record."""
        raw = self.tags.get("OverLoad")
        if raw is None:
            return None
        return raw.strip().lower() == "true"

    @property
    def captured_at(self) -> _dt.datetime | None:
        """Wall-clock time the record was captured.

        PULSE writes ``Date`` as ``M/d/yyyy`` and ``Time`` as
        ``HH:mm:ss:mmm`` -- note the *colon* before the milliseconds.
        """
        date, time = self.header.get("Date"), self.header.get("Time")
        if not date or not time:
            return None
        try:
            month, day, year = (int(p) for p in date.split("/"))
            hour, minute, second, millis = (int(p) for p in time.split(":"))
        except ValueError:
            return None
        # The rig's local clock, with no zone recorded; naive is the honest type.
        return _dt.datetime(year, month, day, hour, minute, second, millis * 1000)  # noqa: DTZ001

    # -- data ---------------------------------------------------------------

    def times(self) -> np.ndarray:
        """Sample times in seconds, reconstructed from the header."""
        return self.t0 + np.arange(self.n_samples, dtype=np.float64) * self.dt

    def peak_pa(self) -> float:
        return float(np.max(self.samples))

    def peak_db(self, reference: float | None = None) -> float:
        ref = reference or self.dB_reference or 2e-5
        return float(20.0 * np.log10(self.peak_pa() / ref))


def _as_float(value: str | None) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except ValueError:
        return None


UNDEFINED = b"Undefined"
"""PULSE's marker for a row it did not export."""

MIN_TRAILING_RUN = 64
"""Shortest undefined tail treated as a short capture rather than damage.

2024 ran the .22LR bolt gun with a 0.1 s capture into the same 0.5 s buffer,
so 104448 of 131072 rows come back undefined by design. A handful of undefined
rows in the middle of a record is something else entirely.
"""


def _parse_amplitudes(
    tokens: list[bytes],
) -> tuple[np.ndarray, tuple[tuple[int, str], ...], int]:
    """Convert the amplitude column into ``(samples, defects, dropped_tail)``.

    Three shapes show up across the four release sets:

    * a clean column, which is the overwhelming majority;
    * a long run of ``Undefined`` at the end, where the DAQ captured less than
      its buffer held.  Those rows are dropped and counted, not treated as
      damage;
    * isolated bad tokens -- a stray ``Undefined``, or a corrupted byte or two
      such as ``-1.6211"u+00`` where ``-1.62110e+00`` was meant.  Those become
      NaN and are reported; nothing here silently invents a value.

    The tail is trimmed *before* falling back to per-token parsing, because
    otherwise a record that is 80% buffer padding would take the slow path for
    all 131072 rows.
    """
    try:
        return np.array(tokens, dtype=np.float32), (), 0
    except ValueError:
        pass

    end = len(tokens)
    while end and tokens[end - 1] == UNDEFINED:
        end -= 1
    dropped = len(tokens) - end
    if dropped < MIN_TRAILING_RUN:
        # Too short to be a buffer tail; treat those rows like any other defect.
        end, dropped = len(tokens), 0

    head = tokens[:end] if dropped else tokens
    try:
        return np.array(head, dtype=np.float32), (), dropped
    except ValueError:
        pass

    values = np.empty(len(head), dtype=np.float32)
    defects: list[tuple[int, str]] = []
    for index, token in enumerate(head):
        if _NUMBER.match(token):
            values[index] = float(token)
        else:
            values[index] = np.nan
            defects.append((index, token.decode(_ENCODING)))
    return values, tuple(defects), dropped


def _split_kv(line: str) -> tuple[str, str] | None:
    """Turn one tab-delimited header/footer line into a (key, value) pair.

    PULSE pads with empty tab-separated fields and is inconsistent about which
    column holds the value: ``Signal:\\tMil Left\\t`` puts it second while
    ``Date:\\t \\t8/18/2025`` puts it third.  Take the last non-empty field.
    """
    parts = [p.strip() for p in line.split("\t")]
    key = parts[0].rstrip(":").strip()
    if not key:
        return None
    values = [p for p in parts[1:] if p]
    return key, (values[-1] if values else "")


def parse_pulse(raw: bytes, *, with_samples: bool = True) -> PulseWaveform:
    """Parse the bytes of one PULSE export."""
    match = _DATA_START.search(raw)
    if match is None:
        raise PulseParseError("no data block found (expected a line starting '1\\t')")
    data_start = match.start()

    footer = _FOOTER_START.search(raw, data_start)
    data_end = footer.start() if footer else len(raw)

    header: dict[str, str] = {}
    header_text = raw[:data_start].decode(_ENCODING)
    header_lines = header_text.splitlines()
    for line in header_lines:
        pair = _split_kv(line)
        if pair:
            header[pair[0]] = pair[1]

    tags: dict[str, str] = {}
    for line in raw[data_end:].decode(_ENCODING).splitlines():
        pair = _split_kv(line)
        # TagsBegin/TagsEnd/TagScalesBegin/TagScalesEnd are structural markers.
        if pair and not pair[0].endswith(("Begin", "End")):
            tags[pair[0]] = pair[1]

    if not with_samples:
        return PulseWaveform(header, tags, np.empty(0, np.float32), len(header_lines))

    tokens = raw[data_start:data_end].split()
    if len(tokens) % 3:
        raise PulseParseError(
            f"data block has {len(tokens)} whitespace-separated tokens, "
            "which is not a whole number of 3-column rows"
        )
    samples, defects, dropped_tail = _parse_amplitudes(tokens[2::3])

    # The index column must start at 1, or we did not find the data block.
    if tokens[0] != b"1":
        raise PulseParseError(f"data block starts at index {tokens[0]!r}, expected 1")

    # Its last value should equal the row count, but a short or byte-damaged
    # tail is not fatal -- one 2023 file is cut off well past the analysis
    # window, with the final indices corrupted too.  Flag it and move on.
    try:
        last_index = int(tokens[-3])
    except ValueError:
        last_index = None
    # Compare against the row count before the undefined tail was trimmed:
    # those rows still carry an index, so a short capture is consistent.
    inconsistent = last_index != samples.size + dropped_tail

    return PulseWaveform(
        header, tags, samples, len(header_lines), defects, inconsistent, dropped_tail
    )


def parse_pulse_file(path, *, with_samples: bool = True) -> PulseWaveform:
    """Parse a PULSE export from disk."""
    with open(path, "rb") as handle:
        return parse_pulse(handle.read(), with_samples=with_samples)

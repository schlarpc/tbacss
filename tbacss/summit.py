"""Domain layer for TBAC Silencer Summit release sets.

Covers the three things the release set encodes outside the PULSE files
themselves: the directory naming convention, ``Specs.txt``, and the published
``all.csv`` summary table.
"""

from __future__ import annotations

import csv
import re
from dataclasses import dataclass

__all__ = [
    "MICS",
    "METRIC_COLUMNS",
    "RunKey",
    "RunDir",
    "Specs",
    "SummaryRow",
    "WaveformName",
    "parse_event",
    "parse_run_dir",
    "parse_specs",
    "parse_spec_filename",
    "parse_waveform_filename",
    "read_summary_csv",
    "is_baseline_manufacturer",
    "is_reference_run",
    "is_void_capture",
    "IGNORED_FILENAMES",
    "NOTE_FILENAME",
    "signal_to_mic",
    "split_member_path",
]

# PULSE channel name -> the mic code used in the published tables.
# ML/MR sit at the MIL-STD-1474 positions left and right of the muzzle; SE is
# the shooter's ear (the channel is named for the ear it is clipped to).
# 2023 ran ML, SE and "225", a 225-degree above-shoulder-arc position, and had
# no MR; from 2024 on the third mic was moved to MR.
_SIGNAL_TO_MIC = {
    "Mil Left": "ML",
    "Mil Right": "MR",
    "Right Ear": "SE",
    "225 Deg ASA": "225",
}
MICS = ("ML", "MR", "SE", "225")

# all.csv second header row -> our column names.
METRIC_COLUMNS = {
    "PkPr": "peak_pressure_pa",
    "dB": "peak_db",
    "dB(A)": "peak_dba",
    "Im-Pa": "impulse_pa_ms",
    "Im-dB": "impulse_db_ms",
    "Pk Leq": "peak_leq10ms_dba",
}

# "Nixis 30K (.30 on .300BO-16BA)" -- the space before "(" is not always there.
_RUN_DIR = re.compile(r"^(?P<suppressor>.*?)\s*\((?P<caliber>[^()]+?)\s+on\s+(?P<cartridge>[^()]+?)\)$")

# 2023 wraps everything in one top-level directory and puts each shot in its
# own "Shot N" subdirectory; 2024 onwards drop both.
_ARCHIVE_ROOT = re.compile(r"^\d{4}_SUMMIT_RELEASE_SET$")
_SHOT_DIR = re.compile(r"^Shot\s+(\d+)$")
# 2023 keeps failed captures in place and renames the directory to say so,
# e.g. "XX Shot 4 did not record".  Those files are all "Undefined".
_VOID_SHOT_DIR = re.compile(r"did not record|^XX\b", re.IGNORECASE)

# "Time Group_Expanded Time(Mil Left) - Input.3", or "... - Input.txt".
# 2024 also has three "- Input.x" files: a duplicate capture TBAC set aside.
_WAVEFORM_FILE = re.compile(
    r"^Time Group_Expanded Time\((?P<signal>.+)\) - Input(?:\.(?P<suffix>txt|x|\d+))?$"
)
EXCLUDED_SUFFIX = "x"

# Files that live in run directories but are not data.  BKFiles.m is the PULSE
# export macro 2023 copied into every shot directory; octave-workspace is
# leftover interpreter state; FIXME is a note TBAC left for themselves and is
# read into test_run.note rather than ignored.
IGNORED_FILENAMES = frozenset({"BKFiles.m", "octave-workspace", ".DS_Store"})
NOTE_FILENAME = "FIXME"

# "Specs.txt", but also "Spec.txt" and note-prefixed forms such as
# "DNR Specs.txt" or "No Thread on Specs.txt".
_SPEC_FILE = re.compile(r"^(?:(?P<note>.+?)\s+)?Specs?\.txt$")

# Manufacturers used for the unsuppressed reference shots.  2023 wrote
# "Bare Muzzle"; 2024 and 2025 shortened it to "Bare".
BASELINE_MANUFACTURERS = frozenset({"Bare", "Bare Muzzle"})

# Reference signals that are not a gunshot at all.  2023 recorded a handclap
# ("TBAC / Kurtis Clap", cal and cart both "hand") and entered the clapper's
# weight and height in the physical-spec columns -- 2800 oz and 72 in, against
# a 30 oz heaviest real suppressor.  Left unclassified it dominates any axis it
# appears on, so it is grouped with the baselines: measured, kept, and not a
# suppressor.
REFERENCE_CARTRIDGES = frozenset({"hand"})


def is_baseline_manufacturer(manufacturer: str) -> bool:
    return manufacturer in BASELINE_MANUFACTURERS


def is_reference_run(manufacturer: str, cartridge: str) -> bool:
    """Whether a run measures something other than a suppressed shot."""
    return (
        manufacturer in BASELINE_MANUFACTURERS
        or cartridge.strip().lower() in REFERENCE_CARTRIDGES
    )


RunKey = tuple[str, str, str, str, str]
"""(event_label, manufacturer, suppressor, caliber, cartridge)."""


@dataclass(frozen=True)
class RunDir:
    """A run directory, e.g. ``20250818/RR Weapons/Nixis 30K (.30 on .300BO-16BA)``."""

    event_label: str  # raw, e.g. "20250818" or 2023's "Day1"
    event_date: str | None  # ISO date when the label carries one, else None
    manufacturer: str
    suppressor: str
    caliber: str  # suppressor bore, e.g. ".30"
    cartridge: str  # cartridge + host code, e.g. ".300BO-16BA"
    path: str

    @property
    def is_baseline(self) -> bool:
        return is_reference_run(self.manufacturer, self.cartridge)


@dataclass(frozen=True)
class WaveformName:
    signal: str
    mic: str | None
    suffix: str  # "1".."4", "txt", or "x"

    @property
    def excluded(self) -> bool:
        """A capture TBAC set aside rather than one of the published shots."""
        return self.suffix == EXCLUDED_SUFFIX


@dataclass(frozen=True)
class Specs:
    """Contents of ``Specs.txt``.

    The five lines are name, length, weight, caliber, max diameter -- note
    that length comes *before* weight, the opposite of the column order in
    ``all.csv``.  Verified against all 366 runs where both sources carry
    physical specs: length matched line 2 and weight matched line 3 in every
    case.  Length and diameter are inches, weight is ounces.  The caliber line
    is free text and does not always agree with the directory name (".223" vs
    "5.56"), so it is kept verbatim and not used as a key.
    """

    name: str | None
    length_in: float | None
    weight_oz: float | None
    caliber: str | None
    max_diameter_in: float | None
    note: str | None = None
    raw: str = ""


@dataclass(frozen=True)
class SummaryRow:
    """One row of the published ``all.csv``."""

    event_label: str
    event_date: str | None
    manufacturer: str
    suppressor: str
    caliber: str
    cartridge: str
    shots: int | None
    weight_oz: float | None
    length_in: float | None
    max_diameter_in: float | None
    metrics: dict[str, dict[str, float | None]]  # mic -> column -> value

    @property
    def key(self) -> RunKey:
        return (
            self.event_label,
            self.manufacturer,
            self.suppressor,
            self.caliber,
            self.cartridge,
        )


def signal_to_mic(signal: str) -> str | None:
    """Map a PULSE channel name to a published mic code, or None if unknown."""
    return _SIGNAL_TO_MIC.get(signal.strip())


def parse_event(label: str) -> tuple[str, str | None]:
    """Return the raw event label and its ISO date, if it has one.

    2024 onwards use ``YYYYMMDD``. 2023 used ``Day1``/``Day2``/``Day3``, which
    carries no date, so callers must tolerate a null ``event_date``.
    """
    label = label.strip()
    if re.fullmatch(r"\d{8}", label):
        return label, f"{label[:4]}-{label[4:6]}-{label[6:]}"
    return label, None


def split_member_path(path: str) -> tuple[str, int | None, str] | None:
    """Split an archive member into ``(run_dir, shot, filename)``.

    Handles both layouts:

    * ``20250818/RR Weapons/Nixis 30K (.30 on .300BO-16BA)/...Input.3``
    * ``2023_SUMMIT_RELEASE_SET/Day1/Resilient/Jolene (.30 on .308)/Shot 4/...``

    Returns ``None`` for anything that is not a file inside a run directory.
    """
    parts = [p for p in path.strip("/").split("/") if p]
    if parts and _ARCHIVE_ROOT.match(parts[0]):
        parts = parts[1:]

    shot = None
    if len(parts) == 5:
        match = _SHOT_DIR.match(parts[3])
        if match is None:
            return None
        shot = int(match.group(1))
        parts = parts[:3] + parts[4:]
    if len(parts) != 4:
        return None
    return "/".join(parts[:3]), shot, parts[3]


def is_void_capture(path: str) -> bool:
    """Whether a path sits in a directory marked as a failed capture."""
    return any(_VOID_SHOT_DIR.search(part) for part in path.split("/"))


def parse_run_dir(path: str) -> RunDir | None:
    """Parse a ``<event>/<manufacturer>/<suppressor> (<cal> on <cart>)`` path."""
    parts = [p for p in path.strip("/").split("/") if p]
    if parts and _ARCHIVE_ROOT.match(parts[0]):
        parts = parts[1:]
    if len(parts) != 3:
        return None
    event, manufacturer, run = parts
    match = _RUN_DIR.match(run)
    if match is None:
        return None
    label, date = parse_event(event)
    return RunDir(
        event_label=label,
        event_date=date,
        manufacturer=manufacturer,
        suppressor=match.group("suppressor"),
        caliber=match.group("caliber"),
        cartridge=match.group("cartridge"),
        path="/".join(parts),
    )


def parse_waveform_filename(name: str) -> WaveformName | None:
    match = _WAVEFORM_FILE.match(name)
    if match is None:
        return None
    signal = match.group("signal")
    return WaveformName(
        signal=signal,
        mic=signal_to_mic(signal),
        suffix=match.group("suffix") or "txt",
    )


def parse_spec_filename(name: str) -> str | None | bool:
    """Return the note prefix on a spec filename, ``None`` if bare, else False.

    ``False`` means the name is not a spec file at all.  The prefixes are how
    the release set records per-run remarks: ``DNR Specs.txt``,
    ``Did not Run Specs.txt``, ``Strike Specs.txt``, ``No Thread on Specs.txt``.
    """
    match = _SPEC_FILE.match(name)
    if match is None:
        return False
    return match.group("note")


def parse_specs(raw: bytes | str, note: str | None = None) -> Specs:
    """Parse ``Specs.txt``.  Missing or malformed lines become ``None``."""
    text = raw.decode("latin-1") if isinstance(raw, bytes) else raw
    lines = [line.strip() for line in text.splitlines()]
    lines += [""] * (5 - len(lines))

    def num(value: str) -> float | None:
        try:
            return float(value)
        except ValueError:
            return None

    return Specs(
        name=lines[0] or None,
        length_in=num(lines[1]),
        weight_oz=num(lines[2]),
        caliber=lines[3] or None,
        max_diameter_in=num(lines[4]),
        note=note,
        raw=text,
    )


def read_summary_csv(path) -> list[SummaryRow]:
    """Parse a published ``all.csv``.

    Two header rows: the first names the mic for each measurement column, the
    second names the metric.  Column positions are read from those rows rather
    than hardcoded, so a future year that adds a mic or metric still parses.
    """
    with open(path, newline="", encoding="utf-8-sig") as handle:
        rows = list(csv.reader(handle))
    if len(rows) < 2:
        raise ValueError(f"{path}: expected at least two header rows")

    mic_row, metric_row = rows[0], rows[1]
    width = len(metric_row)
    mic_row = mic_row + [""] * (width - len(mic_row))

    if metric_row[:5] != ["_EVENT_", "_MFGR_", "_SUPPRESSOR_", "_CAL_", "_CART_"]:
        raise ValueError(f"{path}: unexpected key columns {metric_row[:5]!r}")

    # measurement columns: index -> (mic, our column name)
    measurements: dict[int, tuple[str, str]] = {}
    trailing: dict[str, int] = {}
    for index in range(5, width):
        mic, label = mic_row[index].strip(), metric_row[index].strip()
        if mic:
            column = METRIC_COLUMNS.get(label)
            if column is None:
                raise ValueError(f"{path}: unknown metric {label!r} in column {index}")
            measurements[index] = (mic, column)
        elif label:
            trailing[label] = index

    for required in ("shots", "weight", "len", "maxdia"):
        if required not in trailing:
            raise ValueError(f"{path}: missing trailing column {required!r}")

    def num(value: str) -> float | None:
        value = value.strip()
        try:
            return float(value)
        except ValueError:
            return None

    def dimension(value: str) -> float | None:
        """A physical spec, where zero means "not applicable", not "zero".

        The bare-muzzle references have no suppressor to measure, and
        Innovative Arms' IASW is an integrally-suppressed rifle, so its can is
        the barrel. All six are entered as 0.0 rather than left blank. Taken
        literally, a 0 oz 0 in suppressor is lighter and shorter than anything
        real and wins every frontier it appears on, so a zero is stored as
        missing.
        """
        measured = num(value)
        return None if measured == 0 else measured

    out: list[SummaryRow] = []
    for line_no, row in enumerate(rows[2:], start=3):
        if not any(cell.strip() for cell in row):
            continue
        if len(row) != width:
            raise ValueError(f"{path}:{line_no}: expected {width} columns, got {len(row)}")
        metrics: dict[str, dict[str, float | None]] = {}
        for index, (mic, column) in measurements.items():
            metrics.setdefault(mic, {})[column] = num(row[index])
        shots = num(row[trailing["shots"]])
        label, date = parse_event(row[0])
        out.append(
            SummaryRow(
                event_label=label,
                event_date=date,
                manufacturer=row[1].strip(),
                suppressor=row[2].strip(),
                caliber=row[3].strip(),
                cartridge=row[4].strip(),
                shots=int(shots) if shots is not None else None,
                weight_oz=dimension(row[trailing["weight"]]),
                length_in=dimension(row[trailing["len"]]),
                max_diameter_in=dimension(row[trailing["maxdia"]]),
                metrics=metrics,
            )
        )
    return out

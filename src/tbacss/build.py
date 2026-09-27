"""Build a SQLite database from a TBAC Silencer Summit release set.

The release tarball is read as a stream, so the ~60 GB of expanded PULSE text
never lands on disk.  Members arrive grouped by run directory; each group is
parsed, matched against the published ``all.csv`` row, and committed before the
next one starts.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import sqlite3
import sys
import tarfile
import time
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from . import blobs
from .pulse import PulseParseError, parse_pulse
from .summit import (
    RunDir,
    Specs,
    SummaryRow,
    parse_run_dir,
    parse_spec_filename,
    parse_specs,
    parse_waveform_filename,
    is_reference_run,
    is_void_capture,
    IGNORED_FILENAMES,
    NOTE_FILENAME,
    read_summary_csv,
    split_member_path,
)

__all__ = ["build", "BuildReport"]

SCHEMA_PATH = Path(__file__).with_name("schema.sql")


@dataclass
class BuildReport:
    """What the importer saw.  Printed by the CLI and worth checking."""

    runs: int = 0
    waveforms: int = 0
    samples: int = 0
    blob_bytes: int = 0
    summary_rows: int = 0
    matched_by_name: int = 0
    matched_by_specs: int = 0
    unmatched_runs: list[str] = field(default_factory=list)
    unmatched_summary: list[str] = field(default_factory=list)
    unknown_signals: set[str] = field(default_factory=set)
    void_captures: int = 0
    excluded_captures: int = 0
    short_captures: dict = field(default_factory=dict)
    truncated: list[str] = field(default_factory=list)
    defective: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    seconds: float = 0.0

    def render(self) -> str:
        lines = [
            f"runs              {self.runs}",
            f"waveforms         {self.waveforms}",
            f"samples           {self.samples:,}",
            f"blob bytes        {self.blob_bytes / 1e9:.2f} GB"
            f" ({self.samples * 4 / max(self.blob_bytes, 1):.2f}x vs raw float32)",
            f"all.csv rows      {self.summary_rows}"
            f" (matched {self.matched_by_name} by name,"
            f" {self.matched_by_specs} by physical specs)",
        ]
        if self.unmatched_runs:
            lines.append(f"runs not in all.csv ({len(self.unmatched_runs)}):")
            lines += [f"    {p}" for p in self.unmatched_runs]
        if self.unmatched_summary:
            lines.append(f"all.csv rows with no run directory ({len(self.unmatched_summary)}):")
            lines += [f"    {p}" for p in self.unmatched_summary]
        if self.short_captures:
            total = sum(self.short_captures.values())
            shapes = ", ".join(
                f"{n} records captured {k} samples" for k, n in sorted(self.short_captures.items())
            )
            lines.append(f"short captures ({total}): {shapes}")
        if self.excluded_captures:
            lines.append(
                f"spare captures kept but not numbered as shots: {self.excluded_captures}"
            )
        if self.void_captures:
            lines.append(
                f"files skipped in directories marked as failed captures: {self.void_captures}"
            )
        if self.truncated:
            lines.append(f"short records ({len(self.truncated)}):")
            lines += [f"    {p}" for p in self.truncated]
        if self.defective:
            lines.append(f"records with unparseable samples ({len(self.defective)}):")
            lines += [f"    {p}" for p in self.defective]
        if self.unknown_signals:
            lines.append(f"unmapped PULSE channels: {sorted(self.unknown_signals)}")
        for warning in self.warnings:
            lines.append(f"warning: {warning}")
        lines.append(f"elapsed           {self.seconds:.0f}s")
        return "\n".join(lines)


class _HashingReader:
    """File wrapper that SHA-256s the compressed bytes as they stream past."""

    def __init__(self, handle):
        self._handle = handle
        self.digest = hashlib.sha256()
        self.bytes_read = 0

    def read(self, size=-1):
        chunk = self._handle.read(size)
        self.digest.update(chunk)
        self.bytes_read += len(chunk)
        return chunk

    def close(self):
        self._handle.close()


@dataclass
class _PendingRun:
    """Members of one run directory, buffered until the directory changes."""

    run: RunDir
    specs: Specs | None = None
    spec_filename: str | None = None
    fixme: str | None = None
    waveforms: list[dict] = field(default_factory=list)
    aliases: dict[str, list[str]] = field(default_factory=lambda: defaultdict(list))


def _iter_members(source: Path):
    """Yield ``(path, kind, payload)`` for a tarball or an extracted directory.

    ``kind`` is ``"file"`` (payload is bytes) or ``"link"`` (payload is the
    link target, relative to the containing directory).
    """
    _iter_members.digest = None
    _iter_members.size = None
    if source.is_dir():
        yield from _iter_directory(source)
        return

    reader = _HashingReader(open(source, "rb"))
    try:
        with tarfile.open(fileobj=reader, mode="r|gz") as archive:
            for member in archive:
                if member.issym() or member.islnk():
                    yield member.name, "link", os.path.basename(member.linkname)
                elif member.isfile():
                    handle = archive.extractfile(member)
                    yield member.name, "file", handle.read()
        # tarfile stops at the end-of-archive marker; read the trailing
        # padding too so the digest matches sha256sum(1) on the whole file.
        while reader.read(1 << 20):
            pass
    finally:
        reader.close()
    _iter_members.digest = reader.digest.hexdigest()
    _iter_members.size = reader.bytes_read


def _iter_directory(root: Path):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort()
        for name in sorted(filenames):
            full = Path(dirpath) / name
            rel = str(full.relative_to(root))
            if full.is_symlink():
                yield rel, "link", os.path.basename(os.readlink(full))
            else:
                yield rel, "file", full.read_bytes()


def _close(a: float | None, b: float | None) -> bool:
    if a is None or b is None:
        return False
    return math.isclose(a, b, rel_tol=1e-9, abs_tol=1e-9)


class _SummaryIndex:
    """Match run directories to published rows.

    Four 2025 runs have a directory name that disagrees with the report --
    "Slamander" for "Salamander", and three Knight's Armament cans whose
    directory names were rewritten between the archive and the tables.  Those
    fall through to a match on (day, manufacturer, caliber, cartridge) plus
    the three physical dimensions, which is unique for every one of them.
    """

    def __init__(self, rows: list[SummaryRow]):
        self.rows = rows
        self.by_key = {row.key: row for row in rows}
        self.by_host: dict[tuple, list[SummaryRow]] = defaultdict(list)
        for row in rows:
            self.by_host[
                (row.event_label, row.manufacturer, row.caliber, row.cartridge)
            ].append(row)
        self.used: set[tuple] = set()

    def match(self, run: RunDir, specs: Specs | None) -> tuple[SummaryRow | None, str]:
        key = (
            run.event_label,
            run.manufacturer,
            run.suppressor,
            run.caliber,
            run.cartridge,
        )
        row = self.by_key.get(key)
        if row is not None:
            self.used.add(row.key)
            return row, "name"

        if specs is None:
            return None, "none"
        candidates = [
            candidate
            for candidate in self.by_host[
                (run.event_label, run.manufacturer, run.caliber, run.cartridge)
            ]
            if candidate.key not in self.used
            and _close(candidate.weight_oz, specs.weight_oz)
            and _close(candidate.length_in, specs.length_in)
            and _close(candidate.max_diameter_in, specs.max_diameter_in)
        ]
        if len(candidates) == 1:
            self.used.add(candidates[0].key)
            return candidates[0], "specs"
        return None, "none"


# Columns added after the first release, as (table, column, definition).
# CREATE TABLE IF NOT EXISTS will not add them to a database that already has
# the table, so they are applied by hand. Each default matches what the column
# would have held for rows imported before it existed.
_MIGRATIONS = (
    ("dataset", "archive_url", "TEXT"),
    ("waveform", "excluded", "INTEGER NOT NULL DEFAULT 0"),
    ("waveform", "defect_count", "INTEGER NOT NULL DEFAULT 0"),
    ("waveform", "defects_json", "TEXT"),
)


def _migrate(connection: sqlite3.Connection) -> None:
    for table, column, definition in _MIGRATIONS:
        existing = {
            row[1] for row in connection.execute(f"PRAGMA table_info({table})")
        }
        if existing and column not in existing:
            connection.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")


def _connect(db_path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(db_path)
    connection.executescript(SCHEMA_PATH.read_text())
    _migrate(connection)
    connection.commit()
    connection.execute("PRAGMA journal_mode = WAL")
    connection.execute("PRAGMA synchronous = NORMAL")
    return connection


def build(
    db_path: str | os.PathLike,
    *,
    year: int,
    archive: str | os.PathLike | None,
    summary_csv: str | os.PathLike,
    name: str | None = None,
    report_url: str | None = None,
    archive_url: str | None = None,
    replace: bool = False,
    progress=None,
) -> BuildReport:
    """Import one summit year into ``db_path``.

    ``archive`` may be the release ``.tar.gz``, an already-extracted copy of
    it, or ``None`` to import only the published table -- which is all that is
    available for a year whose release set has not been posted yet.
    ``summary_csv`` is the published ``all.csv`` for the same year.
    """
    db_path = Path(db_path)
    archive = Path(archive) if archive is not None else None
    summary_csv = Path(summary_csv)
    started = time.time()
    report = BuildReport()

    summary_rows = read_summary_csv(summary_csv)
    report.summary_rows = len(summary_rows)
    index = _SummaryIndex(summary_rows)

    connection = _connect(db_path)
    with connection:
        existing = connection.execute(
            "SELECT id FROM dataset WHERE year = ?", (year,)
        ).fetchone()
        if existing:
            if not replace:
                raise SystemExit(
                    f"{db_path}: year {year} is already imported; pass replace=True to redo it"
                )
            connection.execute("DELETE FROM dataset WHERE id = ?", (existing[0],))
        dataset_id = connection.execute(
            """INSERT INTO dataset
                   (year, name, report_url, summary_csv, archive_name,
                    archive_url, imported_at)
               VALUES (?, ?, ?, ?, ?, ?, datetime('now'))""",
            (
                year,
                name or f"{year} Silencer Summit",
                report_url,
                str(summary_csv),
                archive.name if archive else None,
                archive_url,
            ),
        ).lastrowid

    pending: _PendingRun | None = None

    def flush():
        nonlocal pending
        if pending is not None:
            _write_run(connection, dataset_id, pending, index, report)
            pending = None
            if progress:
                progress(report)

    members = _iter_members(archive) if archive is not None else ()
    for path, kind, payload in members:
        split = split_member_path(path)
        if split is None:
            if is_void_capture(path):
                report.void_captures += 1
            else:
                report.warnings.append(f"skipping unrecognised path {path!r}")
            continue
        directory, shot_dir, filename = split

        if pending is None or pending.run.path != directory:
            flush()
            run = parse_run_dir(directory)
            if run is None:
                report.warnings.append(f"skipping unrecognised path {path!r}")
                continue
            pending = _PendingRun(run=run)

        if kind == "link":
            pending.aliases[payload].append(filename)
            continue

        if filename in IGNORED_FILENAMES:
            continue
        if filename == NOTE_FILENAME:
            # TBAC's own remark about the run, e.g. "duplicated".
            pending.fixme = payload.decode("latin-1").strip()
            continue

        note = parse_spec_filename(filename)
        if note is not False:
            pending.specs = parse_specs(payload, note=note)
            pending.spec_filename = filename
            continue

        parsed_name = parse_waveform_filename(filename)
        if parsed_name is None:
            report.warnings.append(f"skipping unrecognised file {path!r}")
            continue
        if parsed_name.excluded:
            report.excluded_captures += 1
        if parsed_name.mic is None:
            report.unknown_signals.add(parsed_name.signal)

        try:
            waveform = parse_pulse(payload)
        except PulseParseError as error:
            report.warnings.append(f"{path}: {error}")
            continue
        if waveform.short_capture:
            report.short_captures[waveform.n_samples] = (
                report.short_captures.get(waveform.n_samples, 0) + 1
            )
        if waveform.truncated or waveform.index_inconsistent:
            report.truncated.append(
                f"{path} ({waveform.n_samples} of "
                f"{waveform.declared_samples} samples)"
            )
        if waveform.defects:
            report.defective.append(f"{path} ({len(waveform.defects)} samples)")
        pending.waveforms.append(
            {
                "filename": filename if shot_dir is None else f"Shot {shot_dir}/{filename}",
                "name": parsed_name,
                "waveform": waveform,
                "shot_dir": shot_dir,
            }
        )

    flush()

    digest = getattr(_iter_members, "digest", None)
    if digest:
        with connection:
            connection.execute(
                "UPDATE dataset SET archive_sha256 = ?, archive_bytes = ? WHERE id = ?",
                (digest, getattr(_iter_members, "size", None), dataset_id),
            )

    report.unmatched_summary = [
        " / ".join(row.key) for row in summary_rows if row.key not in index.used
    ]
    with connection:
        _insert_summary_only_rows(connection, dataset_id, summary_rows, index)
    connection.execute("PRAGMA optimize")
    connection.close()

    report.seconds = time.time() - started
    return report


def _insert_summary_only_rows(connection, dataset_id, summary_rows, index):
    """Keep published rows that have no run directory in the archive."""
    for row in summary_rows:
        if row.key in index.used:
            continue
        run_id = connection.execute(
            """INSERT INTO test_run
                   (dataset_id, event_label, event_date, manufacturer, suppressor,
                    caliber, cartridge, is_baseline, shots, weight_oz, length_in,
                    max_diameter_in, in_summary)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)""",
            (
                dataset_id,
                row.event_label,
                row.event_date,
                row.manufacturer,
                row.suppressor,
                row.caliber,
                row.cartridge,
                int(is_reference_run(row.manufacturer, row.cartridge)),
                row.shots,
                row.weight_oz,
                row.length_in,
                row.max_diameter_in,
            ),
        ).lastrowid
        _write_metrics(connection, run_id, row)


def _write_metrics(connection, run_id: int, row: SummaryRow) -> None:
    for mic, values in sorted(row.metrics.items()):
        connection.execute(
            """INSERT INTO summary_metric
                   (test_run_id, mic, peak_pressure_pa, peak_db, peak_dba,
                    impulse_pa_ms, impulse_db_ms, peak_leq10ms_dba)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                run_id,
                mic,
                values.get("peak_pressure_pa"),
                values.get("peak_db"),
                values.get("peak_dba"),
                values.get("impulse_pa_ms"),
                values.get("impulse_db_ms"),
                values.get("peak_leq10ms_dba"),
            ),
        )


def _merge_notes(*parts: str | None) -> str | None:
    """Combine the spec-filename prefix with any FIXME TBAC left in the run."""
    kept = [p.strip() for p in parts if p and p.strip()]
    return "; ".join(kept) or None


def _write_run(connection, dataset_id, pending: _PendingRun, index, report) -> None:
    run, specs = pending.run, pending.specs
    row, how = index.match(run, specs)
    if how == "name":
        report.matched_by_name += 1
    elif how == "specs":
        report.matched_by_specs += 1
    else:
        report.unmatched_runs.append(run.path)

    suppressor = row.suppressor if row else run.suppressor
    archive_suppressor = run.suppressor if suppressor != run.suppressor else None

    with connection:
        run_id = connection.execute(
            """INSERT INTO test_run
                   (dataset_id, event_label, event_date, manufacturer, suppressor,
                    caliber, cartridge, is_baseline, shots, weight_oz, length_in,
                    max_diameter_in, archive_path, archive_suppressor,
                    specs_name, specs_caliber, note, in_summary)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                dataset_id,
                run.event_label,
                run.event_date,
                run.manufacturer,
                suppressor,
                run.caliber,
                run.cartridge,
                int(run.is_baseline),
                row.shots if row else None,
                row.weight_oz if row else (specs.weight_oz if specs else None),
                row.length_in if row else (specs.length_in if specs else None),
                row.max_diameter_in if row else (specs.max_diameter_in if specs else None),
                run.path,
                archive_suppressor,
                specs.name if specs else None,
                specs.caliber if specs else None,
                _merge_notes(specs.note if specs else None, pending.fixme),
                int(row is not None),
            ),
        ).lastrowid
        if row:
            _write_metrics(connection, run_id, row)
        _write_waveforms(connection, run_id, pending, report)

    report.runs += 1


def _write_waveforms(connection, run_id: int, pending: _PendingRun, report) -> None:
    """Insert one run's waveforms, numbering shots by capture time.

    2023 puts each shot in its own ``Shot N`` directory, so the number is
    stated outright and we use it.

    2024 onwards flatten that away, and PULSE names the first export
    ``- Input.txt`` and later ones ``- Input.1`` onwards, so the filename
    suffix is not the shot order.  The releases add an ``Input.5`` symlink to
    ``Input.txt`` in most runs, which implies ``.txt`` is the last shot; the
    header timestamps confirm it, so those are what we sort on.
    """
    by_signal: dict[str, list[dict]] = defaultdict(list)
    for entry in pending.waveforms:
        by_signal[entry["name"].signal].append(entry)

    for signal, entries in sorted(by_signal.items()):
        spare = [e for e in entries if e["name"].excluded]
        entries = [e for e in entries if not e["name"].excluded]
        numbered = entries and all(e["shot_dir"] is not None for e in entries)
        if numbered:
            entries.sort(key=lambda e: e["shot_dir"])
        elif any(entry["waveform"].captured_at is None for entry in entries):
            report.warnings.append(
                f"{pending.run.path}: {signal} has records without a header "
                "timestamp; falling back to filename order"
            )
            entries.sort(key=lambda e: (e["name"].suffix == "txt", e["name"].suffix))
        else:
            entries.sort(key=lambda e: e["waveform"].captured_at)
        # Spare captures keep their data but are numbered after the real
        # shots, so shot 1..N still lines up with the published average.
        highest = max((e["shot_dir"] or 0) for e in entries) if numbered else len(entries)
        entries = entries + sorted(spare, key=lambda e: e["filename"])

        for index, entry in enumerate(entries, start=1):
            excluded = entry["name"].excluded
            if excluded:
                highest += 1
                shot = highest
            else:
                shot = entry["shot_dir"] if numbered else index
            waveform = entry["waveform"]
            blob = blobs.encode(waveform.samples)
            aliases = pending.aliases.get(entry["filename"], [])
            captured = waveform.captured_at
            connection.execute(
                """INSERT INTO waveform
                       (test_run_id, mic, signal, shot, excluded, captured_at, n_samples,
                        sample_rate_hz, t0_s, dt_s, amplitude_unit, db_reference,
                        input_range, overload, peak_pa, min_pa, defect_count,
                        defects_json, archive_path, archive_aliases, header_json,
                        tags_json, codec, samples)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    run_id,
                    entry["name"].mic,
                    signal,
                    shot,
                    int(excluded),
                    captured.isoformat(timespec="milliseconds") if captured else None,
                    waveform.n_samples,
                    waveform.sample_rate,
                    waveform.t0,
                    waveform.dt,
                    waveform.amplitude_unit,
                    waveform.dB_reference,
                    waveform.input_range,
                    None if waveform.overload is None else int(waveform.overload),
                    float(np.nanmax(waveform.samples)),
                    float(np.nanmin(waveform.samples)),
                    len(waveform.defects),
                    json.dumps(waveform.defects[:64]) if waveform.defects else None,
                    f"{pending.run.path}/{entry['filename']}",
                    json.dumps(aliases) if aliases else None,
                    json.dumps(waveform.header),
                    json.dumps(waveform.tags),
                    blobs.CODEC,
                    blob,
                ),
            )
            report.waveforms += 1
            report.samples += waveform.n_samples
            report.blob_bytes += len(blob)


def default_progress(report: BuildReport) -> None:
    if report.runs % 10:
        return
    sys.stderr.write(
        f"\r{report.runs} runs, {report.waveforms} waveforms, "
        f"{report.blob_bytes / 1e9:.2f} GB stored"
    )
    sys.stderr.flush()

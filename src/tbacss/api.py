"""Read side of the database.

Everything here is a thin convenience layer over SQL -- the point is to make
waveform blobs come back as numpy arrays.  For anything analytical, query the
``v_run`` / ``v_measurement`` views directly.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from . import blobs

__all__ = ["SummitDB", "Waveform"]


@dataclass
class Waveform:
    """One shot at one microphone, with its samples decoded."""

    id: int
    test_run_id: int
    mic: str | None
    signal: str
    shot: int
    captured_at: str | None
    sample_rate_hz: float
    t0_s: float
    dt_s: float
    amplitude_unit: str | None
    db_reference: float | None
    overload: bool | None
    archive_path: str
    defect_count: int
    samples: np.ndarray

    def times(self) -> np.ndarray:
        """Sample times in seconds."""
        return self.t0_s + np.arange(self.samples.size, dtype=np.float64) * self.dt_s

    def to_db(self, reference: float | None = None) -> np.ndarray:
        """Instantaneous level in dB re the calibration reference."""
        ref = reference or self.db_reference or 2e-5
        return 20.0 * np.log10(np.abs(self.samples.astype(np.float64)) / ref)


class SummitDB:
    """Open a database built by :func:`tbacss.build.build`."""

    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.connection = sqlite3.connect(f"file:{self.path}?mode=ro", uri=True)
        self.connection.row_factory = sqlite3.Row

    def __enter__(self) -> SummitDB:
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    def close(self) -> None:
        self.connection.close()

    # -- generic ------------------------------------------------------------

    def query(self, sql: str, params=()) -> list[sqlite3.Row]:
        return self.connection.execute(sql, params).fetchall()

    def dataframe(self, sql: str, params=()):
        """Run a query and return a pandas DataFrame (pandas required)."""
        import pandas as pd

        return pd.read_sql_query(sql, self.connection, params=params)

    # -- runs ---------------------------------------------------------------

    def runs(
        self,
        *,
        year: int | None = None,
        manufacturer: str | None = None,
        suppressor: str | None = None,
        caliber: str | None = None,
        cartridge: str | None = None,
    ) -> list[sqlite3.Row]:
        """Rows from ``v_run``, optionally filtered.  Text filters are exact."""
        where, params = [], []
        for column, value in (
            ("year", year),
            ("manufacturer", manufacturer),
            ("suppressor", suppressor),
            ("caliber", caliber),
            ("cartridge", cartridge),
        ):
            if value is not None:
                where.append(f"{column} = ?")
                params.append(value)
        sql = "SELECT * FROM v_run"
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY year, event_label, manufacturer, suppressor"
        return self.query(sql, params)

    # -- waveforms ----------------------------------------------------------

    _WAVEFORM_COLUMNS = """
        id, test_run_id, mic, signal, shot, captured_at, sample_rate_hz,
        t0_s, dt_s, amplitude_unit, db_reference, overload, archive_path,
        defect_count, codec, samples
    """

    def waveforms(
        self,
        test_run_id: int,
        *,
        mic: str | None = None,
        shot: int | None = None,
    ) -> list[Waveform]:
        """Decoded waveforms for one run."""
        sql = f"SELECT {self._WAVEFORM_COLUMNS} FROM waveform WHERE test_run_id = ?"
        params: list = [test_run_id]
        if mic is not None:
            sql += " AND mic = ?"
            params.append(mic)
        if shot is not None:
            sql += " AND shot = ?"
            params.append(shot)
        sql += " ORDER BY mic, shot"
        return [self._to_waveform(row) for row in self.query(sql, params)]

    def waveform(self, waveform_id: int) -> Waveform:
        rows = self.query(
            f"SELECT {self._WAVEFORM_COLUMNS} FROM waveform WHERE id = ?", (waveform_id,)
        )
        if not rows:
            raise KeyError(f"no waveform with id {waveform_id}")
        return self._to_waveform(rows[0])

    def waveform_index(self, **filters) -> list[sqlite3.Row]:
        """Waveform metadata without decoding any blobs."""
        where, params = [], []
        for column, value in filters.items():
            where.append(f"w.{column} = ?")
            params.append(value)
        sql = """
            SELECT w.id, w.test_run_id, w.mic, w.shot, w.captured_at, w.n_samples,
                   w.overload, w.peak_pa, w.archive_path,
                   r.event_label, r.event_date, r.manufacturer, r.suppressor,
                   r.caliber, r.cartridge
            FROM waveform w JOIN test_run r ON r.id = w.test_run_id
        """
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY r.event_label, r.manufacturer, r.suppressor, w.mic, w.shot"
        return self.query(sql, params)

    @staticmethod
    def _to_waveform(row: sqlite3.Row) -> Waveform:
        overload = row["overload"]
        return Waveform(
            id=row["id"],
            test_run_id=row["test_run_id"],
            mic=row["mic"],
            signal=row["signal"],
            shot=row["shot"],
            captured_at=row["captured_at"],
            sample_rate_hz=row["sample_rate_hz"],
            t0_s=row["t0_s"],
            dt_s=row["dt_s"],
            amplitude_unit=row["amplitude_unit"],
            db_reference=row["db_reference"],
            overload=None if overload is None else bool(overload),
            archive_path=row["archive_path"],
            defect_count=row["defect_count"],
            samples=blobs.decode(row["samples"], row["codec"]),
        )

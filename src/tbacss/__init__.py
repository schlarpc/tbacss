"""Parse TBAC Silencer Summit release sets into SQLite.

    from tbacss import SummitDB

    with SummitDB("tbacss.db") as db:
        run = db.runs(manufacturer="TBAC")[0]
        shot = db.waveforms(run["test_run_id"], mic="SE", shot=1)[0]
        print(shot.samples.max(), "Pa peak")

Build a database with ``python -m tbacss build``.
"""

import importlib.metadata as _importlib_metadata

from .api import SummitDB, Waveform
from .build import BuildReport, build
from .pulse import PulseParseError, PulseWaveform, parse_pulse, parse_pulse_file
from .summit import MICS, Specs, SummaryRow, read_summary_csv

__all__ = [
    "MICS",
    "BuildReport",
    "PulseParseError",
    "PulseWaveform",
    "Specs",
    "SummaryRow",
    "SummitDB",
    "Waveform",
    "__version__",
    "build",
    "parse_pulse",
    "parse_pulse_file",
    "read_summary_csv",
]

__version__: str = _importlib_metadata.version(__package__ or __name__)

#!/usr/bin/env python3
"""Write the fixture that `web/check.mjs` validates the browser maths against.

Picks a spread of records -- different years, mics and hosts -- encodes each
analysis window exactly as `tbacss publish` does, and records the metrics
`tbacss.analysis` computes from the same decoded samples.

    python3 scripts/make_js_fixture.py tbacss.db web/fixture
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

from tbacss import SummitDB, wavecodec
from tbacss.analysis import P_0, TIME_START_S, a_weighting, shot_metrics
from tbacss.webexport import _analysis_window

SAMPLE_RATE = 262144.0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("database")
    parser.add_argument("output", type=Path)
    parser.add_argument("--count", type=int, default=6)
    parser.add_argument("--bits", type=int, default=16, choices=[16, 24])
    args = parser.parse_args()

    args.output.mkdir(parents=True, exist_ok=True)
    b, a = a_weighting(SAMPLE_RATE)
    meta = {
        "sample_rate_hz": SAMPLE_RATE,
        "a_weighting": {"b": list(b), "a": list(a)},
        "sample_bits": args.bits,
        "codec": wavecodec.CODEC,
        "records": [],
    }

    with SummitDB(args.database) as db:
        # One record per (year, mic) combination that exists, up to --count.
        picks = db.query(
            """SELECT w.id, w.mic, w.dt_s, r.cartridge, r.manufacturer,
                      r.suppressor, d.year
               FROM waveform w
               JOIN test_run r ON r.id = w.test_run_id
               JOIN dataset d ON d.id = r.dataset_id
               WHERE w.defect_count = 0
               GROUP BY d.year, w.mic
               ORDER BY d.year, w.mic
               LIMIT ?""",
            (args.count,),
        )
        for position, row in enumerate(picks):
            waveform = db.waveform(row["id"])
            window = _analysis_window(
                waveform.samples, row["dt_s"], row["cartridge"], row["year"]
            ).astype(np.float32)
            encoded = wavecodec.encode(window, bits=args.bits)
            name = f"window{position}.tbw"
            (args.output / name).write_bytes(encoded.payload)

            # The metrics a browser must match are the ones Python gets from
            # the same quantised samples. shot_metrics slices the analysis
            # window itself, so splice the decoded samples back into the full
            # record rather than handing it a window it would window again.
            spliced = waveform.samples.copy()
            offset = int(np.floor(TIME_START_S / row["dt_s"] + 0.5)) - 1
            decoded = wavecodec.decode(encoded.payload)
            spliced[offset : offset + decoded.size] = decoded
            computed = shot_metrics(
                spliced,
                dt=row["dt_s"],
                cartridge=row["cartridge"],
                year=row["year"],
            )
            to_db = lambda v: float(20 * np.log10(v / P_0))
            meta["records"].append(
                {
                    "file": name,
                    "label": f"{row['year']} {row['manufacturer']} {row['suppressor']}"
                    f" ({row['cartridge']}) {row['mic']}",
                    "dt": row["dt_s"],
                    "n": int(window.size),
                    "expected": {
                        "peak_pa": computed.peak_pa,
                        "peak_db": to_db(computed.peak_pa),
                        "peak_dba": to_db(computed.peak_a_pa),
                        "impulse_pa_ms": computed.impulse_pa_ms,
                        "impulse_db_ms": to_db(computed.impulse_pa_ms),
                        "peak_leq10ms_dba": to_db(computed.peak_leq_pa),
                    },
                }
            )

    (args.output / "meta.json").write_text(json.dumps(meta, indent=1))
    print(f"wrote {len(meta['records'])} fixture records to {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

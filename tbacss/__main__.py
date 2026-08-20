"""Command line interface: ``python -m tbacss <command>``."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np

from .api import SummitDB
from .build import build, default_progress

REPORT_URL = "https://thunderbeastarms.com/sound/summit{year}/"


def _cmd_build(args) -> int:
    report = build(
        args.database,
        year=args.year,
        archive=args.archive,
        summary_csv=args.summary_csv,
        report_url=REPORT_URL.format(year=args.year),
        archive_url=args.archive_url,
        replace=args.replace,
        progress=None if args.quiet else default_progress,
    )
    if not args.quiet:
        sys.stderr.write("\r" + " " * 78 + "\r")
    print(report.render())
    return 0


def _cmd_info(args) -> int:
    with SummitDB(args.database) as db:
        for row in db.query("SELECT * FROM dataset ORDER BY year"):
            size = row["archive_bytes"]
            print(f"{row['year']}  {row['name']}")
            print(f"    imported     {row['imported_at']}")
            print(f"    report       {row['report_url']}")
            print(f"    archive      {row['archive_name']}"
                  + (f" ({size / 1e9:.2f} GB)" if size else ""))
            if row["archive_url"]:
                print(f"    source       {row['archive_url']}")
            if row["archive_sha256"]:
                print(f"    sha256       {row['archive_sha256']}")
            counts = db.query(
                """SELECT
                       (SELECT COUNT(*) FROM test_run WHERE dataset_id = ?) AS runs,
                       (SELECT COUNT(*) FROM test_run
                         WHERE dataset_id = ? AND in_summary = 1) AS published,
                       (SELECT COUNT(*) FROM waveform w JOIN test_run r
                         ON r.id = w.test_run_id WHERE r.dataset_id = ?) AS waveforms,
                       (SELECT SUM(n_samples) FROM waveform w JOIN test_run r
                         ON r.id = w.test_run_id WHERE r.dataset_id = ?) AS samples""",
                (row["id"],) * 4,
            )[0]
            print(f"    runs         {counts['runs']} ({counts['published']} in all.csv)")
            print(f"    waveforms    {counts['waveforms']}"
                  f"  ({counts['samples'] or 0:,} samples)")
    return 0


def _cmd_export(args) -> int:
    with SummitDB(args.database) as db:
        frame = db.dataframe(f"SELECT * FROM {args.view}")
    out = Path(args.output)
    if out.suffix == ".parquet":
        frame.to_parquet(out, index=False)
    elif out.suffix in (".json", ".jsonl"):
        frame.to_json(out, orient="records", lines=out.suffix == ".jsonl", indent=2)
    else:
        frame.to_csv(out, index=False)
    print(f"wrote {len(frame)} rows to {out}")
    return 0


def _cmd_analyze(args) -> int:
    """Recompute per-shot metrics from the waveforms into `shot_metric`."""
    import sqlite3

    import numpy as np

    from .analysis import P_0, shot_metrics
    from . import blobs

    from .build import _migrate

    write = sqlite3.connect(args.database)
    write.executescript((Path(__file__).with_name("schema.sql")).read_text())
    _migrate(write)
    write.commit()
    if args.replace:
        write.execute("DELETE FROM shot_metric")
        write.commit()

    with SummitDB(args.database) as db:
        todo = db.query(
            """SELECT w.id, w.codec, r.cartridge, d.year, w.dt_s, w.sample_rate_hz
               FROM waveform w
               JOIN test_run r ON r.id = w.test_run_id
               JOIN dataset d ON d.id = r.dataset_id
               WHERE (? IS NULL OR d.year = ?)
                 AND w.id NOT IN (SELECT waveform_id FROM shot_metric)
               ORDER BY w.id""",
            (args.year, args.year),
        )
        total, done, failed = len(todo), 0, 0
        for row in todo:
            blob = db.query(
                "SELECT samples FROM waveform WHERE id = ?", (row["id"],)
            )[0]["samples"]
            samples = blobs.decode(blob, row["codec"])
            try:
                m = shot_metrics(
                    samples,
                    dt=row["dt_s"],
                    cartridge=row["cartridge"],
                    sample_rate=row["sample_rate_hz"],
                    year=row["year"],
                )
            except ValueError as error:
                failed += 1
                sys.stderr.write(f"\n  waveform {row['id']}: {error}\n")
                continue
            to_db = lambda v: float(20.0 * np.log10(v / P_0))  # noqa: E731
            write.execute(
                """INSERT OR REPLACE INTO shot_metric
                       (waveform_id, peak_pa, peak_a_pa, impulse_pa_ms, peak_leq_pa,
                        peak_db, peak_dba, impulse_db_ms, peak_leq10ms_dba)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    row["id"],
                    m.peak_pa,
                    m.peak_a_pa,
                    m.impulse_pa_ms,
                    m.peak_leq_pa,
                    to_db(m.peak_pa),
                    to_db(m.peak_a_pa),
                    to_db(m.impulse_pa_ms),
                    to_db(m.peak_leq_pa),
                ),
            )
            done += 1
            if done % 200 == 0:
                write.commit()
                sys.stderr.write(f"\r{done}/{total} shots analysed")
                sys.stderr.flush()
    write.commit()
    write.close()
    sys.stderr.write("\r" + " " * 60 + "\r")
    print(f"analysed {done} waveforms ({failed} failed, {total} outstanding at start)")
    return 1 if failed else 0


def _cmd_verify(args) -> int:
    """Recompute the published table from the stored waveforms and diff it."""
    from .analysis import ShotMetrics, average_metrics, shot_metrics

    columns = [
        "peak_pressure_pa",
        "peak_db",
        "peak_dba",
        "impulse_pa_ms",
        "impulse_db_ms",
        "peak_leq10ms_dba",
    ]
    worst: dict[str, float] = {column: 0.0 for column in columns}
    checked = failed = 0
    with SummitDB(args.database) as db:
        runs = db.query(
            """SELECT r.id, r.manufacturer, r.suppressor, r.caliber, r.cartridge,
                      r.shots, d.year
               FROM test_run r JOIN dataset d ON d.id = r.dataset_id
               WHERE r.in_summary = 1
                 AND (? IS NULL OR d.year = ?)
                 AND EXISTS (SELECT 1 FROM waveform w WHERE w.test_run_id = r.id)
               ORDER BY r.id""",
            (args.year, args.year),
        )
        if args.limit:
            runs = runs[: args.limit]
        for run in runs:
            published = {
                row["mic"]: row
                for row in db.query(
                    "SELECT * FROM summary_metric WHERE test_run_id = ?", (run["id"],)
                )
            }
            for mic, expected in published.items():
                # Prefer the metrics `analyze` already stored; only decode
                # waveforms for shots it has not covered.
                stored = db.query(
                    """SELECT s.peak_pa, s.peak_a_pa, s.impulse_pa_ms, s.peak_leq_pa
                       FROM waveform w JOIN shot_metric s ON s.waveform_id = w.id
                       WHERE w.test_run_id = ? AND w.mic = ? AND w.excluded = 0
                         AND (? IS NULL OR w.shot <= ?)
                       ORDER BY w.shot""",
                    (run["id"], mic, run["shots"], run["shots"]),
                )
                try:
                    if stored:
                        shots = [ShotMetrics(*row) for row in stored]
                    else:
                        waveforms = db.waveforms(run["id"], mic=mic)
                        # 2023 saved more shots than it published; the
                        # reference averages "Shot 1".."Shot N" for the N in
                        # the table.
                        if run["shots"]:
                            waveforms = [
                                w for w in waveforms if w.shot <= run["shots"]
                            ]
                        if not waveforms:
                            continue
                        shots = [
                            shot_metrics(
                                w.samples,
                                dt=w.dt_s,
                                cartridge=run["cartridge"],
                                year=run["year"],
                            )
                            for w in waveforms
                        ]
                    actual = average_metrics(shots)
                except ValueError as error:
                    failed += 1
                    print(
                        f"  !! {run['manufacturer']} {run['suppressor']} {mic}: {error}"
                    )
                    continue
                checked += 1
                for column in columns:
                    if expected[column] is None:
                        continue
                    delta = abs(getattr(actual, column) - expected[column])
                    if delta > worst[column]:
                        worst[column] = delta
                    if delta > args.tolerance:
                        print(
                            f"  !! {run['manufacturer']} {run['suppressor']} "
                            f"({run['caliber']} on {run['cartridge']}) {mic} {column}: "
                            f"published {expected[column]} vs {getattr(actual, column):.4f}"
                        )
    print(f"checked {checked} run/mic combinations ({failed} could not be computed)")
    print("largest deviation from the published table:")
    for column in columns:
        print(f"    {column:20} {worst[column]:.4f}")
    print(f"tolerance {args.tolerance} (the table is rounded to 2 decimals)")
    return 1 if failed or max(worst.values()) > args.tolerance else 0


def _cmd_publish(args) -> int:
    from .webexport import publish

    def progress(done, total):
        sys.stderr.write(f"\r{done}/{total} waveforms packed")
        sys.stderr.flush()

    report = publish(
        args.database,
        args.output,
        buckets=args.buckets,
        sample_bits=args.sample_bits,
        progress=None if args.quiet else progress,
    )
    sys.stderr.write("\r" + " " * 60 + "\r")
    print(report.render())
    return 0


def _cmd_wave(args) -> int:
    with SummitDB(args.database) as db:
        waveform = db.waveform(args.waveform_id)
    out = Path(args.output)
    if out.suffix == ".npy":
        np.save(out, waveform.samples)
    elif out.suffix == ".npz":
        np.savez_compressed(out, t=waveform.times(), pa=waveform.samples)
    else:
        np.savetxt(
            out,
            np.column_stack([waveform.times(), waveform.samples]),
            delimiter=",",
            header="time_s,pressure_pa",
            comments="",
        )
    print(
        f"wrote {waveform.samples.size} samples from {waveform.archive_path} to {out}"
    )
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="tbacss", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("build", help="import a release set into SQLite")
    p.add_argument("database", help="SQLite file to create or add to")
    p.add_argument("--year", type=int, required=True)
    p.add_argument(
        "--archive",
        default=None,
        help="release .tar.gz or extracted dir; omit to import the table only",
    )
    p.add_argument("--summary-csv", required=True, help="published all.csv")
    p.add_argument("--archive-url", default=None,
                   help="where --archive came from, recorded for provenance")
    p.add_argument("--replace", action="store_true", help="re-import an existing year")
    p.add_argument("--quiet", action="store_true")
    p.set_defaults(func=_cmd_build)

    p = sub.add_parser("info", help="summarise what a database holds")
    p.add_argument("database")
    p.set_defaults(func=_cmd_info)

    p = sub.add_parser("export", help="dump a view to csv/json/parquet")
    p.add_argument("database")
    p.add_argument("output", help="destination; extension picks the format")
    p.add_argument("--view", default="v_measurement", choices=["v_run", "v_measurement"])
    p.set_defaults(func=_cmd_export)

    p = sub.add_parser(
        "analyze", help="compute per-shot metrics from the waveforms"
    )
    p.add_argument("database")
    p.add_argument("--year", type=int, default=None)
    p.add_argument("--replace", action="store_true", help="recompute everything")
    p.set_defaults(func=_cmd_analyze)

    p = sub.add_parser(
        "verify", help="recompute all.csv from the waveforms and diff it"
    )
    p.add_argument("database")
    p.add_argument("--year", type=int, default=None)
    p.add_argument("--limit", type=int, default=None, help="check only the first N runs")
    p.add_argument("--tolerance", type=float, default=0.01)
    p.set_defaults(func=_cmd_verify)

    p = sub.add_parser("publish", help="emit the static bundle for a web explorer")
    p.add_argument("database")
    p.add_argument("output", help="directory to write the bundle into")
    p.add_argument("--buckets", type=int, default=2048, help="envelope resolution")
    p.add_argument("--sample-bits", type=int, default=16, choices=[16, 24],
                   help="quantiser depth for the full-rate tier")
    p.add_argument("--quiet", action="store_true")
    p.set_defaults(func=_cmd_publish)

    p = sub.add_parser("wave", help="dump one waveform to npy/npz/csv")
    p.add_argument("database")
    p.add_argument("waveform_id", type=int)
    p.add_argument("output")
    p.set_defaults(func=_cmd_wave)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())

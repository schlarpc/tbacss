"""Emit a static bundle for a browser-side explorer.

The dataset is two things bolted together, and they want opposite treatments:

* the **catalog** -- every filterable, sortable, Pareto-able number -- is a few
  thousand rows.  It ships whole, up front, as dictionary-encoded columns that
  land directly in typed arrays.  Filtering and frontier-finding over that is a
  tight loop over ``Float32Array``, so no query engine is involved.
* the **waveforms** are hundreds of megabytes.  Nothing ships up front.  Each
  record lives at a known byte range inside one big file and is pulled with a
  ``Range`` request when something actually needs to draw it.

Two resolutions of waveform are published:

* ``envelopes.bin`` -- per-record min/max over ``ENVELOPE_BUCKETS`` buckets,
  int16.  This is what an overview plot needs: for a canvas narrower than the
  bucket count, min/max decimation is visually lossless, because the extremes
  are exactly the feature that matters in a blast trace.
* ``samples.bin`` -- the full-rate analysis window as ``fixed2-rice-v1``
  frames (see :mod:`tbacss.wavecodec`), about half the size of raw int16.
  Fetched on zoom; roughly 2 ms to decode a record in a browser.

Impulse and Leq curves are deliberately *not* published.  They are cheap to
derive in the browser from the full-rate window -- a cumulative trapezoid and a
six-coefficient IIR plus a sliding RMS -- and deriving them client-side means
the user can re-window or re-weight interactively instead of being stuck with
whatever windowing was baked in at publish time.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
from dataclasses import asdict, dataclass, field
from pathlib import Path

import numpy as np

from . import blobs, wavecodec
from .caveats import CAVEATS, as_dicts, caveats_for
from .analysis import BAND_CENTRES
from .derive import band_statistics, net_reduction, run_statistics
from .hosts import HOSTS, Host
from .analysis import TIME_START_S, TIME_STOP_S, TIME_STOP_SHORT_S, is_short_window

__all__ = ["ENVELOPE_BUCKETS", "PublishReport", "publish"]

ENVELOPE_BUCKETS = 2048
INT16_MAX = 32767.0

# Columns lifted straight out of v_run.  Strings become dictionary indices,
# numbers become float32; both arrive in the browser as typed arrays.
_TEXT_COLUMNS = (
    "manufacturer",
    "suppressor",
    "caliber",
    "cartridge",
    "event_label",
)
_NUMERIC_COLUMNS = (
    "year",
    "is_baseline",
    "shots",
    "weight_oz",
    "length_in",
    "max_diameter_in",
    "vol_cuin",
    "se_peak_db",
    "se_peak_dba",
    "se_impulse_db_ms",
    "se_peak_leq10ms_dba",
    "ml_peak_db",
    "ml_peak_dba",
    "ml_impulse_db_ms",
    "ml_peak_leq10ms_dba",
    "mr_peak_db",
    "mr_peak_dba",
    "p225_peak_db",
    "p225_peak_dba",
    "waveform_count",
)
#: Shipped column -> the (mic, per-shot metric) it summarises. Used to attach
#: a standard error to every published mean.
_MIC_METRIC = {
    "se_peak_db": ("SE", "peak_db"),
    "se_peak_dba": ("SE", "peak_dba"),
    "se_impulse_db_ms": ("SE", "impulse_db_ms"),
    "se_peak_leq10ms_dba": ("SE", "peak_leq10ms_dba"),
    "ml_peak_db": ("ML", "peak_db"),
    "ml_peak_dba": ("ML", "peak_dba"),
    "ml_impulse_db_ms": ("ML", "impulse_db_ms"),
    "ml_peak_leq10ms_dba": ("ML", "peak_leq10ms_dba"),
    "mr_peak_db": ("MR", "peak_db"),
    "mr_peak_dba": ("MR", "peak_dba"),
    "p225_peak_db": ("225", "peak_db"),
    "p225_peak_dba": ("225", "peak_dba"),
}

_SHOT_NUMERIC_COLUMNS = (
    "peak_db",
    "peak_dba",
    "impulse_db_ms",
    "peak_leq10ms_dba",
)


@dataclass
class PublishReport:
    runs: int = 0
    waveforms: int = 0
    shots_with_metrics: int = 0
    files: dict[str, int] = field(default_factory=dict)

    def render(self) -> str:
        lines = [
            f"runs               {self.runs}",
            f"waveforms          {self.waveforms}",
            f"per-shot metrics   {self.shots_with_metrics}",
            "",
            f"{'file':22}{'bytes':>14}{'MB':>9}",
        ]
        for name, size in self.files.items():
            lines.append(f"{name:22}{size:14,}{size / 1e6:9.2f}")
        total = sum(self.files.values())
        eager = sum(
            v for k, v in self.files.items()
            if k.endswith(".json") and k != "bands.json"
        )
        lines += [
            f"{'TOTAL':22}{total:14,}{total / 1e6:9.2f}",
            "",
            f"shipped on first load: {eager / 1024:.0f} KB uncompressed"
            " (the .bin files are range-fetched on demand)",
        ]
        return "\n".join(lines)


def _finite(values: list) -> list:
    """Replace non-finite floats with None.

    json.dumps happily writes ``-Infinity`` and ``NaN``, which no JSON parser
    accepts -- the browser's fetch().json() rejects the whole file. Guard the
    boundary rather than trusting every upstream column to be clean.
    """
    return [
        None if isinstance(v, float) and not math.isfinite(v) else v for v in values
    ]


def _encode_text_column(values: list) -> tuple[list[str], list[int]]:
    """Dictionary-encode a string column.

    The dictionary doubles as the facet list for the filter UI, so the browser
    never has to scan the column to find out what values exist.
    """
    order: dict[str, int] = {}
    codes = []
    for value in values:
        if value is None:
            codes.append(-1)
            continue
        code = order.get(value)
        if code is None:
            code = len(order)
            order[value] = code
        codes.append(code)
    return list(order), codes


def _analysis_window(samples: np.ndarray, dt: float, cartridge: str, year: int):
    """The slice the published metrics are computed over."""
    stop_s = TIME_STOP_SHORT_S if is_short_window(cartridge, year) else TIME_STOP_S
    start = int(np.floor(TIME_START_S / dt + 0.5))
    stop = int(np.floor(stop_s / dt + 0.5))
    return samples[start - 1 : stop]


def _envelope(window: np.ndarray, buckets: int) -> np.ndarray:
    """Interleaved min/max per bucket, as float32.

    The buckets tile the *whole* window, which needs uneven ones: 32507 samples
    do not divide into 2048.  Truncating to a round multiple instead would drop
    the last 1787 samples -- 6.8 ms, the tail end of the decay -- and, worse,
    leave a reader no way to know it had happened.  A client can only place a
    bucket in time by assuming the buckets span the record, so an envelope that
    quietly covers 117 ms of a 124 ms window is drawn stretched across the full
    width and puts every feature in it a few milliseconds late.
    """
    if window.size < buckets:
        raise ValueError(f"{window.size} samples cannot fill {buckets} buckets")
    edges = (np.arange(buckets) * window.size) // buckets
    out = np.empty(buckets * 2, dtype=np.float32)
    out[0::2] = np.minimum.reduceat(window, edges)
    out[1::2] = np.maximum.reduceat(window, edges)
    return out


def _quantize(values: np.ndarray) -> tuple[bytes, float]:
    """int16 with a single per-record scale factor, used for the envelopes.

    Envelopes are deliberately left raw rather than run through
    :mod:`tbacss.wavecodec`: a client slices a whole run's worth out of one
    Range response with no decode at all, and the codec only buys 1.34x on
    min/max data, which is not worth a decode per record every time a run is
    opened.

    Measured against the full pipeline this quantiser costs at most 0.0013 dB
    on impulse and under 0.0005 dB on every other metric -- an order of
    magnitude below the 0.01 dB the published tables are rounded to.

    float16 is the obvious alternative at the same two bytes per sample, and it
    is a real trade rather than a clear loss.  Measured over the same records:

        metric              int16     float16
        peak                0.0002 dB  0.0025 dB
        peak A-weighted     0.0001 dB  0.0015 dB
        impulse             0.0013 dB  0.0007 dB
        noise floor         0.0045 Pa  0.0002 Pa

    int16 spends its resolution at the peak, float16 spreads it evenly across
    the dynamic range.  Every published metric here is peak-referenced, so
    int16 wins where it counts and is supported everywhere.  If a later tier
    publishes the full 0.5 s record for studying the decay tail, float16 is
    the better encoding for it.
    """
    peak = float(np.abs(values).max())
    scale = peak / INT16_MAX if peak > 0 else 1.0
    return np.round(values / scale).astype("<i2").tobytes(), scale


def publish(
    db_path: str | os.PathLike,
    out_dir: str | os.PathLike,
    *,
    buckets: int = ENVELOPE_BUCKETS,
    sample_bits: int = 16,
    catalog_only: bool = False,
    progress=None,
) -> PublishReport:
    """Write the static bundle for ``db_path`` into ``out_dir``.

    ``catalog_only`` rewrites just the three JSON files and leaves the two
    binaries alone.  Repacking 13620 frames to change one column in the
    catalog is several minutes of work for a few hundred kilobytes of output,
    and the waveform bytes only change when the database's waveforms do.
    """
    from .api import SummitDB

    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    report = PublishReport()

    with SummitDB(db_path) as db:
        runs = db.query("SELECT * FROM v_run ORDER BY year, test_run_id")
        report.runs = len(runs)

        catalog: dict = {"n": len(runs), "columns": {}, "dictionaries": {}}
        catalog["ids"] = [r["test_run_id"] for r in runs]
        for column in _TEXT_COLUMNS:
            dictionary, codes = _encode_text_column([r[column] for r in runs])
            catalog["dictionaries"][column] = dictionary
            catalog["columns"][column] = codes
        for column in _NUMERIC_COLUMNS:
            catalog["columns"][column] = _finite([r[column] for r in runs])

        datasets = db.query(
            "SELECT year, name, report_url, archive_sha256 FROM dataset ORDER BY year"
        )
        catalog["datasets"] = [dict(d) for d in datasets]

        # The host codes are prose in each year's report, not in all.csv, so
        # ship the transcription with the data rather than making every reader
        # decode ".50BW-SUB-10.5AR" for themselves.
        used = set(catalog["dictionaries"]["cartridge"])
        catalog["hosts"] = {
            code: asdict(host) for code, host in HOSTS.items() if code in used
        }

        # Join the host attributes onto every run as real columns, so the same
        # filter and frontier code works on them without a special case. The
        # barrel a can was tested on is the biggest confounder in the set, and
        # it was previously locked inside a string like ".300BO-16BA".
        codes = [r["cartridge"] for r in runs]
        blank = Host(label="", description="")
        for column, field in (
            ("host_barrel_in", "barrel_in"),
            ("host_grains", "grains"),
        ):
            catalog["columns"][column] = _finite(
                [getattr(HOSTS.get(code, blank), field) for code in codes]
            )
        for column, field in (("host_cycling", "cycling"), ("host_platform", "platform")):
            dictionary, values = _encode_text_column(
                [getattr(HOSTS.get(code, blank), field) for code in codes]
            )
            catalog["dictionaries"][column] = dictionary
            catalog["columns"][column] = values
        # Tri-state, so "not stated" never reads as "supersonic".
        supersonic_dict, supersonic = _encode_text_column(
            [
                None
                if HOSTS.get(code, blank).subsonic is None
                else ("subsonic" if HOSTS[code].subsonic else "supersonic")
                for code in codes
            ]
        )
        catalog["dictionaries"]["host_ammo"] = supersonic_dict
        catalog["columns"]["host_ammo"] = supersonic

        # Uncertainty, first-round pop and net reduction: everything the
        # published tables leave out. See tbacss.derive for why each matters.
        ids = [r["test_run_id"] for r in runs]
        stats = {
            metric: run_statistics(db, metric)
            for metric in {m for _, m in _MIC_METRIC.values()}
        }
        for column, (mic, metric) in _MIC_METRIC.items():
            if column not in catalog["columns"]:
                continue
            table = stats[metric]
            catalog["columns"][f"{column}_sem"] = _finite(
                [
                    (table.get((run_id, mic)).sem if table.get((run_id, mic)) else None)
                    for run_id in ids
                ]
            )

        pop = stats["peak_dba"]
        for column, mic in (("se_first_round_pop", "SE"), ("ml_first_round_pop", "ML")):
            catalog["columns"][column] = _finite(
                [
                    (
                        pop.get((run_id, mic)).first_round_pop
                        if pop.get((run_id, mic))
                        else None
                    )
                    for run_id in ids
                ]
            )

        for column, mic, metric in (
            ("se_reduction_dba", "SE", "peak_dba"),
            ("ml_reduction_dba", "ML", "peak_dba"),
            ("se_reduction_db", "SE", "peak_db"),
            ("ml_reduction_db", "ML", "peak_db"),
        ):
            reduction = net_reduction(db, metric)
            catalog["columns"][column] = _finite(
                [reduction.get((run_id, mic)) for run_id in ids]
            )

        # One-third-octave spectra. Two scalars go in the catalog so they can
        # be filtered and plotted; the full curves ship separately and are
        # fetched only when something needs to draw one.
        bands = band_statistics(db, BAND_CENTRES) if _has_bands(db) else {}
        if bands:
            for column, mic, field in (
                ("se_low_freq_db", "SE", "low_frequency_db"),
                ("ml_low_freq_db", "ML", "low_frequency_db"),
                ("se_centroid_hz", "SE", "centroid_hz"),
            ):
                catalog["columns"][column] = _finite(
                    [
                        (bands.get((run_id, mic)) or {}).get(field)
                        for run_id in ids
                    ]
                )
            catalog["band_centres"] = [round(f, 1) for f in BAND_CENTRES]

        # Advisories TBAC published in prose. Without these a reader ranks
        # suppressors on numbers TBAC says to disregard.
        catalog["caveats"] = as_dicts()
        years = [r["year"] for r in runs]
        flags = [
            "; ".join(c.summary for c in caveats_for(year, code)) or None
            for year, code in zip(years, codes)
        ]
        caveat_dict, caveat_codes = _encode_text_column(flags)
        catalog["dictionaries"]["caveat"] = caveat_dict
        catalog["columns"]["caveat"] = caveat_codes

        # -- per-shot metrics ------------------------------------------------
        shots = db.query(
            """SELECT waveform_id, test_run_id, mic, shot, peak_db, peak_dba,
                      impulse_db_ms, peak_leq10ms_dba
               FROM v_shot ORDER BY waveform_id"""
        )
        report.shots_with_metrics = len(shots)
        shot_table: dict = {"n": len(shots), "columns": {}, "dictionaries": {}}
        shot_table["columns"]["waveform_id"] = [s["waveform_id"] for s in shots]
        shot_table["columns"]["test_run_id"] = [s["test_run_id"] for s in shots]
        shot_table["columns"]["shot"] = [s["shot"] for s in shots]
        mics, codes = _encode_text_column([s["mic"] for s in shots])
        shot_table["dictionaries"]["mic"] = mics
        shot_table["columns"]["mic"] = codes
        for column in _SHOT_NUMERIC_COLUMNS:
            shot_table["columns"][column] = _finite([s[column] for s in shots])

        # -- waveform tiers --------------------------------------------------
        index = db.query(
            """SELECT w.id, w.test_run_id, w.mic, w.shot, w.excluded, w.dt_s,
                      w.overload, w.codec, r.cartridge, d.year
               FROM waveform w
               JOIN test_run r ON r.id = w.test_run_id
               JOIN dataset d ON d.id = r.dataset_id
               ORDER BY r.id, w.mic, w.shot"""
        )
        report.waveforms = len(index)

        env_path, raw_path = out / "envelopes.bin", out / "samples.bin"
        index_path = out / "waveforms.json"
        if catalog_only:
            # Reuse the published index rather than decoding 13k blobs to
            # rebuild an index that is already on disk and unchanged.
            if not (env_path.exists() and raw_path.exists() and index_path.exists()):
                raise SystemExit(
                    f"catalog_only needs an existing bundle in {out}; "
                    "run a full publish first"
                )
            waveform_index = json.loads(index_path.read_text())
            report.waveforms = waveform_index["n"]
            _write_json(out, catalog, shot_table, waveform_index)
            _write_bands(out, bands, run_ids=ids)
            return _measure(out, report, waveform_index["n"] * buckets * 4,
                            sum(waveform_index["columns"]["raw_len"]))

        entries = []
        with open(env_path, "wb") as env_file, open(raw_path, "wb") as raw_file:
            env_offset = raw_offset = 0
            for position, row in enumerate(index):
                blob = db.query(
                    "SELECT samples FROM waveform WHERE id = ?", (row["id"],)
                )[0]["samples"]
                samples = blobs.decode(blob, row["codec"])
                window = _analysis_window(
                    samples, row["dt_s"], row["cartridge"], row["year"]
                ).astype(np.float32)

                # Envelopes stay raw int16: a client slices them straight out
                # of one Range response with no decode, and the codec only
                # buys 1.34x on min/max data -- not worth a decode per record
                # on every run the user opens.
                env_bytes, env_scale = _quantize(_envelope(window, buckets))
                # Full-rate samples get the frame codec, which halves them.
                # That tier is only fetched on zoom, so ~2 ms to decode is free.
                raw_bytes = wavecodec.encode(window, bits=sample_bits).payload
                env_file.write(env_bytes)
                raw_file.write(raw_bytes)

                entries.append(
                    {
                        "id": row["id"],
                        "run": row["test_run_id"],
                        "mic": row["mic"],
                        "shot": row["shot"],
                        "excluded": row["excluded"],
                        "dt": row["dt_s"],
                        "n": int(window.size),
                        "overload": row["overload"],
                        "env_scale": env_scale,
                        "env_len": len(env_bytes),
                        "raw_len": len(raw_bytes),
                    }
                )
                env_offset += len(env_bytes)
                raw_offset += len(raw_bytes)
                if progress and position % 250 == 0:
                    progress(position, len(index))

        # Columnar, and with the offsets left out: envelopes are fixed size so
        # an envelope offset is just index * env_len, and raw offsets are the
        # prefix sum of raw_len. The client reconstructs both in one pass,
        # which keeps this file a few hundred KB instead of a few MB.
        #
        # Records are written in run order, so one run's records are contiguous
        # in both files. run_first/run_count let a client open a run with a
        # single coalesced Range request instead of one per record.
        run_first: dict[str, int] = {}
        run_count: dict[str, int] = {}
        for position, entry in enumerate(entries):
            key = str(entry["run"])
            if key not in run_first:
                run_first[key] = position
            run_count[key] = run_count.get(key, 0) + 1

        mic_names, mic_codes = _encode_text_column([e["mic"] for e in entries])
        waveform_index = {
            "n": len(entries),
            "buckets": buckets,
            "env_len": buckets * 4,  # every envelope is the same size
            "sample_codec": wavecodec.CODEC,
            "sample_bits": sample_bits,
            "sample_rate_hz": 262144.0,
            "window_start_s": TIME_START_S,
            "dictionaries": {"mic": mic_names},
            "columns": {
                "id": [e["id"] for e in entries],
                "run": [e["run"] for e in entries],
                "mic": mic_codes,
                "shot": [e["shot"] for e in entries],
                "excluded": [e["excluded"] for e in entries],
                "n": [e["n"] for e in entries],
                "dt": [e["dt"] for e in entries],
                "overload": [e["overload"] for e in entries],
                "env_scale": [e["env_scale"] for e in entries],
                "raw_len": [e["raw_len"] for e in entries],
            },
            "run_first": run_first,
            "run_count": run_count,
        }

    _write_json(out, catalog, shot_table, waveform_index)
    _write_bands(out, bands, run_ids=ids)
    return _measure(
        out,
        report,
        len(entries) * buckets * 4,
        sum(entry["raw_len"] for entry in entries),
    )


def _has_bands(db) -> bool:
    return bool(
        db.query(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='band_level'"
        )
        and db.query("SELECT 1 FROM band_level LIMIT 1")
    )


def _write_bands(out: Path, bands: dict, run_ids: list[int]) -> None:
    """Spectra, in their own file because nothing needs them on first load.

    Rounded to a tenth of a dB: these are 30-point curves for a chart, and
    full float precision would triple the file for no visible difference.
    """
    if not bands:
        return
    payload: dict[str, dict[str, list]] = {}
    for (run_id, mic), entry in bands.items():
        payload.setdefault(str(run_id), {})[mic] = [
            None if v != v else round(float(v), 1) for v in entry["levels"]
        ]
    (out / "bands.json").write_text(
        json.dumps({"centres": [round(f, 1) for f in BAND_CENTRES], "runs": payload},
                   separators=(",", ":"))
    )


def _write_json(out: Path, catalog, shot_table, waveform_index) -> None:
    """Write the three JSON files, stamping the bundle with a content version.

    The version is what lets a client cache the megabytes aggressively and
    still never serve a stale bundle: it revalidates the small catalog and
    fetches everything else at a versioned URL. Without it a long-lived cache
    entry outlives a republish, which looks exactly like the export being
    broken -- and did, once, here.
    """
    payloads = {
        "catalog.json": catalog,
        "shots.json": shot_table,
        "waveforms.json": waveform_index,
    }
    digest = hashlib.sha256()
    for name in sorted(payloads):
        digest.update(json.dumps(payloads[name], separators=(",", ":"), sort_keys=True).encode())
    catalog["version"] = digest.hexdigest()[:12]

    for name, payload in payloads.items():
        (out / name).write_text(json.dumps(payload, separators=(",", ":")))


def _measure(out: Path, report, expected_env: int, expected_raw: int):
    """Record the file sizes, and check the index's arithmetic lands on them.

    The index publishes lengths, not offsets, so a client rebuilds both by
    prefix sum. A silent drift there would produce plausible-looking garbage.
    """
    for name in (
        "catalog.json",
        "shots.json",
        "waveforms.json",
        "bands.json",
        "envelopes.bin",
        "samples.bin",
    ):
        path = out / name
        if path.exists():
            report.files[name] = path.stat().st_size

    for name, expected in (
        ("envelopes.bin", expected_env),
        ("samples.bin", expected_raw),
    ):
        if report.files[name] != expected:
            raise RuntimeError(
                f"{name} is {report.files[name]} bytes, "
                f"but the index implies {expected}"
            )
    return report

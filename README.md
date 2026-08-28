# tbacss

Parses [TBAC Silencer Summit](https://thunderbeastarms.com/sound/consolidated/)
release sets into a single SQLite database: the published summary table, the
per-suppressor physical specs, and every PULSE waveform in the archive.

## What the release sets look like

TBAC publishes two things per year:

* `all.csv` — the summary table from the report. One row per test run, with
  shot-averaged peak / impulse / Leq figures for each microphone.
* `<year>_SUMMIT_RELEASE_SET.tar.gz` — the raw B&K PULSE exports. Every
  capture is 131072 samples at 262144 Hz (0.5 s, 24-bit), exported as ASCII.

The layout is not the same every year, and the parser handles both shapes:

| | 2023 | 2024 – 2026 |
| --- | --- | --- |
| archive root | `2023_SUMMIT_RELEASE_SET/` | none |
| event | `Day1` … `Day3` | `YYYYMMDD` |
| shot | `Shot N/` subdirectory | filename suffix `- Input.N` |
| microphones | `ML`, `SE`, `225` | `ML`, `MR`, `SE` |
| physical specs | `all.csv` only | `Specs.txt` per run |
| `.22` analysis window | 0.125 s (no special case) | 0.100 s |

`ML` and `MR` are the MIL-STD-1474 positions left and right of the muzzle,
`SE` is the shooter's ear, and `225` is the 225-degree above-shoulder-arc
position 2023 used in place of `MR`.

## Install

Only `numpy` is needed to build and read. `scipy` is needed for `verify`,
`pandas` for `export`.

```
pip install numpy scipy pandas
```

## Get the sources

The published summary tables are tracked here. Everything else — the report
pages, TBAC's reference Octave, and the ~21 GB of release archives — is
fetched:

```
scripts/fetch_sources.sh              # tables, reports, reference code
scripts/fetch_sources.sh --archives   # also the release sets
```

[PROVENANCE.md](PROVENANCE.md) records the URL, size and SHA-256 of every
archive; [ATTRIBUTION.md](ATTRIBUTION.md) covers the terms the data is used
under.

## Build

```
for year in 2023 2024 2025; do
    python -m tbacss build tbacss.db \
        --year $year \
        --archive ${year}_SUMMIT_RELEASE_SET.tar.gz \
        --summary-csv summit$year/all.csv
done

# 2026's release set is not posted yet; import the published table alone
python -m tbacss build tbacss.db --year 2026 --summary-csv summit2026/all.csv

python -m tbacss analyze tbacss.db      # per-shot metrics from the waveforms
python -m tbacss bands tbacss.db        # one-third-octave spectra, for the shape
```

The tarball is streamed, so the expanded text never hits disk. `--archive`
also accepts an already-extracted directory, and omitting it imports only
`all.csv` — useful for a year whose waveforms have not been released.

## Use

```python
from tbacss import SummitDB

with SummitDB("tbacss.db") as db:
    quietest = db.query("""
        SELECT manufacturer, suppressor, se_peak_db, weight_oz
        FROM v_run
        WHERE cartridge = '5.56-16AR' AND caliber = '.223'
        ORDER BY se_peak_db LIMIT 10
    """)

    run = db.runs(manufacturer="TBAC", suppressor="Ultra 7")[0]
    for shot in db.waveforms(run["test_run_id"], mic="SE"):
        print(shot.shot, shot.samples.max(), "Pa peak")
```

`Waveform.samples` is a float32 numpy array of pressure in Pa;
`Waveform.times()` reconstructs the sample times.

Other commands:

```
python -m tbacss info tbacss.db
python -m tbacss export tbacss.db measurements.parquet --view v_measurement
python -m tbacss wave tbacss.db 1234 shot.npz
python -m tbacss verify tbacss.db
```

## Static web bundle

`python -m tbacss publish tbacss.db web/data` writes a bundle a static site can
serve with no backend and no query engine:

| file | loaded | contents |
| --- | --- | --- |
| `catalog.json` | up front | one row per run, dictionary-encoded columns |
| `shots.json` | up front | per-shot metrics |
| `waveforms.json` | up front | byte offsets into the two `.bin` files |
| `envelopes.bin` | on demand | 2048-bucket min/max per record, raw int16 |
| `samples.bin` | on demand | full-rate analysis window, `fixed2-rice-v1` frames |

The envelope's buckets tile the whole record, which means uneven ones: 32507
samples do not divide into 2048. A client has nothing to place a bucket in time
with except the assumption that the buckets span the record, so truncating to a
round multiple would not merely lose the tail — the rest would be drawn
stretched across the full width, putting every feature in it milliseconds late.

The split is deliberate. Everything filterable is a few thousand rows, so it
ships whole and lands in typed arrays; filtering and Pareto search are plain
loops. Everything large is a waveform, which no SQL engine helps with — those
are fetched one at a time by byte range.

Impulse and Leq curves are *not* published. They are a cumulative trapezoid
and a six-coefficient IIR, cheap to derive in the browser, and deriving them
client-side lets a reader re-window or re-weight interactively instead of
being stuck with whatever was baked in at publish time.

### The waveform codec

These records are audio — 262 kHz sampling of a signal whose energy is far
below Nyquist — so `tbacss/wavecodec.py` uses the cheap tier of FLAC: quantise
to integers, take the second difference, Rice-code the residual with a
parameter chosen per 4096-sample block. Measured over real records, bytes per
sample:

| encoding | B/sample |
| --- | ---: |
| float32 raw | 4.000 |
| float32 + zlib | 2.416 |
| float16 raw / int16 raw | 2.000 |
| int16 + zlib | 1.356 |
| int16 + zstd-19 | 1.270 |
| int16 delta + zstd-19 | 1.130 |
| **int16 + this codec** | **0.889** |
| int24 + this codec | 1.887 |

The win comes from predicting across samples. No per-sample number format can
capture that: float16, bfloat16 and posit16 all sit at 2.0 B/sample, and a
posit's tapered precision peaks near ±1.0 while every metric here is
referenced to the peak. Order 2 beat orders 0, 1, 3 and 4 on every record, and
also beat computed LPC at orders 8, 16 and 32 — the signal is oversampled
enough that a two-tap predictor is already near optimal.

At `--sample-bits 24` the codec reproduces the published metrics *exactly* and
still costs less than raw int16. At the int16 default the worst error is
0.0013 dB, against tables rounded to 0.01 dB.

Envelopes stay raw int16 on purpose: a client slices them straight out of one
Range response with no decode, and the codec only buys 1.34x there — not worth
a decode per record every time a run is opened.

`scripts/bench_encodings.py` reproduces the table above.

### Running the explorer

```
python -m tbacss publish tbacss.db web/data
python3 scripts/serve.py                     # http://127.0.0.1:8765
```

Use `scripts/serve.py`, not `python -m http.server`: the stock one ignores
`Range` and answers 200 with the whole file, so every waveform click would pull
all 432 MB of `samples.bin`. Any real static host (S3, Cloudflare, nginx,
Caddy) handles ranges correctly.

The page filters on facets and numeric ranges, plots any measure against any
other with the Pareto frontier highlighted, and draws a run's waveforms —
overview envelopes first, then full rate on demand with impulse and Leq
derived in the browser. A run or shot is deep-linkable
(`#run=20&shot=296`), and `?theme=light|dark` overrides the OS setting.

The waveform card opens framed on the blast, not on the whole window. The rig
pre-triggers and every shot in the archive arrives between about 47 and 56 ms,
so a full-window view spends two fifths of the plot on guaranteed silence and
leaves the event a few pixels wide. Scroll, pinch, drag or the arrow keys move
the view; `reset zoom` returns to the run's own framing, which is widened if a
shot's trough falls outside it. The shots of one mic are drawn as a single
min/max band — its width is the shot-to-shot spread — and picking a shot draws
that record at full rate on top. Impulse and Leq are marked where the report's
method takes them from: the impulse is the largest the running integral gets
before the trough, not where it ends up, and the Leq peak is looked for in the
25 ms after the shot starts. A marker the reader has zoomed past is pulled to
the edge with its time rather than dropped.

Setting a Z axis punches the plot into 3D — drag to rotate — and the frontier
becomes 3-objective. Direction is a property of each measure rather than a
control: everything on the axes is a sound level or a physical dimension, so
less is always better. A column where more is better is added by writing
`'max'` in `MEASURES`. `year` is `null` there, meaning it is a dimension and
not an objective, so putting it on an axis switches the frontier off instead of
pretending 2026 dominates 2023.

On a phone the filter panel collapses behind a toggle so the data is above the
fold, each dimension is its own disclosure with a count badge, the table folds
to five columns instead of scrolling sideways, and a tap does the job hover
does on a desktop: it selects the run *and* leaves the readout up until the
next tap.

`scripts/ui_smoke.mjs` drives the real thing over CDP — screenshots prove it
renders, this proves it works:

```
python3 scripts/serve.py &
chromium --headless --remote-debugging-port=9222 --no-sandbox about:blank &
node scripts/ui_smoke.mjs                                   # 390x844, touch
node scripts/ui_smoke.mjs http://127.0.0.1:8765/index.html 1400 900
```

The runs table lists frontier runs first by default, then the sorted column;
the grouping is a toggle in the card header. Facets are ordered by what you do
with them — calibers by volume, makers and hosts A-Z, since those are lists you
look a specific name up in. Hosts sort by the name shown rather than the raw
code, or the rendered list would look unsorted.

`web/tbacss.js` is the dependency-free reader underneath it: `loadBundle`,
`selection`, `paretoFront`, `fetchRunEnvelopes`, `fetchSamples`, `decodeFrame`,
and the derived `impulse` / `leq` / `metrics`. `analyse` is the same analysis
returning its working — the curves plus the indices the report's method picks
out of them — which is what lets the plots mark where a figure came from;
`metrics` is that reduced to the published numbers. To confirm the browser maths
matches Python:

```
node web/test.mjs                                       # filtering and Pareto
python3 scripts/make_js_fixture.py tbacss.db web/fixture
node web/check.mjs web/fixture                          # DSP against Python
```

`check.mjs` closes the loop: Python encodes a frame, JS decodes it, JS
recomputes peak / dBA / impulse / Leq, and the results are compared against
what `tbacss.analysis` gets from the same samples. They agree to 0.00001 dB,
which is what makes it safe to derive figures in the browser rather than
shipping precomputed curves.

## Schema

| table | grain |
| --- | --- |
| `dataset` | one summit year, with the archive's SHA-256 |
| `test_run` | one suppressor on one host/cartridge on one day |
| `summary_metric` | run × mic, straight from `all.csv` |
| `waveform` | run × mic × shot, with the samples as a compressed blob |
| `shot_metric` | run × mic × shot, recomputed by `analyze` |
| `band_level` | run × mic × shot, 30 one-third-octave levels, from `bands` |

Three views flatten the common cases: `v_measurement` (one row per run per
mic), `v_run` (one row per run, all mics pivoted, plus cylinder volume), and
`v_shot` (per-shot metrics with enough context to group them).

In SQLite, samples are stored as zlib-compressed little-endian float32. The
source files print six significant figures, which float32 round-trips exactly,
so nothing is lost relative to the release set. (The `fixed2-rice-v1` codec is
for the web bundle, where halving the bytes on the wire matters; the database
keeps the plain float32 so any tool can read it.) The full PULSE header and
footer tags are kept verbatim in `waveform.header_json` / `waveform.tags_json`.

## Derived analyses

`all.csv` gives one shot-averaged number per run per mic, printed to two
decimals. `tbacss/derive.py` adds four things that number cannot express, all
computed from `shot_metric` and `band_level` — no waveform is re-read.

**Uncertainty.** Five shots have a spread: the median shot-to-shot standard
deviation is 1.46 dBA, so the mean carries a standard error near 0.65 dBA. The
published figures resolve to 0.01 dB, which invites rankings the measurement
cannot support — the eight quietest .223 cans on `5.56-16AR` span 1.72 dBA in
total, under three standard errors end to end. Every `*_dba`/`*_db` column in
the web bundle has a `*_sem` companion, the scatter draws ±1 SEM bars whenever
the slice is sparse enough to read them, and the readout says how many other
visible runs are *not* distinguishable from the one you picked.

**First-round pop.** The first shot through a cold, air-filled can is louder;
the median is +1.11 dBA and it is positive in 72% of run/mic combinations.
Averaging five shots hides it, and it is the shot that matters in the field.

**Net reduction.** TBAC fires an unsuppressed reference on most hosts, so "how
much quieter" is computable for 629 runs, spanning +6.18 to +41.41 dBA. Only a
reference fired the same year on the same host counts as a baseline. This is
the one measure where **more is better**, which is why frontier direction is a
per-measure property rather than a global setting.

**Spectral shape.** `tbacss bands` computes 30 one-third-octave levels
(IEC 61260 preferred centres, 25 Hz to 20 kHz) per shot, Parseval-checked
against a direct periodogram to 0.0000 dB. Shots are averaged in energy, not in
decibels. Two scalars come out of it — energy at or below 250 Hz, where
A-weighting has rolled off ~9 dB and stops reporting what you feel, and the
spectral centroid. The chart plots energy *per Hz*: proportional-bandwidth
bands widen as they climb, so raw band levels slope up about 1 dB per band on
any signal and read as "it's all treble" regardless of content. The stored
levels are raw — the energy sums need the widths in — and only the plot divides
them out.

## Verification

`python -m tbacss verify` recomputes every cell of `all.csv` from the stored
waveforms using `tbacss/analysis.py`, an independent port of the Octave TBAC
links from each report's CODE section (fetched into `reference/`). Agreement is
within the table's 2-decimal rounding, which is the end-to-end check that the
archive was parsed correctly.

`analysis.py` is usable on its own if you want to re-window or re-weight the
data: `a_weighting()`, `leq_fast()`, `shot_metrics()`, `average_metrics()`.

Unit tests cover the file formats against synthetic fixtures:

```
python3 -m pytest
```

## Notes on the data

* 2023 names each shot directory outright. From 2024 on, PULSE names the first
  export `- Input.txt` and later ones `- Input.1` onwards, so the filename
  suffix is *not* the shot order; shots are numbered by the capture timestamp
  in the header instead. The 2025 set adds an `Input.5` symlink to `Input.txt`
  in most runs, which agrees.
* 2023 saved more shots than it published in a few runs. Every capture is
  stored; `test_run.shots` is how many the report averaged, and `verify` uses
  only those.
* A handful of run directories disagree with the report on the suppressor
  name. Those are matched on manufacturer, host and physical dimensions, and
  the directory spelling is preserved in `test_run.archive_suppressor`.
* Runs that were photographed but not fired carry a note prefix on the spec
  filename (`DNR Specs.txt`, `Did not Run Specs.txt`); that lands in
  `test_run.note`, and `test_run.in_summary` marks whether the run made it
  into the published table.
* `Specs.txt` lists length *before* weight, the opposite of the `all.csv`
  column order.
* A physical dimension of `0.0` means "not applicable", not "zero", and is
  stored as NULL. Six 2024 rows carry zeros: the five bare-muzzle references,
  and Innovative Arms' IASW, an integrally-suppressed rifle whose can is the
  barrel. Taken literally a 0 oz, 0 in suppressor is lighter and shorter than
  anything real — before the fix IASW ranked as the lightest *and* shortest
  suppressor in the dataset and sat unbeatable on every weight or length
  frontier.
* **TBAC published a warning that is not in the data.** The 2024 `.22LR-BA`
  host was a last-minute substitute after a rifle malfunction, and it rings at
  the shooter's-ear mic on roughly half the shots: *"it is probably best to
  ignore the SE numbers for this run of .22's"*. That is 26 runs whose SE
  figures should not be ranked on, and it lives only in the report prose, so
  anything built on `all.csv` alone would use them. `tbacss/caveats.py` makes
  it machine-readable, `publish` flags the affected runs, and the explorer
  marks them. It is the only substantive advisory across all four years —
  found by grepping every report for advisory language, not by luck.
* Host codes are not in `all.csv` — they are prose in each year's report.
  `tbacss/hosts.py` is that prose *parsed*, covering all 51 codes, and
  `publish` both ships it and joins it onto every run as `host_barrel_in`,
  `host_cycling`, `host_platform`, `host_ammo` and `host_grains`. So the two
  biggest confounders in the dataset stop being locked inside a string:

  | attribute | coverage | values |
  | --- | ---: | --- |
  | `host_cycling` | 1185 / 1188 runs | 583 manual, 602 self-loading |
  | `host_barrel_in` | 1010 / 1188 runs | 5" to 27" |
  | `host_platform` | 1187 / 1188 runs | bolt, AR, pistol, PCC, lever, rifle |
  | `host_ammo` | 1173 / 1188 runs | 391 subsonic, 782 supersonic |

  Cycling matters because TBAC's own FAQ says so: "suppressors shot on 5.56
  will never have their peak less than the SS crack because the action noise
  ('port pop') on the MK18 dominates." A bolt gun has no port to pop. Barrel
  length matters because a can on a 10.3" MK18 and the same can on a 20" bolt
  gun are not comparable numbers.

  Values are either stated in the report, or are facts about the named firearm
  — a Marlin 1895 is a lever action, a Volquartsen Summit is a bolt gun.
  `barrel_source` records which: `report` for 1010 runs, `model` for 69 where
  the report omits a length but names a gun with one published spec (the Sig
  P322's 4", the MP5K's 4.5"). A stated length is a measurement of the gun
  that fired; a looked-up one assumes TBAC used the stock configuration, and
  the tooltip says so.

  Where neither settles it the field is null rather than a guess. The largest
  gap is deliberate: `9mm-PS` is 73 runs, and the METE SFx ships with a 5.20"
  barrel while the SFx Pro has a 5.74" threaded one. TBAC needed threads to
  mount a can, which points at the Pro — but pointing is not knowing, so it
  stays null. `host_ammo` is tri-state for the same reason: 124gr 9mm sits on
  the transonic line, so it is "not stated" rather than called supersonic.

  Neither is an objective — you control for a barrel length, you do not
  minimise it — so both are `null` direction and putting one on an axis
  switches the frontier off.

  Codes were reused loosely: 2023's bare `5.56` is a 10.3" MK18 while 2024's
  `5.56-16AR` is a 16" DD, so attributes are per code and never assumed to
  carry across years.
* The unsuppressed reference is manufacturer `Bare Muzzle` in 2023 and `Bare`
  from 2024 on; `test_run.is_baseline` flags either. 2023 has two, 2025 three,
  and the 2026 table has none.
* PULSE fills the unused tail of its capture buffer with `Undefined`. 2024 ran
  the .22LR bolt gun with a 0.1 s capture into the same 0.5 s buffer, so 465
  records come back 104448 rows short by design. Those are stored at their real
  length and flagged as short captures, not as damage.
* Two genuine defects exist across all four archives, both in 2023:
  `Day1/AB/Raptor 10` has a directory literally named `XX Shot 4 did not
  record` whose files are entirely `Undefined`, and one Otter Creek `Hydrogen
  L` file is cut off at 127805 of 131072 rows with three byte-corrupted
  numbers in the tail. The truncation is past the analysis window, so that
  record is kept and flagged rather than dropped.
* Unparseable samples become NaN, never a guessed value; `waveform.defect_count`
  and `defects_json` record which. `analysis.fill_defects` interpolates runs of
  at most 8 samples (30 µs) and refuses anything longer.
* Names are entered by hand and are not normalised, within a year or across
  them: `Theorem S` / `Theorem-S`, `AEM5K` / `AEM5k`, `RXD910TI` / `RXD910Ti`,
  `Wraith Metalworks` (2025) / `Wraith Metal Works` (2026). Do not join on
  name without cleaning first.
* `waveform.overload` carries the DAQ's clipping flag. In 2025 it is set on
  exactly 15 records, all of them the unsuppressed .300 Win Mag baseline,
  which peaks near 10 kPa.

## Licence of the data

TBAC releases the numbers, the CSV and the PULSE waveform files for anyone to
use provided the data is footnoted as coming from that year's Silencer Summit.
The report prose and its graphs are copyright TBAC and are not redistributable.

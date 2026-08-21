-- Schema for TBAC Silencer Summit release sets.
--
-- Grain:
--   dataset            one summit year
--   test_run           one suppressor on one host/cartridge on one day
--   summary_metric     one run x mic, from the published all.csv
--   waveform           one run x mic x shot, from the PULSE release archive
--
-- All pressures are Pa, levels dB re 20 uPa, impulses Pa*ms, lengths inches,
-- weights ounces, times seconds.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS dataset (
    id              INTEGER PRIMARY KEY,
    year            INTEGER NOT NULL UNIQUE,
    name            TEXT    NOT NULL,
    report_url      TEXT,
    summary_csv     TEXT,           -- path of the all.csv that was ingested
    archive_name    TEXT,           -- filename of the release tarball
    archive_url     TEXT,           -- where it was fetched from
    archive_bytes   INTEGER,
    archive_sha256  TEXT,
    imported_at     TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS test_run (
    id               INTEGER PRIMARY KEY,
    dataset_id       INTEGER NOT NULL REFERENCES dataset(id) ON DELETE CASCADE,
    event_label      TEXT    NOT NULL,           -- raw: '20250818', or 2023's 'Day1'
    event_date       TEXT,                       -- ISO date; NULL for 2023
    manufacturer     TEXT    NOT NULL,
    suppressor       TEXT    NOT NULL,           -- name as published in all.csv
    caliber          TEXT    NOT NULL,           -- suppressor bore, e.g. '.30'
    cartridge        TEXT    NOT NULL,           -- cartridge + host, e.g. '.300BO-16BA'
    is_baseline      INTEGER NOT NULL DEFAULT 0, -- 1 for unsuppressed reference shots
    shots            INTEGER,                    -- shots averaged in the published row
    weight_oz        REAL,
    length_in        REAL,
    max_diameter_in  REAL,
    -- provenance / disagreements between the archive and the report
    archive_path     TEXT,                       -- run directory inside the tarball
    archive_suppressor TEXT,                     -- name in the directory, when it differs
    specs_name       TEXT,                       -- name line of Specs.txt
    specs_caliber    TEXT,                       -- free-text caliber line of Specs.txt
    note             TEXT,                       -- prefix on the spec filename, e.g. 'DNR'
    in_summary       INTEGER NOT NULL DEFAULT 0, -- 1 if the run appears in all.csv
    UNIQUE (dataset_id, event_label, manufacturer, suppressor, caliber, cartridge)
);

CREATE INDEX IF NOT EXISTS test_run_lookup
    ON test_run (dataset_id, manufacturer, suppressor);
CREATE INDEX IF NOT EXISTS test_run_host
    ON test_run (dataset_id, cartridge, caliber);

CREATE TABLE IF NOT EXISTS summary_metric (
    test_run_id       INTEGER NOT NULL REFERENCES test_run(id) ON DELETE CASCADE,
    mic               TEXT    NOT NULL,   -- 'ML' | 'MR' | 'SE'
    peak_pressure_pa  REAL,
    peak_db           REAL,
    peak_dba          REAL,
    impulse_pa_ms     REAL,
    impulse_db_ms     REAL,
    peak_leq10ms_dba  REAL,
    PRIMARY KEY (test_run_id, mic)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS waveform (
    id              INTEGER PRIMARY KEY,
    test_run_id     INTEGER NOT NULL REFERENCES test_run(id) ON DELETE CASCADE,
    mic             TEXT,                   -- NULL if the channel name is unrecognised
    signal          TEXT    NOT NULL,       -- PULSE channel name, e.g. 'Mil Left'
    shot            INTEGER NOT NULL,       -- 1..n, ordered by capture time
    excluded        INTEGER NOT NULL DEFAULT 0, -- a spare capture, not a published shot
    captured_at     TEXT,                   -- ISO timestamp from the PULSE header
    n_samples       INTEGER NOT NULL,
    sample_rate_hz  REAL    NOT NULL,
    t0_s            REAL    NOT NULL,       -- time of sample 0
    dt_s            REAL    NOT NULL,
    amplitude_unit  TEXT,
    db_reference    REAL,                   -- Pa for 0 dB, normally 2e-5
    input_range     REAL,
    overload        INTEGER,                -- DAQ overload flag, 1/0/NULL
    peak_pa         REAL,                   -- max(samples), for cheap filtering
    min_pa          REAL,
    defect_count    INTEGER NOT NULL DEFAULT 0, -- samples stored as NaN
    defects_json    TEXT,                   -- [[index, raw token], ...]
    archive_path    TEXT    NOT NULL,       -- file inside the tarball
    archive_aliases TEXT,                   -- other names for the same file (symlinks)
    header_json     TEXT    NOT NULL,       -- complete PULSE header
    tags_json       TEXT    NOT NULL,       -- complete PULSE footer tags
    codec           TEXT    NOT NULL,
    samples         BLOB    NOT NULL,
    UNIQUE (test_run_id, signal, shot)
);

CREATE INDEX IF NOT EXISTS waveform_by_run ON waveform (test_run_id, mic, shot);

-- Per-shot metrics recomputed from the waveforms by `python -m tbacss analyze`.
-- The published table only carries shot-averaged figures; these expose the
-- shot-to-shot spread, which is what makes a difference of a few tenths of a
-- dB between two suppressors interpretable.  Linear units, so they average the
-- way the reference code averages them.
-- The dB columns are nullable: a level is only defined for a positive linear
-- value.  33 very quiet records -- mostly .22LR -- integrate to exactly zero
-- impulse, because the reference method ends the impulse window at the trough
-- of the running integral and for those the trough is the first sample.  That
-- is TBAC's own behaviour (verify agrees with their published averages), so
-- the linear 0.0 is kept and the dB is left NULL rather than stored as -inf.
CREATE TABLE IF NOT EXISTS shot_metric (
    waveform_id     INTEGER PRIMARY KEY REFERENCES waveform(id) ON DELETE CASCADE,
    peak_pa         REAL NOT NULL,
    peak_a_pa       REAL NOT NULL,
    impulse_pa_ms   REAL NOT NULL,
    peak_leq_pa     REAL NOT NULL,
    peak_db         REAL,
    peak_dba        REAL,
    impulse_db_ms   REAL,
    peak_leq10ms_dba REAL
) WITHOUT ROWID;

-- One-third-octave band levels per waveform, from `python -m tbacss bands`.
-- TBAC publishes peak and A-weighted peak, which say how loud a shot is but
-- not what it sounds like; A-weighting discounts exactly the low frequencies
-- that make a suppressed shot feel heavy. Stored as a float32 array rather
-- than 30 rows per waveform, which would be 400k rows to say the same thing.
CREATE TABLE IF NOT EXISTS band_level (
    waveform_id INTEGER PRIMARY KEY REFERENCES waveform(id) ON DELETE CASCADE,
    n_bands     INTEGER NOT NULL,
    levels      BLOB    NOT NULL   -- little-endian float32, dB re 20 uPa
) WITHOUT ROWID;

-- Runs joined to their published numbers, one row per run per mic.
CREATE VIEW IF NOT EXISTS v_measurement AS
SELECT d.year,
       r.id AS test_run_id,
       r.event_label, r.event_date,
       r.manufacturer, r.suppressor, r.caliber, r.cartridge,
       r.is_baseline, r.shots, r.weight_oz, r.length_in, r.max_diameter_in,
       m.mic, m.peak_pressure_pa, m.peak_db, m.peak_dba,
       m.impulse_pa_ms, m.impulse_db_ms, m.peak_leq10ms_dba
FROM test_run r
JOIN dataset d ON d.id = r.dataset_id
JOIN summary_metric m ON m.test_run_id = r.id;

-- One row per run, pivoted across mics.  2023 ran ML/SE/225; 2024 onwards run
-- ML/MR/SE, so one of mr_* and p225_* is always null.  vol_cuin is TBAC's
-- "vol.m" column: the suppressor treated as a perfect cylinder.
CREATE VIEW IF NOT EXISTS v_run AS
SELECT d.year,
       r.id AS test_run_id,
       r.event_label, r.event_date,
       r.manufacturer, r.suppressor, r.caliber, r.cartridge,
       r.is_baseline, r.shots, r.weight_oz, r.length_in, r.max_diameter_in,
       0.785 * r.max_diameter_in * r.max_diameter_in * r.length_in AS vol_cuin,
       se.peak_db  AS se_peak_db,
       se.peak_dba AS se_peak_dba,
       se.impulse_db_ms AS se_impulse_db_ms,
       se.peak_leq10ms_dba AS se_peak_leq10ms_dba,
       ml.peak_db  AS ml_peak_db,
       ml.peak_dba AS ml_peak_dba,
       ml.impulse_db_ms AS ml_impulse_db_ms,
       ml.peak_leq10ms_dba AS ml_peak_leq10ms_dba,
       mr.peak_db  AS mr_peak_db,
       mr.peak_dba AS mr_peak_dba,
       p225.peak_db  AS p225_peak_db,
       p225.peak_dba AS p225_peak_dba,
       (SELECT COUNT(*) FROM waveform w WHERE w.test_run_id = r.id) AS waveform_count
FROM test_run r
JOIN dataset d ON d.id = r.dataset_id
LEFT JOIN summary_metric se ON se.test_run_id = r.id AND se.mic = 'SE'
LEFT JOIN summary_metric ml ON ml.test_run_id = r.id AND ml.mic = 'ML'
LEFT JOIN summary_metric mr ON mr.test_run_id = r.id AND mr.mic = 'MR'
LEFT JOIN summary_metric p225 ON p225.test_run_id = r.id AND p225.mic = '225';

-- Per-shot metrics with enough context to group and rank them.
CREATE VIEW IF NOT EXISTS v_shot AS
SELECT d.year,
       r.id AS test_run_id, w.id AS waveform_id,
       r.event_label, r.manufacturer, r.suppressor, r.caliber, r.cartridge,
       w.mic, w.shot, w.excluded, w.captured_at, w.overload,
       s.peak_pa, s.peak_db, s.peak_dba, s.impulse_pa_ms, s.impulse_db_ms,
       s.peak_leq10ms_dba
FROM waveform w
JOIN shot_metric s ON s.waveform_id = w.id
JOIN test_run r ON r.id = w.test_run_id
JOIN dataset d ON d.id = r.dataset_id;

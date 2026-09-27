"""Tests for the PULSE ASCII parser, against a synthetic fixture.

The fixture reproduces the quirks of the real exports: CRLF endings, latin-1
bytes in the header, ragged tab padding, values printed to six significant
figures, and the TagsBegin/TagsEnd footer.
"""

from __future__ import annotations

import datetime as dt

import numpy as np
import pytest

from tbacss.pulse import PulseParseError, parse_pulse

FS = 262144.0
DT = 3.8146973000e-06


def make_export(values, *, signal="Mil Left", date="8/18/2025", time="15:40:50:041"):
    header = [
        "Header Size:\t 79\t ",
        "Pulse Version:\t 80\t ",
        "Decimal Symbol:\t.\t ",
        "Data Type:\tReal\t ",
        "X-Axis type:\tLinear\t ",
        f"X-Axis size:\t{len(values)}\t ",
        "X-Axis unit:\ts\t ",
        "X-Axis first value:\t  0.0000000000e+00\t ",
        f"X-Axis delta:\t  {DT:.10e}\t ",
        "\t \t ",
        "AmplitudeUnit:\tPa\t ",
        "PowerUnit:\tPa\xb2\t ",  # the byte that makes the file non-UTF-8
        "dBReference:\t  2.0000000000e-05\t ",
        f"InputSampleFrequency:\t  {FS:.10e}\t ",
        "InputRange:\t  1.3477019929e+04\t ",
        f"Signal:\t{signal}\t ",
        "SignalUnit:\tPa\t ",
        f"Date:\t \t{date}",
        f"Time:\t \t{time}",
    ]
    body = [f"{i + 1}\t  {i * DT:.10e}\t {value: .5e}" for i, value in enumerate(values)]
    footer = [
        "TagsBegin:\t \t ",
        "OverLoad:\t \tFalse",
        "Overrun: []\t \t  0.00000e+00",
        "TagsEnd:\t \t ",
    ]
    return "\r\n".join(header + body + footer).encode("latin-1") + b"\r\n"


@pytest.fixture
def values():
    return [0.0954715, -0.106928, 255.787, -204.487, 1.5e-3]


def test_parses_header_and_samples(values):
    waveform = parse_pulse(make_export(values))
    assert waveform.signal == "Mil Left"
    assert waveform.amplitude_unit == "Pa"
    assert waveform.n_samples == len(values)
    assert waveform.sample_rate == pytest.approx(FS)
    assert waveform.dt == pytest.approx(DT)
    assert waveform.t0 == 0.0
    assert waveform.dB_reference == pytest.approx(2e-5)
    assert waveform.input_range == pytest.approx(1.3477019929e04)


def test_samples_round_trip_the_printed_text(values):
    """Six significant figures survive float32 exactly."""
    waveform = parse_pulse(make_export(values))
    np.testing.assert_allclose(waveform.samples, values, rtol=1e-6)
    assert waveform.samples.dtype == np.float32


def test_reads_the_tags_footer(values):
    waveform = parse_pulse(make_export(values))
    assert waveform.overload is False
    assert "Overrun: []" in waveform.tags
    # Structural markers are not tags.
    assert "TagsBegin" not in waveform.tags


def test_captured_at_parses_the_colon_before_milliseconds(values):
    waveform = parse_pulse(make_export(values))
    assert waveform.captured_at == dt.datetime(2025, 8, 18, 15, 40, 50, 41000)


def test_captured_at_is_none_when_absent(values):
    raw = make_export(values).replace(b"Date:\t \t8/18/2025\r\n", b"")
    assert parse_pulse(raw).captured_at is None


def test_times_are_reconstructed_from_the_header(values):
    waveform = parse_pulse(make_export(values))
    np.testing.assert_allclose(waveform.times(), np.arange(len(values)) * DT)


def test_with_samples_false_skips_the_data_block(values):
    waveform = parse_pulse(make_export(values), with_samples=False)
    assert waveform.n_samples == 0
    assert waveform.signal == "Mil Left"


def test_flags_an_inconsistent_index_column(values):
    raw = make_export(values).replace(f"{len(values)}\t  ".encode(), b"999999\t  ")
    waveform = parse_pulse(raw)
    assert waveform.index_inconsistent
    assert waveform.n_samples == len(values)


def test_tolerates_a_corrupted_index_in_the_tail(values):
    """The 2023 short file has byte damage in the index column too."""
    raw = make_export(values).replace(f"{len(values)}\t  ".encode(), b"\x0e1d58\t  ")
    waveform = parse_pulse(raw)
    assert waveform.index_inconsistent
    assert waveform.n_samples == len(values)


def test_rejects_a_data_block_that_does_not_start_at_one():
    raw = make_export([1.0, 2.0]).replace(b"\r\n1\t", b"\r\n7\t", 1)
    with pytest.raises(PulseParseError):
        parse_pulse(raw)


def test_undefined_samples_become_nan_and_are_reported(values):
    """PULSE writes 'Undefined' for a sample it could not export."""
    raw = make_export(values).replace(b" 2.55787e+02", b"Undefined")
    waveform = parse_pulse(raw)

    assert waveform.n_samples == len(values)
    assert np.isnan(waveform.samples[2])
    assert not np.isnan(waveform.samples[[0, 1, 3, 4]]).any()
    assert waveform.defects == ((2, "Undefined"),)


def test_byte_corrupted_numbers_become_nan(values):
    """Seen once in the 2023 set: '-1.6211"u+00' where '-1.62110e+00' was meant."""
    raw = make_export(values).replace(b"-1.06928e-01", b'-1.0692"u-01')
    waveform = parse_pulse(raw)

    assert np.isnan(waveform.samples[1])
    assert waveform.defects == ((1, '-1.0692"u-01'),)


def test_a_short_record_is_kept_and_flagged(values):
    """One 2023 file is cut off past the analysis window; the good part stays."""
    raw = make_export(values)
    # Claim more samples in the header than the body carries.
    raw = raw.replace(f"X-Axis size:\t{len(values)}\t".encode(), b"X-Axis size:\t131072\t")
    waveform = parse_pulse(raw)

    assert waveform.n_samples == len(values)
    assert waveform.declared_samples == 131072
    assert waveform.truncated


def test_a_complete_record_is_not_flagged_as_truncated(values):
    waveform = parse_pulse(make_export(values))
    assert not waveform.truncated
    assert not waveform.short_capture


def test_an_undefined_tail_is_a_short_capture_not_damage():
    """2024 ran .22LR with a 0.1 s capture into the 0.5 s buffer.

    PULSE fills the unused tail with 'Undefined'. Those rows are dropped and
    the record reports its real length rather than 80% defects.
    """
    captured = [0.5, -0.25, 300.0, 1.0]
    raw = make_export(captured + [0.0] * 200)
    for index in range(len(captured), len(captured) + 200):
        raw = raw.replace(
            f"\r\n{index + 1}\t  {index * DT:.10e}\t  0.00000e+00".encode(),
            f"\r\n{index + 1}\t  {index * DT:.10e}\tUndefined".encode(),
        )
    waveform = parse_pulse(raw)

    assert waveform.n_samples == len(captured)
    assert waveform.dropped_tail == 200
    assert waveform.short_capture
    assert not waveform.truncated  # captured + dropped accounts for the buffer
    # The dropped rows still carried an index, so the column is consistent.
    assert not waveform.index_inconsistent
    assert waveform.defects == ()
    assert not np.isnan(waveform.samples).any()


def test_a_short_undefined_run_is_still_a_defect():
    """Only a long trailing run is a buffer tail; a few are damage."""
    raw = make_export([1.0, 2.0, 3.0, 4.0])
    raw = raw.replace(b" 4.00000e+00", b"Undefined")
    waveform = parse_pulse(raw)

    assert waveform.dropped_tail == 0
    assert not waveform.short_capture
    assert waveform.defects == ((3, "Undefined"),)
    assert np.isnan(waveform.samples[3])


def test_rejects_a_file_with_no_data():
    with pytest.raises(PulseParseError):
        parse_pulse(b"Header Size:\t 79\t \r\nTagsBegin:\t \t \r\n")

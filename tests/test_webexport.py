"""Tests for the static web bundle."""

from __future__ import annotations

import json

import numpy as np
import pytest

from tbacss.webexport import _encode_text_column, _envelope, _quantize


def test_dictionary_encoding_preserves_first_seen_order():
    dictionary, codes = _encode_text_column(["TBAC", "FCA", "TBAC", "Banish"])
    assert dictionary == ["TBAC", "FCA", "Banish"]
    assert codes == [0, 1, 0, 2]


def test_dictionary_encoding_marks_nulls_with_minus_one():
    dictionary, codes = _encode_text_column(["TBAC", None, "TBAC"])
    assert dictionary == ["TBAC"]
    assert codes == [0, -1, 0]


def test_dictionary_round_trips_through_json():
    """The browser reads these straight out of JSON, so they must survive it."""
    dictionary, codes = _encode_text_column(["Knight's Armament Co", "B&T", None])
    decoded = json.loads(json.dumps({"d": dictionary, "c": codes}))
    assert [None if c < 0 else decoded["d"][c] for c in decoded["c"]] == [
        "Knight's Armament Co",
        "B&T",
        None,
    ]


def test_envelope_keeps_the_extremes():
    """Min/max decimation must not lose the peak -- that is the whole point."""
    window = np.zeros(4096, dtype=np.float32)
    window[1000] = 300.0  # the blast
    window[3000] = -120.0
    envelope = _envelope(window, 2048)

    assert envelope.size == 4096  # interleaved min, max
    assert envelope[1::2].max() == pytest.approx(300.0)
    assert envelope[0::2].min() == pytest.approx(-120.0)


def test_envelope_bucket_alignment():
    window = np.arange(4100, dtype=np.float32)
    envelope = _envelope(window, 2048)
    assert envelope.size == 4096
    # Bucket 0 spans samples 0 and 1.
    assert envelope[0] == pytest.approx(0.0)
    assert envelope[1] == pytest.approx(1.0)


def test_envelope_tiles_the_whole_record():
    """Buckets must cover every sample, including a tail that does not divide.

    A client has nothing to place a bucket in time with except the assumption
    that the buckets span the record.  An envelope covering only a round
    multiple of ``buckets`` therefore does not merely lose its tail: the rest
    gets drawn stretched across the full width, and every feature in it lands
    late.  32507 samples over 2048 buckets used to drop 1787 of them -- 6.8 ms
    -- and shift the blast about 2.8 ms to the right.
    """
    size = 32507  # a real record length; 32507 % 2048 == 1787
    window = np.arange(size, dtype=np.float64)
    envelope = _envelope(window, 2048)

    # The last bucket must reach the last sample.
    assert envelope[1::2].max() == pytest.approx(size - 1)
    # And the buckets must be contiguous: each one picks up where the last left
    # off, so no sample falls between two of them.
    lows, highs = envelope[0::2], envelope[1::2]
    assert lows[0] == pytest.approx(0.0)
    assert np.allclose(lows[1:], highs[:-1] + 1)


def test_envelope_refuses_a_record_it_cannot_fill():
    with pytest.raises(ValueError, match="cannot fill"):
        _envelope(np.zeros(100, dtype=np.float32), 2048)


def test_quantize_round_trips_within_one_step():
    values = np.array([0.0, 1.5, -300.25, 295.666], dtype=np.float32)
    payload, scale = _quantize(values)
    restored = np.frombuffer(payload, dtype="<i2").astype(np.float64) * scale
    np.testing.assert_allclose(restored, values, atol=scale)


def test_quantize_puts_the_peak_at_full_scale():
    values = np.array([0.0, 10.0, -3.0], dtype=np.float32)
    payload, scale = _quantize(values)
    codes = np.frombuffer(payload, dtype="<i2")
    assert abs(codes).max() == 32767
    assert 10.0 / scale == pytest.approx(32767, rel=1e-6)


def test_quantize_handles_an_all_zero_record():
    payload, scale = _quantize(np.zeros(8, dtype=np.float32))
    assert scale == 1.0
    assert set(np.frombuffer(payload, dtype="<i2")) == {0}

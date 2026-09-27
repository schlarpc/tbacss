"""Round-trip tests for the waveform frame codec."""

from __future__ import annotations

import numpy as np
import pytest

from tbacss import wavecodec


def quantised(window: np.ndarray, bits: int) -> np.ndarray:
    """What a lossless decode must return: the quantiser output, in Pa."""
    codes, scale = wavecodec.quantize(window.astype(np.float64), bits)
    return (codes.astype(np.float64) * scale).astype(np.float32)


@pytest.fixture
def blast():
    """A crude stand-in for a suppressed gunshot: transient then decay."""
    rng = np.random.default_rng(0)
    t = np.arange(20000)
    signal = np.zeros(t.size)
    signal[500:] = 300 * np.exp(-(t[500:] - 500) / 800) * np.sin(t[500:] / 9)
    signal += rng.normal(0, 0.05, t.size)  # noise floor
    return signal.astype(np.float32)


@pytest.mark.parametrize("bits", [16, 24])
def test_round_trip_is_exact(blast, bits):
    payload = wavecodec.encode(blast, bits=bits).payload
    np.testing.assert_array_equal(wavecodec.decode(payload), quantised(blast, bits))


@pytest.mark.parametrize("size", [3, 4, 100, 4096, 4097, 8193])
def test_round_trip_across_block_boundaries(size):
    rng = np.random.default_rng(size)
    window = np.cumsum(rng.normal(0, 1, size)).astype(np.float32)
    payload = wavecodec.encode(window, bits=16).payload
    np.testing.assert_array_equal(wavecodec.decode(payload), quantised(window, 16))


@pytest.mark.parametrize("order", [0, 1, 2, 3, 4])
def test_every_predictor_order_round_trips(blast, order):
    payload = wavecodec.encode(blast, bits=16, order=order).payload
    np.testing.assert_array_equal(wavecodec.decode(payload), quantised(blast, 16))


def test_beats_raw_int16_on_signal_like_data(blast):
    """The whole point: prediction plus Rice should roughly halve raw int16."""
    payload = wavecodec.encode(blast, bits=16).payload
    assert len(payload) / blast.size < 1.4


def test_a_constant_record_costs_almost_nothing():
    payload = wavecodec.encode(np.full(8192, 5.0, dtype=np.float32), bits=16).payload
    assert len(payload) / 8192 < 0.2


def test_an_all_zero_record_round_trips():
    zeros = np.zeros(1000, dtype=np.float32)
    payload = wavecodec.encode(zeros, bits=16).payload
    np.testing.assert_array_equal(wavecodec.decode(payload), zeros)


def test_scale_survives_as_float64():
    """A float32 scale would round and break bit-exact decoding."""
    window = np.array([1e-4, -3.7e-4, 2.2e-4] * 100, dtype=np.float32)
    encoded = wavecodec.encode(window, bits=24)
    np.testing.assert_array_equal(wavecodec.decode(encoded.payload), quantised(window, 24))


def test_rejects_a_foreign_frame():
    with pytest.raises(ValueError, match="not a tbacss waveform frame"):
        wavecodec.decode(b"NOPE" + bytes(32))


def test_rejects_an_unknown_version(blast):
    payload = bytearray(wavecodec.encode(blast, bits=16).payload)
    payload[4] = 99
    with pytest.raises(ValueError, match="unsupported frame version"):
        wavecodec.decode(bytes(payload))


def test_rejects_an_unsupported_bit_depth(blast):
    with pytest.raises(ValueError, match="bits must be"):
        wavecodec.encode(blast, bits=12)


def test_rejects_a_record_shorter_than_the_predictor():
    with pytest.raises(ValueError, match="shorter than the predictor"):
        wavecodec.encode(np.zeros(2, dtype=np.float32), bits=16, order=2)


def test_unary_runs_stay_bounded():
    """A quiet block with one huge outlier must not blow up the unary run."""
    window = np.zeros(8192, dtype=np.float32)
    window[4000] = 30000.0
    payload = wavecodec.encode(window, bits=16).payload
    np.testing.assert_array_equal(wavecodec.decode(payload), quantised(window, 16))

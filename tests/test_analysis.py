"""Tests for the ported analysis code."""

from __future__ import annotations

import numpy as np
import pytest
from scipy.signal import freqz

from tbacss.analysis import (
    FS,
    a_weighting,
    fill_defects,
    is_short_window,
    leq_fast,
)


@pytest.mark.parametrize(
    "frequency, expected_db",
    [
        # IEC 61672-1 class 1 weightings, tolerance is +-1 dB at these points.
        (31.5, -39.4),
        (125.0, -16.1),
        (1000.0, 0.0),
        (4000.0, 1.0),
        (8000.0, -1.1),
    ],
)
def test_a_weighting_matches_iec_61672(frequency, expected_db):
    b, a = a_weighting(FS)
    _, response = freqz(b, a, worN=[2 * np.pi * frequency / FS])
    assert 20 * np.log10(abs(response[0])) == pytest.approx(expected_db, abs=0.3)


def test_leq_fast_of_a_constant_is_that_constant():
    signal = np.full(int(FS * 0.1), 3.0)
    running = leq_fast(signal, FS)
    # Skip the first window, where the rectangular kernel is still filling.
    assert running[int(FS * 0.02) :].max() == pytest.approx(3.0, rel=1e-9)


@pytest.mark.parametrize(
    "cartridge, year, expected",
    [
        (".22LR-PS", 2025, True),
        (".22LR-PS", 2024, True),
        # 2023's process_string.m has no short-window branch at all.
        (".22LR-PS", 2023, False),
        (".300BO-16BA", 2025, False),
        (".22LR-BA", None, True),
    ],
)
def test_short_window_policy_is_year_dependent(cartridge, year, expected):
    assert is_short_window(cartridge, year) is expected


def test_fill_defects_interpolates_isolated_gaps():
    samples = np.array([1.0, 2.0, np.nan, 4.0, 5.0], dtype=np.float32)
    np.testing.assert_allclose(fill_defects(samples), [1, 2, 3, 4, 5])


def test_fill_defects_is_a_no_op_without_defects():
    samples = np.arange(10, dtype=np.float32)
    assert fill_defects(samples) is samples


def test_fill_defects_refuses_a_long_gap():
    samples = np.array([1.0] + [np.nan] * 9 + [11.0], dtype=np.float32)
    with pytest.raises(ValueError, match="longer than"):
        fill_defects(samples)


def test_fill_defects_refuses_gaps_at_the_edges():
    with pytest.raises(ValueError, match="edge"):
        fill_defects(np.array([np.nan, 1.0, 2.0], dtype=np.float32))

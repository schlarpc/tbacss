"""Tests for the derived run statistics."""

from __future__ import annotations

import pytest

from tbacss.derive import RunStats, indistinguishable, run_statistics


class FakeDB:
    """Just enough of SummitDB to drive run_statistics."""

    def __init__(self, rows):
        self._rows = rows

    def query(self, sql, params=()):
        return self._rows


def rows(*triples):
    return [
        {"test_run_id": run, "mic": mic, "shot": shot, "value": value}
        for run, mic, shot, value in triples
    ]


def test_mean_and_standard_error_over_five_shots():
    db = FakeDB(rows(*[(1, "SE", n, v) for n, v in enumerate([10, 12, 11, 13, 14], 1)]))
    stats = run_statistics(db)[(1, "SE")]
    assert stats.n == 5
    assert stats.mean == pytest.approx(12.0)
    assert stats.sd == pytest.approx(1.5811, abs=1e-3)
    # The published figure is a mean, so its error shrinks with sqrt(n).
    assert stats.sem == pytest.approx(1.5811 / 5**0.5, abs=1e-3)


def test_first_round_pop_is_shot_one_against_the_rest():
    db = FakeDB(rows((1, "SE", 1, 20.0), (1, "SE", 2, 10.0),
                     (1, "SE", 3, 10.0), (1, "SE", 4, 10.0)))
    assert run_statistics(db)[(1, "SE")].first_round_pop == pytest.approx(10.0)


def test_first_round_pop_needs_a_first_shot():
    """A run whose shot 1 is missing has no pop to report, rather than a wrong one."""
    db = FakeDB(rows((1, "SE", 2, 10.0), (1, "SE", 3, 12.0)))
    assert run_statistics(db)[(1, "SE")].first_round_pop is None


def test_a_single_shot_has_a_mean_but_no_spread():
    stats = run_statistics(FakeDB(rows((1, "SE", 1, 42.0))))[(1, "SE")]
    assert stats.mean == 42.0
    assert stats.sd is None and stats.sem is None and stats.first_round_pop is None


def test_run_statistics_rejects_an_unknown_metric():
    with pytest.raises(ValueError, match="unknown metric"):
        run_statistics(FakeDB([]), "loudness")


@pytest.mark.parametrize(
    "a, a_sem, b, b_sem, expected",
    [
        # The real case: ranks 2 and 3 of the quietest .223 cans.
        (138.14, 0.78, 138.40, 0.82, True),
        # A gap the measurement can carry.
        (137.01, 0.50, 142.00, 0.50, False),
        # Either side of the 2-sigma line, with room for float error. The
        # line itself is not worth asserting: 2*sqrt(0.5) is not exactly
        # representable, so the comparison there is a coin toss.
        (100.0, 0.5, 100.0 + 1.35, 0.5, True),
        (100.0, 0.5, 100.0 + 1.50, 0.5, False),
    ],
)
def test_indistinguishable(a, a_sem, b, b_sem, expected):
    assert indistinguishable(a, a_sem, b, b_sem) is expected


def test_no_error_means_no_claim_either_way():
    """Without a spread there is no basis to call two figures the same."""
    assert indistinguishable(100.0, None, 100.0, 0.5) is False

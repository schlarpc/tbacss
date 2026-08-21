"""Tests for the published data advisories."""

from __future__ import annotations

from tbacss.caveats import CAVEATS, caveats_for
from tbacss.hosts import HOSTS


def test_every_caveat_points_at_a_real_host():
    for caveat in CAVEATS:
        assert caveat.cartridge in HOSTS, caveat.cartridge
        assert caveat.severity in ("ignore", "note")
        assert caveat.mics
        assert caveat.summary and caveat.detail


def test_the_2024_rimfire_shooters_ear_advisory():
    """TBAC: "it is probably best to ignore the SE numbers for this run of .22's"."""
    found = caveats_for(2024, ".22LR-BA")
    assert len(found) == 1
    assert found[0].mics == ("SE",)
    assert found[0].severity == "ignore"


def test_the_advisory_is_scoped_to_its_year_and_host():
    # Same host, a year where the usual rifle was working.
    assert caveats_for(2023, ".22LR-BA") == ()
    # Same year, the pistol host rather than the bolt gun.
    assert caveats_for(2024, ".22LR-PS") == ()
    assert caveats_for(2025, ".300BO-16BA") == ()

"""Tests for the host attribute table."""

from __future__ import annotations

import pytest

from tbacss.hosts import CYCLING, HOSTS, PLATFORMS, host_description, host_label


def test_every_host_has_a_label_and_description():
    for code, host in HOSTS.items():
        assert host.label, code
        assert host.description, code


def test_attributes_use_the_declared_vocabularies():
    for code, host in HOSTS.items():
        assert host.cycling in (*CYCLING, None), code
        assert host.platform in (*PLATFORMS, None), code
        assert host.subsonic in (True, False, None), code


def test_barrel_lengths_are_plausible():
    """5 inches to 27: a 9mm AR pistol up to a .338 Lapua bolt gun."""
    for code, host in HOSTS.items():
        if host.barrel_in is not None:
            assert 4 <= host.barrel_in <= 30, code


@pytest.mark.parametrize(
    "code, cycling, barrel_in",
    [
        # Named guns pin these down: a Volquartsen Summit is a bolt action, an
        # AR-15 is self-loading, a Marlin 1895 is a lever gun.
        (".22LR-BA", "manual", 16.5),
        ("5.56-16AR", "semi", 16),
        (".45-70FP", "manual", 16),
        # 2023's bare "5.56" is a 10.3" MK18, not the 16" DD of later years.
        ("5.56", "semi", 10.3),
        (".300WM-BA", "manual", 26),
    ],
)
def test_known_hosts(code, cycling, barrel_in):
    assert HOSTS[code].cycling == cycling
    assert HOSTS[code].barrel_in == barrel_in


def test_an_undocumented_barrel_is_none_not_a_guess():
    """The report says only "W.T.F.'s .375 RUM" — no barrel, so no number."""
    assert HOSTS[".375RUM-BA"].barrel_in is None
    assert HOSTS[".375RUM-BA"].cycling == "manual"  # "-BA" and a bolt gun


def test_subsonic_is_tri_state():
    assert HOSTS[".300BO-16BA"].subsonic is True
    assert HOSTS["5.56-16AR"].subsonic is False
    # 124gr 9mm sits on the transonic line; the report does not resolve it.
    assert HOSTS["9mm"].subsonic is None


def test_the_hand_clap_has_no_gun_attributes():
    clap = HOSTS["hand"]
    assert clap.cycling is None
    assert clap.platform is None
    assert clap.barrel_in is None


def test_lookups_fall_back_to_the_code():
    assert host_label("NOT-A-HOST") == "NOT-A-HOST"
    assert host_description("NOT-A-HOST") is None
    assert host_label("5.56-16AR") == '5.56, 16" AR'

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


def test_barrel_source_matches_whether_there_is_a_barrel():
    for code, host in HOSTS.items():
        assert (host.barrel_in is None) == (host.barrel_source is None), code
        assert host.barrel_source in ("report", "model", None), code


def test_a_looked_up_barrel_is_marked_as_such():
    """The P322's 4" is the model's published spec, not TBAC's text."""
    assert HOSTS[".22LR-PS"].barrel_in == 4
    assert HOSTS[".22LR-PS"].barrel_source == "model"
    assert HOSTS["5.56-16AR"].barrel_source == "report"


def test_an_ambiguous_model_stays_unknown():
    """The METE SFx is 5.20" and the SFx Pro 5.74"; the report says neither.

    This is the largest barrel gap in the set (73 runs) and looking the model
    up does not close it -- TBAC needed a threaded barrel, which points at the
    Pro, but pointing is not the same as knowing.
    """
    assert HOSTS["9mm-PS"].barrel_in is None
    assert HOSTS["9mm-PS"].barrel_source is None


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


def test_labels_are_unique():
    """A label is all a filter list shows, so two hosts must never share one.

    2023's Staccato P on 124gr and 2024's Canik on 165gr subsonic were both
    "9mm pistol", and read 4-5 dB apart on the two cans shot on both.
    """
    labels = [host.label for host in HOSTS.values()]
    assert len(labels) == len(set(labels))

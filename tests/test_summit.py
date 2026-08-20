"""Tests for the release-set naming conventions and the summary CSV."""

from __future__ import annotations

import pytest

from tbacss.summit import (
    parse_event,
    parse_run_dir,
    parse_spec_filename,
    parse_specs,
    parse_waveform_filename,
    read_summary_csv,
    split_member_path,
)


@pytest.mark.parametrize(
    "path, suppressor, caliber, cartridge",
    [
        (
            "20250818/RR Weapons/Nixis 30K (.30 on .300BO-16BA)",
            "Nixis 30K",
            ".30",
            ".300BO-16BA",
        ),
        # No space before the paren -- happens in several 2025 directories.
        (
            "20250819/FCA/FX 556K-ss(.223 on 5.56-16AR)",
            "FX 556K-ss",
            ".223",
            "5.56-16AR",
        ),
        # Manufacturer with an apostrophe, model with a hyphen.
        (
            "20250819/Knight's Armament Co/556 DTS-1 (.223 on 5.56-16AR)",
            "556 DTS-1",
            ".223",
            "5.56-16AR",
        ),
    ],
)
def test_parse_run_dir(path, suppressor, caliber, cartridge):
    run = parse_run_dir(path)
    assert run.suppressor == suppressor
    assert run.caliber == caliber
    assert run.cartridge == cartridge
    assert run.event_date in ("2025-08-18", "2025-08-19")


def test_parse_run_dir_handles_the_2023_layout():
    run = parse_run_dir("2023_SUMMIT_RELEASE_SET/Day1/Resilient/Jolene (.30 on .308)")
    assert run.event_label == "Day1"
    assert run.event_date is None  # 2023 labelled days, not dates
    assert run.manufacturer == "Resilient"
    assert run.suppressor == "Jolene"
    assert run.cartridge == ".308"


@pytest.mark.parametrize(
    "label, expected_date",
    [("20250818", "2025-08-18"), ("Day1", None), ("Day3", None)],
)
def test_parse_event(label, expected_date):
    assert parse_event(label) == (label, expected_date)


@pytest.mark.parametrize(
    "path, run_dir, shot, filename",
    [
        # 2024/2025: flat, shot encoded in the filename suffix
        (
            "20250818/RR Weapons/Nixis 30K (.30 on .300BO-16BA)/Time Group_Expanded Time(Mil Left) - Input.3",
            "20250818/RR Weapons/Nixis 30K (.30 on .300BO-16BA)",
            None,
            "Time Group_Expanded Time(Mil Left) - Input.3",
        ),
        # 2023: wrapped in a release-set root, one directory per shot
        (
            "2023_SUMMIT_RELEASE_SET/Day1/Resilient/Jolene (.30 on .308)/Shot 4/Time Group_Expanded Time(225 Deg ASA) - Input.txt",
            "Day1/Resilient/Jolene (.30 on .308)",
            4,
            "Time Group_Expanded Time(225 Deg ASA) - Input.txt",
        ),
        (
            "2023_SUMMIT_RELEASE_SET/Day2/TBAC/Magnus CB (.30 on .308)/Shot 10/BKFiles.m",
            "Day2/TBAC/Magnus CB (.30 on .308)",
            10,
            "BKFiles.m",
        ),
    ],
)
def test_split_member_path(path, run_dir, shot, filename):
    assert split_member_path(path) == (run_dir, shot, filename)


@pytest.mark.parametrize(
    "path",
    [
        "20250818/RR Weapons/",  # a directory, not a file
        "20250818/RR Weapons/Nixis 30K (.30 on .300BO-16BA)/Nope/Input.txt",
        "top/level/file.txt/extra/deep/nope",
    ],
)
def test_split_member_path_rejects_other_shapes(path):
    assert split_member_path(path) is None


def test_parse_run_dir_flags_the_unsuppressed_baseline():
    run = parse_run_dir("20250818/Bare/26in 300WM BA (.30 on .300WM-BA)")
    assert run.is_baseline


def test_parse_run_dir_rejects_other_depths():
    assert parse_run_dir("20250818/RR Weapons") is None
    assert parse_run_dir("20250818/RR Weapons/no parens here") is None


@pytest.mark.parametrize(
    "name, signal, mic, suffix",
    [
        ("Time Group_Expanded Time(Mil Left) - Input.txt", "Mil Left", "ML", "txt"),
        ("Time Group_Expanded Time(Mil Right) - Input.3", "Mil Right", "MR", "3"),
        ("Time Group_Expanded Time(Right Ear) - Input.1", "Right Ear", "SE", "1"),
    ],
)
def test_parse_waveform_filename(name, signal, mic, suffix):
    parsed = parse_waveform_filename(name)
    assert (parsed.signal, parsed.mic, parsed.suffix) == (signal, mic, suffix)


def test_2023_third_mic_maps_to_225():
    parsed = parse_waveform_filename("Time Group_Expanded Time(225 Deg ASA) - Input.txt")
    assert parsed.signal == "225 Deg ASA"
    assert parsed.mic == "225"


def test_unknown_channel_has_no_mic_code():
    parsed = parse_waveform_filename("Time Group_Expanded Time(Left Ear) - Input.1")
    assert parsed.signal == "Left Ear"
    assert parsed.mic is None


@pytest.mark.parametrize(
    "name, note",
    [
        ("Specs.txt", None),
        ("Spec.txt", None),
        ("DNR Specs.txt", "DNR"),
        ("Did not Run Specs.txt", "Did not Run"),
        ("No Thread on Specs.txt", "No Thread on"),
    ],
)
def test_parse_spec_filename(name, note):
    assert parse_spec_filename(name) == note


def test_parse_spec_filename_rejects_other_files():
    assert parse_spec_filename("Time Group_Expanded Time(Mil Left) - Input.1") is False


def test_parse_specs_puts_length_before_weight():
    # Real file for RR Weapons' Nixis 30K; all.csv lists weight 14.2, len 5.63.
    specs = parse_specs("Nixis 30K\r\n5.63\r\n14.2\r\n.30\r\n1.6")
    assert specs.name == "Nixis 30K"
    assert specs.length_in == 5.63
    assert specs.weight_oz == 14.2
    assert specs.caliber == ".30"
    assert specs.max_diameter_in == 1.6


def test_parse_specs_tolerates_empty_and_short_files():
    assert parse_specs("").name is None
    short = parse_specs("Thing\r\n5.0")
    assert short.length_in == 5.0
    assert short.weight_oz is None


SUMMARY_CSV = """\
_EVENT_,_MFGR_,_SUPPRESSOR_,_CAL_,_CART_,ML,ML,ML,ML,ML,ML,SE,SE,SE,SE,SE,SE,
_EVENT_,_MFGR_,_SUPPRESSOR_,_CAL_,_CART_,PkPr,dB,dB(A),Im-Pa,Im-dB,Pk Leq,PkPr,dB,dB(A),Im-Pa,Im-dB,Pk Leq,shots,weight,len,maxdia
20250818,RR Weapons,"Nixis 30K",".30",".300BO-16BA",291.65,143.28,135.18,26.85,122.56,120.66,124.13,135.86,129.99,7.05,110.94,116.83,5,14.2,5.63,1.6
20250819,Bare,"Sig P322 Bare Muzzle",".22",".22LR-PS",1,2,3,4,5,6,7,8,9,10,11,12,5,,,
"""


def test_read_summary_csv(tmp_path):
    path = tmp_path / "all.csv"
    path.write_text(SUMMARY_CSV)
    rows = read_summary_csv(path)

    assert len(rows) == 2
    first = rows[0]
    assert first.event_date == "2025-08-18"
    assert first.suppressor == "Nixis 30K"
    assert first.shots == 5
    assert first.weight_oz == 14.2
    assert first.length_in == 5.63
    assert set(first.metrics) == {"ML", "SE"}
    assert first.metrics["ML"]["peak_pressure_pa"] == 291.65
    assert first.metrics["SE"]["peak_leq10ms_dba"] == 116.83


def test_read_summary_csv_leaves_missing_specs_as_none(tmp_path):
    path = tmp_path / "all.csv"
    path.write_text(SUMMARY_CSV)
    baseline = read_summary_csv(path)[1]
    assert baseline.weight_oz is None
    assert baseline.length_in is None
    assert baseline.max_diameter_in is None
    assert baseline.shots == 5


def test_read_summary_csv_rejects_an_unknown_metric(tmp_path):
    path = tmp_path / "all.csv"
    path.write_text(SUMMARY_CSV.replace("Pk Leq,shots", "Pk Bananas,shots"))
    with pytest.raises(ValueError, match="unknown metric"):
        read_summary_csv(path)

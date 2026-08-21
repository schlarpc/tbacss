"""What each host/cartridge code actually means, in machine-readable form.

The codes in ``_CART_`` (``.300BO-16BA``, ``9mmSTTH-MP5K``) are not explained
anywhere in ``all.csv`` -- they are prose in each year's report, under
"HOST/CARTRIDGE NOTES". This module is that prose parsed into attributes, so
the host stops being an opaque label and becomes something you can filter and
plot against.

Why these attributes and not others:

* ``barrel_in`` is the strongest confounder in the whole dataset. A can on a
  10.3" MK18 and the same can on a 20" bolt gun are not comparable numbers,
  and until now nothing in the data said so.
* ``cycling`` -- manual or self-loading -- is the other one. TBAC's own FAQ
  points at it: "suppressors shot on 5.56 will never have their peak less than
  the SS crack because the action noise ('port pop') on the MK18 dominates."
  A bolt gun has no port to pop.
* ``subsonic`` decides whether there is a supersonic crack in the trace at
  all, which is a different measurement problem from muzzle blast.

**Sourcing.** Every value is either stated in the report or is a fact about the
named firearm -- a Marlin 1895 is a lever action, an AR-15 is self-loading, a
Volquartsen Summit is a bolt gun. Where the report names no barrel length, or
no gun specific enough to pin one down, the field is ``None`` rather than a
guess: ``.375RUM-BA`` is "W.T.F.'s .375 RUM" and that is all anyone knows.

Codes were reused loosely across years -- 2023's bare ``5.56`` is a 10.3" MK18
while 2024's ``5.56-16AR`` is a 16" DD -- so the attributes are per code, and a
code is never assumed to carry across years without the report saying so.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass

__all__ = [
    "Host",
    "HOSTS",
    "CYCLING",
    "PLATFORMS",
    "host_label",
    "host_description",
    "host_attributes",
]

CYCLING = ("manual", "semi")
"""Manual (bolt, lever) or self-loading. The port-pop distinction."""

PLATFORMS = ("bolt", "AR", "pistol", "PCC", "lever", "rifle")


@dataclass(frozen=True)
class Host:
    """One host/cartridge combination, as the report describes it."""

    label: str
    description: str
    barrel_in: float | None = None
    # Where barrel_in came from: "report" if TBAC stated it, "model" if it is
    # the published spec of a firearm they named unambiguously. None when
    # barrel_in is None. The distinction is worth keeping -- a stated length is
    # a measurement of the gun that fired, a looked-up one assumes TBAC used
    # the stock configuration.
    barrel_source: str | None = None
    cycling: str | None = None
    platform: str | None = None
    integral: bool = False
    # True when the report says subsonic, False when the stated load is
    # unambiguously supersonic, None when it does not say enough. 124gr 9mm
    # sits right on the transonic line and the .50 Beowulf load is unstated,
    # so those are None rather than a guess in either direction.
    subsonic: bool | None = None
    grains: int | None = None


def _h(label, description, **kwargs) -> Host:
    return Host(label=label, description=description, **kwargs)


HOSTS: dict[str, Host] = {
    # -- standard hosts, 2024 onwards -------------------------------------
    "5.56-16AR": _h(
        '5.56, 16" AR', 'LC M193 55gr 5.56 from a Daniel Defense 16" AR-15',
        barrel_in=16, barrel_source="report", cycling="semi", platform="AR", grains=55,
        subsonic=False,
    ),
    ".308-20BA": _h(
        '.308, 20" bolt', 'M118LR 175gr from a 20" Accuracy International AX',
        barrel_in=20, barrel_source="report", cycling="manual", platform="bolt", grains=175,
        subsonic=False,
    ),
    ".300BO-16BA": _h(
        '.300 BLK subsonic, 16" bolt',
        '220gr subsonic Ammo Inc Stelth .300 Blackout from a 16" bolt action',
        barrel_in=16, barrel_source="report", cycling="manual", platform="bolt", subsonic=True, grains=220,
    ),
    ".300WM-BA": _h(
        '.300 Win Mag, 26" bolt',
        'Federal 150gr soft point .300 Win Mag from a 26" Savage 110',
        barrel_in=26, barrel_source="report", cycling="manual", platform="bolt", grains=150,
        subsonic=False,
    ),
    ".300BO-16AR-SUB": _h(
        '.300 BLK subsonic, 16" AR',
        '220gr subsonic Ammo Inc Stelth .300 Blackout from a Daniel Defense 16" AR',
        barrel_in=16, barrel_source="report", cycling="semi", platform="AR", subsonic=True, grains=220,
    ),
    # 73 runs, the largest hole in barrel_in, and it stays a hole on purpose:
    # the METE SFx ships with a 5.20" barrel and the SFx Pro with a 5.74"
    # threaded one, TBAC needed threads to mount a can, and they wrote only
    # "Canik METESFX". Picking one would be a guess dressed as a spec.
    "9mm-PS": _h(
        "9mm pistol", "Ammo Inc Stelth 165gr from a Canik METE SFX pistol",
        cycling="semi", platform="pistol", subsonic=True, grains=165,
    ),
    ".22LR-PS": _h(
        '.22 LR pistol, 4"', "CCI Standard Velocity from a Sig P322 pistol",
        barrel_in=4, barrel_source="model",
        cycling="semi", platform="pistol", subsonic=True,
    ),
    ".22LR-BA": _h(
        '.22 LR, 16.5" bolt',
        'CCI Standard Velocity from a 16.5" Volquartsen Summit bolt action',
        barrel_in=16.5, barrel_source="report", cycling="manual", platform="bolt", subsonic=True,
    ),
    "5.56-105AR": _h(
        '5.56, 10.5" AR', 'LC M193 55gr from a 10.5" AR',
        barrel_in=10.5, barrel_source="report", cycling="semi", platform="AR", grains=55,
        subsonic=False,
    ),
    "9mm-19X": _h(
        "9mm integral Glock",
        "Ammo Inc Stelth 165gr from an integrally-suppressed Glock 19X",
        cycling="semi", platform="pistol", integral=True, subsonic=True, grains=165,
    ),
    # -- 2023's codes, which name different guns -------------------------
    "5.56": _h(
        '5.56, 10.3" MK18',
        'LC M193 55gr from a Daniel Defense MK18 (10.3") with an H2 buffer',
        barrel_in=10.3, barrel_source="report", cycling="semi", platform="AR", grains=55,
        subsonic=False,
    ),
    ".308": _h(
        '.308, 20" bolt', 'LC M118LR 175gr from a 20" Accuracy International AXSA',
        barrel_in=20, barrel_source="report", cycling="manual", platform="bolt", grains=175,
        subsonic=False,
    ),
    ".338LM": _h(
        '.338 Lapua, 24" bolt', 'Hornady 285gr ELD from a 24" Barrett MRAD',
        barrel_in=24, barrel_source="report", cycling="manual", platform="bolt", grains=285,
        subsonic=False,
    ),
    "5.56-MK12": _h(
        '5.56, 18" MK12', 'LC M193 55gr from an 18" MK12 SPR clone',
        barrel_in=18, barrel_source="report", cycling="semi", platform="AR", grains=55,
        subsonic=False,
    ),
    "9mm": _h(
        "9mm pistol", "CCI Blazer Brass 124gr from a Staccato P",
        cycling="semi", platform="pistol", grains=124,
    ),
    "9mmSTTH": _h(
        "9mm subsonic pistol", "Ammo Inc Stelth 165gr from a Staccato P",
        cycling="semi", platform="pistol", subsonic=True, grains=165,
    ),
    "9mm-MP5K": _h(
        "9mm MP5K", "CCI Blazer Brass 124gr from an HK MP5K/SP5K",
        barrel_in=4.5, barrel_source="model",
        cycling="semi", platform="PCC", grains=124,
    ),
    "9mmSTTH-MP5K": _h(
        "9mm subsonic MP5K", "Ammo Inc Stelth 165gr from an HK MP5K/SP5K",
        barrel_in=4.5, barrel_source="model",
        cycling="semi", platform="PCC", subsonic=True, grains=165,
    ),
    "9mm-CZ": _h(
        "9mm Scorpion", "CCI Blazer Brass 124gr from a CZ Scorpion",
        cycling="semi", platform="PCC", grains=124,
    ),
    "9mmSTTH-CZ": _h(
        "9mm subsonic Scorpion", "Ammo Inc Stelth 165gr from a CZ Scorpion",
        cycling="semi", platform="PCC", subsonic=True, grains=165,
    ),
    ".45-70FP": _h(
        '.45-70, 16" lever',
        'Hornady LEVERevolution 325gr FTX from a Marlin 1895, 16" barrel',
        barrel_in=16, barrel_source="report", cycling="manual", platform="lever", grains=325,
        subsonic=False,
    ),
    ".45-70SUB": _h(
        '.45-70 subsonic, 16" lever',
        'Defiant Munitions 400gr TCX-S subsonic from a Marlin 1895, 16" barrel',
        barrel_in=16, barrel_source="report", cycling="manual", platform="lever", subsonic=True, grains=400,
    ),
    "hand": _h(
        "a hand clap", "the sound of a hand clap, recorded as a reference",
    ),
    # -- non-standard hosts, mostly maker-supplied -------------------------
    ".22LR-Integral-SA": _h(
        ".22 LR integral rifle", "Innovative Arms' integrally-suppressed .22 rifle",
        cycling="semi", platform="rifle", integral=True, subsonic=True,
    ),
    "5.56-11.5AR": _h(
        '5.56, 11.5" AR', "Allen Engineering's 11.5\" AR",
        barrel_in=11.5, barrel_source="report", cycling="semi", platform="AR", grains=55,
        subsonic=False,
    ),
    "5.56-12.5AR": _h(
        '5.56, 12.5" AR', "Allen Engineering's 12.5\" AR",
        barrel_in=12.5, barrel_source="report", cycling="semi", platform="AR", grains=55,
        subsonic=False,
    ),
    "5.56-14.5AR": _h(
        '5.56, 14.5" AR', "Allen Engineering's 14.5\" AR",
        barrel_in=14.5, barrel_source="report", cycling="semi", platform="AR", grains=55,
        subsonic=False,
    ),
    "5.56-AE12.5AR": _h(
        '5.56, 12.5" AE AR', "Allen Engineering's 12.5\" AR",
        barrel_in=12.5, barrel_source="report", cycling="semi", platform="AR", grains=55,
        subsonic=False,
    ),
    "5.56-AE18AR": _h(
        '5.56, 18" AE AR', "Allen Engineering's 18\" AR",
        barrel_in=18, barrel_source="report", cycling="semi", platform="AR", grains=55,
        subsonic=False,
    ),
    "5.56-MK12AR": _h(
        "5.56, B&T MK12", "B&T's MK12",
        cycling="semi", platform="AR", grains=55,
        subsonic=False,
    ),
    "13.7-5.56-Infidel": _h(
        '5.56, 13.7" Infidel', 'a 13.7" Noveske Infidel AR',
        barrel_in=13.7, barrel_source="report", cycling="semi", platform="AR", grains=55,
        subsonic=False,
    ),
    "6.5GREN-20AR": _h(
        '6.5 Grendel, 20" AR', "W.T.F.'s 20\" 6.5 Grendel AR",
        barrel_in=20, barrel_source="report", cycling="semi", platform="AR",
        subsonic=False,
    ),
    "6ARC-16AR": _h(
        '6mm ARC, 16" AR', "Allen Engineering's 16\" 6mm ARC AR",
        barrel_in=16, barrel_source="report", cycling="semi", platform="AR",
        subsonic=False,
    ),
    "6CM-BA": _h(
        "6mm Creedmoor bolt", "a 6mm Creedmoor bolt action",
        cycling="manual", platform="bolt",
        subsonic=False,
    ),
    "7-08": _h(
        "7mm-08 integral rifle", "Ecco's integrally-suppressed 7mm-08 rifle",
        platform="rifle", integral=True,
        subsonic=False,
    ),
    ".300BO-RAT-110": _h(
        ".300 BLK Rattler, 110gr", "a Sig Rattler shooting 110gr Barnes",
        cycling="semi", platform="AR", grains=110,
        subsonic=False,
    ),
    ".300BO-RAT-220": _h(
        ".300 BLK Rattler, subsonic", "a Sig Rattler shooting 220gr subsonic",
        cycling="semi", platform="AR", subsonic=True, grains=220,
    ),
    ".300BO-SUBS-Integral": _h(
        ".300 BLK integral rifle", "B&T's integrally-suppressed rifle",
        platform="rifle", integral=True, subsonic=True,
    ),
    ".308-24BA": _h(
        '.308, 24" B&T', "B&T's 24\" .308 shooting M118LR",
        barrel_in=24, barrel_source="report", cycling="manual", platform="bolt", grains=175,
        subsonic=False,
    ),
    ".338LM-26BA": _h(
        '.338 Lapua, 26" MRAD', 'Hornady 285gr ELD from a 26" Barrett MRAD',
        barrel_in=26, barrel_source="report", cycling="manual", platform="bolt", grains=285,
        subsonic=False,
    ),
    ".338LM-SAKO": _h(
        '.338 Lapua, 27" Sako',
        'Sako 250gr from a 27" Sako TRG M10, provided by Elite Iron',
        barrel_in=27, barrel_source="report", cycling="manual", platform="bolt", grains=250,
        subsonic=False,
    ),
    ".375RUM-BA": _h(
        ".375 RUM bolt", "W.T.F.'s .375 RUM",
        cycling="manual", platform="bolt",
        subsonic=False,
    ),
    ".500SW-SUB": _h(
        ".500 S&W subsonic lever", "W.T.F.'s .500 S&W lever action shooting subsonic",
        cycling="manual", platform="lever", subsonic=True,
    ),
    ".50Beowolf-SA": _h(
        ".50 Beowulf semi-auto", "a .50 Beowulf semi-automatic",
        cycling="semi", platform="AR",
    ),
    ".50BW-SUB-10.5AR": _h(
        '.50 Beowulf subsonic, 10.5" AR', 'subsonic .50 Beowulf from a 10.5" AR',
        barrel_in=10.5, barrel_source="report", cycling="semi", platform="AR", subsonic=True,
    ),
    "5.7-PS": _h(
        "5.7 pistol", "Ecco's Caracal 5.7 pistol",
        cycling="semi", platform="pistol",
        subsonic=False,
    ),
    "APC9-SUB": _h(
        "9mm subsonic APC9", "B&T's APC9 shooting 165gr subsonic",
        cycling="semi", platform="PCC", subsonic=True, grains=165,
    ),
    "MP9-SUB": _h(
        "9mm subsonic MP9", "B&T's MP9 shooting 165gr subsonic",
        cycling="semi", platform="PCC", subsonic=True, grains=165,
    ),
    "9mm-EI-PCC": _h(
        '9mm, 8.5" AR9', 'an 8.5" AR9 provided by Elite Iron, Ammo Inc Stelth 165gr',
        barrel_in=8.5, barrel_source="report", cycling="semi", platform="PCC", subsonic=True, grains=165,
    ),
    "9mm-5AR": _h(
        '9mm, 5" AR9', 'a 5" AR9',
        barrel_in=5, barrel_source="report", cycling="semi", platform="PCC",
    ),
    "10mm-SUB-Stribog": _h(
        "10mm subsonic Stribog", "a Grand Power Stribog shooting subsonic 10mm",
        cycling="semi", platform="PCC", subsonic=True,
    ),
    "Berretta-32Auto": _h(
        ".32 ACP Beretta", "a Beretta .32 Auto pistol",
        cycling="semi", platform="pistol", subsonic=True,
    ),
}


def host_label(code: str) -> str:
    """Short human name, falling back to the code when it is not documented."""
    host = HOSTS.get(code)
    return host.label if host else code


def host_description(code: str) -> str | None:
    """TBAC's own wording for the gun and ammunition, if the report gave one."""
    host = HOSTS.get(code)
    return host.description if host else None


def host_attributes(code: str) -> dict:
    """Every field as a plain dict, for serialising into the bundle."""
    host = HOSTS.get(code)
    return asdict(host) if host else {}

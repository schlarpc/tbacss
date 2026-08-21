"""What each host/cartridge code actually means.

The codes in ``_CART_`` (``.300BO-16BA``, ``9mmSTTH-MP5K``) are not explained
anywhere in ``all.csv`` -- they are prose in each year's report, under
"HOST/CARTRIDGE NOTES". This module is that prose, transcribed, so a reader
never has to decode ``.50BW-SUB-10.5AR`` themselves.

Each entry is ``(label, description)``:

* ``label`` is a short human name, for a filter row or an axis tick.
* ``description`` is TBAC's own wording: the gun and the ammunition.

Codes were reused loosely across years -- 2023's bare ``5.56`` is a 10.3" MK18
while 2024's ``5.56-16AR`` is a 16" DD, and both appear in the combined data --
so a code is never assumed to mean the same thing across years without the
report saying so. Where TBAC's own text is a typo ("specual", "Beowolf",
"Berretta") the label is spelled correctly and the description is left as
written.
"""

from __future__ import annotations

__all__ = ["HOSTS", "host_label", "host_description"]

HOSTS: dict[str, tuple[str, str]] = {
    # -- standard hosts, 2024 onwards -------------------------------------
    "5.56-16AR": (
        '5.56, 16" AR',
        'LC M193 55gr 5.56 from a Daniel Defense 16" AR-15',
    ),
    ".308-20BA": (
        '.308, 20" bolt',
        'M118LR 175gr from a 20" Accuracy International AX',
    ),
    ".300BO-16BA": (
        '.300 BLK subsonic, 16" bolt',
        '220gr subsonic Ammo Inc Stelth .300 Blackout from a 16" bolt action',
    ),
    ".300WM-BA": (
        '.300 Win Mag, 26" bolt',
        'Federal 150gr soft point .300 Win Mag from a 26" Savage 110',
    ),
    ".300BO-16AR-SUB": (
        '.300 BLK subsonic, 16" AR',
        '220gr subsonic Ammo Inc Stelth .300 Blackout from a Daniel Defense 16" AR',
    ),
    "9mm-PS": (
        "9mm pistol",
        "Ammo Inc Stelth 165gr from a Canik METE SFX pistol",
    ),
    ".22LR-PS": (".22 LR pistol", "CCI Standard Velocity from a Sig P322 pistol"),
    ".22LR-BA": (
        '.22 LR, 16.5" bolt',
        'CCI Standard Velocity from a 16.5" Volquartsen Summit bolt action',
    ),
    "5.56-105AR": ('5.56, 10.5" AR', 'LC M193 55gr from a 10.5" AR'),
    "9mm-19X": (
        "9mm integral Glock",
        "Ammo Inc Stelth 165gr from an integrally-suppressed Glock 19X",
    ),
    # -- 2023's codes, which name different guns -------------------------
    "5.56": ('5.56, 10.3" MK18', 'LC M193 55gr from a Daniel Defense MK18 (10.3") with an H2 buffer'),
    ".308": ('.308, 20" bolt', 'LC M118LR 175gr from a 20" Accuracy International AXSA'),
    ".338LM": ('.338 Lapua, 24" bolt', 'Hornady 285gr ELD from a 24" Barrett MRAD'),
    "5.56-MK12": ('5.56, 18" MK12', 'LC M193 55gr from an 18" MK12 SPR clone'),
    "9mm": ("9mm pistol", "CCI Blazer Brass 124gr from a Staccato P"),
    "9mmSTTH": ("9mm subsonic pistol", "Ammo Inc Stelth 165gr from a Staccato P"),
    "9mm-MP5K": ("9mm MP5K", "CCI Blazer Brass 124gr from an HK MP5K/SP5K"),
    "9mmSTTH-MP5K": ("9mm subsonic MP5K", "Ammo Inc Stelth 165gr from an HK MP5K/SP5K"),
    "9mm-CZ": ("9mm Scorpion", "CCI Blazer Brass 124gr from a CZ Scorpion"),
    "9mmSTTH-CZ": ("9mm subsonic Scorpion", "Ammo Inc Stelth 165gr from a CZ Scorpion"),
    ".45-70FP": (
        '.45-70, 16" lever',
        'Hornady LEVERevolution 325gr FTX from a Marlin 1895, 16" barrel',
    ),
    ".45-70SUB": (
        '.45-70 subsonic, 16" lever',
        'Defiant Munitions 400gr TCX-S subsonic from a Marlin 1895, 16" barrel',
    ),
    "hand": ("a hand clap", "the sound of a hand clap, recorded as a reference"),
    # -- non-standard hosts, mostly maker-supplied -------------------------
    ".22LR-Integral-SA": (
        ".22 LR integral rifle",
        "Innovative Arms' integrally-suppressed .22 rifle",
    ),
    "5.56-11.5AR": ('5.56, 11.5" AR', "Allen Engineering's 11.5\" AR"),
    "5.56-12.5AR": ('5.56, 12.5" AR', "Allen Engineering's 12.5\" AR"),
    "5.56-14.5AR": ('5.56, 14.5" AR', "Allen Engineering's 14.5\" AR"),
    "5.56-AE12.5AR": ('5.56, 12.5" AE AR', "Allen Engineering's 12.5\" AR"),
    "5.56-AE18AR": ('5.56, 18" AE AR', "Allen Engineering's 18\" AR"),
    "5.56-MK12AR": ("5.56, B&T MK12", "B&T's MK12"),
    "13.7-5.56-Infidel": ('5.56, 13.7" Infidel', 'a 13.7" Noveske Infidel AR'),
    "6.5GREN-20AR": ('6.5 Grendel, 20" AR', "W.T.F.'s 20\" 6.5 Grendel AR"),
    "6ARC-16AR": ('6mm ARC, 16" AR', "Allen Engineering's 16\" 6mm ARC AR"),
    "6CM-BA": ("6mm Creedmoor bolt", "a 6mm Creedmoor bolt action"),
    "7-08": ("7mm-08 integral rifle", "Ecco's integrally-suppressed 7mm-08 rifle"),
    ".300BO-RAT-110": (".300 BLK Rattler, 110gr", "a Sig Rattler shooting 110gr Barnes"),
    ".300BO-RAT-220": (
        ".300 BLK Rattler, subsonic",
        "a Sig Rattler shooting 220gr subsonic",
    ),
    ".300BO-SUBS-Integral": (
        ".300 BLK integral rifle",
        "B&T's integrally-suppressed rifle",
    ),
    ".308-24BA": ('.308, 24" B&T', "B&T's 24\" .308 shooting M118LR"),
    ".338LM-26BA": ('.338 Lapua, 26" MRAD', 'Hornady 285gr ELD from a 26" Barrett MRAD'),
    ".338LM-SAKO": (
        '.338 Lapua, 27" Sako',
        'Sako 250gr from a 27" Sako TRG M10, provided by Elite Iron',
    ),
    ".375RUM-BA": (".375 RUM bolt", "W.T.F.'s .375 RUM"),
    ".500SW-SUB": (
        ".500 S&W subsonic lever",
        "W.T.F.'s .500 S&W lever action shooting subsonic",
    ),
    ".50Beowolf-SA": (".50 Beowulf semi-auto", "a .50 Beowulf semi-automatic"),
    ".50BW-SUB-10.5AR": (
        '.50 Beowulf subsonic, 10.5" AR',
        'subsonic .50 Beowulf from a 10.5" AR',
    ),
    "5.7-PS": ("5.7 pistol", "Ecco's Caracal 5.7 pistol"),
    "APC9-SUB": ("9mm subsonic APC9", "B&T's APC9 shooting 165gr subsonic"),
    "MP9-SUB": ("9mm subsonic MP9", "B&T's MP9 shooting 165gr subsonic"),
    "9mm-EI-PCC": (
        '9mm, 8.5" AR9',
        'an 8.5" AR9 provided by Elite Iron, Ammo Inc Stelth 165gr',
    ),
    "9mm-5AR": ('9mm, 5" AR9', 'a 5" AR9'),
    "10mm-SUB-Stribog": (
        "10mm subsonic Stribog",
        "a Grand Power Stribog shooting subsonic 10mm",
    ),
    "Berretta-32Auto": (".32 ACP Beretta", "a Beretta .32 Auto pistol"),
}


def host_label(code: str) -> str:
    """Short human name, falling back to the code when it is not documented."""
    entry = HOSTS.get(code)
    return entry[0] if entry else code


def host_description(code: str) -> str | None:
    """TBAC's own wording for the gun and ammunition, if the report gave one."""
    entry = HOSTS.get(code)
    return entry[1] if entry else None

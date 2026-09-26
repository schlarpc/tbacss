"""Data advisories TBAC published alongside the numbers.

Some measurements come with a warning attached, and the warning lives in the
report prose rather than in ``all.csv``. A reader who only has the CSV -- or a
tool built on it -- will happily rank suppressors on numbers TBAC themselves
say to disregard.

Found by grepping all four reports for advisory language; there is exactly one
substantive entry so far. The rest of what turned up was the boilerplate
"typos are possible" line that every year carries.

Everything here is a warning *TBAC* wrote. Errors we found ourselves, which
they did not flag, do not belong in this table --
:data:`tbacss.summit.SPEC_DEFECTS` holds those.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass

__all__ = ["Caveat", "CAVEATS", "caveats_for"]


@dataclass(frozen=True)
class Caveat:
    """A warning that applies to some slice of the published numbers."""

    year: int
    cartridge: str
    #: Mic codes the warning applies to; other mics on the same run are fine.
    mics: tuple[str, ...]
    #: "ignore" when TBAC says not to use the numbers, "note" for lesser things.
    severity: str
    summary: str
    detail: str


CAVEATS: tuple[Caveat, ...] = (
    Caveat(
        year=2024,
        cartridge=".22LR-BA",
        mics=("SE",),
        severity="ignore",
        summary="Shooter's-ear numbers are compromised by a rifle harmonic",
        detail=(
            "A last-minute rifle malfunction forced a switch to a Volquartsen "
            "Summit .22 for this host. It rings at just before 0.048 s, on "
            "roughly half the shots, and only at the shooter's-ear mic. TBAC's "
            "own example: the El Jefe and Abel PI have near-identical mil-left "
            "and mil-right figures but differ by 3.5 dBA at the ear, entirely "
            "because of the harmonic. Their advice is that \"it is probably "
            "best to ignore the SE numbers for this run of .22's\". The muzzle "
            "mics are unaffected."
        ),
    ),
)


def caveats_for(year: int, cartridge: str) -> tuple[Caveat, ...]:
    """Every caveat that applies to a run, which is usually none."""
    return tuple(
        c for c in CAVEATS if c.year == year and c.cartridge == cartridge
    )


def as_dicts() -> list[dict]:
    return [asdict(c) for c in CAVEATS]

"""Which runs are the same suppressor.

``all.csv`` names a can by maker and model as typed that year, and the typing
drifts: "Hydrogen L" in 2023 and 2025 is "Hydrogen-L" in 2024, and SilencerCo
appears as both "SilencerCo" and "Silencer Co". A tool that groups on the raw
strings splits one can into several and undercounts where it was tested.

Two rules put them back together:

* **Makers** go through :data:`MAKER_ALIASES`, a hand-checked table. Maker names
  differ by more than punctuation -- "YHM" is "Yankee Hill Machine" -- so no
  string rule is safe, and every entry was checked against the rest of the
  maker list.
* **Models** compare with case and punctuation dropped. That merges
  "Hydrogen L" and "Hydrogen-L" and keeps "Nomad LTI XC" apart from
  "Nomad TI XC", which really are different cans.

The raw strings stay in the catalog; this only adds a key to group on.
"""

from __future__ import annotations

import re
from collections import Counter
from collections.abc import Iterable

__all__ = ["MAKER_ALIASES", "can_key", "canonical_maker", "display_names"]

#: Spelling found in all.csv -> the one name used for grouping and display.
MAKER_ALIASES: dict[str, str] = {
    "Banish Suppressors": "Banish",
    "Bare": "Bare Muzzle",
    "C.A.T": "CAT",
    "ECCO": "Ecco Machine",
    "Energetic": "Energetic Armament",
    "Griffin": "Griffin Armament",
    "Q LLC": "Q",
    "Sig": "Sig Sauer",
    "Silencer Co": "SilencerCo",
    "Wraith Metal Works": "Wraith Metalworks",
    "Yankee Hill": "Yankee Hill Machine",
    "YHM": "Yankee Hill Machine",
}


def canonical_maker(maker: str) -> str:
    """The maker's name as grouped and shown."""
    return MAKER_ALIASES.get(maker.strip(), maker.strip())


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def can_key(maker: str, model: str) -> str:
    """A stable id for one suppressor, e.g. ``otter-creek-labs/hydrogenl``.

    URL-safe, so it can go straight into a link to the can's page.
    """
    return f"{_slug(canonical_maker(maker))}/{re.sub(r'[^a-z0-9]', '', model.lower())}"


def display_names(runs: Iterable[tuple[str, str, int]]) -> dict[str, dict[str, str]]:
    """``can_key -> {"maker", "model"}`` from ``(maker, model, year)`` rows.

    The model is shown as it was most often written, and on a tie as the most
    recent year wrote it -- the maker's current spelling, as far as TBAC knew.
    """
    spellings: dict[str, Counter[str]] = {}
    latest: dict[tuple[str, str], int] = {}
    makers: dict[str, str] = {}
    for maker, model, year in runs:
        key = can_key(maker, model)
        makers[key] = canonical_maker(maker)
        spellings.setdefault(key, Counter())[model.strip()] += 1
        latest[key, model.strip()] = max(year, latest.get((key, model.strip()), year))
    return {
        key: {
            "maker": makers[key],
            "model": max(counts, key=lambda m: (counts[m], latest[key, m])),
        }
        for key, counts in spellings.items()
    }

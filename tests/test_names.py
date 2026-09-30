from tbacss.names import MAKER_ALIASES, can_key, canonical_maker, display_names


def test_punctuation_in_a_model_does_not_split_a_can():
    assert can_key("Otter Creek Labs", "Hydrogen L") == can_key("Otter Creek Labs", "Hydrogen-L")


def test_different_models_stay_apart():
    assert can_key("Dead Air", "Nomad LTI XC") != can_key("Dead Air", "Nomad TI XC")


def test_maker_spellings_are_merged():
    assert can_key("Silencer Co", "Omega 9k") == can_key("SilencerCo", "Omega 9k")
    assert can_key("YHM", "R9") == can_key("Yankee Hill Machine", "R9")


def test_an_unknown_maker_passes_through():
    assert canonical_maker("TBAC") == "TBAC"


def test_aliases_point_at_names_that_are_not_themselves_aliases():
    """A chain would make the result depend on lookup order."""
    assert not set(MAKER_ALIASES.values()) & set(MAKER_ALIASES)


def test_key_is_url_safe():
    assert can_key("W.T.F. Silencers", "The Jackalope") == "w-t-f-silencers/thejackalope"


def test_display_name_is_the_common_spelling_then_the_latest():
    names = display_names(
        [
            ("Otter Creek Labs", "Hydrogen L", 2023),
            ("Otter Creek Labs", "Hydrogen-L", 2024),
            ("Otter Creek Labs", "Hydrogen L", 2025),
            ("Silencer Co", "Velos", 2024),
            ("SilencerCo", "VELOS", 2026),
        ]
    )
    assert names["otter-creek-labs/hydrogenl"] == {
        "maker": "Otter Creek Labs",
        "model": "Hydrogen L",
    }
    assert names["silencerco/velos"] == {"maker": "SilencerCo", "model": "VELOS"}

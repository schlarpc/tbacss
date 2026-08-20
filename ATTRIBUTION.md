# Attribution

The measurement data in this repository — the `summit*/all.csv` tables, and
everything derived from them or from the PULSE release archives — comes from
the **TBAC Silencer Summit**, run by
[Thunder Beast Arms Corporation](https://thunderbeastarms.com/sound/consolidated/).

TBAC's terms, from each year's report:

> The raw data itself, that is, the numbers in the above tables, the CSV file,
> and PULSE-generated waveform file (".txt") are available for anyone to use,
> provided that the data is footnoted to have come from the &lt;year&gt; SILENCER
> SUMMIT.

So anything you publish from this data needs a footnote naming the year it
came from. Every row carries its year, and `v_run` / `v_measurement` expose it,
so the right footnote is always derivable from the rows you used:

```sql
SELECT DISTINCT year FROM v_measurement WHERE /* your filter */;
```

Suggested wording for a single year:

> Sound data from the 2025 TBAC Silencer Summit.

and across several:

> Sound data from the 2023–2026 TBAC Silencer Summits, Thunder Beast Arms
> Corporation.

The static bundle written by `python -m tbacss publish` carries the year and
report URL for each dataset in `catalog.json` under `datasets`, so a viewer can
render the footnote itself rather than relying on whoever deployed it.

## What is *not* covered

The report prose, its figures, and the plots on each year's results page are
"© COPYRIGHT &lt;year&gt; THUNDER BEAST ARMS CORPORATION (TBAC), ALL RIGHTS
RESERVED, and may not be reproduced without written permission from TBAC."
That is why `summit*/index.html` is fetched rather than tracked, and why
nothing here republishes TBAC's own graphs.

The Octave TBAC links from each report carries the same reservation, so it is
fetched into `reference/` by `scripts/fetch_sources.sh` rather than vendored
here. Nothing in the build reads it: `tbacss/analysis.py` is an independent
port of the method the reports document, and `python -m tbacss verify` is what
demonstrates the port agrees with TBAC's published numbers.

## This code

The code in this repository is separate from the data and carries no claim over
it.

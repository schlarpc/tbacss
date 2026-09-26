#!/usr/bin/env bash
# Upload the web bundle as a GitHub release and pin the site to it.
#
#   python -m tbacss publish tbacss.db web/data
#   scripts/release_data.sh            # creates release data-<version>
#   git commit web/DATA_RELEASE
#
# The bundle is 600+ MB, mostly samples.bin, and it is rebuilt from ~27 GB of
# archives no CI runner has room for. So it does not live in git, and not in
# LFS either: LFS quota is metered on every clone and every Pages deploy, while
# release assets are not. The Pages workflow downloads the release named in
# web/DATA_RELEASE, so a deploy always pairs the code with the bundle it was
# committed against.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
data="$root/web/data"
version="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$data/catalog.json")"
tag="data-$version"

if gh release view "$tag" >/dev/null 2>&1; then
    echo "==> $tag already exists; the bundle is unchanged"
else
    echo "==> creating $tag"
    gh release create "$tag" "$data"/* \
        --title "Web bundle $version" \
        --notes "Static bundle for the explorer, written by \`python -m tbacss publish\`.

Sound data from the TBAC Silencer Summits, Thunder Beast Arms Corporation. See ATTRIBUTION.md."
fi

echo "$tag" > "$root/web/DATA_RELEASE"
echo "==> web/DATA_RELEASE now names $tag; commit it to deploy"

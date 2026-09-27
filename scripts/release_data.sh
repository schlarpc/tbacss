#!/usr/bin/env bash
# Upload the web bundle as a GitHub release and pin the site to it.
#
#   python -m tbacss publish tbacss.db web/data
#   scripts/release_data.sh            # creates release data-<version>
#   git commit web/data-release.json
#
# The bundle is 600+ MB, mostly samples.bin, and it is rebuilt from ~27 GB of
# archives no CI runner has room for. So it does not live in git, and not in
# LFS either: LFS quota is metered on every clone and every Pages deploy, while
# release assets are not. web/data-release.json records the release's URL and
# the SRI hash of every file in it, and `nix build .#site` fetches exactly
# those bytes -- a deploy always pairs the code with the bundle it was
# committed against, and a re-uploaded asset fails the build instead of
# silently changing the site.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
data="$root/web/data"
version="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$data/catalog.json")"
tag="data-$version"
repo="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"

if gh release view "$tag" >/dev/null 2>&1; then
    echo "==> $tag already exists; the bundle is unchanged"
else
    echo "==> creating $tag"
    gh release create "$tag" "$data"/* \
        --title "Web bundle $version" \
        --notes "Static bundle for the explorer, written by \`python -m tbacss publish\`.

Sound data from the TBAC Silencer Summits, Thunder Beast Arms Corporation. See ATTRIBUTION.md."
fi

python3 - "$data" "$tag" "$repo" >"$root/web/data-release.json" <<'EOF'
import base64, hashlib, json, sys
from pathlib import Path

data, tag, repo = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
files = {}
for path in sorted(data.iterdir()):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1 << 20):
            digest.update(chunk)
    files[path.name] = "sha256-" + base64.b64encode(digest.digest()).decode()
release = {
    "tag": tag,
    "url": f"https://github.com/{repo}/releases/download/{tag}",
    "files": files,
}
print(json.dumps(release, indent=2))
EOF
echo "==> web/data-release.json now pins $tag; commit it to deploy"

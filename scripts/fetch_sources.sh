#!/usr/bin/env bash
# Fetch everything the build needs from thunderbeastarms.com.
#
#   scripts/fetch_sources.sh            # tables, reports and reference code
#   scripts/fetch_sources.sh --archives # also the ~21 GB of release sets
#
# The summary tables are tracked in git; the report pages and the Octave they
# link are not, because TBAC holds copyright on them. This script puts them
# back where the README expects them.
#
# thunderbeastarms.com serves only its leaf certificate and omits the Sectigo
# intermediate, so curl fails with "unable to get local issuer certificate"
# where a browser succeeds by chasing the AIA URL. We do the same thing by
# hand and build a one-off CA bundle.
set -euo pipefail

years=(2023 2024 2025 2026)
base="https://thunderbeastarms.com/sound"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

echo "==> building a CA bundle with the missing intermediate"
: "${SSL_CERT_FILE:=/etc/ssl/certs/ca-certificates.crt}"
intermediate="http://crt.sectigo.com/SectigoPublicServerAuthenticationCADVR36.crt"
curl -fsS "$intermediate" -o "$work/inter.der"
openssl x509 -inform DER -in "$work/inter.der" -out "$work/inter.pem"
cat "$SSL_CERT_FILE" "$work/inter.pem" > "$work/bundle.pem"
get() { curl -fsSL --cacert "$work/bundle.pem" "$1" -o "$2"; }

for year in "${years[@]}"; do
    echo "==> $year"
    mkdir -p "$root/summit$year"
    get "$base/summit$year/HTML/all.csv"  "$root/summit$year/all.csv"
    get "$base/summit$year/"              "$root/summit$year/index.html"
done

# 2023 published physical specs separately from the results table.
get "$base/summit2023/HTML/physical-specs.csv" "$root/summit2023/physical-specs.csv"

echo "==> reference code"
# 2023 used process_string.m; 2024 onwards use process_string_flat.m, which
# adds the shortened .22 analysis window. tbacss/analysis.py ports both.
for year in "${years[@]}"; do
    mkdir -p "$root/reference/octave-$year"
    for name in adsgn.m Leq_fast.m process_string.m process_string_flat.m; do
        get "$base/summit$year/HTML/m/$name" \
            "$root/reference/octave-$year/$name" 2>/dev/null || true
    done
    find "$root/reference/octave-$year" -size 0 -delete
done

if [[ "${1:-}" == "--archives" ]]; then
    echo "==> release archives (this is ~21 GB)"
    # 2023 is hosted by TBAC; 2024 and 2025 are on Dropbox. 2026 was still
    # marked TBD on the report page as of this writing.
    get "$base/summit2023/2023_SUMMIT_RELEASE_SET.tar.gz" \
        "$root/2023_SUMMIT_RELEASE_SET.tar.gz"
    curl -fsSL -C - -o "$root/2024_SUMMIT_RELEASE_SET.tar.gz" \
        "https://www.dropbox.com/scl/fi/x0rzms56e52nd2bpy53a8/2024_SUMMIT_RELEASE_SET.tar.gz?rlkey=3jjtikha3tkvrejcawju5nhz3&dl=1"
    curl -fsSL -C - -o "$root/2025_SUMMIT_RELEASE_SET.tar.gz" \
        "https://www.dropbox.com/scl/fi/yxxu6dgejp2e2g18wyuvo/2025_SUMMIT_RELEASE_SET.tar.gz?rlkey=n98408fdjv54rji0m4ulxxuv3&dl=1"
fi

echo "done"

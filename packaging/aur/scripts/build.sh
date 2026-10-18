#!/usr/bin/env bash
# Sets the version and sums in mx-mail-bin/PKGBUILD from a published release, checks and builds the package, and
# writes .SRCINFO. It pushes nothing; push.sh does that.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
repo='PixelHabits/mx'
pkgname='mx-mail-bin'
tag="${RELEASE_TAG:?RELEASE_TAG is required}"
pkgrel="${PKGREL:-1}"

if [[ ! "$tag" =~ ^v([0-9]+\.[0-9]+\.[0-9]+)$ ]]; then
  echo "$tag is not a release tag such as v1.2.3." >&2
  exit 1
fi
pkgver="${BASH_REMATCH[1]}"
release_json="$(gh api "repos/$repo/releases/tags/$tag")"

package_dir="$repo_root/packaging/aur/$pkgname"
cd "$package_dir"
sed -Ei -e "s/^pkgver=.*/pkgver=$pkgver/" -e "s/^pkgrel=.*/pkgrel=$pkgrel/" PKGBUILD

for asset in mx-linux-x64 mx-sync.service LICENSE THIRD_PARTY_NOTICES; do
  digest="$(jq -r --arg name "$asset" \
    '.assets[] | select(.name == $name) | .digest' <<<"$release_json")"
  sha256="${digest#sha256:}"
  if [[ ! "$sha256" =~ ^[0-9a-f]{64}$ ]]; then
    echo "Release $tag is missing $asset or its SHA-256 digest." >&2
    exit 1
  fi
  sed -Ei "/# $asset\$/s/'[0-9a-f]{64}'/'$sha256'/" PKGBUILD
done

run_as_builder() {
  if [[ "$(id -u)" == 0 ]]; then
    runuser -u builder -- "$@"
  else
    "$@"
  fi
}

if [[ "$(id -u)" == 0 ]]; then
  chown -R builder:builder "$package_dir"
fi
run_as_builder namcap PKGBUILD
run_as_builder makepkg --printsrcinfo > .SRCINFO
# Without --syncdeps, makepkg installs nothing and stops if a dependency is missing.
run_as_builder makepkg --cleanbuild --clean --force
run_as_builder namcap "$(run_as_builder makepkg --packagelist)"

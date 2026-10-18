#!/usr/bin/env bash
# Pushes the PKGBUILD and .SRCINFO that build.sh wrote to the AUR, with AUR_SSH_PRIVATE_KEY.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
pkgname='mx-mail-bin'
key="${AUR_SSH_PRIVATE_KEY:?AUR_SSH_PRIVATE_KEY is required}"

package_dir="$repo_root/packaging/aur/$pkgname"
pkgver="$(sed -n 's/^\tpkgver = //p' "$package_dir/.SRCINFO")"
pkgrel="$(sed -n 's/^\tpkgrel = //p' "$package_dir/.SRCINFO")"

work_dir="$(mktemp -d)"
trap 'rm -rf -- "$work_dir"' EXIT
key_file="$work_dir/id_ed25519"
known_hosts_file="$work_dir/known_hosts"
aur_dir="$work_dir/$pkgname"
(umask 077 && printf '%s\n' "$key" > "$key_file")
printf '%s\n' \
  'aur.archlinux.org ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEuBKrPzbawxA/k2g6NcyV5jmqwJ2s+zpgZGZ7tpLIcN' \
  > "$known_hosts_file"
export GIT_SSH_COMMAND="ssh -i $key_file -o IdentitiesOnly=yes -o UserKnownHostsFile=$known_hosts_file -o StrictHostKeyChecking=yes"

# Cloning a package the AUR does not have yet gives an empty repository, and the first push creates the package.
git clone "ssh://aur@aur.archlinux.org/$pkgname.git" "$aur_dir"
cp "$package_dir/PKGBUILD" "$package_dir/.SRCINFO" "$aur_dir/"
cd "$aur_dir"
git config user.name 'github-actions[bot]'
git config user.email '41898282+github-actions[bot]@users.noreply.github.com'
git add PKGBUILD .SRCINFO

if git diff --cached --quiet; then
  echo 'AUR package is already up to date.'
  exit 0
fi

git commit -m "Update to $pkgver-$pkgrel"
git push origin HEAD:master

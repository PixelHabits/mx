# AUR packaging

This directory maintains the [`mx-mail-bin`](https://aur.archlinux.org/packages/mx-mail-bin) package. It
repackages `mx-linux-x64`, `mx-sync.service`, `LICENSE` and `THIRD_PARTY_NOTICES` from the GitHub release. The AUR
name `mx` belongs to an unrelated package. `packaging/arch/PKGBUILD` builds the same files from source as `mx-mail`,
which `mx-mail-bin` conflicts with.

## Publishing

The Release workflow calls `.github/workflows/publish-aur.yml` after publishing a GitHub release;
the workflow can also be run manually for a specific tag. It updates the package's version and
checksums from the digests GitHub records for the release files, builds it, regenerates `.SRCINFO`,
and pushes it to the AUR. The committed `PKGBUILD` keeps placeholder checksums; only the AUR copy
carries a release's.

To validate a release on Arch Linux:

```bash
sudo pacman -Syu --needed base-devel github-cli jq namcap
GH_TOKEN=$(gh auth token) RELEASE_TAG=v0.1.0 \
  packaging/aur/scripts/build.sh
```

`build.sh` builds the package and pushes nothing; the workflow pushes with `scripts/push.sh` in a
separate step. `build.sh` edits `mx-mail-bin/PKGBUILD` in place;
`git restore packaging/aur/mx-mail-bin/PKGBUILD` undoes that.

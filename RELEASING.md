# Releasing mx

release-please releases mx from the conventional commits on `main`, and the Release workflow in `.github/workflows/release-please.yml` builds, signs and publishes each release.

## Release a version

1. Merge pull requests into `main` with conventional commit messages. release-please keeps a release PR open that raises `version` in `package.json` and `.release-please-manifest.json` and lists the changes in `CHANGELOG.md`. Before 1.0.0, a breaking change raises the minor version.
2. Merge the release PR. release-please tags the merge commit `v<version>` and creates the GitHub release `v<version>` as a draft.
3. In the Release workflow run, approve the `release` job. It waits because the `release` environment has a required reviewer.

The `release` job then:

1. Builds `mx-linux-x64` and `mx-windows-x64.exe` with the Bun that `packageManager` in `package.json` pins, and writes `THIRD_PARTY_NOTICES`.
2. Writes the manifest `latest.json` with each binary's URL, size and sha256, and signs it with `MX_RELEASE_SIGNING_KEY` into `latest.json.sig`.
3. Uploads the five files to the draft with `gh release upload`.
4. Attests the build provenance of both binaries and `latest.json`.
5. Publishes the draft.

mx reads `https://github.com/PixelHabits/mx/releases/latest/download/latest.json`. GitHub's `latest` skips drafts, so mx sees a release only after the job uploads its files and publishes it.

Pull requests that release-please opens with the workflow's token start no other workflow, so the Check workflow does not run on the release PR.

## Settings

The repository needs these settings:

- The environment `release`, with a required reviewer, and its deployment branches set to `main` only.
- The environment secret `MX_RELEASE_SIGNING_KEY` in `release`: the release signing key, an Ed25519 private key in PKCS #8 PEM. Its public half is `release/public-key.pem`, which every build compiles in, and mx refuses a manifest that this key did not sign.
- In Settings › Actions › General, "Allow GitHub Actions to create and approve pull requests", so that release-please can open its release PR.

## Verify a release

```sh
gh attestation verify mx-linux-x64 --repo PixelHabits/mx
```

## Dry run

`bun run release` builds and signs the release files into `dist/` and uploads nothing:

```sh
MX_RELEASE_SIGNING_KEY="$(cat path/to/signing-key.pem)" bun run release
```

Signed with any key other than the release signing key, the files are complete, but mx refuses the manifest.

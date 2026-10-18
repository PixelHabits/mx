# Releasing mx

release-please releases mx from the conventional commits on `main`, and the Release workflow in `.github/workflows/release-please.yml` builds, signs and publishes each release.

## Release a version

1. Merge pull requests into `main` with conventional commit messages. release-please keeps a release PR open that raises `version` in `package.json` and `.release-please-manifest.json` and lists the changes in `CHANGELOG.md`. Before 1.0.0, a breaking change raises the minor version.
2. Merge the release PR. release-please tags the merge commit `v<version>` and creates the GitHub release `v<version>` as a draft.
3. In the Release workflow run, approve the `sign` job. It waits because the `release` environment has a required reviewer.

The workflow then runs three jobs in turn:

1. `build`, on Linux, builds `mx-darwin-arm64`, `mx-darwin-x64`, `mx-linux-x64` and `mx-windows-x64.exe` with the Bun that `packageManager` in `package.json` pins. It writes `THIRD_PARTY_NOTICES`, and for the Arch packages the sync unit `mx-sync.service` for `/usr/bin/mx` and a copy of `LICENSE`.
2. `sign`, on macOS:
   1. Signs `mx-darwin-arm64` and `mx-darwin-x64` with the Developer ID Application certificate, with the hardened runtime, a secure timestamp and the entitlements in `release/entitlements.plist`.
   2. Checks each signature against Apple's requirement for a Developer ID Application signature of `APPLE_TEAM_ID`, and runs the signed arm64 binary.
   3. Sends both binaries to Apple's notary service in one ZIP archive and waits until Apple accepts them. Apple can't staple a ticket to a bare executable, so Gatekeeper looks the tickets up online.
   4. Writes the manifest `latest.json` with each binary's URL, size and sha256, of the signed bytes, and signs it with `MX_RELEASE_SIGNING_KEY` into `latest.json.sig`.
3. `publish`, on Linux:
   1. Uploads the nine files to the draft with `gh release upload`.
   2. Attests the build provenance of the binaries, `mx-sync.service` and `latest.json`.
   3. Publishes the draft.

mx reads `https://github.com/PixelHabits/mx/releases/latest/download/latest.json`. GitHub's `latest` skips drafts, so mx sees a release only after the workflow uploads its files and publishes it.

Pull requests that release-please opens with the workflow's token start no other workflow, so the Check workflow does not run on the release PR.

## Settings

The repository needs these settings:

- The environment `release`, with a required reviewer, and its deployment branches set to `main` only.
- In Settings › Actions › General, "Allow GitHub Actions to create and approve pull requests", so that release-please can open its release PR.

The `release` environment needs these secrets:

| Secret | Value |
| --- | --- |
| `MX_RELEASE_SIGNING_KEY` | The release signing key, an Ed25519 private key in PKCS #8 PEM. Its public half is `release/public-key.pem`, which every build compiles in, and mx refuses a manifest that this key did not sign. |
| `APPLE_DEVELOPER_ID_P12` | The Developer ID Application certificate with its private key, as a `.p12` file in base64. |
| `APPLE_DEVELOPER_ID_P12_PASSWORD` | The password of that `.p12` file. |
| `APPLE_NOTARY_KEY` | The contents of the App Store Connect API key's `.p8` file. |
| `APPLE_NOTARY_KEY_ID` | That key's Key ID. |
| `APPLE_NOTARY_ISSUER_ID` | The Issuer ID of the team's App Store Connect API keys. |
| `APPLE_TEAM_ID` | The Apple Developer team ID, the 10 characters in parentheses in the certificate's name. |

To make the Apple secrets:

1. On a Mac, open Keychain Access, select the "Developer ID Application" certificate in My Certificates, and export it as a `.p12` file with a password. Copy it in base64 with `base64 -i developer-id.p12 | pbcopy`.
2. In App Store Connect, open Users and Access › Integrations › App Store Connect API, and create a Team key. The workflow passes the Issuer ID, which notarytool requires for a Team key and refuses for an Individual key. Download the `.p8` file; App Store Connect offers it only once.

## Verify a release

```sh
gh attestation verify mx-linux-x64 --repo PixelHabits/mx
```

On a Mac, check a macOS binary's signature too:

```sh
codesign --verify --strict --verbose=2 mx-darwin-arm64
```

## Dry run

`bun run release` builds the release files into `dist/`, writes the signed manifest, and uploads nothing:

```sh
MX_RELEASE_SIGNING_KEY="$(cat path/to/signing-key.pem)" bun run release
```

It runs on Linux and needs no Apple secrets, so the macOS binaries keep the ad-hoc signature that Bun gives them. Signed with any key other than the release signing key, the files are complete, but mx refuses the manifest.

`bun run manifest` writes and signs the manifest of the binaries already in `dist/`, as the `sign` job does after it signs them.

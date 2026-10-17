# Contributing

Issues and pull requests are welcome.

- Install [Bun](https://bun.com), then run `bun install`.
- Before you open a pull request, run `bun run typecheck`, `bun run check` and `bun run test`. CI runs them on Linux and Windows.
- Write commit messages as [conventional commits](https://www.conventionalcommits.org), such as `fix: keep the draft's attachments on update`. release-please builds the changelog and version from them.
- The tests run against an in-memory Microsoft Graph in `tests/`, so they need no account. Please add a test for the behavior you change.

By contributing, you agree that your contribution is licensed under the MIT license.

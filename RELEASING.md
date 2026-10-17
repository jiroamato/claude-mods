# Releasing

Releases are driven by [release-please](https://github.com/googleapis/release-please). Each
plugin is versioned and released on its own, tagged `<plugin>-v<version>`
(`desktop-statusline-v0.1.0`).

**Nothing releases by itself.** release-please only opens a release PR on `main`. A release is
cut solely when the maintainer merges that PR. Merging ordinary PRs never releases.

## Steady state

1. Conventional commits land on `main` through squash-merged PRs.
2. For each plugin with `feat` or `fix` commits touching its folder since its last release,
   release-please opens or updates a release PR, `chore(main): release <plugin> <version>`. It
   bumps the version in the plugin's `.claude-plugin/plugin.json`, in its entry in
   `.claude-plugin/marketplace.json` and in `.release-please-manifest.json`, and adds the
   release to the plugin's `CHANGELOG.md`.
3. The maintainer reviews and merges the release PR. That is the go decision.
4. `.github/workflows/release-please.yml` tags the merge commit and publishes the GitHub
   release with the same notes as the changelog.

Installed copies update on the next marketplace sync: the desktop app and `claude plugin`
compare the `version` in `plugin.json` with what is installed.

## Versions

While a plugin is below 1.0.0, a `feat` bumps the patch version and a breaking change bumps
the minor. `docs`, `chore`, `ci`, `style` and `test` commits release nothing on their own.

Do not hand-edit the `version` fields, `CHANGELOG.md` or `.release-please-manifest.json`; the
Guard generated files check rejects PRs that do.

## Adding a plugin

Add an entry for its folder under `packages` in `release-please-config.json`, copying
`desktop-statusline`'s and changing the names and the `jsonpath` filter. Its first release PR
proposes `initial-version`.

## One-time repository setup

release-please opens its PRs with the workflow's `GITHUB_TOKEN`, which GitHub only allows
when **Settings > Actions > General > Workflow permissions > Allow GitHub Actions to create
and approve pull requests** is on.

Those PRs do not trigger the `ci` workflow, since GitHub starts no workflow for events a
`GITHUB_TOKEN` causes. They only change versions and changelogs, and `ci` runs on `main`
once they merge.

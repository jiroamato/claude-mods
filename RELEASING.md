# Releasing

Releases are driven by [release-please](https://github.com/googleapis/release-please). Each
plugin is versioned and released on its own. `desktop-statusline`'s releases are tagged and
named by version alone (`v0.1.0`).

**Nothing releases by itself.** Work collects on `dev`, and release-please runs only on pushes
to `main`, where it opens a release PR. A release is cut solely when the maintainer merges that
PR. Merging ordinary PRs never releases.

## Steady state

1. Conventional commits land on `dev` through squash-merged PRs (see
   [CONTRIBUTING.md](CONTRIBUTING.md)).
2. The maintainer promotes `dev` with a PR from `dev` into `main`, merged with a merge commit so
   every commit reaches `main` on its own and gets its own changelog line.
3. For each plugin with `feat` or `fix` commits touching its folder since its last release,
   release-please opens or updates a release PR, `chore(main): release <version>`. It
   bumps the version in the plugin's `.claude-plugin/plugin.json`, in its entry in
   `.claude-plugin/marketplace.json`, in `.release-please-manifest.json` and, for
   `desktop-statusline`, in its `package.json`, and adds the release to the plugin's
   `CHANGELOG.md`. The release PR shows no CI checks (see
   [One-time repository setup](#one-time-repository-setup)).
4. The maintainer reviews and merges the release PR. That is the go decision.
5. `.github/workflows/release-please.yml` tags the merge commit and publishes the GitHub
   release with the same notes as the changelog. For `desktop-statusline` it then runs the
   `ci` checks on that commit and, once they pass, publishes its npm package (see below).
6. The maintainer merges `main` back into `dev` with a PR from `main`, merged with a merge
   commit, so `dev` carries the new versions and changelogs.

Installed copies update on the next marketplace sync: the desktop app and `claude plugin`
compare the `version` in `plugin.json` with what is installed.

## Stacked pull requests

Merge a stack bottom-up. Merge the base PR into `dev`; then, for the next PR, rebase its
branch onto `dev` from its own first commit (`git rebase --onto origin/dev <old-base>`),
force-push it with `--force-with-lease`, retarget the PR to `dev`, wait for CI to pass, and
merge it. Repeat up the stack.

## npm

`desktop-statusline/` is also the npm package `@jiroamato/desktop-statusline`, whose only
code is an installer: `npx @jiroamato/desktop-statusline` adds this marketplace and installs
the plugin through the `claude` CLI. The plugin itself still reaches people through the
marketplace. The package's `version` is the plugin's, bumped by release-please in the same
release PR (the package's release type is `node`), and its npm page shows the plugin's own
README, its relative links made absolute by `pack-docs.mjs` while npm packs it.

Publishing uses npm [trusted publishing](https://docs.npmjs.com/trusted-publishers): the
`npm` job in `release-please.yml` has `id-token: write`, npm takes the workflow's OIDC token
in place of a stored npm token, and publishes with provenance. No npm token exists anywhere.
A release that fails to publish can be published by re-running the workflow's failed jobs.

### One-time setup

npm only lets a trusted publisher be configured on a package that already exists, so the
first version is published by hand, once:

1. From an up-to-date checkout of a branch that has `desktop-statusline/package.json` (`dev`,
   until it is promoted to `main`), run `npm login`, then `npm publish` in
   `desktop-statusline/`.
2. On npmjs.com, open the package's **Settings > Trusted Publisher > GitHub Actions** and set
   user `jiroamato`, repository `claude-mods`, workflow `release-please.yml`, environment
   empty. Under **Allowed actions**, check **Allow npm publish**: without it the workflow's
   `npm publish` only stages the version and never makes it live. Leave **Allow npm
   dist-tag** unchecked, since the workflow never changes dist-tags.
3. Under **Settings > Publishing access**, choose **Require two-factor authentication and
   disallow tokens**, so that only the workflow, or the maintainer with 2FA, can publish.

A release PR merged before this is done is tagged and released on GitHub, but its `npm` job
fails to authenticate: finish the setup, then re-run the failed jobs.

## Versions

While a plugin is below 1.0.0, a `feat` bumps the patch version and a breaking change bumps
the minor. `docs`, `chore`, `ci`, `style` and `test` commits, and commits outside a plugin
folder, release nothing on their own.

Do not hand-edit the `version` fields, `CHANGELOG.md` or `.release-please-manifest.json`; the
Guard generated files check rejects PRs that edit a changelog or the manifest.

release-please rewrites the JSON files it bumps with `JSON.stringify`, so `.prettierrc` formats
`.claude-plugin/*.json` and `.release-please-manifest.json` with the `json-stringify` parser
(Prettier already uses it for `package.json`), and its output passes the format check.

## Adding a plugin

Add an entry for its folder under `packages` in `release-please-config.json`, copying
`desktop-statusline`'s and changing the names and the `jsonpath` filter, but leave out
`include-component-in-tag`: only one package can own the bare `v<version>` tags, so every other
plugin is tagged `<plugin>-v<version>`. Its first release PR proposes `initial-version`.

## One-time repository setup

release-please opens its PRs with the workflow's `GITHUB_TOKEN`, which GitHub only allows
when **Settings > Actions > General > Workflow permissions > Allow GitHub Actions to create
and approve pull requests** is on.

Those PRs do not trigger the `ci` workflow, since GitHub starts no workflow for events a
`GITHUB_TOKEN` causes. They only change versions and changelogs, and `ci` runs on `main`
once they merge.

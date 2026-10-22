# Project agent memory

claude-mods is a Claude Code plugin marketplace: each top-level folder with a
`.claude-plugin/plugin.json` is one plugin, built on function hooks (an early-access API), listed in
`.claude-plugin/marketplace.json`.

## Orientation

- `README.md` documents each plugin's user-facing behaviour and the develop loop; `CONTRIBUTING.md`
  holds the checks CI runs; `RELEASING.md` holds the release process in full.
- A plugin's hooks module is `<plugin>/hooks/register.tsx`, its state contract `<plugin>/types/index.d.ts`,
  its tests `<plugin>/tests/`. The engine's API typings land in `<plugin>/.claude-plugin/types/` when a
  session loads the plugin; grep them for any `$` call or event before using it. They are generated,
  never committed.
- Checks, all of which CI runs on Ubuntu, macOS and Windows:
  `claude plugin validate --strict .`, `claude plugin validate --strict <plugin>`,
  `claude plugin test <plugin>`, `npx --yes prettier@3.9.10 --check .`. Type-check with
  `tsc -p <plugin>` once the typings exist. CI pins Claude Code and Prettier in `.github/workflows/ci.yml`;
  bump either there on purpose.
- UI changes are proven in the Claude desktop app, not only in tests: the desktop draws differently from
  the test harness (hover cards are a fixed-width popover, an unfocused pane spends its first click on
  focus). Put screenshots and recordings in the PR body.

## Git workflow

- Work collects on `dev`; `main` is what releases. Branch from `dev` as `type/short-name`; type is one
  of `feat|fix|refactor|perf|docs|test|chore|ci|build|style|revert`.
- Every change reaches `dev` through a PR (`gh pr create --base dev`: `main` stays the default branch),
  squash-merged with the PR title as the commit title. The PR title is what lands, so make it
  Conventional Commits: `type(scope): summary`, the scope being the plugin folder when the change is
  inside one (`fix(desktop-statusline): ...`).
- `dev` reaches `main` through a PR from `dev` merged with a merge commit, so each squashed commit
  arrives on `main` intact for release-please to read.
- Stacked PRs merge bottom-up: merge the base, rebase the next branch onto `dev` from its own first
  commit (`git rebase --onto origin/dev <old-base>`), force-push with lease, retarget it to `dev`,
  wait for green, merge.

## Release automation

Releases are release-please, per plugin. `desktop-statusline` is tagged `v<version>`; any other plugin
would be tagged `<plugin>-v<version>` (see `RELEASING.md`). It runs only on pushes to `main`, and
nothing releases by itself:

1. A `feat` or `fix` whose files touch `<plugin>/` reaching `main` makes release-please open or update
   `chore(main): release <version>`. `docs`, `chore`, `ci`, `style` and `test` commits,
   and commits outside a plugin folder, release nothing.
2. That PR bumps the version in `<plugin>/.claude-plugin/plugin.json`, the plugin's entry in
   `.claude-plugin/marketplace.json`, `.release-please-manifest.json` and, for
   `desktop-statusline`, `desktop-statusline/package.json`, and writes `<plugin>/CHANGELOG.md`.
   It shows no CI checks: GitHub runs no workflow for a PR the workflow token opened.
3. Merging it is the go decision: `.github/workflows/release-please.yml` tags the commit and publishes
   the GitHub release with the changelog's notes. Installed copies update on the next marketplace sync,
   which compares the `version` field. For `desktop-statusline` it then re-runs `ci.yml` on that
   commit and publishes the npm package `@jiroamato/desktop-statusline`, whose only code is the
   `npx` installer (`install.mjs`), through npm trusted publishing: no npm token exists (see
   `RELEASING.md`).
4. Merge `main` back into `dev` (a PR from `main`, merged with a merge commit) so `dev` carries the new
   versions and changelog.

Below 1.0.0 a `feat` bumps the patch and a breaking change the minor. The `version` fields,
`CHANGELOG.md` files and `.release-please-manifest.json` belong to release-please; leave them as they
are, and the `Guard generated files` workflow fails any PR that edits a changelog or the manifest. Release-please rewrites JSON with
`JSON.stringify`, which is why `.prettierrc` formats `.claude-plugin/*.json` with `json-stringify`.
A new plugin needs its own entry under `packages` in `release-please-config.json` (see `RELEASING.md`).

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Point to the authoritative file or command rather than repeating what the codebase shows.
Prefer rewriting or pruning existing entries over appending new ones.

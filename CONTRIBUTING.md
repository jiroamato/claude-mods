# Contributing

Thanks for wanting to contribute.

## Workflow

1. Fork the repo and create a branch from `dev` named `type/short-name` (`feat/context-map`,
   `fix/meter-width`), the type one of `feat`, `fix`, `refactor`, `perf`, `docs`, `test`,
   `chore`, `ci`, `build`, `style` or `revert`.
2. Make your changes, then run the same checks CI runs until they are all green:

   ```bash
   claude plugin validate --strict .
   claude plugin validate --strict <plugin>
   claude plugin test <plugin>
   npx --yes prettier@3.9.10 --check .
   ```

   `npx --yes prettier@3.9.10 --write .` fixes the formatting.

3. Load the plugin in a real session and check it on the surface it draws on. For
   `desktop-statusline` that means the Claude desktop app, in light and dark themes.
4. Open a pull request against `dev` with a [Conventional Commits](https://www.conventionalcommits.org)
   title, `type(scope): summary`. When the change is inside a plugin, the scope is its folder
   name (`fix(desktop-statusline): keep the timer from shifting the meter`). `main` is the
   repository's default branch, so name the base: `gh pr create --base dev`.

CI checks formatting, validates the marketplace, then validates and tests each plugin and
installs `desktop-statusline` with `npx`, on Ubuntu, macOS and Windows. Pull requests are squash-merged with the PR title as the commit
title, so the title is what lands on `dev`, and for `feat` and `fix` it becomes the line in
the release notes once `dev` is promoted to `main`.

## Repo conventions

- Each plugin lives in its own self-contained folder with its manifest, hooks module, state
  contract, tests, README and screenshots (`<plugin>/docs/`). A new plugin also gets an entry
  in `.claude-plugin/marketplace.json` and a row in the root README's Plugins table.
- Function hooks are an early-access API. Write against the Claude Code version named in the
  latest release notes, and say in the PR if your change needs a newer one.
- Add or update tests under `<plugin>/tests/` for the behaviour you change.
- For UI changes, attach a screenshot of the plugin as it draws.
- Do not commit the engine's generated typings (`<plugin>/.claude-plugin/types/`).
- Leave the `version` fields in `plugin.json` and `marketplace.json` alone, and do not
  hand-edit any `CHANGELOG.md` or `.release-please-manifest.json`. release-please writes them,
  and releases are cut by the maintainer merging its release PR; see [RELEASING.md](RELEASING.md).

## Questions

Open an issue.

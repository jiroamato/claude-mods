# Contributing

Thanks for wanting to contribute.

## Workflow

1. Fork the repo and create a branch named `type/short-name` (`feat/context-map`, `fix/meter-width`).
2. Make your changes, then validate and test every plugin you touched until both are green:

   ```bash
   claude plugin validate --strict <plugin>
   claude plugin test <plugin>
   ```

3. Load the plugin in a real session and check it on the surface it draws on. For
   `desktop-statusline` that means the Claude desktop app, in light and dark themes.
4. Open a pull request against `main` with a [Conventional Commits](https://www.conventionalcommits.org)
   title, `type(scope): summary`, where the scope is the plugin's folder name
   (`fix(desktop-statusline): keep the timer from shifting the meter`).

CI validates the marketplace, then validates and tests each plugin on Ubuntu, macOS and
Windows. Pull requests are squash-merged, so the PR title is the commit that lands on `main`
and the line that shows up in the release notes.

## Repo Conventions

- Each plugin lives in its own self-contained folder with its manifest, hooks module, state
  contract and tests. A new plugin also gets an entry in `.claude-plugin/marketplace.json` and
  a section in the README.
- Function hooks are an early-access API. Write against the Claude Code version named in the
  latest release notes, and say in the PR if your change needs a newer one.
- Add or update tests under `<plugin>/tests/` for the behaviour you change.
- For UI changes, attach a screenshot of the plugin as it draws.
- Do not commit the engine's generated typings (`<plugin>/.claude-plugin/types/`).
- Leave the `version` fields in `plugin.json` and `marketplace.json` alone, and do not
  hand-edit `CHANGELOG.md`. The maintainer sets versions and cuts releases.

## Questions

Open an issue.

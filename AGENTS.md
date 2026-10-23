# Project agent memory

claude-mods is a Claude Code plugin marketplace: each top-level folder with a
`.claude-plugin/plugin.json` is one plugin, built on function hooks (an early-access API), listed in
`.claude-plugin/marketplace.json`.

## Workflow docs

Read the matching file before you act:

- **Branching, committing or opening a PR:** `CONTRIBUTING.md`. Branches and PRs target `dev`;
  `main` is the default branch but only receives releases.
- **Merging PRs, promoting `dev` to `main`, releasing, or touching what release-please or npm
  owns** (versions, changelogs, `release-please-config.json`, the release workflow, the npm
  package, a new plugin): `RELEASING.md`.

## Orientation

- The root `README.md` is the marketplace's front page (its plugins, installing);
  `<plugin>/README.md` documents that plugin's behaviour and install for its users, with its images in
  `<plugin>/docs/`.
- A plugin's hooks module is `<plugin>/hooks/register.tsx`, its state contract `<plugin>/types/index.d.ts`,
  its tests `<plugin>/tests/`. The engine's API typings land in `<plugin>/.claude-plugin/types/` when a
  session loads the plugin; grep them for any `$` call or event before using it. They are generated,
  never committed.
- In `desktop-statusline/hooks/`, `register.tsx` registers every hook and draws the band, its timer in
  `elapsed.tsx` and `duration.ts`. `panel.tsx` and the components it mounts (`tabs.tsx`,
  `disclosure.tsx`, `reader.tsx`, `text.tsx`) are the Context details pane. `context.ts` reads the
  breakdown, `tools.ts` the tools and the deny edit, `trace.ts` tracing's settings and traces, and
  `folder.ts` opens the traces folder. `trace/` is the receiver Node runs for tracing, its browser
  pages, and the record code `hooks/trace.ts` shares. `package.json`, `install.mjs` and
  `pack-docs.mjs` are the npm installer, which `RELEASING.md` covers.
- Code carries no comments: names, types and test names say what it does, so nothing drifts from it.
- Checks, all of which CI runs on Ubuntu, macOS and Windows:
  `claude plugin validate --strict .`, `claude plugin validate --strict <plugin>`,
  `claude plugin test <plugin>`, `npx --yes prettier@3.9.10 --check .`. Type-check with
  `tsc -p <plugin>` once the typings exist. CI runs the latest Claude Code release and pins Prettier
  in `.github/workflows/ci.yml`; bump Prettier there on purpose.
- UI changes are proven in the Claude desktop app, not only in tests: the desktop draws differently from
  the test harness (hover cards are a fixed-width popover, an unfocused pane spends its first click on
  focus). Put screenshots and recordings in the PR body.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Point to the authoritative file or command rather than repeating what the codebase shows.
Prefer rewriting or pruning existing entries over appending new ones.

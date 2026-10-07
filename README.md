# claude-mods

A plugin marketplace of mods for [Claude Code](https://code.claude.com): live UI
plugins built on function hooks.

## Plugins

### desktop-statusline

A status bar above the prompt in the Claude desktop app's Code tab. It mirrors
the figures a terminal status line shows, drawn in the app's own theme colours:

![The desktop-statusline band: Fable 5.1, high effort, claude-mods | main, a context meter at 27%, $6.58, 2h 24m](docs/desktop-statusline.png)

- **Model** in the Claude accent, with the session's reasoning **effort** beside it,
  coloured from quiet (low) to warning and error tones (x-high, max).
- **Folder** and **git branch**, with a dot when the working copy has uncommitted changes.
- **Context meter**: a hollow rounded rectangle that fills as the context window does.
- **Cost** so far and **elapsed** session time. Seconds are dropped past an hour.

It draws on the desktop surface only. In the terminal it stays out of the way,
so a `statusLine` command in your settings keeps working there.

## Install

```bash
claude plugin marketplace add jiroamato/claude-mods
```

```bash
claude plugin install desktop-statusline@claude-mods
```

Open a new session and the band appears above the prompt. Later versions arrive
with `claude plugin update`.

## Develop

Function hooks are an early-access API: the surface may change between Claude
Code releases, and the plugin is written against the version named in each
release's notes. Each plugin folder is self-contained:

```
desktop-statusline/
  .claude-plugin/plugin.json   manifest
  hooks/hooks.json             names the hooks module
  hooks/register.tsx           the mod: hooks, state and the band's tree
  types/index.d.ts             its state contract
  tests/                       run with `claude plugin test`
```

Validate, test and type-check a plugin from its folder:

```bash
claude plugin validate --strict desktop-statusline
```

```bash
claude plugin test desktop-statusline
```

Loading it in a session lays the engine's typings beside the manifest, after
which `tsc -p desktop-statusline` type-checks it. Those generated files are
ignored by git.

To hack on it live, point a session at the folder: `claude --plugin-dir
./desktop-statusline`, or set `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of
`~/.claude/settings.json`. Saving a file reloads the mod in that session.

## License

MIT

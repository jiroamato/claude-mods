<h1 align="center">claude-mods</h1>
<p align="center">
  <a href="https://github.com/jiroamato/claude-mods/actions/workflows/ci.yml"
    ><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/jiroamato/claude-mods/ci.yml?branch=main&style=flat-square&label=ci"
  /></a>
  <a href="https://claude.ai/download"
    ><img alt="Platform" src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux%20(beta)-blue?style=flat-square"
  /></a>
  <a href="https://x.com/Jiro0x"
    ><img alt="X" src="https://img.shields.io/badge/X-@Jiro0x-black?style=flat-square"
  /></a>
</p>

A plugin marketplace of mods for [Claude Code](https://code.claude.com): live UI
plugins built on function hooks.

## Plugins

Each plugin has a README of its own, with what it does and how to install it.

### [desktop-statusline](desktop-statusline/README.md)

A status bar above the prompt in the Claude desktop app: model, effort, folder, git
branch, context meter, cost and elapsed time. Its ⓘ opens a pane to remove built-in
tools, read the system prompt as sent, and trace every request to the model.

![The desktop-statusline band above the prompt box: Opus 5.5, high effort, claude-mods | feat/desktop-statusline-context-breakdown with a dot for uncommitted changes, a context meter at 7%, $0.02, 22m 8s and an info button, with hairlines between each figure](desktop-statusline/docs/desktop-statusline-above-prompt.png)

## Install

Add this marketplace once, then install any of its plugins.

**In the Claude desktop app**, open **Settings > Plugins** (under _Customize_),
click **Add > Add marketplace > Add from a repository**, paste
`https://github.com/jiroamato/claude-mods` and press **Sync**. Its plugins then
appear in the list; click a plugin's **Add** button and pick a scope. Start a new
Code session to load it.

**From a terminal**, the same in two commands (the terminal and the desktop app
share one plugin configuration):

```bash
claude plugin marketplace add jiroamato/claude-mods
```

```bash
claude plugin install <plugin>@claude-mods
```

A plugin may also have an installer of its own, such as
`npx @jiroamato/desktop-statusline`; its README says so.

## Develop

Function hooks are an early-access API: the surface may change between Claude
Code releases, and each plugin is written against the version named in its
release notes. Each plugin folder is self-contained: its manifest
(`.claude-plugin/plugin.json`), hooks (`hooks/`), state contract
(`types/index.d.ts`), tests (`tests/`), README and screenshots (`docs/`). Its
README lists its files.

Validate, test and type-check a plugin by passing its folder:

```bash
claude plugin validate --strict <plugin>
```

```bash
claude plugin test <plugin>
```

Loading it in a session lays the engine's typings beside the manifest, after
which `tsc -p <plugin>` type-checks it. Those generated files are ignored by git.

To hack on a plugin live, point a session at its folder: `claude --plugin-dir
./<plugin>`, or set `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of
`~/.claude/settings.json`. Saving a file reloads the mod in that session.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the contributor workflow and
[RELEASING.md](RELEASING.md) for how plugins are released.

## License

[MIT](LICENSE)

<h1 align="center">claude-mods</h1>
<p align="center">
  <a href="https://github.com/jiroamato/claude-mods/actions/workflows/ci.yml"
    ><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/jiroamato/claude-mods/ci.yml?branch=main&style=flat-square&label=ci"
  /></a>
  <a href="https://github.com/jiroamato/claude-mods/releases"
    ><img alt="Release" src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fjiroamato%2Fclaude-mods%2Fmain%2Fdesktop-statusline%2F.claude-plugin%2Fplugin.json&query=%24.version&prefix=v&label=release&style=flat-square"
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

### desktop-statusline

A status bar above the prompt in the Claude desktop app's Code tab. It mirrors
the figures a terminal status line shows, its text in the app's own theme colours:

![The desktop-statusline band above the prompt box: Opus 5.5, high effort, claude-mods | main, a context meter at 9%, $1.25, 8m 28s, with hairlines between each figure](docs/desktop-statusline-above-prompt.png)

- **Model** in the Claude accent, with the session's reasoning **effort** beside it,
  coloured from quiet (low) to warning and error tones (x-high, max).
- **Folder** and **git branch**, with a dot when the working copy has uncommitted changes.
- **Context meter**: a hollow rounded rectangle that fills as the context window does.
- **Cost** so far and **elapsed** session time. Seconds are dropped past an hour.

#### Context details

The desktop app's own Context card lists what fills the context window. Click the
percentage beside the meter to open the **Context details** pane for what that card
cannot show, in four tabs, each with its size as `/context` counts it:

- **Tools**: every built-in tool with a one-line summary and its approximate size,
  grouped as in the context, deferred (loaded on demand), and removed, each group open
  until you close it. **Remove** takes a tool
  out of the open session at once (its schema leaves the context and Claude can no
  longer call it) and adds its name to `permissions.deny` in your user settings
  (`~/.claude/settings.json`, or `$CLAUDE_CONFIG_DIR`), so new sessions in every
  project start without it. **Put back** undoes both. A tool the session started
  without comes back in the next session. Deleting the name from `permissions.deny`
  by hand works too. Best done at the start of a session: the tools lead what the
  prompt cache keeps, so a change mid-session invalidates it, and the next request
  costs more as it caches the whole conversation again.
- **Prompt**: the system prompt, section by section, with each section's approximate
  size. Open a section to read its text. With tracing on, it shows the prompt exactly
  as the last request sent it, in two groups: Claude Code's own sections, and what was
  added to them when the request was sent, such as the billing header, the line that
  introduces Claude, an output style and the desktop app's own instructions.
- **Skills**: each skill's listing as Claude sees it, read-only for now: the ones you
  installed apart from the ones Claude Code and the desktop app bring, each group open
  until you close it.
- **Trace**: every request the session sends to the model, newest first, the
  conversation's apart from side requests such as titles and subagents, with what it
  added to the conversation, what came back, and its tokens, cost and time. Open one
  for a preview, then **Expand**: its system prompt, every tool definition
  and every message, as the model received them, with a search that steps through
  each match. The search stays at the top; the text moves under it by its own
  scrollbar (press or drag it), by the page buttons, or by the keys once you click
  it (the arrows, Page Up and Page Down, Home and End), and the arrows beside the
  counter or Enter bring each match into view. The wheel does nothing there, by
  design: nothing in the pane ever moves but the text. Or open the request whole in your browser. A request too large to read in the
  pane (over 4 MiB) is still listed with its figures and answer and opens in the
  browser, and the requests after it show where its messages were.

##### Tracing

**Turn on tracing** in the Trace tab turns on Claude Code's own telemetry for the
sessions you start after it, in the terminal and in the desktop app alike. It adds
these to the `env` block of your user settings (`~/.claude/settings.json`, or
`$CLAUDE_CONFIG_DIR`), so they apply globally. Before it does, it notes what you had
under each of these names, or that you had nothing, in the plugin's store
(`~/.claude/plugins/store/`). **Turn off tracing** puts exactly that back: your own
value, the same as tracing's or not, comes back, and a name you never set goes. A value
you changed while tracing was on stays as you left it. While tracing holds the place of
a value of yours, the Trace tab says which. If the store lost what it noted, off takes
tracing's values out and says it could not put yours back.

Tracing counts as on while `CLAUDE_CODE_ENABLE_TELEMETRY`, `OTEL_LOGS_EXPORTER` and
`OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` hold its values, since they decide where telemetry
goes. If you change any of the other four by hand, the Trace tab names them, as
requests may then be cut short, arrive later or not be recorded, and turning tracing
off and on again sets them back:

| Variable                              | Value                               |
| ------------------------------------- | ----------------------------------- |
| `CLAUDE_CODE_ENABLE_TELEMETRY`        | `1`                                 |
| `OTEL_LOGS_EXPORTER`                  | `otlp`                              |
| `OTEL_EXPORTER_OTLP_LOGS_PROTOCOL`    | `http/json`                         |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`    | `http://127.0.0.1:43180/v1/logs`    |
| `OTEL_LOGS_EXPORT_INTERVAL`           | `1000`                              |
| `OTEL_LOG_RAW_API_BODIES`             | `1`                                 |
| `CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH` | `20000000`, so no body is cut short |

Only the log events are exported, to a small receiver on this machine that the
plugin starts with [Node.js](https://nodejs.org) (which has to be on your `PATH`).
One receiver serves every session, and lives as long as the session that started
it; each prompt you send checks that one listens and starts another if not, so a
request sent in the moment between can be missing from a trace. If your
organization's settings, or a variable of your own, send telemetry elsewhere, that
endpoint wins and the Trace tab says so: the requests go there, whole, not here.

The receiver keeps each session's requests in a folder of its own under
`~/.claude/desktop-statusline/traces/`, always there whatever `$CLAUDE_CONFIG_DIR`
says, and serves the browser pages on `localhost` only, behind a token it writes
beside them. The first session after you install the plugin makes the folder,
tracing on or off, with a `README.txt` saying what it holds. Nothing in it is ever
deleted for you: delete the folder to remove every trace, and the next session
makes it again, empty. The Trace tab shows its full path, and **Open traces
folder** opens it in Explorer (on Windows, and from WSL), Finder, or your Linux
desktop's file manager through `xdg-open`.

A trace holds the whole conversation, file contents and command output included.
Unless telemetry goes elsewhere as above, it never leaves your machine. On macOS
and Linux the traces folder is yours alone (mode 700); anyone who can read your
files can still read it. On a machine you share with other users, another user
could send the receiver records of their own, or, while no receiver runs, listen
on its port in its place.

![The Context details pane: its tabs, and the Tools tab's In context group with Remove beside each tool](docs/context-pane.png)

It draws on the desktop surface only. In the terminal it stays out of the way,
so a `statusLine` command in your settings keeps working there.

## Install in the Claude desktop app

Everything happens inside the app. No terminal needed.

**1. Open the plugin settings.** In the Claude desktop app, open **Settings**
and choose **Plugins** in the sidebar, under _Customize_.

**2. Add this marketplace.** Click the **Add** button at the top right, then
**Add marketplace**, then **Add from a repository**. Paste the repository URL:

```
https://github.com/jiroamato/claude-mods
```

Press **Sync**. The app fetches the catalogue and **claude-mods** joins your
marketplaces.

**3. Install the plugin.** **Desktop statusline** by Jiro Amato now appears in
the list. Click its **Add** button and pick a scope:

- **Install for me** puts it in `~/.claude/`, so the band is on in every
  project on this machine. This is the one to choose for a status bar.
- **Install for project (shared)** or **(personal)** limits it to the current
  project instead.

**4. Start a new session.** Open a fresh Code session and the band appears
above the prompt. Running sessions keep what they had until they end.

**Later.** Enable, disable or remove it from the same **Plugins** page, through
the menu at the end of its row. Marketplaces are managed under **Add >
Manage marketplaces**, and new versions published here arrive through a sync.

<details>
<summary>Prefer the terminal?</summary>

The terminal and the desktop app share one plugin configuration, so these two
commands give the same result:

```bash
claude plugin marketplace add jiroamato/claude-mods
```

```bash
claude plugin install desktop-statusline@claude-mods
```

</details>

## Develop

Function hooks are an early-access API: the surface may change between Claude
Code releases, and the plugin is written against the version named in each
release's notes. Each plugin folder is self-contained:

```
desktop-statusline/
  .claude-plugin/plugin.json   manifest
  hooks/hooks.json             names the hooks module
  hooks/register.tsx           the mod: hooks, state and the band's tree
  hooks/panel.tsx              the Context details pane
  hooks/tabs.tsx               a tab of the pane, a region of its own
  hooks/context.ts             the window broken down as /context counts it
  hooks/tools.ts               tool summaries, sizes and the settings deny edit
  hooks/trace.ts               tracing's settings, and a trace read for the pane
  trace/receiver.mjs           the trace receiver, run with Node
  trace/store.mjs              what the receiver keeps of each request
  trace/view.mjs               the receiver's pages for the browser
  types/index.d.ts             its state contract
  tests/                       run with `claude plugin test`
```

Validate, test and type-check a plugin by passing its folder:

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

See [CONTRIBUTING.md](CONTRIBUTING.md) for the contributor workflow.

## License

MIT

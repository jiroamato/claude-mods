import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Effort, GitInfo } from '../types'
import { buildSnapshot } from './context'
import { ContextPane, HoverCard, PANE_ID, PANE_TITLE } from './panel'
import {
  deniedTools,
  editDeny,
  KEPT_TOOLS,
  parseSettings,
  SettingsShapeError,
  toolRows,
} from './tools'

// Mirrors a terminal status line on the desktop
// surface, drawn as one band above the prompt. Colours are theme keys, so
// the band follows the app's light and dark palettes and its accent:
//
//   Fable 5.1 │ high │ construct-land | main •        [▮▮▮▮      ] 33% │ $1.23 │ 12m 4s
//
// Hovering the meter reveals a map of what fills the context window. The
// percentage opens the Context pane, which lists the built-in tools, each of
// which can be removed from the window and put back, and the skills.

const tick = atom({ plugin: 'desktop-statusline', key: 'tick' } as const, 0)
const git = atom({ plugin: 'desktop-statusline', key: 'git' } as const, null)
const effort = atom({ plugin: 'desktop-statusline', key: 'effort' } as const, null)
const context = atom({ plugin: 'desktop-statusline', key: 'context' } as const, null)
const tools = atom({ plugin: 'desktop-statusline', key: 'tools' } as const, {})
const removed = atom({ plugin: 'desktop-statusline', key: 'removed' } as const, [])
const putBack = atom({ plugin: 'desktop-statusline', key: 'putBack' } as const, [])
const toolError = atom({ plugin: 'desktop-statusline', key: 'toolError' } as const, null)
/** The store key under which a built-in tool's description is kept across sessions. */
const KNOWN_TOOL_PREFIX = 'tool-description:'

const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
const EFFORT_LABEL: Record<Effort, string> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'x-high',
  max: 'max',
}
// Quiet for cheap, through the text colour, to the warning and error tones
// for the two top levels, so the intensity reads at a glance.
const EFFORT_COLOR: Record<Effort, string> = {
  low: 'inactive',
  medium: 'secondaryText',
  high: 'text',
  xhigh: 'warning',
  max: 'error',
}

// The context meter: a hollow rounded rectangle, filled from the left.
const METER_WIDTH = 64
const METER_HEIGHT = 10
const METER_STROKE = 1
const METER_OUTLINE = '#8a8a8a'
const METER_FILL = '#c19c00'
// The hairline between the band's figures: two pixels wide, a solid dark
// grey a few shades off the dark band's background, so it sits back as a
// faint seam rather than a drawn line.
const DIVIDER_WIDTH = 2
const DIVIDER_HEIGHT = 14
const DIVIDER_COLOR = '#333333'
const DIVIDER_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" width="${DIVIDER_WIDTH}" height="${DIVIDER_HEIGHT}" viewBox="0 0 ${DIVIDER_WIDTH} ${DIVIDER_HEIGHT}">` +
  `<rect width="${DIVIDER_WIDTH}" height="${DIVIDER_HEIGHT}" fill="${DIVIDER_COLOR}"/>` +
  `</svg>`
const GIT_REFRESH_EVERY_TICKS = 15
// The widest reading the timer draws (`59m 59s`, `23h 59m`), so the slot
// holds its width as the digits change and nothing to its left shifts. The
// reading sits at the slot's left, so its gap from the hairline matches the
// other figures' and the spare width falls against the band's edge.
const ELAPSED_COLUMNS = 7
// The pane's map, in CSS pixels: the docked pane's default width less its padding.
const PANE_MAP_WIDTH = 410
// How long the pane takes to redraw after a change, before scrolling it.
const PANE_SETTLE_MS = 300
// How long after a press in the pane a jump of its window is the desktop's.
const PRESS_JUMP_WINDOW_MS = 2000

function asEffort(value: unknown): Effort | null {
  if (typeof value !== 'string') return null
  const lower = value.toLowerCase()

  return (EFFORTS as readonly string[]).includes(lower) ? (lower as Effort) : null
}

function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))

  return index === -1 ? trimmed : trimmed.slice(index + 1)
}

/** `claude-fable-5-1` -> `Fable 5.1`; a name already spelled for display is kept. */
function prettyModel(model: string): string {
  if (/\s/.test(model) || /[A-Z]/.test(model)) return model
  const parts = model
    .replace(/^claude-/, '')
    .split('-')
    .filter(Boolean)
  if (parts.length === 0) return model
  const words: string[] = []
  const digits: string[] = []
  for (const part of parts) {
    if (/^\d+$/.test(part)) digits.push(part)
    else if (digits.length === 0) words.push(part[0]!.toUpperCase() + part.slice(1))
  }
  const name = words.join(' ')

  return digits.length > 0 ? `${name} ${digits.join('.')}` : name
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)

  return `${hours}h ${minutes % 60}m`
}

/** The meter's markup: a grey rounded outline, the fill clipped to its inside. */
function meterSvg(percent: number | undefined): string {
  const w = METER_WIDTH
  const h = METER_HEIGHT
  const s = METER_STROKE
  const radius = h / 2
  const innerWidth = w - 2 * s
  const innerHeight = h - 2 * s
  const filled = Math.round((Math.max(0, Math.min(100, percent ?? 0)) / 100) * innerWidth)

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<defs><clipPath id="inside"><rect x="${s}" y="${s}" width="${innerWidth}" height="${innerHeight}" rx="${radius - s}"/></clipPath></defs>` +
    `<rect x="${s}" y="${s}" width="${filled}" height="${innerHeight}" fill="${METER_FILL}" clip-path="url(#inside)"/>` +
    `<rect x="${s / 2}" y="${s / 2}" width="${w - s}" height="${h - s}" rx="${radius}" fill="none" stroke="${METER_OUTLINE}" stroke-width="${s}"/>` +
    `</svg>`
  )
}

async function refreshGit($: EngineInterface): Promise<void> {
  let next: GitInfo = null
  try {
    const cwd = await $.session.cwd()
    const head = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      timeoutMs: 3000,
    })
    if (head.exitCode === 0) {
      const branch = head.stdout.trim()
      const status = await $.process.run(['git', 'status', '--porcelain'], {
        cwd,
        timeoutMs: 5000,
      })
      const isDirty = status.exitCode === 0 && status.stdout.trim().length > 0
      next = { branch, isDirty }
    }
  } catch {
    next = null
  }
  await update($, git, () => next)
}

/** The effort the session is configured with, when no request has told us yet. */
async function configuredEffort($: EngineInterface): Promise<Effort | null> {
  try {
    const row = (await $.config.list()).find(one => /effort/i.test(one.key))
    const fromConfig = asEffort(row?.value)
    if (fromConfig) return fromConfig
  } catch {
    // the menu may not be listable here; fall through to settings
  }
  try {
    const settings = await $.settings.read()
    const model = (await $.session.model()).toLowerCase()
    const perModel = settings.modelSettings
    if (perModel && typeof perModel === 'object') {
      for (const [id, value] of Object.entries(perModel as Record<string, unknown>)) {
        const lower = id.toLowerCase()
        const isMatch = lower === model || lower.includes(model) || model.includes(lower)
        if (isMatch && value && typeof value === 'object') {
          const found = asEffort((value as Record<string, unknown>).effortLevel)
          if (found) return found
        }
      }
    }

    return asEffort(settings.effortLevel)
  } catch {
    return null
  }
}

/** The user settings file, which `/permissions` and the settings UI also write. */
async function settingsPath($: EngineInterface): Promise<string> {
  const configDir = await $.env.get('CLAUDE_CONFIG_DIR')
  if (configDir) return `${configDir}/settings.json`
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  if (!home)
    throw new SettingsShapeError('Cannot find your home folder, so settings.json was not changed.')

  return `${home}/.claude/settings.json`
}

// Reads and writes of the settings file run one at a time, so two quick presses
// cannot both read the file before either writes it.
let settingsQueue: Promise<unknown> = Promise.resolve()

function serially<T>(task: () => Promise<T>): Promise<T> {
  const run = settingsQueue.then(task, task)
  settingsQueue = run.catch(() => undefined)

  return run
}

async function readSettingsText($: EngineInterface): Promise<string> {
  const path = await settingsPath($)

  return (await $.fs.exists(path)) ? String(await $.fs.read(path)) : ''
}

/**
 * Re-reads which tools the user settings deny, from the file itself, and
 * re-describes the tools when that changed, so a hand edit applies here too.
 */
function refreshRemoved($: EngineInterface): Promise<void> {
  return serially(async () => {
    try {
      const names = deniedTools(parseSettings(await readSettingsText($)))
      const before = await read($, removed)
      if (names.length === before.length && names.every(one => before.includes(one))) return
      await update($, removed, () => names)
      $.ui.invalidate('tool.describe')
    } catch {
      // An unreadable settings file leaves the last reading in place.
    }
  })
}

/** Reads the context window broken down, for the hover card and the pane. */
async function refreshContext($: EngineInterface): Promise<void> {
  try {
    const usage = await $.session.usage({ breakdown: 'summary' })
    const breakdown = usage.context.breakdown
    if (!breakdown) return
    const [messages, commands] = await Promise.all([$.session.messages(), $.command.list()])
    const snapshot = buildSnapshot(breakdown, messages, commands)
    await update($, context, () => snapshot)
  } catch {
    // The session could not be read just now; the next turn tries again.
  }
}

/**
 * Removes a built-in tool, or puts it back: the deny rule in the user settings
 * for new sessions, and the tool's schema moved out of (or back into) this
 * session's context at once.
 */
async function setRemoved($: EngineInterface, name: string, shouldRemove: boolean): Promise<void> {
  const isWritten = await serially(async () => {
    try {
      const path = await settingsPath($)
      const text = await readSettingsText($)
      const next = editDeny(text, name, shouldRemove)
      if (next !== text) await $.fs.write(path, next)
    } catch (error) {
      const reason =
        error instanceof SettingsShapeError
          ? error.message
          : `Could not update settings.json: ${String(error)}`
      await update($, toolError, () => reason)

      return false
    }
    await update($, toolError, () => null)
    await update($, removed, names =>
      shouldRemove
        ? [...names.filter(one => one !== name), name]
        : names.filter(one => one !== name),
    )

    return true
  })
  if (!isWritten) return
  const seen = await read($, tools)
  if (name in seen) {
    $.ui.invalidate('tool.describe')
  } else {
    await update($, putBack, names =>
      shouldRemove
        ? names.filter(one => one !== name)
        : [...names.filter(one => one !== name), name],
    )
  }
  await refreshContext($)
}

/**
 * Opens the Context pane at its top, with the deny list and the map read
 * afresh: the settings may have been edited by hand since the session began,
 * and the window may have moved since the last turn (a /compact).
 */
async function openPane($: EngineInterface): Promise<void> {
  try {
    // Focused, so the first click in the pane presses its button: an
    // unfocused pane spends that click on taking the focus.
    await $.ui.open({ id: PANE_ID, title: PANE_TITLE, focus: true })
    await Promise.all([refreshRemoved($), refreshContext($)])
    await $.clock.sleep(PANE_SETTLE_MS)
    await $.ui.scroll({ in: PANE_ID, to: 'start' })
  } catch {
    // Unloaded or closed meanwhile; the next press opens it again.
  }
}

export const register: Register = on => {
  /** When a Remove or Put back was last pressed in the pane, in epoch ms. */
  let lastPaneToggleAt = Number.NEGATIVE_INFINITY
  /** Descriptions of built-in tools seen in any session, read from the store at start. */
  const knownTools: Record<string, string> = {}

  on('session.start', async ($, e, next) => {
    const started = await next(e)

    void (async () => {
      const configured = await configuredEffort($)
      await update($, effort, current => current ?? configured)
      await refreshGit($)
      await refreshRemoved($)
      await refreshContext($)
    })()
    void (async () => {
      for (const key of await $.store.keys()) {
        if (!key.startsWith(KNOWN_TOOL_PREFIX)) continue
        const description = await $.store.get(key)
        if (typeof description === 'string') {
          knownTools[key.slice(KNOWN_TOOL_PREFIX.length)] = description
        }
      }
    })().catch(() => {
      // No store here: tools removed in earlier sessions fall back to the catalog.
    })

    $.clock.every(1000, () => {
      void (async () => {
        const count = await update($, tick, n => n + 1)
        if (count % GIT_REFRESH_EVERY_TICKS === 0) await refreshGit($)
      })()
    })

    return started
  })

  // The live effort of each main-loop request, as the engine sends it.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      const level = asEffort(e.effort)
      if (level) void update($, effort, () => level)
    }

    return yield* next(e)
  })

  // A turn may have committed, switched branch or touched files: re-read git.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      void refreshGit($)
      void refreshContext($)
    }

    return next(e)
  })

  // Every built-in tool's description, as the model reads it; a tool removed
  // in the pane is moved behind ToolSearch, out of the context window.
  on('tool.describe', async ($, e, next) => {
    const described = await next(e)
    if (e.provider.plugin !== 'engine') return described
    const description = described.description
    const isDeferred = described.isDeferred ?? e.isDeferred === true
    const was = (await read($, tools))[e.tool]
    if (was?.description !== description || was?.isDeferred !== isDeferred) {
      await update($, tools, all => ({ ...all, [e.tool]: { description, isDeferred } }))
    }
    if (knownTools[e.tool] !== description) {
      knownTools[e.tool] = description
      await $.store.set(`${KNOWN_TOOL_PREFIX}${e.tool}`, description)
    }
    const isRemoved = (await read($, removed)).includes(e.tool) && !KEPT_TOOLS.includes(e.tool)

    return isRemoved ? { ...described, isDeferred: true } : described
  })

  // A removed tool the model loads through ToolSearch anyway is refused. When
  // the state cannot be read the call goes ahead: this guard never blocks work
  // the person did not ask to block.
  on('tool.call', async ($, e, next) => {
    const names = await read($, removed)
    if (names.includes(e.tool) && !KEPT_TOOLS.includes(e.tool)) {
      return {
        deny: `The user removed ${e.tool} from this session; do not retry it. They can put it back in the Context pane.`,
      }
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  // The desktop answers a press in the pane by jumping its window to the end,
  // reported as the person's own scroll; the window stays where they had it.
  on('ui.scroll', { requestId: PANE_ID }, async ($, e, next) => {
    const isJump = e.origin.kind === 'person' && !e.pointer && Math.abs(e.by) > e.bodyRows
    if (isJump && (await $.clock.now()) - lastPaneToggleAt < PRESS_JUMP_WINDOW_MS) return {}

    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    if (e.surface !== 'desktop') {
      const { Text } = $.ui.resolve(e)

      return <Text>The context map draws in the desktop app.</Text>
    }
    const ui = $.ui.resolve(e)
    const [snapshot, seen, names, back, error] = await Promise.all([
      read($, context),
      read($, tools),
      read($, removed),
      read($, putBack),
      read($, toolError),
    ])

    return ContextPane({
      ui,
      snapshot,
      tools: toolRows(seen, knownTools, names, back),
      mapWidth: PANE_MAP_WIDTH,
      error,
      onToggle: (name, shouldRemove) =>
        void (async () => {
          lastPaneToggleAt = await $.clock.now()
          await setRemoved($, name, shouldRemove)
          // A slow write may outlast the window; the desktop's jump follows the redraw.
          lastPaneToggleAt = await $.clock.now()
        })().catch(error => update($, toolError, () => String(error))),
    })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // The CLI already has its own status line; this band is for the desktop.
    if (e.surface !== 'desktop' || e.props.hasSurvey) return next(e)

    const ui = $.ui.resolve(e)
    const { Box, Button, Svg, Text } = ui

    // Subscribes this drawing to the once-a-second tick.
    await read($, tick)
    const [model, cwd, usage, repo, level, now, snapshot] = await Promise.all([
      $.session.model(),
      $.session.cwd(),
      $.session.usage(),
      read($, git),
      read($, effort),
      $.clock.now(),
      read($, context),
    ])

    const folder = basename(cwd)
    const percent = usage.context.percent
    const usd = usage.cost?.usd
    const elapsed = now - usage.startedAt

    const hasPlace = folder !== '' || repo !== null
    const divider = () => (
      <Svg source={DIVIDER_SVG} alt="divider" width={DIVIDER_WIDTH} height={DIVIDER_HEIGHT} />
    )

    return (
      <Box flexDirection="row" flexWrap="wrap" alignItems="center" paddingX={1} columnGap={3}>
        {/* Identity: what is answering, how hard, and where, a hairline between each. */}
        <Box flexDirection="row" alignItems="center" columnGap={2}>
          <Text color="claude" bold>
            {prettyModel(model)}
          </Text>
          {level !== null && divider()}
          {level !== null && <Text color={EFFORT_COLOR[level]}>{EFFORT_LABEL[level]}</Text>}
          {hasPlace && divider()}
          {hasPlace && (
            <Box flexDirection="row" alignItems="center" columnGap={1}>
              {folder !== '' && <Text color="text">{folder}</Text>}
              {folder !== '' && repo !== null && <Text color="inactive">|</Text>}
              {repo !== null && <Text color="secondaryText">{repo.branch}</Text>}
              {repo?.isDirty && <Text color="warning">•</Text>}
            </Box>
          )}
        </Box>

        <Box flexGrow={1} />

        {/* Live figures: context, cost, elapsed, a hairline between each. */}
        <Box flexDirection="row" alignItems="center" columnGap={2}>
          {/* Hovering the meter reveals the context map; the percentage opens the pane. */}
          <Box flexDirection="row" alignItems="center" columnGap={1}>
            <Box key="context-meter" flexDirection="row" alignItems="center">
              <Box
                position="absolute"
                bottom={2}
                right={0}
                display="none"
                hover={{ display: 'flex' }}
                flexDirection="column"
                borderStyle="round"
                borderColor="inactive"
                backgroundColor="background"
                paddingX={1}
              >
                {HoverCard({ ui, snapshot })}
              </Box>
              <Svg
                source={meterSvg(percent)}
                alt={percent === undefined ? 'context: no reading yet' : `context ${percent}% used`}
                width={METER_WIDTH}
                height={METER_HEIGHT}
              />
            </Box>
            <Button
              key="open-context"
              plain
              label={percent === undefined ? '--%' : `${percent}%`}
              onPress={() => openPane($)}
            />
          </Box>

          {usd !== undefined && divider()}
          {usd !== undefined && <Text color="text">${usd.toFixed(2)}</Text>}

          {divider()}
          <Box width={ELAPSED_COLUMNS} justifyContent="flex-start">
            <Text color="secondaryText">{formatDuration(elapsed)}</Text>
          </Box>
        </Box>
      </Box>
    )
  })
}

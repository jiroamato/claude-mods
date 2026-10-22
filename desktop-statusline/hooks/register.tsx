import { atom, read, update } from 'claude-code'
import type { EngineInterface, PromptComposeSection, Register } from 'claude-code'

import type {
  Effort,
  GitInfo,
  PaneTab,
  TraceItem,
  TracePlaces,
  TraceState,
  TraceStatus,
} from '../types'
import { buildSnapshot, currentSnapshot } from './context'
import { showFolder } from './folder'
import {
  ContextPane,
  DISCLOSURE_PREFIX,
  GROUP_PREFIX,
  PANE_ID,
  PANE_TITLE,
  READER_KEY,
  readerVisibleRows,
} from './panel'
import type { ReaderView } from './panel'
import { READER_TEXT_KEY } from './text'
import type { TextPick } from './text'
import type { DisclosurePick } from './disclosure'
import type { ReaderBarPick } from './reader'
import { TAB_PREFIX } from './tabs'
import type { TabPick } from './tabs'
import type { RowMatch, TraceRecord } from './trace'
import {
  currentTrace,
  differingNames,
  editTraceEnv,
  isMainSource,
  isRoutedHere,
  isTraceOn,
  RECEIVER_HEALTH,
  RECEIVER_NAME,
  requestText,
  findMatches,
  fromHead,
  promptRecord,
  replacedNames,
  sentPrompt,
  sourceLabel,
  summarize,
  wholeRequestText,
  wrapRows,
  TRACE_ENV,
  TRACE_PORT,
} from './trace'
import {
  deniedTools,
  editDeny,
  isPlainObject,
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
// The percentage opens the Context details pane, for what the desktop's own
// Context card cannot show: the built-in tools, which can be removed from the
// window and put back, the system prompt's text, the skills' listings and the
// conversation's trace.

const tick = atom({ plugin: 'desktop-statusline', key: 'tick' } as const, 0)
const git = atom({ plugin: 'desktop-statusline', key: 'git' } as const, null)
const effort = atom({ plugin: 'desktop-statusline', key: 'effort' } as const, null)
const context = atom({ plugin: 'desktop-statusline', key: 'context' } as const, null)
const expanded = atom({ plugin: 'desktop-statusline', key: 'expanded' } as const, [])
const collapsed = atom({ plugin: 'desktop-statusline', key: 'collapsed' } as const, [])
const page = atom({ plugin: 'desktop-statusline', key: 'page' } as const, 0)
const reader = atom({ plugin: 'desktop-statusline', key: 'reader' } as const, null)
const readerSearch = atom({ plugin: 'desktop-statusline', key: 'readerSearch' } as const, {
  query: '',
  index: 0,
})
const readerOffset = atom({ plugin: 'desktop-statusline', key: 'readerOffset' } as const, 0)
const tab = atom({ plugin: 'desktop-statusline', key: 'tab' } as const, 'tools' as PaneTab)
const PANE_TABS: readonly PaneTab[] = ['tools', 'prompt', 'skills', 'trace']
const NO_TRACE: TraceState = {
  status: 'off',
  items: [],
  prompt: null,
  view: null,
  replaced: [],
  differing: [],
}
const trace = atom({ plugin: 'desktop-statusline', key: 'trace' } as const, NO_TRACE)
const traceError = atom({ plugin: 'desktop-statusline', key: 'traceError' } as const, null)
const folderError = atom({ plugin: 'desktop-statusline', key: 'folderError' } as const, null)
/** The store key under which what tracing found under its names is kept, to give back. */
const TRACE_ENV_BEFORE = 'trace-env-before'
/** Said when off had nothing noted to give back, so took tracing's values out alone. */
const TRACE_ENV_LOST =
  'Tracing is off, but what you had under its settings before it was turned on was not found ' +
  '(the plugin’s store was cleared, or another copy of the plugin turned it on), so its values ' +
  'were taken out and none of yours put back. Check the `env` block of settings.json.'
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
// How long the pane takes to redraw after a change, before scrolling it.
const PANE_SETTLE_MS = 300

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

/**
 * The person's home folder: the profile on Windows, `HOME` elsewhere. WSL can
 * be given the Windows profile's variable too (WSLENV), and its Claude Code
 * keeps its settings in the Linux home, not there.
 */
async function homeDir($: EngineInterface): Promise<string> {
  const [profile, unixHome] = [await $.env.get('USERPROFILE'), await $.env.get('HOME')]
  const home =
    (await $.env.get('OS')) === 'Windows_NT' ? (profile ?? unixHome) : (unixHome ?? profile)
  if (!home) throw new SettingsShapeError('Cannot find your home folder: HOME is not set.')

  return home
}

/** The user's Claude configuration folder: `$CLAUDE_CONFIG_DIR`, else `~/.claude`. */
async function configDir($: EngineInterface): Promise<string> {
  const configured = await $.env.get('CLAUDE_CONFIG_DIR')
  if (configured) return configured

  return `${await homeDir($)}/.claude`
}

/** The user settings file, which `/permissions` and the settings UI also write. */
async function settingsPath($: EngineInterface): Promise<string> {
  return `${await configDir($)}/settings.json`
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

/** The system prompt's sections as the session composes them; none when it cannot be read. */
async function composedPrompt($: EngineInterface): Promise<readonly PromptComposeSection[]> {
  try {
    return (await $.prompt.compose()).sections
  } catch {
    return []
  }
}

/**
 * Reads the context window broken down, for the pane, counted with the
 * token-count API as /context counts it so the two agree.
 */
async function refreshContext($: EngineInterface): Promise<void> {
  try {
    const usage = await $.session.usage({ breakdown: 'full' })
    const breakdown = usage.context.breakdown
    if (!breakdown) return
    const [commands, sections] = await Promise.all([$.command.list(), composedPrompt($)])
    const snapshot = buildSnapshot(breakdown, commands, sections)
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
 * Where the trace receiver keeps each session's requests: always
 * `~/.claude/desktop-statusline/traces`, whatever `$CLAUDE_CONFIG_DIR` says.
 * One receiver serves every session on the machine, so its folder is one
 * too, and the person always knows where to find it, or delete it.
 */
async function traceRoot($: EngineInterface): Promise<string> {
  return `${await homeDir($)}/.claude/desktop-statusline/traces`
}

/** What the traces folder says it is, to whoever comes across it. */
const TRACES_README =
  'Traces of desktop-statusline, a plugin for Claude Code.\n' +
  '\n' +
  'With tracing on (the Trace tab of its Context details pane), every request a\n' +
  'Claude Code session sends to the model is kept here, a folder per session, until\n' +
  'you delete it. They hold the whole conversation, file contents and command output\n' +
  'included, and never leave this machine.\n' +
  '\n' +
  'Delete this folder to remove every trace. The next session makes it again, empty.\n'

/**
 * Makes the traces folder if it is missing, so the path the Trace tab names
 * leads somewhere from the first session after install, tracing on or off.
 * The engine makes a folder only for a file written in it: the folder's one
 * is a note on what it holds.
 */
async function ensureTraceFolder($: EngineInterface): Promise<void> {
  const root = await traceRoot($)
  if (!(await $.fs.exists(root))) await $.fs.write(`${root}/README.txt`, TRACES_README)
}

/**
 * Opens the traces folder in the system's file manager (./folder.ts). The
 * folder is made first, so there is always one to open.
 */
async function showTraceFolder($: EngineInterface): Promise<void> {
  try {
    await ensureTraceFolder($)
    await showFolder($, await traceRoot($))
    await update($, folderError, () => null)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    await update($, folderError, () => `Could not open the traces folder: ${reason}`)
  }
}

/** The files tracing touches, as the Trace tab names them; null where no home folder is set. */
async function tracePlaces($: EngineInterface): Promise<TracePlaces | null> {
  try {
    return { settings: await settingsPath($), traces: await traceRoot($) }
  } catch {
    return null
  }
}

/** How long the receiver gets to answer once started, before it counts as failed. */
const RECEIVER_START_MS = 3000
const RECEIVER_POLL_MS = 150
/** How long after a turn its last answer has surely been exported. */
const TRACE_SETTLE_MS = 2500

/**
 * Which receiver answers on the port: this plugin's, an older or a newer one
 * of it, another server, or none. A newer one, from a plugin updated in
 * another session, is left to serve: the two would otherwise take turns
 * replacing each other.
 */
async function receiverOnPort(
  $: EngineInterface,
): Promise<'current' | 'older' | 'newer' | 'other' | 'none'> {
  let answer
  try {
    answer = await $.http.fetch(`http://127.0.0.1:${TRACE_PORT}/health`)
  } catch {
    return 'none'
  }
  if (answer.ok && answer.text === RECEIVER_HEALTH) return 'current'
  const theirs = receiverVersion(answer.text)
  const ours = receiverVersion(RECEIVER_HEALTH)!
  if (!answer.ok || theirs === null) return 'other'

  return theirs < ours ? 'older' : 'newer'
}

/** The version a receiver's health text names, or null for another server's. */
function receiverVersion(text: string): number | null {
  const match = new RegExp(`^${RECEIVER_NAME} (\\d+)$`).exec(text.trim())

  return match ? Number(match[1]) : null
}

/** The token the running receiver's pages answer to, which it writes beside the traces. */
async function viewToken($: EngineInterface): Promise<string | null> {
  try {
    const token = String(await $.fs.read(`${await traceRoot($)}/.view-token`)).trim()

    return /^[0-9a-f]{32}$/.test(token) ? token : null
  } catch {
    return null
  }
}

async function isReceiverUp($: EngineInterface): Promise<boolean> {
  const found = await receiverOnPort($)

  return found === 'current' || found === 'newer'
}

/**
 * Makes sure a trace receiver listens: one serves every session on the
 * machine, so one already up is used. Else this session starts one with Node,
 * which runs for the session's life; when that session ends, the next one to
 * check starts another.
 */
async function ensureReceiver($: EngineInterface): Promise<TraceStatus> {
  const found = await receiverOnPort($)
  if (found === 'current' || found === 'newer') return 'on'
  if (found === 'other') return 'unreachable'
  if (found === 'older') {
    // An older receiver serves the trace as it was: asked to leave, it frees the port.
    const token = await viewToken($)
    if (token) {
      await $.http
        .fetch(`http://127.0.0.1:${TRACE_PORT}/quit?t=${token}`, { method: 'POST' })
        .catch(() => undefined)
    }
    for (let waited = 0; waited < RECEIVER_START_MS; waited += RECEIVER_POLL_MS) {
      if ((await receiverOnPort($)) === 'none') break
      await $.clock.sleep(RECEIVER_POLL_MS)
    }
  }
  let hasFailed = false
  try {
    const child = $.process.spawn({
      argv: ['node', `${$.plugin.root}/trace/receiver.mjs`, await traceRoot($), String(TRACE_PORT)],
    })
    void (async () => {
      try {
        for await (const _piece of child) {
          // Its output is not read; the loop holds the child for the session.
        }
      } catch {
        hasFailed = true
      }
    })()
  } catch {
    return 'no-node'
  }
  for (let waited = 0; waited < RECEIVER_START_MS; waited += RECEIVER_POLL_MS) {
    if (hasFailed) return 'no-node'
    await $.clock.sleep(RECEIVER_POLL_MS)
    if (await isReceiverUp($)) return 'on'
  }

  // Node ran, but nothing answers: the port is another program's, or the
  // receiver stopped (it could not make its folder).
  return hasFailed ? 'no-node' : 'unreachable'
}

/**
 * Requests read from this session's trace folder, by file name, with what
 * each was read at: its file's time, and its head's for one read from that.
 * A `/clear` or a resume goes on in the same process under a new session id,
 * so the cache is the session's it was read for.
 */
const traceCache = new Map<string, { stamp: string; item: TraceItem; record: TraceRecord }>()
let traceSession: string | null = null
const systemCache = new Map<string, { type: string; text: string }[]>()
let traceQueue: Promise<unknown> = Promise.resolve()
/**
 * The largest file `$.fs.read` reads: a larger request is read from its head
 * (`<seq>.head.json`, which the receiver writes for a large one), or listed by
 * its number alone when it has none.
 */
const MAX_READ_BYTES = 4 * 1024 * 1024

/** A request too large to read here, with no head: listed for the browser, where it opens. */
function unreadRecord(name: string, at: number): TraceRecord {
  return {
    seq: Number(name.slice(0, 6)),
    at: new Date(at).toISOString(),
    source: 'unknown',
    model: '',
    promptId: null,
    system: null,
    tools: null,
    toolCount: 0,
    messageCount: 0,
    from: 0,
    added: [],
    tooLarge: true,
    usage: null,
    response: null,
  }
}

/** Starts the caches afresh when the session they were read for is not this one. */
async function traceFolder($: EngineInterface): Promise<{ session: string; folder: string }> {
  const session = await $.session.id()
  if (session !== traceSession) {
    traceCache.clear()
    readerCache = null
    matchCache = null
    traceSession = session
  }

  return { session, folder: `${await traceRoot($)}/${session}` }
}

/**
 * Whether this process's telemetry started sending its log events to the
 * receiver, read from its environment at the module's first `session.start`,
 * which fires before the first prompt: the settings' `env` as the process
 * started, since a later change to the settings reaches its environment but
 * not its telemetry. Null before it is read, or when it could not be.
 */
let startedTraced: Promise<boolean | null> = Promise.resolve(null)
let hasReadStart = false

/** Reads whether telemetry was sent here as this process started; once, at the first `session.start`. */
function readStartedTraced($: EngineInterface): void {
  if (hasReadStart) return
  hasReadStart = true
  startedTraced = (async () =>
    isRoutedHere({
      CLAUDE_CODE_ENABLE_TELEMETRY: await $.env.get('CLAUDE_CODE_ENABLE_TELEMETRY'),
      OTEL_LOGS_EXPORTER: await $.env.get('OTEL_LOGS_EXPORTER'),
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: await $.env.get('OTEL_EXPORTER_OTLP_LOGS_ENDPOINT'),
    }))().catch(() => null)
}

/**
 * Reads this session's trace from the receiver's folder: what tracing's
 * switch says, every request recorded, and the system prompt the last main
 * request sent. One reading at a time; a request already read is read again
 * only when its file changed (its answer arrived).
 */
function refreshTrace($: EngineInterface): Promise<void> {
  const run = traceQueue.then(async () => {
    try {
      const settings = parseSettings(await readSettingsText($))
      let status: TraceStatus = isTraceOn(settings) ? await ensureReceiver($) : 'off'
      // Another endpoint wins over the one tracing sets (managed settings, a
      // variable of the person's own): the requests go there, not here.
      const endpoint = await $.env.get('OTEL_EXPORTER_OTLP_LOGS_ENDPOINT')
      if (status === 'on' && endpoint && endpoint !== TRACE_ENV.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT) {
        status = 'elsewhere'
      }
      // Tracing's names the settings hold otherwise, changed by hand while it is on.
      const differing = status === 'off' ? [] : differingNames(settings)
      // The person's own values tracing holds in place of while it is on: one
      // changed by hand since is no longer tracing's, and off leaves it be.
      const replaced =
        status === 'off'
          ? []
          : replacedNames(await $.store.get(TRACE_ENV_BEFORE).catch(() => undefined)).filter(
              name => !differing.includes(name),
            )
      if (status !== 'on') {
        // Off, the list goes: what it held is no longer this tab's to show.
        await update($, trace, kept => {
          // What is kept may be an earlier version's: read in this one's shape.
          const current = currentTrace(kept)

          return {
            ...current,
            status,
            items: status === 'off' ? [] : current.items,
            replaced,
            differing,
          }
        })
        return
      }
      const { session, folder } = await traceFolder($)
      const entries = (await $.fs.exists(folder)) ? await $.fs.list(folder) : []
      // Telemetry starts with the process: one already running when tracing was
      // turned on exports nothing, though its environment says otherwise once
      // the settings change. A session that has taken a turn and has no trace
      // is such a one, unless its telemetry started pointed here: then its
      // folder was deleted meanwhile, or its requests were not recorded.
      const turns = await $.session.turns().catch(() => 0)
      if (entries.length === 0 && turns > 0) {
        status = (await startedTraced) ? 'emptied' : 'next-session'
      }
      const byName = new Map(entries.map(entry => [entry.name, entry]))
      // A request the person deleted goes from the list too.
      for (const name of traceCache.keys()) if (!byName.has(name)) traceCache.delete(name)
      // A request's file, not a head beside it: those are read in its place.
      for (const entry of entries) {
        if (!/^\d{6}\.json$/.test(entry.name)) continue
        const isLarge = entry.size > MAX_READ_BYTES
        const head = isLarge ? byName.get(entry.name.replace(/\.json$/, '.head.json')) : undefined
        const stamp = `${entry.mtimeMs}:${head?.mtimeMs ?? ''}`
        const cached = traceCache.get(entry.name)
        if (cached && cached.stamp === stamp) continue
        try {
          let record: TraceRecord
          if (!isLarge) {
            record = JSON.parse(String(await $.fs.read(`${folder}/${entry.name}`))) as TraceRecord
          } else if (head && head.size <= MAX_READ_BYTES) {
            record = fromHead(
              JSON.parse(String(await $.fs.read(`${folder}/${head.name}`))) as TraceRecord,
            )
          } else {
            record = unreadRecord(entry.name, entry.mtimeMs)
          }
          traceCache.set(entry.name, { stamp, item: summarize(record), record })
        } catch {
          // Being written: the next reading tries again.
        }
      }
      const records = [...traceCache.values()].sort((a, b) => a.item.seq - b.item.seq)
      // The last main request's prompt: a request that went on from the one
      // before carried none of its own, only the billing header.
      const last = records.findLast(one => isMainSource(one.record.source))?.record
      const main = last
        ? promptRecord(
            records.map(one => one.record),
            last.seq,
          )
        : null
      let prompt: TraceState['prompt'] = null
      if (main?.system) {
        let blocks = systemCache.get(main.system)
        if (!blocks) {
          try {
            blocks = JSON.parse(
              String(await $.fs.read(`${folder}/system-${main.system}.json`)),
            ) as {
              type: string
              text: string
            }[]
            systemCache.set(main.system, blocks)
          } catch {
            // Deleted, or not written yet: the Prompt tab shows the composed sections.
          }
        }
        if (blocks) {
          const snapshot = currentSnapshot(await read($, context))
          prompt = sentPrompt(blocks, snapshot?.prompt ?? [])
        }
      }
      const token = await viewToken($)
      const view = token ? { session, token } : null
      const items = records.map(one => one.item)
      await update($, trace, () => ({ status, items, prompt, view, replaced, differing }))
    } catch {
      // The folder could not be read just now; the next turn tries again.
    }
  })
  traceQueue = run.catch(() => undefined)

  return run
}

/** The request the reader last laid out, as rows at a width: kept while the person scrolls. */
let readerCache: { key: string; title: string; detail: string; rows: string[] } | null = null

/** A request whole as rows `columns` wide, for the reader; null when it cannot be read. */
async function readerRows(
  $: EngineInterface,
  seq: number,
  columns: number,
): Promise<{ key: string; title: string; detail: string; rows: string[] } | null> {
  const { session, folder } = await traceFolder($)
  const cached = [...traceCache.values()].find(one => one.item.seq === seq)
  if (!cached) return null
  // Read again once its answer lands, which changes its file, or one before
  // it changes, which it is rebuilt from.
  const stamps = [...traceCache.values()]
    .filter(one => one.item.seq <= seq)
    .map(one => `${one.item.seq}@${one.stamp}`)
    .join(',')
  const key = `${session}:${seq}:${stamps}:${columns}`
  if (readerCache?.key === key) return readerCache
  const readJson = async <T,>(name: string): Promise<T | null> => {
    try {
      return JSON.parse(String(await $.fs.read(`${folder}/${name}`))) as T
    } catch {
      return null
    }
  }
  const record = cached.record
  const base = promptRecord(
    [...traceCache.values()].map(one => one.record),
    seq,
  )!
  const system = base.system
    ? (systemCache.get(base.system) ??
      (await readJson<{ type: string; text: string }[]>(`system-${base.system}.json`)))
    : null
  const tools = base.tools ? await readJson<{ name?: string }[]>(`tools-${base.tools}.json`) : null
  const text = wholeRequestText(
    [...traceCache.values()].map(one => one.record),
    seq,
    system,
    tools,
  )
  if (text === null) return null
  readerCache = {
    key,
    title: `Request #${seq + 1} · ${sourceLabel(record.source)}`,
    detail: `${text.length.toLocaleString('en-US')} characters`,
    rows: wrapRows(text, columns),
  }

  return readerCache
}

/** Matches of the reader's search, kept while neither the rows nor the query change. */
let matchCache: { key: string; query: string; matches: RowMatch[] } | null = null

function readerMatches(laid: { key: string; rows: string[] }, query: string): RowMatch[] {
  if (matchCache?.key === laid.key && matchCache.query === query) return matchCache.matches
  matchCache = { key: laid.key, query, matches: findMatches(laid.rows, query) }

  return matchCache.matches
}

/** How many rows the window showed at the reader's last drawing; a guess until it is drawn. */
let readerBodyRows = 40

/** The reader's first row in view, kept so the rows in view are all text. */
function clampOffset(offset: number, total: number, visible: number): number {
  return Math.max(0, Math.min(offset, total - visible))
}

/**
 * Moves the reader's rows so the current match is in the middle of those in
 * view. The reader draws its own rows under its top (./panel.tsx), so this is
 * a change of state, which redraws it, not a scroll of the pane.
 */
async function revealHit($: EngineInterface): Promise<void> {
  const laid = readerCache
  if (!laid) return
  const searching = await read($, readerSearch)
  const matches = readerMatches(laid, searching.query)
  const current = matches[Math.min(searching.index, matches.length - 1)]
  if (!current) return
  const visible = readerVisibleRows(readerBodyRows)
  await update($, readerOffset, () =>
    clampOffset(current.row - Math.floor(visible / 2), laid.rows.length, visible),
  )
}

/** A new search in the reader: its first match current. */
async function searchReader($: EngineInterface, query: string): Promise<void> {
  await update($, readerSearch, () => ({ query, index: 0 }))
  if (query.trim() !== '') await revealHit($)
}

/** Steps the reader's current match on or back, round the ends. */
async function stepReader($: EngineInterface, by: number): Promise<void> {
  const count = matchCache?.matches.length ?? 0
  if (count === 0) return
  await update($, readerSearch, now => ({ ...now, index: (now.index + by + count) % count }))
  await revealHit($)
}

/**
 * Moves the reader's rows: by `by` rows, or to an end. What its text posts
 * for a key (./text.tsx), and its page buttons press.
 */
async function scrollReader($: EngineInterface, pick: TextPick): Promise<void> {
  const laid = readerCache
  if (!laid) return
  const visible = readerVisibleRows(readerBodyRows)
  const total = laid.rows.length
  await update($, readerOffset, now =>
    clampOffset('to' in pick ? (pick.to === 'start' ? 0 : total) : now + pick.by, total, visible),
  )
}

/**
 * Opens a request whole in the pane's reader, at its top. The reader is never
 * taller than the pane's window (./panel.tsx), so the window, put at the top
 * once, has nothing to scroll from then on.
 */
async function openReader($: EngineInterface, seq: number): Promise<void> {
  // Laid out afresh for this request.
  readerCache = null
  await update($, readerSearch, () => ({ query: '', index: 0 }))
  await update($, readerOffset, () => 0)
  await update($, reader, () => seq)
  await $.ui.scroll({ in: PANE_ID, to: 'start' }).catch(() => undefined)
}

/** One recorded request as text, for the Trace tab's open row; null when it is not read. */
function traceRequestText(seq: number): string | null {
  const cached = [...traceCache.values()].find(one => one.item.seq === seq)

  return cached ? requestText(cached.record) : null
}

/** Turns tracing on or off in the user settings; new sessions follow it. */
async function setTracing($: EngineInterface, isOn: boolean): Promise<void> {
  await serially(async () => {
    try {
      const path = await settingsPath($)
      const text = await readSettingsText($)
      const kept = await $.store.get(TRACE_ENV_BEFORE).catch(() => undefined)
      const next = editTraceEnv(text, isOn, isPlainObject(kept) ? kept : undefined)
      // What on found is kept before the file changes, so tracing is never on
      // with nothing to give back; off forgets it once it is given back.
      if (isOn && next.before) await $.store.set(TRACE_ENV_BEFORE, next.before)
      if (next.text !== text) await $.fs.write(path, next.text)
      if (!isOn) await $.store.delete(TRACE_ENV_BEFORE).catch(() => undefined)
      await update($, traceError, () => (next.isLost ? TRACE_ENV_LOST : null))
    } catch (error) {
      const reason =
        error instanceof SettingsShapeError
          ? error.message
          : `Could not update settings.json: ${String(error)}`
      await update($, traceError, () => reason)
    }
  })
  await refreshTrace($)
}

/**
 * Opens or closes one of the system prompt's sections. A section opens alone,
 * so the pane never draws more than one at a time.
 */
async function toggleExpanded($: EngineInterface, key: string): Promise<void> {
  await update($, page, () => 0)
  await update($, expanded, keys => (keys.includes(key) ? [] : [key]))
}

/**
 * Opens the Context details pane at its top, on its Tools tab, with the deny
 * list and the breakdown read afresh: the settings may have been edited by hand
 * since the session began, and the window may have moved since the last turn
 * (a /compact).
 */
async function openPane($: EngineInterface): Promise<void> {
  try {
    await update($, tab, () => 'tools')
    await update($, reader, () => null)
    readerCache = null
    // Focused, so the first click in the pane presses its button: an
    // unfocused pane spends that click on taking the focus.
    await $.ui.open({ id: PANE_ID, title: PANE_TITLE, focus: true })
    await Promise.all([refreshRemoved($), refreshContext($).then(() => refreshTrace($))])
    await $.clock.sleep(PANE_SETTLE_MS)
    await $.ui.scroll({ in: PANE_ID, to: 'start' })
  } catch {
    // Unloaded or closed meanwhile; the next press opens it again.
  }
}

export const register: Register = on => {
  /** Descriptions of built-in tools seen in any session, read from the store at start. */
  const knownTools: Record<string, string> = {}

  on('session.start', async ($, e, next) => {
    readStartedTraced($)
    const started = await next(e)

    void (async () => {
      const configured = await configuredEffort($)
      await update($, effort, current => current ?? configured)
      await refreshGit($)
      await refreshRemoved($)
      await refreshContext($)
      await refreshTrace($)
    })()
    void ensureTraceFolder($).catch(() => {
      // No home folder, or it could not be written: the receiver makes the folder when it starts.
    })
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

  // The receiver lives as long as the session that started it. When that one
  // ends, the requests of the others would go nowhere until their turn ended:
  // each prompt makes sure one listens, before the turn's requests are sent.
  on('prompt.submit', async ($, e, next) => {
    void refreshTrace($)

    return next(e)
  })

  // A turn may have committed, switched branch or touched files: re-read git.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      void refreshGit($)
      // The last request's answer reaches the receiver a moment after the turn
      // ends (the export runs every second), so the trace is read twice.
      void refreshContext($)
        .then(() => refreshTrace($))
        .then(() => $.clock.sleep(TRACE_SETTLE_MS))
        .then(() => refreshTrace($))
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
        deny: `The user removed ${e.tool} from this session; do not retry it. They can put it back in the Context details pane.`,
      }
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  // The desktop sometimes moves the pane's window straight to its last row as
  // it redraws (after a press, or a wheel tick), reported as the person's own
  // scroll. No key or wheel moves it that way (End moves by every row, a page
  // key by a page), so such a move is refused and the window stays put.
  on('ui.scroll', { requestId: PANE_ID }, async ($, e, next) => {
    const lastOffset = Math.max(0, e.contentRows - e.bodyRows)
    const isRedrawJump =
      e.origin.kind === 'person' &&
      !e.pointer &&
      Math.abs(e.by) > e.bodyRows &&
      Math.abs(e.by) !== e.contentRows &&
      e.offset === lastOffset

    return isRedrawJump ? {} : next(e)
  }).catch(($, e, next) => next(e))

  // A tab picked in the pane's strip, posted by its region.
  on('ui.message', { requestId: PANE_ID }, async ($, e, next) => {
    const picked = (e.data as Partial<TabPick> | null)?.tab
    const isTab = (value: unknown): value is PaneTab => PANE_TABS.includes(value as PaneTab)
    if (e.element.startsWith(TAB_PREFIX) && isTab(picked)) await update($, tab, () => picked)
    const toggled = (e.data as Partial<DisclosurePick> | null)?.toggle
    if (e.element.startsWith(DISCLOSURE_PREFIX) && typeof toggled === 'string') {
      // A group opens and closes on its own; a section opens alone.
      if (toggled.startsWith(GROUP_PREFIX)) {
        await update($, collapsed, keys =>
          keys.includes(toggled) ? keys.filter(key => key !== toggled) : [...keys, toggled],
        )
      } else {
        await toggleExpanded($, toggled)
      }
    }
    if (e.element === READER_KEY && (e.data as Partial<ReaderBarPick> | null)?.back) {
      await update($, reader, () => null)
      readerCache = null
    }
    // A key in the reader's text: a row or a page either way, or an end.
    if (e.element === READER_TEXT_KEY) {
      const pick = e.data as Partial<TextPick> | null
      if (pick && 'to' in pick && (pick.to === 'start' || pick.to === 'end')) {
        await scrollReader($, { to: pick.to })
      } else if (pick && 'by' in pick && typeof pick.by === 'number') {
        await scrollReader($, { by: pick.by })
      }
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    if (e.surface !== 'desktop') {
      const { Text } = $.ui.resolve(e)

      return <Text>The context details draw in the desktop app.</Text>
    }
    const ui = $.ui.resolve(e)
    const [
      snapshot,
      open,
      closed,
      shown,
      seen,
      names,
      back,
      error,
      traced,
      tracingError,
      openingError,
      shownPage,
      readingSeq,
      searching,
      readingOffset,
    ] = await Promise.all([
      read($, context).then(currentSnapshot),
      read($, expanded),
      read($, collapsed),
      read($, tab),
      read($, tools),
      read($, removed),
      read($, putBack),
      read($, toolError),
      // In this version's shape: a reload keeps what an earlier one wrote.
      read($, trace).then(currentTrace),
      read($, traceError),
      read($, folderError),
      read($, page),
      read($, reader),
      read($, readerSearch),
      read($, readerOffset),
    ])
    const openSeq = open.map(key => /^trace-(\d+)$/.exec(key)?.[1]).find(Boolean)
    // The reader draws the rows that fit under its top, from the first the
    // person scrolled to: the rest of the request is not drawn at all.
    const readerView = async (): Promise<ReaderView | null> => {
      const laid = await readerRows($, readingSeq!, Math.max(20, e.props.bodyColumns - 2))
      if (!laid) return null
      readerBodyRows = e.props.scroll.bodyRows
      const visible = readerVisibleRows(e.props.scroll.bodyRows)
      const first = clampOffset(readingOffset, laid.rows.length, visible)
      const last = Math.min(laid.rows.length, first + visible)
      const matches = readerMatches(laid, searching.query)
      const current =
        matches.length > 0 ? matches[Math.min(searching.index, matches.length - 1)]! : null
      // The matches by row, for the rows drawn.
      const byRow = new Map<number, RowMatch[]>()
      for (const match of matches) {
        if (match.row < first || match.row >= last) continue
        byRow.set(match.row, [...(byRow.get(match.row) ?? []), match])
      }

      return {
        title: laid.title,
        detail: laid.detail,
        first,
        total: laid.rows.length,
        search: {
          query: searching.query,
          index: current ? matches.indexOf(current) : 0,
          count: matches.length,
        },
        rows: laid.rows.slice(first, last).map((text, at) => ({
          text,
          hits: (byRow.get(first + at) ?? []).map(match => ({
            start: match.start,
            end: match.end,
            isCurrent: match === current,
          })),
        })),
      }
    }

    return ContextPane({
      ui,
      snapshot,
      places: await tracePlaces($),
      tools: toolRows(seen, knownTools, names, back),
      tab: shown,
      expanded: open,
      collapsed: closed,
      error,
      trace: traced,
      traceError: tracingError,
      folderError: openingError,
      traceText: openSeq === undefined ? null : traceRequestText(Number(openSeq)),
      onTracing: isOn => void setTracing($, isOn),
      onShowTraces: () => void showTraceFolder($),
      onToggle: (name, shouldRemove) =>
        void setRemoved($, name, shouldRemove).catch(error =>
          update($, toolError, () => String(error)),
        ),
      onExpand: key => void toggleExpanded($, key),
      page: shownPage,
      reader: readingSeq === null || shown !== 'trace' ? null : await readerView(),
      onRead: seq => void openReader($, seq),
      onSearch: query => void searchReader($, query),
      onStep: by => void stepReader($, by),
      onScroll: by => void scrollReader($, { by }),
      onPage: next => void update($, page, () => next),
    })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // The CLI already has its own status line; this band is for the desktop.
    if (e.surface !== 'desktop' || e.props.hasSurvey) return next(e)

    const ui = $.ui.resolve(e)
    const { Box, Button, Svg, Text } = ui

    // Subscribes this drawing to the once-a-second tick.
    await read($, tick)
    const [model, cwd, usage, repo, level, now] = await Promise.all([
      $.session.model(),
      $.session.cwd(),
      $.session.usage(),
      read($, git),
      read($, effort),
      $.clock.now(),
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
      <Box flexDirection="row" alignItems="center" paddingX={1} columnGap={3}>
        {/* Identity: what is answering, how hard, and where, a hairline between each.
            It gives way first: a long branch name is cut short rather than pushing
            the figures onto a second line. */}
        <Box flexDirection="row" alignItems="center" columnGap={2} flexShrink={1} minWidth={0}>
          <Box flexShrink={0}>
            <Text color="claude" bold>
              {prettyModel(model)}
            </Text>
          </Box>
          {level !== null && divider()}
          {level !== null && (
            <Box flexShrink={0}>
              <Text color={EFFORT_COLOR[level]}>{EFFORT_LABEL[level]}</Text>
            </Box>
          )}
          {hasPlace && divider()}
          {hasPlace && (
            <Box flexDirection="row" alignItems="center" columnGap={1} flexShrink={1} minWidth={0}>
              {folder !== '' && (
                <Box flexShrink={0}>
                  <Text color="text">{folder}</Text>
                </Box>
              )}
              {folder !== '' && repo !== null && <Text color="inactive">|</Text>}
              {repo !== null && (
                <Text color="secondaryText" wrap="truncate-end">
                  {repo.branch}
                </Text>
              )}
              {repo?.isDirty && <Text color="warning">•</Text>}
            </Box>
          )}
        </Box>

        <Box flexGrow={1} />

        {/* Live figures: context, cost, elapsed, a hairline between each. */}
        <Box flexDirection="row" alignItems="center" columnGap={2} flexShrink={0}>
          {/* The percentage opens the Context details pane. */}
          <Box flexDirection="row" alignItems="center" columnGap={1}>
            <Svg
              source={meterSvg(percent)}
              alt={percent === undefined ? 'context: no reading yet' : `context ${percent}% used`}
              width={METER_WIDTH}
              height={METER_HEIGHT}
            />
            <Button
              key="open-context"
              plain
              label={percent === undefined ? '--%' : `${percent}%`}
              onPress={() => void openPane($)}
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

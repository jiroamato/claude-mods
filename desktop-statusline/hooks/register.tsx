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
import type { ElapsedProps } from './elapsed'
import { showFolder } from './folder'
import {
  ContextPane,
  DISCLOSURE_PREFIX,
  GROUP_PREFIX,
  OLD_PANE_ID,
  PANE_ID,
  PANE_TITLE,
  READER_KEY,
  READER_SIDE_COLUMNS,
  TRACE_ITEM_PREFIX,
  readerVisibleRows,
} from './panel'
import type { ReaderView } from './panel'
import { READER_TEXT_KEY } from './text'
import type { TextPick, TextProps } from './text'
import type { DisclosurePick } from './disclosure'
import type { ReaderBarPick } from './reader'
import { TAB_PREFIX } from './tabs'
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
  withBilling,
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

const steps = atom({ plugin: 'desktop-statusline', key: 'steps' } as const, 0)
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
const TRACE_ENV_BEFORE = 'trace-env-before'
const TRACE_ENV_LOST =
  'Tracing is off, but what you had under its settings before it was turned on was not found ' +
  '(the plugin’s store was cleared, or another copy of the plugin turned it on), so its values ' +
  'were taken out and none of yours put back. Check the `env` block of settings.json.'
const tools = atom({ plugin: 'desktop-statusline', key: 'tools' } as const, {})
const removed = atom({ plugin: 'desktop-statusline', key: 'removed' } as const, [])
const putBack = atom({ plugin: 'desktop-statusline', key: 'putBack' } as const, [])
const toolError = atom({ plugin: 'desktop-statusline', key: 'toolError' } as const, null)
const KNOWN_TOOL_PREFIX = 'tool-description:'

const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
const EFFORT_LABEL: Record<Effort, string> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'x-high',
  max: 'max',
}
const EFFORT_COLOR: Record<Effort, string> = {
  low: 'inactive',
  medium: 'secondaryText',
  high: 'text',
  xhigh: 'warning',
  max: 'error',
}

const METER_WIDTH = 64
const METER_HEIGHT = 10
const METER_STROKE = 1
const METER_OUTLINE = '#8a8a8a'
const METER_FILL = '#c19c00'
const DIVIDER_WIDTH = 2
const DIVIDER_HEIGHT = 14
const DIVIDER_COLOR = '#333333'
const DIVIDER_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" width="${DIVIDER_WIDTH}" height="${DIVIDER_HEIGHT}" viewBox="0 0 ${DIVIDER_WIDTH} ${DIVIDER_HEIGHT}">` +
  `<rect width="${DIVIDER_WIDTH}" height="${DIVIDER_HEIGHT}" fill="${DIVIDER_COLOR}"/>` +
  `</svg>`
const GIT_REFRESH_EVERY_TICKS = 15
const ELAPSED_COLUMNS = 7

const INFO_GLYPH = ' ⓘ '
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
  try {
    let next: GitInfo = null
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
    const was = await read($, git)
    if (was?.branch === next?.branch && was?.isDirty === next?.isDirty) return
    await update($, git, () => next)
  } catch {}
}

function attempt(work: Promise<unknown>): void {
  void work.catch(() => undefined)
}

async function configuredEffort($: EngineInterface): Promise<Effort | null> {
  try {
    const row = (await $.config.list()).find(one => /effort/i.test(one.key))
    const fromConfig = asEffort(row?.value)
    if (fromConfig) return fromConfig
  } catch {}
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

async function homeDir($: EngineInterface): Promise<string> {
  const [profile, unixHome] = [await $.env.get('USERPROFILE'), await $.env.get('HOME')]
  const home =
    (await $.env.get('OS')) === 'Windows_NT' ? (profile ?? unixHome) : (unixHome ?? profile)
  if (!home) throw new SettingsShapeError('Cannot find your home folder: HOME is not set.')

  return home
}

async function configDir($: EngineInterface): Promise<string> {
  const configured = await $.env.get('CLAUDE_CONFIG_DIR')
  if (configured) return configured

  return `${await homeDir($)}/.claude`
}

async function settingsPath($: EngineInterface): Promise<string> {
  return `${await configDir($)}/settings.json`
}

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

function refreshRemoved($: EngineInterface): Promise<void> {
  return serially(async () => {
    try {
      const names = deniedTools(parseSettings(await readSettingsText($)))
      const before = await read($, removed)
      if (names.length === before.length && names.every(one => before.includes(one))) return
      await update($, removed, () => names)
      $.ui.invalidate('tool.describe')
    } catch {}
  })
}

async function composedPrompt($: EngineInterface): Promise<readonly PromptComposeSection[]> {
  try {
    return (await $.prompt.compose()).sections
  } catch {
    return []
  }
}

async function refreshContext($: EngineInterface): Promise<void> {
  try {
    const usage = await $.session.usage({ breakdown: 'full' })
    const breakdown = usage.context.breakdown
    if (!breakdown) return
    const [commands, sections] = await Promise.all([$.command.list(), composedPrompt($)])
    const snapshot = buildSnapshot(breakdown, commands, sections)
    await update($, context, () => snapshot)
  } catch {}
}

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

async function traceRoot($: EngineInterface): Promise<string> {
  return `${await homeDir($)}/.claude/desktop-statusline/traces`
}

const TRACES_README =
  'Traces of desktop-statusline, a plugin for Claude Code.\n' +
  '\n' +
  'With tracing on (the Trace tab of its Context details pane), every request a\n' +
  'Claude Code session sends to the model is kept here, a folder per session, until\n' +
  'you delete it. They hold the whole conversation, file contents and command output\n' +
  'included, and never leave this machine.\n' +
  '\n' +
  'Delete this folder to remove every trace. The next session makes it again, empty.\n'

async function ensureTraceFolder($: EngineInterface): Promise<void> {
  const root = await traceRoot($)
  if (!(await $.fs.exists(root))) await $.fs.write(`${root}/README.txt`, TRACES_README)
}

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

async function tracePlaces($: EngineInterface): Promise<TracePlaces | null> {
  try {
    return { settings: await settingsPath($), traces: await traceRoot($) }
  } catch {
    return null
  }
}

const RECEIVER_START_MS = 3000
const RECEIVER_POLL_MS = 150
const TRACE_SETTLE_MS = 2500

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

function receiverVersion(text: string): number | null {
  const match = new RegExp(`^${RECEIVER_NAME} (\\d+)$`).exec(text.trim())

  return match ? Number(match[1]) : null
}

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

async function ensureReceiver($: EngineInterface): Promise<TraceStatus> {
  const found = await receiverOnPort($)
  if (found === 'current' || found === 'newer') return 'on'
  if (found === 'other') return 'unreachable'
  if (found === 'older') {
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

  return hasFailed ? 'no-node' : 'unreachable'
}

const traceCache = new Map<string, { stamp: string; item: TraceItem; record: TraceRecord }>()
let traceSession: string | null = null
const systemCache = new Map<string, { type: string; text: string }[]>()
let traceQueue: Promise<unknown> = Promise.resolve()
const MAX_READ_BYTES = 4 * 1024 * 1024

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

let startedTraced: Promise<boolean | null> = Promise.resolve(null)
let hasReadStart = false

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

function refreshTrace($: EngineInterface): Promise<void> {
  const run = traceQueue.then(async () => {
    try {
      const settings = parseSettings(await readSettingsText($))
      let status: TraceStatus = isTraceOn(settings) ? await ensureReceiver($) : 'off'
      const endpoint = await $.env.get('OTEL_EXPORTER_OTLP_LOGS_ENDPOINT')
      if (status === 'on' && endpoint && endpoint !== TRACE_ENV.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT) {
        status = 'elsewhere'
      }
      const differing = status === 'off' ? [] : differingNames(settings)
      const replaced =
        status === 'off'
          ? []
          : replacedNames(await $.store.get(TRACE_ENV_BEFORE).catch(() => undefined)).filter(
              name => !differing.includes(name),
            )
      if (status !== 'on') {
        await update($, trace, kept => {
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
      const turns = await $.session.turns().catch(() => 0)
      if (entries.length === 0 && turns > 0) {
        status = (await startedTraced) ? 'emptied' : 'next-session'
      }
      const byName = new Map(entries.map(entry => [entry.name, entry]))
      for (const name of traceCache.keys()) if (!byName.has(name)) traceCache.delete(name)
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
        } catch {}
      }
      const records = [...traceCache.values()].sort((a, b) => a.item.seq - b.item.seq)
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
          } catch {}
        }
        if (blocks) {
          const snapshot = currentSnapshot(await read($, context))
          prompt = sentPrompt(withBilling(last, blocks), snapshot?.prompt ?? [])
        }
      }
      const token = await viewToken($)
      const view = token ? { session, token } : null
      const items = records.map(one => one.item)
      await update($, trace, () => ({ status, items, prompt, view, replaced, differing }))
    } catch {}
  })
  traceQueue = run.catch(() => undefined)

  return run
}

let readerCache: { key: string; title: string; detail: string; rows: string[] } | null = null

async function readerRows(
  $: EngineInterface,
  seq: number,
  columns: number,
): Promise<{ key: string; title: string; detail: string; rows: string[] } | null> {
  const { session, folder } = await traceFolder($)
  const cached = [...traceCache.values()].find(one => one.item.seq === seq)
  if (!cached) return null
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
    withBilling(record, system),
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

let matchCache: { key: string; query: string; matches: RowMatch[] } | null = null

function readerMatches(laid: { key: string; rows: string[] }, query: string): RowMatch[] {
  if (matchCache?.key === laid.key && matchCache.query === query) return matchCache.matches
  matchCache = { key: laid.key, query, matches: findMatches(laid.rows, query) }

  return matchCache.matches
}

let readerBodyRows = 40

function clampOffset(offset: number, total: number, visible: number): number {
  return Math.max(0, Math.min(offset, total - visible))
}

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

async function searchReader($: EngineInterface, query: string): Promise<void> {
  await update($, readerSearch, () => ({ query, index: 0 }))
  if (query.trim() !== '') await revealHit($)
}

async function stepReader($: EngineInterface, by: number): Promise<void> {
  const count = matchCache?.matches.length ?? 0
  if (count === 0) return
  await update($, readerSearch, now => ({ ...now, index: (now.index + by + count) % count }))
  await revealHit($)
}

function textProps(
  laid: { rows: string[] },
  offset: number,
  visible: number,
  searching: { query: string; index: number },
): TextProps & { first: number } {
  const total = laid.rows.length
  const first = clampOffset(offset, total, visible)
  const base = Math.max(0, first - visible)
  const last = Math.min(total, first + 2 * visible)
  const matches = readerMatches(laid as { key: string; rows: string[] }, searching.query)
  const current =
    matches.length > 0 ? matches[Math.min(searching.index, matches.length - 1)]! : null
  const byRow = new Map<number, RowMatch[]>()
  for (const match of matches) {
    if (match.row < base || match.row >= last) continue
    byRow.set(match.row, [...(byRow.get(match.row) ?? []), match])
  }

  return {
    rows: laid.rows.slice(base, last).map((text, at) => ({
      text,
      hits: (byRow.get(base + at) ?? []).map(match => ({
        start: match.start,
        end: match.end,
        isCurrent: match === current,
      })),
    })),
    base,
    first,
    page: visible,
    total,
  }
}

async function scrollReader($: EngineInterface, pick: TextPick): Promise<void> {
  const laid = readerCache
  if (!laid) return
  const visible = readerVisibleRows(readerBodyRows)
  const total = laid.rows.length
  await update($, readerOffset, now =>
    clampOffset(
      'first' in pick
        ? pick.first
        : 'to' in pick
          ? pick.to === 'start'
            ? 0
            : total
          : clampOffset(now, total, visible) + pick.by,
      total,
      visible,
    ),
  )
}

async function openReader($: EngineInterface, seq: number): Promise<void> {
  readerCache = null
  await update($, readerSearch, () => ({ query: '', index: 0 }))
  await update($, readerOffset, () => 0)
  await update($, reader, () => seq)
  await $.ui.scroll({ in: PANE_ID, to: 'start' }).catch(() => undefined)
}

function traceRequestText(seq: number): string | null {
  const cached = [...traceCache.values()].find(one => one.item.seq === seq)

  return cached ? requestText(cached.record) : null
}

async function setTracing($: EngineInterface, isOn: boolean): Promise<void> {
  await serially(async () => {
    try {
      const path = await settingsPath($)
      const text = await readSettingsText($)
      const kept = await $.store.get(TRACE_ENV_BEFORE).catch(() => undefined)
      const next = editTraceEnv(text, isOn, isPlainObject(kept) ? kept : undefined)
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

async function toggleExpanded($: EngineInterface, key: string): Promise<void> {
  await update($, page, () => 0)
  await update($, expanded, keys => (keys.includes(key) ? [] : [key]))
}

async function openPane($: EngineInterface): Promise<void> {
  try {
    const panes = await $.ui.panes()
    if (panes.some(pane => pane.id === OLD_PANE_ID)) {
      await $.ui.close({ id: OLD_PANE_ID }).catch(() => undefined)
    }
    const isOpen = panes.some(pane => pane.id === PANE_ID && pane.isShown)
    if (!isOpen) {
      await update($, tab, () => 'tools')
      await update($, reader, () => null)
      readerCache = null
    }
    await $.ui.open({ id: PANE_ID, title: PANE_TITLE, focus: true })
    await Promise.all([refreshRemoved($), refreshContext($).then(() => refreshTrace($))])
    if (isOpen) return
    await $.clock.sleep(PANE_SETTLE_MS)
    await $.ui.scroll({ in: PANE_ID, to: 'start' })
  } catch {}
}

export const register: Register = on => {
  const knownTools: Record<string, string> = {}

  on('session.start', async ($, e, next) => {
    readStartedTraced($)
    const started = await next(e)

    attempt(
      (async () => {
        const configured = await configuredEffort($)
        await update($, effort, current => current ?? configured)
        await refreshGit($)
        await refreshRemoved($)
        await refreshContext($)
        await refreshTrace($)
        await update($, steps, n => n + 1)
      })(),
    )
    void ensureTraceFolder($).catch(() => {})
    void (async () => {
      for (const key of await $.store.keys()) {
        if (!key.startsWith(KNOWN_TOOL_PREFIX)) continue
        const description = await $.store.get(key)
        if (typeof description === 'string') {
          knownTools[key.slice(KNOWN_TOOL_PREFIX.length)] = description
        }
      }
    })().catch(() => {})

    let ticks = 0
    $.clock.every(1000, () => {
      ticks += 1
      if (ticks % GIT_REFRESH_EVERY_TICKS === 0) attempt(refreshGit($))
    })

    return started
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') {
      readerCache = null
      matchCache = null
      await Promise.all([
        update($, reader, () => null),
        update($, readerSearch, () => ({ query: '', index: 0 })),
        update($, readerOffset, () => 0),
        update($, expanded, keys => keys.filter(key => !key.startsWith(TRACE_ITEM_PREFIX))),
      ])
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      const level = asEffort(e.effort)
      if (level) attempt(update($, effort, () => level))
      attempt(update($, steps, n => n + 1))
    }

    return yield* next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    attempt(refreshTrace($))

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      attempt(refreshGit($))
      attempt(update($, steps, n => n + 1))
      void refreshContext($)
        .then(() => refreshTrace($))
        .then(() => $.clock.sleep(TRACE_SETTLE_MS))
        .then(() => refreshTrace($))
        .catch(() => {})
    }

    return next(e)
  })

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

  on('tool.call', async ($, e, next) => {
    const names = await read($, removed)
    if (names.includes(e.tool) && !KEPT_TOOLS.includes(e.tool)) {
      return {
        deny: `The user removed ${e.tool} from this session; do not retry it. They can put it back in the Context details pane.`,
      }
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.message', { requestId: PANE_ID }, async ($, e, next) => {
    const isTab = (value: unknown): value is PaneTab => PANE_TABS.includes(value as PaneTab)
    if (e.element.startsWith(TAB_PREFIX)) {
      const pick = e.data as Partial<{ tab: unknown; step: unknown }> | null
      const picked = pick?.tab
      if (isTab(picked)) await update($, tab, () => picked)
      const step = pick?.step
      if (step === -1 || step === 1) {
        await update($, tab, now => PANE_TABS[PANE_TABS.indexOf(now) + step] ?? now)
      }
    }
    const toggled = (e.data as Partial<DisclosurePick> | null)?.toggle
    if (e.element.startsWith(DISCLOSURE_PREFIX) && typeof toggled === 'string') {
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
    if (e.element === READER_TEXT_KEY) {
      const pick = e.data as Partial<TextPick> | null
      if (pick && 'to' in pick && (pick.to === 'start' || pick.to === 'end')) {
        await scrollReader($, { to: pick.to })
      } else if (pick && 'by' in pick && typeof pick.by === 'number') {
        await scrollReader($, { by: pick.by })
      } else if (pick && 'first' in pick && typeof pick.first === 'number') {
        await scrollReader($, { first: Math.round(pick.first) })
      }
      const laid = readerCache
      if (laid) {
        const [offset, searching] = await Promise.all([
          read($, readerOffset),
          read($, readerSearch),
        ])

        return { props: textProps(laid, offset, readerVisibleRows(readerBodyRows), searching) }
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
      read($, trace).then(currentTrace),
      read($, traceError),
      read($, folderError),
      read($, page),
      read($, reader),
      read($, readerSearch),
      read($, readerOffset),
    ])
    const openSeq = open.map(key => /^trace-(\d+)$/.exec(key)?.[1]).find(Boolean)
    const readerView = async (): Promise<ReaderView | null> => {
      const laid = await readerRows(
        $,
        readingSeq!,
        Math.max(20, e.props.bodyColumns - READER_SIDE_COLUMNS),
      )
      if (!laid) return null
      readerBodyRows = e.props.scroll.bodyRows
      const visible = readerVisibleRows(e.props.scroll.bodyRows)
      const matches = readerMatches(laid, searching.query)
      const current =
        matches.length > 0 ? matches[Math.min(searching.index, matches.length - 1)]! : null

      return {
        title: laid.title,
        detail: laid.detail,
        text: textProps(laid, readingOffset, visible, searching),
        search: {
          query: searching.query,
          index: current ? matches.indexOf(current) : 0,
          count: matches.length,
        },
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
      onTracing: isOn => attempt(setTracing($, isOn)),
      onShowTraces: () => attempt(showTraceFolder($)),
      onToggle: (name, shouldRemove) =>
        attempt(
          setRemoved($, name, shouldRemove).catch(error =>
            update($, toolError, () => String(error)),
          ),
        ),
      onExpand: key => attempt(toggleExpanded($, key)),
      page: shownPage,
      reader: readingSeq === null || shown !== 'trace' ? null : await readerView(),
      onRead: seq => attempt(openReader($, seq)),
      onSearch: query => attempt(searchReader($, query)),
      onStep: by => attempt(stepReader($, by)),
      onPage: next => attempt(update($, page, () => next)),
    })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface !== 'desktop' || e.props.hasSurvey) return next(e)

    const ui = $.ui.resolve(e)
    const { Box, Button, Client, Svg, Text } = ui

    await read($, steps)
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

        <Box flexDirection="row" alignItems="center" columnGap={2} flexShrink={0}>
          <Box flexDirection="row" alignItems="center" columnGap={1}>
            <Svg
              source={meterSvg(percent)}
              alt={percent === undefined ? 'context: no reading yet' : `context ${percent}% used`}
              width={METER_WIDTH}
              height={METER_HEIGHT}
            />
            <Text color="text" tabular>
              {percent === undefined ? '--%' : `${percent}%`}
            </Text>
          </Box>

          {usd !== undefined && divider()}
          {usd !== undefined && <Text color="text">${usd.toFixed(2)}</Text>}

          {divider()}
          <Box width={ELAPSED_COLUMNS} justifyContent="center">
            <Client
              key="elapsed"
              module="./elapsed.tsx"
              props={{ ms: elapsed } satisfies ElapsedProps}
            />
          </Box>

          {divider()}
          <Button
            key="open-details"
            plain
            dimColor
            label={INFO_GLYPH}
            onPress={() => attempt(openPane($))}
          />
        </Box>
      </Box>
    )
  })
}

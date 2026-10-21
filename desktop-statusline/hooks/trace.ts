import type { PromptSection, TraceItem } from '../types'
import {
  CHARS_PER_TOKEN,
  isPlainObject,
  parseSettings,
  SettingsShapeError,
  writeSettings,
} from './tools'
import {
  fullMessages,
  headMessages,
  isMain,
  promptRecord as sharedPromptRecord,
} from '../trace/store.mjs'

/** The loopback port the trace receiver listens on, and Claude Code exports to. */
export const TRACE_PORT = 43180

/** What the receiver's `GET /health` answers (trace/store.mjs keeps the same text). */
export const RECEIVER_HEALTH = 'desktop-statusline trace receiver 11'
/** What every version of the receiver's health answer opens with. */
export const RECEIVER_NAME = 'desktop-statusline trace receiver'

/**
 * The link to a session's trace page, or to one request's, in the browser. By
 * the name `localhost`: the one plain-http host a link on the desktop may name.
 */
export function viewLink(session: string, token: string, seq?: number): string {
  return `http://localhost:${TRACE_PORT}/view/${session}${seq === undefined ? '' : `/${seq}`}?t=${token}`
}

/**
 * What tracing sets in the user settings' `env`: Claude Code's own telemetry,
 * its log events only, each request and response body whole, sent to the
 * receiver on this machine. Metrics and traces stay off.
 */
export const TRACE_ENV: Readonly<Record<string, string>> = {
  CLAUDE_CODE_ENABLE_TELEMETRY: '1',
  OTEL_LOGS_EXPORTER: 'otlp',
  OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: 'http/json',
  OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `http://127.0.0.1:${TRACE_PORT}/v1/logs`,
  OTEL_LOGS_EXPORT_INTERVAL: '1000',
  OTEL_LOG_RAW_API_BODIES: '1',
  // A body is cut at 60KB by default, and the conversation comes before the
  // system prompt in it: this keeps every body whole.
  CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH: '20000000',
}

/** The names that decide where telemetry goes: with these as tracing sets them, it comes here. */
const TRACE_ROUTE = [
  'CLAUDE_CODE_ENABLE_TELEMETRY',
  'OTEL_LOGS_EXPORTER',
  'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
] as const

/** Whether an environment sends its log events to the receiver: the names that decide it as tracing sets them. */
export function isRoutedHere(env: Readonly<Record<string, unknown>>): boolean {
  return TRACE_ROUTE.every(key => env[key] === TRACE_ENV[key])
}

/**
 * Whether a settings object turns tracing on: its telemetry goes to the
 * receiver. The other names may have been changed by hand, and tracing is on
 * all the same, so it can always be turned off.
 */
export function isTraceOn(settings: unknown): boolean {
  const env = (settings as { env?: unknown } | null)?.env

  return isPlainObject(env) && isRoutedHere(env)
}

/** The names of tracing's a settings object holds other than as tracing sets them, or not at all. */
export function differingNames(settings: unknown): string[] {
  const env = (settings as { env?: unknown } | null)?.env
  const held = isPlainObject(env) ? env : {}

  return Object.entries(TRACE_ENV)
    .filter(([key, value]) => held[key] !== value)
    .map(([key]) => key)
}

/**
 * What the person had under each of tracing's names before it was turned on:
 * the value, or null where none was set. Kept whole, a value equal to
 * tracing's included, so off gives back exactly what on found.
 */
export type TraceEnvBefore = Record<string, unknown>

/**
 * The settings file's text with tracing's `env` values added or taken out,
 * everything else kept, and what on found there, to give back.
 *
 * On notes every name's value first; pressed again while on, it keeps what it
 * noted then. Off gives back what was noted for each name that still holds
 * tracing's value, so one the person changed since stays theirs. A name with
 * nothing noted is taken out, and `isLost` says so.
 */
export function editTraceEnv(
  text: string,
  isOn: boolean,
  before?: TraceEnvBefore,
): { text: string; before: TraceEnvBefore | null; isLost: boolean } {
  const settings = parseSettings(text)
  const env = settings.env ?? {}
  if (!isPlainObject(env)) {
    throw new SettingsShapeError('env in settings.json is not an object, so it was left as is.')
  }
  // Already on, every value tracing's: what it holds now is not the person's to note.
  if (isOn && differingNames(settings).length === 0) {
    return { text, before: before ?? null, isLost: false }
  }
  const next: Record<string, unknown> = { ...env }
  const noted: TraceEnvBefore = {}
  let isLost = false
  for (const [key, value] of Object.entries(TRACE_ENV)) {
    const had = next[key]
    const known = before !== undefined && Object.hasOwn(before, key)
    if (isOn) {
      // Tracing's value left from an earlier turn on keeps what was noted then.
      noted[key] = had === value && known ? before[key] : (had ?? null)
      next[key] = value
    } else if (had === value) {
      const given = known ? before[key] : null
      if (given === null || given === undefined) delete next[key]
      else next[key] = given
      if (!known) isLost = true
    }
  }
  const kept = isOn ? noted : null
  if (JSON.stringify(next) === JSON.stringify(env)) return { text, before: kept, isLost }
  settings.env = next

  return { text: writeSettings(text, settings), before: kept, isLost }
}

/** The names whose own value of the person's tracing holds in place of, by what on noted. */
export function replacedNames(before: unknown): string[] {
  if (!isPlainObject(before)) return []

  return Object.entries(TRACE_ENV)
    .filter(
      ([key, value]) => before[key] !== null && before[key] !== undefined && before[key] !== value,
    )
    .map(([key]) => key)
}

/** A request the receiver kept: what trace/store.mjs writes for each. */
export type TraceRecord = {
  seq: number
  at: string
  source: string
  model: string
  promptId: string | null
  /** The hashes its system prompt and tool list are kept under; null when it could not be read. */
  system: string | null
  tools: string | null
  toolCount: number
  messageCount: number
  from: number
  /** Goes on from the request before, adding to its messages (trace/store.mjs). */
  continues?: boolean
  added: ApiMessage[]
  /** A body that could not be read (cut short, too large to export whole): its length. */
  unreadable?: number
  /** A request whose file is too large to read in the pane: listed, and opened in the browser. */
  tooLarge?: boolean
  /**
   * Read from its head (`<seq>.head.json`, trace/store.mjs): all but its
   * messages, which stand in as placeholders. A request too large to read
   * with no head (an older receiver's) is known by its number alone.
   */
  isHead?: boolean
  roles?: string[]
  usage: TraceItem['usage']
  response: { content?: ApiBlock[]; stop_reason?: string | null } | null
}

type ApiBlock = {
  type: string
  text?: string
  thinking?: string
  name?: string
  input?: unknown
  content?: unknown
  tool_use_id?: string
}

type ApiMessage = { role: string; content: string | ApiBlock[] }

type SystemBlock = { type: string; text: string }

/**
 * A request too large to read here, from its head: as it was kept, its
 * messages placeholders. Marked too large, so it still says to open it in
 * the browser.
 */
export function fromHead(head: TraceRecord): TraceRecord {
  return { ...head, added: headMessages(head), tooLarge: true }
}

/** The main loop's requests, by the engine's name for where a request came from. */
export function isMainSource(source: string): boolean {
  return isMain(source)
}

/**
 * The request whose system prompt and tools a request was sent with
 * (trace/store.mjs, which the receiver's pages read them by too).
 */
export function promptRecord(records: readonly TraceRecord[], seq: number): TraceRecord | null {
  return sharedPromptRecord(records, seq)
}

/** Where a request came from, in a word. */
export function sourceLabel(source: string): string {
  if (isMainSource(source)) return 'Main'
  if (source === 'generate_session_title') return 'Title'
  if (source.startsWith('agent')) return 'Subagent'
  if (source.startsWith('compact')) return 'Compact'

  return source.replace(/_/g, ' ')
}

function blocksOf(message: ApiMessage): ApiBlock[] {
  return typeof message.content === 'string'
    ? [{ type: 'text', text: message.content }]
    : message.content
}

function oneLine(text: string, max = 60): string {
  const line = text.replace(/\s+/g, ' ').trim()

  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  return content
    .map(one =>
      isPlainObject(one) && typeof one.text === 'string' ? one.text : `[${String(one?.type)}]`,
    )
    .join('\n')
}

/** What one block is, in a few words, for a request's line in the list. */
function blockLabel(block: ApiBlock): string {
  switch (block.type) {
    case 'text': {
      const text = block.text ?? ''
      if (/^\s*<system-reminder>/.test(text)) return 'reminder'
      if (/^\s*<task-notification>/.test(text)) return 'notification'

      return `"${oneLine(text, 40)}"`
    }
    case 'tool_use':
      return String(block.name)
    case 'tool_result':
      return 'tool result'
    case 'thinking':
    case 'redacted_thinking':
      return 'thinking'
    default:
      return block.type
  }
}

/** What a request added and what came back, as the Trace tab lists it. */
export function summarize(record: TraceRecord): TraceItem {
  const added =
    record.unreadable !== undefined
      ? ['body too large to record']
      : record.tooLarge
        ? [
            record.isHead
              ? `${record.added.length} ${record.added.length === 1 ? 'message' : 'messages'} too large to read here: open it in your browser`
              : 'too large to read here: open it in your browser',
          ]
        : record.added.flatMap(message => blocksOf(message).map(blockLabel))
  const answer = record.response?.content ?? []
  const said = answer.find(one => one.type === 'text' && (one.text ?? '').trim() !== '')
  const calls = answer.filter(one => one.type === 'tool_use').map(one => String(one.name))
  const reply = [said ? `"${oneLine(said.text ?? '', 50)}"` : '', calls.join(', ')]
    .filter(one => one !== '')
    .join(' · ')

  return {
    seq: record.seq,
    at: record.at,
    source: record.source,
    model: record.model,
    promptId: record.promptId,
    added: added.length > 6 ? [...added.slice(0, 6), `+${added.length - 6} more`] : added,
    reply: record.response === null ? null : reply || (record.response.stop_reason ?? ''),
    usage: record.usage,
    messageCount: record.messageCount,
    toolCount: record.toolCount,
  }
}

function blockText(block: ApiBlock): string {
  switch (block.type) {
    case 'text':
      return block.text ?? ''
    case 'thinking':
      return `(thinking)\n${block.thinking ?? ''}`
    case 'redacted_thinking':
      return '(thinking, redacted)'
    case 'tool_use':
      return `→ ${String(block.name)} ${JSON.stringify(block.input ?? {}, null, 2)}`
    case 'tool_result':
      return `← tool result\n${textOf(block.content)}`
    default:
      return `[${block.type}]`
  }
}

/**
 * Text as rows `columns` characters wide at most, cut at the last space that
 * fits where there is one, so each row draws as exactly one line.
 */
export function wrapRows(text: string, columns: number): string[] {
  const width = Math.max(8, columns)
  const rows: string[] = []
  for (const raw of text.replace(/\t/g, '  ').split('\n')) {
    let line = raw
    while (line.length > width) {
      const space = line.lastIndexOf(' ', width)
      const cut = space > width / 2 ? space + 1 : width
      rows.push(line.slice(0, cut))
      line = line.slice(cut)
    }
    rows.push(line)
  }

  return rows
}

/** One match of a search in the reader's rows: the row, and where in it. */
export type RowMatch = { row: number; start: number; end: number }

/** The most matches a search counts: past it, the person narrows the search. */
export const MAX_MATCHES = 5_000

/** Where `query` appears in `rows`, ignoring case; within a row only, as rows are drawn. */
/**
 * Text in lower case, one character for one: a character whose lower case is
 * longer (`İ`) stays as it is, so a match's place is the same in the row.
 */
function foldCase(text: string): string {
  return text.replace(/[\s\S]/g, one => {
    const lower = one.toLowerCase()

    return lower.length === one.length ? lower : one
  })
}

export function findMatches(rows: readonly string[], query: string): RowMatch[] {
  const needle = foldCase(query)
  if (needle.trim() === '') return []
  const found: RowMatch[] = []
  for (let row = 0; row < rows.length && found.length < MAX_MATCHES; row += 1) {
    const haystack = foldCase(rows[row]!)
    for (
      let at = haystack.indexOf(needle);
      at !== -1;
      at = haystack.indexOf(needle, at + needle.length)
    ) {
      found.push({ row, start: at, end: at + needle.length })
      if (found.length >= MAX_MATCHES) break
    }
  }

  return found
}

/**
 * The stretches of rows the reader draws: a screen above the window, the
 * window and a screen below, so a scroll either way lands on drawn text; and
 * the rows around the current match, so the pane can be scrolled to it.
 */
export function readerRanges(
  total: number,
  firstInView: number,
  bodyRows: number,
  focus: number | null,
): { first: number; last: number }[] {
  const around = (row: number, before: number, after: number) => ({
    first: Math.min(total, Math.max(0, row - before)),
    last: Math.min(total, Math.max(0, row + after)),
  })
  const ranges = [around(firstInView, bodyRows, 2 * bodyRows)]
  if (focus !== null) ranges.push(around(focus, bodyRows, bodyRows))
  ranges.sort((a, b) => a.first - b.first)
  const merged: { first: number; last: number }[] = []
  for (const range of ranges) {
    const last = merged.at(-1)
    if (last && range.first <= last.last) last.last = Math.max(last.last, range.last)
    else if (range.last > range.first) merged.push({ ...range })
  }

  return merged
}

/** What a request too large to read here says, in its preview and its reader. */
const TOO_LARGE_TEXT =
  'This request is too large to read here: open it in your browser to read it whole.'

/** A request as text: what it added to the conversation, then the answer. */
export function requestText(record: TraceRecord): string {
  if (record.tooLarge && !record.isHead) return TOO_LARGE_TEXT
  const lines: string[] = record.tooLarge ? [TOO_LARGE_TEXT, ''] : []
  const count = record.added.length
  lines.push(
    `── Sent: ${count} new ${count === 1 ? 'message' : 'messages'} (${record.messageCount} in all), ` +
      `${record.toolCount} tools, ${record.model}`,
  )
  // A head's messages are placeholders: the line above counts them.
  for (const message of record.isHead ? [] : record.added) {
    lines.push('', `[${message.role}]`)
    for (const block of blocksOf(message)) lines.push(blockText(block))
  }
  lines.push(
    '',
    `── Answer${record.response?.stop_reason ? ` (${record.response.stop_reason})` : ''}`,
  )
  if (record.response === null) lines.push('(no answer recorded yet)')
  for (const block of record.response?.content ?? []) lines.push('', blockText(block))

  return lines.join('\n')
}

/**
 * A request whole, as the model received it: its system prompt, its tools,
 * every message (rebuilt from the requests of its kind before it), the answer.
 */
export function wholeRequestText(
  records: readonly TraceRecord[],
  seq: number,
  system: readonly SystemBlock[] | null,
  tools: readonly { name?: string }[] | null,
): string | null {
  const record = records.find(one => one.seq === seq)
  if (!record) return null
  // One with no head is known by its number alone.
  if (record.tooLarge && !record.isHead) return TOO_LARGE_TEXT
  const messages: ApiMessage[] = fullMessages(records, seq) ?? []
  // What this request added comes last, however it was sent.
  const firstNew = Math.max(0, messages.length - record.added.length)
  const lines: string[] = []
  // Its own messages stand in as placeholders; the rest is as it was sent.
  if (record.tooLarge) lines.push(TOO_LARGE_TEXT, '')
  lines.push(`══ System prompt: ${(system ?? []).length} blocks`)
  ;(system ?? []).forEach((block, index) =>
    lines.push('', `── Block ${index + 1}`, block.text ?? ''),
  )
  lines.push('', `══ Tools: ${(tools ?? []).length}`)
  for (const tool of tools ?? [])
    lines.push('', `── ${tool.name ?? 'tool'}`, JSON.stringify(tool, null, 2))
  lines.push(
    '',
    `══ Messages: ${messages.length}, the last ${messages.length - firstNew} new in this request`,
  )
  messages.forEach((message, index) => {
    lines.push('', `── #${index + 1} ${message.role}${index >= firstNew ? ' (new)' : ''}`)
    for (const block of blocksOf(message)) lines.push(blockText(block))
  })
  lines.push(
    '',
    `══ Answer${record.response?.stop_reason ? ` (${record.response.stop_reason})` : ''}`,
  )
  if (record.response === null) lines.push('(no answer recorded yet)')
  for (const block of record.response?.content ?? []) lines.push('', blockText(block))

  return lines.join('\n')
}

function estimate(text: string): number {
  return Math.round(text.length / CHARS_PER_TOKEN)
}

/** A piece of the sent prompt the engine's own sections do not hold, titled by its heading. */
function addedPieces(text: string, at: number): PromptSection[] {
  const body = text.trim()
  if (body === '') return []
  // Each top-level heading starts a piece of its own.
  const pieces = body.split(/\n(?=# )/)

  return pieces.map((piece, index) => {
    const heading = /^#\s+(.+)$/m.exec(piece.split('\n')[0] ?? '')?.[1]

    // A short piece with no heading (the identity line) is titled by its words.
    const title =
      heading?.trim() ??
      (!piece.includes('\n') && piece.length <= 200 ? oneLine(piece, 48) : 'Added text')

    return {
      id: `added-${at}-${index}`,
      title,
      tokens: estimate(piece),
      text: piece,
      isAdded: true,
    }
  })
}

/**
 * The system prompt as the last main request sent it, in order: the engine's
 * own sections where its text is found, and between and around them what
 * else was sent (the output style, the identity line, an app's own
 * instructions), each piece marked as added.
 */
export function sentPrompt(
  blocks: readonly SystemBlock[],
  sections: readonly PromptSection[],
): PromptSection[] {
  const out: PromptSection[] = []
  const placed = new Set<string>()
  blocks.forEach((block, index) => {
    const text = block.text ?? ''
    if (/^x-anthropic-billing-header:/.test(text)) {
      out.push({
        id: `billing-${index}`,
        title: 'Billing header',
        tokens: estimate(text),
        text,
        isAdded: true,
      })
      return
    }
    let cursor = 0
    for (const section of sections) {
      if (placed.has(section.id)) continue
      const found = text.indexOf(section.text, cursor)
      if (found < 0) continue
      placed.add(section.id)
      out.push(...addedPieces(text.slice(cursor, found), index * 1000 + out.length))
      out.push(section)
      cursor = found + section.text.length
    }
    out.push(...addedPieces(text.slice(cursor), index * 1000 + out.length))
  })

  return out
}

import type { PromptSection, TraceItem } from '../types'
import {
  CHARS_PER_TOKEN,
  isPlainObject,
  parseSettings,
  SettingsShapeError,
  writeSettings,
} from './tools'

/** The loopback port the trace receiver listens on, and Claude Code exports to. */
export const TRACE_PORT = 43180

/** What the receiver's `GET /health` answers (trace/store.mjs keeps the same text). */
export const RECEIVER_HEALTH = 'desktop-statusline trace receiver 5'
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

/** Whether a settings object turns tracing on, every value as tracing sets it. */
export function isTraceOn(settings: unknown): boolean {
  const env = (settings as { env?: unknown } | null)?.env
  if (!isPlainObject(env)) return false

  return Object.entries(TRACE_ENV).every(([key, value]) => env[key] === value)
}

/**
 * The settings file's text with tracing's `env` values added or taken out,
 * everything else kept. Off takes out only what still holds tracing's value,
 * so a value the person set by hand stays.
 */
export function editTraceEnv(text: string, isOn: boolean): string {
  const settings = parseSettings(text)
  const env = settings.env ?? {}
  if (!isPlainObject(env)) {
    throw new SettingsShapeError('env in settings.json is not an object, so it was left as is.')
  }
  const next: Record<string, unknown> = { ...env }
  for (const [key, value] of Object.entries(TRACE_ENV)) {
    if (isOn) next[key] = value
    else if (next[key] === value) delete next[key]
  }
  if (JSON.stringify(next) === JSON.stringify(env)) return text
  settings.env = next

  return writeSettings(text, settings)
}

/** A request the receiver kept: what trace/store.mjs writes for each. */
export type TraceRecord = {
  seq: number
  at: string
  source: string
  model: string
  promptId: string | null
  system: string
  tools: string
  toolCount: number
  messageCount: number
  from: number
  /** Goes on from the request before, adding to its messages (trace/store.mjs). */
  continues?: boolean
  added: ApiMessage[]
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

/** The main loop's requests, by the engine's name for where a request came from. */
export function isMainSource(source: string): boolean {
  return source === 'sdk' || source.startsWith('repl_main_thread')
}

/**
 * Whether a request goes on from the one before, adding to its messages: newer
 * Claude Code sends the system prompt and the tools once, then the billing
 * header, no tools and the new messages. The receiver marks such a request;
 * one it kept before it knew to is a main request with no tools whose
 * messages start afresh. (trace/view.mjs reads them the same way.)
 */
export function goesOn(record: TraceRecord, hasBefore: boolean): boolean {
  return (
    record.continues === true ||
    (hasBefore &&
      record.continues === undefined &&
      isMainSource(record.source) &&
      record.toolCount === 0 &&
      record.from === 0)
  )
}

/**
 * The request whose system prompt and tools a request was sent with: itself,
 * or for one that goes on from the one before, the last of its kind that
 * carried them.
 */
export function promptRecord(records: readonly TraceRecord[], seq: number): TraceRecord | null {
  const target = records.find(one => one.seq === seq)
  if (!target) return null
  if (target.toolCount > 0) return target
  const before = records
    .filter(one => one.source === target.source && one.seq <= seq && one.toolCount > 0)
    .sort((a, b) => b.seq - a.seq)

  return before[0] ?? target
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
  const added = record.added.flatMap(message => blocksOf(message).map(blockLabel))
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
export function findMatches(rows: readonly string[], query: string): RowMatch[] {
  const needle = query.toLowerCase()
  if (needle.trim() === '') return []
  const found: RowMatch[] = []
  for (let row = 0; row < rows.length && found.length < MAX_MATCHES; row += 1) {
    const haystack = rows[row]!.toLowerCase()
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

/** A request as text: what it added to the conversation, then the answer. */
export function requestText(record: TraceRecord): string {
  const lines: string[] = []
  const count = record.added.length
  lines.push(
    `── Sent: ${count} new ${count === 1 ? 'message' : 'messages'} (${record.messageCount} in all), ` +
      `${record.toolCount} tools, ${record.model}`,
  )
  for (const message of record.added) {
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
  let messages: ApiMessage[] = []
  for (const one of [...records].sort((a, b) => a.seq - b.seq)) {
    if (one.source !== record.source) continue
    messages = goesOn(one, messages.length > 0)
      ? [...messages, ...one.added]
      : [...messages.slice(0, one.from), ...one.added]
    if (one.seq === seq) break
  }
  // What this request added comes last, however it was sent.
  const firstNew = Math.max(0, messages.length - record.added.length)
  const lines: string[] = []
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

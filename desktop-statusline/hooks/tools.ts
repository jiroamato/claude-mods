import type { SeenTool } from '../types'

/**
 * A one-line summary of each built-in tool, and the size of its input schema in
 * characters, read off the request Claude Code 2.1.302 sends. The schema is not
 * visible to a plugin, so a tool's size is estimated from its live description
 * plus this. Tools missing here are summarised from their own description.
 */
const CATALOG: Record<string, { summary: string; schemaChars?: number }> = {
  Agent: {
    summary: 'Launches a subagent to work on a task in its own context.',
    schemaChars: 2034,
  },
  AskUserQuestion: { summary: 'Asks you a multiple-choice question mid-task.' },
  Bash: { summary: 'Runs a shell command and returns its output.', schemaChars: 1855 },
  CronCreate: { summary: 'Schedules a prompt to run later, once or on a cron.', schemaChars: 924 },
  CronDelete: { summary: 'Cancels a scheduled cron job.', schemaChars: 219 },
  CronList: { summary: 'Lists the cron jobs scheduled in this session.', schemaChars: 126 },
  DesignSync: {
    summary: 'Reads and updates claude.ai/design design-system projects.',
    schemaChars: 5495,
  },
  Edit: { summary: 'Replaces an exact string in a file.', schemaChars: 584 },
  EnterPlanMode: { summary: 'Switches into plan mode to design before editing.' },
  EnterWorktree: { summary: 'Moves the session into an isolated git worktree.', schemaChars: 720 },
  ExitPlanMode: { summary: 'Presents the plan for your approval and leaves plan mode.' },
  ExitWorktree: {
    summary: 'Leaves the worktree and returns to the original folder.',
    schemaChars: 502,
  },
  Glob: { summary: 'Finds files by name pattern.', schemaChars: 557 },
  Grep: { summary: 'Searches file contents with ripgrep.', schemaChars: 2776 },
  ListAgents: { summary: 'Lists the agents and sessions it can message.', schemaChars: 336 },
  Monitor: { summary: 'Streams events from a long-running background script.', schemaChars: 1091 },
  NotebookEdit: {
    summary: 'Replaces, inserts or deletes a cell in a Jupyter notebook.',
    schemaChars: 981,
  },
  PowerShell: { summary: 'Runs a PowerShell command.', schemaChars: 876 },
  PushNotification: { summary: 'Sends you a desktop or phone notification.', schemaChars: 351 },
  Read: { summary: 'Reads a file, image, PDF or notebook from disk.', schemaChars: 1112 },
  ReportFindings: {
    summary: 'Reports code-review findings as a list for the app.',
    schemaChars: 1670,
  },
  ScheduleWakeup: { summary: 'Schedules when a /loop session wakes up next.', schemaChars: 1423 },
  SendMessage: { summary: 'Sends a message to another agent or session.', schemaChars: 1380 },
  Skill: { summary: 'Runs a skill: packaged instructions for a kind of task.', schemaChars: 345 },
  TaskStop: { summary: 'Stops a running background task.', schemaChars: 382 },
  TodoWrite: { summary: "Keeps a checklist of the task's steps." },
  WebFetch: { summary: 'Fetches a web page and answers a question about it.', schemaChars: 584 },
  WebSearch: { summary: 'Searches the web and returns result links.', schemaChars: 499 },
  Workflow: {
    summary: 'Runs a scripted multi-agent workflow in the background.',
    schemaChars: 1869,
  },
  Write: { summary: 'Writes a whole file to disk.', schemaChars: 367 },
}

/** Tools the panel never offers to remove: removing them breaks removal itself. */
export const KEPT_TOOLS: readonly string[] = ['ToolSearch']

/** The schema size assumed for a tool the catalog does not measure. */
const DEFAULT_SCHEMA_CHARS = 600
/** Characters per token, for schema JSON and English prose alike. */
export const CHARS_PER_TOKEN = 3.6
const SUMMARY_MAX = 90

/** A bare built-in tool name, as a deny rule spells a whole tool (`NotebookEdit`). */
export function isBareToolName(rule: string): boolean {
  return /^[A-Z][A-Za-z0-9_]*$/.test(rule)
}

/** The first sentence of a description, cut to a line's length. */
export function firstSentence(text: string, max = SUMMARY_MAX): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const sentence = /^(.+?[.!?])(\s|$)/.exec(flat)?.[1] ?? flat

  return sentence.length > max ? `${sentence.slice(0, max - 1)}…` : sentence
}

/** The tool's one-liner: the catalog's, else the first sentence of its description. */
export function summarize(name: string, description: string | undefined): string {
  const known = CATALOG[name]?.summary
  if (known) return known
  const prose = (description ?? '').replace(/^#.*$/gm, '').replace(/^\s*[-*]\s+/gm, '')
  const sentence = firstSentence(prose)

  return sentence === '' ? 'A built-in tool.' : sentence
}

/** A rough size of the tool's schema in the request: name, description and input schema. */
export function estimateTokens(name: string, description: string | undefined): number {
  const schema = CATALOG[name]?.schemaChars ?? DEFAULT_SCHEMA_CHARS
  const chars = name.length + (description?.length ?? 0) + schema + 40

  return Math.round(chars / CHARS_PER_TOKEN)
}

/** Where a tool stands, as the panel shows it. */
export type ToolStatus = 'in' | 'deferred' | 'removed' | 'back-next-session'

export type ToolRow = { name: string; summary: string; tokens: number; status: ToolStatus }

/**
 * The panel's tool rows: every built-in tool of the session, then any tool the
 * session started without because the settings deny it, or that was put back.
 * `known` holds the descriptions of tools seen in earlier sessions, so a tool
 * removed then still has its one-liner.
 */
export function toolRows(
  seen: Readonly<Record<string, SeenTool>>,
  known: Readonly<Record<string, string>>,
  removed: readonly string[],
  putBack: readonly string[],
): ToolRow[] {
  const rows: ToolRow[] = []
  for (const [name, tool] of Object.entries(seen)) {
    if (KEPT_TOOLS.includes(name)) continue
    const isRemoved = removed.includes(name)
    rows.push({
      name,
      summary: summarize(name, tool.description),
      tokens: tool.isDeferred ? 0 : estimateTokens(name, tool.description),
      status: isRemoved ? 'removed' : tool.isDeferred ? 'deferred' : 'in',
    })
  }
  for (const name of [...removed, ...putBack]) {
    if (name in seen || KEPT_TOOLS.includes(name) || rows.some(one => one.name === name)) continue
    if (!(name in CATALOG) && !(name in known) && !putBack.includes(name)) continue
    rows.push({
      name,
      summary: summarize(name, known[name]),
      tokens: estimateTokens(name, known[name]),
      status: removed.includes(name) ? 'removed' : 'back-next-session',
    })
  }

  const order: Record<ToolStatus, number> = {
    in: 0,
    deferred: 1,
    'back-next-session': 2,
    removed: 3,
  }

  return rows.sort(
    (a, b) =>
      order[a.status] - order[b.status] || b.tokens - a.tokens || a.name.localeCompare(b.name),
  )
}

/** The bare tool names a settings object denies (`permissions.deny`). */
export function deniedTools(settings: unknown): string[] {
  const deny = (settings as { permissions?: { deny?: unknown } } | null)?.permissions?.deny
  if (!Array.isArray(deny)) return []

  return deny.filter((rule): rule is string => typeof rule === 'string' && isBareToolName(rule))
}

/** Why the settings file was left untouched: it holds something the panel will not rewrite. */
export class SettingsShapeError extends Error {}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The settings a file holds: `{}` when it is empty; a byte-order mark is ignored. */
export function parseSettings(text: string): Record<string, unknown> {
  const body = text.replace(/^\uFEFF/, '')
  if (body.trim() === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new SettingsShapeError(
      'settings.json is not plain JSON (comments?), so it was left as is.',
    )
  }
  if (!isPlainObject(parsed)) {
    throw new SettingsShapeError('settings.json does not hold an object, so it was left as is.')
  }

  return parsed
}

/**
 * The settings file's text with `name` added to or dropped from
 * `permissions.deny`, everything else kept, and the file's byte-order mark,
 * line endings and indentation too. A `permissions` that is not an object, or
 * a `deny` that is not a list, is refused rather than rewritten.
 */
export function editDeny(text: string, name: string, shouldDeny: boolean): string {
  const settings = parseSettings(text)
  const permissions = settings.permissions ?? {}
  if (!isPlainObject(permissions)) {
    throw new SettingsShapeError(
      'permissions in settings.json is not an object, so it was left as is.',
    )
  }
  const deny = permissions.deny ?? []
  if (!Array.isArray(deny)) {
    throw new SettingsShapeError(
      'permissions.deny in settings.json is not a list, so it was left as is.',
    )
  }
  if (deny.includes(name) === shouldDeny) return text
  const next = deny.filter(rule => rule !== name)
  if (shouldDeny) next.push(name)
  settings.permissions = { ...permissions, deny: next }

  return writeSettings(text, settings)
}

/** `settings` as the file's text, keeping the file's byte-order mark, line endings and indentation. */
export function writeSettings(text: string, settings: Record<string, unknown>): string {
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : ''
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const indent = /^\uFEFF?\s*\{\r?\n([ \t]+)"/.exec(text)?.[1] ?? '  '

  return `${bom}${JSON.stringify(settings, null, indent).replace(/\n/g, eol)}${eol}`
}

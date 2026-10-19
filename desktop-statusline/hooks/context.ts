import type {
  CommandInfo,
  ContextMcpTool,
  PromptComposeSection,
  SessionContextBreakdown,
  SessionMessage,
  ToolUseSummary,
} from 'claude-code'

import type {
  ContextItem,
  ContextRow,
  ContextSnapshot,
  McpServer,
  PromptSection,
  RowKind,
} from '../types'
import { CHARS_PER_TOKEN, firstSentence } from './tools'

/** How many tool results the Messages row lists. */
const RESULTS_SHOWN = 8
/** A tool result smaller than this is not listed on its own. */
const RESULT_MIN_TOKENS = 500
const SKILL_LINE_MAX = 110

// The desktop's own /context card colours its four largest rows from a fixed
// chart palette and the rest in greys; these are its dark-theme values. The
// greys are theme keys, so they follow the light theme too.
const CHART = ['#5a88de', '#c36136', '#539b74', '#ba872e'] as const
const OTHER_USED = 'subtle'
const RESERVED = 'promptBorder'
const FREE = 'promptBorderShimmer'

const KIND_ORDER: Record<RowKind, number> = { used: 0, buffer: 1, free: 2, deferred: 3 }

// Where a skill comes from, in words, by the engine's name for the source.
const SKILL_SOURCE: Record<string, string> = {
  userSettings: 'your settings',
  projectSettings: 'this project',
  policySettings: 'your organization',
  'built-in': 'Claude Code',
  mcp: 'an MCP server',
  syncedSkills: 'claude.ai',
}

// Where a custom agent is defined, in words.
const AGENT_SOURCE: Record<string, string> = {
  userSettings: 'your settings',
  projectSettings: 'this project',
  policySettings: 'your organization',
  localSettings: 'this project (local)',
  plugin: 'a plugin',
  'built-in': 'Claude Code',
}

// The engine's section ids, in words, for the ones that open with no heading.
const SECTION_TITLE: Record<string, string> = {
  intro: 'Introduction',
  lean_body: 'Core instructions',
  bare: 'Bare prompt',
  system: 'System',
  doing_tasks: 'Doing tasks',
  actions: 'Actions',
  tools: 'Using tools',
  tone: 'Tone and style',
  communication: 'Communication',
  pronouns: 'Pronouns',
  action_caution: 'Caution with actions',
  memory: 'Memory',
  total_tokens: 'Token budget',
}

/** `21k`, `18.2k`, `894.5k`, `1M`: a token count as /context prints it. */
export function formatTokens(tokens: number): string {
  const round = (value: number) => value.toFixed(1).replace(/\.0$/, '')
  if (tokens >= 999_950) return `${round(tokens / 1_000_000)}M`
  if (tokens >= 1000) return `${round(tokens / 1000)}k`

  return String(Math.round(tokens))
}

/** `2.1%`: a row's share of the window, one decimal, as /context prints it. */
export function formatShare(tokens: number, window: number): string {
  return `${window > 0 ? ((tokens / window) * 100).toFixed(1) : '0.0'}%`
}

function basename(path: string): string {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))

  return index === -1 ? path : path.slice(index + 1)
}

function dirname(path: string): string {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))

  return index === -1 ? '' : path.slice(0, index)
}

/** `Bash: npm test`, `Read: register.tsx`: what a tool call was, in a few words. */
export function describeCall(use: Pick<ToolUseSummary, 'tool' | 'input'>): string {
  const input = use.input
  const pick = (key: string): string | undefined =>
    typeof input[key] === 'string' && input[key] !== '' ? (input[key] as string) : undefined
  const path = pick('file_path') ?? pick('notebook_path') ?? pick('path')
  let detail = path ? basename(path) : (pick('command') ?? pick('pattern') ?? pick('url'))
  detail ??= pick('description') ?? pick('prompt') ?? pick('query')
  if (!detail) return use.tool
  const line = detail.split('\n')[0]!.trim()

  return `${use.tool}: ${line.length > 40 ? `${line.slice(0, 39)}…` : line}`
}

function estimate(text: string): number {
  return text.length / CHARS_PER_TOKEN
}

/**
 * /context's rows in the order its card lists them, each with its swatch:
 * what is in the window largest first, then the reserve, the free space and
 * what loads on demand.
 */
export function contextRows(breakdown: SessionContextBreakdown): ContextRow[] {
  const rows = breakdown.categories
    .filter(row => row.tokens > 0)
    .map(row => ({ name: row.name, tokens: row.tokens, kind: row.kind }))
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || b.tokens - a.tokens)
  let rank = 0

  return rows.map(row => {
    if (row.kind !== 'used') return { ...row, color: row.kind === 'free' ? FREE : RESERVED }
    const color = CHART[rank] ?? OTHER_USED
    rank += 1

    return { ...row, color }
  })
}

/**
 * The largest tool results in the transcript. Sizes are estimated from their
 * text and scaled so the whole transcript adds up to the Messages row.
 */
export function largestResults(
  messages: readonly SessionMessage[],
  messageTokens: number,
): ContextItem[] {
  const results: ContextItem[] = []
  let estimated = 0
  for (const message of messages) {
    estimated += estimate(message.text)
    for (const use of message.toolUses) {
      estimated += estimate(JSON.stringify(use.input))
      const size = estimate(use.text ?? '')
      estimated += size
      results.push({ name: describeCall(use), tokens: size, detail: '' })
    }
  }
  const scale = estimated > 0 ? messageTokens / estimated : 0

  return results
    .map(one => ({ ...one, tokens: Math.round(one.tokens * scale) }))
    .filter(one => one.tokens >= RESULT_MIN_TOKENS)
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, RESULTS_SHOWN)
}

/** The MCP tools grouped by server, largest server first. */
export function mcpServers(tools: readonly ContextMcpTool[]): McpServer[] {
  const servers = new Map<string, McpServer>()
  for (const tool of tools) {
    const server = servers.get(tool.serverName) ?? { name: tool.serverName, tokens: 0, tools: [] }
    const prefix = `mcp__${tool.serverName}__`
    server.tokens += tool.tokens
    server.tools.push({
      name: tool.name.startsWith(prefix) ? tool.name.slice(prefix.length) : tool.name,
      tokens: tool.tokens,
      detail: '',
    })
    servers.set(tool.serverName, server)
  }
  for (const server of servers.values()) server.tools.sort((a, b) => b.tokens - a.tokens)

  return [...servers.values()].sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name))
}

/** A section's title: its own heading, else its id in words. */
export function sectionTitle(section: Pick<PromptComposeSection, 'id' | 'text'>): string {
  const heading = /^\s*#{1,3}\s+(.+)$/m.exec(section.text.trimStart().split('\n')[0] ?? '')?.[1]
  if (heading) return heading.trim()
  const known = SECTION_TITLE[section.id]
  if (known) return known
  const words = section.id
    .replace(/^[^:]+:/, '')
    .replace(/[_-]+/g, ' ')
    .trim()

  return words === '' ? section.id : words[0]!.toUpperCase() + words.slice(1)
}

/** The system prompt's sections, each with a title and its estimated tokens. */
export function promptSections(sections: readonly PromptComposeSection[]): PromptSection[] {
  return sections
    .filter(one => one.text.trim() !== '')
    .map(one => ({
      id: one.id,
      title: sectionTitle(one),
      tokens: Math.round(estimate(one.text)),
      text: one.text.replace(/^\n+/, '').replace(/\s+$/, ''),
    }))
}

/** The context window as the card and the pane draw it: /context's rows and what is in each. */
export function buildSnapshot(
  breakdown: SessionContextBreakdown,
  messages: readonly SessionMessage[],
  commands: readonly CommandInfo[],
  sections: readonly PromptComposeSection[],
): ContextSnapshot {
  const rows = contextRows(breakdown)
  const messageTokens = rows.find(one => one.name === 'Messages')?.tokens ?? 0

  const descriptions = new Map(commands.map(one => [one.name, one.description]))
  const skills = (breakdown.skills?.skillFrontmatter ?? [])
    .map(one => ({
      name: one.name,
      tokens: one.tokens,
      source: one.pluginName ?? SKILL_SOURCE[String(one.source)] ?? String(one.source),
      description: firstSentence(descriptions.get(one.name) ?? '', SKILL_LINE_MAX),
    }))
    .sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name))

  return {
    used: breakdown.totalTokens,
    window: breakdown.rawMaxTokens,
    percent: breakdown.percentage,
    rows,
    results: largestResults(messages, messageTokens),
    skills,
    memoryFiles: breakdown.memoryFiles
      .map(one => ({
        name: basename(one.path),
        tokens: one.tokens,
        detail: `${one.type} · ${dirname(one.path)}`,
      }))
      .sort((a, b) => b.tokens - a.tokens),
    agents: breakdown.agents
      .map(one => ({
        name: one.agentType,
        tokens: one.tokens,
        detail: `From ${AGENT_SOURCE[one.source] ?? one.source}.`,
      }))
      .sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name)),
    mcpLoaded: mcpServers(breakdown.mcpTools.filter(one => one.isLoaded)),
    mcpDeferred: mcpServers(breakdown.mcpTools.filter(one => !one.isLoaded)),
    prompt: promptSections(sections),
  }
}

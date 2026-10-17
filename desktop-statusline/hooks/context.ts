import type {
  CommandInfo,
  SessionContextBreakdown,
  SessionMessage,
  ToolUseSummary,
} from 'claude-code'

import type { BlockKind, ContextBlock, ContextSnapshot } from '../types'
import { firstSentence } from './tools'

/** How many tool results the map names on their own, the rest folded into the conversation. */
const RESULTS_SHOWN = 6
/** A tool result smaller than this stays in the conversation's tile. */
const RESULT_MIN_TOKENS = 1000
const CHARS_PER_TOKEN = 3.6
const SKILL_LINE_MAX = 110

// /context's rows by the label it prints. The breakdown marks only whether a
// row is used, free or reserve, so the kind of content comes from the label;
// a row this does not know is drawn as system content.
const KIND_BY_CATEGORY: Record<string, BlockKind> = {
  'System prompt': 'system',
  'System tools': 'tools',
  'MCP tools': 'mcp',
  'MCP server instructions': 'mcp',
  'Custom agents': 'agents',
  'Memory files': 'memory',
  Skills: 'skills',
  Messages: 'conversation',
}

function basename(path: string): string {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))

  return index === -1 ? path : path.slice(index + 1)
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
 * The context window as the map draws it: /context's used rows, with the
 * messages split into their largest tool results and the conversation around
 * them. Result sizes are estimated from their text and scaled so the pieces
 * add up to the messages row.
 */
export function buildSnapshot(
  breakdown: SessionContextBreakdown,
  messages: readonly SessionMessage[],
  commands: readonly CommandInfo[],
): ContextSnapshot {
  const blocks: ContextBlock[] = []
  for (const row of breakdown.categories) {
    if (row.kind !== 'used' || row.tokens <= 0) continue
    const kind = KIND_BY_CATEGORY[row.name] ?? 'system'
    if (kind !== 'conversation') {
      blocks.push({ label: row.name, kind, tokens: row.tokens })
      continue
    }

    const results: ContextBlock[] = []
    let estimated = 0
    for (const message of messages) {
      estimated += estimate(message.text)
      for (const use of message.toolUses) {
        estimated += estimate(JSON.stringify(use.input))
        const size = estimate(use.text ?? '')
        estimated += size
        results.push({ label: describeCall(use), kind: 'result', tokens: size })
      }
    }
    const scale = estimated > 0 ? row.tokens / estimated : 0
    const shown = results
      .map(one => ({ ...one, tokens: Math.round(one.tokens * scale) }))
      .filter(one => one.tokens >= RESULT_MIN_TOKENS)
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, RESULTS_SHOWN)
    const rest = row.tokens - shown.reduce((sum, one) => sum + one.tokens, 0)
    blocks.push(...shown, {
      label: 'Conversation',
      kind: 'conversation',
      tokens: Math.max(0, rest),
    })
  }

  const descriptions = new Map(commands.map(one => [one.name, one.description]))
  const skills = (breakdown.skills?.skillFrontmatter ?? [])
    .map(one => ({
      name: one.name,
      tokens: one.tokens,
      source: one.pluginName ?? String(one.source),
      description: firstSentence(descriptions.get(one.name) ?? '', SKILL_LINE_MAX),
    }))
    .sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name))

  return {
    used: breakdown.totalTokens,
    window: breakdown.rawMaxTokens,
    percent: breakdown.percentage,
    blocks: blocks.sort((a, b) => b.tokens - a.tokens),
    skills,
  }
}

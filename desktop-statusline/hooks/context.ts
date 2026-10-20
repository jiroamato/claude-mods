import type { CommandInfo, PromptComposeSection, SessionContextBreakdown } from 'claude-code'

import type { ContextItem, ContextRow, ContextSnapshot, PromptSection, RowKind } from '../types'
import { CHARS_PER_TOKEN, firstSentence } from './tools'

const SKILL_LINE_MAX = 110

// The desktop's own /context card colours its four largest rows from its
// palette (blue-400, orange-400, aqua-400, yellow-350) and the rest in its warm
// grey (gray-350): solid for the rest of what is in the window, then fainter for
// the reserve and what loads on demand, and faintest for the free space. On the
// card's dark surface the faint ones land on its #5f5e5a and #292827; being
// see-through, they lighten on a light one.
const CHART = ['#3987e5', '#d95926', '#199e70', '#c98500'] as const
const OTHER_USED = '#97958d'
const RESERVED = '#97958d91'
export const FREE = '#97958d27'

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
 * What the window holds as a bar draws it, left to right: each row in it,
 * neighbouring rows of one colour as one segment, as the desktop's card draws
 * its greys. The free space is the track left over.
 */
export function barSegments(rows: readonly ContextRow[]): { color: string; tokens: number }[] {
  const segments: { color: string; tokens: number }[] = []
  for (const row of rows) {
    if (row.kind !== 'used' && row.kind !== 'buffer') continue
    const last = segments.at(-1)
    if (last?.color === row.color) last.tokens += row.tokens
    else segments.push({ color: row.color, tokens: row.tokens })
  }

  return segments
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
  commands: readonly CommandInfo[],
  sections: readonly PromptComposeSection[],
): ContextSnapshot {
  const rows = contextRows(breakdown)

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
    skills,
    prompt: promptSections(sections),
  }
}

/**
 * The breakdown kept in the state, or null while none stands in this version's
 * shape: a reload keeps what an earlier version of the plugin wrote.
 */
export function currentSnapshot(value: unknown): ContextSnapshot | null {
  const rows = (value as { rows?: unknown } | null)?.rows

  return Array.isArray(rows) ? (value as ContextSnapshot) : null
}

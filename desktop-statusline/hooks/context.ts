import type {
  CommandInfo,
  ContextSkill,
  PromptComposeSection,
  SessionContextBreakdown,
} from 'claude-code'

import type { ContextRow, ContextSnapshot, PromptSection, RowKind, SkillOrigin } from '../types'
import { CHARS_PER_TOKEN, firstSentence } from './tools'

const SKILL_LINE_MAX = 110

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

/**
 * Who put a skill in the session: Anthropic for the skills Claude Code
 * bundles (`built-in`, and the default plugins it ships, `cc-plugin-*`) and
 * the ones the desktop app adds (`anthropic-skills:*`); the organization for
 * managed settings; else the person, by their settings, a plugin or a server.
 */
export function skillOrigin(
  skill: Pick<ContextSkill, 'name' | 'source' | 'pluginName'>,
): SkillOrigin {
  const plugin = skill.pluginName ?? ''
  if (
    skill.source === 'built-in' ||
    skill.name.startsWith('anthropic-skills:') ||
    plugin === 'anthropic-skills' ||
    plugin.startsWith('cc-plugin-')
  ) {
    return 'anthropic'
  }

  return skill.source === 'policySettings' ? 'organization' : 'yours'
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

function estimate(text: string): number {
  return text.length / CHARS_PER_TOKEN
}

/**
 * /context's rows in the order its card lists them: what is in the window
 * largest first, then the reserve, the free space and what loads on demand.
 */
export function contextRows(breakdown: SessionContextBreakdown): ContextRow[] {
  return breakdown.categories
    .filter(row => row.tokens > 0)
    .map(row => ({ name: row.name, tokens: row.tokens, kind: row.kind }))
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || b.tokens - a.tokens)
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

/** The context window as the pane reads it: /context's rows, the skills and the system prompt. */
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
      origin: skillOrigin(one),
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

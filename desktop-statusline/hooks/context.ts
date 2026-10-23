import type {
  CommandInfo,
  ContextSkill,
  PromptComposeSection,
  SessionContextBreakdown,
} from 'claude-code'

import type { ContextRow, ContextSnapshot, PromptSection, SkillOrigin } from '../types'
import { CHARS_PER_TOKEN, firstSentence } from './tools'

const SKILL_LINE_MAX = 110

const SKILL_SOURCE: Record<string, string> = {
  userSettings: 'your settings',
  projectSettings: 'this project',
  policySettings: 'your organization',
  'built-in': 'Claude Code',
  mcp: 'an MCP server',
  syncedSkills: 'claude.ai',
}

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

export function formatTokens(tokens: number): string {
  const round = (value: number) => value.toFixed(1).replace(/\.0$/, '')
  if (tokens >= 999_950) return `${round(tokens / 1_000_000)}M`
  if (tokens >= 1000) return `${round(tokens / 1000)}k`

  return String(Math.round(tokens))
}

export function formatShare(tokens: number, window: number): string {
  return `${window > 0 ? ((tokens / window) * 100).toFixed(1) : '0.0'}%`
}

function estimate(text: string): number {
  return text.length / CHARS_PER_TOKEN
}

function contextRows(breakdown: SessionContextBreakdown): ContextRow[] {
  return breakdown.categories
    .filter(row => row.tokens > 0)
    .map(row => ({ name: row.name, tokens: row.tokens }))
}

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

function promptSections(sections: readonly PromptComposeSection[]): PromptSection[] {
  return sections
    .filter(one => one.text.trim() !== '')
    .map(one => ({
      id: one.id,
      title: sectionTitle(one),
      tokens: Math.round(estimate(one.text)),
      text: one.text.replace(/^\n+/, '').replace(/\s+$/, ''),
    }))
}

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
    window: breakdown.rawMaxTokens,
    rows,
    skills,
    prompt: promptSections(sections),
  }
}

export function currentSnapshot(value: unknown): ContextSnapshot | null {
  const rows = (value as { rows?: unknown } | null)?.rows

  return Array.isArray(rows) ? (value as ContextSnapshot) : null
}

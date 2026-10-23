export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type GitInfo = { branch: string; isDirty: boolean } | null

export type ContextRow = {
  name: string
  tokens: number
}

export type ContextItem = { name: string; tokens: number; detail: string }

export type PromptSection = {
  id: string
  title: string
  tokens: number
  text: string
  isAdded?: boolean
}

export type SkillOrigin = 'yours' | 'anthropic' | 'organization'

export type PaneTab = 'tools' | 'prompt' | 'skills' | 'trace'

export type TraceItem = {
  seq: number
  at: string
  source: string
  model: string
  promptId: string | null
  added: string[]
  reply: string | null
  usage: {
    input?: number
    output?: number
    cacheRead?: number
    cacheWrite?: number
    costUsd?: number
    durationMs?: number
    effort?: string | null
  } | null
  messageCount: number
  toolCount: number
}

export type TraceStatus =
  'off' | 'next-session' | 'emptied' | 'no-node' | 'unreachable' | 'elsewhere' | 'on'

export type TraceState = {
  status: TraceStatus
  items: TraceItem[]
  prompt: PromptSection[] | null
  view: { session: string; token: string } | null
  replaced: string[]
  differing: string[]
}

export type TracePlaces = { settings: string; traces: string }

export type ContextSnapshot = {
  window: number
  rows: ContextRow[]
  skills: {
    name: string
    tokens: number
    source: string
    description: string
    origin: SkillOrigin
  }[]
  prompt: PromptSection[]
}

export type SeenTool = { description: string; isDeferred: boolean }

declare module 'claude-code' {
  interface PluginState {
    'desktop-statusline': {
      steps: number
      git: GitInfo
      effort: Effort | null
      context: ContextSnapshot | null
      expanded: string[]
      collapsed: string[]
      tab: PaneTab
      page: number
      reader: number | null
      readerSearch: { query: string; index: number }
      readerOffset: number
      trace: TraceState
      traceError: string | null
      folderError: string | null
      tools: Record<string, SeenTool>
      removed: string[]
      putBack: string[]
      toolError: string | null
    }
  }
}

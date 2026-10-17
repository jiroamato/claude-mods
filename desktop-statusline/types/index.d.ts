export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type GitInfo = { branch: string; isDirty: boolean } | null

/** What one tile of the context map stands for. */
export type BlockKind =
  'system' | 'tools' | 'mcp' | 'agents' | 'memory' | 'skills' | 'conversation' | 'result'

/** One tile of the context map: a category, or one tool result within the messages. */
export type ContextBlock = { label: string; kind: BlockKind; tokens: number }

/** The context window broken down, as the hover card and the pane draw it. */
export type ContextSnapshot = {
  /** Tokens in use, as /context counts them. */
  used: number
  /** The window measured against. */
  window: number
  /** Used over window, a whole percentage. */
  percent: number
  /** Every used category, the messages split into their largest tool results. */
  blocks: ContextBlock[]
  /** Each listed skill with its listing's tokens. */
  skills: { name: string; tokens: number; source: string; description: string }[]
}

/** A built-in tool as the engine described it to the model this session. */
export type SeenTool = { description: string; isDeferred: boolean }

declare module 'claude-code' {
  interface PluginState {
    'desktop-statusline': {
      /** Bumped once a second so the band redraws its live figures. */
      tick: number
      /** The working copy's branch and whether it has uncommitted changes. */
      git: GitInfo
      /** The reasoning effort of the last main-loop request, or the configured one. */
      effort: Effort | null
      /** The context window broken down, refreshed after every turn; null until read. */
      context: ContextSnapshot | null
      /** The built-in tools of this session, by name, as `tool.describe` saw them. */
      tools: Record<string, SeenTool>
      /** Built-in tools denied by bare name in the user settings, read from the file. */
      removed: string[]
      /** Tools put back during this session that it started without. */
      putBack: string[]
      /** Why the last Remove or Put back failed, until the next one succeeds. */
      toolError: string | null
    }
  }
}

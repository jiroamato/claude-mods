export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type GitInfo = { branch: string; isDirty: boolean } | null

/** What a /context row is: in the window, the window left, the compaction reserve, or loaded on demand. */
export type RowKind = 'used' | 'free' | 'buffer' | 'deferred'

/** One row of the breakdown, as /context lists it. */
export type ContextRow = {
  /** The row's label as /context prints it (`System tools`, `Free space`). */
  name: string
  tokens: number
  kind: RowKind
  /** The swatch's colour: a theme key, or a fixed chart colour for the four largest rows. */
  color: string
}

/** One piece of a row, listed when the row is expanded. */
export type ContextItem = { name: string; tokens: number; detail: string }

/** One section of the system prompt, with its text. */
export type PromptSection = { id: string; title: string; tokens: number; text: string }

/** The pane's tabs: what the desktop's own Context card cannot show. */
export type PaneTab = 'tools' | 'prompt' | 'skills' | 'results'

/** The context window broken down, as the pane draws it. */
export type ContextSnapshot = {
  /** Tokens in use, as /context counts them. */
  used: number
  /** The window measured against. */
  window: number
  /** Used over window, a whole percentage. */
  percent: number
  /** /context's rows: in use largest first, then the reserve, the free space, what loads on demand. */
  rows: ContextRow[]
  /** The largest tool results within the messages, largest first. */
  results: ContextItem[]
  /** Each listed skill with its listing's tokens. */
  skills: { name: string; tokens: number; source: string; description: string }[]
  /** The system prompt's sections, in the order they are sent. */
  prompt: PromptSection[]
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
      /** Which of the pane's system prompt sections are open, by key. */
      expanded: string[]
      /** The pane's open tab. */
      tab: PaneTab
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

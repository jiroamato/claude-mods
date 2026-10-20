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
export type PromptSection = {
  id: string
  title: string
  tokens: number
  text: string
  /** Sent, but not one of the engine's own sections: the output style, an app's instructions. */
  isAdded?: boolean
}

/** Who put a skill in the session. */
export type SkillOrigin = 'yours' | 'anthropic' | 'organization'

/** The pane's tabs: what the desktop's own Context card cannot show. */
export type PaneTab = 'tools' | 'prompt' | 'skills' | 'trace'

/** One request of the conversation as the Trace tab lists it, from the trace receiver. */
export type TraceItem = {
  seq: number
  /** When it was sent, an ISO timestamp. */
  at: string
  /** The engine's name for where it came from (`sdk`, `generate_session_title`, ...). */
  source: string
  model: string
  /** The person's prompt it answers, shared by every request of that turn. */
  promptId: string | null
  /** What it added to the conversation, a few words each. */
  added: string[]
  /** What came back, in a few words; null while no answer is recorded. */
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

/** Whether this session is traced, and why not when it is not. */
export type TraceStatus =
  /** Tracing is off in the user settings. */
  | 'off'
  /** On in the settings, but this session started before: its next one is traced. */
  | 'next-session'
  /** On, but Node.js, which runs the receiver, is not on the PATH. */
  | 'no-node'
  /** On, and this session's requests are recorded. */
  | 'on'

/** The conversation's trace, as the receiver recorded it. */
export type TraceState = {
  status: TraceStatus
  /** Every request recorded for this session, oldest first. */
  items: TraceItem[]
  /** The system prompt the last main request sent, its sections in order; null before one. */
  prompt: PromptSection[] | null
  /** What links to the trace's pages in the browser; null while none can be served. */
  view: { session: string; token: string } | null
}

/** The files tracing touches: the settings it writes, and the one folder its traces are kept in. */
export type TracePlaces = { settings: string; traces: string }

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
  /** Each listed skill with its listing's tokens. */
  skills: {
    name: string
    tokens: number
    source: string
    description: string
    /** Who put it there: the person, Anthropic (bundled with Claude Code or the app), or their organization. */
    origin: SkillOrigin
  }[]
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
      /** Which of the pane's groups are closed, by key: a group is open until closed. */
      collapsed: string[]
      /** The pane's open tab. */
      tab: PaneTab
      /** Which page of the open request's or section's text is shown, from 0. */
      page: number
      /** The request the pane reads whole, by its number; null while the pane shows its tabs. */
      reader: number | null
      /** The reader's search: what is looked for, and which match is current. */
      readerSearch: { query: string; index: number }
      /** The conversation's trace, read from the receiver's folder after each turn. */
      trace: TraceState
      /** Why the last tracing switch failed, until the next one succeeds. */
      traceError: string | null
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

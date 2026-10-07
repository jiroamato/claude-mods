export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type GitInfo = { branch: string; isDirty: boolean } | null

declare module 'claude-code' {
  interface PluginState {
    'desktop-statusline': {
      /** Bumped once a second so the band redraws its live figures. */
      tick: number
      /** The working copy's branch and whether it has uncommitted changes. */
      git: GitInfo
      /** The reasoning effort of the last main-loop request, or the configured one. */
      effort: Effort | null
    }
  }
}

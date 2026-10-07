import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Effort, GitInfo } from '../types'

// Mirrors ~/.claude/statusline.py (the CLI status line) on the desktop
// surface, drawn as one band above the prompt. Colours are theme keys, so
// the band follows the app's light and dark palettes and its accent:
//
//   Fable 5.1 │ high │ construct-land | main •        [▮▮▮▮      ] 33%   $1.23   12m 4s

const tick = atom({ plugin: 'desktop-statusline', key: 'tick' } as const, 0)
const git = atom({ plugin: 'desktop-statusline', key: 'git' } as const, null)
const effort = atom({ plugin: 'desktop-statusline', key: 'effort' } as const, null)

const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
const EFFORT_LABEL: Record<Effort, string> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'x-high',
  max: 'max',
}
// Quiet for cheap, through the text colour, to the warning and error tones
// for the two top levels, so the intensity reads at a glance.
const EFFORT_COLOR: Record<Effort, string> = {
  low: 'inactive',
  medium: 'secondaryText',
  high: 'text',
  xhigh: 'warning',
  max: 'error',
}

// The context meter: a hollow rounded rectangle, filled from the left.
const METER_WIDTH = 64
const METER_HEIGHT = 10
const METER_STROKE = 1
const METER_OUTLINE = '#8a8a8a'
const METER_FILL = '#c19c00'
// The hairline between model, effort and folder: one pixel wide, a solid
// mid grey a few shades off the band's background, muted like the meter's
// outline rather than a theme key, so it reads the same in light and dark.
const DIVIDER_WIDTH = 1
const DIVIDER_HEIGHT = 14
const DIVIDER_COLOR = '#5a5a5a'
const DIVIDER_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" width="${DIVIDER_WIDTH}" height="${DIVIDER_HEIGHT}" viewBox="0 0 ${DIVIDER_WIDTH} ${DIVIDER_HEIGHT}">` +
  `<rect width="${DIVIDER_WIDTH}" height="${DIVIDER_HEIGHT}" fill="${DIVIDER_COLOR}"/>` +
  `</svg>`
const GIT_REFRESH_EVERY_TICKS = 15
// The widest reading the timer draws (`59m 59s`, `23h 59m`), so the slot
// holds its width as the digits change and nothing to its left shifts.
const ELAPSED_COLUMNS = 7

function asEffort(value: unknown): Effort | null {
  if (typeof value !== 'string') return null
  const lower = value.toLowerCase()

  return (EFFORTS as readonly string[]).includes(lower) ? (lower as Effort) : null
}

function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))

  return index === -1 ? trimmed : trimmed.slice(index + 1)
}

/** `claude-fable-5-1` -> `Fable 5.1`; a name already spelled for display is kept. */
function prettyModel(model: string): string {
  if (/\s/.test(model) || /[A-Z]/.test(model)) return model
  const parts = model.replace(/^claude-/, '').split('-').filter(Boolean)
  if (parts.length === 0) return model
  const words: string[] = []
  const digits: string[] = []
  for (const part of parts) {
    if (/^\d+$/.test(part)) digits.push(part)
    else if (digits.length === 0) words.push(part[0]!.toUpperCase() + part.slice(1))
  }
  const name = words.join(' ')

  return digits.length > 0 ? `${name} ${digits.join('.')}` : name
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)

  return `${hours}h ${minutes % 60}m`
}

/** The meter's markup: a grey rounded outline, the fill clipped to its inside. */
function meterSvg(percent: number | undefined): string {
  const w = METER_WIDTH
  const h = METER_HEIGHT
  const s = METER_STROKE
  const radius = h / 2
  const innerWidth = w - 2 * s
  const innerHeight = h - 2 * s
  const filled = Math.round((Math.max(0, Math.min(100, percent ?? 0)) / 100) * innerWidth)

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<defs><clipPath id="inside"><rect x="${s}" y="${s}" width="${innerWidth}" height="${innerHeight}" rx="${radius - s}"/></clipPath></defs>` +
    `<rect x="${s}" y="${s}" width="${filled}" height="${innerHeight}" fill="${METER_FILL}" clip-path="url(#inside)"/>` +
    `<rect x="${s / 2}" y="${s / 2}" width="${w - s}" height="${h - s}" rx="${radius}" fill="none" stroke="${METER_OUTLINE}" stroke-width="${s}"/>` +
    `</svg>`
  )
}

async function refreshGit($: EngineInterface): Promise<void> {
  let next: GitInfo = null
  try {
    const cwd = await $.session.cwd()
    const head = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      timeoutMs: 3000,
    })
    if (head.exitCode === 0) {
      const branch = head.stdout.trim()
      const status = await $.process.run(['git', 'status', '--porcelain'], {
        cwd,
        timeoutMs: 5000,
      })
      const isDirty = status.exitCode === 0 && status.stdout.trim().length > 0
      next = { branch, isDirty }
    }
  } catch {
    next = null
  }
  await update($, git, () => next)
}

/** The effort the session is configured with, when no request has told us yet. */
async function configuredEffort($: EngineInterface): Promise<Effort | null> {
  try {
    const row = (await $.config.list()).find(one => /effort/i.test(one.key))
    const fromConfig = asEffort(row?.value)
    if (fromConfig) return fromConfig
  } catch {
    // the menu may not be listable here; fall through to settings
  }
  try {
    const settings = await $.settings.read()
    const model = (await $.session.model()).toLowerCase()
    const perModel = settings.modelSettings
    if (perModel && typeof perModel === 'object') {
      for (const [id, value] of Object.entries(perModel as Record<string, unknown>)) {
        const lower = id.toLowerCase()
        const isMatch = lower === model || lower.includes(model) || model.includes(lower)
        if (isMatch && value && typeof value === 'object') {
          const found = asEffort((value as Record<string, unknown>).effortLevel)
          if (found) return found
        }
      }
    }

    return asEffort(settings.effortLevel)
  } catch {
    return null
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)

    void (async () => {
      const configured = await configuredEffort($)
      await update($, effort, current => current ?? configured)
      await refreshGit($)
    })()

    $.clock.every(1000, () => {
      void (async () => {
        const count = await update($, tick, n => n + 1)
        if (count % GIT_REFRESH_EVERY_TICKS === 0) await refreshGit($)
      })()
    })

    return started
  })

  // The live effort of each main-loop request, as the engine sends it.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      const level = asEffort(e.effort)
      if (level) void update($, effort, () => level)
    }

    return yield* next(e)
  })

  // A turn may have committed, switched branch or touched files: re-read git.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) void refreshGit($)

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // The CLI already has its own status line; this band is for the desktop.
    if (e.surface !== 'desktop' || e.props.hasSurvey) return next(e)

    const { Box, Svg, Text } = $.ui.resolve(e)

    // Subscribes this drawing to the once-a-second tick.
    await read($, tick)
    const [model, cwd, usage, repo, level, now] = await Promise.all([
      $.session.model(),
      $.session.cwd(),
      $.session.usage(),
      read($, git),
      read($, effort),
      $.clock.now(),
    ])

    const folder = basename(cwd)
    const percent = usage.context.percent
    const usd = usage.cost?.usd
    const elapsed = now - usage.startedAt

    const hasPlace = folder !== '' || repo !== null
    const divider = () => (
      <Svg source={DIVIDER_SVG} alt="divider" width={DIVIDER_WIDTH} height={DIVIDER_HEIGHT} />
    )

    return (
      <Box flexDirection="row" flexWrap="wrap" alignItems="center" paddingX={1} columnGap={3}>
        {/* Identity: what is answering, how hard, and where, a hairline between each. */}
        <Box flexDirection="row" alignItems="center" columnGap={2}>
          <Text color="claude" bold>
            {prettyModel(model)}
          </Text>
          {level !== null && divider()}
          {level !== null && <Text color={EFFORT_COLOR[level]}>{EFFORT_LABEL[level]}</Text>}
          {hasPlace && divider()}
          {hasPlace && (
            <Box flexDirection="row" alignItems="center" columnGap={1}>
              {folder !== '' && <Text color="text">{folder}</Text>}
              {folder !== '' && repo !== null && <Text color="inactive">|</Text>}
              {repo !== null && <Text color="secondaryText">{repo.branch}</Text>}
              {repo?.isDirty && <Text color="warning">•</Text>}
            </Box>
          )}
        </Box>

        <Box flexGrow={1} />

        {/* Live figures: context, cost, elapsed. */}
        <Box flexDirection="row" alignItems="center" columnGap={1}>
          <Svg
            source={meterSvg(percent)}
            alt={percent === undefined ? 'context: no reading yet' : `context ${percent}% used`}
            width={METER_WIDTH}
            height={METER_HEIGHT}
          />
          <Text color={percent === undefined ? 'inactive' : 'text'}>
            {percent === undefined ? '--%' : `${percent}%`}
          </Text>
        </Box>

        {usd !== undefined && <Text color="text">${usd.toFixed(2)}</Text>}

        <Box width={ELAPSED_COLUMNS} justifyContent="flex-end">
          <Text color="secondaryText">{formatDuration(elapsed)}</Text>
        </Box>
      </Box>
    )
  })
}

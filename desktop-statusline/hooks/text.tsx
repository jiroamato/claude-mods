import type { ClientSurface } from 'claude-code'

type TextRow = {
  text: string
  hits: { start: number; end: number; isCurrent: boolean }[]
}

export type TextProps = {
  rows: TextRow[]
  base: number
  first: number
  page: number
  total: number
}

export type TextPick = { by: number } | { to: 'start' | 'end' } | { first: number }

export const READER_TEXT_KEY = 'reader-text'

const SCROLLBAR_COLUMNS = 2
const SCROLLBAR_DRAWN_COLUMNS = 1
const THUMB_MIN_ROWS = 2

const HIT = '#c9850059'
const HIT_CURRENT = '#c98500'

const TRACK = '#80808018'
const THUMB = '#80808066'
const THUMB_LIT = '#808080aa'

const GLIDE_MS = 16
const GLIDE_SHARE = 0.28

const latest = new WeakMap<object, TextProps>()

const shownBy = new WeakMap<object, number>()

type State = {
  step: number
  hover: boolean
  isDragging: boolean
  grab: number
}

const AT_REST: State = { step: 0, hover: false, isDragging: false, grab: 0 }

function thumbAt(props: TextProps, first: number) {
  const trackRows = Math.max(1, props.page)
  const thumbRows = Math.min(
    trackRows,
    Math.max(THUMB_MIN_ROWS, Math.round((props.page / Math.max(1, props.total)) * trackRows)),
  )
  const last = Math.max(0, props.total - props.page)
  const top = Math.round((last === 0 ? 0 : first / last) * (trackRows - thumbRows))

  return { trackRows, thumbRows, last, top }
}

export default function ReaderText(props: TextProps, surface: ClientSurface<State>) {
  const { Box, Text } = surface.elements
  const state = surface.state ?? AT_REST
  const isWired = latest.has(surface)
  latest.set(surface, props)
  if (!isWired) {
    shownBy.set(surface, props.first)
    const now = () => latest.get(surface)!
    const current = () => surface.state ?? AT_REST
    surface.onKey(event => {
      const pick = KEY_PICKS[event.key]?.(now().page)
      if (pick) surface.post(pick)
    })
    const rowAt = (y: number, grab: number) => {
      const { trackRows, thumbRows, last } = thumbAt(now(), 0)
      const room = Math.max(1, trackRows - thumbRows)
      const top = Math.max(0, Math.min(room, y - grab))

      return Math.round((top / room) * last)
    }
    const dragTo = (y: number) => {
      const first = rowAt(y, current().grab)
      shownBy.set(surface, first)
      surface.post({ first } satisfies TextPick)
      surface.setState({ ...current(), step: current().step + 1 })
    }
    const isOnTrack = (x: number) => x >= surface.columns - SCROLLBAR_COLUMNS
    const isInside = (x: number, y: number) =>
      x >= 0 && x < surface.columns && y >= 0 && y < surface.rows
    surface.onPointer(event => {
      const was = current()
      if (event.type === 'leave') {
        if (was.hover) surface.setState({ ...was, hover: false })
        return
      }
      if (event.type === 'down' && event.button === 'left' && isOnTrack(event.x)) {
        const { thumbRows, top } = thumbAt(now(), now().first)
        const isOnThumb = event.y >= top && event.y < top + thumbRows
        const grab = isOnThumb ? event.y - top : Math.floor(thumbRows / 2)
        surface.setState({ ...was, hover: true, isDragging: true, grab })
        dragTo(event.y)
        return
      }
      if (event.type === 'move' && event.button === 'left' && was.isDragging) {
        dragTo(event.y)
        return
      }
      if (event.type === 'up' && was.isDragging) {
        const hover = isOnTrack(event.x) && isInside(event.x, event.y)
        surface.setState({ ...was, isDragging: false, hover })
        return
      }
      const hover = isOnTrack(event.x)
      if (hover !== was.hover) surface.setState({ ...was, hover })
    })
    surface.every(GLIDE_MS, () => {
      if (current().isDragging) return
      const target = now().first
      const shown = shownBy.get(surface) ?? target
      if (shown === target) return
      const away = target - shown
      const step = Math.sign(away) * Math.max(1, Math.round(Math.abs(away) * GLIDE_SHARE))
      shownBy.set(surface, Math.abs(step) >= Math.abs(away) ? target : shown + step)
      surface.setState({ ...current(), step: current().step + 1 })
    })
  }

  const lowest = props.base
  const highest = Math.max(lowest, props.base + props.rows.length - props.page)
  const wanted = shownBy.get(surface) ?? props.first
  const shown = Math.max(lowest, Math.min(highest, wanted))
  if (!state.isDragging) shownBy.set(surface, shown)
  const rows = props.rows.slice(shown - props.base, shown - props.base + props.page)

  const {
    trackRows,
    thumbRows,
    top: thumbTop,
  } = thumbAt(props, state.isDragging ? wanted : props.first)

  return (
    <Box flexDirection="row" height={props.page} columnGap={1}>
      <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
        {rows.map(row => {
          if (row.hits.length === 0) {
            return (
              <Text color="text" mono wrap="truncate-end">
                {row.text === '' ? ' ' : row.text}
              </Text>
            )
          }
          const parts: JSX.Element[] = []
          let at = 0
          for (const hit of row.hits) {
            if (hit.start > at) parts.push(<Text>{row.text.slice(at, hit.start)}</Text>)
            parts.push(
              <Text
                backgroundColor={hit.isCurrent ? HIT_CURRENT : HIT}
                color={hit.isCurrent ? 'inverseText' : 'text'}
              >
                {row.text.slice(hit.start, hit.end)}
              </Text>,
            )
            at = hit.end
          }
          if (at < row.text.length) parts.push(<Text>{row.text.slice(at)}</Text>)

          return (
            <Text color="text" mono wrap="truncate-end">
              {parts}
            </Text>
          )
        })}
      </Box>
      <Box width={SCROLLBAR_COLUMNS} height={trackRows} flexShrink={0} alignItems="flex-end">
        <Box
          width={SCROLLBAR_DRAWN_COLUMNS}
          height={trackRows}
          flexShrink={0}
          flexDirection="column"
          backgroundColor={TRACK}
        >
          <Box height={thumbTop} flexShrink={0} />
          <Box
            width={SCROLLBAR_DRAWN_COLUMNS}
            height={thumbRows}
            flexShrink={0}
            backgroundColor={state.hover || state.isDragging ? THUMB_LIT : THUMB}
          />
        </Box>
      </Box>
    </Box>
  )
}

const KEY_PICKS: Record<string, (page: number) => TextPick> = {
  up: () => ({ by: -1 }),
  down: () => ({ by: 1 }),
  pageup: page => ({ by: -page }),
  pagedown: page => ({ by: page }),
  home: () => ({ to: 'start' }),
  end: () => ({ to: 'end' }),
}

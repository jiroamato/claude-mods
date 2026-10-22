import type { ClientSurface } from 'claude-code'

/** One drawn row, as the pane hands it: its text, and the matches in it. */
export type TextRow = {
  text: string
  hits: { start: number; end: number; isCurrent: boolean }[]
}

/**
 * What the pane hands the reader's text: the rows around the view (a screen
 * above it, the view, a screen below), where they start, which row is to be
 * first in view, how many rows the view holds, and how many the request has,
 * for the scrollbar beside the rows.
 */
export type TextProps = {
  rows: TextRow[]
  /** The row of the request `rows[0]` is, from 0. */
  base: number
  /** The row to be first in view: the text glides there from where it is. */
  first: number
  /** The rows in view, and what a page key moves by. */
  page: number
  /** How many rows the request has: the scrollbar's whole. */
  total: number
}

/**
 * What the text posts to the hooks module: rows to move by, an end to go
 * to, or the row to put first in view (a press or a drag on its scrollbar).
 */
export type TextPick = { by: number } | { to: 'start' | 'end' } | { first: number }

/** The key of the reader's text, which the hooks module hears it post under. */
export const READER_TEXT_KEY = 'reader-text'

/** How wide the scrollbar's track is, in cells: thin, and wide enough to take a press. */
export const SCROLLBAR_COLUMNS = 2

// A match, and the current one, as the desktop marks found text.
const HIT = '#c9850059'
const HIT_CURRENT = '#c98500'

// The track and its thumb: a mid grey seen through, so both show on a light
// theme too, the thumb lit under the pointer and while dragged.
const TRACK = '#80808018'
const THUMB = '#80808066'
const THUMB_LIT = '#808080aa'

/** How often the glide steps, in milliseconds: once a frame at sixty a second. */
const GLIDE_MS = 16
/** The share of the way left the glide covers each step: an ease-out, a row at least. */
const GLIDE_SHARE = 0.28

/** The props each instance last drew with, by its surface, for listeners set once. */
const latest = new WeakMap<object, TextProps>()

/**
 * The row each instance shows first, by its surface: where its glide is, on
 * the way to the props' `first`. Kept here, not in the state, so the glide's
 * clock reads it before the first drawing has set any state.
 */
const shownBy = new WeakMap<object, number>()

type State = {
  /** A count of the glide's steps: each one asks for a drawing. */
  step: number
  /** Whether the pointer is over the scrollbar's track. */
  hover: boolean
  /** Whether the thumb is being dragged. */
  isDragging: boolean
}

const AT_REST: State = { step: 0, hover: false, isDragging: false }

/**
 * The reader's text: the rows in view with a scrollbar beside them, drawn as
 * one region so a click gives it the keys, and the keys then move the rows
 * (Up and Down a row, Page Up and Page Down a page, Home and End to the
 * ends), by what it posts to the hooks module; a press or a drag on the
 * track posts the row to put first in view. The pane's own window never
 * moves: the reader's tree fits it.
 *
 * The scrollbar is in this region, not one of its own, because the desktop
 * draws nothing of the pane's tree while a pointer is held, nor hands a
 * region its next props: only a region's own state draws then. So while the
 * thumb is held the region moves the thumb and its rows itself, from the
 * pointer, over the rows it has, and the row it asks the pane for at each
 * move lands when the thumb is let go.
 *
 * A move glides: the region keeps the row it shows first, and each frame
 * takes it a share of the way to the row the pane asks for, so a page, a
 * match or a drag reads as scrolling, not as a cut. The pane hands a screen
 * of rows either side of the view for the glide to cross; a longer move
 * starts a screen away and glides in.
 */
export default function ReaderText(props: TextProps, surface: ClientSurface<State>) {
  const { Box, Text } = surface.elements
  const state = surface.state ?? AT_REST
  const isWired = latest.has(surface)
  latest.set(surface, props)
  if (!isWired) {
    // The first drawing is where the pane asks: nothing to glide from yet.
    shownBy.set(surface, props.first)
    const now = () => latest.get(surface)!
    const current = () => surface.state ?? AT_REST
    surface.onKey(event => {
      const pick = KEY_PICKS[event.key]?.(now().page)
      if (pick) surface.post(pick)
    })
    // Where in the track the pointer is, as the row to put first in view: the
    // track's rows map onto the rows that can be first.
    const rowAt = (y: number) => {
      const { total, page } = now()
      const rows = Math.max(1, page)
      const last = Math.max(0, total - page)
      const row = Math.max(0, Math.min(rows - 1, y))

      return Math.round((row / Math.max(1, rows - 1)) * last)
    }
    // While the thumb is held, the region moves its own rows from the pointer,
    // over the rows it has, and asks the pane for the row at each move: the
    // desktop draws nothing of the pane's tree, nor hands a region its next
    // props, while a pointer is held, so the pane's answer lands at release.
    const dragTo = (y: number) => {
      const first = rowAt(y)
      shownBy.set(surface, first)
      surface.post({ first } satisfies TextPick)
      surface.setState({ ...current(), step: current().step + 1 })
    }
    const isOnTrack = (x: number) => x >= surface.columns - SCROLLBAR_COLUMNS
    surface.onPointer(event => {
      const was = current()
      if (event.type === 'leave') {
        if (was.hover) surface.setState({ ...was, hover: false })
        return
      }
      if (event.type === 'down' && event.button === 'left' && isOnTrack(event.x)) {
        surface.setState({ ...was, hover: true, isDragging: true })
        dragTo(event.y)
        return
      }
      if (event.type === 'move' && event.button === 'left' && was.isDragging) {
        dragTo(event.y)
        return
      }
      if (event.type === 'up' && was.isDragging) {
        surface.setState({ ...was, isDragging: false, hover: isOnTrack(event.x) })
        return
      }
      const hover = isOnTrack(event.x)
      if (hover !== was.hover) surface.setState({ ...was, hover })
    })
    // Started once, with the instance: each frame, a step of the glide where
    // one is under way, and nothing where the text is where it should be.
    surface.every(GLIDE_MS, () => {
      // A held thumb puts the rows where the pointer says, not where the pane last did.
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

  // The first row drawn: where the glide is, or where a held thumb points,
  // kept within the rows handed over, so a move from too far starts a screen
  // away and glides in. A held thumb past those rows shows their nearest end
  // until it is let go, and the pane's answer brings the rows asked for.
  const lowest = props.base
  const highest = Math.max(lowest, props.base + props.rows.length - props.page)
  const wanted = shownBy.get(surface) ?? props.first
  const shown = Math.max(lowest, Math.min(highest, wanted))
  if (!state.isDragging) shownBy.set(surface, shown)
  const rows = props.rows.slice(shown - props.base, shown - props.base + props.page)

  // The scrollbar: the thumb as tall as the rows in view are of the request,
  // one row at least, from where the first row in view is in it: the row the
  // pane asked for, or, while the thumb is held, the row the pointer is on.
  const trackRows = Math.max(1, props.page)
  const thumbRows = Math.max(
    1,
    Math.min(trackRows, Math.round((props.page / Math.max(1, props.total)) * trackRows)),
  )
  const last = Math.max(0, props.total - props.page)
  const at = state.isDragging ? wanted : props.first
  const thumbTop = Math.round((last === 0 ? 0 : at / last) * (trackRows - thumbRows))

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
      <Box
        flexDirection="column"
        width={SCROLLBAR_COLUMNS}
        height={trackRows}
        flexShrink={0}
        backgroundColor={TRACK}
      >
        {thumbTop > 0 && <Box height={thumbTop} flexShrink={0} />}
        <Box
          height={thumbRows}
          flexShrink={0}
          backgroundColor={state.hover || state.isDragging ? THUMB_LIT : THUMB}
        />
      </Box>
    </Box>
  )
}

/** What each key moves by, given the page's rows. */
const KEY_PICKS: Record<string, (page: number) => TextPick> = {
  up: () => ({ by: -1 }),
  down: () => ({ by: 1 }),
  pageup: page => ({ by: -page }),
  pagedown: page => ({ by: page }),
  home: () => ({ to: 'start' }),
  end: () => ({ to: 'end' }),
}

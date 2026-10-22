import type { ClientSurface } from 'claude-code'

/** One drawn row, as the pane hands it: its text, and the matches in it. */
export type TextRow = {
  text: string
  hits: { start: number; end: number; isCurrent: boolean }[]
}

/**
 * What the pane hands the reader's text: the rows around the view (a screen
 * above it, the view, a screen below), where they start, which row is to be
 * first in view, and how many rows the view holds.
 */
export type TextProps = {
  rows: TextRow[]
  /** The row of the request `rows[0]` is, from 0. */
  base: number
  /** The row to be first in view: the text glides there from where it is. */
  first: number
  /** The rows in view, and what a page key moves by. */
  page: number
}

/** What the text posts to the hooks module: rows to move by, or an end to go to. */
export type TextPick = { by: number } | { to: 'start' | 'end' }

/** The key of the reader's text, which the hooks module hears it post under. */
export const READER_TEXT_KEY = 'reader-text'

// A match, and the current one, as the desktop marks found text.
const HIT = '#c9850059'
const HIT_CURRENT = '#c98500'

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

/** The state is a count of the glide's steps: each one asks for a drawing. */
type State = { step: number }

/**
 * The reader's text: the rows in view, drawn as one region so a click gives
 * it the keys, and the keys then move the rows (Up and Down a row, Page Up
 * and Page Down a page, Home and End to the ends), by what it posts to the
 * hooks module. The pane's own window never moves: the reader's tree fits it.
 *
 * A move glides: the region keeps the row it shows first, and each frame
 * takes it a share of the way to the row the pane asks for, so a page, a
 * match or a drag reads as scrolling, not as a cut. The pane hands a screen
 * of rows either side of the view for the glide to cross; a longer move
 * starts a screen away and glides in.
 */
export default function ReaderText(props: TextProps, surface: ClientSurface<State>) {
  const { Box, Text } = surface.elements
  const isWired = latest.has(surface)
  latest.set(surface, props)
  if (!isWired) {
    // The first drawing is where the pane asks: nothing to glide from yet.
    shownBy.set(surface, props.first)
    surface.onKey(event => {
      const page = latest.get(surface)!.page
      const pick = KEY_PICKS[event.key]?.(page)
      if (pick) surface.post(pick)
    })
    // Started once, with the instance: each frame, a step of the glide where
    // one is under way, and nothing where the text is where it should be.
    surface.every(GLIDE_MS, () => {
      const now = latest.get(surface)!
      const shown = shownBy.get(surface) ?? now.first
      if (shown === now.first) return
      const away = now.first - shown
      const step = Math.sign(away) * Math.max(1, Math.round(Math.abs(away) * GLIDE_SHARE))
      shownBy.set(surface, Math.abs(step) >= Math.abs(away) ? now.first : shown + step)
      surface.setState({ step: (surface.state?.step ?? 0) + 1 })
    })
  }

  // The first row drawn: where the glide is, kept within the rows handed
  // over, so a move from too far starts a screen away and glides in.
  const lowest = props.base
  const highest = Math.max(lowest, props.base + props.rows.length - props.page)
  const shown = Math.max(lowest, Math.min(highest, shownBy.get(surface) ?? props.first))
  shownBy.set(surface, shown)
  const rows = props.rows.slice(shown - props.base, shown - props.base + props.page)

  return (
    <Box flexDirection="column" height={props.page} overflow="hidden">
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

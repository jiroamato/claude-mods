import type { ClientSurface } from 'claude-code'

/** One drawn row, as the pane hands it: its text, and the matches in it. */
export type TextRow = {
  text: string
  hits: { start: number; end: number; isCurrent: boolean }[]
}

/** What the pane hands the reader's text: the rows in view, and how many a page is. */
export type TextProps = {
  rows: TextRow[]
  /** The rows a page key moves by: as many as are in view. */
  page: number
}

/** What the text posts to the hooks module: rows to move by, or an end to go to. */
export type TextPick = { by: number } | { to: 'start' | 'end' }

/** The key of the reader's text, which the hooks module hears it post under. */
export const READER_TEXT_KEY = 'reader-text'

// A match, and the current one, as the desktop marks found text.
const HIT = '#c9850059'
const HIT_CURRENT = '#c98500'

/** The props each instance last drew with, by its surface, for a listener set once. */
const latest = new WeakMap<object, TextProps>()

/**
 * The reader's text: the rows in view, drawn as one region so a click gives
 * it the keys, and the keys then move the rows (Up and Down a row, Page Up
 * and Page Down a page, Home and End to the ends), by what it posts to the
 * hooks module. The pane's own window never moves: the reader's tree fits it.
 */
export default function ReaderText(props: TextProps, surface: ClientSurface<never>) {
  const { Box, Text } = surface.elements
  const isWired = latest.has(surface)
  latest.set(surface, props)
  if (!isWired) {
    surface.onKey(event => {
      const page = latest.get(surface)!.page
      const pick = KEY_PICKS[event.key]?.(page)
      if (pick) surface.post(pick)
    })
  }

  return (
    <Box flexDirection="column">
      {props.rows.map(row => {
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

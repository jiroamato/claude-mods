import type { ClientSurface } from 'claude-code'

/** What the pane hands the reader's scrollbar: where the rows in view are in the request. */
export type ScrollbarProps = {
  /** The first row in view, from 0. */
  first: number
  /** How many rows are in view: the track's height too, beside them. */
  visible: number
  /** How many rows the request has. */
  total: number
}

/** What the scrollbar posts to the hooks module: the row to put first in view. */
export type ScrollbarPick = { first: number }

/** The key of the reader's scrollbar, which the hooks module hears it post under. */
export const READER_SCROLLBAR_KEY = 'reader-scrollbar'

/** How wide the track is, in cells: two, thin, and wide enough to take a press. */
export const SCROLLBAR_COLUMNS = 2

// The track and its thumb: a mid grey seen through, so both show on a light
// theme too (the desktop's own scrollbar greys on the dark pane), the thumb
// lit under the pointer and while dragged.
const TRACK = '#80808018'
const THUMB = '#80808066'
const THUMB_LIT = '#808080aa'

type State = { hover: boolean; isDragging: boolean }

/** The props each instance last drew with, by its surface, for listeners set once. */
const latest = new WeakMap<object, ScrollbarProps>()

/**
 * The reader's scrollbar, a region of its own beside the text: a thumb for
 * the rows in view, and a press or a drag that puts the row under the pointer
 * first in view, by what it posts to the hooks module. The pane's own
 * scrollbar never shows for the reader, which fits the window; this one is
 * the plugin's, so dragging it moves the text alone and the top stays.
 *
 * The thumb's top is the row the pointer is on, so a drag reads as taking
 * the thumb by its top edge: simple, and the same whether the press lands on
 * the thumb or beside it.
 */
export default function Scrollbar(props: ScrollbarProps, surface: ClientSurface<State>) {
  const { Box } = surface.elements
  const state = surface.state ?? { hover: false, isDragging: false }
  const isWired = latest.has(surface)
  latest.set(surface, props)
  if (!isWired) {
    const now = () => latest.get(surface)!
    const pick = (y: number) => {
      const { total, visible } = now()
      // The track is as tall as the rows in view: the region is laid out by
      // what the module draws, so its own `rows` may lag a drawing behind.
      const rows = Math.max(1, visible)
      // The track's rows map onto the request's: the pointer's row, as a share
      // of the track, is the first row in view, as a share of what can be first.
      const last = Math.max(0, total - visible)
      const first = Math.round((Math.max(0, Math.min(rows - 1, y)) / Math.max(1, rows - 1)) * last)
      surface.post({ first } satisfies ScrollbarPick)
    }
    surface.onPointer(event => {
      const current = surface.state ?? { hover: false, isDragging: false }
      if (event.type === 'leave') {
        if (current.hover) surface.setState({ ...current, hover: false })
        return
      }
      if (event.type === 'down' && event.button === 'left') {
        surface.setState({ hover: true, isDragging: true })
        pick(event.y)
        return
      }
      if (event.type === 'move' && event.button === 'left' && current.isDragging) {
        pick(event.y)
        return
      }
      if (event.type === 'up') {
        surface.setState({ ...current, isDragging: false })
        return
      }
      if (!current.hover) surface.setState({ ...current, hover: true })
    })
  }

  const { first, visible, total } = props
  // The track is as tall as the rows in view, drawn so: the region takes the
  // height its module draws, whatever the pane asked for.
  const rows = Math.max(1, visible)
  // The thumb: as tall as the rows in view are of the request, one row at least,
  // from where the first row in view is in it.
  const thumbRows = Math.max(1, Math.min(rows, Math.round((visible / Math.max(1, total)) * rows)))
  const last = Math.max(0, total - visible)
  const thumbTop = Math.round((last === 0 ? 0 : first / last) * (rows - thumbRows))

  return (
    <Box
      flexDirection="column"
      width={SCROLLBAR_COLUMNS}
      height={rows}
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
  )
}

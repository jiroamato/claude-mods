import type { ClientSurface } from 'claude-code'

/** What the pane hands the reader's top line. */
export type ReaderBarProps = { title: string; detail: string }

/** What the line posts to the hooks module when the person goes back. */
export type ReaderBarPick = { back: true }

/** The instances whose listeners are set. */
const wired = new WeakSet<object>()

/**
 * The reader's top line: the way back to the trace, and what is being read.
 * A region of its own so it is exactly one row high: the reader counts rows
 * to draw only the lines on screen, and a Button is taller than a row.
 */
export default function ReaderBar(
  props: ReaderBarProps,
  surface: ClientSurface<{ hover: boolean }>,
) {
  const { Box, Text } = surface.elements
  const isHover = surface.state?.hover === true

  // Its listeners are set once, at the first drawing: set again at every one,
  // an event that comes while one is replaced (the pointer leaving) is lost.
  const isWired = wired.has(surface)
  wired.add(surface)
  // Read as things stand when the event comes, not as a drawing saw them.
  const isLit = () => surface.state?.hover === true
  if (!isWired)
    surface.onPointer(event => {
      if (event.type === 'leave') {
        if (isLit()) surface.setState({ hover: false })
        return
      }
      if (event.type === 'down' && event.button === 'left')
        surface.post({ back: true } satisfies ReaderBarPick)
      if (!isLit()) surface.setState({ hover: true })
    })
  if (!isWired)
    surface.onKey(event => {
      if (event.key === 'backspace' || event.key === 'left')
        surface.post({ back: true } satisfies ReaderBarPick)
    })

  return (
    <Box flexDirection="row" columnGap={2}>
      <Text color={isHover ? 'text' : 'secondaryText'} underline={isHover}>
        ← Back to the trace
      </Text>
      <Text color="text">{props.title}</Text>
      <Text color="subtle">{props.detail}</Text>
    </Box>
  )
}

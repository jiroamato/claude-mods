import type { ClientSurface } from 'claude-code'

export type ReaderBarProps = { title: string; detail: string }

export type ReaderBarPick = { back: true }

const wired = new WeakSet<object>()

export default function ReaderBar(
  props: ReaderBarProps,
  surface: ClientSurface<{ hover: boolean }>,
) {
  const { Box, Text } = surface.elements
  const isHover = surface.state?.hover === true

  const isWired = wired.has(surface)
  wired.add(surface)
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

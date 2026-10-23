import type { ClientSurface } from 'claude-code'

export type TabProps = {
  id: string
  label: string
  figure: string | null
  isOpen: boolean
}

export type TabPick = { tab: string } | { step: -1 | 1 }

export const TAB_PREFIX = 'tab-'

type State = { hover: boolean }

const latest = new WeakMap<object, TabProps>()

const CLEAR = '#00000000'
const OPEN = '#8080802c'
const HOVER = '#80808016'

export default function Tab(props: TabProps, surface: ClientSurface<State>) {
  const { Box, Text } = surface.elements
  const isHover = surface.state?.hover === true
  const isWired = latest.has(surface)
  latest.set(surface, props)
  if (!isWired) {
    const now = () => latest.get(surface)!
    const isLit = () => surface.state?.hover === true
    surface.onPointer(event => {
      if (event.type === 'leave') {
        if (isLit()) surface.setState({ hover: false })
        return
      }
      if (event.type === 'down' && event.button === 'left' && !now().isOpen) {
        surface.post({ tab: now().id } satisfies TabPick)
      }
      if (!isLit()) surface.setState({ hover: true })
    })
    surface.onKey(event => {
      if (event.key === 'left') surface.post({ step: -1 } satisfies TabPick)
      if (event.key === 'right') surface.post({ step: 1 } satisfies TabPick)
    })
  }

  return (
    <Box
      flexDirection="row"
      justifyContent="center"
      columnGap={1}
      paddingY="xs"
      borderStyle="round"
      borderColor={CLEAR}
      paddingX={0}
      backgroundColor={props.isOpen ? OPEN : isHover ? HOVER : CLEAR}
    >
      <Text color={props.isOpen ? 'text' : 'secondaryText'}>{props.label}</Text>
      {props.figure !== null && (
        <Text color="subtle" tabular>
          {props.figure}
        </Text>
      )}
    </Box>
  )
}

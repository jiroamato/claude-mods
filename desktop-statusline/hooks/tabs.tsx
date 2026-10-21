import type { ClientSurface } from 'claude-code'

/** One tab as the pane hands it: its id, label and, where /context counts it, its size. */
export type TabProps = {
  id: string
  label: string
  figure: string | null
  isOpen: boolean
  /** The tabs beside it, for the left and right keys. */
  previous: string | null
  next: string | null
}

/** What a tab posts to the hooks module when it is picked. */
export type TabPick = { tab: string }

/** The key prefix of a tab's region, which the hooks module hears it post under. */
export const TAB_PREFIX = 'tab-'

type State = { hover: boolean }

/** The props each instance last drew with, by its surface, for listeners set once. */
const latest = new WeakMap<object, TabProps>()

// A border no one sees: only a Box with a border has rounded corners.
const CLEAR = '#00000000'
// The open tab raised on the strip's track, a tab under the pointer between.
// A mid grey, seen through: it lightens a dark theme's track and darkens a
// light one's, where white would vanish (on the dark track, #252524 open).
const OPEN = '#8080802c'
const HOVER = '#80808016'

/**
 * One tab of the Context details pane's strip, a region of its own so its
 * whole pill takes the press, not only its label: a Button is drawn no wider
 * than its label. Each tab its own region, so a press is the tab's under the
 * pointer, never one worked out from a width. The left and right keys move
 * to the tabs beside it.
 */
export default function Tab(props: TabProps, surface: ClientSurface<State>) {
  const { Box, Text } = surface.elements
  const isHover = surface.state?.hover === true
  // Its listeners are set once, at the first drawing, and read the latest
  // props: set again at every drawing, an event that comes while one is
  // replaced (the pointer leaving) is lost, a tab left lit.
  const isWired = latest.has(surface)
  latest.set(surface, props)
  if (!isWired) {
    const now = () => latest.get(surface)!
    const isLit = () => surface.state?.hover === true
    const pick = (id: string | null) => {
      if (id !== null && !(id === now().id && now().isOpen)) {
        surface.post({ tab: id } satisfies TabPick)
      }
    }
    surface.onPointer(event => {
      if (event.type === 'leave') {
        if (isLit()) surface.setState({ hover: false })
        return
      }
      if (event.type === 'down' && event.button === 'left') pick(now().id)
      if (!isLit()) surface.setState({ hover: true })
    })
    surface.onKey(event => {
      if (event.key === 'left') pick(now().previous)
      if (event.key === 'right') pick(now().next)
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

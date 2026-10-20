import type { ClientSurface } from 'claude-code'

/** One tab as the pane hands it: its id, label and, where /context counts it, its size. */
export type TabStripTab = { id: string; label: string; figure: string | null }

/** What the pane hands the strip. */
export type TabStripProps = { tabs: TabStripTab[]; open: string }

/** What the strip posts to the hooks module when a tab is picked. */
export type TabStripPick = { tab: string }

type State = { hover: number | null }

// A border no one sees: only a Box with a border has rounded corners.
const CLEAR = '#00000000'
// A recessed track, the open tab raised on it, a tab under the pointer between.
const TRACK = '#0000004d'
const OPEN = '#ffffff14'
const HOVER = '#ffffff0a'

/**
 * The Context details pane's tab strip, drawn as a region of its own so the
 * whole pill of a tab takes the press, not only its label: a Button is drawn
 * no wider than its label. The left and right keys move between the tabs.
 */
export default function TabStrip(props: TabStripProps, surface: ClientSurface<State>) {
  const { Box, Text } = surface.elements
  const tabs = props.tabs
  const hover = surface.state?.hover ?? null
  const openIndex = Math.max(
    0,
    tabs.findIndex(one => one.id === props.open),
  )
  const pick = (index: number) => {
    const tab = tabs[index]
    if (tab && tab.id !== props.open) surface.post({ tab: tab.id } satisfies TabStripPick)
  }
  // Which tab a column is over: each takes an equal share of the region.
  const at = (x: number) =>
    Math.min(tabs.length - 1, Math.floor((x / Math.max(1, surface.columns)) * tabs.length))

  surface.onPointer(event => {
    if (event.type === 'leave') {
      if (hover !== null) surface.setState({ hover: null })
      return
    }
    const index = at(event.x)
    if (event.type === 'down' && event.button === 'left') pick(index)
    if (index !== hover) surface.setState({ hover: index })
  })
  surface.onKey(event => {
    if (event.key === 'left') pick(Math.max(0, openIndex - 1))
    if (event.key === 'right') pick(Math.min(tabs.length - 1, openIndex + 1))
  })

  const rounded = { borderStyle: 'round', borderColor: CLEAR } as const

  return (
    <Box flexDirection="row" columnGap="xs" padding="xs" {...rounded} backgroundColor={TRACK}>
      {tabs.map((tab, index) => {
        const isOpen = tab.id === props.open
        const fill = isOpen ? OPEN : index === hover ? HOVER : CLEAR

        return (
          // Each tab an equal share of the strip, whatever its label.
          <Box
            flexGrow={1}
            width={0}
            flexDirection="row"
            justifyContent="center"
            columnGap={1}
            paddingY="xs"
            {...rounded}
            backgroundColor={fill}
          >
            <Text color={isOpen ? 'text' : 'secondaryText'}>{tab.label}</Text>
            {tab.figure !== null && (
              <Text color="subtle" tabular>
                {tab.figure}
              </Text>
            )}
          </Box>
        )
      })}
    </Box>
  )
}

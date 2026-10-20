import type { ClientSurface } from 'claude-code'

/** What the pane hands a row that opens: its address, label, figure, and whether it is open. */
export type DisclosureProps = {
  id: string
  label: string
  /** Drawn after the label, quieter: `added`, a time. */
  tag?: string
  /** Right-aligned: a size, a cost. */
  figure: string
  isOpen: boolean
  /** A card's heading: its label set as the card's, its figures smaller. */
  isHeading?: boolean
}

/** A row's height: room above and below its line, so its lit pill is not cramped. */
export const DISCLOSURE_ROWS = 1.7

/** What the row posts to the hooks module when pressed. */
export type DisclosurePick = { toggle: string }

// A border no one sees: only a Box with a border has rounded corners.
const CLEAR = '#00000000'
// The row under the pointer, as the desktop lights its own rows that open.
const HOVER = '#ffffff0f'

/**
 * The props each instance last drew with, by its surface: its listeners are
 * set once, at its first drawing, and read them here. Set again at every
 * drawing, a listener is replaced while events arrive, and one that comes in
 * between (the pointer leaving) is lost, the row left lit.
 */
const latest = new WeakMap<object, DisclosureProps>()

/**
 * A row that opens and closes what is under it, drawn as the desktop draws
 * its own (the Context card's MCP tools): the chevron first, the label, the
 * figure at the far end, and the whole row lit and pressed, not the label
 * alone. A region of its own, as a Button is drawn no wider than its label.
 */
export default function Disclosure(
  props: DisclosureProps,
  surface: ClientSurface<{ hover: boolean }>,
) {
  const { Box, Text } = surface.elements
  const isHover = surface.state?.hover === true
  const isWired = latest.has(surface)
  latest.set(surface, props)
  if (!isWired) {
    // Read as things stand when the event comes, not as a drawing saw them.
    const isLit = () => surface.state?.hover === true
    const toggle = () => surface.post({ toggle: latest.get(surface)!.id } satisfies DisclosurePick)
    surface.onPointer(event => {
      if (event.type === 'leave') {
        if (isLit()) surface.setState({ hover: false })
        return
      }
      if (event.type === 'down' && event.button === 'left') toggle()
      if (!isLit()) surface.setState({ hover: true })
    })
    surface.onKey(event => {
      if (event.key === 'return' || event.key === ' ') toggle()
    })
  }

  return (
    <Box
      flexDirection="row"
      alignItems="center"
      columnGap={1}
      paddingX={1}
      borderStyle="round"
      borderColor={CLEAR}
      paddingY={0}
      height={DISCLOSURE_ROWS}
      backgroundColor={isHover ? HOVER : CLEAR}
    >
      {/* The chevron's room: the pane draws the icon under this region. */}
      <Box width={1.6} flexShrink={0} />
      <Box flexDirection="row" columnGap={1} flexGrow={1} flexShrink={1} minWidth={0}>
        <Text
          color="text"
          wrap="truncate-end"
          {...(props.isHeading ? { weight: 'semibold' as const } : {})}
        >
          {props.label}
        </Text>
        {props.tag !== undefined && <Text color="subtle">{props.tag}</Text>}
      </Box>
      <Box flexShrink={0}>
        <Text color="subtle" tabular {...(props.isHeading ? { size: 'footnote' as const } : {})}>
          {props.figure}
        </Text>
      </Box>
    </Box>
  )
}

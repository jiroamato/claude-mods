import type { ClientSurface } from 'claude-code'

export type DisclosureProps = {
  id: string
  label: string
  tag?: string
  figure: string
  isOpen: boolean
  isHeading?: boolean
  lines?: string[]
}

export const DISCLOSURE_ROWS = 1.7
const LINES_BOTTOM = (DISCLOSURE_ROWS - 1) / 2
const CHEVRON_COLUMNS = 1.6
const LABEL_INDENT = CHEVRON_COLUMNS + 1

export function disclosureRows(props: Pick<DisclosureProps, 'lines'>): number {
  const count = props.lines?.length ?? 0

  return count === 0 ? DISCLOSURE_ROWS : DISCLOSURE_ROWS + count + LINES_BOTTOM
}

export type DisclosurePick = { toggle: string }

const CLEAR = '#00000000'
const HOVER = '#80808020'

const latest = new WeakMap<object, DisclosureProps>()

export default function Disclosure(
  props: DisclosureProps,
  surface: ClientSurface<{ hover: boolean }>,
) {
  const { Box, Text } = surface.elements
  const isHover = surface.state?.hover === true
  const isWired = latest.has(surface)
  latest.set(surface, props)
  if (!isWired) {
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

  const lines = props.lines ?? []

  return (
    <Box
      flexDirection="column"
      paddingX={1}
      borderStyle="round"
      borderColor={CLEAR}
      paddingY={0}
      height={disclosureRows(props)}
      backgroundColor={isHover ? HOVER : CLEAR}
    >
      <Box flexDirection="row" alignItems="center" columnGap={1} height={DISCLOSURE_ROWS}>
        <Box width={CHEVRON_COLUMNS} flexShrink={0} />
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
      {lines.length > 0 && (
        <Box flexDirection="row">
          <Box width={LABEL_INDENT} flexShrink={0} />
          <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
            {lines.map(line => (
              <Text color="subtle" wrap="truncate-end">
                {line}
              </Text>
            ))}
          </Box>
        </Box>
      )}
    </Box>
  )
}

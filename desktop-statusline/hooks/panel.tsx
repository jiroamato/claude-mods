import type { ElementTable } from 'claude-code'

import type { ContextSnapshot } from '../types'
import { BLOCK_COLOR, formatTokens, treemapSvg } from './treemap'
import type { ToolRow } from './tools'

/** The pane the meter opens. */
export const PANE_ID = 'context-map'
export const PANE_TITLE = 'Context'

// The desktop draws a hover card as a popover about 360px wide, so the card
// stacks the map above the list; sizes in CSS pixels.
const CARD_MAP_WIDTH = 330
const CARD_MAP_HEIGHT = 150
const CARD_ITEMS = 6
const PANE_MAP_HEIGHT = 140
const SWATCH = 9

function swatch(color: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SWATCH}" height="${SWATCH}" viewBox="0 0 ${SWATCH} ${SWATCH}">` +
    `<rect width="${SWATCH}" height="${SWATCH}" rx="2" fill="${color}"/></svg>`
  )
}

function summaryLine(snapshot: ContextSnapshot): string {
  return `${formatTokens(snapshot.used)} of ${formatTokens(snapshot.window)} tokens`
}

/** The card the meter reveals on hover: the map, the largest pieces, how to open the pane. */
export function HoverCard(props: {
  ui: ElementTable<'desktop'>
  snapshot: ContextSnapshot | null
}) {
  const { Box, Svg, Text } = props.ui
  const snapshot = props.snapshot
  if (!snapshot) {
    return <Text color="secondaryText">The map appears after Claude's first reply.</Text>
  }
  const largest = snapshot.blocks.slice(0, CARD_ITEMS)

  return (
    <Box flexDirection="column" rowGap={1}>
      <Box flexDirection="row" columnGap={2}>
        <Text color="text" bold>
          Context {snapshot.percent}%
        </Text>
        <Text color="secondaryText">{summaryLine(snapshot)}</Text>
      </Box>
      <Svg
        source={treemapSvg(snapshot.blocks, CARD_MAP_WIDTH, CARD_MAP_HEIGHT)}
        alt="context map"
        width={CARD_MAP_WIDTH}
        height={CARD_MAP_HEIGHT}
        isInteractive
      />
      <Box flexDirection="column">
        {largest.map(block => (
          <Box key={`item-${block.label}`} flexDirection="row" alignItems="center" columnGap={1}>
            <Svg
              source={swatch(BLOCK_COLOR[block.kind])}
              alt={block.kind}
              width={SWATCH}
              height={SWATCH}
            />
            <Box flexGrow={1} flexShrink={1}>
              <Text color="text" wrap="truncate-end">
                {block.label}
              </Text>
            </Box>
            <Text color="secondaryText">{formatTokens(block.tokens)}</Text>
          </Box>
        ))}
      </Box>
      <Text color="inactive">Click the percentage to manage tools and see skills.</Text>
    </Box>
  )
}

const STATUS_NOTE: Record<ToolRow['status'], string> = {
  in: '',
  deferred: 'loaded on demand',
  removed: 'removed',
  'back-next-session': 'back in a new session',
}

/** The pane: the map, then every built-in tool with a switch, then the skills. */
export function ContextPane(props: {
  ui: ElementTable<'desktop'>
  snapshot: ContextSnapshot | null
  tools: ToolRow[]
  mapWidth: number
  /** Why the last Remove or Put back failed, if it did. */
  error: string | null
  onToggle: (name: string, isRemoved: boolean) => void
}) {
  const { Box, Button, Svg, Text } = props.ui
  const snapshot = props.snapshot

  return (
    <Box flexDirection="column" rowGap={1} paddingX={1}>
      {snapshot ? (
        <Box flexDirection="column" rowGap={1}>
          <Box flexDirection="row" columnGap={2}>
            <Text color="text" bold>
              {snapshot.percent}% used
            </Text>
            <Text color="secondaryText">{summaryLine(snapshot)}</Text>
          </Box>
          <Svg
            source={treemapSvg(snapshot.blocks, props.mapWidth, PANE_MAP_HEIGHT)}
            alt="context map"
            isInteractive
          />
        </Box>
      ) : (
        <Text color="secondaryText">The map appears after Claude's first reply.</Text>
      )}

      <Box flexDirection="column">
        <Text color="text" bold>
          Tools
        </Text>
        <Text color="secondaryText">
          Remove takes a tool out of this session's context at once (Claude can no longer call it)
          and adds it to permissions.deny in your user settings, so new sessions in every project
          start without it. Put back undoes both.
        </Text>
        {props.error && <Text color="error">{props.error}</Text>}
      </Box>
      {props.tools.map(tool => {
        const isRemoved = tool.status === 'removed'
        const note = STATUS_NOTE[tool.status]

        return (
          <Box key={`tool-${tool.name}`} flexDirection="row" alignItems="center" columnGap={2}>
            <Box flexDirection="column" flexGrow={1} flexShrink={1}>
              <Box flexDirection="row" columnGap={1}>
                <Text color={isRemoved ? 'inactive' : 'text'} bold strikethrough={isRemoved}>
                  {tool.name}
                </Text>
                {note !== '' && <Text color="inactive">{note}</Text>}
              </Box>
              <Text color="secondaryText">{tool.summary}</Text>
            </Box>
            <Text color={isRemoved ? 'inactive' : 'text'}>
              {tool.status === 'deferred' ? '0' : `~${formatTokens(tool.tokens)}`}
            </Text>
            <Button
              key={`toggle-${tool.name}`}
              label={isRemoved ? 'Put back' : 'Remove'}
              variant={isRemoved ? 'primary' : 'secondary'}
              onPress={() => props.onToggle(tool.name, !isRemoved)}
            />
          </Box>
        )
      })}

      <Box flexDirection="column">
        <Text color="text" bold>
          Skills
        </Text>
        <Text color="secondaryText">
          Each skill's listing as the model sees it. Removing skills is not supported yet.
        </Text>
      </Box>
      {snapshot && snapshot.skills.length === 0 && (
        <Text color="secondaryText">No skills listed.</Text>
      )}
      {snapshot?.skills.map(skill => (
        <Box key={`skill-${skill.name}`} flexDirection="column">
          <Box flexDirection="row" columnGap={1}>
            <Box flexGrow={1} flexShrink={1}>
              <Text color="text" bold>
                {skill.name}
              </Text>
            </Box>
            <Text color="text">~{formatTokens(skill.tokens)}</Text>
          </Box>
          <Text color="secondaryText">{skill.description || `From ${skill.source}.`}</Text>
        </Box>
      ))}
    </Box>
  )
}

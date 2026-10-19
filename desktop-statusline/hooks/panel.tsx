import type { ElementTable } from 'claude-code'

import type { ContextItem, ContextRow, ContextSnapshot, McpServer } from '../types'
import { FREE, formatShare, formatTokens } from './context'
import type { ToolRow } from './tools'

/** The pane the meter opens. */
export const PANE_ID = 'context-map'
export const PANE_TITLE = 'Context'

type Ui = ElementTable<'desktop'>

// Sizes in cells: across in character widths, down in rows. The desktop draws
// a hover card as a popover at most 360px wide, which holds about 40 columns.
const CARD_COLUMNS = 40
const SWATCH_WIDTH = 1.4
const SWATCH_HEIGHT = 0.55
// The swatch sits this close to its name, as on the desktop's own /context card.
const SWATCH_GAP = 0.25
// A plain Button pads its label by the `xs` step, about half a column.
const LABEL_PAD = 0.5
// The bar is as tall as a swatch; its see-through border takes a pixel off each
// edge, which leaves the desktop card's 8px pill.
const BAR_HEIGHT = SWATCH_HEIGHT
const BAR_GAP = 0.15
const BAR_MIN_SEGMENT = 0.4
const TOKENS_COLUMNS = 7
const SHARE_COLUMNS = 6
// The swatch, the gap after it and the label's padding, so what a row lists lines up under its name.
const DETAIL_INDENT = SWATCH_WIDTH + SWATCH_GAP + LABEL_PAD
// A border no one sees: only a Box with a border has rounded corners.
const CLEAR = '#00000000'
// One drawing holds at most 100000 characters of code; a section is cut well short of that.
const SECTION_TEXT_MAX = 40_000

const CLOSED = '▸'
const OPEN = '▾'

/** The pane's rows whose pieces it can list, by /context's label. */
const SYSTEM_TOOLS = 'System tools'
const SYSTEM_TOOLS_DEFERRED = 'System tools (deferred)'

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

function headerFigures(snapshot: ContextSnapshot): string {
  return `${formatTokens(snapshot.used)} / ${formatTokens(snapshot.window)} (${snapshot.percent}%)`
}

function Swatch(props: { ui: Ui; color: string }) {
  const { Box } = props.ui

  return <Box width={SWATCH_WIDTH} height={SWATCH_HEIGHT} backgroundColor={props.color} />
}

/** `Context window   72.6k / 1M (7%)`. */
function Header(props: { ui: Ui; snapshot: ContextSnapshot }) {
  const { Box, Text } = props.ui

  return (
    <Box flexDirection="row" alignItems="center" columnGap={2}>
      <Box flexGrow={1} flexShrink={1} minWidth={0}>
        <Text color="text" size="heading">
          Context window
        </Text>
      </Box>
      <Text color="subtle" tabular>
        {headerFigures(props.snapshot)}
      </Text>
    </Box>
  )
}

/** The window as one rounded bar: each row in it, then the free space as bare track. */
function Bar(props: { ui: Ui; snapshot: ContextSnapshot }) {
  const { Box } = props.ui
  const inWindow = props.snapshot.rows.filter(one => one.kind === 'used' || one.kind === 'buffer')
  const free = props.snapshot.rows.find(one => one.kind === 'free')?.tokens ?? 0
  // Each segment grows by its share of the window, in thousandths: a Box's
  // flexGrow is capped, where a token count is not.
  const grow = (tokens: number) => (tokens / Math.max(1, props.snapshot.window)) * 1000

  return (
    // The rounded border clips the track inside it to a pill; the track sits
    // within it so the border stays clear rather than ringing the bar.
    <Box
      width="100%"
      height={BAR_HEIGHT}
      borderStyle="round"
      borderColor={CLEAR}
      padding={0}
      overflow="hidden"
    >
      <Box
        flexDirection="row"
        flexGrow={1}
        columnGap={BAR_GAP}
        backgroundColor={FREE}
        overflow="hidden"
      >
        {inWindow.map(row => (
          <Box
            flexGrow={grow(row.tokens)}
            flexShrink={0}
            minWidth={BAR_MIN_SEGMENT}
            backgroundColor={row.color}
          />
        ))}
        {free > 0 && <Box flexGrow={grow(free)} flexShrink={1} />}
      </Box>
    </Box>
  )
}

/** Right-aligned figures in a column of fixed width, so the rows line up. */
function Figure(props: {
  ui: Ui
  columns: number
  text: string
  /** Drawn in the text colour, as /context draws a row's share; else muted, as its tokens. */
  isStrong?: boolean
  dim?: boolean
}) {
  const { Box, Text } = props.ui
  const color = props.dim ? 'inactive' : props.isStrong ? 'text' : 'subtle'

  return (
    <Box width={props.columns} justifyContent="flex-end" flexShrink={0}>
      <Text color={color} tabular>
        {props.text}
      </Text>
    </Box>
  )
}

/** One /context row: swatch, label, tokens, share of the window (none for what loads on demand). */
function RowLine(props: {
  ui: Ui
  row: ContextRow
  window: number
  /** The label, a Button when the row opens; else the row's name. */
  label?: JSX.Element
}) {
  const { Box, Text } = props.ui
  const row = props.row

  return (
    <Box flexDirection="row" alignItems="center" columnGap={1}>
      <Box
        flexDirection="row"
        alignItems="center"
        flexGrow={1}
        flexShrink={1}
        minWidth={0}
        columnGap={SWATCH_GAP}
      >
        {Swatch({ ui: props.ui, color: row.color })}
        {props.label ?? (
          // A plain Button pads its label by `xs`; so does this, so the names line up.
          <Box paddingX="xs">
            <Text color="text" wrap="truncate-end">
              {row.name}
            </Text>
          </Box>
        )}
      </Box>
      {Figure({ ui: props.ui, columns: TOKENS_COLUMNS, text: formatTokens(row.tokens) })}
      {Figure({
        ui: props.ui,
        columns: SHARE_COLUMNS,
        text: row.kind === 'deferred' ? '–' : formatShare(row.tokens, props.window),
        isStrong: true,
      })}
    </Box>
  )
}

/** The card the meter reveals on hover: /context's rows, as its card lists them. */
export function HoverCard(props: { ui: Ui; snapshot: ContextSnapshot | null }) {
  const { Box, Text } = props.ui
  const snapshot = props.snapshot
  if (!snapshot) {
    return <Text color="secondaryText">The breakdown appears after Claude's first reply.</Text>
  }

  return (
    <Box flexDirection="column" rowGap={1} width={CARD_COLUMNS}>
      {Header({ ui: props.ui, snapshot })}
      {Bar({ ui: props.ui, snapshot })}
      <Box flexDirection="column">
        {snapshot.rows.map(row => RowLine({ ui: props.ui, row, window: snapshot.window }))}
      </Box>
      <Text color="inactive">Click the percentage to open each row and remove tools.</Text>
    </Box>
  )
}

const STATUS_NOTE: Record<ToolRow['status'], string> = {
  in: '',
  deferred: 'loaded on demand',
  removed: 'removed',
  'back-next-session': 'back in a new session',
}

/** A name with a line under it and its tokens, as the rows' pieces are listed. */
function ItemLine(props: {
  ui: Ui
  item: ContextItem
  /** A line under the name in place of the item's detail, wrapped rather than cut. */
  note?: string
}) {
  const { Box, Text } = props.ui
  const item = props.item
  const detail = props.note ?? item.detail

  return (
    // The figure sits on the name's line; a long line under it never pushes past the figures.
    <Box flexDirection="row" alignItems="flex-start" columnGap={1}>
      <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
        <Text color="text" wrap="truncate-end">
          {item.name}
        </Text>
        {detail !== '' && (
          <Text color="secondaryText" wrap={props.note === undefined ? 'truncate-end' : 'wrap'}>
            {detail}
          </Text>
        )}
      </Box>
      {Figure({ ui: props.ui, columns: TOKENS_COLUMNS, text: `~${formatTokens(item.tokens)}` })}
      <Box width={SHARE_COLUMNS} flexShrink={0} />
    </Box>
  )
}

/** A Button that opens and closes what is under it: its label, then the chevron. */
function Toggle(props: {
  ui: Ui
  id: string
  label: string
  isOpen: boolean
  onPress: () => void
}) {
  const { Button, Text } = props.ui

  return (
    <Button key={props.id} plain onPress={props.onPress}>
      <Text color="text">{props.label}</Text>{' '}
      <Text color="inactive">{props.isOpen ? OPEN : CLOSED}</Text>
    </Button>
  )
}

/** Props the pane is drawn from. */
export type ContextPaneProps = {
  ui: Ui
  snapshot: ContextSnapshot | null
  tools: ToolRow[]
  /** Keys of the rows and sections that are open. */
  expanded: readonly string[]
  /** Why the last Remove or Put back failed, if it did. */
  error: string | null
  onToggle: (name: string, isRemoved: boolean) => void
  onExpand: (key: string) => void
}

function ToolLines(props: ContextPaneProps & { rows: ToolRow[]; isExplained: boolean }) {
  const { Box, Button, Text } = props.ui

  return (
    <Box flexDirection="column" rowGap={1}>
      {props.isExplained && (
        <Text color="secondaryText">
          Remove takes a tool out of this session's context at once (Claude can no longer call it)
          and adds it to permissions.deny in your user settings, so new sessions in every project
          start without it. Put back undoes both.
        </Text>
      )}
      {props.rows.map(tool => {
        const isRemoved = tool.status === 'removed'
        const note = STATUS_NOTE[tool.status]

        return (
          <Box key={`tool-${tool.name}`} flexDirection="row" alignItems="center" columnGap={1}>
            <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
              <Box flexDirection="row" columnGap={1}>
                <Text color={isRemoved ? 'inactive' : 'text'} bold strikethrough={isRemoved}>
                  {tool.name}
                </Text>
                {note !== '' && <Text color="inactive">{note}</Text>}
              </Box>
              <Text color="secondaryText">{tool.summary}</Text>
            </Box>
            {Figure({
              ui: props.ui,
              columns: TOKENS_COLUMNS,
              text: tool.status === 'deferred' ? '0' : `~${formatTokens(tool.tokens)}`,
              dim: isRemoved,
            })}
            <Button
              key={`toggle-${tool.name}`}
              label={isRemoved ? 'Put back' : 'Remove'}
              variant={isRemoved ? 'primary' : 'secondary'}
              onPress={() => props.onToggle(tool.name, !isRemoved)}
            />
          </Box>
        )
      })}
    </Box>
  )
}

function ServerLines(props: ContextPaneProps & { servers: McpServer[]; group: string }) {
  const { Box, Text } = props.ui

  return (
    <Box flexDirection="column" rowGap={1}>
      {props.servers.map(server => {
        const id = `mcp-${props.group}-${slug(server.name)}`
        const isOpen = props.expanded.includes(id)
        const count = `${server.tools.length} ${server.tools.length === 1 ? 'tool' : 'tools'}`

        return (
          <Box key={id} flexDirection="column">
            <Box flexDirection="row" alignItems="center" columnGap={1}>
              <Box flexDirection="row" flexGrow={1} flexShrink={1} minWidth={0} columnGap={1}>
                {Toggle({
                  ui: props.ui,
                  id: `open-${id}`,
                  label: server.name,
                  isOpen,
                  onPress: () => props.onExpand(id),
                })}
                <Text color="inactive">{count}</Text>
              </Box>
              {Figure({
                ui: props.ui,
                columns: TOKENS_COLUMNS,
                text: `~${formatTokens(server.tokens)}`,
              })}
              <Box width={SHARE_COLUMNS} flexShrink={0} />
            </Box>
            {isOpen && (
              <Box flexDirection="column" paddingLeft={2}>
                {server.tools.map(tool => ItemLine({ ui: props.ui, item: tool }))}
              </Box>
            )}
          </Box>
        )
      })}
    </Box>
  )
}

function PromptLines(props: ContextPaneProps & { snapshot: ContextSnapshot }) {
  const { Box, Code, Text } = props.ui

  return (
    <Box flexDirection="column" rowGap={1}>
      <Text color="secondaryText">
        The system prompt as this session composes it, section by section. Sizes are estimated from
        each section's text.
      </Text>
      {props.snapshot.prompt.map(section => {
        const id = `prompt-${slug(section.id)}`
        const isOpen = props.expanded.includes(id)
        const text =
          section.text.length > SECTION_TEXT_MAX
            ? `${section.text.slice(0, SECTION_TEXT_MAX)}\n\n[${section.text.length - SECTION_TEXT_MAX} more characters]`
            : section.text

        return (
          <Box key={id} flexDirection="column" rowGap={1}>
            <Box flexDirection="row" alignItems="center" columnGap={1}>
              <Box flexGrow={1} flexShrink={1} minWidth={0}>
                {Toggle({
                  ui: props.ui,
                  id: `open-${id}`,
                  label: section.title,
                  isOpen,
                  onPress: () => props.onExpand(id),
                })}
              </Box>
              {Figure({
                ui: props.ui,
                columns: TOKENS_COLUMNS,
                text: `~${formatTokens(section.tokens)}`,
              })}
              <Box width={SHARE_COLUMNS} flexShrink={0} />
            </Box>
            {isOpen && <Code source={text} wrap="wrap" />}
          </Box>
        )
      })}
    </Box>
  )
}

function SkillLines(props: ContextPaneProps & { snapshot: ContextSnapshot }) {
  const { Box, Text } = props.ui
  const skills = props.snapshot.skills

  return (
    <Box flexDirection="column" rowGap={1}>
      <Text color="secondaryText">
        Each skill's listing as the model sees it. Removing skills is not supported yet.
      </Text>
      {skills.map(skill => (
        <Box key={`skill-${skill.name}`} flexDirection="column">
          {ItemLine({
            ui: props.ui,
            item: { name: skill.name, tokens: skill.tokens, detail: '' },
            note: skill.description || `From ${skill.source}.`,
          })}
        </Box>
      ))}
    </Box>
  )
}

function ItemLines(props: { ui: Ui; items: ContextItem[]; intro?: string }) {
  const { Box, Text } = props.ui

  return (
    <Box flexDirection="column" rowGap={1}>
      {props.intro && <Text color="secondaryText">{props.intro}</Text>}
      {props.items.map(item => ItemLine({ ui: props.ui, item }))}
    </Box>
  )
}

/** What a row lists when opened, or null for a row with nothing to list. */
function rowDetail(props: ContextPaneProps, row: ContextRow): JSX.Element | null {
  const { Box, Text } = props.ui
  const snapshot = props.snapshot
  const hasDeferredRow = snapshot?.rows.some(one => one.name === SYSTEM_TOOLS_DEFERRED) ?? false
  switch (row.name) {
    case SYSTEM_TOOLS: {
      // Tools removed or put back sit here, with their switch, whatever the engine now counts them as.
      const rows = props.tools.filter(one => one.status !== 'deferred' || !hasDeferredRow)

      return ToolLines({ ...props, rows, isExplained: true })
    }
    case SYSTEM_TOOLS_DEFERRED: {
      const rows = props.tools.filter(one => one.status === 'deferred')
      if (rows.length === 0) return null

      return (
        <Box flexDirection="column" rowGap={1}>
          <Text color="secondaryText">
            Loaded only when Claude searches for them, so their schemas stay out of the window until
            then.
          </Text>
          {ToolLines({ ...props, rows, isExplained: false })}
        </Box>
      )
    }
    case 'MCP tools':
      return snapshot && snapshot.mcpLoaded.length > 0
        ? ServerLines({ ...props, servers: snapshot.mcpLoaded, group: 'loaded' })
        : null
    case 'MCP tools (deferred)':
      return snapshot && snapshot.mcpDeferred.length > 0
        ? ServerLines({ ...props, servers: snapshot.mcpDeferred, group: 'deferred' })
        : null
    case 'System prompt':
      return snapshot && snapshot.prompt.length > 0 ? PromptLines({ ...props, snapshot }) : null
    case 'Skills':
      return snapshot && snapshot.skills.length > 0 ? SkillLines({ ...props, snapshot }) : null
    case 'Memory files':
      return snapshot && snapshot.memoryFiles.length > 0
        ? ItemLines({ ui: props.ui, items: snapshot.memoryFiles })
        : null
    case 'Custom agents':
      return snapshot && snapshot.agents.length > 0
        ? ItemLines({ ui: props.ui, items: snapshot.agents })
        : null
    case 'Messages':
      return snapshot && snapshot.results.length > 0
        ? ItemLines({
            ui: props.ui,
            items: snapshot.results,
            intro: 'The largest tool results in the conversation, sized from their text.',
          })
        : null
    default:
      return null
  }
}

/** The pane: /context's rows, each opening onto what fills it; tools can be removed there. */
export function ContextPane(props: ContextPaneProps) {
  const { Box, Text } = props.ui
  const snapshot = props.snapshot
  // Before the first reading, the tools are still listed so they can be removed.
  const rows: ContextRow[] = snapshot?.rows ?? [
    { name: SYSTEM_TOOLS, tokens: 0, kind: 'used', color: 'inactive' },
  ]

  return (
    <Box flexDirection="column" rowGap={1} paddingX={1}>
      {snapshot ? (
        <Box flexDirection="column" rowGap={1}>
          {Header({ ui: props.ui, snapshot })}
          {Bar({ ui: props.ui, snapshot })}
        </Box>
      ) : (
        <Text color="secondaryText">The breakdown appears after Claude's first reply.</Text>
      )}
      {props.error && <Text color="error">{props.error}</Text>}
      <Box flexDirection="column">
        {rows.map(row => {
          const id = `row-${slug(row.name)}`
          const detail = rowDetail(props, row)
          const isOpen = detail !== null && props.expanded.includes(id)
          const label =
            detail === null
              ? undefined
              : Toggle({
                  ui: props.ui,
                  id: `open-${id}`,
                  label: row.name,
                  isOpen,
                  onPress: () => props.onExpand(id),
                })
          const line = snapshot ? (
            RowLine({ ui: props.ui, row, window: snapshot.window, label })
          ) : (
            <Box flexDirection="row" alignItems="center" columnGap={SWATCH_GAP}>
              {Swatch({ ui: props.ui, color: row.color })}
              {label}
            </Box>
          )

          return (
            <Box key={id} flexDirection="column">
              {line}
              {isOpen && (
                <Box flexDirection="column" paddingLeft={DETAIL_INDENT} paddingY={1}>
                  {detail}
                </Box>
              )}
            </Box>
          )
        })}
      </Box>
    </Box>
  )
}

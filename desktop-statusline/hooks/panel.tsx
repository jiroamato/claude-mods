import type { ElementTable } from 'claude-code'

import type { ContextItem, ContextSnapshot, PaneTab } from '../types'
import { FREE, barSegments, formatShare, formatTokens } from './context'
import type { ToolRow } from './tools'

/** The pane the percentage opens. */
export const PANE_ID = 'context-map'
export const PANE_TITLE = 'Context details'

type Ui = ElementTable<'desktop'>

// Sizes in cells: across in character widths, down in rows.
// The desktop Context card's bar: 4px tall, its pills a pixel apart, the
// smallest about 2px wide.
const BAR_HEIGHT = 0.215
const BAR_GAP = 0.08
const BAR_MIN_SEGMENT = 0.25
const TOKENS_COLUMNS = 7
// A border no one sees: only a Box with a border has rounded corners.
const CLEAR = '#00000000'
// The tab strip: a recessed track, the open tab raised on it.
const TAB_TRACK = '#0000004d'
const TAB_OPEN = '#ffffff14'
// A one-pixel rule between the pieces a tab lists, in the border's own faint colour.
const HAIRLINE = 0.05
const RULE = 'promptBorderShimmer'
// One drawing holds at most 100000 characters of code; a section is cut well short of that.
const SECTION_TEXT_MAX = 40_000

const CLOSED = '▸'
const OPEN = '▾'

/** The tabs in their order, each with its label and the /context row it details. */
const TABS: readonly { id: PaneTab; label: string; row?: string }[] = [
  { id: 'tools', label: 'Tools', row: 'System tools' },
  { id: 'prompt', label: 'Prompt', row: 'System prompt' },
  { id: 'skills', label: 'Skills', row: 'Skills' },
  { id: 'results', label: 'Results', row: 'Messages' },
]

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

function rowTokens(snapshot: ContextSnapshot | null, name: string | undefined): number | null {
  const row = snapshot?.rows.find(one => one.name === name)

  return row ? row.tokens : null
}

/** `Context window   72.6k / 1M (7%)`. */
function Header(props: { ui: Ui; snapshot: ContextSnapshot }) {
  const { Box, Text } = props.ui
  const snapshot = props.snapshot

  return (
    <Box flexDirection="row" alignItems="center" columnGap={2}>
      <Box flexGrow={1} flexShrink={1} minWidth={0}>
        <Text color="text" size="heading">
          Context window
        </Text>
      </Box>
      <Text color="subtle" tabular>
        {`${formatTokens(snapshot.used)} / ${formatTokens(snapshot.window)} (${snapshot.percent}%)`}
      </Text>
    </Box>
  )
}

/**
 * The window as one bar, drawn as the desktop's own Context card draws it: a
 * rounded pill per segment, a hair from the next, then the free space as a
 * pill of bare track. Nothing in it is positioned: the desktop draws a
 * positioned Box on a layer of its own, which shifts its colours.
 */
function Bar(props: { ui: Ui; snapshot: ContextSnapshot }) {
  const { Box } = props.ui
  const inWindow = barSegments(props.snapshot.rows)
  const free = props.snapshot.rows.find(one => one.kind === 'free')?.tokens ?? 0
  // Each segment grows by its share of the window, in thousandths: a Box's
  // flexGrow is capped, where a token count is not.
  const grow = (tokens: number) => (tokens / Math.max(1, props.snapshot.window)) * 1000
  // Only a Box with a border has rounded corners; a clear one lets the colour
  // fill the whole Box, so each pill keeps the bar's full height.
  const pill = { borderStyle: 'round', borderColor: CLEAR, padding: 0 } as const

  return (
    <Box flexDirection="row" width="100%" height={BAR_HEIGHT} columnGap={BAR_GAP}>
      {inWindow.map(row => (
        <Box
          flexGrow={grow(row.tokens)}
          flexShrink={0}
          minWidth={BAR_MIN_SEGMENT}
          {...pill}
          backgroundColor={row.color}
        />
      ))}
      {free > 0 && <Box flexGrow={grow(free)} flexShrink={1} {...pill} backgroundColor={FREE} />}
    </Box>
  )
}

/** The tab strip: each tab's label and, where /context counts it, its tokens. */
function Tabs(props: ContextPaneProps) {
  const { Box, Button, Text } = props.ui
  const rounded = { borderStyle: 'round', borderColor: CLEAR } as const

  return (
    <Box flexDirection="row" columnGap="xs" padding="xs" {...rounded} backgroundColor={TAB_TRACK}>
      {TABS.map(tab => {
        const isOpen = props.tab === tab.id
        const tokens = tab.id === 'results' ? null : rowTokens(props.snapshot, tab.row)

        return (
          <Box
            key={`tab-${tab.id}`}
            // Each tab an equal share of the strip, whatever its label.
            flexGrow={1}
            width={0}
            justifyContent="center"
            {...rounded}
            padding={0}
            backgroundColor={isOpen ? TAB_OPEN : CLEAR}
          >
            <Button key={`open-tab-${tab.id}`} plain onPress={() => props.onTab(tab.id)}>
              <Text color={isOpen ? 'text' : 'secondaryText'}>{tab.label}</Text>
              {tokens !== null && (
                <Text color="subtle" size="footnote">
                  {` ${formatTokens(tokens)}`}
                </Text>
              )}
            </Button>
          </Box>
        )
      })}
    </Box>
  )
}

/** A tab's heading: what it lists, and its tokens and share as /context counts them. */
function Heading(props: { ui: Ui; title: string; snapshot: ContextSnapshot | null; row: string }) {
  const { Box, Text } = props.ui
  const tokens = rowTokens(props.snapshot, props.row)

  return (
    <Box flexDirection="row" alignItems="center" columnGap={2}>
      <Box flexGrow={1} flexShrink={1} minWidth={0}>
        <Text color="text" size="heading">
          {props.title}
        </Text>
      </Box>
      {tokens !== null && props.snapshot && (
        <Text color="subtle" tabular>
          {`${formatTokens(tokens)} · ${formatShare(tokens, props.snapshot.window)}`}
        </Text>
      )}
    </Box>
  )
}

/** Right-aligned figures in a column of fixed width, so the rows line up. */
function Figure(props: { ui: Ui; text: string; dim?: boolean }) {
  const { Box, Text } = props.ui

  return (
    <Box width={TOKENS_COLUMNS} justifyContent="flex-end" flexShrink={0}>
      <Text color={props.dim ? 'inactive' : 'subtle'} tabular>
        {props.text}
      </Text>
    </Box>
  )
}

/** What a tab says before it lists its pieces: small and muted, so the list leads. */
function Intro(props: { ui: Ui; text: string }) {
  const { Text } = props.ui

  return (
    <Text color="subtle" size="footnote">
      {props.text}
    </Text>
  )
}

/** A group's label and how many it holds, small and muted above its list. */
function GroupLabel(props: { ui: Ui; label: string; count: number }) {
  const { Box, Text } = props.ui

  return (
    <Box flexDirection="row" columnGap={1}>
      <Box flexGrow={1}>
        <Text color="secondaryText" size="footnote" weight="medium">
          {props.label.toUpperCase()}
        </Text>
      </Box>
      <Text color="subtle" size="footnote" tabular>
        {String(props.count)}
      </Text>
    </Box>
  )
}

/** The pieces a tab lists, a faint rule between each so one reads apart from the next. */
function Ruled(props: { ui: Ui; children: JSX.Element[] }) {
  const { Box } = props.ui

  return (
    <Box flexDirection="column" rowGap={1}>
      {props.children.flatMap((child, index) =>
        index === 0
          ? [child]
          : [<Box height={HAIRLINE} flexShrink={0} backgroundColor={RULE} />, child],
      )}
    </Box>
  )
}

/** A name with a line under it and its tokens, as a tab lists its pieces. */
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
          <Text color="subtle" wrap={props.note === undefined ? 'truncate-end' : 'wrap'}>
            {detail}
          </Text>
        )}
      </Box>
      {Figure({ ui: props.ui, text: `~${formatTokens(item.tokens)}` })}
    </Box>
  )
}

/** Props the pane is drawn from. */
export type ContextPaneProps = {
  ui: Ui
  snapshot: ContextSnapshot | null
  tools: ToolRow[]
  /** The tab that is open. */
  tab: PaneTab
  /** Keys of the sections that are open. */
  expanded: readonly string[]
  /** Why the last Remove or Put back failed, if it did. */
  error: string | null
  onToggle: (name: string, isRemoved: boolean) => void
  onExpand: (key: string) => void
  onTab: (tab: PaneTab) => void
}

const STATUS_NOTE: Record<ToolRow['status'], string> = {
  in: '',
  deferred: '',
  removed: 'removed',
  'back-next-session': 'back in a new session',
}

function ToolLines(props: ContextPaneProps & { rows: ToolRow[] }) {
  const { Box, Button, Text } = props.ui

  return Ruled({
    ui: props.ui,
    children: props.rows.map(tool => {
      const isRemoved = tool.status === 'removed'
      const note = STATUS_NOTE[tool.status]

      return (
        <Box key={`tool-${tool.name}`} flexDirection="row" alignItems="center" columnGap={1}>
          <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
            {/* In a narrow pane the note drops under the name whole, rather than a word a line. */}
            <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
              <Text color={isRemoved ? 'inactive' : 'text'} bold strikethrough={isRemoved}>
                {tool.name}
              </Text>
              {note !== '' && <Text color="inactive">{note}</Text>}
            </Box>
            <Text color="subtle">{tool.summary}</Text>
          </Box>
          {Figure({
            ui: props.ui,
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
    }),
  })
}

/** The Tools tab: the built-in tools in the window, loaded on demand, and removed. */
function ToolsTab(props: ContextPaneProps) {
  const { Box } = props.ui
  const groups = [
    {
      label: 'In context',
      rows: props.tools.filter(one => one.status === 'in' || one.status === 'back-next-session'),
    },
    { label: 'Loaded on demand', rows: props.tools.filter(one => one.status === 'deferred') },
    { label: 'Removed', rows: props.tools.filter(one => one.status === 'removed') },
  ].filter(group => group.rows.length > 0)

  return (
    <Box flexDirection="column" rowGap={1}>
      {Heading({
        ui: props.ui,
        title: 'Built-in tools',
        snapshot: props.snapshot,
        row: 'System tools',
      })}
      {Intro({
        ui: props.ui,
        text:
          "Remove takes a tool out of this session's context at once (Claude can no longer call " +
          'it) and adds it to permissions.deny in your user settings, so new sessions in every ' +
          'project start without it. Put back undoes both.',
      })}
      {groups.map(group => (
        <Box key={`group-${slug(group.label)}`} flexDirection="column" rowGap={1} paddingTop={1}>
          {GroupLabel({ ui: props.ui, label: group.label, count: group.rows.length })}
          {ToolLines({ ...props, rows: group.rows })}
        </Box>
      ))}
    </Box>
  )
}

/** The Prompt tab: the system prompt section by section, each opening to its text. */
function PromptTab(props: ContextPaneProps) {
  const { Box, Code, Button, Text } = props.ui
  const sections = props.snapshot?.prompt ?? []

  return (
    <Box flexDirection="column" rowGap={1}>
      {Heading({
        ui: props.ui,
        title: 'System prompt',
        snapshot: props.snapshot,
        row: 'System prompt',
      })}
      {Intro({
        ui: props.ui,
        text:
          sections.length === 0
            ? "The system prompt appears after Claude's first reply."
            : 'The system prompt as this session composes it, section by section. Sizes are ' +
              "estimated from each section's text.",
      })}
      {sections.length > 0 &&
        Ruled({
          ui: props.ui,
          children: sections.map(section => {
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
                    <Button key={`open-${id}`} plain onPress={() => props.onExpand(id)}>
                      <Text color="text">{section.title}</Text>{' '}
                      <Text color="inactive">{isOpen ? OPEN : CLOSED}</Text>
                    </Button>
                  </Box>
                  {Figure({ ui: props.ui, text: `~${formatTokens(section.tokens)}` })}
                </Box>
                {isOpen && <Code source={text} wrap="wrap" />}
              </Box>
            )
          }),
        })}
    </Box>
  )
}

/** The Skills tab: each skill's listing as the model sees it. */
function SkillsTab(props: ContextPaneProps) {
  const { Box } = props.ui
  const skills = props.snapshot?.skills ?? []

  return (
    <Box flexDirection="column" rowGap={1}>
      {Heading({ ui: props.ui, title: 'Skills', snapshot: props.snapshot, row: 'Skills' })}
      {Intro({
        ui: props.ui,
        text:
          skills.length === 0
            ? 'No skills are listed in this session.'
            : "Each skill's listing as the model sees it. Removing skills is not supported yet.",
      })}
      {skills.length > 0 &&
        Ruled({
          ui: props.ui,
          children: skills.map(skill => (
            <Box key={`skill-${skill.name}`} flexDirection="column">
              {ItemLine({
                ui: props.ui,
                item: { name: skill.name, tokens: skill.tokens, detail: '' },
                note: skill.description || `From ${skill.source}.`,
              })}
            </Box>
          )),
        })}
    </Box>
  )
}

/** The Results tab: the largest tool results in the conversation. */
function ResultsTab(props: ContextPaneProps) {
  const { Box } = props.ui
  const results = props.snapshot?.results ?? []

  return (
    <Box flexDirection="column" rowGap={1}>
      {Heading({
        ui: props.ui,
        title: 'Largest tool results',
        snapshot: props.snapshot,
        row: 'Messages',
      })}
      {Intro({
        ui: props.ui,
        text:
          results.length === 0
            ? 'No tool result in this conversation is large enough to list yet.'
            : 'The tool results that fill the most of the conversation, sized from their text.',
      })}
      {results.length > 0 &&
        Ruled({ ui: props.ui, children: results.map(item => ItemLine({ ui: props.ui, item })) })}
    </Box>
  )
}

/**
 * The pane: the window as a bar, then a tab for each thing the desktop's own
 * Context card cannot show: the built-in tools (which can be removed), the
 * system prompt's text, the skills' listings and the largest tool results.
 */
export function ContextPane(props: ContextPaneProps) {
  const { Box, Text } = props.ui
  const snapshot = props.snapshot
  const content = {
    tools: ToolsTab,
    prompt: PromptTab,
    skills: SkillsTab,
    results: ResultsTab,
  }[props.tab]

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
      {Tabs(props)}
      {props.error && <Text color="error">{props.error}</Text>}
      <Box flexDirection="column" paddingTop={1}>
        {content(props)}
      </Box>
    </Box>
  )
}

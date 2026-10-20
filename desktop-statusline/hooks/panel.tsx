import type { ElementTable } from 'claude-code'

import type {
  ContextItem,
  ContextSnapshot,
  PaneTab,
  PromptSection,
  SkillOrigin,
  TraceItem,
  TraceState,
} from '../types'
import { FREE, barSegments, formatShare, formatTokens } from './context'
import type { DisclosureProps } from './disclosure'
import type { ReaderBarProps } from './reader'
import { TAB_PREFIX } from './tabs'
import type { TabProps } from './tabs'
import type { ToolRow } from './tools'
import { MAX_MATCHES, isMainSource, sourceLabel, viewLink } from './trace'

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
// A pill's card: as wide as its text, in footnote type a little narrower than
// a column a character, and no wider than the pane.
const CARD_CHARS_PER_COLUMN = 0.75
// The pane's padding and the card's own border, which the card leaves inside the pane.
const CARD_EDGE_COLUMNS = 4
// A border no one sees: only a Box with a border has rounded corners.
const CLEAR = '#00000000'
// A one-pixel rule between the pieces a tab lists, in the border's own faint colour.
const HAIRLINE = 0.05
const RULE = 'promptBorderShimmer'
// The system prompt /context counts beyond the sections, below which the
// difference is the sections' estimate erring rather than text left unread.
const UNREAD_MIN_TOKENS = 100
// One drawing holds at most 100000 characters of code, so long text is read a
// page at a time, each well short of that.
const PAGE_CHARS = 40_000
// A page ends at the last line break this close to its end, so it never cuts a line.
const PAGE_SLACK = 4_000

/** The tabs in their order, each with its label and the /context row it details. */
const TABS: readonly { id: PaneTab; label: string; row?: string }[] = [
  { id: 'tools', label: 'Tools', row: 'System tools' },
  { id: 'prompt', label: 'Prompt', row: 'System prompt' },
  { id: 'skills', label: 'Skills', row: 'Skills' },
  { id: 'trace', label: 'Trace' },
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
function Bar(props: { ui: Ui; snapshot: ContextSnapshot; columns: number }) {
  const { Box, Text } = props.ui
  const window = props.snapshot.window
  const free = props.snapshot.rows.find(one => one.kind === 'free')
  const segments = [
    ...barSegments(props.snapshot.rows),
    ...(free && free.tokens > 0 ? [{ color: FREE, tokens: free.tokens, rows: [free] }] : []),
  ]
  // Each segment grows by its share of the window, in thousandths: a Box's
  // flexGrow is capped, where a token count is not.
  const grow = (tokens: number) => (tokens / Math.max(1, window)) * 1000
  // Only a Box with a border has rounded corners; a clear one lets the colour
  // fill the whole Box, so each pill keeps the bar's full height.
  const pill = { borderStyle: 'round', borderColor: CLEAR, padding: 0 } as const

  return (
    <Box flexDirection="row" width="100%" height={BAR_HEIGHT} columnGap={BAR_GAP}>
      {segments.map(segment => {
        // One line, the rows a grey pill draws side by side: the card sits
        // between the bar and the pane's top, where a second line is cut off.
        const text = segment.rows
          .map(
            row => `${row.name}: ${formatTokens(row.tokens)}, ${formatShare(row.tokens, window)}`,
          )
          .join('  ·  ')

        return (
          // Keyed, so the pointer over a pill shows its card, as the desktop's
          // own Context card names the segment under the pointer.
          <Box
            key={`bar-${slug(segment.rows[0]!.name)}`}
            flexGrow={grow(segment.tokens)}
            flexShrink={segment.color === FREE ? 1 : 0}
            minWidth={BAR_MIN_SEGMENT}
            {...pill}
            backgroundColor={segment.color}
          >
            <Box
              // The desktop places the card itself, above the pill. Its width
              // is the text's own: a card takes no width from a pill this thin.
              position="absolute"
              bottom={1}
              left={0}
              width={Math.min(
                props.columns - CARD_EDGE_COLUMNS,
                Math.ceil(text.length * CARD_CHARS_PER_COLUMN) + 2,
              )}
              display="none"
              hover={{ display: 'flex' }}
              borderStyle="round"
              backgroundColor="userMessageBackground"
              paddingX={1}
              paddingY={0}
            >
              <Text color="text" size="footnote" wrap="truncate-end">
                {text}
              </Text>
            </Box>
          </Box>
        )
      })}
    </Box>
  )
}

/**
 * The tab strip: each tab's label and, where /context counts it, its tokens.
 * A region of its own (./tabs.tsx), so the whole pill of a tab takes the press.
 */
function Tabs(props: ContextPaneProps) {
  const { Box, Client } = props.ui

  return (
    // A recessed track, each tab a region of its own on it (./tabs.tsx).
    <Box
      flexDirection="row"
      columnGap="xs"
      padding="xs"
      borderStyle="round"
      borderColor={CLEAR}
      backgroundColor={TAB_TRACK}
    >
      {TABS.map((tab, index) => {
        const tokens = rowTokens(props.snapshot, tab.row)
        const count = props.trace.items.length
        const figure =
          tab.id === 'trace'
            ? count > 0
              ? String(count)
              : null
            : tokens === null
              ? null
              : formatTokens(tokens)
        const one: TabProps = {
          id: tab.id,
          label: tab.label,
          figure,
          isOpen: props.tab === tab.id,
          previous: TABS[index - 1]?.id ?? null,
          next: TABS[index + 1]?.id ?? null,
        }

        // Each tab an equal share of the strip, whatever its label.
        return (
          <Client
            key={`${TAB_PREFIX}${tab.id}`}
            module="./tabs.tsx"
            props={one}
            width={0}
            flexGrow={1}
          />
        )
      })}
    </Box>
  )
}

// The strip's track, recessed under its tabs.
const TAB_TRACK = '#0000004d'

/** Where each page of `text` starts: about PAGE_CHARS apart, each at a line's start. */
export function pageStarts(text: string): number[] {
  const starts = [0]
  while (text.length - starts.at(-1)! > PAGE_CHARS) {
    const from = starts.at(-1)!
    const end = from + PAGE_CHARS
    const lineBreak = text.lastIndexOf('\n', end)
    starts.push(lineBreak > end - PAGE_SLACK ? lineBreak + 1 : end)
  }

  return starts
}

/** Long text, a page at a time, with the way to the pages before and after. */
function Paged(props: { ui: Ui; text: string; page: number; onPage: (page: number) => void }) {
  const { Box, Button, Code, Text } = props.ui
  const starts = pageStarts(props.text)
  const page = Math.min(Math.max(0, props.page), starts.length - 1)
  const from = starts[page]!
  const to = starts[page + 1] ?? props.text.length
  const code = <Code source={props.text.slice(from, to)} wrap="wrap" />
  if (starts.length === 1) return code
  // Above the page and again under it; each Button keyed by where it sits.
  const pager = (at: 'top' | 'bottom') => (
    <Box flexDirection="row" alignItems="center" columnGap={1}>
      <Box flexGrow={1} flexShrink={1} minWidth={0}>
        <Text color="subtle" size="footnote" tabular>
          {`Page ${page + 1} of ${starts.length} · characters ${(from + 1).toLocaleString('en-US')}–${to.toLocaleString('en-US')} of ${props.text.length.toLocaleString('en-US')}`}
        </Text>
      </Box>
      {page > 0 && (
        <Button
          key={at === 'top' ? 'page-previous' : 'page-previous-bottom'}
          label="Previous"
          onPress={() => props.onPage(page - 1)}
        />
      )}
      {page < starts.length - 1 && (
        <Button
          key={at === 'top' ? 'page-next' : 'page-next-bottom'}
          label="Next"
          onPress={() => props.onPage(page + 1)}
        />
      )}
    </Box>
  )

  return (
    <Box flexDirection="column" rowGap={1}>
      {pager('top')}
      {code}
      {pager('bottom')}
    </Box>
  )
}

/** How much of a request its open row shows: the reader shows the rest. */
const PREVIEW_ROWS = 12
const PREVIEW_CHARS = 1_500

/**
 * An open request's opening: a few lines of what it added and what came
 * back, enough to tell it apart. "Read it whole here" shows all of it.
 */
function RequestText(props: { ui: Ui; text: string | null }) {
  const { Box, Code, Text } = props.ui
  if (props.text === null) return <Text color="subtle">This request could not be read.</Text>
  const lines = props.text.split('\n')
  let preview = lines.slice(0, PREVIEW_ROWS).join('\n')
  if (preview.length > PREVIEW_CHARS) preview = `${preview.slice(0, PREVIEW_CHARS)}…`
  const rest = props.text.length - preview.length
  const more = lines.length - PREVIEW_ROWS

  return (
    <Box flexDirection="column" rowGap={1}>
      <Code source={preview} wrap="wrap" />
      {rest > 0 && (
        <Text color="subtle" size="footnote">
          {more > 0
            ? `${more.toLocaleString('en-US')} more ${more === 1 ? 'line' : 'lines'}`
            : `${rest.toLocaleString('en-US')} more characters`}
        </Text>
      )}
    </Box>
  )
}

/** The key prefix of a row that opens, which the hooks module hears it post under. */
export const DISCLOSURE_PREFIX = 'disclose-'
// The chevron's column and the gap after it, so what sits under the label lines up with it.
const DISCLOSURE_INDENT = 2.6

/**
 * A row that opens what is under it: the chevron, the label, the figure at the
 * far end, the whole row lit and pressed (./disclosure.tsx).
 */
function DisclosureRow(props: { ui: Ui; row: DisclosureProps }) {
  const { Box, Client, Svg } = props.ui

  return (
    // The desktop's own chevron, the icon its rows draw, under the row's
    // region: a region draws no icon, and an icon over it would take the press.
    // The region, laid over the icon with no background of its own, lets it
    // show and takes the press on the whole row.
    // Set out into its card's padding by the row's own, so the chevron lines up
    // with the card's heading and the figure with its figures, as the lit row
    // runs past them both.
    <Box
      flexDirection="row"
      alignItems="center"
      height={1}
      paddingLeft={CARET_INSET}
      marginX={-CARET_INSET}
    >
      <Svg
        source={props.row.isOpen ? CARET_DOWN : CARET_RIGHT}
        alt={props.row.isOpen ? 'open' : 'closed'}
        width={CARET_SIZE}
        height={CARET_SIZE}
      />
      <Box position="absolute" top={0} left={0} right={0} bottom={0}>
        <Client
          key={`${DISCLOSURE_PREFIX}${props.row.id}`}
          module="./disclosure.tsx"
          props={props.row}
          width="100%"
          height={1}
        />
      </Box>
    </Box>
  )
}

// The desktop's chevrons: Phosphor's CaretRight and CaretDown (regular), as
// its rows that open draw them, at its `xs` icon size in its muted text colour.
const CARET_SIZE = 12
const CARET_COLOR = '#898781'
const caret = (path: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${CARET_SIZE}" height="${CARET_SIZE}" viewBox="0 0 256 256">` +
  `<path fill="${CARET_COLOR}" d="${path}"/></svg>`
const CARET_RIGHT = caret(
  'M181.66,133.66l-80,80a8,8,0,0,1-11.32-11.32L164.69,128,90.34,53.66a8,8,0,0,1,11.32-11.32l80,80A8,8,0,0,1,181.66,133.66Z',
)
const CARET_DOWN = caret(
  'M213.66,101.66l-80,80a8,8,0,0,1-11.32,0l-80-80A8,8,0,0,1,53.66,90.34L128,164.69l74.34-74.35a8,8,0,0,1,11.32,11.32Z',
)
// The row region's own padding, so the icon sits where its room is kept.
const CARET_INSET = 1

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

function sumTokens(items: readonly { tokens: number }[]): number {
  return items.reduce((sum, one) => sum + one.tokens, 0)
}

/** What a tab says before it lists its pieces: small and muted, so the list leads. */
function Intro(props: { ui: Ui; text: string }) {
  const { Text } = props.ui
  // A word in backticks reads as inline code, as Markdown draws it.
  const parts = props.text.split(/(`[^`]+`)/).filter(part => part !== '')

  return (
    <Text color="subtle" size="footnote">
      {parts.map(part =>
        /^`[^`]+`$/.test(part) ? (
          <Text mono color="text" backgroundColor={INLINE_CODE}>
            {` ${part.slice(1, -1)} `}
          </Text>
        ) : (
          part
        ),
      )}
    </Text>
  )
}

// Inline code's ground: the raised surface the desktop sets code on.
const INLINE_CODE = 'bashMessageBackgroundColor'

/**
 * A group of what a tab lists, set apart as a card: its name, then how many
 * it holds and their size, then the list.
 */
function Group(props: {
  ui: Ui
  id: string
  label: string
  count: number
  noun: string
  tokens?: number
  /** Said after the size, as `when loaded`. */
  tokensNote?: string
  /** A last figure, as a cost. */
  extra?: string
  children: JSX.Element
}) {
  const { Box, Text } = props.ui
  const figures = [
    `${props.count} ${props.count === 1 ? props.noun : `${props.noun}s`}`,
    ...(props.tokens === undefined
      ? []
      : [`~${formatTokens(props.tokens)}${props.tokensNote ? ` ${props.tokensNote}` : ''}`]),
    ...(props.extra === undefined ? [] : [props.extra]),
  ].join(' · ')

  return (
    <Box key={props.id} flexDirection="column" rowGap={1} borderStyle="round">
      <Box flexDirection="row" alignItems="center" columnGap={2}>
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          <Text color="text" weight="semibold">
            {props.label}
          </Text>
        </Box>
        <Text color="subtle" size="footnote" tabular>
          {figures}
        </Text>
      </Box>
      <Box height={HAIRLINE} flexShrink={0} backgroundColor={RULE} />
      {props.children}
    </Box>
  )
}

/** A tab's groups, stacked under its intro with room between each. */
function Groups(props: { ui: Ui; children: JSX.Element[] }) {
  const { Box } = props.ui

  return (
    <Box flexDirection="column" rowGap={2} paddingTop={1}>
      {props.children}
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
  /** The conversation's trace, from the trace receiver. */
  trace: TraceState
  /** Why the last tracing switch failed, if it did. */
  traceError: string | null
  /** The open request of the Trace tab, as text; null when none is open. */
  traceText: string | null
  onToggle: (name: string, isRemoved: boolean) => void
  onExpand: (key: string) => void
  onTracing: (isOn: boolean) => void
  /** The page of the open request or section's text. */
  page: number
  onPage: (page: number) => void
  /** The pane's width in columns. */
  columns: number
  /** The request read whole, as the rows on screen and around them; null while the tabs show. */
  reader: ReaderView | null
  onRead: (seq: number) => void
  onSearch: (query: string) => void
  onStep: (by: number) => void
}

/** What the reader draws: the rows near the window, and how many rows come before and after. */
export type ReaderView = {
  title: string
  detail: string
  /** The stretches of rows drawn, each from its row `first` of the text. */
  stretches: { first: number; rows: ReaderRow[] }[]
  total: number
  /** The search: what is looked for, how many matches, and the current one. */
  search: { query: string; index: number; count: number }
}

/** One drawn row: its text, the matches in it, and whether it holds the current one. */
export type ReaderRow = {
  text: string
  hits: { start: number; end: number; isCurrent: boolean }[]
}

/** The reader's top, in rows: its line back, its search, and a row of space under them. */
export const READER_TOP_ROWS = 4

/** The key of the row the reader scrolls to: the one holding the current match. */
export const READER_HIT_KEY = 'reader-hit'

// A match, and the current one, as the desktop marks found text.
const HIT = '#c9850059'
const HIT_CURRENT = '#c98500'

/** A row, its matches marked. */
function RowText(props: { ui: Ui; row: ReaderRow }) {
  const { Text } = props.ui
  const row = props.row
  if (row.hits.length === 0) {
    return (
      <Text color="text" mono wrap="truncate-end">
        {row.text === '' ? ' ' : row.text}
      </Text>
    )
  }
  const parts: JSX.Element[] = []
  let at = 0
  for (const hit of row.hits) {
    if (hit.start > at) parts.push(<Text>{row.text.slice(at, hit.start)}</Text>)
    parts.push(
      <Text
        backgroundColor={hit.isCurrent ? HIT_CURRENT : HIT}
        color={hit.isCurrent ? 'inverseText' : 'text'}
      >
        {row.text.slice(hit.start, hit.end)}
      </Text>,
    )
    at = hit.end
  }
  if (at < row.text.length) parts.push(<Text>{row.text.slice(at)}</Text>)

  return (
    <Text color="text" mono wrap="truncate-end">
      {parts}
    </Text>
  )
}

/**
 * A request whole, read in the pane: its rows drawn only near the window and
 * around the current match, the rest stood in for by empty space of the same
 * height, so the pane scrolls through all of it and draws no more than a
 * drawing holds. Its top is a fixed height, so the rows below are counted true.
 */
function Reader(props: {
  ui: Ui
  view: ReaderView
  onSearch: (query: string) => void
  onStep: (by: number) => void
}) {
  const { Box, Button, Client, Input, Text } = props.ui
  const view = props.view
  const bar: ReaderBarProps = { title: view.title, detail: view.detail }
  const search = view.search
  const status =
    search.query.trim() === ''
      ? ''
      : search.count === 0
        ? 'No match'
        : `${search.index + 1} of ${search.count.toLocaleString('en-US')}${search.count >= MAX_MATCHES ? '+' : ''}`
  const drawn: JSX.Element[] = []
  let row = 0
  for (const stretch of view.stretches) {
    drawn.push(...Space({ ui: props.ui, rows: stretch.first - row }))
    stretch.rows.forEach(one => {
      const line = RowText({ ui: props.ui, row: one })
      drawn.push(
        one.hits.some(hit => hit.isCurrent) ? (
          <Box key={READER_HIT_KEY} flexDirection="column">
            {line}
          </Box>
        ) : (
          line
        ),
      )
    })
    row = stretch.first + stretch.rows.length
  }
  drawn.push(...Space({ ui: props.ui, rows: view.total - row }))

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box height={READER_TOP_ROWS - 1} flexShrink={0} flexDirection="column" overflow="hidden">
        <Client key={READER_KEY} module="./reader.tsx" props={bar} width="100%" height={1} />
        <Box height={2} flexShrink={0} flexDirection="row" alignItems="center" columnGap={1}>
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            <Input
              key="reader-search"
              placeholder="Search this request"
              value={search.query}
              submitLabel="next"
              onInput={value => props.onSearch(value)}
              onSubmit={() => props.onStep(1)}
            />
          </Box>
          <Box flexShrink={0}>
            <Text color={search.count === 0 && status !== '' ? 'error' : 'subtle'} tabular>
              {status}
            </Text>
          </Box>
          {search.count > 0 && (
            <Button key="reader-previous" label="↑" onPress={() => props.onStep(-1)} />
          )}
          {search.count > 0 && (
            <Button key="reader-next" label="↓" onPress={() => props.onStep(1)} />
          )}
        </Box>
      </Box>
      <Box height={1} flexShrink={0} />
      {drawn}
    </Box>
  )
}

/** The tallest Box the engine draws, in rows. */
const MAX_BOX_ROWS = 10_000

/** Empty space `rows` high: as many Boxes as it takes, each no taller than the engine draws. */
function Space(props: { ui: Ui; rows: number }) {
  const { Box } = props.ui
  const heights: number[] = []
  for (let left = props.rows; left > 0; left -= MAX_BOX_ROWS)
    heights.push(Math.min(left, MAX_BOX_ROWS))

  return heights.map(height => <Box height={height} flexShrink={0} />)
}

/** The key of the reader's top line, which the hooks module hears it post under. */
export const READER_KEY = 'reader'

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
            text: `~${formatTokens(tool.tokens)}`,
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
    {
      label: 'Deferred (loaded on demand)',
      isDeferred: true,
      rows: props.tools.filter(one => one.status === 'deferred'),
    },
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
          'it) and adds it to `permissions.deny` in your user settings, so new sessions in every ' +
          'project start without it. Put back undoes both.',
      })}
      {Groups({
        ui: props.ui,
        children: groups.map(group =>
          Group({
            ui: props.ui,
            id: `group-${slug(group.label)}`,
            label: group.label,
            count: group.rows.length,
            noun: 'tool',
            // What loads on demand is out of the window: its size is what it
            // would take, as /context counts the row where it can.
            tokens:
              'isDeferred' in group
                ? (rowTokens(props.snapshot, 'System tools (deferred)') ?? sumTokens(group.rows))
                : sumTokens(group.rows),
            tokensNote: 'isDeferred' in group ? 'when loaded' : undefined,
            children: ToolLines({ ...props, rows: group.rows }),
          }),
        ),
      })}
    </Box>
  )
}

/** The Prompt tab: the system prompt section by section, each opening to its text. */
function PromptTab(props: ContextPaneProps) {
  const { Box } = props.ui
  const sent = props.trace.prompt
  const sections: PromptSection[] = sent ?? props.snapshot?.prompt ?? []
  const counted = rowTokens(props.snapshot, 'System prompt') ?? 0
  const unread = sent ? 0 : counted - sumTokens(sections)
  const section = (one: PromptSection) => {
    const id = `prompt-${slug(one.id)}`
    const isOpen = props.expanded.includes(id)

    return (
      <Box key={id} flexDirection="column" rowGap={1}>
        {DisclosureRow({
          ui: props.ui,
          row: { id, label: one.title, figure: `~${formatTokens(one.tokens)}`, isOpen },
        })}
        {isOpen && Paged({ ui: props.ui, text: one.text, page: props.page, onPage: props.onPage })}
      </Box>
    )
  }
  const own = sections.filter(one => !one.isAdded)
  const added = sections.filter(one => one.isAdded)
  const groups = [
    { id: 'prompt-own', label: 'Claude Code’s prompt', sections: own },
    { id: 'prompt-added', label: 'Added at send time', sections: added },
  ].filter(group => group.sections.length > 0)

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
            : sent
              ? 'The system prompt exactly as the last request sent it: Claude Code’s own ' +
                'sections, then what was added to them when it was sent, such as the billing ' +
                'header, the line that introduces Claude and the app’s own instructions.'
              : 'The system prompt as this session composes it. Sizes are estimated from each ' +
                "section's text. Turn on tracing (the Trace tab) to see it exactly as sent.",
      })}
      {Groups({
        ui: props.ui,
        children: [
          ...groups.map(group =>
            Group({
              ui: props.ui,
              id: group.id,
              label: group.label,
              count: group.sections.length,
              noun: 'section',
              tokens: sumTokens(group.sections),
              children: Ruled({ ui: props.ui, children: group.sections.map(section) }),
            }),
          ),
          // What /context counts that no plugin can read, so the groups add up to the row.
          ...(unread >= UNREAD_MIN_TOKENS
            ? [
                Group({
                  ui: props.ui,
                  id: 'prompt-unread',
                  label: 'Added at send time',
                  count: 1,
                  noun: 'part',
                  tokens: unread,
                  children: ItemLine({
                    ui: props.ui,
                    item: { name: 'Not readable by plugins', tokens: unread, detail: '' },
                    note:
                      'The output style, the line that introduces Claude, and any instructions ' +
                      'the app or --append-system-prompt adds. Turn on tracing to see them.',
                  }),
                }),
              ]
            : []),
        ],
      })}
    </Box>
  )
}

const SKILL_GROUPS: readonly { origin: SkillOrigin; label: string }[] = [
  { origin: 'yours', label: 'User installed skills' },
  { origin: 'organization', label: 'Your organization' },
  { origin: 'anthropic', label: 'Anthropic skills' },
]

/**
 * The Skills tab: each skill's listing as the model sees it, the ones the
 * person added apart from the ones Claude Code and the app bring.
 */
function SkillsTab(props: ContextPaneProps) {
  const { Box } = props.ui
  const skills = props.snapshot?.skills ?? []
  const groups = SKILL_GROUPS.map(group => ({
    ...group,
    skills: skills.filter(one => one.origin === group.origin),
  })).filter(group => group.skills.length > 0)

  return (
    <Box flexDirection="column" rowGap={1}>
      {Heading({ ui: props.ui, title: 'Skills', snapshot: props.snapshot, row: 'Skills' })}
      {Intro({
        ui: props.ui,
        text:
          skills.length === 0
            ? 'No skills are listed in this session.'
            : "Each skill's listing as the model sees it: the ones you added, then the ones " +
              'Claude Code and the desktop app bring. Removing skills is not supported yet.',
      })}
      {Groups({
        ui: props.ui,
        children: groups.map(group =>
          Group({
            ui: props.ui,
            id: `skills-${group.origin}`,
            label: group.label,
            count: group.skills.length,
            noun: 'skill',
            tokens: sumTokens(group.skills),
            children: Ruled({
              ui: props.ui,
              children: group.skills.map(skill => (
                <Box key={`skill-${skill.name}`} flexDirection="column">
                  {ItemLine({
                    ui: props.ui,
                    // Anthropic's are named under one prefix; their group says so.
                    item: {
                      name: skill.name.replace(/^anthropic-skills:/, ''),
                      tokens: skill.tokens,
                      detail: '',
                    },
                    note: skill.description || `From ${skill.source}.`,
                  })}
                </Box>
              )),
            }),
          }),
        ),
      })}
    </Box>
  )
}

const TRACE_NOTE: Record<Exclude<TraceState['status'], 'on'>, string> = {
  off:
    'Tracing records every request this session sends to the model, the system prompt, the ' +
    'tools and the messages exactly as sent, and what came back. It turns on Claude Code’s own ' +
    'telemetry for new sessions, sent only to a receiver on this machine, which keeps the ' +
    'requests in your Claude folder for 14 days. They hold the whole conversation, file ' +
    'contents and command output included.',
  'next-session':
    'Tracing is on. This session started before it was, so it is not traced: start a new ' +
    'session to trace it.',
  'no-node':
    'Tracing is on, but the receiver could not start: it runs on Node.js, which was not found ' +
    'on your PATH. Install Node.js, then start a new session.',
}

/** A request's figures: tokens read and written, cost, time. */
function usageLine(item: TraceItem): string {
  const usage = item.usage
  if (!usage) return 'waiting for its answer'
  const read = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)
  const parts = [`${formatTokens(read)} in`, `${formatTokens(usage.output ?? 0)} out`]
  if (usage.costUsd !== undefined)
    parts.push(`$${usage.costUsd.toFixed(usage.costUsd < 0.01 ? 4 : 2)}`)
  if (usage.durationMs !== undefined) parts.push(`${(usage.durationMs / 1000).toFixed(1)}s`)

  return parts.join(' · ')
}

function clock(at: string): string {
  const match = /T(\d{2}:\d{2}:\d{2})/.exec(at)

  return match?.[1] ?? ''
}

/** The Trace tab: every request of the conversation as sent, each opening onto its text. */
function TraceTab(props: ContextPaneProps) {
  const { Box, Button, Code, Link, Text } = props.ui
  const traced = props.trace
  const items = [...traced.items].reverse()
  const cost = traced.items.reduce((sum, one) => sum + (one.usage?.costUsd ?? 0), 0)
  const switchButton = (
    <Box flexDirection="row">
      <Button
        key="tracing"
        label={traced.status === 'off' ? 'Turn on tracing' : 'Turn off tracing'}
        variant={traced.status === 'off' ? 'primary' : 'secondary'}
        onPress={() => props.onTracing(traced.status === 'off')}
      />
    </Box>
  )

  return (
    <Box flexDirection="column" rowGap={1}>
      <Box flexDirection="row" alignItems="center" columnGap={2}>
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          <Text color="text" size="heading">
            Trace
          </Text>
        </Box>
        {traced.items.length > 0 && (
          <Text color="subtle" tabular>
            {`${traced.items.length} ${traced.items.length === 1 ? 'request' : 'requests'} · $${cost.toFixed(2)}`}
          </Text>
        )}
      </Box>
      {props.traceError && <Text color="error">{props.traceError}</Text>}
      {traced.status !== 'on' && Intro({ ui: props.ui, text: TRACE_NOTE[traced.status] })}
      {traced.status !== 'on' && switchButton}
      {traced.status === 'on' &&
        Intro({
          ui: props.ui,
          text:
            items.length === 0
              ? 'Tracing is on. Each request appears here once it is sent.'
              : 'Each request this session sent to the model, newest first: what it added to ' +
                'the conversation and what came back. Open one to read it, with its system ' +
                'prompt, tools and every message.',
        })}
      {traced.status === 'on' && (
        // The tab's actions on one line: the whole trace, and the switch at the far end.
        <Box flexDirection="row" alignItems="center" columnGap={2}>
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            {traced.view && items.length > 0 && (
              <Link
                href={viewLink(traced.view.session, traced.view.token)}
                label="Open the whole trace in your browser"
              />
            )}
          </Box>
          {switchButton}
        </Box>
      )}
      {Groups({
        ui: props.ui,
        children: TRACE_GROUPS.map(group => ({
          ...group,
          items: items.filter(item => isMainSource(item.source) === group.isMain),
        }))
          .filter(group => group.items.length > 0)
          .map(group =>
            Group({
              ui: props.ui,
              id: `trace-${group.isMain ? 'main' : 'side'}`,
              label: group.label,
              count: group.items.length,
              noun: 'request',
              extra: `$${group.items.reduce((sum, one) => sum + (one.usage?.costUsd ?? 0), 0).toFixed(2)}`,
              children: Ruled({
                ui: props.ui,
                children: group.items.map(item => traceRow(item, group.isMain)),
              }),
            }),
          ),
      })}
    </Box>
  )

  function traceRow(item: TraceItem, isMain: boolean) {
    const id = `trace-${item.seq}`
    const isOpen = props.expanded.includes(id)

    return (
      <Box key={id} flexDirection="column" rowGap={1}>
        <Box flexDirection="column">
          {DisclosureRow({
            ui: props.ui,
            row: {
              id,
              // Its group names the main loop; a side request says where it came from.
              label: isMain ? `#${item.seq + 1}` : `#${item.seq + 1} ${sourceLabel(item.source)}`,
              tag: clock(item.at),
              figure: usageLine(item),
              isOpen,
            },
          })}
          {/* Under the label, past the chevron: a padding is drawn in whole cells, a width is not. */}
          <Box flexDirection="row">
            <Box width={DISCLOSURE_INDENT} flexShrink={0} />
            <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
              <Text color="subtle" wrap="truncate-end">
                {`+ ${item.added.join(', ') || 'nothing new'}`}
              </Text>
              {item.reply !== null && (
                <Text color="subtle" wrap="truncate-end">
                  {`→ ${item.reply}`}
                </Text>
              )}
            </Box>
          </Box>
        </Box>
        {isOpen && RequestText({ ui: props.ui, text: props.traceText })}
        {isOpen && (
          <Box flexDirection="row" alignItems="center" columnGap={2}>
            <Button
              key={`read-${item.seq}`}
              label="Read it whole here"
              variant="primary"
              onPress={() => props.onRead(item.seq)}
            />
            {traced.view && (
              <Link
                href={viewLink(traced.view.session, traced.view.token, item.seq)}
                label="Open in your browser"
              />
            )}
          </Box>
        )}
      </Box>
    )
  }
}

// The main loop's requests, then the ones made beside it (titles, subagents, compaction).
const TRACE_GROUPS: readonly { isMain: boolean; label: string }[] = [
  { isMain: true, label: 'Conversation' },
  { isMain: false, label: 'Side requests' },
]

/**
 * The pane: the window as a bar, then a tab for each thing the desktop's own
 * Context card cannot show: the built-in tools (which can be removed), the
 * system prompt as sent, the skills' listings and the conversation's trace.
 */
export function ContextPane(props: ContextPaneProps) {
  const { Box, Text } = props.ui
  if (props.reader) {
    return Reader({
      ui: props.ui,
      view: props.reader,
      onSearch: props.onSearch,
      onStep: props.onStep,
    })
  }
  const snapshot = props.snapshot
  const content = {
    tools: ToolsTab,
    prompt: PromptTab,
    skills: SkillsTab,
    trace: TraceTab,
  }[props.tab]

  return (
    <Box flexDirection="column" rowGap={1} paddingX={1}>
      {snapshot ? (
        // Room above the heading, so a pill's card has a line between the bar
        // and the pane's top.
        <Box flexDirection="column" rowGap={1} paddingTop={1}>
          {Header({ ui: props.ui, snapshot })}
          {Bar({ ui: props.ui, snapshot, columns: props.columns })}
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

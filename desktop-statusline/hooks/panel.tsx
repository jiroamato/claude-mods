import type { ElementTable } from 'claude-code'

import type {
  ContextItem,
  ContextSnapshot,
  PaneTab,
  PromptSection,
  SkillOrigin,
  TraceItem,
  TracePlaces,
  TraceState,
} from '../types'
import { formatShare, formatTokens } from './context'
import { DISCLOSURE_ROWS, disclosureRows } from './disclosure'
import type { DisclosureProps } from './disclosure'
import type { ReaderBarProps } from './reader'
import { READER_SCROLLBAR_KEY, SCROLLBAR_COLUMNS } from './scrollbar'
import type { ScrollbarProps } from './scrollbar'
import { READER_TEXT_KEY } from './text'
import type { TextProps } from './text'
import { TAB_PREFIX } from './tabs'
import type { TabProps } from './tabs'
import type { ToolRow } from './tools'
import { MAX_MATCHES, isMainSource, sourceLabel, viewLink } from './trace'

/** The pane the percentage opens. */
export const PANE_ID = 'context-map'
export const PANE_TITLE = 'Context details'

type Ui = ElementTable<'desktop'>

// Sizes in cells: across in character widths, down in rows.
const TOKENS_COLUMNS = 7
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
 * back, enough to tell it apart. Expand shows all of it.
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
    // The chevron sits by the row's first line, whatever lines the region draws under it.
    <Box
      flexDirection="column"
      height={disclosureRows(props.row)}
      paddingLeft={CARET_INSET}
      marginX={-CARET_INSET}
    >
      <Box flexDirection="row" alignItems="center" height={DISCLOSURE_ROWS}>
        <Svg
          source={props.row.isOpen ? CARET_DOWN : CARET_RIGHT}
          alt={props.row.isOpen ? 'open' : 'closed'}
          width={CARET_SIZE}
          height={CARET_SIZE}
        />
      </Box>
      <Box position="absolute" top={0} left={0} right={0} bottom={0}>
        <Client
          key={`${DISCLOSURE_PREFIX}${props.row.id}`}
          module="./disclosure.tsx"
          props={props.row}
          width="100%"
          height={disclosureRows(props.row)}
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

/** A recommendation, set apart from a tab's intro by an info icon. */
function Tip(props: { ui: Ui; text: string }) {
  const { Box, Svg, Text } = props.ui

  return (
    <Box flexDirection="row" columnGap={1} alignItems="flex-start">
      {/* As tall as the footnote's line, so the icon sits by its first line. */}
      <Box height={1} flexShrink={0} justifyContent="center">
        <Svg source={INFO_ICON} alt="tip" width={CARET_SIZE} height={CARET_SIZE} />
      </Box>
      <Box flexGrow={1} flexShrink={1} minWidth={0}>
        <Text color="subtle" size="footnote">
          {props.text}
        </Text>
      </Box>
    </Box>
  )
}

// Phosphor's Info (regular), in the chevrons' size and colour.
const INFO_ICON = caret(
  'M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Zm16-40a8,8,0,0,1-8,8,16,16,0,0,1-16-16V128a8,8,0,0,1,0-16,16,16,0,0,1,16,16v40A8,8,0,0,1,144,176ZM112,84a12,12,0,1,1,12,12A12,12,0,0,1,112,84Z',
)

// Inline code's ground: the raised surface the desktop sets code on.
const INLINE_CODE = 'bashMessageBackgroundColor'

/** The key prefix of a group that opens and closes, as the hooks module keeps it closed. */
export const GROUP_PREFIX = 'group-'

/**
 * A group of what a tab lists, set apart as a card: its name, then how many
 * it holds and their size, then the list. Given `isOpen`, its heading is a
 * row that opens and closes the list.
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
  /** Whether the list shows, for a group that opens and closes. */
  isOpen?: boolean
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

  if (props.isOpen !== undefined) {
    return (
      <Box key={props.id} flexDirection="column" rowGap={1} borderStyle="round">
        {DisclosureRow({
          ui: props.ui,
          row: {
            id: props.id,
            label: props.label,
            figure: figures,
            isOpen: props.isOpen,
            isHeading: true,
          },
        })}
        {props.isOpen && <Box height={HAIRLINE} flexShrink={0} backgroundColor={RULE} />}
        {props.isOpen && props.children}
      </Box>
    )
  }

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
  /** Keys of the groups that are closed: a group is open until closed. */
  collapsed: readonly string[]
  /** Why the last Remove or Put back failed, if it did. */
  error: string | null
  /** The conversation's trace, from the trace receiver. */
  trace: TraceState
  /** The settings file tracing writes and the folder its traces are kept in. */
  places: TracePlaces | null
  /** Why the last tracing switch failed, if it did. */
  traceError: string | null
  /** Why the traces folder did not open. */
  folderError: string | null
  /** The open request of the Trace tab, as text; null when none is open. */
  traceText: string | null
  onToggle: (name: string, isRemoved: boolean) => void
  onExpand: (key: string) => void
  onTracing: (isOn: boolean) => void
  /** Opens the traces folder in the system's file manager. */
  onShowTraces: () => void
  /** The page of the open request or section's text. */
  page: number
  onPage: (page: number) => void
  /** The request read whole, as the rows in view; null while the tabs show. */
  reader: ReaderView | null
  onRead: (seq: number) => void
  onSearch: (query: string) => void
  onStep: (by: number) => void
  /** Moves the reader's rows by `by`, as its page buttons do. */
  onScroll: (by: number) => void
}

/** What the reader draws: the rows in view, and where they sit in the request. */
export type ReaderView = {
  title: string
  detail: string
  /** The row of the text the first one drawn is, from 0. */
  first: number
  /** The rows in view, as many as the pane's window holds under the reader's top. */
  rows: ReaderRow[]
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

/** How many of the text's rows the reader shows under its top, in a window `bodyRows` high. */
export function readerVisibleRows(bodyRows: number): number {
  return Math.max(1, bodyRows - READER_TOP_ROWS)
}

/** A count as the pane writes figures: `4,493`. */
function formatCount(value: number): string {
  return value.toLocaleString('en-US')
}

/**
 * A request whole, read in the pane: its top (the way back, the search, the
 * page buttons) stays, and under it the rows that fit the window, in a region
 * of their own (./text.tsx) that moves them by the keys once clicked, with a
 * scrollbar of the reader's own beside them (./scrollbar.tsx) to press or
 * drag. The whole is never taller than the window, so the pane's own window
 * has nothing to scroll and nothing in it ever moves: the wheel does nothing
 * here, by design, and a drawing holds no more than a screen of text.
 */
function Reader(props: {
  ui: Ui
  view: ReaderView
  onSearch: (query: string) => void
  onStep: (by: number) => void
  onPage: (by: number) => void
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
        : `${search.index + 1} of ${formatCount(search.count)}${search.count >= MAX_MATCHES ? '+' : ''}`
  // Where in the request the rows in view are, in figures beside the scrollbar's thumb.
  const position = `rows ${formatCount(view.first + 1)} to ${formatCount(view.first + view.rows.length)} of ${formatCount(view.total)}`
  const text: TextProps = { rows: view.rows, page: view.rows.length }
  const scrollbar: ScrollbarProps = {
    first: view.first,
    visible: view.rows.length,
    total: view.total,
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box height={READER_TOP_ROWS - 1} flexShrink={0} flexDirection="column" overflow="hidden">
        <Client key={READER_KEY} module="./reader.tsx" props={bar} width="100%" height={1} />
        <Box height={2} flexShrink={0} flexDirection="row" alignItems="center" columnGap={1}>
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            {/* No `value`: the field keeps what is typed. Drawn with one, each
                keystroke's redraw sets the field back to the state's text, and
                a key pressed meanwhile is lost. The field is fresh at each
                opening, as the reader is drawn anew, and the state starts empty. */}
            <Input
              key="reader-search"
              placeholder="Search this request"
              submitLabel="next"
              onInput={value => props.onSearch(value)}
              onSubmit={() => props.onStep(1)}
            />
          </Box>
          {/* Where the rows are gives way before the field, cut short in a narrow pane. */}
          <Box flexShrink={1} minWidth={0}>
            <Text color="subtle" size="footnote" tabular wrap="truncate-end">
              {position}
            </Text>
          </Box>
          {status !== '' && (
            <Box flexShrink={0}>
              <Text color={search.count === 0 ? 'error' : 'subtle'} tabular>
                {status}
              </Text>
            </Box>
          )}
          {search.count > 0 && (
            <Button key="reader-previous" label="↑" onPress={() => props.onStep(-1)} />
          )}
          {search.count > 0 && (
            <Button key="reader-next" label="↓" onPress={() => props.onStep(1)} />
          )}
          {/* A page either way, for the pointer; the keys do the same once the text is clicked. */}
          <Button
            key="reader-page-up"
            label="Page up"
            variant="secondary"
            onPress={() => props.onPage(-view.rows.length)}
          />
          <Button
            key="reader-page-down"
            label="Page down"
            variant="secondary"
            onPress={() => props.onPage(view.rows.length)}
          />
        </Box>
      </Box>
      <Box height={1} flexShrink={0} />
      {/* The text, and beside it the reader's own scrollbar (./scrollbar.tsx):
          the pane's never shows here, as the reader fits its window. */}
      <Box flexDirection="row" height={view.rows.length} flexShrink={0} columnGap={1}>
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          <Client
            key={READER_TEXT_KEY}
            module="./text.tsx"
            props={text}
            width="100%"
            height={view.rows.length}
          />
        </Box>
        <Client
          key={READER_SCROLLBAR_KEY}
          module="./scrollbar.tsx"
          props={scrollbar}
          width={SCROLLBAR_COLUMNS}
          height={view.rows.length}
        />
      </Box>
    </Box>
  )
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
      {Tip({
        ui: props.ui,
        // The tools are the start of what the prompt cache keeps, so a change
        // to them leaves nothing of it to read.
        text:
          'Changing tools at the start of a session is recommended. A mid-session change ' +
          'invalidates the prompt cache, so the next request costs more.',
      })}
      {Groups({
        ui: props.ui,
        children: groups.map(group =>
          Group({
            ui: props.ui,
            id: `${GROUP_PREFIX}${slug(group.label)}`,
            label: group.label,
            isOpen: !props.collapsed.includes(`${GROUP_PREFIX}${slug(group.label)}`),
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
            id: `${GROUP_PREFIX}skills-${group.origin}`,
            label: group.label,
            isOpen: !props.collapsed.includes(`${GROUP_PREFIX}skills-${group.origin}`),
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

/** A path as the person's system writes it: backslashes throughout on Windows. */
function shownPath(path: string): string {
  return path.includes('\\') ? path.replace(/\//g, '\\') : path
}

/** What turning tracing on changes, and where its traces are kept. */
function tracingNotes(places: TracePlaces | null): string[] {
  const settings = places ? `\`${shownPath(places.settings)}\`` : 'your user settings'
  const traces = places ? `\`${shownPath(places.traces)}\`` : 'your home folder'

  return [
    'Tracing records every request a session sends to the model: the system prompt, the tools ' +
      'and the messages exactly as sent, and what came back.',
    `Turning it on adds seven telemetry settings to the \`env\` block of ${settings}, so it ` +
      'applies to every Claude Code session you start after it, in the terminal and in the ' +
      'desktop app. It notes what you had under those names first, and turning it off puts ' +
      'that back.',
    `The requests go only to a receiver on this machine, which keeps them in ${traces}, a ` +
      'folder per session, until you delete them. They hold the whole conversation, file ' +
      'contents and command output included. Delete the folder to remove them.',
  ]
}

/** What tracing holds in place of the person's own `env` values, and that off puts them back. */
function replacedNote(names: string[]): string {
  const joined = joinWords(
    names.map(name => `\`${name}\``),
    'and',
  )
  const isLogs = names.some(name => /^OTEL_(LOGS_EXPORTER|EXPORTER_OTLP_LOGS_)/.test(name))

  return (
    `Tracing set its own values in place of your ${joined}; turning it off puts yours back.` +
    (isLogs ? ' Meanwhile your log events come here, not to where you had them go.' : '')
  )
}

/** What each of tracing's names, set otherwise, does to the requests recorded. */
const DIFFERING_EFFECT: Readonly<Record<string, string>> = {
  CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH: 'be cut short',
  OTEL_LOGS_EXPORT_INTERVAL: 'arrive later',
  OTEL_LOG_RAW_API_BODIES: 'not be recorded',
  OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: 'not be recorded',
}

/** Which of tracing's values the settings hold otherwise while it is on, and how to set them back. */
function differingNote(names: string[]): string {
  const effects = [...new Set(names.flatMap(name => DIFFERING_EFFECT[name] ?? []))]
  const effect = effects.length === 0 ? '' : `, so requests may ${joinWords(effects, 'or')}`
  const [is, it] = names.length === 1 ? ['is', 'it'] : ['are', 'them']
  const listed = joinWords(
    names.map(name => `\`${name}\``),
    'and',
  )

  return (
    `${listed} in your settings ${is} not as tracing sets ${it}${effect}. ` +
    `Turning tracing off and on again sets ${it} back.`
  )
}

/** Words as a list in a sentence: `a`, `a and b`, `a, b and c`. */
function joinWords(words: string[], last: string): string {
  return words.length === 1 ? words[0]! : `${words.slice(0, -1).join(', ')} ${last} ${words.at(-1)}`
}

/** Where traces are kept, said under the list: the one folder, to find or delete. */
function keptNote(places: TracePlaces | null): string {
  return places
    ? `Kept in \`${shownPath(places.traces)}\` until you delete them, one folder per session.`
    : 'Kept in your home folder until you delete them.'
}

const TRACE_NOTE: Record<Exclude<TraceState['status'], 'on' | 'off'>, string> = {
  unreachable:
    'Tracing is on, but no receiver answers on port 43180: another program may hold the ' +
    'port, or the receiver stopped. Requests are not being recorded.',
  elsewhere:
    'Tracing is on, but this session sends its telemetry to an endpoint set elsewhere (your ' +
    'organization’s settings or a variable of your own), so its requests go there, whole, and ' +
    'are not recorded here. Turn tracing off unless you mean them to go there.',
  'next-session':
    'Tracing is on. This session started before it was, so it is not traced: start a new ' +
    'session to trace it.',
  emptied:
    'Tracing is on, but none of this session’s requests are in its traces folder: it was ' +
    'deleted, or they were not recorded. Each request from now on appears here once it is sent.',
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
  const { Box, Button, Link, Text } = props.ui
  const traced = props.trace
  const items = [...traced.items].reverse()
  const cost = traced.items.reduce((sum, one) => sum + (one.usage?.costUsd ?? 0), 0)
  const replaced =
    traced.status !== 'off' &&
    traced.replaced.length > 0 &&
    Intro({ ui: props.ui, text: replacedNote(traced.replaced) })
  const differing =
    traced.status !== 'off' &&
    traced.differing.length > 0 &&
    Intro({ ui: props.ui, text: differingNote(traced.differing) })
  const switchButton = (
    <Box flexDirection="row" columnGap={1}>
      {/* Where the traces are, in Explorer, Finder or the desktop's file manager. */}
      {props.places && (
        <Button
          key="trace-folder"
          label="Open traces folder"
          variant="secondary"
          onPress={() => props.onShowTraces()}
        />
      )}
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
      {props.folderError && <Text color="error">{props.folderError}</Text>}
      {traced.status === 'off' &&
        tracingNotes(props.places).map(text => Intro({ ui: props.ui, text }))}
      {traced.status !== 'on' &&
        traced.status !== 'off' &&
        Intro({ ui: props.ui, text: TRACE_NOTE[traced.status] })}
      {traced.status !== 'on' && differing}
      {traced.status !== 'on' && replaced}
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
      {traced.status === 'on' && Intro({ ui: props.ui, text: keptNote(props.places) })}
      {traced.status === 'on' && differing}
      {traced.status === 'on' && replaced}
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
        {DisclosureRow({
          ui: props.ui,
          row: {
            id,
            // Its group names the main loop; a side request says where it came from.
            label: isMain ? `#${item.seq + 1}` : `#${item.seq + 1} ${sourceLabel(item.source)}`,
            tag: clock(item.at),
            figure: usageLine(item),
            isOpen,
            // What it added and what came back, lit with the row as one pill.
            lines: [
              `+ ${item.added.join(', ') || 'nothing new'}`,
              ...(item.reply === null ? [] : [`→ ${item.reply}`]),
            ],
          },
        })}
        {isOpen && RequestText({ ui: props.ui, text: props.traceText })}
        {isOpen && (
          <Box flexDirection="row" alignItems="center" columnGap={2}>
            <Button
              key={`read-${item.seq}`}
              label="Expand"
              variant="primary"
              onPress={() => props.onRead(item.seq)}
            />
            {traced.view && (
              // A pill beside Expand, quieter: only a Link opens the browser,
              // so the Link is set on a pill of its own.
              <Box
                borderStyle="round"
                borderColor={CLEAR}
                backgroundColor={BROWSER_PILL}
                paddingX={1}
                paddingY={0.2}
              >
                <Link href={viewLink(traced.view.session, traced.view.token, item.seq)}>
                  <Text color={BROWSER_PILL_TEXT}>Open in your browser</Text>
                </Link>
              </Box>
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
 * The pane: a tab for each thing the desktop's own Context card cannot show:
 * the built-in tools (which can be removed), the system prompt as sent, the
 * skills' listings and the conversation's trace.
 */
export function ContextPane(props: ContextPaneProps) {
  const { Box, Text } = props.ui
  if (props.reader) {
    return Reader({
      ui: props.ui,
      view: props.reader,
      onSearch: props.onSearch,
      onStep: props.onStep,
      onPage: props.onScroll,
    })
  }
  const content = {
    tools: ToolsTab,
    prompt: PromptTab,
    skills: SkillsTab,
    trace: TraceTab,
  }[props.tab]

  return (
    <Box flexDirection="column" rowGap={1} paddingX={1}>
      {Tabs(props)}
      {props.error && <Text color="error">{props.error}</Text>}
      <Box flexDirection="column" paddingTop={1}>
        {content(props)}
      </Box>
    </Box>
  )
}

// The browser's pill: light grey, set apart from Expand's white.
const BROWSER_PILL = '#c2c0b6'
const BROWSER_PILL_TEXT = '#1f1e1d'

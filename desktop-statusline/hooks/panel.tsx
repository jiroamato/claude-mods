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
import { READER_TEXT_KEY } from './text'
import type { TextProps } from './text'
import { TAB_PREFIX } from './tabs'
import type { TabProps } from './tabs'
import type { ToolRow } from './tools'
import { MAX_MATCHES, isMainSource, sourceLabel, viewLink } from './trace'

export const PANE_ID = 'context-details'
export const OLD_PANE_ID = 'context-map'
export const PANE_TITLE = 'Context details'

type Ui = ElementTable<'desktop'>

const TOKENS_COLUMNS = 7
const CLEAR = '#00000000'
const HAIRLINE = 0.05
const RULE = 'promptBorderShimmer'
const UNREAD_MIN_TOKENS = 100
const PAGE_CHARS = 40_000
const PAGE_SLACK = 4_000

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

function Tabs(props: ContextPaneProps) {
  const { Box, Client } = props.ui

  return (
    <Box
      flexDirection="row"
      columnGap="xs"
      padding="xs"
      borderStyle="round"
      borderColor={CLEAR}
      backgroundColor={TAB_TRACK}
    >
      {TABS.map(tab => {
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
        }

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

const TAB_TRACK = '#0000004d'

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

function Paged(props: { ui: Ui; text: string; page: number; onPage: (page: number) => void }) {
  const { Box, Button, Code, Text } = props.ui
  const starts = pageStarts(props.text)
  const page = Math.min(Math.max(0, props.page), starts.length - 1)
  const from = starts[page]!
  const to = starts[page + 1] ?? props.text.length
  const code = <Code source={props.text.slice(from, to)} wrap="wrap" />
  if (starts.length === 1) return code
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

const PREVIEW_ROWS = 12
const PREVIEW_CHARS = 1_500

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

export const DISCLOSURE_PREFIX = 'disclose-'

function DisclosureRow(props: { ui: Ui; row: DisclosureProps }) {
  const { Box, Client, Svg } = props.ui

  return (
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
const CARET_INSET = 1

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

function Intro(props: { ui: Ui; text: string }) {
  const { Text } = props.ui
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

function Tip(props: { ui: Ui; text: string }) {
  const { Box, Svg, Text } = props.ui

  return (
    <Box flexDirection="row" columnGap={1} alignItems="flex-start">
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

const INFO_ICON = caret(
  'M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Zm16-40a8,8,0,0,1-8,8,16,16,0,0,1-16-16V128a8,8,0,0,1,0-16,16,16,0,0,1,16,16v40A8,8,0,0,1,144,176ZM112,84a12,12,0,1,1,12,12A12,12,0,0,1,112,84Z',
)

const INLINE_CODE = 'bashMessageBackgroundColor'

export const GROUP_PREFIX = 'group-'

export const TRACE_ITEM_PREFIX = 'trace-'

function Group(props: {
  ui: Ui
  id: string
  label: string
  count: number
  noun: string
  tokens?: number
  tokensNote?: string
  extra?: string
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

function Groups(props: { ui: Ui; children: JSX.Element[] }) {
  const { Box } = props.ui

  return (
    <Box flexDirection="column" rowGap={2} paddingTop={1}>
      {props.children}
    </Box>
  )
}

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

function ItemLine(props: { ui: Ui; item: ContextItem; note?: string }) {
  const { Box, Text } = props.ui
  const item = props.item
  const detail = props.note ?? item.detail

  return (
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

export type ContextPaneProps = {
  ui: Ui
  snapshot: ContextSnapshot | null
  tools: ToolRow[]
  tab: PaneTab
  expanded: readonly string[]
  collapsed: readonly string[]
  error: string | null
  trace: TraceState
  places: TracePlaces | null
  traceError: string | null
  folderError: string | null
  traceText: string | null
  onToggle: (name: string, isRemoved: boolean) => void
  onExpand: (key: string) => void
  onTracing: (isOn: boolean) => void
  onShowTraces: () => void
  page: number
  onPage: (page: number) => void
  reader: ReaderView | null
  onRead: (seq: number) => void
  onSearch: (query: string) => void
  onStep: (by: number) => void
}

export type ReaderView = {
  title: string
  detail: string
  text: TextProps
  search: { query: string; index: number; count: number }
}

const READER_TOP_ROWS = 3
const READER_FRAME_ROWS = 2
export const READER_SIDE_COLUMNS = 7

export function readerVisibleRows(bodyRows: number): number {
  return Math.max(1, bodyRows - READER_TOP_ROWS - READER_FRAME_ROWS)
}

function formatCount(value: number): string {
  return value.toLocaleString('en-US')
}

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
        : `${search.index + 1} of ${formatCount(search.count)}${search.count >= MAX_MATCHES ? '+' : ''}`
  const text = view.text
  const inView = Math.min(text.page, text.total - text.first)
  const position = `rows ${formatCount(text.first + 1)} to ${formatCount(text.first + inView)} of ${formatCount(text.total)}`

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box height={READER_TOP_ROWS} flexShrink={0} flexDirection="column" overflow="hidden">
        <Client key={READER_KEY} module="./reader.tsx" props={bar} width="100%" height={1} />
        <Box height={2} flexShrink={0} flexDirection="row" alignItems="center" columnGap={1}>
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            <Input
              key="reader-search"
              placeholder="Search this request"
              submitLabel="next"
              onInput={value => props.onSearch(value)}
              onSubmit={() => props.onStep(1)}
            />
          </Box>
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
        </Box>
      </Box>
      <Box borderStyle="round" height={text.page + READER_FRAME_ROWS} flexShrink={0}>
        <Client
          key={READER_TEXT_KEY}
          module="./text.tsx"
          props={text}
          width="100%"
          height={text.page}
        />
      </Box>
    </Box>
  )
}

export const READER_KEY = 'reader'

const STATUS_NOTE: Record<ToolRow['status'], string> = {
  in: '',
  deferred: '',
  removed: 'removed',
  'back-next-session': '',
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

function ToolsTab(props: ContextPaneProps) {
  const { Box } = props.ui
  const byStatus = (status: ToolRow['status']) => props.tools.filter(one => one.status === status)
  const groups: { label: string; note?: string; rows: ToolRow[] }[] = [
    { label: 'In context', rows: byStatus('in') },
    { label: 'Deferred (loaded on demand)', note: 'when loaded', rows: byStatus('deferred') },
    { label: 'Back in a new session', rows: byStatus('back-next-session') },
    { label: 'Removed', rows: byStatus('removed') },
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
            tokens: sumTokens(group.rows),
            tokensNote: group.note,
            children: ToolLines({ ...props, rows: group.rows }),
          }),
        ),
      })}
    </Box>
  )
}

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

function shownPath(path: string): string {
  return path.includes('\\') ? path.replace(/\//g, '\\') : path
}

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

const DIFFERING_EFFECT: Readonly<Record<string, string>> = {
  CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH: 'be cut short',
  OTEL_LOGS_EXPORT_INTERVAL: 'arrive later',
  OTEL_LOG_RAW_API_BODIES: 'not be recorded',
  OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: 'not be recorded',
}

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

function joinWords(words: string[], last: string): string {
  return words.length === 1 ? words[0]! : `${words.slice(0, -1).join(', ')} ${last} ${words.at(-1)}`
}

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
    const id = `${TRACE_ITEM_PREFIX}${item.seq}`
    const isOpen = props.expanded.includes(id)

    return (
      <Box key={id} flexDirection="column" rowGap={1}>
        {DisclosureRow({
          ui: props.ui,
          row: {
            id,
            label: isMain ? `#${item.seq + 1}` : `#${item.seq + 1} ${sourceLabel(item.source)}`,
            tag: clock(item.at),
            figure: usageLine(item),
            isOpen,
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

const TRACE_GROUPS: readonly { isMain: boolean; label: string }[] = [
  { isMain: true, label: 'Conversation' },
  { isMain: false, label: 'Side requests' },
]

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

const BROWSER_PILL = '#c2c0b6'
const BROWSER_PILL_TEXT = '#1f1e1d'

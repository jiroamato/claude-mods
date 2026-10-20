import type { ElementTable } from 'claude-code'

import type {
  ContextItem,
  ContextSnapshot,
  PaneTab,
  PromptSection,
  TraceItem,
  TraceState,
} from '../types'
import { FREE, barSegments, formatShare, formatTokens } from './context'
import type { TabStripProps } from './tabs'
import type { ToolRow } from './tools'
import { sourceLabel, viewLink } from './trace'

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

const CLOSED = '▸'
const OPEN = '▾'

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

/** The key of the tab strip's region, which the hooks module hears it post under. */
export const TABS_KEY = 'tabs'

/**
 * The tab strip: each tab's label and, where /context counts it, its tokens.
 * A region of its own (./tabs.tsx), so the whole pill of a tab takes the press.
 */
function Tabs(props: ContextPaneProps) {
  const { Client } = props.ui
  const strip: TabStripProps = {
    open: props.tab,
    tabs: TABS.map(tab => {
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

      return { id: tab.id, label: tab.label, figure }
    }),
  }

  return <Client key={TABS_KEY} module="./tabs.tsx" props={strip} width="100%" />
}

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

/**
 * An open request as text: whole when it fits in the pane, which draws at most
 * 100000 characters of code; else its opening, and where the rest is.
 */
function RequestText(props: { ui: Ui; text: string | null }) {
  const { Box, Code, Text } = props.ui
  if (props.text === null) return <Text color="subtle">This request could not be read.</Text>
  const end = pageStarts(props.text)[1]
  if (end === undefined) return <Code source={props.text} wrap="wrap" />

  return (
    <Box flexDirection="column" rowGap={1}>
      <Code source={props.text.slice(0, end)} wrap="wrap" />
      <Text color="subtle" size="footnote">
        {`The pane shows the first ${end.toLocaleString('en-US')} of its ${props.text.length.toLocaleString('en-US')} characters; the browser shows it whole.`}
      </Text>
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
  const sent = props.trace.prompt
  const sections: PromptSection[] = sent ?? props.snapshot?.prompt ?? []
  const counted = rowTokens(props.snapshot, 'System prompt') ?? 0
  const unread = sent ? 0 : counted - sections.reduce((sum, one) => sum + one.tokens, 0)

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
              ? 'The system prompt exactly as the last request sent it, in order. The engine’s own ' +
                'sections, and marked added what came from outside them: the output style, the ' +
                'line that names Claude, an app’s own instructions.'
              : 'The system prompt as this session composes it, section by section. Sizes are ' +
                "estimated from each section's text. Turn tracing on (the Trace tab) to see " +
                'it exactly as sent.',
      })}
      {sections.length > 0 &&
        Ruled({
          ui: props.ui,
          children: sections.map(section => {
            const id = `prompt-${slug(section.id)}`
            const isOpen = props.expanded.includes(id)

            return (
              <Box key={id} flexDirection="column" rowGap={1}>
                <Box flexDirection="row" alignItems="center" columnGap={1}>
                  <Box flexGrow={1} flexShrink={1} minWidth={0}>
                    <Button key={`open-${id}`} plain onPress={() => props.onExpand(id)}>
                      <Text color="text">{section.title}</Text>
                      {section.isAdded && <Text color="subtle">{' added'}</Text>}{' '}
                      <Text color="inactive">{isOpen ? OPEN : CLOSED}</Text>
                    </Button>
                  </Box>
                  {Figure({ ui: props.ui, text: `~${formatTokens(section.tokens)}` })}
                </Box>
                {isOpen &&
                  Paged({
                    ui: props.ui,
                    text: section.text,
                    page: props.page,
                    onPage: props.onPage,
                  })}
              </Box>
            )
          }),
        })}
      {unread >= UNREAD_MIN_TOKENS && (
        // What /context counts that no plugin can read, so the list adds up to the row.
        <Box flexDirection="row" alignItems="flex-start" columnGap={1} paddingTop={1}>
          <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
            <Text color="secondaryText">Not readable by plugins</Text>
            <Text color="subtle" size="footnote">
              The rest of what /context counts: the output style, the line that names Claude Code,
              and any instructions the app or an --append-system-prompt adds. Turn tracing on to see
              them.
            </Text>
          </Box>
          {Figure({ ui: props.ui, text: `~${formatTokens(unread)}` })}
        </Box>
      )}
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
              : 'Each request this session sent, newest first: what it added to the ' +
                'conversation, and what came back. Open one to read it, or read any request ' +
                'whole in your browser: its system prompt, tools and every message.',
        })}
      {traced.status === 'on' && traced.view && items.length > 0 && (
        <Link
          href={viewLink(traced.view.session, traced.view.token)}
          label="Open the whole trace in your browser"
        />
      )}
      {items.length > 0 &&
        Ruled({
          ui: props.ui,
          children: items.map(item => {
            const id = `trace-${item.seq}`
            const isOpen = props.expanded.includes(id)

            return (
              <Box key={id} flexDirection="column" rowGap={1}>
                <Box flexDirection="row" alignItems="flex-start" columnGap={1}>
                  <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
                    <Button key={`open-${id}`} plain onPress={() => props.onExpand(id)}>
                      <Text color="text">{`#${item.seq + 1} ${sourceLabel(item.source)}`}</Text>
                      <Text color="subtle">{` ${clock(item.at)}`}</Text>{' '}
                      <Text color="inactive">{isOpen ? OPEN : CLOSED}</Text>
                    </Button>
                    <Text color="subtle" wrap="truncate-end">
                      {`+ ${item.added.join(', ') || 'nothing new'}`}
                    </Text>
                    {item.reply !== null && (
                      <Text color="subtle" wrap="truncate-end">
                        {`→ ${item.reply}`}
                      </Text>
                    )}
                  </Box>
                  <Box flexShrink={0}>
                    <Text color="subtle" size="footnote" tabular>
                      {usageLine(item)}
                    </Text>
                  </Box>
                </Box>
                {isOpen && traced.view && (
                  <Link
                    href={viewLink(traced.view.session, traced.view.token, item.seq)}
                    label="Open this request whole in your browser"
                  />
                )}
                {isOpen && RequestText({ ui: props.ui, text: props.traceText })}
              </Box>
            )
          }),
        })}
      {traced.status === 'on' && <Box paddingTop={1}>{switchButton}</Box>}
    </Box>
  )
}

/**
 * The pane: the window as a bar, then a tab for each thing the desktop's own
 * Context card cannot show: the built-in tools (which can be removed), the
 * system prompt as sent, the skills' listings and the conversation's trace.
 */
export function ContextPane(props: ContextPaneProps) {
  const { Box, Text } = props.ui
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

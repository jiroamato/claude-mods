import { expect, mock, test } from 'claude-code/testing'
import type { On, PromptComposeSection, SessionContextBreakdown } from 'claude-code'

import {
  buildSnapshot,
  currentSnapshot,
  formatShare,
  formatTokens,
  sectionTitle,
  skillOrigin,
} from '../hooks/context'
import { deniedTools, editDeny, summarize, toolRows } from '../hooks/tools'

const ENGINE = { plugin: 'engine', tier: 'core' } as const
// The engine resolves the path for the platform, so compare its tail.
const SETTINGS_PATH = /[\\/]home[\\/]me[\\/]\.claude[\\/]settings\.json$/

const BAND = {
  plugin: 'desktop-statusline',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 6,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 6 },
    view: {},
  },
} as const

const PANE = {
  plugin: 'desktop-statusline',
  component: 'Pane',
  requestId: 'context-map',
  props: {
    title: 'Context',
    isFocused: false,
    bodyColumns: 70,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

function breakdown(): SessionContextBreakdown {
  return {
    categories: [
      {
        name: 'System prompt',
        tokens: 8_000,
        color: 'promptBorder',
        isDeferred: false,
        kind: 'used',
      },
      { name: 'System tools', tokens: 20_000, color: 'inactive', isDeferred: false, kind: 'used' },
      { name: 'Skills', tokens: 4_000, color: 'warning', isDeferred: false, kind: 'used' },
      { name: 'Messages', tokens: 60_000, color: 'permission', isDeferred: false, kind: 'used' },
      { name: 'MCP tools', tokens: 900, color: 'cyan', isDeferred: false, kind: 'used' },
      { name: 'Memory files', tokens: 700, color: 'claude', isDeferred: false, kind: 'used' },
      {
        name: 'MCP tools (deferred)',
        tokens: 3_000,
        color: 'inactive',
        isDeferred: true,
        kind: 'deferred',
      },
      { name: 'Free space', tokens: 100_000, color: 'inactive', isDeferred: false, kind: 'free' },
      {
        name: 'Autocompact buffer',
        tokens: 8_000,
        color: 'inactive',
        isDeferred: false,
        kind: 'buffer',
      },
    ],
    totalTokens: 93_600,
    maxTokens: 200_000,
    rawMaxTokens: 200_000,
    autocompactSource: 'auto',
    percentage: 46,
    gridRows: [],
    model: 'Opus 5.5',
    memoryFiles: [{ path: '/repo/CLAUDE.md', type: 'Project', tokens: 700 }],
    mcpTools: [
      { name: 'mcp__docs__lookup', serverName: 'docs', tokens: 600, isLoaded: true },
      { name: 'mcp__docs__search', serverName: 'docs', tokens: 300, isLoaded: true },
      { name: 'mcp__web__browse', serverName: 'web', tokens: 3_000, isLoaded: false },
    ],
    agents: [],
    skills: {
      totalSkills: 2,
      includedSkills: 2,
      tokens: 4_000,
      skillFrontmatter: [
        { name: 'deploy', source: 'userSettings', tokens: 300 },
        { name: 'review', source: 'plugin', pluginName: 'reviewer', tokens: 120 },
        { name: 'plugin-authoring', source: 'built-in', tokens: 90 },
      ],
    },
    isAutoCompactEnabled: true,
    apiUsage: null,
  }
}

const SECTIONS: PromptComposeSection[] = [
  { id: 'intro', text: '\nYou are Claude Code, an interactive CLI tool.', scope: 'shared' },
  { id: 'env_info_simple', text: '# Environment\n - Platform: linux', scope: 'session' },
  { id: 'memory', text: '   ', scope: 'session' },
]

const DEPLOY = {
  name: 'deploy',
  description: 'Ships the app to production. Runs the checks first.',
  source: 'user',
  isFullscreen: false,
} as const

/** The engine around the plugin: a settings file in memory, the usage and the transcript. */
type SettingsFile = { text: string; isLocked?: boolean; path?: RegExp; writes?: number }

/** Files under the trace folder, by name, as the receiver writes them. */
type TraceFiles = Record<string, string>

function engine(
  on: On,
  settings: SettingsFile,
  env: Record<string, string> = { HOME: '/home/me' },
  traced?: TraceFiles,
) {
  const clock = mock.clock(on, { now: 1_000 })
  mock.store(on)
  mock.env(on, env)
  const traceFile = (path: string) =>
    traced ? /[\\/]traces[\\/]session-1[\\/]([^\\/]+)$/.exec(path)?.[1] : undefined
  on('fs.exists', async () => ({ value: true }))
  on('fs.read', async (_$, e) => {
    const name = traceFile(e.path)

    return { value: name !== undefined ? (traced?.[name] ?? '') : settings.text }
  })
  on('fs.list', async () => ({
    value: Object.keys(traced ?? {}).map(name => ({
      name,
      kind: 'file' as const,
      size: traced![name]!.length,
      mtimeMs: 1,
      isLink: false,
    })),
  }))
  on('session.id', async () => ({ value: 'session-1' }))
  on('http.fetch', async () => ({
    value: { status: 200, ok: true, headers: {}, text: 'desktop-statusline trace receiver 7' },
  }))
  on('fs.write', async (_$, e) => {
    expect(e.path).toMatch(settings.path ?? SETTINGS_PATH)
    if (settings.isLocked) return { deny: 'EPERM: settings.json is read-only' }
    settings.text = e.text
    settings.writes = (settings.writes ?? 0) + 1

    return { value: undefined }
  })
  on('session.model', async () => ({ value: 'Opus 5.5' }))
  on('session.cwd', async () => ({ value: '/repo' }))
  on('session.usage', async (_$, e) => ({
    value: {
      startedAt: 0,
      context: {
        window: 200_000,
        tokens: 92_000,
        percent: 46,
        ...(e?.breakdown === 'full' ? { breakdown: breakdown() } : {}),
      },
      rateLimits: [],
    },
  }))
  on('command.list', async () => ({ value: [DEPLOY] }))
  on('prompt.compose', async () => ({ sections: SECTIONS }))
  on('process.run', async () => ({
    value: {
      exitCode: 1,
      stdout: '',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  on('config.list', async () => ({ value: [] }))
  on('settings.read', async () => ({ value: {} }))
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('tool.describe', async (_$, e) => ({ description: e.description }))
  on('ui.toast', async () => ({ value: undefined }))

  return clock
}

test('editDeny adds and drops a bare tool name and keeps the rest of the file', () => {
  const text = '{\n    "model": "opus",\n    "permissions": { "deny": ["Read(.env)"] }\n}\n'
  const removed = editDeny(text, 'NotebookEdit', true)
  expect(JSON.parse(removed)).toEqual({
    model: 'opus',
    permissions: { deny: ['Read(.env)', 'NotebookEdit'] },
  })
  expect(removed).toMatch(/^\{\n {4}"model"/)
  expect(editDeny(removed, 'NotebookEdit', true)).toBe(removed)
  expect(JSON.parse(editDeny(removed, 'NotebookEdit', false)).permissions.deny).toEqual([
    'Read(.env)',
  ])
  expect(JSON.parse(editDeny('', 'Write', true))).toEqual({ permissions: { deny: ['Write'] } })
  expect(editDeny(text, 'Write', false)).toBe(text)
})

test('deniedTools reads only whole-tool rules', () => {
  expect(
    deniedTools({ permissions: { deny: ['EnterPlanMode', 'Read(.env)', 'mcp__x__y', 3] } }),
  ).toEqual(['EnterPlanMode'])
  expect(deniedTools({})).toEqual([])
})

test('summarize prefers the catalog, else the first sentence of the description', () => {
  expect(summarize('Bash', 'anything')).toBe('Runs a shell command and returns its output.')
  expect(summarize('Mystery', '# Mystery\n\nDoes a thing. Then more.')).toBe('Does a thing.')
  expect(summarize('Mystery', undefined)).toBe('A built-in tool.')
})

test('toolRows orders the tools by status, then by size', () => {
  const rows = toolRows(
    {
      Bash: { description: 'b'.repeat(1_000), isDeferred: false },
      Grep: { description: 'g'.repeat(400), isDeferred: false },
      Monitor: { description: 'm', isDeferred: true },
      Write: { description: 'w', isDeferred: false },
      ToolSearch: { description: 't', isDeferred: false },
    },
    {},
    ['Write', 'EnterPlanMode', 'Unknown'],
    [],
  )
  // In the window first, largest first; then loaded on demand; then removed.
  expect(rows.map(one => [one.name, one.status])).toEqual([
    ['Grep', 'in'],
    ['Bash', 'in'],
    ['Monitor', 'deferred'],
    ['EnterPlanMode', 'removed'],
    ['Write', 'removed'],
  ])
  // Name, description and Grep's measured schema at 3.6 characters a token.
  expect(rows.find(one => one.name === 'Grep')?.tokens).toBe(
    Math.round((4 + 400 + 2776 + 40) / 3.6),
  )
  // Loaded on demand, its size is what it would take once loaded.
  expect(rows.find(one => one.name === 'Monitor')?.tokens).toBeGreaterThan(0)
})

test('a tool put back that the session started without waits for a new session', () => {
  const rows = toolRows({}, { ListPlugins: 'Lists plugins.' }, [], ['ListPlugins'])
  expect(rows).toEqual([
    expect.objectContaining({
      name: 'ListPlugins',
      status: 'back-next-session',
      summary: 'Lists plugins.',
    }),
  ])
})

test('the snapshot lists the rows as /context does, and what the pane details', () => {
  const snapshot = buildSnapshot(breakdown(), [DEPLOY], SECTIONS)
  expect(snapshot).toMatchObject({ used: 93_600, window: 200_000, percent: 46 })
  // In the window largest first; then the reserve, the free space and what loads on demand.
  expect(snapshot.rows.map(one => one.name)).toEqual([
    'Messages',
    'System tools',
    'System prompt',
    'Skills',
    'MCP tools',
    'Memory files',
    'Autocompact buffer',
    'Free space',
    'MCP tools (deferred)',
  ])
  // An empty section is not sent, so it is not listed.
  expect(snapshot.prompt.map(one => [one.id, one.title, one.text])).toEqual([
    ['intro', 'Introduction', 'You are Claude Code, an interactive CLI tool.'],
    ['env_info_simple', 'Environment', '# Environment\n - Platform: linux'],
  ])
  expect(snapshot.skills).toEqual([
    {
      name: 'deploy',
      tokens: 300,
      source: 'your settings',
      description: 'Ships the app to production.',
      origin: 'yours',
    },
    { name: 'review', tokens: 120, source: 'reviewer', description: '', origin: 'yours' },
    {
      name: 'plugin-authoring',
      tokens: 90,
      source: 'Claude Code',
      description: '',
      origin: 'anthropic',
    },
  ])
})

test('sizes and shares read as /context prints them', () => {
  expect(formatTokens(1_000_000)).toBe('1M')
  expect(formatTokens(999_960)).toBe('1M')
  expect(formatTokens(894_500)).toBe('894.5k')
  expect(formatTokens(41_234)).toBe('41.2k')
  expect(formatTokens(21_012)).toBe('21k')
  expect(formatTokens(412)).toBe('412')
  expect(formatShare(21_000, 1_000_000)).toBe('2.1%')
  expect(formatShare(10, 1_000_000)).toBe('0.0%')
  expect(sectionTitle({ id: 'heron_brook', text: 'The reasoning effort.' })).toBe('Heron brook')
  expect(sectionTitle({ id: 'acme:house_rules', text: 'Be kind.' })).toBe('House rules')
})

/** Every element under a drawn one, at any depth. */
function descendants(node: { children?: unknown[] }): { type: string; children?: unknown[] }[] {
  return (node.children ?? []).flatMap(child =>
    typeof child === 'object' && child !== null && 'type' in child
      ? [child as { type: string }, ...descendants(child as { children?: unknown[] })]
      : [],
  )
}

/** The pane's tabs in their order, as the strip lays them out. */
const TAB_IDS = ['tools', 'prompt', 'skills', 'trace'] as const

/** Clicks a tab in the pane's strip, in its own region. */
async function openTab(
  pane: {
    pointer: (event: {
      type: 'down'
      x: number
      y: number
      button: 'left'
      in?: string
    }) => Promise<void>
  },
  id: (typeof TAB_IDS)[number],
): Promise<void> {
  await pane.pointer({ type: 'down', x: 2, y: 0, button: 'left', in: `tab-${id}` })
}

test('the meter has no hover card; the percentage opens the pane on its Tools tab', async ($, on) => {
  const clock = engine(on, { text: '{}' })
  let opened: unknown
  on('ui.open', async (_$, e) => {
    opened = e

    return { value: { isPlaced: true } }
  })
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })

  // The desktop's own Context card lists the rows; the band adds nothing over the meter.
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const boxes = await band.findAll({ type: 'Box' })
  expect(boxes.filter(one => one.props.position === 'absolute')).toEqual([])
  expect(boxes.filter(one => one.props.hover !== undefined)).toEqual([])

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await openTab(pane, 'skills')
  expect(await pane.find({ type: 'Text', text: 'deploy' })).toBeDefined()

  const pressed = band.press({ key: 'open-context' })
  // The press reads the settings and the breakdown before it waits; let the time pass.
  for (let step = 0; step < 10; step += 1) await clock.advance(100)
  await pressed
  // Focused, or the desktop spends the first click in it on the focus.
  expect(opened).toMatchObject({ id: 'context-map', title: 'Context details', focus: true })
  expect(await pane.find({ type: 'Text', text: 'deploy' })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: 'Built-in tools' })).toBeDefined()

  await pane.unmount()
  await band.unmount()
})

test('the pane opens on its tabs, each naming what /context counts for it', async ($, on) => {
  engine(on, { text: '{}' })
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })

  // No bar of the window over them: the tabs lead.
  expect(await pane.find({ type: 'Text', text: 'Context window' })).toBeUndefined()
  const tabs = (await pane.findAll({ type: 'Client' })).filter(one =>
    String(one.props.key).startsWith('tab-'),
  )
  expect(tabs.map(one => one.props.module)).toEqual(Array(4).fill('hooks/tabs.tsx'))
  expect(tabs.map(one => one.props.props)).toMatchObject([
    { id: 'tools', label: 'Tools', figure: '20k', isOpen: true, previous: null, next: 'prompt' },
    { id: 'prompt', label: 'Prompt', figure: '8k', isOpen: false },
    { id: 'skills', label: 'Skills', figure: '4k', isOpen: false },
    { id: 'trace', label: 'Trace', figure: null, isOpen: false, next: null },
  ])

  await pane.unmount()
})

test('a tab takes the press anywhere on its pill, and the arrow keys move between tabs', async ($, on) => {
  engine(on, { text: '{}' })
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const open = async () =>
    (await pane.findAll({ type: 'Client' }))
      .filter(one => String(one.props.key).startsWith('tab-'))
      .map(one => one.props.props as { id: string; isOpen: boolean })
      .find(one => one.isOpen)?.id

  // The far edge of the last pill, well clear of its label.
  await pane.resize({ columns: 12, rows: 1, in: 'tab-trace' })
  await pane.pointer({ type: 'down', x: 11, y: 0, button: 'left', in: 'tab-trace' })
  expect(await open()).toBe('trace')
  expect(await pane.find({ type: 'Button', key: 'tracing' })).toBeDefined()
  // The near edge of the second.
  await pane.pointer({ type: 'down', x: 0, y: 0, button: 'left', in: 'tab-prompt' })
  expect(await open()).toBe('prompt')

  await pane.key({ key: 'right', in: 'tab-prompt' })
  expect(await open()).toBe('skills')
  await pane.key({ key: 'left', in: 'tab-skills' })
  await pane.key({ key: 'left', in: 'tab-prompt' })
  expect(await open()).toBe('tools')
  // No tab left of the first.
  await pane.key({ key: 'left', in: 'tab-tools' })
  expect(await open()).toBe('tools')

  await pane.unmount()
})

test('the pane opens the system prompt section by section, one at a time', async ($, on) => {
  engine(on, { text: '{}' })
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect(await pane.find({ type: 'Client', key: 'disclose-prompt-intro' })).toBeUndefined()
  await openTab(pane, 'prompt')
  expect(
    (await pane.find({ type: 'Client', key: 'disclose-prompt-intro' }))?.props.props,
  ).toMatchObject({ label: 'Introduction' })
  // /context counts 8k; the sections hold a few tokens, the rest no plugin can read.
  expect((await pane.find({ type: 'Box', text: /^Not readable by plugins.*~8k$/ }))?.text).toMatch(
    /output style/,
  )
  expect(await pane.find({ type: 'Code' })).toBeUndefined()

  await pane.pointer({ type: 'down', x: 5, y: 0, button: 'left', in: 'disclose-prompt-intro' })
  expect((await pane.findAll({ type: 'Code' })).map(one => one.props.source)).toEqual([
    'You are Claude Code, an interactive CLI tool.',
  ])
  await pane.pointer({
    type: 'down',
    x: 5,
    y: 0,
    button: 'left',
    in: 'disclose-prompt-env-info-simple',
  })
  expect((await pane.findAll({ type: 'Code' })).map(one => one.props.source)).toEqual([
    '# Environment\n - Platform: linux',
  ])

  // Pressing the open section again closes it.
  await pane.pointer({
    type: 'down',
    x: 5,
    y: 0,
    button: 'left',
    in: 'disclose-prompt-env-info-simple',
  })
  expect(await pane.find({ type: 'Code' })).toBeUndefined()

  await pane.unmount()
})

test('the Skills tab lists each skill, yours apart from the ones Anthropic ships', async ($, on) => {
  engine(on, { text: '{}' })
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await openTab(pane, 'skills')
  const heading = async (origin: string) =>
    (await pane.find({ type: 'Client', key: `disclose-group-skills-${origin}` }))?.props.props as
      { label: string; figure: string; isOpen: boolean } | undefined
  expect(await pane.find({ type: 'Text', text: 'Ships the app to production.' })).toBeDefined()
  expect(await heading('yours')).toMatchObject({
    label: 'User installed skills',
    figure: '2 skills · ~420',
    isOpen: true,
  })
  expect((await pane.find({ key: 'group-skills-yours' }))?.text).toMatch(/deploy/)
  expect(await heading('anthropic')).toMatchObject({
    label: 'Anthropic skills',
    figure: '1 skill · ~90',
    isOpen: true,
  })
  expect((await pane.find({ key: 'group-skills-anthropic' }))?.text).toMatch(/plugin-authoring/)
  expect(await pane.find({ key: 'group-skills-organization' })).toBeUndefined()

  // Each group closes on its own, and opens again.
  await pane.pointer({
    type: 'down',
    x: 5,
    y: 0,
    button: 'left',
    in: 'disclose-group-skills-yours',
  })
  expect((await heading('yours'))?.isOpen).toBe(false)
  expect(await pane.find({ type: 'Text', text: 'Ships the app to production.' })).toBeUndefined()
  expect((await heading('anthropic'))?.isOpen).toBe(true)
  await pane.pointer({
    type: 'down',
    x: 5,
    y: 0,
    button: 'left',
    in: 'disclose-group-skills-yours',
  })
  expect(await pane.find({ type: 'Text', text: 'Ships the app to production.' })).toBeDefined()

  await pane.unmount()
})

test('removing a tool denies it in the settings and moves it out of the window at once', async ($, on) => {
  const settings = { text: '{\n  "permissions": {\n    "deny": ["EnterPlanMode"]\n  }\n}\n' }
  engine(on, settings)
  let invalidated = 0
  on('ui.invalidate', async () => {
    invalidated += 1

    return { value: undefined }
  })
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  const bash = { tool: 'Bash', description: 'Executes a command.', provider: ENGINE }
  expect(await $.tool.describe(bash)).toEqual({ description: 'Executes a command.' })

  // The pane opens on the Tools tab.
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await pane.find({ key: 'tool-Bash' }))?.text).toMatch(/Runs a shell command/)
  expect((await pane.find({ key: 'toggle-Bash' }))?.props).toMatchObject({ label: 'Remove' })
  expect((await pane.find({ key: 'toggle-EnterPlanMode' }))?.props).toMatchObject({
    label: 'Put back',
  })
  // Grouped: the removed tool under its own heading.
  expect(
    (await pane.find({ type: 'Client', key: 'disclose-group-removed' }))?.props.props,
  ).toMatchObject({ label: 'Removed', figure: '1 tool · ~181', isOpen: true, isHeading: true })
  expect((await pane.find({ key: 'group-removed' }))?.text).toMatch(/^EnterPlanMode/)

  const before = invalidated
  await pane.press({ key: 'toggle-Bash' })
  expect(JSON.parse(settings.text).permissions.deny).toEqual(['EnterPlanMode', 'Bash'])
  expect(invalidated).toBe(before + 1)
  expect(await $.tool.describe(bash)).toEqual({
    description: 'Executes a command.',
    isDeferred: true,
  })
  expect(await $.tool.call({ tool: 'Bash', tool_use_id: 'u1', command: 'ls' })).toMatchObject({
    deny: expect.stringContaining('The user removed Bash from this session'),
  })
  expect((await pane.find({ key: 'toggle-Bash' }))?.props).toMatchObject({ label: 'Put back' })

  await pane.press({ key: 'toggle-Bash' })
  expect(JSON.parse(settings.text).permissions.deny).toEqual(['EnterPlanMode'])
  expect(await $.tool.describe(bash)).toEqual({ description: 'Executes a command.' })

  await pane.unmount()
})

test('the pane refuses the jump to its last row the desktop reports as a scroll', async ($, on) => {
  engine(on, { text: '{}' })
  let moved = 0
  on('ui.scroll', async () => {
    moved += 1

    return {}
  })
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const window = {
    component: 'Pane',
    requestId: 'context-map',
    bodyRows: 40,
    contentRows: 340,
  } as const
  const person = { kind: 'person' } as const

  // The desktop's jump: straight to the last row, by neither a page nor every row.
  await $.ui.scroll({ ...window, origin: person, by: 290, offset: 300 })
  expect(moved).toBe(0)
  // A wheel tick, a page key and End all go through.
  await $.ui.scroll({ ...window, origin: person, by: 3, offset: 13 })
  await $.ui.scroll({ ...window, origin: person, by: 40, offset: 53 })
  await $.ui.scroll({ ...window, origin: person, by: 340, offset: 300 })
  expect(moved).toBe(3)

  await pane.unmount()
})

test('a settings file that cannot be written says so in the pane and removes nothing', async ($, on) => {
  const settings = { text: '{}\n', isLocked: true }
  engine(on, settings)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.describe({ tool: 'Grep', description: 'Searches.', provider: ENGINE })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await pane.press({ key: 'toggle-Grep' })
  expect(settings.text).toBe('{}\n')
  expect(await pane.find({ type: 'Text', text: /Could not update settings\.json/ })).toBeDefined()
  expect((await pane.find({ key: 'toggle-Grep' }))?.props).toMatchObject({ label: 'Remove' })

  await pane.unmount()
})

test('editDeny refuses settings it would have to reshape', () => {
  expect(() => editDeny('{"permissions": "x"}', 'Bash', true)).toThrow(/not an object/)
  expect(() => editDeny('{"permissions": ["Read"]}', 'Bash', true)).toThrow(/not an object/)
  expect(() => editDeny('{"permissions": {"deny": "Write"}}', 'Bash', true)).toThrow(/not a list/)
  expect(() => editDeny('{ // mine\n}', 'Bash', true)).toThrow(/not plain JSON/)
  expect(() => editDeny('[1]', 'Bash', true)).toThrow(/does not hold an object/)
})

test('editDeny keeps the byte-order mark, the line endings and the top-level indent', () => {
  const text = '\uFEFF{\r\n\t"env": {\r\n\t\t"A": "1"\r\n\t}\r\n}\r\n'
  const out = editDeny(text, 'Bash', true)
  expect(out.startsWith('\uFEFF{\r\n\t"env"')).toBe(true)
  expect(out.endsWith('}\r\n')).toBe(true)
  expect(out.includes('\n') && !/[^\r]\n/.test(out)).toBe(true)
  expect(JSON.parse(out.slice(1))).toEqual({ env: { A: '1' }, permissions: { deny: ['Bash'] } })
})

test('the settings live under CLAUDE_CONFIG_DIR when it is set', async ($, on) => {
  const settings = { text: '{}', path: /[\\/]cfg[\\/]settings\.json$/ }
  engine(on, settings, { CLAUDE_CONFIG_DIR: '/cfg', HOME: '/home/me' })
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.describe({ tool: 'Grep', description: 'Searches.', provider: ENGINE })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await pane.press({ key: 'toggle-Grep' })
  expect(JSON.parse(settings.text).permissions.deny).toEqual(['Grep'])

  await pane.unmount()
})

test('two presses at once both land in the settings file', async ($, on) => {
  const settings: SettingsFile = { text: '{}' }
  engine(on, settings)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.describe({ tool: 'Grep', description: 'Searches.', provider: ENGINE })
  await $.tool.describe({ tool: 'Glob', description: 'Finds files.', provider: ENGINE })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await Promise.all([pane.press({ key: 'toggle-Grep' }), pane.press({ key: 'toggle-Glob' })])
  expect(JSON.parse(settings.text).permissions.deny.sort()).toEqual(['Glob', 'Grep'])
  expect(settings.writes).toBe(2)

  await pane.unmount()
})

test('MCP tools are not listed and ToolSearch is never removed', async ($, on) => {
  engine(on, { text: '{"permissions": {"deny": ["ToolSearch"]}}' })
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  const search = { tool: 'ToolSearch', description: 'Loads tools.', provider: ENGINE }
  expect(await $.tool.describe(search)).toEqual({ description: 'Loads tools.' })
  await $.tool.describe({
    tool: 'mcp__docs__lookup',
    description: 'Looks things up.',
    provider: { plugin: 'mcp:docs', tier: 'user' },
  })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect(await pane.find({ key: 'tool-ToolSearch' })).toBeUndefined()
  expect(await pane.find({ key: 'tool-mcp__docs__lookup' })).toBeUndefined()

  await pane.unmount()
})

test('a deny added by hand is picked up when the pane opens', async ($, on) => {
  const settings = { text: '{}' }
  const clock = engine(on, settings)
  let invalidated = 0
  on('ui.invalidate', async () => {
    invalidated += 1

    return { value: undefined }
  })
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  const grep = { tool: 'Grep', description: 'Searches.', provider: ENGINE }
  await $.tool.describe(grep)

  settings.text = '{"permissions": {"deny": ["Grep"]}}'
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const pressed = band.press({ key: 'open-context' })
  // The press reads the settings and the breakdown before it waits; let the time pass.
  for (let step = 0; step < 10; step += 1) await clock.advance(100)
  await pressed
  expect(invalidated).toBe(1)
  expect(await $.tool.describe(grep)).toEqual({ description: 'Searches.', isDeferred: true })

  await band.unmount()
})

test('with no breakdown yet, the pane still lists the tools, its tabs without sizes', async ($, on) => {
  // No session has started, so no breakdown has been read.
  engine(on, { text: '{}' })
  await $.tool.describe({ tool: 'Bash', description: 'Executes a command.', provider: ENGINE })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect((await pane.find({ key: 'toggle-Bash' }))?.props).toMatchObject({ label: 'Remove' })
  expect((await pane.find({ type: 'Client', key: 'tab-tools' }))?.props.props).toMatchObject({
    figure: null,
  })
  await openTab(pane, 'prompt')
  expect(
    await pane.find({
      type: 'Text',
      text: "The system prompt appears after Claude's first reply.",
    }),
  ).toBeDefined()

  await pane.unmount()
})

test('a breakdown an earlier version kept in the state is read as none', () => {
  // What the treemap version wrote, still in the state after a reload.
  expect(currentSnapshot({ used: 1, window: 2, percent: 50, blocks: [], skills: [] })).toBeNull()
  expect(currentSnapshot(null)).toBeNull()
  const snapshot = buildSnapshot(breakdown(), [DEPLOY], SECTIONS)
  expect(currentSnapshot(snapshot)).toBe(snapshot)
})

test('a skill is the person’s, Anthropic’s or the organization’s by where it comes from', () => {
  expect(skillOrigin({ name: 'plugin-authoring', source: 'built-in' })).toBe('anthropic')
  expect(skillOrigin({ name: 'anthropic-skills:computer-use', source: 'plugin' })).toBe('anthropic')
  expect(skillOrigin({ name: 'x', source: 'plugin', pluginName: 'cc-plugin-telemetry' })).toBe(
    'anthropic',
  )
  expect(skillOrigin({ name: 'treg', source: 'userSettings' })).toBe('yours')
  expect(skillOrigin({ name: 'review', source: 'plugin', pluginName: 'reviewer' })).toBe('yours')
  expect(skillOrigin({ name: 'policy', source: 'policySettings' })).toBe('organization')
})

test('each group of tools opens and closes on its own, and starts open', async ($, on) => {
  engine(on, { text: '{"permissions":{"deny":["EnterPlanMode"]}}' })
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.describe({ tool: 'Bash', description: 'Executes a command.', provider: ENGINE })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const heading = async (id: string) =>
    (await pane.find({ type: 'Client', key: `disclose-${id}` }))?.props.props as
      { label: string; isOpen: boolean } | undefined

  expect(await heading('group-in-context')).toMatchObject({ label: 'In context', isOpen: true })
  expect(await pane.find({ key: 'tool-Bash' })).toBeDefined()

  await pane.pointer({ type: 'down', x: 5, y: 0, button: 'left', in: 'disclose-group-in-context' })
  expect((await heading('group-in-context'))?.isOpen).toBe(false)
  expect(await pane.find({ key: 'tool-Bash' })).toBeUndefined()
  // The other groups stay as they were, and so does an open prompt section.
  expect((await heading('group-removed'))?.isOpen).toBe(true)
  await openTab(pane, 'prompt')
  await pane.pointer({ type: 'down', x: 5, y: 0, button: 'left', in: 'disclose-prompt-intro' })
  await openTab(pane, 'tools')
  expect((await heading('group-in-context'))?.isOpen).toBe(false)

  await pane.pointer({ type: 'down', x: 5, y: 0, button: 'left', in: 'disclose-group-in-context' })
  expect((await heading('group-in-context'))?.isOpen).toBe(true)
  expect(await pane.find({ key: 'tool-Bash' })).toBeDefined()

  await pane.unmount()
})

test('a row that opens lights under the pointer and goes dark when it leaves', async ($, on) => {
  engine(on, { text: '{}' })
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await openTab(pane, 'prompt')
  const row = 'disclose-prompt-intro'
  const fill = async () =>
    ((await pane.drawn({ in: row })) as { props?: { backgroundColor?: string } }).props
      ?.backgroundColor

  expect(await fill()).toBe('#00000000')
  await pane.pointer({ type: 'enter', x: 3, y: 0, in: row })
  await pane.pointer({ type: 'move', x: 4, y: 0, in: row })
  expect(await fill()).toBe('#ffffff0f')
  await pane.pointer({ type: 'leave', x: 4, y: 0, in: row })
  expect(await fill()).toBe('#00000000')

  await pane.unmount()
})

import { expect, mock, test } from 'claude-code/testing'
import type { On, SessionContextBreakdown, SessionMessage } from 'claude-code'

import { buildSnapshot, describeCall } from '../hooks/context'
import { deniedTools, editDeny, summarize, toolRows } from '../hooks/tools'
import { formatTokens, squarify } from '../hooks/treemap'

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
      { name: 'Free space', tokens: 100_000, color: 'inactive', isDeferred: false, kind: 'free' },
      {
        name: 'Autocompact buffer',
        tokens: 8_000,
        color: 'inactive',
        isDeferred: false,
        kind: 'buffer',
      },
    ],
    totalTokens: 92_000,
    maxTokens: 200_000,
    rawMaxTokens: 200_000,
    autocompactSource: 'auto',
    percentage: 46,
    gridRows: [],
    model: 'Opus 5.5',
    memoryFiles: [],
    mcpTools: [],
    agents: [],
    skills: {
      totalSkills: 2,
      includedSkills: 2,
      tokens: 4_000,
      skillFrontmatter: [
        { name: 'deploy', source: 'userSettings', tokens: 300 },
        { name: 'review', source: 'plugin', pluginName: 'reviewer', tokens: 120 },
      ],
    },
    isAutoCompactEnabled: true,
    apiUsage: null,
  }
}

// A transcript with one big log dump and one small read.
const MESSAGES: SessionMessage[] = [
  { role: 'user', text: 'run the tests', toolUses: [] },
  {
    role: 'assistant',
    text: 'Running them.',
    toolUses: [
      {
        tool_use_id: 't1',
        tool: 'Bash',
        input: { command: 'npm test -- --verbose' },
        text: 'x'.repeat(100_000),
      },
      {
        tool_use_id: 't2',
        tool: 'Read',
        input: { file_path: '/repo/src/app.ts' },
        text: 'y'.repeat(800),
      },
    ],
  },
]

const DEPLOY = {
  name: 'deploy',
  description: 'Ships the app to production. Runs the checks first.',
  source: 'user',
  isFullscreen: false,
} as const

/** The engine around the plugin: a settings file in memory, the usage and the transcript. */
function engine(on: On, settings: { text: string }) {
  const clock = mock.clock(on, { now: 1_000 })
  mock.store(on)
  mock.env(on, { HOME: '/home/me' })
  on('fs.exists', async () => ({ value: true }))
  on('fs.read', async () => ({ value: settings.text }))
  on('fs.write', async (_$, e) => {
    expect(e.path).toMatch(SETTINGS_PATH)
    settings.text = e.text

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
        ...(e?.breakdown ? { breakdown: breakdown() } : {}),
      },
      rateLimits: [],
    },
  }))
  on('session.messages', async () => ({ value: MESSAGES }))
  on('command.list', async () => ({ value: [DEPLOY] }))
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

test('toolRows scales the tools in the window to the measured total and orders by status', () => {
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
    3_000,
  )
  // In the window first, largest first; then loaded on demand; then removed.
  expect(rows.map(one => [one.name, one.status])).toEqual([
    ['Grep', 'in'],
    ['Bash', 'in'],
    ['Monitor', 'deferred'],
    ['EnterPlanMode', 'removed'],
    ['Write', 'removed'],
  ])
  const inWindow = rows.filter(one => one.status === 'in')
  expect(inWindow.reduce((sum, one) => sum + one.tokens, 0)).toBeGreaterThanOrEqual(2_999)
  expect(rows.find(one => one.name === 'Monitor')?.tokens).toBe(0)
})

test('a tool put back that the session started without waits for a new session', () => {
  const rows = toolRows({}, { ListPlugins: 'Lists plugins.' }, [], ['ListPlugins'], 0)
  expect(rows).toEqual([
    expect.objectContaining({
      name: 'ListPlugins',
      status: 'back-next-session',
      summary: 'Lists plugins.',
    }),
  ])
})

test('the snapshot splits the messages into their largest tool results', () => {
  const snapshot = buildSnapshot(breakdown(), MESSAGES, [DEPLOY])
  expect(snapshot).toMatchObject({ used: 92_000, window: 200_000, percent: 46, toolTokens: 20_000 })
  expect(snapshot.blocks[0]).toMatchObject({ label: 'Bash: npm test -- --verbose', kind: 'result' })
  expect(snapshot.blocks.some(one => one.label.startsWith('Read'))).toBe(false)
  const messages = snapshot.blocks.filter(
    one => one.kind === 'result' || one.kind === 'conversation',
  )
  expect(messages.reduce((sum, one) => sum + one.tokens, 0)).toBe(60_000)
  expect(snapshot.skills).toEqual([
    {
      name: 'deploy',
      tokens: 300,
      source: 'userSettings',
      description: 'Ships the app to production.',
    },
    { name: 'review', tokens: 120, source: 'reviewer', description: '' },
  ])
})

test('describeCall names a call by what it touched', () => {
  expect(describeCall({ tool: 'Read', input: { file_path: 'C:\\repo\\a.ts' } })).toBe('Read: a.ts')
  expect(describeCall({ tool: 'Bash', input: { command: 'ls\nmore' } })).toBe('Bash: ls')
  expect(describeCall({ tool: 'TaskStop', input: {} })).toBe('TaskStop')
})

test('the treemap fills its box and formats sizes', () => {
  const tiles = squarify(
    [
      { label: 'a', kind: 'system', tokens: 600 },
      { label: 'b', kind: 'tools', tokens: 300 },
      { label: 'c', kind: 'memory', tokens: 100 },
    ],
    100,
    50,
  )
  const area = tiles.reduce((sum, one) => sum + one.w * one.h, 0)
  expect(Math.round(area)).toBe(5_000)
  expect(tiles[0]).toMatchObject({ label: 'a', x: 0, y: 0 })
  expect(formatTokens(1_000_000)).toBe('1M')
  expect(formatTokens(41_234)).toBe('41k')
  expect(formatTokens(4_123)).toBe('4.1k')
  expect(formatTokens(412)).toBe('412')
})

test('hovering the meter reveals the context map; the percentage opens the pane', async ($, on) => {
  const clock = engine(on, { text: '{}' })
  let opened: unknown
  on('ui.open', async (_$, e) => {
    opened = e

    return { value: { isPlaced: true } }
  })
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })

  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const card = (await band.findAll({ type: 'Box' })).find(one => one.props.position === 'absolute')
  expect(card?.props).toMatchObject({ position: 'absolute', display: 'none' })
  expect(card?.text).toMatch(/Context 46%/)
  expect(card?.text).toMatch(/Bash: npm test -- --verbose/)

  await band.press({ key: 'open-context' })
  expect(opened).toMatchObject({ id: 'context-map', title: 'Context' })
  // The pane is scrolled to its top once it has drawn.
  await clock.advance(1_000)

  await band.unmount()
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

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await pane.find({ key: 'tool-Bash' }))?.text).toMatch(/Runs a shell command/)
  expect((await pane.find({ key: 'toggle-Bash' }))?.props).toMatchObject({ label: 'Remove' })
  expect((await pane.find({ key: 'toggle-EnterPlanMode' }))?.props).toMatchObject({
    label: 'Put back',
  })
  expect(await pane.find({ type: 'Text', text: 'deploy' })).toBeDefined()

  await pane.press({ key: 'toggle-Bash' })
  expect(JSON.parse(settings.text).permissions.deny).toEqual(['EnterPlanMode', 'Bash'])
  expect(invalidated).toBe(1)
  expect(await $.tool.describe(bash)).toEqual({
    description: 'Executes a command.',
    isDeferred: true,
  })
  expect(await $.tool.call({ tool: 'Bash', tool_use_id: 'u1', command: 'ls' })).toMatchObject({
    deny: expect.stringContaining('Bash was removed'),
  })
  expect((await pane.find({ key: 'toggle-Bash' }))?.props).toMatchObject({ label: 'Put back' })

  await pane.press({ key: 'toggle-Bash' })
  expect(JSON.parse(settings.text).permissions.deny).toEqual(['EnterPlanMode'])
  expect(await $.tool.describe(bash)).toEqual({ description: 'Executes a command.' })

  await pane.unmount()
})

test('the pane keeps its place when the desktop jumps it to the end after a press', async ($, on) => {
  engine(on, { text: '{}' })
  let moved = 0
  on('ui.scroll', async () => {
    moved += 1

    return {}
  })
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.describe({ tool: 'Grep', description: 'Searches.', provider: ENGINE })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const jump = {
    component: 'Pane',
    requestId: 'context-map',
    offset: 300,
    by: 290,
    bodyRows: 40,
    contentRows: 340,
    origin: { kind: 'person' },
  } as const

  await $.ui.scroll(jump)
  expect(moved).toBe(1)
  await pane.press({ key: 'toggle-Grep' })
  await $.ui.scroll(jump)
  expect(moved).toBe(1)
  await $.ui.scroll({ ...jump, by: 3, offset: 13 })
  expect(moved).toBe(2)

  await pane.unmount()
})

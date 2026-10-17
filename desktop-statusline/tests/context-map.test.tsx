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
type SettingsFile = { text: string; isLocked?: boolean; path?: RegExp; writes?: number }

function engine(
  on: On,
  settings: SettingsFile,
  env: Record<string, string> = { HOME: '/home/me' },
) {
  const clock = mock.clock(on, { now: 1_000 })
  mock.store(on)
  mock.env(on, env)
  on('fs.exists', async () => ({ value: true }))
  on('fs.read', async () => ({ value: settings.text }))
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
  expect(rows.find(one => one.name === 'Monitor')?.tokens).toBe(0)
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

test('the snapshot splits the messages into their largest tool results', () => {
  const snapshot = buildSnapshot(breakdown(), MESSAGES, [DEPLOY])
  expect(snapshot).toMatchObject({ used: 92_000, window: 200_000, percent: 46 })
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
      source: 'your settings',
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

  const pressed = band.press({ key: 'open-context' })
  // The press reads the settings and the map before it waits; let the time pass.
  for (let step = 0; step < 10; step += 1) await clock.advance(100)
  await pressed
  // Focused, or the desktop spends the first click in it on the focus.
  expect(opened).toMatchObject({ id: 'context-map', title: 'Context', focus: true })

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
  // The press reads the settings and the map before it waits; let the time pass.
  for (let step = 0; step < 10; step += 1) await clock.advance(100)
  await pressed
  expect(invalidated).toBe(1)
  expect(await $.tool.describe(grep)).toEqual({ description: 'Searches.', isDeferred: true })

  await band.unmount()
})

test('the card says when there is no map yet', async ($, on) => {
  // No session has started, so no breakdown has been read.
  engine(on, { text: '{}' })
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect(
    await band.find({ type: 'Text', text: /The map appears after Claude's first reply/ }),
  ).toBeDefined()

  await band.unmount()
})

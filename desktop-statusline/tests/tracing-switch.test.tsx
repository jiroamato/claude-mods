import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import {
  RECEIVER_HEALTH,
  currentTrace,
  differingNames,
  editTraceEnv,
  isTraceOn,
  replacedNames,
  TRACE_ENV,
} from '../hooks/trace'

const SESSION = 'session-1'

const PANE = {
  plugin: 'desktop-statusline',
  component: 'Pane',
  requestId: 'context-details',
  props: {
    title: 'Context details',
    isFocused: false,
    bodyColumns: 70,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

function switchEngine(
  on: On,
  start: {
    settings: Record<string, unknown>
    store?: Record<string, unknown>
    env?: Record<string, string>
    turns?: number
    files?: Record<string, string>
  },
) {
  const state = { text: JSON.stringify(start.settings), files: start.files ?? {} }
  mock.store(on, start.store)
  mock.env(on, { HOME: '/home/me', ...start.env })
  mock.clock(on, { now: 1_000 })
  const traceFile = (path: string) => /[\\/]traces[\\/][^\\/]+[\\/]([^\\/]+)$/.exec(path)?.[1]
  on('fs.exists', async () => ({ value: true }))
  on('fs.read', async (_$, e) => {
    if (/[\\/]traces[\\/]\.view-token$/.test(e.path)) {
      return { value: '0123456789abcdef0123456789abcdef' }
    }
    const name = traceFile(e.path)
    if (name === undefined) return { value: state.text }
    const text = state.files[name]
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)

    return { value: text }
  })
  on('fs.list', async () => ({
    value: Object.keys(state.files).map(name => ({
      name,
      kind: 'file' as const,
      size: state.files[name]!.length,
      mtimeMs: 1,
      isLink: false,
    })),
  }))
  on('fs.write', async (_$, e) => {
    if (e.path.endsWith('settings.json')) state.text = e.text

    return { value: undefined }
  })
  on('session.id', async () => ({ value: SESSION }))
  on('session.turns', async () => ({ value: start.turns ?? 0 }))
  on('http.fetch', async () => ({
    value: { status: 200, ok: true, headers: {}, text: RECEIVER_HEALTH },
  }))
  on('session.model', async () => ({ value: 'Opus 5.5' }))
  on('session.cwd', async () => ({ value: '/repo' }))
  on('session.usage', async () => ({
    value: { startedAt: 0, context: { window: 200_000, tokens: 1, percent: 0 }, rateLimits: [] },
  }))
  on('command.list', async () => ({ value: [] }))
  on('prompt.compose', async () => ({ sections: [] }))
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
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('ui.panes', async () => ({ value: [] }))

  return state
}

const EDITED = {
  ...TRACE_ENV,
  CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH: '60000',
  OTEL_LOGS_EXPORT_INTERVAL: '2000',
}

test('tracing is on while telemetry goes to the receiver, whatever else was changed by hand', () => {
  expect(isTraceOn({ env: EDITED })).toBe(true)
  expect(differingNames({ env: EDITED })).toEqual([
    'OTEL_LOGS_EXPORT_INTERVAL',
    'CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH',
  ])
  const { OTEL_LOG_RAW_API_BODIES: _, ...without } = TRACE_ENV
  expect(isTraceOn({ env: without })).toBe(true)
  expect(differingNames({ env: without })).toEqual(['OTEL_LOG_RAW_API_BODIES'])
  expect(differingNames({ env: TRACE_ENV })).toEqual([])

  for (const [key, value] of [
    ['CLAUDE_CODE_ENABLE_TELEMETRY', '0'],
    ['OTEL_LOGS_EXPORTER', 'otlp,console'],
    ['OTEL_EXPORTER_OTLP_LOGS_ENDPOINT', 'http://127.0.0.1:43181/v1/logs'],
  ] as const) {
    expect(isTraceOn({ env: { ...TRACE_ENV, [key]: value } })).toBe(false)
  }
})

test('off leaves a value changed by hand as it is, and on sets it back', () => {
  const before = {
    ...Object.fromEntries(Object.keys(TRACE_ENV).map(key => [key, null])),
    OTEL_LOGS_EXPORT_INTERVAL: '5000',
  }
  const off = editTraceEnv(JSON.stringify({ env: { ...EDITED, MINE: '1' } }), false, before)
  expect(JSON.parse(off.text).env).toEqual({
    MINE: '1',
    CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH: '60000',
    OTEL_LOGS_EXPORT_INTERVAL: '2000',
  })
  expect(off.isLost).toBe(false)

  const on = editTraceEnv(JSON.stringify({ env: EDITED }), true, before)
  expect(JSON.parse(on.text).env).toEqual(TRACE_ENV)
  expect(on.before).toMatchObject({
    CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH: '60000',
    OTEL_LOGS_EXPORT_INTERVAL: '2000',
  })
  expect(replacedNames(on.before)).toEqual([
    'OTEL_LOGS_EXPORT_INTERVAL',
    'CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH',
  ])
})

test('a partly edited env reads as on, says what differs, and turns off', async ($, on) => {
  const before = {
    ...Object.fromEntries(Object.keys(TRACE_ENV).map(key => [key, null])),
    OTEL_LOGS_EXPORT_INTERVAL: '5000',
    OTEL_LOGS_EXPORTER: 'console',
  }
  const state = switchEngine(on, {
    settings: { env: { ...EDITED, MINE: '1' } },
    store: { 'trace-env-before': before },
    env: EDITED,
  })
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.pointer({ type: 'down', x: 2, y: 0, button: 'left', in: 'tab-trace' })

  expect((await pane.find({ key: 'tracing' }))?.props).toMatchObject({ label: 'Turn off tracing' })
  expect(
    await pane.find({ type: 'Text', text: /^Tracing is on\. Each request appears here/ }),
  ).toBeDefined()
  const note = await pane.find({ type: 'Text', text: /in your settings are not as tracing sets/ })
  expect(note?.text).toMatch(
    /^ *OTEL_LOGS_EXPORT_INTERVAL +and +CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH +in your settings are not as tracing sets them, so requests may arrive later or be cut short\. Turning tracing off and on again sets them back\.$/,
  )
  const replaced = await pane.find({ type: 'Text', text: /^Tracing set its own values in place/ })
  expect(replaced?.text).toMatch(/your +OTEL_LOGS_EXPORTER +;/)
  expect(replaced?.text).not.toMatch(/OTEL_LOGS_EXPORT_INTERVAL/)

  await pane.press({ key: 'tracing' })
  expect(JSON.parse(state.text).env).toEqual({
    MINE: '1',
    OTEL_LOGS_EXPORTER: 'console',
    CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH: '60000',
    OTEL_LOGS_EXPORT_INTERVAL: '2000',
  })
  expect((await pane.find({ key: 'tracing' }))?.props).toMatchObject({ label: 'Turn on tracing' })
  expect(await pane.find({ type: 'Text', text: /not as tracing sets/ })).toBeUndefined()

  await pane.unmount()
})

test('a session traced from its start whose folder was deleted does not say it started before', async ($, on) => {
  switchEngine(on, { settings: { env: TRACE_ENV }, env: TRACE_ENV, turns: 3 })
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.pointer({ type: 'down', x: 2, y: 0, button: 'left', in: 'tab-trace' })

  expect(await pane.find({ type: 'Text', text: /started before it was/ })).toBeUndefined()
  expect(
    await pane.find({
      type: 'Text',
      text: /^Tracing is on, but none of this session’s requests are in its traces folder: it was deleted, or they were not recorded\./,
    }),
  ).toBeDefined()
  expect((await pane.find({ key: 'tracing' }))?.props).toMatchObject({ label: 'Turn off tracing' })

  await pane.unmount()
})

test('a trace state an earlier version kept is read in this version’s shape', () => {
  const kept = {
    status: 'on',
    items: [{ seq: 0 }],
    prompt: null,
    view: { session: 's', token: 't' },
  }
  expect(currentTrace(kept)).toEqual({
    status: 'on',
    items: [{ seq: 0 }],
    prompt: null,
    view: { session: 's', token: 't' },
    replaced: [],
    differing: [],
  })
  expect(currentTrace(null)).toMatchObject({
    status: 'off',
    items: [],
    replaced: [],
    differing: [],
  })
  expect(currentTrace({ status: 'nonsense', items: 'x', view: {} })).toMatchObject({
    status: 'off',
    items: [],
    view: null,
  })
})

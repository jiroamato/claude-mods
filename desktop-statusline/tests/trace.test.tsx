import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { pageStarts } from '../hooks/panel'
import { editTraceEnv, isTraceOn, sentPrompt, summarize, TRACE_ENV } from '../hooks/trace'
import type { TraceRecord } from '../hooks/trace'
// The receiver's own logic, as Node runs it.
import { logRecords, TraceStore } from '../trace/store.mjs'
import { fullMessages, requestPage, sessionPage } from '../trace/view.mjs'

const SESSION = 'session-1'

function requestBody(messages: unknown[], system = 'You are Claude Code.') {
  return JSON.stringify({
    model: 'claude-opus-5-5',
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: cc_version=1' },
      { type: 'text', text: system },
    ],
    tools: [{ name: 'Bash' }],
    messages,
  })
}

function record(name: string, extra: Record<string, unknown>) {
  return { 'event.name': name, 'session.id': SESSION, 'event.timestamp': 'T12:00:01Z', ...extra }
}

test('the store keeps each request once: what it added, its usage and its answer', () => {
  const files: Record<string, string> = {}
  const store = new TraceStore((name: string, text: string) => {
    files[name] = text
  })
  const first = [{ role: 'user', content: 'hello' }]
  const second = [
    ...first,
    { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    { role: 'user', content: 'list the files' },
  ]
  for (const one of [
    record('api_request_body', {
      body: requestBody(first),
      query_source: 'sdk',
      request_body_id: 'b1',
    }),
    record('api_request', {
      query_source: 'sdk',
      input_tokens: 5,
      output_tokens: 7,
      cost_usd: 0.01,
    }),
    record('api_response_body', {
      request_body_id: 'b1',
      body: JSON.stringify({ content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn' }),
    }),
    record('api_request_body', {
      body: requestBody(second),
      query_source: 'sdk',
      request_body_id: 'b2',
    }),
    // Another plugin's or kind's events are left unread.
    record('tool_result', { tool_name: 'Bash' }),
  ]) {
    store.take(one)
  }

  // The system prompt and the tools once, by hash; one file per request.
  const names = Object.keys(files).sort()
  expect(names.filter(name => name.includes('/system-'))).toHaveLength(1)
  expect(names.filter(name => name.includes('/tools-'))).toHaveLength(1)
  const one = JSON.parse(files[`${SESSION}/000000.json`]!) as TraceRecord
  expect(one).toMatchObject({ seq: 0, source: 'sdk', from: 0, messageCount: 1 })
  expect(one.usage).toMatchObject({ input: 5, output: 7, costUsd: 0.01 })
  expect(one.response).toMatchObject({ stop_reason: 'end_turn' })
  // The second carries only what follows the first.
  const two = JSON.parse(files[`${SESSION}/000001.json`]!) as TraceRecord
  expect(two).toMatchObject({ seq: 1, from: 1, messageCount: 3, usage: null, response: null })
  expect(two.added).toHaveLength(2)
})

test('a restarted store goes on numbering where the session left off', () => {
  const files: Record<string, string> = {}
  const store = new TraceStore(
    (name: string, text: string) => {
      files[name] = text
    },
    () => 12,
  )
  store.take(record('api_request_body', { body: requestBody([]), query_source: 'sdk' }))
  expect(Object.keys(files)).toContain(`${SESSION}/000012.json`)
})

test('an OTLP/JSON payload reads as each record’s attributes', () => {
  const payload = {
    resourceLogs: [
      {
        scopeLogs: [
          {
            logRecords: [
              {
                attributes: [
                  { key: 'event.name', value: { stringValue: 'api_request' } },
                  { key: 'input_tokens', value: { intValue: '12' } },
                  { key: 'cost_usd', value: { doubleValue: 0.5 } },
                ],
              },
            ],
          },
        ],
      },
    ],
  }
  expect(logRecords(payload)).toEqual([
    { 'event.name': 'api_request', input_tokens: 12, cost_usd: 0.5 },
  ])
})

test('tracing’s switch adds its env values and takes back only its own', () => {
  const text =
    '{\n    "env": {\n        "MINE": "1",\n        "OTEL_LOGS_EXPORTER": "console"\n    }\n}\n'
  const on = editTraceEnv(text, true)
  const settings = JSON.parse(on) as { env: Record<string, string> }
  expect(isTraceOn(settings)).toBe(true)
  expect(settings.env.MINE).toBe('1')
  // The file's own indentation stays.
  expect(on).toMatch(/^\{\n {4}"env"/)

  const off = JSON.parse(editTraceEnv(on, false)) as { env: Record<string, string> }
  expect(isTraceOn(off)).toBe(false)
  expect(off.env).toEqual({ MINE: '1' })
  // A value set by hand that is not tracing's stays when tracing is turned off.
  const own = editTraceEnv(
    JSON.stringify({ env: { ...TRACE_ENV, OTEL_LOGS_EXPORTER: 'console' } }),
    false,
  )
  expect(JSON.parse(own).env).toEqual({ OTEL_LOGS_EXPORTER: 'console' })
})

test('the sent prompt reads as the engine’s sections, and what was added around them', () => {
  const sections = [
    { id: 'intro', title: 'Introduction', tokens: 5, text: 'You are an agent.' },
    { id: 'env_info_simple', title: 'Environment', tokens: 5, text: '# Environment\n - linux' },
  ]
  const blocks = [
    { type: 'text', text: 'x-anthropic-billing-header: cc_version=1' },
    { type: 'text', text: 'You are Claude Code, Anthropic’s official CLI.' },
    {
      type: 'text',
      text:
        'You are an agent.\n\n# Environment\n - linux\n\n# Output Style: Concise\nBe brief.\n\n' +
        '# Desktop\nThe app’s own.',
    },
  ]
  expect(sentPrompt(blocks, sections).map(one => [one.title, one.isAdded ?? false])).toEqual([
    ['Billing header', true],
    ['You are Claude Code, Anthropic’s official CLI.', true],
    ['Introduction', false],
    ['Environment', false],
    ['Output Style: Concise', true],
    ['Desktop', true],
  ])
})

test('a request reads in a line: what it added and what came back', () => {
  const item = summarize({
    seq: 3,
    at: '2026-10-19T12:00:00Z',
    source: 'sdk',
    model: 'claude-opus-5-5',
    promptId: 'p1',
    system: 'a',
    tools: 'b',
    toolCount: 1,
    messageCount: 4,
    from: 2,
    added: [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'hi' }] },
      { role: 'user', content: '<system-reminder>\nnote\n</system-reminder>' },
    ],
    usage: null,
    response: {
      content: [
        { type: 'text', text: 'Reading it.' },
        { type: 'tool_use', name: 'Read' },
      ],
      stop_reason: 'tool_use',
    },
  })
  expect(item).toMatchObject({ added: ['tool result', 'reminder'], reply: '"Reading it." · Read' })
})

const PANE = {
  plugin: 'desktop-statusline',
  component: 'Pane',
  requestId: 'context-map',
  props: {
    title: 'Context details',
    isFocused: false,
    bodyColumns: 70,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

/** A traced session's engine: tracing on in the settings and in the session's env. */
function tracedEngine(on: On, files: Record<string, string>, turns = 0) {
  const settings = { text: JSON.stringify({ env: TRACE_ENV }) }
  mock.clock(on, { now: 1_000 })
  mock.store(on)
  mock.env(on, { HOME: '/home/me', OTEL_LOG_RAW_API_BODIES: '1' })
  const traceFile = (path: string) => /[\\/]traces[\\/]session-1[\\/]([^\\/]+)$/.exec(path)?.[1]
  const isToken = (path: string) => /[\\/]traces[\\/]\.view-token$/.test(path)
  on('fs.exists', async () => ({ value: true }))
  on('fs.read', async (_$, e) => {
    if (isToken(e.path)) return { value: '0123456789abcdef0123456789abcdef' }
    const name = traceFile(e.path)

    return { value: name !== undefined ? (files[name] ?? '') : settings.text }
  })
  on('fs.list', async () => ({
    value: Object.keys(files).map(name => ({
      name,
      kind: 'file' as const,
      size: files[name]!.length,
      mtimeMs: 1,
      isLink: false,
    })),
  }))
  on('fs.write', async (_$, e) => {
    settings.text = e.text

    return { value: undefined }
  })
  on('session.id', async () => ({ value: 'session-1' }))
  on('session.turns', async () => ({ value: turns }))
  on('http.fetch', async () => ({
    value: { status: 200, ok: true, headers: {}, text: 'desktop-statusline trace receiver 2' },
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

  return settings
}

test('the Trace tab lists each request, opening onto it, and the Prompt tab shows it as sent', async ($, on) => {
  const files: Record<string, string> = {
    'system-a.json': JSON.stringify([
      { type: 'text', text: 'x-anthropic-billing-header: cc_version=1' },
      { type: 'text', text: '# Output Style: Concise\nBe brief.' },
    ]),
    '000000.json': JSON.stringify({
      seq: 0,
      at: '2026-10-19T12:00:05Z',
      source: 'sdk',
      model: 'claude-opus-5-5',
      promptId: 'p1',
      system: 'a',
      tools: 'b',
      toolCount: 1,
      messageCount: 1,
      from: 0,
      added: [{ role: 'user', content: 'list the files' }],
      usage: { input: 10, output: 5, costUsd: 0.25, durationMs: 1500 },
      response: { content: [{ type: 'text', text: 'Here they are.' }], stop_reason: 'end_turn' },
    } satisfies TraceRecord),
  }
  tracedEngine(on, files)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.resize({ columns: 40, rows: 2, in: 'tabs' })

  await pane.pointer({ type: 'down', x: 35, y: 0, button: 'left', in: 'tabs' })
  expect((await pane.find({ key: 'open-trace-0' }))?.text).toMatch(/^#1 Main 12:00:05/)
  expect(await pane.find({ type: 'Text', text: '+ "list the files"' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '→ "Here they are."' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '10 in · 5 out · $0.25 · 1.5s' })).toBeDefined()
  await pane.press({ key: 'open-trace-0' })
  expect(String((await pane.find({ type: 'Code' }))?.props.source)).toMatch(
    /\[user\]\nlist the files[\s\S]*── Answer \(end_turn\)\n\nHere they are\./,
  )

  await pane.pointer({ type: 'down', x: 15, y: 0, button: 'left', in: 'tabs' })
  expect((await pane.find({ key: 'open-prompt-billing-0' }))?.text).toMatch(/^Billing header added/)
  expect(await pane.find({ type: 'Text', text: 'Output Style: Concise' })).toBeDefined()

  await pane.unmount()
})

test('turning tracing on writes its env to the user settings', async ($, on) => {
  const settings = tracedEngine(on, {})
  settings.text = '{}'
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.resize({ columns: 40, rows: 2, in: 'tabs' })
  await pane.pointer({ type: 'down', x: 35, y: 0, button: 'left', in: 'tabs' })

  expect((await pane.find({ key: 'tracing' }))?.props).toMatchObject({ label: 'Turn on tracing' })
  await pane.press({ key: 'tracing' })
  expect(isTraceOn(JSON.parse(settings.text))).toBe(true)
  expect((await pane.find({ key: 'tracing' }))?.props).toMatchObject({ label: 'Turn off tracing' })

  await pane.unmount()
})

test('a session that started before tracing was on says so', async ($, on) => {
  // Tracing on in the settings and the env, but three turns and no trace.
  tracedEngine(on, {}, 3)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.resize({ columns: 40, rows: 2, in: 'tabs' })
  await pane.pointer({ type: 'down', x: 35, y: 0, button: 'left', in: 'tabs' })

  expect(await pane.find({ type: 'Text', text: /start a new session to trace it/ })).toBeDefined()
  expect((await pane.find({ key: 'tracing' }))?.props).toMatchObject({ label: 'Turn off tracing' })

  await pane.unmount()
})

test('long text is read a page at a time, each page starting on a line', () => {
  const line = `${'x'.repeat(99)}\n`
  const text = line.repeat(1_000)
  const starts = pageStarts(text)
  expect(starts).toHaveLength(3)
  for (const start of starts) expect(start === 0 || text[start - 1] === '\n').toBe(true)
  expect(pageStarts('short')).toEqual([0])
})

test('an open request too long for the pane shows its opening, and opens whole in the browser', async ($, on) => {
  const long = 'line of the request\n'.repeat(5_000)
  const files: Record<string, string> = {
    'system-a.json': JSON.stringify([{ type: 'text', text: 'You are Claude.' }]),
    '000000.json': JSON.stringify({
      seq: 0,
      at: '2026-10-19T12:00:05Z',
      source: 'sdk',
      model: 'claude-opus-5-5',
      promptId: 'p1',
      system: 'a',
      tools: 'b',
      toolCount: 0,
      messageCount: 1,
      from: 0,
      added: [{ role: 'user', content: long }],
      usage: null,
      response: null,
    } satisfies TraceRecord),
  }
  tracedEngine(on, files)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.resize({ columns: 40, rows: 2, in: 'tabs' })
  await pane.pointer({ type: 'down', x: 35, y: 0, button: 'left', in: 'tabs' })

  expect((await pane.find({ type: 'Link' }))?.props).toMatchObject({
    href: 'http://localhost:43180/view/session-1?t=0123456789abcdef0123456789abcdef',
  })
  await pane.press({ key: 'open-trace-0' })
  const links = (await pane.findAll({ type: 'Link' })).map(one => one.props.href)
  expect(links).toContain(
    'http://localhost:43180/view/session-1/0?t=0123456789abcdef0123456789abcdef',
  )
  // No pages in the pane: its opening, and where the rest is.
  expect(await pane.find({ key: 'page-next' })).toBeUndefined()
  expect(String((await pane.find({ type: 'Code' }))?.props.source).length).toBeLessThan(45_000)
  expect(await pane.find({ type: 'Text', text: /the browser shows it whole\.$/ })).toBeDefined()

  await pane.unmount()
})

const VIEW_RECORDS = [
  { seq: 0, source: 'sdk', from: 0, added: [{ role: 'user', content: 'one' }] },
  {
    seq: 1,
    source: 'generate_session_title',
    from: 0,
    added: [{ role: 'user', content: 'title' }],
  },
  {
    seq: 2,
    source: 'sdk',
    from: 1,
    added: [
      { role: 'assistant', content: [{ type: 'text', text: 'two' }] },
      { role: 'user', content: '<b>three</b>' },
    ],
  },
]

test('a request is rebuilt whole from the requests of its kind before it', () => {
  expect(fullMessages(VIEW_RECORDS, 2)).toEqual([
    { role: 'user', content: 'one' },
    { role: 'assistant', content: [{ type: 'text', text: 'two' }] },
    { role: 'user', content: '<b>three</b>' },
  ])
  expect(fullMessages(VIEW_RECORDS, 1)).toEqual([{ role: 'user', content: 'title' }])
  expect(fullMessages(VIEW_RECORDS, 9)).toBeNull()
})

test('the browser pages show every message, escaped, and link to each other', () => {
  const link = (session: string, seq?: number) =>
    `/view/${session}${seq === undefined ? '' : `/${seq}`}?t=x`
  const html = requestPage({
    session: 's',
    records: VIEW_RECORDS.map(one => ({ ...one, at: '', model: 'm', usage: null, response: null })),
    seq: 2,
    system: [{ type: 'text', text: 'You are <Claude>.' }],
    tools: [{ name: 'Bash' }],
    link,
  })!
  expect(html).toContain('&lt;b&gt;three&lt;/b&gt;')
  expect(html).not.toContain('<b>three</b>')
  expect(html).toContain('You are &lt;Claude&gt;.')
  expect(html).toContain('href="/view/s?t=x"')
  // The two new in this request open; the one before stays closed.
  expect(html.match(/<details class="new" open>/g)).toHaveLength(2)
  const index = sessionPage({
    session: 's',
    records: VIEW_RECORDS.map(one => ({ ...one, at: '', usage: null, messageCount: 1 })),
    link,
  })
  expect(index).toContain('href="/view/s/2?t=x"')
})

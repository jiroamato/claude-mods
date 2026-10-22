import { expect, mock, test } from 'claude-code/testing'
import type { Mounted, TestBody } from 'claude-code/testing'
import type { On } from 'claude-code'

import { FOLDER_VARIABLE, SHOW_FOLDER_SCRIPT, encodedCommand } from '../hooks/folder'
import { pageStarts } from '../hooks/panel'
import {
  RECEIVER_HEALTH,
  RECEIVER_NAME,
  editTraceEnv,
  replacedNames,
  findMatches,
  fromHead,
  isTraceOn,
  promptRecord as tracePromptRecord,
  sentPrompt,
  summarize,
  TRACE_ENV,
  wrapRows,
} from '../hooks/trace'
import type { TraceRecord } from '../hooks/trace'
// The receiver's own logic, as Node runs it.
import { HEAD_AFTER_BYTES, HEALTH, logRecords, TraceStore } from '../trace/store.mjs'
import { fullMessages, promptRecord, requestPage, sessionPage } from '../trace/view.mjs'

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
  // The second carries only what follows the first and its answer.
  const two = JSON.parse(files[`${SESSION}/000001.json`]!) as TraceRecord
  expect(two).toMatchObject({ seq: 1, from: 2, messageCount: 3, usage: null, response: null })
  expect(two.added).toEqual([{ role: 'user', content: 'list the files' }])
})

test('usage lands on its own request by the API request id, whichever comes first', () => {
  const files: Record<string, string> = {}
  const store = new TraceStore((name: string, text: string) => {
    files[name] = text
  })
  const kept = (seq: number) =>
    JSON.parse(files[`${SESSION}/${String(seq).padStart(6, '0')}.json`]!) as TraceRecord
  const answer = (bodyId: string, requestId: string) =>
    record('api_response_body', {
      request_body_id: bodyId,
      request_id: requestId,
      body: JSON.stringify({ content: [], stop_reason: 'end_turn' }),
    })
  const usage = (requestId: string, input: number) =>
    record('api_request', { query_source: 'sdk', request_id: requestId, input_tokens: input })
  for (const one of [
    // The first is interrupted: no usage, no answer.
    record('api_request_body', {
      body: requestBody([]),
      query_source: 'sdk',
      request_body_id: 'b1',
    }),
    // The second's answer comes before its usage, the third's after.
    record('api_request_body', {
      body: requestBody([]),
      query_source: 'sdk',
      request_body_id: 'b2',
    }),
    answer('b2', 'req_2'),
    usage('req_2', 20),
    record('api_request_body', {
      body: requestBody([]),
      query_source: 'sdk',
      request_body_id: 'b3',
    }),
    usage('req_3', 30),
    answer('b3', 'req_3'),
  ]) {
    store.take(one)
  }

  expect(kept(0).usage).toBeNull()
  expect(kept(1).usage).toMatchObject({ input: 20 })
  expect(kept(2).usage).toMatchObject({ input: 30 })
})

test('a body cut short is kept as a request that could not be read', () => {
  const files: Record<string, string> = {}
  const store = new TraceStore((name: string, text: string) => {
    files[name] = text
  })
  const body = '{"model":"claude-opus-5-5","messages":[{"role":"user","content":"a lo'
  store.take(record('api_request_body', { body, query_source: 'sdk', request_body_id: 'b1' }))
  const kept = JSON.parse(files[`${SESSION}/000000.json`]!) as TraceRecord
  expect(kept).toMatchObject({ seq: 0, source: 'sdk', unreadable: body.length, added: [] })
  expect(summarize(kept).added).toEqual(['body too large to record'])
})

test('a prompt or tool list deleted from the folder is written again when next sent', () => {
  const files: Record<string, string> = {}
  const store = new TraceStore(
    (name: string, text: string) => {
      files[name] = text
    },
    () => 0,
    (name: string) => name in files,
  )
  store.take(record('api_request_body', { body: requestBody([]), query_source: 'sdk' }))
  for (const name of Object.keys(files)) delete files[name]
  store.take(record('api_request_body', { body: requestBody([]), query_source: 'sdk' }))

  expect(Object.keys(files).filter(name => /\/(system|tools)-/.test(name))).toHaveLength(2)
})

test('the receiver and the plugin agree on the receiver’s health text', () => {
  expect(RECEIVER_HEALTH).toBe(HEALTH)
  expect(HEALTH.startsWith(RECEIVER_NAME)).toBe(true)
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

test('tracing’s switch adds its env values, and off gives back the person’s own', () => {
  const text =
    '{\n    "env": {\n        "MINE": "1",\n        "OTEL_LOGS_EXPORTER": "console"\n    }\n}\n'
  const on = editTraceEnv(text, true)
  const settings = JSON.parse(on.text) as { env: Record<string, string> }
  expect(isTraceOn(settings)).toBe(true)
  expect(settings.env.MINE).toBe('1')
  // The file's own indentation stays.
  expect(on.text).toMatch(/^\{\n {4}"env"/)
  // Every name is noted, null where the person had nothing.
  expect(on.before).toEqual({
    ...Object.fromEntries(Object.keys(TRACE_ENV).map(key => [key, null])),
    OTEL_LOGS_EXPORTER: 'console',
  })
  expect(replacedNames(on.before)).toEqual(['OTEL_LOGS_EXPORTER'])

  const off = editTraceEnv(on.text, false, on.before!)
  const offSettings = JSON.parse(off.text) as { env: Record<string, string> }
  expect(isTraceOn(offSettings)).toBe(false)
  expect(offSettings.env).toEqual({ MINE: '1', OTEL_LOGS_EXPORTER: 'console' })
  expect(off).toMatchObject({ before: null, isLost: false })

  // A value the person changed while tracing was on is theirs, and stays.
  const changed = editTraceEnv(
    JSON.stringify({ env: { ...TRACE_ENV, OTEL_LOGS_EXPORTER: 'none' } }),
    false,
    on.before!,
  )
  expect(JSON.parse(changed.text).env).toEqual({ OTEL_LOGS_EXPORTER: 'none' })
})

test('a value of the person’s equal to tracing’s is noted, and stays when tracing goes off', () => {
  const text = JSON.stringify({ env: { CLAUDE_CODE_ENABLE_TELEMETRY: '1' } })
  const on = editTraceEnv(text, true)
  expect(on.before?.CLAUDE_CODE_ENABLE_TELEMETRY).toBe('1')
  // Not a replacement: the Trace tab does not list it.
  expect(replacedNames(on.before)).toEqual([])

  const off = editTraceEnv(on.text, false, on.before!)
  expect(JSON.parse(off.text).env).toEqual({ CLAUDE_CODE_ENABLE_TELEMETRY: '1' })
})

test('turning tracing on again keeps what it noted the first time', () => {
  const on = editTraceEnv(JSON.stringify({ env: { OTEL_LOGS_EXPORTER: 'console' } }), true)
  // Pressed again while on: nothing changes, and what was noted stays.
  const again = editTraceEnv(on.text, true, on.before!)
  expect(again.text).toBe(on.text)
  expect(again.before).toEqual(on.before)

  // Turned on again after a hand edit took one value out: tracing's values
  // still in place keep what was noted, the edited one is noted afresh.
  const edited = JSON.stringify({
    env: { ...JSON.parse(on.text).env, OTEL_LOG_RAW_API_BODIES: '0' },
  })
  const reOn = editTraceEnv(edited, true, on.before!)
  expect(reOn.before).toMatchObject({ OTEL_LOGS_EXPORTER: 'console', OTEL_LOG_RAW_API_BODIES: '0' })
  const off = editTraceEnv(reOn.text, false, reOn.before!)
  expect(JSON.parse(off.text).env).toEqual({
    OTEL_LOGS_EXPORTER: 'console',
    OTEL_LOG_RAW_API_BODIES: '0',
  })
})

test('off with nothing noted takes tracing’s values out, and says yours were not found', () => {
  const lost = editTraceEnv(JSON.stringify({ env: { ...TRACE_ENV, MINE: '1' } }), false)
  expect(JSON.parse(lost.text).env).toEqual({ MINE: '1' })
  expect(lost.isLost).toBe(true)

  // Nothing of tracing's left to take out: nothing was lost.
  expect(editTraceEnv(JSON.stringify({ env: { MINE: '1' } }), false).isLost).toBe(false)
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
function tracedEngine(
  on: On,
  files: Record<string, string>,
  turns = 0,
  env: Record<string, string> = {},
) {
  const settings = {
    text: JSON.stringify({ env: TRACE_ENV }),
    written: [] as string[],
    /** Paths `fs.exists` denies, as the engine resolves them; every other one exists. */
    missing: [] as RegExp[],
    /** Every command run, and what `uname -s` answers. */
    ran: [] as string[][],
    /** The variables each command was given. */
    env: [] as Record<string, string>[],
    system: 'Linux',
    /** Programs that are not installed: running one rejects. */
    absent: [] as string[],
    /** Whether the Explorer script says it could not show the folder. */
    explorerFails: false,
    /** The session's id: a `/clear` goes on under a new one. */
    session: SESSION,
    /** Each session's trace folder, its files by name. */
    folders: { [SESSION]: files } as Record<string, Record<string, string>>,
    /** Sizes the folder's listing gives instead of a file's own. */
    sizes: {} as Record<string, number>,
    /** What the receiver's health answers, and how often it was asked to leave. */
    health: RECEIVER_HEALTH,
    quits: 0,
    clock: mock.clock(on, { now: 1_000 }),
  }
  mock.store(on)
  mock.env(on, { HOME: '/home/me', OTEL_LOG_RAW_API_BODIES: '1', ...env })
  const traceFile = (path: string) => /[\\/]traces[\\/]([^\\/]+)[\\/]([^\\/]+)$/.exec(path)
  const isToken = (path: string) => /[\\/]traces[\\/]\.view-token$/.test(path)
  on('fs.exists', async (_$, e) => ({ value: !settings.missing.some(one => one.test(e.path)) }))
  on('fs.read', async (_$, e) => {
    if (isToken(e.path)) return { value: '0123456789abcdef0123456789abcdef' }
    const found = traceFile(e.path)
    if (!found) return { value: settings.text }
    const text = settings.folders[found[1]!]?.[found[2]!]
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)

    return { value: text }
  })
  on('fs.list', async (_$, e) => {
    const folder =
      settings.folders[/[\\/]traces[\\/]([^\\/]+)$/.exec(e.path ?? '')?.[1] ?? ''] ?? {}

    return {
      value: Object.keys(folder).map(name => ({
        name,
        kind: 'file' as const,
        size: settings.sizes[name] ?? folder[name]!.length,
        // A file grows only by being written again, which changes its time.
        mtimeMs: settings.sizes[name] ?? 1,
        isLink: false,
      })),
    }
  })
  on('fs.write', async (_$, e) => {
    if (e.path.endsWith('settings.json')) settings.text = e.text
    settings.written.push(e.path)

    return { value: undefined }
  })
  on('session.id', async () => ({ value: settings.session }))
  on('session.turns', async () => ({ value: turns }))
  on('http.fetch', async (_$, e) => {
    if (e.url.includes('/quit')) settings.quits += 1

    return { value: { status: 200, ok: true, headers: {}, text: settings.health } }
  })
  on('session.model', async () => ({ value: 'Opus 5.5' }))
  on('session.cwd', async () => ({ value: '/repo' }))
  on('session.usage', async () => ({
    value: { startedAt: 0, context: { window: 200_000, tokens: 1, percent: 0 }, rateLimits: [] },
  }))
  on('command.list', async () => ({ value: [] }))
  on('prompt.compose', async () => ({ sections: [] }))
  on('process.run', async (_$, e) => {
    const program = e.argv[0]!
    settings.ran.push([...e.argv])
    settings.env.push({ ...e.init?.env })
    if (settings.absent.includes(program)) throw new Error(`spawn ${program} ENOENT`)
    const stdout: Record<string, string> = {
      uname: `${settings.system}\n`,
      ...(settings.explorerFails && {
        'powershell.exe': 'FOLDER-NOT-SHOWN: Explorer did not open C:\\x\\traces.\r\n',
      }),
      wslpath: '\\\\wsl.localhost\\Ubuntu\\home\\me\\.claude\\desktop-statusline\\traces\n',
    }

    return {
      value: {
        exitCode:
          program === 'xdg-open' ||
          program === 'git' ||
          (program === 'powershell.exe' && settings.explorerFails)
            ? 1
            : 0,
        stdout: stdout[program] ?? '',
        stderr: program === 'xdg-open' ? 'no method available for opening' : '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('config.list', async () => ({ value: [] }))
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('ui.open', async () => ({ value: { isPlaced: true } }))

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

  await pane.pointer({ type: 'down', x: 2, y: 0, button: 'left', in: 'tab-trace' })
  // A card of the main loop's requests, as the Tools and Skills tabs group theirs.
  expect(
    await pane.find({ key: 'trace-main', text: /^Conversation1 request · \$0\.25/ }),
  ).toBeDefined()
  expect(await pane.find({ key: 'trace-side' })).toBeUndefined()
  expect((await pane.find({ type: 'Client', key: 'disclose-trace-0' }))?.props.props).toMatchObject(
    {
      label: '#1',
      tag: '12:00:05',
      isOpen: false,
    },
  )
  // What it added and what came back, in the row's own region, so they light with it.
  const row = await pane.find({ type: 'Client', key: 'disclose-trace-0' })
  expect(row?.props.props).toMatchObject({ lines: ['+ "list the files"', '→ "Here they are."'] })
  expect(Math.abs(Number(row?.props.height) - 4.05)).toBeLessThan(1e-9)
  expect((await pane.find({ type: 'Client', key: 'disclose-trace-0' }))?.props.props).toMatchObject(
    {
      figure: '10 in · 5 out · $0.25 · 1.5s',
    },
  )
  await pane.pointer({ type: 'down', x: 5, y: 0, button: 'left', in: 'disclose-trace-0' })
  expect(String((await pane.find({ type: 'Code' }))?.props.source)).toMatch(
    /\[user\]\nlist the files[\s\S]*── Answer \(end_turn\)\n\nHere they are\./,
  )

  await pane.pointer({ type: 'down', x: 2, y: 0, button: 'left', in: 'tab-prompt' })
  // What came from outside Claude Code's own prompt is a card of its own.
  const added = await pane.find({ key: 'prompt-added' })
  expect(added?.text).toMatch(/^Added at send time\d+ sections · ~\d+/)
  expect(
    (await pane.find({ type: 'Client', key: 'disclose-prompt-billing-0' }))?.props.props,
  ).toMatchObject({ label: 'Billing header' })
  const sections = (await pane.findAll({ type: 'Client' }))
    .filter(one => String(one.props.key).startsWith('disclose-prompt-'))
    .map(one => (one.props.props as { label: string }).label)
  expect(sections).toContain('Output Style: Concise')

  await pane.unmount()
})

test('turning tracing on writes its env to the user settings', async ($, on) => {
  const settings = tracedEngine(on, {})
  settings.text = '{}'
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.pointer({ type: 'down', x: 2, y: 0, button: 'left', in: 'tab-trace' })

  expect((await pane.find({ key: 'tracing' }))?.props).toMatchObject({ label: 'Turn on tracing' })
  await pane.press({ key: 'tracing' })
  expect(isTraceOn(JSON.parse(settings.text))).toBe(true)
  expect((await pane.find({ key: 'tracing' }))?.props).toMatchObject({ label: 'Turn off tracing' })

  await pane.unmount()
})

test('the Trace tab says what turning tracing on changes, and where the traces are kept', async ($, on) => {
  const settings = tracedEngine(on, {})
  settings.text = '{}'
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.pointer({ type: 'down', x: 2, y: 0, button: 'left', in: 'tab-trace' })

  expect(
    await pane.find({ type: 'Text', text: /seven telemetry settings to the\s+env\s+block of/ }),
  ).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '/home/me/.claude/settings.json' })).toBeDefined()
  expect(
    await pane.find({ type: 'Text', text: '/home/me/.claude/desktop-statusline/traces' }),
  ).toBeDefined()

  // On, the list says where its traces are kept.
  await pane.press({ key: 'tracing' })
  expect(
    await pane.find({
      type: 'Text',
      text: /^Kept in .* until you delete them, one folder per session\.$/,
    }),
  ).toBeDefined()

  await pane.unmount()
})

test('traces are kept under the home folder, wherever CLAUDE_CONFIG_DIR puts the settings', async ($, on) => {
  const settings = tracedEngine(on, {}, 0, { CLAUDE_CONFIG_DIR: '/cfg' })
  settings.text = '{}'
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.pointer({ type: 'down', x: 2, y: 0, button: 'left', in: 'tab-trace' })

  expect(await pane.find({ type: 'Text', text: '/cfg/settings.json' })).toBeDefined()
  expect(
    await pane.find({ type: 'Text', text: '/home/me/.claude/desktop-statusline/traces' }),
  ).toBeDefined()
  await pane.press({ key: 'tracing' })
  expect(settings.written).toHaveLength(1)
  expect(settings.written[0]).toMatch(/[\\/]cfg[\\/]settings\.json$/)

  await pane.unmount()
})

test('a session makes the traces folder when it is missing, tracing on or off', async ($, on) => {
  const settings = tracedEngine(on, {})
  settings.text = '{}'
  settings.missing = [/[\\/]\.claude[\\/]desktop-statusline[\\/]traces$/]
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect(settings.written).toHaveLength(1)
  expect(settings.written[0]).toMatch(
    /[\\/]home[\\/]me[\\/]\.claude[\\/]desktop-statusline[\\/]traces[\\/]README\.txt$/,
  )

  await pane.unmount()
})

test('a session leaves a traces folder that is there as it is', async ($, on) => {
  const settings = tracedEngine(on, {})
  settings.text = '{}'
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect(settings.written).toEqual([])

  await pane.unmount()
})

test('the traces folder opens in the system’s file manager', async ($, on) => {
  const settings = tracedEngine(on, {}, 0, { OS: 'Windows_NT' })
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.pointer({ type: 'down', x: 2, y: 0, button: 'left', in: 'tab-trace' })
  const opened = () => settings.ran.filter(argv => argv[0] !== 'git')

  // Windows: the script that opens Explorer shown and in front, encoded as
  // PowerShell takes it, the folder as Windows writes it beside it.
  await pane.press({ key: 'trace-folder' })
  expect(opened()).toEqual([
    [
      'powershell.exe',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      encodedCommand(SHOW_FOLDER_SCRIPT),
    ],
  ])
  const folder = settings.env.at(-1)![FOLDER_VARIABLE]
  expect(folder).toMatch(/\\traces$/)
  expect(folder).not.toContain('/')
  expect(await pane.find({ type: 'Text', text: /^Could not open/ })).toBeUndefined()

  // A folder that does not show says why, in words: the script's own line.
  settings.explorerFails = true
  await pane.press({ key: 'trace-folder' })
  expect(
    await pane.find({
      type: 'Text',
      text: 'Could not open the traces folder: Explorer did not open C:\\x\\traces.',
    }),
  ).toBeDefined()

  await pane.unmount()
})

test('a script is encoded as PowerShell takes it, UTF-16LE in base64', () => {
  expect(encodedCommand('dir')).toBe('ZABpAHIA')
  expect(encodedCommand('é!')).toBe('6QAhAA==')
  expect(encodedCommand('ab')).toBe('YQBiAA==')
  // The script reads the folder from its variable, never from its own text.
  expect(SHOW_FOLDER_SCRIPT).toContain(`$env:${FOLDER_VARIABLE}`)
  // Explorer starts through the shell, the folder its one argument: no command
  // line (cmd's `&`, `%VAR%`) ever parses the path.
  expect(SHOW_FOLDER_SCRIPT).toContain("ProcessStartInfo 'explorer.exe'")
  expect(SHOW_FOLDER_SCRIPT).not.toContain('cmd.exe')
})

test('the traces folder opens in Finder on macOS and through xdg-open elsewhere', async ($, on) => {
  const settings = tracedEngine(on, {})
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.pointer({ type: 'down', x: 2, y: 0, button: 'left', in: 'tab-trace' })
  const opened = () => settings.ran.filter(argv => argv[0] !== 'git' && argv[0] !== 'uname')

  settings.system = 'Darwin'
  await pane.press({ key: 'trace-folder' })
  expect(opened()).toEqual([['open', expect.stringMatching(/traces$/)]])

  // A file manager that fails says why.
  settings.system = 'Linux 6.8.0-45-generic'
  await pane.press({ key: 'trace-folder' })
  expect(opened()[1]).toEqual(['xdg-open', expect.stringMatching(/traces$/)])
  expect(
    await pane.find({
      type: 'Text',
      text: 'Could not open the traces folder: no method available for opening',
    }),
  ).toBeDefined()

  // So does a desktop with no opener at all.
  settings.absent = ['xdg-open']
  await pane.press({ key: 'trace-folder' })
  expect(
    await pane.find({
      type: 'Text',
      text: /^Could not open the traces folder: xdg-open could not be run \(.+\)\. Is it installed\?$/,
    }),
  ).toBeDefined()

  await pane.unmount()
})

test('under WSL the traces folder opens in Windows Explorer, as Windows reaches it', async ($, on) => {
  const settings = tracedEngine(on, {}, 0, { WSLENV: 'USERPROFILE/p' })
  settings.system = 'Linux 6.6.87.2-microsoft-standard-WSL2'
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.pointer({ type: 'down', x: 2, y: 0, button: 'left', in: 'tab-trace' })
  const opened = () => settings.ran.filter(argv => argv[0] !== 'git' && argv[0] !== 'uname')
  const script = [
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    encodedCommand(SHOW_FOLDER_SCRIPT),
  ]

  await pane.press({ key: 'trace-folder' })
  expect(opened()).toEqual([
    ['wslpath', '-w', expect.stringMatching(/\/home\/me\/\.claude\/desktop-statusline\/traces$/)],
    ['powershell.exe', ...script],
  ])
  // The folder crosses to Windows only as WSLENV names it, beside what it named before.
  expect(settings.env.at(-1)).toEqual({
    [FOLDER_VARIABLE]: '\\\\wsl.localhost\\Ubuntu\\home\\me\\.claude\\desktop-statusline\\traces',
    WSLENV: `USERPROFILE/p:${FOLDER_VARIABLE}`,
  })
  expect(await pane.find({ type: 'Text', text: /^Could not open/ })).toBeUndefined()

  // With Windows left out of the PATH, PowerShell is found where WSL mounts it.
  settings.absent = ['powershell.exe']
  await pane.press({ key: 'trace-folder' })
  expect(opened().slice(-2)).toEqual([
    ['powershell.exe', ...script],
    ['/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', ...script],
  ])
  expect(await pane.find({ type: 'Text', text: /^Could not open/ })).toBeUndefined()

  await pane.unmount()
})

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

/** One request as the receiver keeps it, saying `text`. */
function kept(seq: number, text: string): string {
  return JSON.stringify({
    seq,
    at: '2026-10-19T12:00:05Z',
    source: 'sdk',
    model: 'claude-opus-5-5',
    promptId: 'p1',
    system: 'a',
    tools: 'b',
    toolCount: 1,
    messageCount: 1,
    from: 0,
    added: [{ role: 'user', content: text }],
    usage: null,
    response: null,
  } satisfies TraceRecord)
}

/** Opens the pane from the band, as a person does, which reads the trace afresh. */
async function reopen($: Parameters<TestBody>[0], settings: ReturnType<typeof tracedEngine>) {
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const pressed = band.press({ key: 'open-context' })
  for (let step = 0; step < 10; step += 1) await settings.clock.advance(100)
  await pressed
  await band.unmount()
}

/** The Trace tab's rows, by label. */
async function traceRows(pane: {
  findAll: (query: { type: 'Client' }) => Promise<{ props: Record<string, unknown> }[]>
}) {
  return (await pane.findAll({ type: 'Client' }))
    .filter(one => String(one.props.key).startsWith('disclose-trace-'))
    .map(one => (one.props.props as { label: string }).label)
}

test('after a /clear the Trace tab lists the new session’s requests alone', async ($, on) => {
  const settings = tracedEngine(on, {
    'system-a.json': '[]',
    '000000.json': kept(0, 'one'),
    '000001.json': kept(1, 'two'),
  })
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.pointer({ type: 'down', x: 2, y: 0, button: 'left', in: 'tab-trace' })
  expect(await traceRows(pane)).toEqual(['#2', '#1'])

  // A /clear goes on in the same process, under a new session id.
  settings.session = 'session-2'
  settings.folders['session-2'] = { 'system-a.json': '[]', '000000.json': kept(0, 'fresh') }
  await reopen($, settings)
  await pane.pointer({ type: 'down', x: 2, y: 0, button: 'left', in: 'tab-trace' })
  expect(await traceRows(pane)).toEqual(['#1'])
  expect(await pane.find({ type: 'Text', text: '+ "fresh"' })).toBeUndefined()
  const row = await pane.find({ type: 'Client', key: 'disclose-trace-0' })
  expect((row?.props.props as { lines: string[] }).lines[0]).toBe('+ "fresh"')

  await pane.unmount()
})

test('a request deleted from the folder leaves the list, and one too large to read is listed', async ($, on) => {
  const files = {
    'system-a.json': '[]',
    '000000.json': kept(0, 'one'),
    '000001.json': kept(1, 'two'),
  }
  const settings = tracedEngine(on, files)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })

  delete (files as Record<string, string>)['000000.json']
  settings.sizes['000001.json'] = 5 * 1024 * 1024
  await reopen($, settings)
  await pane.pointer({ type: 'down', x: 2, y: 0, button: 'left', in: 'tab-trace' })
  expect(await traceRows(pane)).toEqual(['#2 unknown'])
  const row = await pane.find({ type: 'Client', key: 'disclose-trace-1' })
  expect((row?.props.props as { lines: string[] }).lines[0]).toBe(
    '+ too large to read here: open it in your browser',
  )

  await pane.unmount()
})

test('a newer receiver is left to serve, and a port another server holds says so', async ($, on) => {
  const settings = tracedEngine(on, {})
  settings.health = 'desktop-statusline trace receiver 999'
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.pointer({ type: 'down', x: 2, y: 0, button: 'left', in: 'tab-trace' })
  expect(settings.quits).toBe(0)
  expect(
    await pane.find({ type: 'Text', text: /^Tracing is on\. Each request appears here/ }),
  ).toBeDefined()

  settings.health = 'Welcome to nginx!'
  await reopen($, settings)
  await pane.pointer({ type: 'down', x: 2, y: 0, button: 'left', in: 'tab-trace' })
  expect(settings.quits).toBe(0)
  expect(await pane.find({ type: 'Text', text: /no receiver answers on port 43180/ })).toBeDefined()

  await pane.unmount()
})

test('telemetry sent to an endpoint set elsewhere is said, not shown as recorded', async ($, on) => {
  tracedEngine(on, {}, 0, { OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'https://collector.example/v1/logs' })
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.pointer({ type: 'down', x: 2, y: 0, button: 'left', in: 'tab-trace' })

  expect(
    await pane.find({ type: 'Text', text: /sends its telemetry to an endpoint set elsewhere/ }),
  ).toBeDefined()
  expect((await pane.find({ type: 'Button', key: 'tracing' }))?.props).toMatchObject({
    label: 'Turn off tracing',
  })

  await pane.unmount()
})

test('turning tracing off gives back the telemetry values it replaced', async ($, on) => {
  const settings = tracedEngine(on, {})
  const mine = { OTEL_LOGS_EXPORTER: 'console', CLAUDE_CODE_ENABLE_TELEMETRY: '1', MINE: '1' }
  settings.text = JSON.stringify({ env: mine })
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.pointer({ type: 'down', x: 2, y: 0, button: 'left', in: 'tab-trace' })

  await pane.press({ key: 'tracing' })
  expect(JSON.parse(settings.text).env.OTEL_LOGS_EXPORTER).toBe('otlp')
  // The tab says whose place tracing holds, the same value not counted.
  const note = await pane.find({ type: 'Text', text: /^Tracing set its own values in place/ })
  expect(note?.text).toMatch(/your +OTEL_LOGS_EXPORTER +; turning it off puts yours back/)
  expect(note?.text).not.toMatch(/CLAUDE_CODE_ENABLE_TELEMETRY/)
  expect(note?.text).toMatch(/your log events come here, not to where you had them go\.$/)

  await pane.press({ key: 'tracing' })
  expect(JSON.parse(settings.text).env).toEqual(mine)
  expect(await pane.find({ type: 'Text', text: /was not found/ })).toBeUndefined()

  await pane.unmount()
})

test('turning tracing off with nothing noted says your own values were not put back', async ($, on) => {
  // Tracing on in the settings, and an empty store: what on noted is gone.
  const settings = tracedEngine(on, {})
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.pointer({ type: 'down', x: 2, y: 0, button: 'left', in: 'tab-trace' })

  await pane.press({ key: 'tracing' })
  expect(JSON.parse(settings.text).env).toEqual({})
  expect(
    await pane.find({ type: 'Text', text: /^Tracing is off, but what you had under its settings/ }),
  ).toBeDefined()

  await pane.unmount()
})

test('under WSL the traces are kept in the Linux home, not the Windows profile', async ($, on) => {
  const settings = tracedEngine(on, {}, 0, { USERPROFILE: '/mnt/c/Users/me' })
  settings.text = '{}'
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.pointer({ type: 'down', x: 2, y: 0, button: 'left', in: 'tab-trace' })

  expect(
    await pane.find({ type: 'Text', text: '/home/me/.claude/desktop-statusline/traces' }),
  ).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '/home/me/.claude/settings.json' })).toBeDefined()

  await pane.unmount()
})

test('a session that started before tracing was on says so', async ($, on) => {
  // Tracing on in the settings and the env, but three turns and no trace.
  tracedEngine(on, {}, 3)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.pointer({ type: 'down', x: 2, y: 0, button: 'left', in: 'tab-trace' })

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

test('an open request shows a short preview, and opens whole here or in the browser', async ($, on) => {
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
  await pane.pointer({ type: 'down', x: 2, y: 0, button: 'left', in: 'tab-trace' })

  expect((await pane.find({ type: 'Link' }))?.props).toMatchObject({
    href: 'http://localhost:43180/view/session-1?t=0123456789abcdef0123456789abcdef',
  })
  await pane.pointer({ type: 'down', x: 5, y: 0, button: 'left', in: 'disclose-trace-0' })
  const links = (await pane.findAll({ type: 'Link' })).map(one => one.props.href)
  expect(links).toContain(
    'http://localhost:43180/view/session-1/0?t=0123456789abcdef0123456789abcdef',
  )
  // No pages in the pane: its opening, and where the rest is.
  expect(await pane.find({ key: 'page-next' })).toBeUndefined()
  // A dozen lines: Expand shows the rest.
  const preview = String((await pane.find({ type: 'Code' }))?.props.source)
  expect(preview.split('\n')).toHaveLength(12)
  expect(await pane.find({ type: 'Text', text: /^4,9\d\d more lines$/ })).toBeDefined()
  expect((await pane.find({ key: 'read-0' }))?.props).toMatchObject({ label: 'Expand' })

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

test('a request page draws whatever shape a record holds, escaped, without throwing', () => {
  const odd = {
    seq: 0,
    at: '',
    source: 'sdk',
    model: 'm',
    promptId: null,
    system: 'a',
    tools: 'b',
    toolCount: 0,
    messageCount: 4,
    from: 0,
    added: [
      { role: 'user', content: { a: '<i>1</i>' } },
      { role: 'user', content: [null, 7, { type: 'text', text: 42 }] },
      null,
      { role: 'assistant', content: [{ type: 'tool_use', name: { x: 1 }, input: null }] },
    ],
    usage: null,
    response: { content: { not: 'a list' }, stop_reason: null },
  }
  const html = requestPage({
    session: 's',
    records: [odd as unknown as TraceRecord],
    seq: 0,
    system: { not: 'a list' } as unknown as { type: string; text: string }[],
    tools: [null, 'x'] as unknown as { name?: string }[],
    link: () => '#',
  })!
  expect(html).toContain('&lt;i&gt;1&lt;/i&gt;')
  expect(html).not.toContain('<i>1</i>')
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
  // The two new in this request open, the first of them the anchor the page's
  // nav jumps to; the one before stays closed.
  expect(html.match(/<details class="row new" open/g)).toHaveLength(2)
  expect(html).toContain(
    '<details class="row"><summary><span class="chev"></span><span class="label"><span class="seq">#1</span>',
  )
  expect(html).toContain('<details class="row new" open id="new">')
  // No script without a nonce; with one, only that nonce's script.
  expect(html).not.toContain('<script')
  expect(
    requestPage({
      session: 's',
      records: VIEW_RECORDS.map(one => ({
        ...one,
        at: '',
        model: 'm',
        usage: null,
        response: null,
      })),
      seq: 2,
      system: null,
      tools: null,
      link,
      nonce: 'abc',
    }),
  ).toContain('<script nonce="abc">')
  const index = sessionPage({
    session: 's',
    records: VIEW_RECORDS.map(one => ({ ...one, at: '', usage: null, messageCount: 1 })),
    link,
  })
  expect(index).toContain('href="/view/s/2?t=x"')
})

test('wrapped rows are each one line, cut at a space where one fits', () => {
  expect(wrapRows('aaaa bbbb cccc\n\nshort', 10)).toEqual(['aaaa bbbb ', 'cccc', '', 'short'])
  expect(wrapRows('x'.repeat(25), 10)).toEqual(['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)])
})

/** A request of `lines` numbered lines, as the reader tests read it. */
function longRequest(lines: number): Record<string, string> {
  const long = Array.from({ length: lines }, (_, index) => `line ${index}`).join('\n')

  return {
    'system-a.json': JSON.stringify([{ type: 'text', text: 'You are Claude.' }]),
    'tools-b.json': JSON.stringify([{ name: 'Bash' }]),
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
      added: [{ role: 'user', content: long }],
      usage: null,
      response: null,
    } satisfies TraceRecord),
  }
}

type ReaderPane = Pick<Mounted<'desktop', 'Pane'>, 'find' | 'findAll'>

/** The reader's text rows as its region draws them, top to bottom. */
async function readerText(pane: ReaderPane): Promise<string[]> {
  return (await pane.findAll({ type: 'Text', in: 'reader-text' }))
    .filter(one => one.props.mono === true)
    .map(one => one.text)
}

/** The row of the reader's text holding the current match, as its region draws it. */
async function readerHit(pane: ReaderPane): Promise<string | undefined> {
  const rows = (await pane.findAll({ type: 'Text', in: 'reader-text' })).filter(
    one => one.props.mono === true,
  )

  return rows.find(row =>
    row.children.some(
      child =>
        typeof child === 'object' &&
        child !== null &&
        (child as { props?: { backgroundColor?: string } }).props?.backgroundColor === '#c98500',
    ),
  )?.text
}

/** Where the reader says its rows are: the first and last in view, and how many in all. */
async function readerPosition(pane: ReaderPane) {
  const text = (await pane.find({ type: 'Text', text: /^rows / }))?.text ?? ''
  const match = /^rows ([\d,]+) to ([\d,]+) of ([\d,]+)$/.exec(text)
  const figure = (part: string | undefined) => Number(part?.replace(/,/g, ''))

  return { first: figure(match?.[1]), last: figure(match?.[2]), total: figure(match?.[3]) }
}

test('the reader keeps its top and draws only the rows that fit under it', async ($, on) => {
  tracedEngine(on, longRequest(20_000))
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.pointer({ type: 'down', x: 2, y: 0, button: 'left', in: 'tab-trace' })
  await pane.pointer({ type: 'down', x: 5, y: 0, button: 'left', in: 'disclose-trace-0' })
  await pane.press({ key: 'read-0' })

  // The way back and the search, then the window's 40 rows less the top's 4.
  expect((await pane.find({ type: 'Client', key: 'reader' }))?.props).toMatchObject({ height: 1 })
  expect(await pane.find({ key: 'reader-search' })).toBeDefined()
  const atTop = await readerText(pane)
  expect(atTop[0]).toBe('══ System prompt: 1 blocks')
  expect(atTop).toHaveLength(36)
  const { total } = await readerPosition(pane)
  expect(total).toBeGreaterThan(20_000)
  expect(
    await pane.find({ type: 'Text', text: `rows 1 to 36 of ${total.toLocaleString('en-US')}` }),
  ).toBeDefined()
  // Nothing stands in for the rest: the tree is never taller than the window,
  // so the pane has nothing to scroll and nothing in it ever moves.
  const heights = (await pane.findAll({ type: 'Box' }))
    .map(one => one.props.height)
    .filter((height): height is number => typeof height === 'number')
  expect(Math.max(...heights)).toBeLessThanOrEqual(36)
  expect((await pane.find({ type: 'Client', key: 'reader-text' }))?.props).toMatchObject({
    height: 36,
  })

  // A shorter window draws fewer rows, one at the least.
  await pane.redraw({ ...PANE.props, scroll: { offset: 0, bodyRows: 20 } })
  expect(await readerText(pane)).toHaveLength(16)
  await pane.redraw({ ...PANE.props, scroll: { offset: 0, bodyRows: 3 } })
  expect(await readerText(pane)).toHaveLength(1)

  // Back to the trace.
  await pane.post({ back: true }, { in: 'reader' })
  expect(await pane.find({ type: 'Client', key: 'reader' })).toBeUndefined()
  expect(await pane.find({ type: 'Client', key: 'disclose-trace-0' })).toBeDefined()

  await pane.unmount()
})

test('the keys in the reader’s text and its page buttons move the rows, never the pane', async ($, on) => {
  tracedEngine(on, longRequest(20_000))
  // Whether any move reaches the pane's window: none should, with the reader open.
  let windowMoves = 0
  on('ui.scroll', async () => {
    windowMoves += 1

    return {}
  })
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.pointer({ type: 'down', x: 2, y: 0, button: 'left', in: 'tab-trace' })
  await pane.pointer({ type: 'down', x: 5, y: 0, button: 'left', in: 'disclose-trace-0' })
  await pane.press({ key: 'read-0' })
  windowMoves = 0
  const atTop = await readerText(pane)
  const { total } = await readerPosition(pane)
  const text = { in: 'reader-text' }

  // Page Down and Page Up move by the rows in view; the arrows by one.
  await pane.key({ key: 'pagedown', ...text })
  expect(await readerPosition(pane)).toEqual({ first: 37, last: 72, total })
  await pane.key({ key: 'up', ...text })
  expect(await readerPosition(pane)).toEqual({ first: 36, last: 71, total })
  await pane.key({ key: 'down', ...text })
  await pane.key({ key: 'down', ...text })
  expect(await readerPosition(pane)).toEqual({ first: 38, last: 73, total })
  await pane.key({ key: 'pageup', ...text })
  expect(await readerPosition(pane)).toEqual({ first: 2, last: 37, total })
  // End and Home go to the ends; a move past either stops at it.
  await pane.key({ key: 'end', ...text })
  expect(await readerPosition(pane)).toEqual({ first: total - 35, last: total, total })
  expect(await readerText(pane)).toHaveLength(36)
  await pane.key({ key: 'pagedown', ...text })
  expect(await readerPosition(pane)).toEqual({ first: total - 35, last: total, total })
  await pane.key({ key: 'home', ...text })
  expect(await readerPosition(pane)).toEqual({ first: 1, last: 36, total })
  expect(await readerText(pane)).toEqual(atTop)
  await pane.key({ key: 'up', ...text })
  expect(await readerPosition(pane)).toEqual({ first: 1, last: 36, total })
  // A key the text does not know moves nothing.
  await pane.key({ key: 'x', ...text })
  expect(await readerPosition(pane)).toEqual({ first: 1, last: 36, total })

  // The page buttons do the same for the pointer.
  await pane.press({ key: 'reader-page-down' })
  expect(await readerPosition(pane)).toEqual({ first: 37, last: 72, total })
  await pane.press({ key: 'reader-page-up' })
  expect(await readerPosition(pane)).toEqual({ first: 1, last: 36, total })

  // The reader's own scrollbar, 36 rows tall beside the text: a press puts the
  // row under the pointer first, as a share of the track; a drag follows it.
  const bar = { in: 'reader-scrollbar' }
  expect((await pane.drawn(bar)) as { props?: { height?: number } }).toMatchObject({
    props: { height: 36 },
  })
  await pane.pointer({ type: 'down', x: 0, y: 35, button: 'left', ...bar })
  expect(await readerPosition(pane)).toEqual({ first: total - 35, last: total, total })
  await pane.pointer({ type: 'move', x: 0, y: 0, button: 'left', ...bar })
  expect(await readerPosition(pane)).toEqual({ first: 1, last: 36, total })
  await pane.pointer({ type: 'move', x: 0, y: 7, button: 'left', ...bar })
  const fifth = Math.round((7 / 35) * (total - 36)) + 1
  expect(await readerPosition(pane)).toEqual({ first: fifth, last: fifth + 35, total })
  await pane.pointer({ type: 'up', x: 0, y: 7, button: 'left', ...bar })
  // A move with no button held moves nothing.
  await pane.pointer({ type: 'move', x: 0, y: 30, ...bar })
  expect(await readerPosition(pane)).toEqual({ first: fifth, last: fifth + 35, total })
  // The thumb: as tall as the rows in view are of the request, one row at least.
  const thumb = (await pane.findAll({ type: 'Box', ...bar })).find(
    one => one.props.backgroundColor === '#80808066' || one.props.backgroundColor === '#808080aa',
  )
  expect(thumb?.props.height).toBe(1)

  // None of it scrolled the pane: its tree fits its window.
  expect(windowMoves).toBe(0)

  await pane.unmount()
})

test('a match after a character whose lower case is longer keeps its place', () => {
  // 'İ' lowers to two characters; the match after it is at its own index.
  expect(findMatches(['İstanbul Tea'], 'tea')).toEqual([{ row: 0, start: 9, end: 12 }])
})

test('a search finds every match in a row, ignoring case', () => {
  expect(findMatches(['Bash and bash', 'none', 'BASH'], 'bash')).toEqual([
    { row: 0, start: 0, end: 4 },
    { row: 0, start: 9, end: 13 },
    { row: 2, start: 0, end: 4 },
  ])
  expect(findMatches(['anything'], '   ')).toEqual([])
})

test('searching the reader marks each match and brings it to the middle of the rows', async ($, on) => {
  // Long enough that every match sits clear of the end.
  tracedEngine(on, longRequest(30_000))
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.pointer({ type: 'down', x: 2, y: 0, button: 'left', in: 'tab-trace' })
  await pane.pointer({ type: 'down', x: 5, y: 0, button: 'left', in: 'disclose-trace-0' })
  await pane.press({ key: 'read-0' })
  const { total } = await readerPosition(pane)

  await pane.input({ key: 'reader-search', text: 'line 1999', kind: 'change' })
  // line 1999, 19990 to 19999: eleven, the first current, in the middle of the 36 rows.
  expect(await pane.find({ type: 'Text', text: '1 of 11' })).toBeDefined()
  expect(await readerHit(pane)).toBe('line 1999')
  expect((await readerText(pane)).indexOf('line 1999')).toBe(18)
  const first = (await readerPosition(pane)).first
  expect(await readerPosition(pane)).toEqual({ first, last: first + 35, total })

  // Thousands of rows down.
  await pane.press({ key: 'reader-next' })
  expect(await pane.find({ type: 'Text', text: '2 of 11' })).toBeDefined()
  expect(await readerHit(pane)).toBe('line 19990')
  const shown = await readerText(pane)
  expect(shown.indexOf('line 19990')).toBe(18)
  expect(shown.slice(18, 28)).toEqual(
    Array.from({ length: 10 }, (_, index) => `line ${19990 + index}`),
  )
  // Back round the start to the last.
  await pane.press({ key: 'reader-previous' })
  await pane.press({ key: 'reader-previous' })
  expect(await pane.find({ type: 'Text', text: '11 of 11' })).toBeDefined()
  expect(await readerHit(pane)).toBe('line 19999')
  expect((await readerText(pane)).indexOf('line 19999')).toBe(18)
  // Enter in the field steps on, round the end to the first.
  await pane.input({ key: 'reader-search', text: 'line 1999', kind: 'submit' })
  expect(await pane.find({ type: 'Text', text: '1 of 11' })).toBeDefined()
  expect(await readerHit(pane)).toBe('line 1999')

  await pane.input({ key: 'reader-search', text: 'nowhere', kind: 'change' })
  expect(await pane.find({ type: 'Text', text: 'No match' })).toBeDefined()
  expect(await pane.find({ key: 'reader-next' })).toBeUndefined()

  await pane.unmount()
})

test('a request that goes on from the one before adds its messages, and keeps the prompt sent before', () => {
  const files: Record<string, string> = {}
  const store = new TraceStore((name: string, text: string) => {
    files[name] = text
  })
  const first = [{ role: 'user', content: 'hello' }]
  store.take(record('api_request_body', { body: requestBody(first), query_source: 'sdk' }))
  // Newer Claude Code: the billing header alone, no tools, the new messages only.
  store.take(
    record('api_request_body', {
      query_source: 'sdk',
      body: JSON.stringify({
        model: 'claude-opus-5-5',
        system: [{ type: 'text', text: 'x-anthropic-billing-header: cc_version=2' }],
        tools: [],
        messages: [{ role: 'user', content: 'how are you' }],
      }),
    }),
  )
  const records = [0, 1].map(
    seq => JSON.parse(files[`${SESSION}/00000${seq}.json`]!) as TraceRecord,
  )
  expect(records[1]).toMatchObject({ continues: true, from: 1, toolCount: 0 })
  expect(fullMessages(records, 1)).toEqual([
    { role: 'user', content: 'hello' },
    { role: 'user', content: 'how are you' },
  ])
  // Its prompt and tools are the first request's.
  expect(promptRecord(records, 1)?.seq).toBe(0)
  expect(tracePromptRecord(records, 1)?.seq).toBe(0)

  // One kept before the receiver marked such requests reads the same.
  const unmarked = records.map(({ continues: _continues, ...one }) =>
    one.seq === 1 ? { ...one, from: 0 } : one,
  )
  expect(fullMessages(unmarked, 1)).toHaveLength(2)
})

/** What the receiver writes for a request: a TraceRecord, and the one it goes on from. */
type KeptRecord = TraceRecord & { after?: number | null }

/** A store over files in memory, reading them back as the receiver reads its folder. */
function memoryStore(files: Record<string, string>, firstSeq = () => 0, readsBack = true) {
  return new TraceStore(
    (name: string, text: string) => {
      files[name] = text
    },
    firstSeq,
    () => true,
    readsBack ? () => keptRecords(files) : () => [],
  )
}

function keptRecords(files: Record<string, string>): KeptRecord[] {
  return Object.entries(files)
    .filter(([name]) => /\/\d{6}\.json$/.test(name))
    .map(([, text]) => JSON.parse(text) as KeptRecord)
    .sort((a, b) => a.seq - b.seq)
}

/** A body that goes on from an earlier request: the billing header alone, no tools. */
function continuationBody(messages: unknown[], previous?: string) {
  return JSON.stringify({
    model: 'claude-opus-5-5',
    system: [{ type: 'text', text: 'x-anthropic-billing-header: cc_version=2' }],
    tools: [],
    messages,
    ...(previous ? { thread: { type: 'continue', previous_message_id: previous } } : {}),
  })
}

/** The answer to a request, under the API's id for it. */
function answer(bodyId: string, id: string, text = 'ok') {
  return record('api_response_body', {
    request_body_id: bodyId,
    body: JSON.stringify({ id, content: [{ type: 'text', text }], stop_reason: 'end_turn' }),
  })
}

const user = (content: string) => ({ role: 'user', content })
const assistant = (text: string) => ({ role: 'assistant', content: [{ type: 'text', text }] })

test('a receiver started mid-conversation goes on from the requests already on disk', () => {
  const before: Record<string, string> = {}
  const first = memoryStore(before)
  first.take(
    record('api_request_body', {
      body: requestBody([user('hello')]),
      query_source: 'sdk',
      request_body_id: 'b0',
    }),
  )
  first.take(answer('b0', 'msg_0'))

  // Told by its shape alone, with nothing read back: it still goes on.
  const shaped = { ...before }
  memoryStore(shaped, () => 1, false).take(
    record('api_request_body', {
      body: continuationBody([user('how are you')]),
      query_source: 'sdk',
    }),
  )
  const shapedRecords = keptRecords(shaped)
  expect(shapedRecords[1]).toMatchObject({ continues: true, after: null })
  expect(fullMessages(shapedRecords, 1)).toEqual([user('hello'), user('how are you')])

  // Naming the answer it goes on from, found in the folder.
  const named = { ...before }
  memoryStore(named, () => 1).take(
    record('api_request_body', {
      body: continuationBody([user('how are you')], 'msg_0'),
      query_source: 'sdk',
    }),
  )
  const namedRecords = keptRecords(named)
  expect(namedRecords[1]).toMatchObject({ continues: true, after: 0, from: 2, messageCount: 3 })
  expect(fullMessages(namedRecords, 1)).toEqual([
    user('hello'),
    assistant('ok'),
    user('how are you'),
  ])
  expect(promptRecord(namedRecords, 1)?.seq).toBe(0)
})

test('switching the output style mid-session keeps the main conversation and its prompt', () => {
  const files: Record<string, string> = {}
  const store = memoryStore(files)
  store.take(
    record('api_request_body', {
      body: requestBody([user('hello')]),
      query_source: 'repl_main_thread:outputStyle:default',
      request_body_id: 'b0',
    }),
  )
  store.take(answer('b0', 'msg_0', 'hi'))
  store.take(
    record('api_request_body', {
      body: continuationBody([user('explain')], 'msg_0'),
      query_source: 'repl_main_thread:outputStyle:Explanatory',
    }),
  )
  store.take(
    record('api_request_body', {
      body: requestBody([user('hello'), assistant('hi'), user('explain'), user('more')]),
      query_source: 'repl_main_thread:outputStyle:Explanatory',
    }),
  )
  const records = keptRecords(files)
  expect(records[1]).toMatchObject({
    source: 'repl_main_thread:outputStyle:Explanatory',
    continues: true,
    after: 0,
  })
  expect(fullMessages(records, 1)).toEqual([user('hello'), assistant('hi'), user('explain')])
  expect(promptRecord(records, 1)?.seq).toBe(0)
  expect(tracePromptRecord(records, 1)?.seq).toBe(0)
  expect(records[2]).toMatchObject({ from: 3 })
  expect(fullMessages(records, 2)).toEqual([
    user('hello'),
    assistant('hi'),
    user('explain'),
    user('more'),
  ])
})

test('a body sent twice adds its messages once', () => {
  const files: Record<string, string> = {}
  const store = memoryStore(files)
  store.take(
    record('api_request_body', { body: requestBody([user('hello')]), query_source: 'sdk' }),
  )
  // Told by its shape: the second time, the conversation already ends with it.
  for (let times = 0; times < 2; times += 1)
    store.take(
      record('api_request_body', { body: continuationBody([user('again')]), query_source: 'sdk' }),
    )
  // Naming its answer: each time, it goes on from that one.
  store.take(
    record('api_request_body', {
      body: requestBody([user('hello'), user('again'), user('next')]),
      query_source: 'sdk',
      request_body_id: 'b3',
    }),
  )
  store.take(answer('b3', 'msg_3'))
  for (let times = 0; times < 2; times += 1)
    store.take(
      record('api_request_body', {
        body: continuationBody([user('last')], 'msg_3'),
        query_source: 'sdk',
      }),
    )
  const records = keptRecords(files)
  expect(records[2]).toMatchObject({ continues: false, from: 1, messageCount: 2 })
  expect(fullMessages(records, 1)).toEqual([user('hello'), user('again')])
  expect(fullMessages(records, 2)).toEqual([user('hello'), user('again')])
  expect(records[3]).toMatchObject({ from: 2 })
  const whole = [user('hello'), user('again'), user('next'), assistant('ok'), user('last')]
  expect(records[4]).toMatchObject({ continues: true, after: 3, messageCount: 5 })
  expect(records[5]).toMatchObject({ continues: true, after: 3, messageCount: 5 })
  expect(fullMessages(records, 4)).toEqual(whole)
  expect(fullMessages(records, 5)).toEqual(whole)
})

test('parallel subagents of one type are each rebuilt whole', () => {
  const files: Record<string, string> = {}
  const store = memoryStore(files)
  const source = 'agent:builtin:general-purpose'
  const bodies = [
    [user('a: task')],
    [user('b: task')],
    [user('a: task'), assistant('a: one'), user('a: more')],
    [user('b: task'), assistant('b: one'), user('b: more')],
    [user('a: task'), assistant('a: one'), user('a: more'), assistant('a: two'), user('a: end')],
  ]
  bodies.forEach((messages, index) =>
    store.take(
      record('api_request_body', {
        body: requestBody(messages),
        query_source: source,
        request_body_id: `b${index}`,
      }),
    ),
  )
  store.take(answer('b3', 'msg_b'))
  store.take(answer('b4', 'msg_a'))
  // Going on, each from the answer it names, whichever came last.
  for (const [text, previous] of [
    ['b: end', 'msg_b'],
    ['a: after', 'msg_a'],
    // One whose answer is nowhere is not joined to another subagent's.
    ['c: lost', 'msg_c'],
  ] as const)
    store.take(
      record('api_request_body', {
        body: continuationBody([user(text)], previous),
        query_source: source,
      }),
    )
  // The main conversation, meanwhile, is apart.
  store.take(record('api_request_body', { body: requestBody([user('main')]), query_source: 'sdk' }))
  const records = keptRecords(files)
  bodies.forEach((messages, index) => expect(fullMessages(records, index)).toEqual(messages))
  expect(records[5]).toMatchObject({ continues: true, after: 3, messageCount: 5 })
  expect(fullMessages(records, 5)).toEqual([...bodies[3]!, assistant('ok'), user('b: end')])
  expect(records[6]).toMatchObject({ continues: true, after: 4, messageCount: 7 })
  expect(fullMessages(records, 6)).toEqual([...bodies[4]!, assistant('ok'), user('a: after')])
  expect(records[7]).toMatchObject({ continues: false, after: null, messageCount: 1 })
  expect(fullMessages(records, 7)).toEqual([user('c: lost')])
  expect(fullMessages(records, 8)).toEqual([user('main')])
})

test('a request that goes on counts the whole conversation, not only its new messages', () => {
  const files: Record<string, string> = {}
  const store = memoryStore(files)
  store.take(
    record('api_request_body', {
      body: requestBody([user('one'), assistant('two'), user('three')]),
      query_source: 'sdk',
    }),
  )
  store.take(
    record('api_request_body', {
      body: continuationBody([assistant('four'), user('five')]),
      query_source: 'sdk',
    }),
  )
  const records = keptRecords(files)
  expect(records[1]).toMatchObject({ continues: true, messageCount: 5 })
  expect(records[1]!.added).toHaveLength(2)
  expect(summarize(records[1]!).messageCount).toBe(5)
})

test('a request that could not be read leaves the conversation as it was', () => {
  const files: Record<string, string> = {}
  const store = memoryStore(files)
  store.take(record('api_request_body', { body: requestBody([user('one')]), query_source: 'sdk' }))
  store.take(record('api_request_body', { body: '{"messages": [', query_source: 'sdk' }))
  store.take(
    record('api_request_body', {
      body: requestBody([user('one'), assistant('two'), user('three')]),
      query_source: 'sdk',
    }),
  )
  const records = keptRecords(files)
  expect(records[1]).toMatchObject({ unreadable: 14 })
  expect(fullMessages(records, 1)).toEqual([])
  expect(records[2]).toMatchObject({ from: 1 })
  expect(fullMessages(records, 2)).toEqual([user('one'), assistant('two'), user('three')])
})

/** Usage for the oldest request of the main loop still without it. */
function usage(input: number, costUsd: number) {
  return record('api_request', {
    query_source: 'sdk',
    input_tokens: input,
    output_tokens: 30,
    cost_usd: costUsd,
    duration_ms: 2500,
  })
}

/** Text that makes a request's file too large for the pane to read. */
const huge = (size: number) => `BIG${'x'.repeat(size)}`

test('the store keeps a head beside a large request, in step as its answer lands', () => {
  const files: Record<string, string> = {}
  const store = memoryStore(files)
  store.take(
    record('api_request_body', {
      body: requestBody([user('hello')]),
      query_source: 'sdk',
      request_body_id: 'b0',
    }),
  )
  store.take(usage(10, 0.01))
  store.take(answer('b0', 'msg_0', 'hi'))
  store.take(
    record('api_request_body', {
      body: requestBody([user('hello'), assistant('hi'), user(huge(HEAD_AFTER_BYTES))]),
      query_source: 'sdk',
      request_body_id: 'b1',
    }),
  )
  expect(Object.keys(files).filter(name => name.endsWith('.head.json'))).toEqual([
    `${SESSION}/000001.head.json`,
  ])
  const head = () => JSON.parse(files[`${SESSION}/000001.head.json`]!) as KeptRecord
  expect(head()).toMatchObject({
    seq: 1,
    isHead: true,
    added: [],
    roles: ['user'],
    from: 2,
    messageCount: 3,
    usage: null,
    response: null,
  })
  store.take(usage(1200, 0.3))
  store.take(answer('b1', 'msg_1', 'done'))
  expect(head()).toMatchObject({
    usage: { input: 1200, costUsd: 0.3 },
    response: { id: 'msg_1', content: [{ type: 'text', text: 'done' }] },
  })
  // The head is the request without its messages.
  const { added: _added, ...whole } = JSON.parse(files[`${SESSION}/000001.json`]!) as KeptRecord
  const {
    added: _none,
    isHead: _isHead,
    roles: _roles,
    ...rest
  } = head() as KeptRecord & {
    isHead: boolean
    roles: string[]
  }
  expect(rest).toEqual(whole)

  // One just under the limit has none until its answer takes it past.
  store.take(
    record('api_request_body', {
      body: continuationBody([user(huge(HEAD_AFTER_BYTES - 2_000))], 'msg_1'),
      query_source: 'sdk',
      request_body_id: 'b2',
    }),
  )
  expect(files[`${SESSION}/000002.head.json`]).toBeUndefined()
  store.take(answer('b2', 'msg_2', 'y'.repeat(3_000)))
  expect(JSON.parse(files[`${SESSION}/000002.head.json`]!)).toMatchObject({
    isHead: true,
    continues: true,
    after: 1,
    response: { id: 'msg_2' },
  })
})

/** A session's files as the store wrote them, by name within its folder. */
function sessionFiles(files: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(files).map(([name, text]) => [name.slice(SESSION.length + 1), text]),
  )
}

/** Three main requests, the second too large for the pane, each answered. */
function largeSession() {
  const files: Record<string, string> = {}
  const store = memoryStore(files)
  const big = user(huge(4.2 * 1024 * 1024))
  const bodies = [
    [user('hello')],
    [user('hello'), assistant('hi'), big],
    [user('hello'), assistant('hi'), big, assistant('done'), user('next')],
  ]
  const answers = ['hi', 'done', 'bye']
  bodies.forEach((messages, index) => {
    store.take(
      record('api_request_body', {
        body: requestBody(messages),
        query_source: 'sdk',
        request_body_id: `b${index}`,
      }),
    )
    store.take(usage(1000 * (index + 1), 0.1 * (index + 1)))
    store.take(answer(`b${index}`, `msg_${index}`, answers[index]))
  })

  return files
}

test('a request too large to read is listed from its head, and the ones after keep their place', async ($, on) => {
  const folder = sessionFiles(largeSession())
  expect(folder['000001.json']!.length).toBeGreaterThan(4 * 1024 * 1024)
  expect(Object.keys(folder)).toContain('000001.head.json')
  tracedEngine(on, folder)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.pointer({ type: 'down', x: 2, y: 0, button: 'left', in: 'tab-trace' })

  // Its own source, usage and answer; a head is not a request of its own.
  expect(await traceRows(pane)).toEqual(['#3', '#2', '#1'])
  const row = (await pane.find({ type: 'Client', key: 'disclose-trace-1' }))?.props.props
  expect(row).toMatchObject({
    figure: '2k in · 30 out · $0.20 · 2.5s',
    lines: ['+ 1 message too large to read here: open it in your browser', '→ "done"'],
  })

  // Expand on it says so, and still shows what it was sent with.
  const drawnText = async () => (await readerText(pane)).join('\n')
  await pane.pointer({ type: 'down', x: 5, y: 0, button: 'left', in: 'disclose-trace-1' })
  expect(String((await pane.find({ type: 'Code' }))?.props.source)).toMatch(
    /^This request is too large to read here: open it in your browser to read it whole\.\n\n── Sent: 1 new message \(3 in all\)/,
  )
  await pane.press({ key: 'read-1' })
  expect(await drawnText()).toMatch(/^This request is too large to read here/)
  expect(await drawnText()).toMatch(/── #3 user \(new\)\n\(Not shown: request #2 is too large/)
  await pane.post({ back: true }, { in: 'reader' })

  // The request after it: every message in its place, the answers between
  // them included, its own whole.
  await pane.pointer({ type: 'down', x: 5, y: 0, button: 'left', in: 'disclose-trace-2' })
  await pane.press({ key: 'read-2' })
  // An empty row is drawn as a space.
  const text = await drawnText()
  expect(text).toMatch(/══ Messages: 5, the last 1 new in this request/)
  expect(text).toMatch(
    /── #1 user\nhello\n \n── #2 assistant\nhi\n \n── #3 user\n\(Not shown: request #2/,
  )
  expect(text).toMatch(/── #4 assistant\ndone\n \n── #5 user \(new\)\nnext/)

  await pane.unmount()
})

test('a request too large to read with no head, from an older receiver, is listed as before', async ($, on) => {
  const folder = sessionFiles(largeSession())
  delete folder['000001.head.json']
  tracedEngine(on, folder)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.pointer({ type: 'down', x: 2, y: 0, button: 'left', in: 'tab-trace' })

  // Known by its number alone, it is not counted in the conversation.
  expect(await traceRows(pane)).toEqual(['#3', '#1', '#2 unknown'])
  const row = (await pane.find({ type: 'Client', key: 'disclose-trace-1' }))?.props.props
  expect((row as { lines: string[] }).lines).toEqual([
    '+ too large to read here: open it in your browser',
  ])
  await pane.pointer({ type: 'down', x: 5, y: 0, button: 'left', in: 'disclose-trace-1' })
  expect(String((await pane.find({ type: 'Code' }))?.props.source)).toBe(
    'This request is too large to read here: open it in your browser to read it whole.',
  )

  await pane.unmount()
})

test('a head stands in for its request’s messages, and the prompt is found through it', () => {
  const files: Record<string, string> = {}
  const store = memoryStore(files)
  store.take(
    record('api_request_body', {
      body: requestBody([user('hello')]),
      query_source: 'sdk',
      request_body_id: 'b0',
    }),
  )
  store.take(answer('b0', 'msg_0', 'hi'))
  store.take(
    record('api_request_body', {
      body: continuationBody([user(huge(HEAD_AFTER_BYTES))], 'msg_0'),
      query_source: 'sdk',
      request_body_id: 'b1',
    }),
  )
  store.take(answer('b1', 'msg_1', 'done'))
  store.take(
    record('api_request_body', {
      body: continuationBody([user('more')], 'msg_1'),
      query_source: 'sdk',
    }),
  )
  const whole = keptRecords(files)
  // As the pane reads them: the large one from its head.
  const read = whole.map(one =>
    one.seq === 1 ? fromHead(JSON.parse(files[`${SESSION}/000001.head.json`]!)) : one,
  )
  expect(read[1]).toMatchObject({ source: 'sdk', continues: true, after: 0, toolCount: 0 })
  expect(promptRecord(read, 2)?.seq).toBe(0)
  expect(tracePromptRecord(read, 2)?.seq).toBe(0)
  const messages = fullMessages(read, 2)!
  expect(messages).toHaveLength(whole[2]!.messageCount)
  expect(messages).toHaveLength(fullMessages(whole, 2)!.length)
  expect(messages.at(-1)).toEqual(user('more'))
  expect(messages.filter(one => JSON.stringify(one).includes('Not shown'))).toHaveLength(1)
})

test('the browser pages read a large request whole, with no head', () => {
  const records = keptRecords(largeSession())
  expect(records.map(one => one.seq)).toEqual([0, 1, 2])
  expect(records.some(one => (one as { isHead?: boolean }).isHead)).toBe(false)
  const html = requestPage({
    session: SESSION,
    records,
    seq: 2,
    system: null,
    tools: null,
    link: () => '#',
  })!
  expect(html).toContain('BIGxxxx')
  expect(html).not.toContain('Not shown')
  expect(fullMessages(records, 2)).toHaveLength(5)
})

/** A main request's answer: what it said, and a tool it called. */
function toolAnswer(bodyId: string, id: string) {
  return record('api_response_body', {
    request_body_id: bodyId,
    body: JSON.stringify({
      id,
      content: [
        { type: 'text', text: 'Running ls.' },
        { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } },
      ],
      stop_reason: 'tool_use',
    }),
  })
}

const toolTurn = {
  role: 'assistant',
  content: [
    { type: 'text', text: 'Running ls.' },
    { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } },
  ],
}
const toolResult = {
  role: 'user',
  content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'a.txt' }],
}

test('a request that goes on has the answer it goes on from in its conversation, and counts it', () => {
  const files: Record<string, string> = {}
  const store = memoryStore(files)
  store.take(
    record('api_request_body', {
      body: requestBody([user('list the files')]),
      query_source: 'sdk',
      request_body_id: 'b0',
    }),
  )
  store.take(toolAnswer('b0', 'msg_0'))
  // Naming the answer, and told by its shape alone.
  store.take(
    record('api_request_body', {
      body: continuationBody([toolResult], 'msg_0'),
      query_source: 'sdk',
      request_body_id: 'b1',
    }),
  )
  store.take(answer('b1', 'msg_1', 'There is a.txt.'))
  store.take(
    record('api_request_body', {
      body: continuationBody([user('thanks')]),
      query_source: 'sdk',
      request_body_id: 'b2',
    }),
  )
  store.take(answer('b2', 'msg_2'))
  const records = keptRecords(files)
  expect(records[1]).toMatchObject({ continues: true, after: 0, from: 2, messageCount: 3 })
  expect(records[1]!.added).toEqual([toolResult])
  expect(fullMessages(records, 1)).toEqual([user('list the files'), toolTurn, toolResult])
  expect(records[2]).toMatchObject({ continues: true, after: 1, from: 4, messageCount: 5 })
  expect(fullMessages(records, 2)).toEqual([
    user('list the files'),
    toolTurn,
    toolResult,
    assistant('There is a.txt.'),
    user('thanks'),
  ])
  // Each rebuilt conversation is as long as the store counted it.
  for (const one of records) expect(fullMessages(records, one.seq)).toHaveLength(one.messageCount)

  // A receiver started after it counts the answer the same, read from the folder.
  const later = { ...files }
  memoryStore(later, () => 3).take(
    record('api_request_body', { body: continuationBody([user('more')]), query_source: 'sdk' }),
  )
  const read = keptRecords(later)
  expect(read[3]).toMatchObject({ continues: true, after: 2, from: 6, messageCount: 7 })
  expect(fullMessages(read, 3)).toHaveLength(7)
  expect(fullMessages(read, 3)!.at(-2)).toEqual(assistant('ok'))
})

test('an answer that lands after the request that goes on from it is not put before it', () => {
  const files: Record<string, string> = {}
  const store = memoryStore(files)
  store.take(
    record('api_request_body', {
      body: requestBody([user('hello')]),
      query_source: 'sdk',
      request_body_id: 'b0',
    }),
  )
  store.take(
    record('api_request_body', { body: continuationBody([user('more')]), query_source: 'sdk' }),
  )
  store.take(answer('b0', 'msg_0', 'hi'))
  // As a request an older receiver kept reads, which counted no answer:
  // the answer is on disk, and the request starts before it.
  const records = keptRecords(files)
  expect(records[0]!.response).not.toBeNull()
  expect(records[1]).toMatchObject({ continues: true, from: 1, messageCount: 2 })
  expect(fullMessages(records, 1)).toEqual([user('hello'), user('more')])
})

test('a whole body sent again after a request that went on rebuilds as sent', () => {
  const sent = (answerBlock: Record<string, unknown>) => {
    const files: Record<string, string> = {}
    const store = memoryStore(files)
    store.take(
      record('api_request_body', {
        body: requestBody([user('hello')]),
        query_source: 'sdk',
        request_body_id: 'b0',
      }),
    )
    store.take(answer('b0', 'msg_0', 'hi'))
    // Goes on, and is never answered: Claude Code sends the conversation whole.
    store.take(
      record('api_request_body', {
        body: continuationBody([user('more')], 'msg_0'),
        query_source: 'sdk',
      }),
    )
    const whole = [user('hello'), { role: 'assistant', content: [answerBlock] }, user('more')]
    store.take(record('api_request_body', { body: requestBody(whole), query_source: 'sdk' }))

    return { records: keptRecords(files), whole }
  }

  // The answer as Claude Code keeps it is the response's: the diff goes past it.
  const same = sent({ type: 'text', text: 'hi' })
  expect(same.records[2]).toMatchObject({ continues: false, from: 3, messageCount: 3, added: [] })
  expect(fullMessages(same.records, 2)).toEqual(same.whole)

  // Kept otherwise (a field added): the diff stops before it, and the body's own is kept.
  const other = sent({ type: 'text', text: 'hi', citations: null })
  expect(other.records[2]).toMatchObject({ continues: false, from: 1, messageCount: 3 })
  expect(other.records[2]!.added).toEqual(other.whole.slice(1))
  expect(fullMessages(other.records, 2)).toEqual(other.whole)
})

test('the pane’s reader and the browser page show the answer a request goes on from', async ($, on) => {
  const files: Record<string, string> = {}
  const store = memoryStore(files)
  store.take(
    record('api_request_body', {
      body: requestBody([user('list the files')]),
      query_source: 'sdk',
      request_body_id: 'b0',
    }),
  )
  store.take(toolAnswer('b0', 'msg_0'))
  store.take(
    record('api_request_body', {
      body: continuationBody([toolResult], 'msg_0'),
      query_source: 'sdk',
    }),
  )

  const html = requestPage({
    session: SESSION,
    records: keptRecords(files),
    seq: 1,
    system: null,
    tools: null,
    link: () => '#',
  })!
  const roles = [
    ...html.matchAll(/<span class="seq">#(\d)<\/span><span class="pill tone-\w+">(\w+)</g),
  ]
  expect(roles.map(match => `${match[1]} ${match[2]}`)).toEqual(['1 user', '2 assistant', '3 user'])

  tracedEngine(on, sessionFiles(files))
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.pointer({ type: 'down', x: 2, y: 0, button: 'left', in: 'tab-trace' })
  await pane.pointer({ type: 'down', x: 5, y: 0, button: 'left', in: 'disclose-trace-1' })
  await pane.press({ key: 'read-1' })
  const text = (await readerText(pane)).join('\n')
  expect(text).toMatch(/══ Messages: 3, the last 1 new in this request/)
  expect(text).toMatch(
    /── #1 user\nlist the files\n \n── #2 assistant\nRunning ls\.\n→ Bash \{[\s\S]*── #3 user \(new\)\n← tool result\na\.txt/,
  )

  await pane.unmount()
})

import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { On } from 'claude-code'

import { FOLDER_VARIABLE, SHOW_FOLDER_SCRIPT, encodedCommand } from '../hooks/folder'
import { pageStarts } from '../hooks/panel'
import {
  RECEIVER_HEALTH,
  RECEIVER_NAME,
  editTraceEnv,
  findMatches,
  isTraceOn,
  promptRecord as tracePromptRecord,
  readerRanges,
  sentPrompt,
  summarize,
  TRACE_ENV,
  wrapRows,
} from '../hooks/trace'
import type { TraceRecord } from '../hooks/trace'
// The receiver's own logic, as Node runs it.
import { HEALTH, logRecords, TraceStore } from '../trace/store.mjs'
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
  // The second carries only what follows the first.
  const two = JSON.parse(files[`${SESSION}/000001.json`]!) as TraceRecord
  expect(two).toMatchObject({ seq: 1, from: 1, messageCount: 3, usage: null, response: null })
  expect(two.added).toHaveLength(2)
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
  // What it replaced is kept, to give back.
  expect(on.before).toEqual({ OTEL_LOGS_EXPORTER: 'console' })

  const off = editTraceEnv(on.text, false, on.before)
  const offSettings = JSON.parse(off.text) as { env: Record<string, string> }
  expect(isTraceOn(offSettings)).toBe(false)
  expect(offSettings.env).toEqual({ MINE: '1', OTEL_LOGS_EXPORTER: 'console' })
  expect(off.before).toEqual({})

  // A value the person changed while tracing was on is theirs, and stays.
  const changed = editTraceEnv(
    JSON.stringify({ env: { ...TRACE_ENV, OTEL_LOGS_EXPORTER: 'none' } }),
    false,
    { OTEL_LOGS_EXPORTER: 'console' },
  )
  expect(JSON.parse(changed.text).env).toEqual({ OTEL_LOGS_EXPORTER: 'none' })
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
  settings.text = JSON.stringify({ env: { OTEL_LOGS_EXPORTER: 'console', MINE: '1' } })
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.pointer({ type: 'down', x: 2, y: 0, button: 'left', in: 'tab-trace' })

  await pane.press({ key: 'tracing' })
  expect(JSON.parse(settings.text).env.OTEL_LOGS_EXPORTER).toBe('otlp')
  await pane.press({ key: 'tracing' })
  expect(JSON.parse(settings.text).env).toEqual({ OTEL_LOGS_EXPORTER: 'console', MINE: '1' })

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

test('the reader draws only the rows near the window, and empty space for the rest', async ($, on) => {
  const long = Array.from({ length: 20_000 }, (_, index) => `line ${index}`).join('\n')
  const files: Record<string, string> = {
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
  tracedEngine(on, files)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.pointer({ type: 'down', x: 2, y: 0, button: 'left', in: 'tab-trace' })
  await pane.pointer({ type: 'down', x: 5, y: 0, button: 'left', in: 'disclose-trace-0' })
  await pane.press({ key: 'read-0' })

  // At the top: the way back, then the start of the request.
  expect((await pane.find({ type: 'Client', key: 'reader' }))?.props).toMatchObject({ height: 1 })
  const drawnRows = async () =>
    (await pane.findAll({ type: 'Text' }))
      .filter(one => one.props.mono === true)
      .map(one => one.text)
  const atTop = await drawnRows()
  expect(atTop[0]).toBe('══ System prompt: 1 blocks')
  expect(atTop.length).toBeLessThanOrEqual(80)
  // Scrolled far down: the rows there, and every row before stood in for.
  await pane.redraw({ ...PANE.props, scroll: { offset: 15_002, bodyRows: 40 } })
  const below = await drawnRows()
  expect(below.length).toBeLessThanOrEqual(120)
  expect(below).toContain('line 14990')
  // The rows before stand in as space, in Boxes no taller than the engine draws.
  const spaces = (await pane.findAll({ type: 'Box' }))
    .map(one => one.props.height)
    .filter((height): height is number => typeof height === 'number' && height > 100)
  expect(spaces.every(height => height <= 10_000)).toBe(true)
  expect(spaces.reduce((sum, height) => sum + height, 0)).toBeGreaterThan(14_000)

  // Back to the trace.
  await pane.post({ back: true }, { in: 'reader' })
  expect(await pane.find({ type: 'Client', key: 'reader' })).toBeUndefined()
  expect(await pane.find({ type: 'Client', key: 'disclose-trace-0' })).toBeDefined()

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

test('the reader draws the window and the rows around the current match', () => {
  // Far apart: two stretches.
  expect(readerRanges(100_000, 500, 40, 90_000)).toEqual([
    { first: 460, last: 580 },
    { first: 89_960, last: 90_040 },
  ])
  // Near each other: one.
  expect(readerRanges(100_000, 500, 40, 520)).toEqual([{ first: 460, last: 580 }])
  // Clamped at the ends.
  expect(readerRanges(50, 0, 40, null)).toEqual([{ first: 0, last: 50 }])
})

test('searching the reader marks each match and steps to the next', async ($, on) => {
  const long = Array.from({ length: 20_000 }, (_, index) => `line ${index}`).join('\n')
  const files: Record<string, string> = {
    'system-a.json': JSON.stringify([{ type: 'text', text: 'You are Claude.' }]),
    'tools-b.json': JSON.stringify([]),
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
  await pane.pointer({ type: 'down', x: 5, y: 0, button: 'left', in: 'disclose-trace-0' })
  await pane.press({ key: 'read-0' })

  await pane.input({ key: 'reader-search', text: 'line 1999', kind: 'change' })
  // line 1999, 19990 to 19999: eleven, the first current and drawn though far below.
  expect(await pane.find({ type: 'Text', text: '1 of 11' })).toBeDefined()
  expect((await pane.find({ key: 'reader-hit' }))?.text).toBe('line 1999')
  await pane.press({ key: 'reader-next' })
  expect(await pane.find({ type: 'Text', text: '2 of 11' })).toBeDefined()
  expect((await pane.find({ key: 'reader-hit' }))?.text).toBe('line 19990')
  await pane.press({ key: 'reader-previous' })
  await pane.press({ key: 'reader-previous' })
  expect(await pane.find({ type: 'Text', text: '11 of 11' })).toBeDefined()

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

import { expect, mock, test } from 'claude-code/testing'

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

test('draws the CLI status line figures as a band on the desktop', async ($, on) => {
  const clock = mock.clock(on, { now: 100_000 })
  on('session.model', async () => ({ value: 'claude-fable-5-1' }))
  on('session.cwd', async () => ({ value: 'C:/Users/amato/repos/construct-land' }))
  on('session.usage', async () => ({
    value: {
      startedAt: 40_000,
      context: { window: 200_000, tokens: 66_000, percent: 33 },
      rateLimits: [],
      cost: { usd: 1.234 },
    },
  }))
  on('turn.complete', async () => ({ text: 'done' }))

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  const model = await ui.find({ type: 'Text', text: 'Fable 5.1' })
  expect(model?.props).toMatchObject({ color: 'claude', bold: true })
  expect(await ui.find({ type: 'Text', text: 'construct-land' })).toBeDefined()

  const meter = (await ui.findAll({ type: 'Svg' })).find(one =>
    /^context(: no reading yet| \d+% used)$/.test(String(one.props.alt)),
  )
  expect(meter?.props).toMatchObject({ alt: 'context 33% used', width: 64, height: 10 })
  expect(String(meter?.props.source)).toMatch(
    /<rect x="1" y="1" width="20" height="8" fill="#c19c00"/,
  )
  expect(String(meter?.props.source)).toMatch(/stroke="#8a8a8a"/)
  // The percentage is text; the button over it and the meter is figure spaces,
  // as wide as the two, so the desktop's pill spans both.
  expect((await ui.find({ type: 'Text', text: '33%' }))?.props).toMatchObject({ tabular: true })
  expect((await ui.find({ key: 'open-context' }))?.props).toMatchObject({
    plain: true,
    label: '\u2007'.repeat(12),
  })

  expect(await ui.find({ type: 'Text', text: /\$1\.23/ })).toBeDefined()
  // The timer is a region of its own (hooks/elapsed.tsx), in a slot as wide
  // as its widest reading, and counts the seconds itself: the band is not
  // drawn again for them.
  await ui.advance(0)
  // Centred in its slot, with digits of one width, so nothing beside it moves.
  expect((await ui.find({ type: 'Text', text: '1m 0s', in: 'elapsed' }))?.props).toMatchObject({
    tabular: true,
  })
  const slot = (await ui.findAll({ type: 'Box' })).find(one => one.props.width === 7)
  expect(slot?.props).toMatchObject({ width: 7, justifyContent: 'center' })
  expect((slot?.children[0] as { props?: unknown } | undefined)?.props).toMatchObject({
    key: 'elapsed',
    module: 'hooks/elapsed.tsx',
    props: { ms: 60_000 },
  })
  await ui.advance(1_000)
  expect(await ui.find({ type: 'Text', text: '1m 1s', in: 'elapsed' })).toBeDefined()
  await ui.advance(59_000)
  expect(await ui.find({ type: 'Text', text: '2m 0s', in: 'elapsed' })).toBeDefined()
  // Drawn again a minute on (a turn ends), the band hands it the time anew,
  // and it counts on from there, not from both: the engine's clock moves,
  // where `advance` moves the region's frames alone.
  await clock.set(160_000)
  await $.turn.complete({
    turnId: 'turn-1',
    answer: 'done',
    durationMs: 1_000,
    isAborted: false,
    reason: 'answer',
  })
  await ui.advance(1_000)
  expect(await ui.find({ type: 'Text', text: '2m 1s', in: 'elapsed' })).toBeDefined()

  // Meter │ cost │ elapsed │ ⓘ, no effort known yet so none on the left.
  const dividers = (await ui.findAll({ type: 'Svg' })).filter(one => one.props.alt === 'divider')
  expect(dividers).toHaveLength(4)
  // The pane's button ends the band: a glyph alone, dim until pointed at, a
  // figure space either side for the pill the desktop draws around it.
  const buttons = (await ui.findAll({ type: 'Button' })).map(one => one.props.key)
  expect(buttons).toEqual(['open-context', 'open-details'])
  expect((await ui.find({ key: 'open-details' }))?.props).toMatchObject({
    plain: true,
    dimColor: true,
    label: ' ⓘ ',
  })

  await ui.unmount()
})

test('draws a hairline between the model, the effort and the folder', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  on('session.model', async () => ({ value: 'Opus 5.5' }))
  on('session.cwd', async () => ({ value: '/home/me/project' }))
  on('session.usage', async () => ({
    value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] },
  }))
  // The session's configured effort, read when the session starts.
  on('config.list', async () => ({
    value: [
      {
        key: 'effort',
        label: 'Effort',
        value: 'high',
        kind: 'choice',
        options: ['low', 'medium', 'high'],
        provider: { plugin: 'engine', tier: 'core' },
        isLocked: false,
      },
    ],
  }))
  on('process.run', async () => ({
    value: {
      exitCode: 1,
      stdout: '',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/home/me/project', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect(await ui.find({ type: 'Text', text: 'high' })).toBeDefined()
  // Two on the left, one on the right between the meter and the timer: no
  // cost has been read yet, so no hairline is drawn for it.
  const dividers = (await ui.findAll({ type: 'Svg' })).filter(one => one.props.alt === 'divider')
  expect(dividers).toHaveLength(4)
  for (const one of dividers) {
    expect(one.props).toMatchObject({ width: 2, height: 14 })
    expect(String(one.props.source)).toMatch(/fill="#333333"\/>/)
  }

  await ui.unmount()
})

test('cuts a long branch name short rather than wrapping the band', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  on('session.model', async () => ({ value: 'Opus 5.5' }))
  on('session.cwd', async () => ({ value: '/home/me/claude-mods' }))
  on('session.usage', async () => ({
    value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] },
  }))
  const branch = 'feat/desktop-statusline-context-breakdown-and-a-good-deal-more'
  on('process.run', async (_$, e) => ({
    value: {
      exitCode: 0,
      stdout: e.argv.includes('rev-parse') ? `${branch}\n` : ' M README.md\n',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/home/me/claude-mods', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect((await ui.find({ type: 'Text', text: branch }))?.props).toMatchObject({
    wrap: 'truncate-end',
  })
  expect(await ui.find({ type: 'Text', text: '•' })).toBeDefined()
  // The band is one row: nothing in it wraps the figures onto a second line.
  for (const box of await ui.findAll({ type: 'Box' })) {
    expect(box.props.flexWrap).toBeUndefined()
  }

  await ui.unmount()
})

test('shows a placeholder bar and no cost before the first response', async ($, on) => {
  mock.clock(on, { now: 5_000 })
  on('session.model', async () => ({ value: 'Opus 5.5' }))
  on('session.cwd', async () => ({ value: '/home/me/project' }))
  on('session.usage', async () => ({
    value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] },
  }))

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect(await ui.find({ type: 'Text', text: 'Opus 5.5' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'project' })).toBeDefined()
  const meter = (await ui.findAll({ type: 'Svg' })).find(one =>
    /^context(: no reading yet| \d+% used)$/.test(String(one.props.alt)),
  )
  expect(meter?.props).toMatchObject({ alt: 'context: no reading yet' })
  expect(String(meter?.props.source)).toMatch(/width="0" height="8" fill="#c19c00"/)
  expect(await ui.find({ type: 'Text', text: '--%' })).toBeDefined()
  expect((await ui.find({ key: 'open-context' }))?.props).toMatchObject({
    label: '\u2007'.repeat(12),
  })
  expect(await ui.find({ type: 'Text', text: /\$/ })).toBeUndefined()
  await ui.advance(0)
  expect(await ui.find({ type: 'Text', text: '5s', in: 'elapsed' })).toBeDefined()
  // One before the folder, one between the meter and the timer, one before
  // the pane's button: the cost brings its own hairline, so none is drawn for
  // it yet.
  const dividers = (await ui.findAll({ type: 'Svg' })).filter(one => one.props.alt === 'divider')
  expect(dividers).toHaveLength(3)

  await ui.unmount()
})

test('drops the seconds once the session passes an hour', async ($, on) => {
  mock.clock(on, { now: 2 * 3_600_000 + 5 * 60_000 + 42_000 })
  on('session.model', async () => ({ value: 'Opus 5.5' }))
  on('session.cwd', async () => ({ value: '/home/me/project' }))
  on('session.usage', async () => ({
    value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] },
  }))

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  await ui.advance(0)
  expect(await ui.find({ type: 'Text', text: /^2h 5m$/, in: 'elapsed' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /42s/, in: 'elapsed' })).toBeUndefined()

  await ui.unmount()
})

test('yields the band while a survey holds it', async ($, on) => {
  mock.clock(on)
  on('session.model', async () => ({ value: 'Opus 5.5' }))
  on('session.cwd', async () => ({ value: '/home/me/project' }))
  on('session.usage', async () => ({
    value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] },
  }))
  let isPassed = false
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    isPassed = true
    const { Text } = $.ui.resolve(e)

    return <Text>survey</Text>
  })

  const ui = await $.ui.mount({
    ...BAND,
    surface: 'desktop',
    props: { ...BAND.props, hasSurvey: true },
  })

  expect(isPassed).toBe(true)
  expect(await ui.find({ type: 'Text', text: 'Opus 5.5' })).toBeUndefined()

  await ui.unmount()
})

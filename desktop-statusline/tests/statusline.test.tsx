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
  mock.clock(on, { now: 100_000 })
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

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  const model = await ui.find({ type: 'Text', text: 'Fable 5.1' })
  expect(model?.props).toMatchObject({ color: 'claude', bold: true })
  expect(await ui.find({ type: 'Text', text: 'construct-land' })).toBeDefined()

  const meter = (await ui.findAll({ type: 'Svg' })).find(one => one.props.alt !== 'divider')
  expect(meter?.props).toMatchObject({ alt: 'context 33% used', width: 64, height: 10 })
  expect(String(meter?.props.source)).toMatch(/<rect x="1" y="1" width="20" height="8" fill="#c19c00"/)
  expect(String(meter?.props.source)).toMatch(/stroke="#8a8a8a"/)
  expect(await ui.find({ type: 'Text', text: /33%/ })).toBeDefined()

  expect(await ui.find({ type: 'Text', text: /\$1\.23/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '1m 0s' })).toBeDefined()
  const slot = await ui.find({ type: 'Box', text: /^1m 0s$/ })
  expect(slot?.props).toMatchObject({ width: 7, justifyContent: 'flex-end' })

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
    value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/home/me/project', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect(await ui.find({ type: 'Text', text: 'high' })).toBeDefined()
  const dividers = (await ui.findAll({ type: 'Svg' })).filter(one => one.props.alt === 'divider')
  expect(dividers).toHaveLength(2)
  for (const one of dividers) {
    expect(one.props).toMatchObject({ width: 1, height: 14 })
    expect(String(one.props.source)).toMatch(/fill="#808080" fill-opacity="0.18"/)
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
  const meter = (await ui.findAll({ type: 'Svg' })).find(one => one.props.alt !== 'divider')
  expect(meter?.props).toMatchObject({ alt: 'context: no reading yet' })
  expect(String(meter?.props.source)).toMatch(/width="0" height="8" fill="#c19c00"/)
  expect(await ui.find({ type: 'Text', text: '--%' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '5s' })).toBeDefined()

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

  expect(await ui.find({ type: 'Text', text: /^2h 5m$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /42s/ })).toBeUndefined()

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

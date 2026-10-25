import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, SessionMessage, TurnStepToolUse } from 'claude-code'

const PLUGIN = 'quiet-transcript'
const SURFACES = ['desktop', 'terminal'] as const

type Step = { answer: string; toolUses: TurnStepToolUse[] }

// Stands in for the engine: `history` is the conversation at session start,
// `steps` the model requests' results in order, and every row the app would
// draw itself reads `engine <Component>`.
function engine(on: On, history: SessionMessage[] = [], steps: Step[] = []) {
  let index = 0
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.messages', () => ({ value: history }))
  on('turn.step', async function* (_, e) {
    const step = steps[index++] ?? { answer: '', toolUses: [] }
    return { turnId: e.turnId, index: e.index, ...step, stopReason: 'end_turn' as const, usage: null }
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    const isExpanded = (e.props as { isExpanded?: boolean }).isExpanded === true
    return <Text>{`engine ${e.component}${isExpanded ? ' expanded' : ''}`}</Text>
  })
}

async function start($: Engine) {
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
}

async function step($: Engine) {
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'xhigh', messageCount: 2 })
  for await (const _ of stream) {
    // nothing streams beneath
  }
  await stream.result
}

let messages = 0

function message($: Engine, surface: (typeof SURFACES)[number], text: string, extra: { isSummary?: true } = {}) {
  return $.ui.mount({ plugin: PLUGIN, surface, component: 'AssistantMessage', requestId: `m${++messages}`, props: { text, isFirstOfReply: true, ...extra } })
}

test('the answer is drawn as the app draws it, narration quiet', async ($, on) => {
  engine(on, [], [{ answer: 'Checking the config first.', toolUses: [{ name: 'Read', input: { file_path: '/a/b.ts' } }] }])
  await start($)
  await step($)
  for (const surface of SURFACES) {
    const answer = await message($, surface, 'Done: the build passes now.')
    expect((await answer.find({ type: 'Text' }))?.text).toBe('engine AssistantMessage')
    await answer.unmount()

    const narration = await message($, surface, 'Checking the config first.')
    const row = await narration.find({ type: 'Text' })
    expect(row?.text).toBe('Checking the config first.')
    expect(row?.props).toMatchObject({ italic: true, dimColor: true, color: 'suggestion' })
    await narration.unmount()
  }
})

test('a summary block is quiet, and narration from before the session loaded too', async ($, on) => {
  engine(on, [
    { role: 'user', text: 'fix it', toolUses: [] },
    { role: 'assistant', text: 'Looking at the **logs**.', toolUses: [{ tool_use_id: 'x', tool: 'Bash', input: {} }] },
    { role: 'assistant', text: 'Fixed.', toolUses: [] },
  ])
  await start($)
  const earlier = await message($, 'desktop', 'Looking at the **logs**.')
  expect((await earlier.find({ type: 'Text' }))?.text).toBe('Looking at the logs.')
  const answer = await message($, 'desktop', 'Fixed.')
  expect((await answer.find({ type: 'Text' }))?.text).toBe('engine AssistantMessage')
  const summary = await message($, 'desktop', 'Ran the tests', { isSummary: true })
  expect((await summary.find({ type: 'Text' }))?.props).toMatchObject({ italic: true })
})

test('an edit row is one quiet line with green and red counts, and details opens the app card', async ($, on) => {
  engine(on)
  await start($)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'ToolUse',
      requestId: `edit-${surface}`,
      props: {
        tool_use_id: `edit-${surface}`,
        tool: 'Edit',
        input: { file_path: 'C:\\repo\\src\\app.ts', old_string: 'a', new_string: 'b' },
        isRunning: false,
        isErrored: false,
        isInterrupted: false,
        output: { structuredPatch: [{ lines: [' x', '-old', '+new', '+more'] }] },
      },
    })
    expect((await ui.find({ type: 'Text', text: /Edited src\/app\.ts/ }))?.props).toMatchObject({ italic: true, color: 'suggestion' })
    expect((await ui.find({ type: 'Text', text: '+2' }))?.props).toMatchObject({ color: 'success' })
    expect((await ui.find({ type: 'Text', text: '-1' }))?.props).toMatchObject({ color: 'error' })
    expect((await ui.find({ type: 'Text', text: '+2' }))?.props.dimColor).toBeUndefined()

    await ui.press({ key: 'details' })
    expect(await ui.find({ type: 'Text', text: 'engine ToolUse' })).toBeDefined()
    await ui.press({ key: 'hide' })
    expect(await ui.find({ type: 'Text', text: 'engine ToolUse' })).toBeUndefined()
    await ui.unmount()
  }
})

test('a failed command says so in red; its result stays hidden until opened', async ($, on) => {
  engine(on)
  await start($)
  const props = { tool_use_id: 'b1', tool: 'Bash', input: { command: 'npm test', description: 'Run the tests' }, isRunning: false, isErrored: true, isInterrupted: false }
  const row = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'ToolUse', requestId: 'b1', props })
  expect(await row.find({ type: 'Text', text: /Ran Run the tests/ })).toBeDefined()
  expect((await row.find({ type: 'Text', text: 'failed' }))?.props).toMatchObject({ color: 'error' })

  const result = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'desktop',
    component: 'ToolResult',
    requestId: 'b1',
    props: { tool_use_id: 'b1', tool: 'Bash', output: { stdout: '1 failing' }, isErrored: true },
  })
  expect(await result.find({ type: 'Text', text: 'engine ToolResult' })).toBeUndefined()
  // Opening the row redraws the result already on screen.
  await row.press({ key: 'details' })
  expect(await result.find({ type: 'Text', text: 'engine ToolResult' })).toBeDefined()
})

test('a tool group is one quiet count line; details unfolds it as the app does', async ($, on) => {
  engine(on)
  await start($)
  const call = (tool: string, isErrored = false) => ({ tool, input: {}, isRunning: false, isErrored, isInterrupted: false })
  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'desktop',
    component: 'ToolGroup',
    requestId: 'g1',
    props: { calls: [call('Read'), call('Read'), call('Grep'), call('Bash', true)], isActive: false, isExpanded: false },
  })
  expect((await ui.find({ type: 'Text', text: /Read 2 files, searched 1 pattern, ran 1 command/ }))?.props).toMatchObject({ italic: true })
  expect((await ui.find({ type: 'Text', text: '1 failed' }))?.props).toMatchObject({ color: 'error' })
  await ui.press({ key: 'details' })
  expect(await ui.find({ type: 'Text', text: 'engine ToolGroup expanded' })).toBeDefined()
})

test('rows the view already shows in full, and errors, are left to the app', async ($, on) => {
  engine(on)
  await start($)
  const expanded = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'ToolUse',
    requestId: 'r1',
    props: { tool_use_id: 'r1', tool: 'Read', input: { file_path: '/x' }, isRunning: false, isErrored: false, isInterrupted: false, isExpanded: true },
  })
  expect(await expanded.find({ type: 'Text', text: 'engine ToolUse expanded' })).toBeDefined()

  const failedCommand = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'desktop',
    component: 'CommandOutput',
    requestId: 'c1',
    props: { command: 'cost', args: '', text: 'boom', isErrored: true },
  })
  expect(await failedCommand.find({ type: 'Text', text: 'engine CommandOutput' })).toBeDefined()

  const output = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'desktop',
    component: 'CommandOutput',
    requestId: 'c2',
    props: { command: 'cost', args: '', text: 'Total: $1', isErrored: false },
  })
  expect((await output.find({ type: 'Markdown' }))?.props).toMatchObject({ dimColor: true, text: 'Total: $1' })
})

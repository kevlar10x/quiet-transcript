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

// Stores a row of the main conversation as a session does: a response one block per row.
function store($: Engine, uuid: string, block: Record<string, unknown>) {
  const door = block.type === 'tool_result' ? 'tool-result' : 'response'
  const origin = door === 'response' ? { kind: 'model' as const, model: 'claude-opus-5-5' } : { kind: 'tool' as const, tool: 'Bash' }
  const type = door === 'response' ? 'assistant' : 'user'
  return $.session.append({ message: { type, role: type, content: [block] }, door, origin, uuid } as never)
}

const said = (text: string) => ({ type: 'text', text })
const ran = (id: string) => ({ type: 'tool_use', id, name: 'Bash', input: { command: 'deploy' } })
const result = (id: string) => ({ type: 'tool_result', tool_use_id: id, content: 'ok' })

function row($: Engine, surface: (typeof SURFACES)[number], uuid: string, text: string) {
  return $.ui.mount({ plugin: PLUGIN, surface, component: 'AssistantMessage', requestId: uuid, props: { text, isFirstOfReply: true } })
}

test('text written beside a tool call is quiet; the answer is drawn as the app draws it', async ($, on) => {
  engine(on)
  await start($)
  await store($, 'n1', said('Checking the config first.'))
  await store($, 't1', ran('t1'))
  await store($, 'r1', result('t1'))
  await store($, 'a1', said('Done: the build passes now.'))
  for (const surface of SURFACES) {
    const narration = await row($, surface, 'n1', 'Checking the config first.')
    const quiet = await narration.find({ type: 'Text' })
    expect(quiet?.text).toBe('Checking the config first.')
    expect(quiet?.props).toMatchObject({ italic: true, dimColor: true, color: 'suggestion' })
    await narration.unmount()

    const answer = await row($, surface, 'a1', 'Done: the build passes now.')
    expect((await answer.find({ type: 'Text' }))?.text).toBe('engine AssistantMessage')
    await answer.unmount()
  }
})

test('an answer that repeats earlier narration word for word keeps its look', async ($, on) => {
  engine(on)
  await start($)
  await store($, 'n1', said('The deployment completed successfully.'))
  await store($, 't1', ran('t1'))
  await store($, 'r1', result('t1'))
  await store($, 'a1', said('The deployment completed successfully.'))
  for (const surface of SURFACES) {
    const answer = await row($, surface, 'a1', 'The deployment completed successfully.')
    expect((await answer.find({ type: 'Text' }))?.text).toBe('engine AssistantMessage')
    await answer.unmount()
    const narration = await row($, surface, 'n1', 'The deployment completed successfully.')
    expect((await narration.find({ type: 'Text' }))?.props).toMatchObject({ italic: true })
    await narration.unmount()
  }
})

test('a row that holds both the text and the tool call is narration', async ($, on) => {
  engine(on)
  await start($)
  await $.session.append({
    message: { type: 'assistant', role: 'assistant', content: [said('Running the deploy.'), ran('t1')] },
    door: 'response',
    origin: { kind: 'model', model: 'claude-opus-5-5' },
    uuid: 'both',
  } as never)
  const narration = await row($, 'terminal', 'both', 'Running the deploy.')
  expect((await narration.find({ type: 'Text' }))?.props).toMatchObject({ italic: true })
})

test('where no row id reaches the mod, text is matched by the steps, and an answer never goes quiet', async ($, on) => {
  const deploy = { name: 'Bash', input: { command: 'deploy' } }
  engine(on, [], [
    { answer: 'Checking the config first.', toolUses: [deploy] },
    { answer: 'The deployment completed successfully.', toolUses: [deploy] },
    { answer: 'The deployment completed successfully.', toolUses: [] },
  ])
  await start($)
  await step($)
  await step($)
  await step($)
  for (const surface of SURFACES) {
    const narration = await message($, surface, 'Checking the config first.')
    expect((await narration.find({ type: 'Text' }))?.props).toMatchObject({ italic: true, color: 'suggestion' })
    await narration.unmount()
    const answer = await message($, surface, 'The deployment completed successfully.')
    expect((await answer.find({ type: 'Text' }))?.text).toBe('engine AssistantMessage')
    await answer.unmount()
  }
})

test('a summary block is quiet, and narration from before the session loaded too', async ($, on) => {
  engine(on, [
    { role: 'user', text: 'fix it', toolUses: [] },
    { role: 'assistant', text: 'Looking at the **logs**.', toolUses: [{ tool_use_id: 'x', tool: 'Bash', input: {} }] },
    { role: 'assistant', text: 'Fixed.', toolUses: [{ tool_use_id: 'y', tool: 'Bash', input: {} }] },
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

test('an edit with no stored result (the desktop) counts its lines from the edit itself', async ($, on) => {
  engine(on)
  await start($)
  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'desktop',
    component: 'ToolUse',
    requestId: 'e2',
    props: {
      tool_use_id: 'e2',
      tool: 'Edit',
      input: { file_path: '/repo/tip.py', old_string: 'def split(a):\n    return a', new_string: 'def split(a):\n    if a == 0:\n        raise ValueError\n    return round(a, 2)' },
      isRunning: false,
      isErrored: false,
      isInterrupted: false,
    },
  })
  expect((await ui.find({ type: 'Text', text: '+3' }))?.props).toMatchObject({ color: 'success' })
  expect((await ui.find({ type: 'Text', text: '-1' }))?.props).toMatchObject({ color: 'error' })
})

test('a command with no description says what ran', async ($, on) => {
  engine(on)
  await start($)
  const props = { tool_use_id: 'b2', tool: 'Bash', input: { command: 'python tip.py' }, isRunning: false, isErrored: false, isInterrupted: false }
  const row = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'ToolUse', requestId: 'b2', props })
  expect((await row.find({ type: 'Text', text: /tip\.py/ }))?.text).toBe('Ran python tip.py')
})

test('a failed command says so in red; its result stays hidden until opened', async ($, on) => {
  engine(on)
  await start($)
  const props = { tool_use_id: 'b1', tool: 'Bash', input: { command: 'npm test', description: 'Run the tests' }, isRunning: false, isErrored: true, isInterrupted: false }
  const row = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'ToolUse', requestId: 'b1', props })
  expect((await row.find({ type: 'Text', text: /the tests/ }))?.text).toBe('Run the tests')
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
    surface: 'terminal',
    component: 'ToolGroup',
    requestId: 'g1',
    props: { calls: [call('Read'), call('Read'), call('Grep'), call('Bash', true)], isActive: false, isExpanded: false },
  })
  expect((await ui.find({ type: 'Text', text: /Read 2 files, searched 1 pattern, ran 1 command/ }))?.props).toMatchObject({ italic: true })
  expect((await ui.find({ type: 'Text', text: '1 failed' }))?.props).toMatchObject({ color: 'error' })
  await ui.press({ key: 'details' })
  expect(await ui.find({ type: 'Text', text: 'engine ToolGroup expanded' })).toBeDefined()
})

test('on the desktop a tool group is left to the app, which already folds it under its own row', async ($, on) => {
  engine(on)
  await start($)
  const call = (tool: string) => ({ tool, input: {}, isRunning: false, isErrored: false, isInterrupted: false })
  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'desktop',
    component: 'ToolGroup',
    requestId: 'g2',
    props: { calls: [call('Read'), call('Bash')], isActive: false, isExpanded: false },
  })
  expect(await ui.find({ type: 'Text', text: 'engine ToolGroup' })).toBeDefined()
  expect(await ui.find({ type: 'Button' })).toBeUndefined()
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

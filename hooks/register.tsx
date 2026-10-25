import { atom, memberOf, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register, ToolGroupCall } from 'claude-code'

// Quiets everything the transcript shows except Claude's answers. An answer is
// the text of a model request that called no tool; text written before a tool
// call is narration. Narration, tool rows, tool groups and command output draw
// in one quiet style, while added and removed line counts and failures keep
// their colors. Each quieted tool row has a "details" button that brings back
// the app's own full card.

const narration = atom({ plugin: 'quiet-transcript', key: 'narration' } as const, [])
const isOpen = atom({ plugin: 'quiet-transcript', key: 'isOpen' } as const, false)

// Italic, in the theme's suggestion tint, dimmed: set apart from the app's own grey rows.
const QUIET = { color: 'suggestion', dimColor: true, italic: true } as const
const KEEP_HASHES = 2000

// FNV-1a over a paragraph with its whitespace collapsed.
function hash(text: string) {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

function hashesOf(text: string) {
  return text
    .split(/\n\s*\n/)
    .map(p => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map(hash)
}

// Markdown to plain text, for narration drawn as one quiet Text.
function plain(text: string) {
  return text
    .replace(/```[^\n]*\n?/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, '$1$2')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .trim()
}

function short(text: string, room = 70) {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > room ? `${line.slice(0, room - 1)}…` : line
}

function fileName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).slice(-2).join('/')
}

// One line saying what a tool call did.
function describe(tool: string, input: unknown) {
  const fields = (input ?? {}) as Record<string, unknown>
  const field = (name: string) => (typeof fields[name] === 'string' ? (fields[name] as string) : '')
  switch (tool) {
    case 'Bash':
    case 'PowerShell':
      return `Ran ${short(field('description') || field('command'))}`
    case 'Read':
      return `Read ${fileName(field('file_path'))}`
    case 'Edit':
    case 'MultiEdit':
      return `Edited ${fileName(field('file_path'))}`
    case 'Write':
      return `Wrote ${fileName(field('file_path'))}`
    case 'NotebookEdit':
      return `Edited ${fileName(field('notebook_path'))}`
    case 'Glob':
      return `Listed ${short(field('pattern'))}`
    case 'Grep':
      return `Searched for ${short(field('pattern'))}`
    case 'WebFetch':
      return `Fetched ${short(field('url'))}`
    case 'WebSearch':
      return `Searched the web for ${short(field('query'))}`
    case 'Agent':
    case 'Task':
      return `Agent: ${short(field('description'))}`
    case 'Skill':
      return `Used skill ${field('skill')}`
  }
  if (tool.startsWith('mcp__')) {
    const [, server = '', name = tool] = tool.split('__')
    const where = server.length <= 24 ? ` (${server.replace(/_/g, ' ')})` : ''
    return `${name.replace(/_/g, ' ')}${where}`
  }
  const first = Object.values(fields).find((v): v is string => typeof v === 'string')
  return first ? `${tool} ${short(first, 50)}` : tool
}

// Added and removed lines of an edit or write, from its stored result.
function lineCounts(tool: string, output: unknown) {
  const result = (output ?? {}) as { structuredPatch?: { lines?: string[] }[]; type?: string; content?: string }
  let added = 0
  let removed = 0
  for (const hunk of result.structuredPatch ?? []) {
    for (const line of hunk.lines ?? []) {
      if (line.startsWith('+')) added++
      else if (line.startsWith('-')) removed++
    }
  }
  if (tool === 'Write' && result.type === 'create' && added === 0 && typeof result.content === 'string') {
    added = result.content.split('\n').length
  }
  return { added, removed }
}

function groupLine(calls: ReadonlyArray<ToolGroupCall>) {
  const counts = new Map<string, number>()
  for (const call of calls) {
    const kind =
      call.tool === 'Read' ? 'read' : call.tool === 'Grep' || call.tool === 'Glob' ? 'search' : call.tool === 'Bash' || call.tool === 'PowerShell' ? 'command' : 'other'
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
  }
  const parts: string[] = []
  const n = (kind: string) => counts.get(kind) ?? 0
  if (n('read')) parts.push(`read ${n('read')} ${n('read') === 1 ? 'file' : 'files'}`)
  if (n('search')) parts.push(`searched ${n('search')} ${n('search') === 1 ? 'pattern' : 'patterns'}`)
  if (n('command')) parts.push(`ran ${n('command')} ${n('command') === 1 ? 'command' : 'commands'}`)
  if (n('other')) parts.push(`${n('other')} other ${n('other') === 1 ? 'call' : 'calls'}`)
  const line = parts.join(', ')
  return line.charAt(0).toUpperCase() + line.slice(1)
}

async function remember($: Engine, text: string) {
  const hashes = hashesOf(text)
  if (hashes.length === 0) return
  await update($, narration, list => [...new Set([...list, ...hashes])].slice(-KEEP_HASHES))
}

export const register: Register = on => {
  // Narration already in the conversation (a resumed session) is quiet from the start.
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const rows = await $.session.messages()
    const earlier = rows.filter(row => row.role === 'assistant' && row.toolUses.length > 0 && row.text.trim())
    for (const row of earlier) await remember($, row.text)
    return started
  })

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (e.agentId === undefined && result.toolUses.length > 0 && result.answer.trim()) await remember($, result.answer)
    return result
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const known = new Set(await read($, narration))
    const hashes = hashesOf(e.props.text)
    const isNarration = e.props.isSummary === true || (hashes.length > 0 && hashes.every(h => known.has(h)))
    if (!isNarration) return next(e)
    const { Text } = $.ui.resolve(e)
    return <Text {...QUIET}>{plain(e.props.text)}</Text>
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (e.props.isExpanded) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const open = memberOf(isOpen, e)
    if (await read($, open)) {
      return (
        <Box flexDirection="column">
          {await next(e)}
          <Button key="hide" plain dimColor label="hide details" onPress={() => update($, open, () => false)} />
        </Box>
      )
    }
    const { added, removed } = lineCounts(e.props.tool, e.props.output)
    return (
      <Box flexDirection="row" gap={1}>
        <Text {...QUIET}>
          {describe(e.props.tool, e.props.input)}
          {e.props.isRunning ? ' …' : ''}
        </Text>
        {added > 0 && <Text color="success">+{added}</Text>}
        {removed > 0 && <Text color="error">-{removed}</Text>}
        {e.props.isErrored && !e.props.isInterrupted && <Text color="error">failed</Text>}
        {e.props.isInterrupted && <Text {...QUIET}>interrupted</Text>}
        <Button key="details" plain dimColor label="details" onPress={() => update($, open, () => true)} />
      </Box>
    )
  })

  // A standalone result shows only while its row is opened.
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (e.props.isExpanded || (await read($, memberOf(isOpen, e)))) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (e.props.isExpanded) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const open = memberOf(isOpen, e)
    if (await read($, open)) {
      return (
        <Box flexDirection="column">
          {await next({ ...e, props: { ...e.props, isExpanded: true } })}
          <Button key="hide" plain dimColor label="hide details" onPress={() => update($, open, () => false)} />
        </Box>
      )
    }
    const failed = e.props.calls.filter(call => call.isErrored && !call.isInterrupted).length
    return (
      <Box flexDirection="row" gap={1}>
        <Text {...QUIET}>
          {groupLine(e.props.calls)}
          {e.props.isActive ? ' …' : ''}
        </Text>
        {failed > 0 && <Text color="error">{failed} failed</Text>}
        <Button key="details" plain dimColor label="details" onPress={() => update($, open, () => true)} />
      </Box>
    )
  })

  on('ui.render', { component: 'CommandOutput' }, async ($, e, next) => {
    if (e.props.isErrored) return next(e)
    const { Markdown } = $.ui.resolve(e)
    return <Markdown text={e.props.text} dimColor />
  })
}

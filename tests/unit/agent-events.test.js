import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseAgentEvents, extractAgentText } from '../../plugin/lib/core/agent-events.js'

const CLAUDE_EVENTS = [
  JSON.stringify({ type: 'system', subtype: 'init' }),
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Hello ' }] } }),
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'world' }] } }),
  JSON.stringify({ type: 'result', subtype: 'success', result: 'Hello world' }),
  JSON.stringify({ type: 'instabox.turn_end', data: { exitCode: 0 } }),
]

const CODEX_EVENTS = [
  JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
  JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Codex reply' } }),
  JSON.stringify({ type: 'turn.completed', usage: {} }),
]

test('parses Claude stream-json events and extracts text', () => {
  const events = parseAgentEvents(CLAUDE_EVENTS.join('\n'))
  const { text, turnEndExitCode, sawTurnEnd } = extractAgentText(events)
  assert.equal(text, 'Hello \nworld')
  assert.equal(turnEndExitCode, 0)
  assert.equal(sawTurnEnd, true)
})

test('parses Codex item.completed agent_message', () => {
  const events = parseAgentEvents(CODEX_EVENTS.join('\n'))
  const { text } = extractAgentText(events)
  assert.equal(text, 'Codex reply')
})

test('ignores malformed lines and non-text events', () => {
  const raw = ['not json', '{"type":"assistant","message":{"content":[{"type":"tool_use"}]}}', '', CLAUDE_EVENTS[1]].join('\n')
  const events = parseAgentEvents(raw)
  const { text } = extractAgentText(events)
  assert.equal(text, 'Hello ')
})

test('generic text field fallback', () => {
  const events = parseAgentEvents(JSON.stringify({ text: 'plain reply' }))
  assert.equal(extractAgentText(events).text, 'plain reply')
})

test('empty input yields empty text and no turn end', () => {
  const { text, sawTurnEnd } = extractAgentText(parseAgentEvents(''))
  assert.equal(text, '')
  assert.equal(sawTurnEnd, false)
})

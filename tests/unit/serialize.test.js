import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderTranscript, serializeSession } from '../../plugin/lib/core/serialize.js'

const IMAGE_REF = {
  attachmentId: 'sha256:abc',
  mediaType: 'image/png',
  bytes: 1024,
  width: 32,
  height: 32,
  name: 'shot.png',
}

function events() {
  return [
    { seq: 0, time: 1000, type: 'turn/start', data: { turn: 1 } },
    {
      seq: 1,
      time: 1010,
      type: 'user/message',
      data: { id: 'm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Please read x' }] },
    },
    { seq: 2, time: 1020, type: 'step/start', data: { turn: 1, step: 1 } },
    {
      seq: 3,
      time: 1030,
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'a1',
          role: 'assistant',
          source: { kind: 'model', provider: 'p', model: 'm' },
          content: [
            { type: 'text', text: 'Reading it.' },
            { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{"path":"x"}' },
          ],
        },
        usage: { inputTokens: 5, outputTokens: 3 },
      },
    },
    { seq: 4, time: 1040, type: 'tool/call', data: { turn: 1, step: 1, callId: 'call-1', name: 'read', arguments: '{"path":"x"}' } },
    {
      seq: 5,
      time: 1050,
      type: 'tool/result',
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 't1',
          role: 'user',
          source: { kind: 'tool', callId: 'call-1' },
          content: [{ type: 'tool-result', toolCallId: 'call-1', isError: false, content: [{ type: 'text', text: 'file body' }] }],
        },
      },
    },
    { seq: 6, time: 1060, type: 'step/end', data: { turn: 1, step: 1 } },
    { seq: 7, time: 1070, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    { seq: 8, time: 1080, type: 'turn/start', data: { turn: 2 } },
    {
      seq: 9,
      time: 1090,
      type: 'user/message',
      data: {
        id: 'm2',
        role: 'user',
        source: { kind: 'user' },
        content: [
          { type: 'text', text: 'Next task' },
          { type: 'image', attachment: IMAGE_REF },
        ],
      },
    },
  ]
}

test('serializes messages, ordering, tool links, task and execution state', () => {
  const result = serializeSession({ events: events(), agentStatus: 'running' })
  assert.deepEqual(
    result.conversation.messages.map((message) => [message.seq, message.role, message.id]),
    [
      [1, 'user', 'm1'],
      [3, 'assistant', 'a1'],
      [5, 'user', 't1'],
      [9, 'user', 'm2'],
    ],
  )
  assert.equal(result.conversation.messages[0].time, 1010)
  assert.equal(result.conversation.messages[1].usage.outputTokens, 3)
  assert.equal(result.conversation.messages[2].source.callId, 'call-1')
  assert.equal(result.conversation.firstSeq, 0)
  assert.equal(result.conversation.lastSeq, 9)
  assert.equal(result.conversation.messageCount, 4)

  assert.equal(result.conversation.toolCallLinks.length, 1)
  assert.deepEqual(result.conversation.toolCallLinks[0], {
    callId: 'call-1',
    name: 'read',
    callSeq: 4,
    modelCallSeq: 3,
    resultSeq: 5,
  })
  assert.deepEqual(result.conversation.toolCalls, [
    { callId: 'call-1', seq: 4, time: 1040, turn: 1, step: 1, name: 'read', arguments: '{"path":"x"}' },
  ])
  assert.equal(result.conversation.toolResults[0].isError, false)
  assert.deepEqual(result.task.openToolCalls, [])
  assert.equal(result.task.lastUserMessageId, 'm2')
  assert.equal(result.task.lastUserText, 'Next task')

  assert.equal(result.execution.status, 'open')
  assert.equal(result.execution.turn, 2)
  assert.equal(result.execution.agentStatus, 'running')
  assert.equal(result.execution.lastTurnEnd.kind, 'completed')

  assert.equal(result.attachments.length, 1)
  assert.equal(result.attachments[0].attachmentId, IMAGE_REF.attachmentId)
  assert.equal(result.attachments[0].messageSeq, 9)
})

test('open tool calls and interrupted turns are visible', () => {
  const list = [
    { seq: 0, time: 1, type: 'turn/start', data: { turn: 1 } },
    {
      seq: 1,
      time: 2,
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'a1',
          role: 'assistant',
          source: { kind: 'model', provider: 'p', model: 'm' },
          content: [{ type: 'tool-call', id: 'call-open', name: 'bash', arguments: '{"cmd":"ls"}' }],
        },
      },
    },
    { seq: 2, time: 3, type: 'tool/call', data: { turn: 1, step: 1, callId: 'call-open', name: 'bash', arguments: '{"cmd":"ls"}' } },
    { seq: 3, time: 4, type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { code: 'X' } } } },
  ]
  const result = serializeSession({ events: list })
  assert.deepEqual(result.task.openToolCalls, [
    { callId: 'call-open', name: 'bash', callSeq: 2, arguments: '{"cmd":"ls"}' },
  ])
  assert.equal(result.execution.status, 'idle')
  assert.equal(result.execution.interruptions.length, 1)
  assert.equal(result.execution.interruptions[0].kind, 'error')
})

test('pending inbox and latest todo are summarized', () => {
  const result = serializeSession({
    events: [
      { seq: 1, time: 1, type: 'todo/write', data: { todos: [{ id: 't', text: 'do it', status: 'pending' }] } },
    ],
    inbox: { nextTurn: [{ id: 'q1', source: { kind: 'user' }, content: [{ type: 'text', text: 'queued' }] }], nextStep: [] },
  })
  assert.equal(result.task.latestTodo[0].text, 'do it')
  assert.deepEqual(result.task.pendingInbox[0], { queue: 'next-turn', id: 'q1', source: { kind: 'user' }, text: 'queued' })
})

test('renderTranscript renders roles, seqs and tool activity', () => {
  const result = serializeSession({ events: events() })
  const transcript = renderTranscript(result.conversation)
  assert.match(transcript, /### user \[seq 1, /)
  assert.match(transcript, /\(tool call read\) \{"path":"x"\}/)
  assert.match(transcript, /\(tool result\) file body/)
  assert.match(transcript, /\(image attachment sha256:abc\)/)
})

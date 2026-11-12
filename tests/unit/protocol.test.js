import assert from 'node:assert/strict'
import { test } from 'node:test'
import { digestOf } from '../../plugin/lib/core/canonical.js'
import {
  ACK_VERSION,
  PROTOCOL_VERSION,
  ProtocolError,
  assertAck,
  assertPayload,
  buildAckMarker,
  createAck,
  createPayload,
  parseAckMarker,
} from '../../plugin/lib/core/protocol.js'

function parts(overrides = {}) {
  return {
    handoffId: 'handoff-abc-1234',
    createdAt: 1700000000000,
    source: {
      harness: 'deepseek-harness',
      sessionId: 'session-test',
      sessionCreatedAt: 1699999999000,
      cwd: 'C:/work',
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
    },
    instructions: {
      systemPrompt: 'You are a helpful agent.',
      agentConfig: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      userPreferences: {},
    },
    conversation: {
      firstSeq: 1,
      lastSeq: 4,
      messageCount: 1,
      messages: [
        {
          seq: 1,
          time: 1699999999500,
          turn: 1,
          step: 1,
          role: 'user',
          id: 'msg-1',
          source: { kind: 'user' },
          content: [{ type: 'text', text: 'Hello' }],
        },
      ],
      toolCalls: [],
      toolResults: [],
      toolCallLinks: [],
    },
    task: { lastUserMessageId: 'msg-1', lastUserText: 'Hello', openToolCalls: [], pendingInbox: [] },
    execution: { turn: 1, step: 1, status: 'idle' },
    tools: [{ name: 'read', description: 'Read a file', parameters: { type: 'object' } }],
    permissions: { toolNames: ['read'], note: 'host-side' },
    attachments: [],
    reason: 'explicit handoff',
    ...overrides,
  }
}

test('createPayload produces a self-verifying document', () => {
  const payload = createPayload(parts())
  assert.equal(payload.protocol, PROTOCOL_VERSION)
  assert.equal(payload.digest, digestOf(payload))
  assert.equal(assertPayload(payload), undefined)
})

test('tampering is detected', () => {
  const payload = createPayload(parts())
  payload.task.lastUserText = 'tampered'
  assert.throws(() => assertPayload(payload), (error) => error instanceof ProtocolError && error.code === 'PAYLOAD_DIGEST_MISMATCH')
})

test('structural problems are reported, including count mismatches and credentials', () => {
  const payload = createPayload(parts())
  payload.conversation.messageCount = 99
  delete payload.digest
  assert.throws(() => assertPayload(payload, { verifyDigest: false }), /messageCount/)
  const withSecret = createPayload(parts())
  withSecret.credentials = { token: 'x' }
  delete withSecret.digest
  assert.throws(() => assertPayload(withSecret, { verifyDigest: false }), /credentials/)
})

test('payload size is bounded', () => {
  const payload = createPayload(parts())
  assert.throws(
    () => assertPayload(payload, { maxBytes: 100 }),
    (error) => error instanceof ProtocolError && error.code === 'PAYLOAD_TOO_LARGE',
  )
})

test('acknowledgements must match handoff identity, digest and counts', () => {
  const payload = createPayload(parts())
  const ack = createAck({
    handoffId: payload.handoffId,
    digest: payload.digest,
    digestMatch: true,
    schemaValid: true,
    messageCount: payload.conversation.messageCount,
    attachmentCount: payload.attachments.length,
    receivedAt: 1700000000100,
  })
  assert.equal(ack.protocol, ACK_VERSION)
  assert.equal(assertAck(ack, payload).handoffId, payload.handoffId)

  assert.throws(() => assertAck({ ...ack, handoffId: 'other-handoff-id' }, payload), /different handoff/)
  assert.throws(() => assertAck({ ...ack, digest: 'nope' }, payload), /digest/)
  assert.throws(() => assertAck({ ...ack, digestMatch: false }, payload), /digest did not match/)
  assert.throws(() => assertAck({ ...ack, messageCount: 2 }, payload), /ingested 2 messages/)
})

test('agent acknowledgement marker round-trips', () => {
  const payload = createPayload(parts())
  const marker = buildAckMarker(payload.handoffId, payload.digest)
  const text = `Ingested the context.\n${marker}\nReady for the next message.`
  const parsed = parseAckMarker(text)
  assert.equal(parsed.handoffId, payload.handoffId)
  assert.equal(parsed.digestPrefix, payload.digest.slice(0, 12))
  assert.equal(parseAckMarker('no marker here'), null)
})

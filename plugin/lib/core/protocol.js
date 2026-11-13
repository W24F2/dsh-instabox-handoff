/**
 * Handoff protocol v1: payload construction/validation, acknowledgement
 * validation, and the agent acknowledgement marker.
 *
 * The protocol is transport-neutral. InstaBox has no native conversation-import
 * endpoint, so the payload is pushed as a file into the box and verified there
 * before the box-side agent is asked to continue the conversation. The digest
 * makes "the file that arrived" provably the file that was produced here.
 *
 * @module instabox-bridge/core/protocol
 */
import { randomUUID } from 'node:crypto'
import { canonicalByteLength, digestOf } from './canonical.js'

export const PROTOCOL_VERSION = 'instabox-handoff/v1'
export const ACK_VERSION = 'instabox-handoff-ack/v1'

/** Maximum default payload size (bytes, canonical JSON). */
export const DEFAULT_MAX_PAYLOAD_BYTES = 32 * 1024 * 1024

export class ProtocolError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message)
    this.name = 'ProtocolError'
    this.code = code
  }
}

const BLOCK_TYPES = new Set(['text', 'reasoning', 'image', 'tool-call', 'tool-result'])
const ROLES = new Set(['user', 'assistant'])
const FORBIDDEN_TOP_LEVEL = new Set([
  'credentials',
  'secrets',
  'apikey',
  'api_key',
  'env',
  'environment',
])

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** @param {unknown} value @returns {boolean} */
function isFiniteInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) && Number.isFinite(value)
}

/**
 * Build a validated payload document with its digest.
 * @param {object} parts
 * @returns {Record<string, unknown>}
 */
export function createPayload(parts) {
  const payload = {
    protocol: PROTOCOL_VERSION,
    handoffId: parts.handoffId ?? randomUUID(),
    createdAt: parts.createdAt ?? Date.now(),
    source: parts.source,
    instructions: parts.instructions,
    conversation: parts.conversation,
    task: parts.task,
    execution: parts.execution,
    tools: parts.tools ?? [],
    permissions: parts.permissions ?? { toolNames: [], note: 'approval policy is host-side and not enumerable' },
    attachments: parts.attachments ?? [],
    ...(parts.memory ? { memory: parts.memory } : {}),
    reason: parts.reason ?? 'explicit handoff',
    redactions: parts.redactions ?? [],
  }
  assertPayload(payload, { verifyDigest: false })
  payload.digest = digestOf(payload)
  return payload
}

/**
 * Validate a payload document. Throws {@link ProtocolError} with the first
 * actionable problems, never a bare TypeError.
 * @param {unknown} payload
 * @param {object} [options]
 * @param {boolean} [options.verifyDigest]
 * @param {number} [options.maxBytes]
 * @returns {void}
 */
export function assertPayload(payload, options = {}) {
  const { verifyDigest = true, maxBytes = DEFAULT_MAX_PAYLOAD_BYTES } = options
  const problems = []
  const fail = (message) => {
    problems.push(message)
  }

  if (!isObject(payload)) throw new ProtocolError('PAYLOAD_INVALID', 'payload must be a plain object')

  for (const key of Object.keys(payload)) {
    if (FORBIDDEN_TOP_LEVEL.has(key.toLowerCase())) fail(`$${'.' + key}: credentials must never be part of a payload`)
  }
  if (payload.protocol !== PROTOCOL_VERSION) fail(`$.protocol: expected ${PROTOCOL_VERSION}`)
  if (typeof payload.handoffId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(payload.handoffId)) {
    fail('$.handoffId: expected 8-64 safe characters')
  }
  if (!isFiniteInteger(payload.createdAt) || payload.createdAt < 0) fail('$.createdAt: expected epoch milliseconds')

  const source = payload.source
  if (!isObject(source)) fail('$.source: expected an object')
  else {
    if (source.harness !== 'deepseek-harness') fail('$.source.harness: expected "deepseek-harness"')
    if (typeof source.sessionId !== 'string' || source.sessionId.length === 0) fail('$.source.sessionId: expected a session id')
    if (source.sessionCreatedAt !== undefined && !isFiniteInteger(source.sessionCreatedAt)) {
      fail('$.source.sessionCreatedAt: expected epoch milliseconds')
    }
  }

  const instructions = payload.instructions
  if (!isObject(instructions)) fail('$.instructions: expected an object')
  else {
    if (typeof instructions.systemPrompt !== 'string') fail('$.instructions.systemPrompt: expected a string')
    if (!isObject(instructions.agentConfig)) fail('$.instructions.agentConfig: expected an object')
    if (instructions.userPreferences !== undefined && !isObject(instructions.userPreferences)) {
      fail('$.instructions.userPreferences: expected an object')
    }
  }

  const conversation = payload.conversation
  if (!isObject(conversation)) fail('$.conversation: expected an object')
  else {
    if (!Array.isArray(conversation.messages)) fail('$.conversation.messages: expected an array')
    else {
      if (conversation.messageCount !== conversation.messages.length) {
        fail('$.conversation.messageCount: does not match messages length')
      }
      let previousSeq = -1
      conversation.messages.forEach((message, index) => {
        const path = `$.conversation.messages[${index}]`
        if (!isObject(message)) return fail(`${path}: expected an object`)
        if (!isFiniteInteger(message.seq) || message.seq < 0) fail(`${path}.seq: expected a non-negative integer`)
        else if (message.seq <= previousSeq) fail(`${path}.seq: must increase`)
        else previousSeq = message.seq
        if (!isFiniteInteger(message.time) || message.time < 0) fail(`${path}.time: expected epoch milliseconds`)
        if (!ROLES.has(message.role)) fail(`${path}.role: expected user or assistant`)
        if (typeof message.id !== 'string' || message.id.length === 0) fail(`${path}.id: expected a message id`)
        if (!isObject(message.source) || typeof message.source.kind !== 'string') fail(`${path}.source: expected a source object`)
        if (!Array.isArray(message.content)) return fail(`${path}.content: expected an array`)
        message.content.forEach((block, blockIndex) => {
          const blockPath = `${path}.content[${blockIndex}]`
          if (!isObject(block)) return fail(`${blockPath}: expected an object`)
          if (!BLOCK_TYPES.has(block.type)) return fail(`${blockPath}.type: unsupported block type "${String(block.type)}"`)
          if ((block.type === 'text' || block.type === 'reasoning') && typeof block.text !== 'string') {
            fail(`${blockPath}.text: expected a string`)
          }
          if (block.type === 'tool-call') {
            if (typeof block.id !== 'string' || block.id.length === 0) fail(`${blockPath}.id: expected a call id`)
            if (typeof block.name !== 'string' || block.name.length === 0) fail(`${blockPath}.name: expected a tool name`)
            if (typeof block.arguments !== 'string') fail(`${blockPath}.arguments: expected the raw argument string`)
          }
          if (block.type === 'tool-result') {
            if (typeof block.toolCallId !== 'string' || block.toolCallId.length === 0) {
              fail(`${blockPath}.toolCallId: expected a call id`)
            }
            if (!Array.isArray(block.content)) fail(`${blockPath}.content: expected an array`)
          }
          if (block.type === 'image') {
            if (!isObject(block.attachment) || typeof block.attachment.attachmentId !== 'string') {
              fail(`${blockPath}.attachment: expected an attachment reference`)
            }
          }
        })
      })
    }
    for (const field of ['toolCalls', 'toolResults', 'toolCallLinks']) {
      if (conversation[field] !== undefined && !Array.isArray(conversation[field])) {
        fail(`$.conversation.${field}: expected an array`)
      }
    }
    for (const [index, entry] of (conversation.toolCalls ?? []).entries()) {
      if (!isObject(entry) || typeof entry.callId !== 'string' || typeof entry.name !== 'string') {
        fail(`$.conversation.toolCalls[${index}]: expected callId and name`)
      }
    }
    for (const [index, entry] of (conversation.toolResults ?? []).entries()) {
      if (!isObject(entry) || typeof entry.callId !== 'string') {
        fail(`$.conversation.toolResults[${index}]: expected callId`)
      }
    }
    for (const [index, link] of (conversation.toolCallLinks ?? []).entries()) {
      if (!isObject(link) || typeof link.callId !== 'string') fail(`$.conversation.toolCallLinks[${index}]: expected callId`)
      if (link.resultSeq !== null && link.resultSeq !== undefined && !isFiniteInteger(link.resultSeq)) {
        fail(`$.conversation.toolCallLinks[${index}].resultSeq: expected an integer or null`)
      }
    }
  }

  const task = payload.task
  if (!isObject(task)) fail('$.task: expected an object')
  else {
    if (task.lastUserMessageId !== null && typeof task.lastUserMessageId !== 'string') {
      fail('$.task.lastUserMessageId: expected a string or null')
    }
    if (task.lastUserText !== null && typeof task.lastUserText !== 'string') {
      fail('$.task.lastUserText: expected a string or null')
    }
    if (task.openToolCalls !== undefined && !Array.isArray(task.openToolCalls)) {
      fail('$.task.openToolCalls: expected an array')
    }
    if (task.pendingInbox !== undefined && !Array.isArray(task.pendingInbox)) {
      fail('$.task.pendingInbox: expected an array')
    }
  }

  const execution = payload.execution
  if (!isObject(execution)) fail('$.execution: expected an object')
  else {
    for (const field of ['turn', 'step']) {
      if (execution[field] !== null && !isFiniteInteger(execution[field])) fail(`$.execution.${field}: expected an integer or null`)
    }
    if (execution.status !== 'open' && execution.status !== 'idle') fail('$.execution.status: expected "open" or "idle"')
  }

  const memory = payload.memory
  if (memory !== undefined && memory !== null) {
    if (!isObject(memory)) fail('$.memory: expected an object')
    else {
      if (!isFiniteInteger(memory.capturedAt)) fail('$.memory.capturedAt: expected epoch milliseconds')
      if (typeof memory.projectPath !== 'string') fail('$.memory.projectPath: expected a string')
      if (typeof memory.projectKey !== 'string' || !/^[0-9a-f]{12}$/.test(memory.projectKey)) {
        fail('$.memory.projectKey: expected the 12-hex project memory key')
      }
      const checkFile = (entry, path) => {
        if (!isObject(entry)) return fail(`${path}: expected an object`)
        if (typeof entry.path !== 'string' || entry.path.length === 0) fail(`${path}.path: expected a relative path`)
        if (typeof entry.text !== 'string') fail(`${path}.text: expected a string`)
        if (typeof entry.truncated !== 'boolean') fail(`${path}.truncated: expected a boolean`)
        if (!isFiniteInteger(entry.bytes) || entry.bytes < 0) fail(`${path}.bytes: expected a non-negative integer`)
      }
      if (memory.project !== null && memory.project !== undefined) checkFile(memory.project, '$.memory.project')
      if (!Array.isArray(memory.daily)) fail('$.memory.daily: expected an array')
      else {
        memory.daily.forEach((entry, index) => {
          checkFile(entry, `$.memory.daily[${index}]`)
          if (isObject(entry) && !/^\d{4}-\d{2}-\d{2}$/.test(String(entry.date))) {
            fail(`$.memory.daily[${index}].date: expected YYYY-MM-DD`)
          }
        })
      }
      if (!isFiniteInteger(memory.fileCount) || memory.fileCount < 0) fail('$.memory.fileCount: expected a non-negative integer')
      if (!isFiniteInteger(memory.bytes) || memory.bytes < 0) fail('$.memory.bytes: expected a non-negative integer')
      if (typeof memory.truncated !== 'boolean') fail('$.memory.truncated: expected a boolean')
    }
  }

  if (!Array.isArray(payload.tools)) {
    fail('$.tools: expected an array')
  } else {
    for (const [index, tool] of payload.tools.entries()) {
      if (!isObject(tool) || typeof tool.name !== 'string' || typeof tool.description !== 'string' || !isObject(tool.parameters)) {
        fail(`$.tools[${index}]: expected name, description and a parameters object`)
      }
    }
  }

  if (!isObject(payload.permissions)) fail('$.permissions: expected an object')
  if (!Array.isArray(payload.attachments)) fail('$.attachments: expected an array')
  else {
    for (const [index, attachment] of payload.attachments.entries()) {
      if (!isObject(attachment) || typeof attachment.attachmentId !== 'string') {
        fail(`$.attachments[${index}]: expected an attachmentId`)
      }
    }
  }

  if (typeof payload.reason !== 'string' || payload.reason.length === 0 || payload.reason.length > 500) {
    fail('$.reason: expected 1-500 characters')
  }
  if (!Array.isArray(payload.redactions)) fail('$.redactions: expected an array')

  if (problems.length > 0) {
    const shown = problems.slice(0, 8).join('; ')
    const suffix = problems.length > 8 ? ` (+${problems.length - 8} more)` : ''
    throw new ProtocolError('PAYLOAD_INVALID', `invalid handoff payload: ${shown}${suffix}`)
  }

  const size = canonicalByteLength(payload)
  if (size > maxBytes) {
    throw new ProtocolError(
      'PAYLOAD_TOO_LARGE',
      `handoff payload is ${size} bytes, over the configured limit of ${maxBytes} bytes`,
    )
  }

  if (verifyDigest) {
    const expected = digestOf(payload)
    if (payload.digest !== expected) {
      throw new ProtocolError(
        'PAYLOAD_DIGEST_MISMATCH',
        `payload digest ${String(payload.digest).slice(0, 12)} does not match content ${expected.slice(0, 12)}`,
      )
    }
  }
}

/**
 * Build an acknowledgement document.
 * @param {object} input
 * @returns {Record<string, unknown>}
 */
export function createAck(input) {
  return {
    protocol: ACK_VERSION,
    handoffId: input.handoffId,
    digest: input.digest,
    digestMatch: input.digestMatch === true,
    schemaValid: input.schemaValid === true,
    messageCount: input.messageCount,
    attachmentCount: input.attachmentCount,
    receivedAt: input.receivedAt ?? Date.now(),
  }
}

/**
 * Validate an acknowledgement against the payload that was sent.
 * Accepts either a payload document or an explicit
 * `{ handoffId, digest, messageCount }`.
 * @param {unknown} ack
 * @param {{ handoffId?: string, digest?: string, messageCount?: number, conversation?: { messageCount?: number } }} expected
 * @returns {Record<string, unknown>}
 */
export function assertAck(ack, expected) {
  const handoffId = expected.handoffId
  const digest = expected.digest
  const messageCount = expected.messageCount ?? expected.conversation?.messageCount
  if (!isObject(ack)) throw new ProtocolError('ACK_INVALID', 'acknowledgement must be a plain object')
  if (ack.protocol !== ACK_VERSION) throw new ProtocolError('ACK_INVALID', `acknowledgement protocol must be ${ACK_VERSION}`)
  if (ack.handoffId !== handoffId) {
    throw new ProtocolError('ACK_HANDOFF_MISMATCH', 'acknowledgement belongs to a different handoff')
  }
  if (ack.digest !== digest) throw new ProtocolError('ACK_DIGEST_MISMATCH', 'acknowledged digest does not match the payload')
  if (ack.digestMatch !== true) throw new ProtocolError('ACK_DIGEST_MISMATCH', 'box reported that the digest did not match')
  if (ack.schemaValid !== true) throw new ProtocolError('ACK_SCHEMA_INVALID', 'box reported that the payload failed validation')
  if (ack.messageCount !== messageCount) {
    throw new ProtocolError(
      'ACK_COUNT_MISMATCH',
      `box ingested ${String(ack.messageCount)} messages but the payload carried ${String(messageCount)}`,
    )
  }
  if (!isFiniteInteger(ack.receivedAt)) throw new ProtocolError('ACK_INVALID', 'acknowledgement receivedAt must be epoch milliseconds')
  return ack
}

/**
 * The marker the box agent must echo after ingesting the context pack.
 * @param {string} handoffId
 * @param {string} digest
 * @returns {string}
 */
export function buildAckMarker(handoffId, digest) {
  return `[instabox-handoff:ack ${handoffId} ${digest.slice(0, 12)}]`
}

/**
 * Find the acknowledgement marker in agent output.
 * @param {string} text
 * @returns {{ handoffId: string, digestPrefix: string } | null}
 */
export function parseAckMarker(text) {
  if (typeof text !== 'string') return null
  const match = /\[instabox-handoff:ack ([A-Za-z0-9_-]{8,64}) ([0-9a-f]{6,64})\]/.exec(text)
  if (!match) return null
  return { handoffId: match[1], digestPrefix: match[2] }
}

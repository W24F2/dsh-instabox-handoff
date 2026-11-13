/**
 * Box-side context-pack verifier. Pushed into the InstaBox instance and run
 * with `node verify.mjs <payload.json> <ack.json>`.
 *
 * It validates the payload's schema-lite shape, recomputes the canonical
 * digest, counts messages, and writes a machine-readable acknowledgement.
 * It never prints secrets and never executes payload content.
 *
 * @module instabox-bridge/box-side/verify
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

const PROTOCOL = 'instabox-handoff/v1'
const ACK_PROTOCOL = 'instabox-handoff-ack/v1'

/** Deterministic JSON (sorted keys) for digest comparison. */
function canonicalize(value) {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(canonicalize)
  const out = {}
  for (const key of Object.keys(value).sort()) {
    const v = canonicalize(value[key])
    if (v !== undefined) out[key] = v
  }
  return out
}
function canonicalJson(value) {
  return JSON.stringify(canonicalize(value))
}
function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex')
}
function digestOf(payload) {
  const copy = { ...payload }
  delete copy.digest
  return sha256Hex(canonicalJson(copy))
}

function isObject(v) { return typeof v === 'object' && v !== null && !Array.isArray(v) }

function validate(payload) {
  const problems = []
  if (!isObject(payload)) problems.push('payload is not an object')
  else {
    if (payload.protocol !== PROTOCOL) problems.push(`protocol must be ${PROTOCOL}`)
    if (typeof payload.handoffId !== 'string') problems.push('handoffId missing')
    if (!isObject(payload.source)) problems.push('source missing')
    if (!isObject(payload.instructions)) problems.push('instructions missing')
    if (!isObject(payload.conversation)) problems.push('conversation missing')
    else {
      if (!Array.isArray(payload.conversation.messages)) problems.push('conversation.messages missing')
      else if (payload.conversation.messageCount !== payload.conversation.messages.length) {
        problems.push('messageCount mismatch')
      }
    }
    if (!isObject(payload.task)) problems.push('task missing')
    if (!isObject(payload.execution)) problems.push('execution missing')
    if (!Array.isArray(payload.tools)) problems.push('tools missing')
    if (!Array.isArray(payload.attachments)) problems.push('attachments missing')
    if (payload.memory !== undefined && payload.memory !== null) {
      if (!isObject(payload.memory)) problems.push('memory is not an object')
      else {
        if (typeof payload.memory.projectKey !== 'string') problems.push('memory.projectKey missing')
        if (!Array.isArray(payload.memory.daily)) problems.push('memory.daily missing')
        if (typeof payload.memory.fileCount !== 'number') problems.push('memory.fileCount missing')
      }
    }
    if (typeof payload.digest !== 'string') problems.push('digest missing')
  }
  return problems
}

function main() {
  const [payloadPath, ackPath] = process.argv.slice(2)
  if (!payloadPath || !ackPath) {
    console.error('usage: node verify.mjs <payload.json> <ack.json>')
    process.exit(2)
  }
  let payload
  try {
    payload = JSON.parse(readFileSync(payloadPath, 'utf8'))
  } catch (error) {
    console.error(`failed to read payload: ${error.message}`)
    process.exit(2)
  }

  const problems = validate(payload)
  const schemaValid = problems.length === 0
  const expectedDigest = payload && typeof payload === 'object' ? digestOf(payload) : null
  const digestMatch = expectedDigest !== null && payload.digest === expectedDigest
  const messageCount = payload?.conversation?.messages?.length ?? 0
  const attachmentCount = Array.isArray(payload?.attachments) ? payload.attachments.length : 0
  const memoryFileCount = payload?.memory?.fileCount ?? 0

  const ack = {
    protocol: ACK_PROTOCOL,
    handoffId: payload?.handoffId ?? null,
    digest: payload?.digest ?? null,
    digestMatch,
    schemaValid,
    messageCount,
    attachmentCount,
    memoryFileCount,
    receivedAt: Date.now(),
    problems: problems.slice(0, 10),
  }
  writeFileSync(ackPath, JSON.stringify(ack, null, 2), 'utf8')
  console.log(JSON.stringify({ ok: schemaValid && digestMatch, problems }))
  process.exit(schemaValid && digestMatch ? 0 : 1)
}

main()

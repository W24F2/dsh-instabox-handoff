/**
 * Project a durable session event log into the conversation, task and
 * execution sections of a handoff payload.
 *
 * Ordering is the log's own: `seq` (monotonic), `time` (epoch ms), and the
 * enclosing `turn`/`step`. Roles, message identities, content blocks, usage,
 * and tool-call↔result correlation are copied verbatim, never re-derived.
 *
 * @module instabox-bridge/core/serialize
 */
import { canonicalize } from './canonical.js'

/**
 * Serialize one session log.
 * @param {object} input
 * @param {Array<Record<string, any>>} input.events
 * @param {string} [input.agentStatus]
 * @param {{ nextTurn?: any[], nextStep?: any[] } | null} [input.inbox]
 * @returns {{ conversation: object, task: object, execution: object, attachments: object[] }}
 */
export function serializeSession(input) {
  const events = Array.isArray(input.events)
    ? [...input.events].sort((left, right) => Number(left.seq) - Number(right.seq))
    : []
  const agentStatus = input.agentStatus
  const inbox = input.inbox ?? null

  /** @type {Array<Record<string, any>>} */
  const messages = []
  /** @type {Array<Record<string, any>>} */
  const toolCalls = []
  /** @type {Array<Record<string, any>>} */
  const toolResults = []
  /** @type {Map<string, number>} */
  const toolCallSeqByCallId = new Map()
  /** @type {Map<string, number>} */
  const assistantSeqByCallId = new Map()
  /** @type {Map<string, Record<string, any>>} */
  const attachmentByKey = new Map()

  let currentTurn = null
  let currentStep = null
  let openTurn = null
  let turnCount = 0
  let lastTurnEnd = null
  const interruptions = []
  let latestTodo = null
  let lastHumanMessage = null
  let firstTime = null
  let lastTime = null

  /** @param {unknown} blocks */
  function collectAttachments(blocks, messageSeq) {
    if (!Array.isArray(blocks)) return
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue
      if (block.type === 'image' && block.attachment && typeof block.attachment.attachmentId === 'string') {
        const key = block.attachment.attachmentId
        if (!attachmentByKey.has(key)) {
          attachmentByKey.set(key, { ...canonicalize(block.attachment), messageSeq })
        }
      }
      if (block.type === 'tool-result') collectAttachments(block.content, messageSeq)
    }
  }

  /**
   * @param {object} message
   * @param {object} meta
   */
  function pushMessage(message, meta) {
    const content = canonicalize(Array.isArray(message.content) ? message.content : [])
    messages.push({
      seq: meta.seq,
      time: meta.time,
      turn: meta.turn ?? null,
      step: meta.step ?? null,
      role: message.role,
      id: message.id,
      source: canonicalize(message.source ?? { kind: 'unknown' }),
      content,
      ...(meta.usage ? { usage: canonicalize(meta.usage) } : {}),
      ...(meta.interrupted ? { interrupted: true } : {}),
    })
    collectAttachments(content, meta.seq)
    for (const block of content) {
      if (block && block.type === 'tool-call' && typeof block.id === 'string') {
        assistantSeqByCallId.set(block.id, meta.seq)
      }
    }
    if (message.role === 'user' && message.source && message.source.kind === 'user') {
      lastHumanMessage = { id: message.id, seq: meta.seq, text: joinText(content) }
    }
  }

  for (const event of events) {
    if (!event || typeof event !== 'object') continue
    const seq = event.seq
    const time = event.time
    if (firstTime === null && Number.isFinite(time)) firstTime = time
    if (Number.isFinite(time)) lastTime = time
    const data = event.data ?? {}

    switch (event.type) {
      case 'turn/start': {
        currentTurn = data.turn ?? null
        currentStep = null
        openTurn = currentTurn
        turnCount += 1
        break
      }
      case 'turn/end': {
        openTurn = null
        lastTurnEnd = {
          turn: data.turn ?? null,
          seq,
          time,
          kind: data.reason?.kind ?? 'unknown',
          ...(data.reason?.message ? { message: String(data.reason.message).slice(0, 200) } : {}),
        }
        if (['error', 'aborted', 'interrupted'].includes(lastTurnEnd.kind)) {
          interruptions.push({ ...lastTurnEnd })
        }
        break
      }
      case 'step/start': {
        currentStep = data.step ?? null
        break
      }
      case 'step/end': {
        currentStep = null
        break
      }
      case 'user/message': {
        if (data && typeof data === 'object' && typeof data.id === 'string') {
          pushMessage(data, { seq, time, turn: currentTurn, step: currentStep })
        }
        break
      }
      case 'assistant/message': {
        if (data.message && typeof data.message.id === 'string') {
          pushMessage(data.message, {
            seq,
            time,
            turn: data.turn ?? currentTurn,
            step: data.step ?? currentStep,
            usage: data.usage,
            interrupted: data.interrupted,
          })
        }
        break
      }
      case 'tool/call': {
        if (typeof data.callId === 'string') {
          const entry = {
            callId: data.callId,
            seq,
            time,
            turn: data.turn ?? null,
            step: data.step ?? null,
            name: String(data.name ?? ''),
            arguments: String(data.arguments ?? ''),
          }
          toolCalls.push(entry)
          toolCallSeqByCallId.set(data.callId, seq)
        }
        break
      }
      case 'tool/result': {
        const message = data.message
        if (message && typeof message.id === 'string') {
          pushMessage(message, {
            seq,
            time,
            turn: data.turn ?? currentTurn,
            step: data.step ?? currentStep,
          })
          const callId = message.source?.callId ?? message.content?.[0]?.toolCallId
          if (typeof callId === 'string') {
            const block = Array.isArray(message.content) ? message.content[0] : null
            toolResults.push({
              callId,
              seq,
              time,
              messageId: message.id,
              isError: block?.isError === true,
              ...(data.error ? { error: canonicalize(data.error) } : {}),
              content: canonicalize(Array.isArray(block?.content) ? block.content : message.content ?? []),
            })
          }
        }
        break
      }
      case 'todo/write': {
        latestTodo = Array.isArray(data.todos) ? canonicalize(data.todos) : null
        break
      }
      default:
        break
    }
  }

  const resultSeqByCallId = new Map(toolResults.map((entry) => [entry.callId, entry.seq]))
  const toolCallLinks = toolCalls.map((call) => ({
    callId: call.callId,
    name: call.name,
    callSeq: call.seq,
    modelCallSeq: assistantSeqByCallId.get(call.callId) ?? null,
    resultSeq: resultSeqByCallId.get(call.callId) ?? null,
  }))
  const openToolCalls = toolCalls
    .filter((call) => !resultSeqByCallId.has(call.callId))
    .map((call) => ({ callId: call.callId, name: call.name, callSeq: call.seq, arguments: call.arguments }))

  const conversation = {
    firstSeq: events.length > 0 ? events[0].seq : null,
    lastSeq: events.length > 0 ? events[events.length - 1].seq : null,
    messageCount: messages.length,
    messages,
    toolCalls,
    toolResults,
    toolCallLinks,
  }

  const task = {
    lastUserMessageId: lastHumanMessage?.id ?? null,
    lastUserText: lastHumanMessage?.text ?? null,
    openToolCalls,
    latestTodo,
    pendingInbox: serializeInbox(inbox),
  }

  const execution = {
    turn: currentTurn,
    step: currentStep,
    status: openTurn === null ? 'idle' : 'open',
    agentStatus: agentStatus ?? null,
    startedTurns: turnCount,
    lastTurnEnd,
    interruptions,
  }

  return {
    conversation,
    task,
    execution,
    attachments: [...attachmentByKey.values()],
  }
}

/**
 * @param {unknown} content
 * @returns {string}
 */
export function joinText(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/**
 * Summarize pending inbox work without duplicating full content into the task.
 * @param {{ nextTurn?: any[], nextStep?: any[] } | null} inbox
 * @returns {Array<object>}
 */
function serializeInbox(inbox) {
  if (!inbox) return []
  const entries = []
  for (const [queue, list] of [
    ['next-turn', inbox.nextTurn],
    ['next-step', inbox.nextStep],
  ]) {
    if (!Array.isArray(list)) continue
    for (const message of list) {
      entries.push({
        queue,
        id: message?.id ?? null,
        source: canonicalize(message?.source ?? { kind: 'unknown' }),
        text: joinText(message?.content).slice(0, 200),
      })
    }
  }
  return entries
}

/**
 * Render the transferred conversation as a stable plain-text transcript for
 * the box-side agent's handoff prompt.
 * @param {Record<string, any>} conversation
 * @returns {string}
 */
export function renderTranscript(conversation) {
  const lines = []
  for (const message of conversation.messages ?? []) {
    const label = message.role === 'assistant' ? 'assistant' : message.source?.kind === 'tool' ? 'tool' : 'user'
    const body = renderBlocks(message.content)
    lines.push(`### ${label} [seq ${message.seq}, ${new Date(message.time).toISOString()}]`)
    lines.push(body.length > 0 ? body : '(no text content)')
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}

/** @param {unknown} blocks */
function renderBlocks(blocks) {
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text') parts.push(block.text)
    if (block.type === 'reasoning') parts.push(`(reasoning) ${block.text}`)
    if (block.type === 'tool-call') parts.push(`(tool call ${block.name}) ${block.arguments}`)
    if (block.type === 'tool-result') parts.push(`(tool result) ${renderBlocks(block.content)}`)
    if (block.type === 'image') parts.push(`(image attachment ${block.attachment?.attachmentId ?? 'unknown'})`)
  }
  return parts.join('\n')
}

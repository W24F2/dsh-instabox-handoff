/**
 * Per-session message routing while control is delegated to InstaBox.
 *
 * The router classifies each agent step, decides whether the request should be
 * served by the box agent, performs the box turn, caches replies for
 * idempotency, and reports failures for failover.
 *
 * @module instabox-bridge/core/router
 */
import { createHash } from 'node:crypto'
import { canonicalJson } from './canonical.js'
import { extractAgentText, parseAgentEvents } from './agent-events.js'

/** @typedef {{ text: string, exitCode: number | null, turnEndExitCode: number | null, sawTurnEnd: boolean }} BoxReply */

export class RoutingError extends Error {
  /** @param {string} code @param {string} message @param {object} [extra] */
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'RoutingError'
    this.code = code
    Object.assign(this, extra)
  }
}

/**
 * Stable key for a user message batch (idempotency).
 * @param {Array<{ id?: string, content?: unknown }>} messages
 * @returns {string}
 */
export function messageKey(messages) {
  const parts = (messages ?? []).map((m) => {
    const id = m?.id ?? ''
    const text = typeof m?.content === 'string'
      ? m.content
      : canonicalJson(m?.content ?? null)
    return `${id}:${createHash('sha256').update(text).digest('hex').slice(0, 16)}`
  })
  return createHash('sha256').update(parts.join('|')).digest('hex')
}

export class MessageRouter {
  /**
   * @param {object} options
   * @param {object} options.client - InstaBoxClient
   * @param {object} options.state - SessionStateStore
   * @param {object} options.config - normalized config
   * @param {{ info?: Function, warn?: Function, error?: Function, debug?: Function }} [options.logger]
   */
  constructor({ client, state, config, logger = console }) {
    this.client = client
    this.state = state
    this.config = config
    this.logger = logger
    /** @type {Map<string, Promise<BoxReply>>} in-flight box turns by session */
    this.inflight = new Map()
  }

  /**
   * Classify a pre-step payload: does this step carry new user input that
   * should be routed to the box?
   * @param {object} state - session state
   * @param {Array<object>} messages - claimed user messages
   * @returns {{ route: boolean, key: string | null, reason: string }}
   */
  classify(state, messages) {
    if (state.phase !== 'delegated') return { route: false, key: null, reason: `phase=${state.phase}` }
    const list = Array.isArray(messages) ? messages : []
    if (list.length === 0) return { route: false, key: null, reason: 'no user messages' }
    const key = messageKey(list)
    if (key === state.lastRoutedKey) return { route: false, key, reason: 'duplicate of last routed batch' }
    // If the batch contains only tool results / non-user sources, skip.
    const hasUser = list.some((m) => m?.source?.kind === 'user' || m?.role === 'user')
    if (!hasUser) return { route: false, key, reason: 'no user-role message' }
    return { route: true, key, reason: 'new user input' }
  }

  /**
   * Check the routed ledger for a previously completed turn with this key.
   * @param {object} state
   * @param {string} key
   * @returns {BoxReply | null}
   */
  lookupRouted(state, key) {
    const entry = (state.routed ?? []).find((r) => r.key === key)
    return entry?.reply ?? null
  }

  /**
   * Run one box turn for a batch of user messages. Idempotent: a second call
   * with the same key while in-flight awaits the same promise; a completed
   * key returns the cached reply without re-prompting.
   * @param {string} sessionId
   * @param {object} state
   * @param {string} key
   * @param {Array<object>} messages
   * @param {object} [opts]
   * @param {AbortSignal} [opts.signal]
   * @returns {Promise<BoxReply>}
   */
  async route(sessionId, state, key, messages, opts = {}) {
    // 1. Cached reply? Check the persisted store, not the passed-in state.
    const current = await this.state.load(sessionId)
    const cached = this.lookupRouted(current, key)
    if (cached) return cached

    // 2. In-flight?
    const inflightKey = `${sessionId}:${key}`
    const existing = this.inflight.get(inflightKey)
    if (existing) return existing

    const promise = this._doRoute(sessionId, current, key, messages, opts)
      .finally(() => this.inflight.delete(inflightKey))
    this.inflight.set(inflightKey, promise)
    return promise
  }

  /** @private */
  async _doRoute(sessionId, state, key, messages, opts) {
    const boxName = state.box?.name
    if (!boxName) throw new RoutingError('NO_BOX', 'no box name in state')
    const conversationId = state.conversationId

    // Build the prompt: continuation context + the new user message(s).
    const prompt = buildContinuationPrompt(messages, state)

    // Submit the turn. For new conversations, send newConversation=true.
    // For resumed conversations, use the existing conversationId.
    const submit = await this.client.agentPrompt(boxName, prompt, {
      resumeConversationId: conversationId,
      newConversation: !conversationId,
      signal: opts.signal,
    })
    const newConversationId = submit?.conversationId ?? conversationId

    // Update state with the (potentially new) conversation ID.
    await this.state.update(sessionId, (s) => {
      if (!s) return null
      s.conversationId = newConversationId
      return s
    })

    // Wait for the box agent's response.
    const reply = await this._awaitTurn(boxName, newConversationId, opts)

    // Persist the routed entry.
    await this.state.update(sessionId, (s) => {
      if (!s) return null
      s.routed = trimRoutedLocal([...(s.routed ?? []), { key, reply, at: Date.now() }], this.config.routing.dedupeLimit)
      s.lastRoutedKey = key
      return s
    })
    return reply
  }

  /**
   * Wait for the box agent's turn to finish and extract its text.
   * For new conversations, use all events. For resumed conversations,
   * keep only events up to (but not including) the turn_end.
   * @param {string} boxName
   * @param {string | null} conversationId
   * @param {object} [opts]
   * @returns {Promise<BoxReply>}
   */
  async _awaitTurn(boxName, conversationId, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? this.config.routing.turnTimeoutMs
    const allEvents = []
    let sawTurnEnd = false
    let turnEndExitCode = null

    await this.client.agentEventsStream(boxName, {
      conversationId,
      timeoutMs,
      signal: opts.signal,
      onLine: (line) => {
        try {
          const record = JSON.parse(line)
          const normalized = parseAgentEvents(JSON.stringify(record))
          for (const ev of normalized) {
            if (ev.kind === 'turn_end') {
              sawTurnEnd = true
              turnEndExitCode = ev.exitCode ?? turnEndExitCode
            }
            allEvents.push(ev)
          }
        } catch {}
      },
    })

    // For new conversations (conversationId === null), use all events.
    // For resumed conversations, keep events BEFORE the first turn_end.
    let events = allEvents
    if (conversationId && allEvents.some((e) => e.kind === 'turn_end')) {
      const turnEndIdx = allEvents.findIndex((e) => e.kind === 'turn_end')
      if (turnEndIdx >= 0) {
        events = allEvents.slice(0, turnEndIdx)
      }
    }

    const { text } = extractAgentText(events)
    if (!sawTurnEnd) {
      this.logger.warn?.(`[instabox-bridge] box turn ended without turn_end marker`)
    }
    if (!text) {
      throw new RoutingError('EMPTY_REPLY', 'box agent produced no text output', {
        turnEndExitCode,
        sawTurnEnd,
      })
    }
    return { text, exitCode: turnEndExitCode, turnEndExitCode, sawTurnEnd }
  }

  /**
   * Interrupt the current box turn (best-effort).
   * @param {object} state
   * @param {object} [opts]
   */
  async interrupt(state, opts = {}) {
    const boxName = state.box?.name
    if (!boxName) return
    try {
      await this.client.agentInterrupt(boxName, { conversationId: state.conversationId, signal: opts.signal })
    } catch (error) {
      this.logger.warn?.(`[instabox-bridge] agent interrupt failed: ${error?.message ?? error}`)
    }
  }
}

/** @param {Array<object>} routed @param {number} limit */
function trimRoutedLocal(routed, limit) {
  return routed.length <= limit ? routed : routed.slice(routed.length - limit)
}

/**
 * Build the prompt sent to the box agent for a new user message batch.
 * @param {Array<object>} messages
 * @param {object} state
 * @returns {string}
 */
export function buildContinuationPrompt(messages, state) {
  const texts = (messages ?? [])
    .map((m) => {
      const content = m?.content
      if (typeof content === 'string') return content
      if (Array.isArray(content)) {
        return content
          .filter((b) => b && b.type === 'text')
          .map((b) => b.text)
          .join('\n')
      }
      return ''
    })
    .filter(Boolean)
  const userText = texts.join('\n\n') || '(empty message)'
  const parts = [
    'You are continuing a conversation that was handed off from a DeepSeek Harness session.',
    'The full prior context was ingested earlier; answer the user\'s new message directly and concisely.',
    'If you need to use tools, use them as you normally would.',
    '',
    '--- NEW USER MESSAGE ---',
    userText,
  ]
  return parts.join('\n')
}
/**
 * LLM adapter that routes a delegated session's model calls to the InstaBox
 * agent. Duck-typed to satisfy the `LlmAdapter` contract without importing
 * DSH types (keeps the module testable standalone).
 *
 * @module instabox-bridge/core/adapter
 */
import { messageKey } from './router.js'
import { extractAgentText, parseAgentEvents } from './agent-events.js'

export class InstaBoxAdapter {
  /**
   * @param {object} options
   * @param {object} options.router - MessageRouter
   * @param {object} options.state - SessionStateStore
   * @param {object} options.config - normalized config
   * @param {{ info?: Function, warn?: Function, error?: Function, debug?: Function }} [options.logger]
   */
  constructor({ router, state, config, logger = console }) {
    this.router = router
    this.state = state
    this.config = config
    this.logger = logger
    /** @type {Map<string, { text: string, pending: boolean }>} sessionId -> last reply */
    this.lastReplies = new Map()
  }

  /** @param {string} provider */
  providerInfo(provider) {
    return { id: provider, name: 'InstaBox Agent' }
  }

  /** @param {string} _provider */
  providerRetryPolicy(_provider) {
    return { mode: 'normal', maxRetries: 0 }
  }

  /** @param {string} _provider */
  async listModels(_provider) {
    return [{ id: 'box:default', name: 'InstaBox Agent' }]
  }

  /**
   * @param {string} provider
   * @param {string} model
   * @param {AbortSignal} [_signal]
   */
  async resolveModel(provider, model, _signal) {
    return {
      provider,
      id: model,
      name: `InstaBox: ${model}`,
      context: { contextWindow: 200000 },
      inputModalities: ['text'],
    }
  }

  /**
   * @param {string} provider
   * @param {string} model
   * @param {AbortSignal} [signal]
   */
  async prepareCall(provider, model, signal) {
    const self = this
    return {
      model: await self.resolveModel(provider, model, signal),
      stream: (options) => self.stream(options),
    }
  }

  /**
   * Stream one model call. The `options` object is the assembled request;
   * `options.sessionId` identifies the DSH session, `options.messages` the
   * conversation. We route the newest user message to the box agent and emit
   * its reply as text chunks.
   *
   * @param {object} options - GenerateOptions
   * @returns {AsyncIterable<object>} StreamChunk
   */
  async *stream(options) {
    const sessionId = String(options.sessionId ?? '')
    const state = await this.state.load(sessionId)
    if (!state || state.phase !== 'delegated') {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'NOT_DELEGATED', message: 'session is not delegated to InstaBox' } } }
      return
    }

    // The first post-handoff request carries the handoff tool result; serve
    // the cached ACK text without a second box prompt.
    if (state.ackReplyText && !state.ackReplyConsumed) {
      await this.state.update(sessionId, (s) => {
        if (!s) return null
        s.ackReplyConsumed = true
        return s
      })
      yield* this._emitText(state.ackReplyText)
      return
    }

    // Find the newest user message(s) not yet routed.
    const userMessages = this._extractNewUserMessages(options.messages, state)
    if (userMessages.length === 0) {
      // No new user input (e.g. a retry or tool-only step); emit a minimal
      // continuation so the loop can close the turn.
      yield* this._emitText('(waiting for user input)')
      return
    }

    const key = messageKey(userMessages)
    try {
      const reply = await this.router.route(sessionId, state, key, userMessages, { signal: options.signal })
      this.lastReplies.set(sessionId, { text: reply.text, pending: false })
      yield* this._emitText(reply.text)
    } catch (error) {
      if (options.signal?.aborted) {
        yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'turn aborted' } } }
        return
      }
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            code: error?.code ?? 'BOX_TURN_FAILED',
            message: error?.message ?? String(error),
          },
        },
      }
    }
  }

  /**
   * Extract user messages that arrived after the last routed key.
   * @private
   */
  _extractNewUserMessages(messages, state) {
    const routedKeys = new Set((state.routed ?? []).map((r) => r.key))
    const candidates = (messages ?? []).filter((m) => {
      if (!m || m.role !== 'user') return false
      // Skip tool results (they have source.kind === 'tool').
      if (m.source?.kind === 'tool') return false
      return true
    })
    // Find the last batch that hasn't been routed.
    // Simple heuristic: take messages after the last assistant message.
    let lastAssistantIdx = -1
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i]?.role === 'assistant') { lastAssistantIdx = i; break }
    }
    const tail = lastAssistantIdx >= 0 ? messages.slice(lastAssistantIdx + 1) : messages
    const userTail = tail.filter((m) => m?.role === 'user' && m?.source?.kind !== 'tool')
    if (userTail.length === 0) return []
    const key = messageKey(userTail)
    if (routedKeys.has(key) || key === state.lastRoutedKey) return []
    return userTail
  }

  /** @private */
  async *_emitText(text) {
    const str = String(text ?? '')
    if (!str) {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'EMPTY_RESPONSE', message: 'empty box reply' } } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    // Emit in chunks to mimic streaming.
    const chunkSize = 200
    for (let i = 0; i < str.length; i += chunkSize) {
      yield { type: 'text-delta', index: 0, text: str.slice(i, i + chunkSize) }
    }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: str } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

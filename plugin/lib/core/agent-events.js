/**
 * Tolerant parser for `instabox agent events --json` output.
 *
 * The in-box agent event schema is provider-owned and not publicly documented,
 * so this parser accepts the two known line shapes and falls back to a bounded
 * generic text extraction. Anything malformed is ignored rather than fatal;
 * the caller decides whether the absence of text is an error.
 *
 * @module instabox-bridge/core/agent-events
 */

/** @typedef {{ kind: 'text', text: string, eventIndex: number }} AgentTextEvent */
/** @typedef {{ kind: 'turn_end', exitCode?: number | null, index: number }} AgentTurnEndEvent */
/** @typedef {{ kind: 'other', index: number }} AgentOtherEvent */
/** @typedef {AgentTextEvent | AgentTurnEndEvent | AgentOtherEvent} AgentEvent */

const MAX_LINE_BYTES = 4 * 1024 * 1024
const MAX_EVENTS = 50_000

/**
 * Parse one JSONL event object into a normalized event.
 * @param {unknown} record
 * @param {number} index
 * @returns {AgentEvent}
 */
function normalizeRecord(record, index) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return { kind: 'other', index }
  const event = /** @type {Record<string, unknown>} */ (record)

  // `instabox.turn` / `instabox.turn_end` envelope types.
  const type = typeof event.type === 'string' ? event.type : ''
  if (type === 'instabox.turn_end' || type === 'instabox.turn.end' || type === 'turn_end') {
    const payload = /** @type {Record<string, unknown>} */ (event.data ?? event.payload ?? {})
    return { kind: 'turn_end', index, exitCode: typeof payload.exitCode === 'number' ? payload.exitCode : null }
  }
  if (type === 'instabox.error') {
    return { kind: 'other', index }
  }

  // Claude Code stream-json shapes.
  const message = event.message
  if (message && typeof message === 'object' && !Array.isArray(message)) {
    const content = /** @type {Record<string, unknown>} */ (message).content
    if (Array.isArray(content)) {
      const texts = []
      for (const block of content) {
        if (block && typeof block === 'object' && !Array.isArray(block)) {
          const b = /** @type {Record<string, unknown>} */ (block)
          if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text)
        }
      }
      if (texts.length > 0) return { kind: 'text', text: texts.join('\n'), eventIndex: index }
    }
  }

  // Codex exec --json item shapes.
  if (event.type === 'item.completed' && event.item && typeof event.item === 'object') {
    const item = /** @type {Record<string, unknown>} */ (event.item)
    if (item.type === 'agent_message' && typeof item.text === 'string') {
      return { kind: 'text', text: item.text, eventIndex: index }
    }
  }

  // Generic fallback: a top-level text/delta field.
  for (const key of ['text', 'delta', 'content']) {
    const value = event[key]
    if (typeof value === 'string' && value.length > 0) {
      return { kind: 'text', text: value, eventIndex: index }
    }
  }
  return { kind: 'other', index }
}

/**
 * Parse a complete `agent events --json` stream (already collected).
 * @param {string} raw
 * @returns {AgentEvent[]}
 */
export function parseAgentEvents(raw) {
  const events = []
  const lines = String(raw ?? '').split('\n')
  for (let index = 0; index < lines.length && events.length < MAX_EVENTS; index += 1) {
    const line = lines[index].trim()
    if (!line) continue
    if (line.length > MAX_LINE_BYTES) continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    events.push(normalizeRecord(record, index))
  }
  return events
}

/**
 * Extract the concatenated assistant text from parsed events.
 * @param {AgentEvent[]} events
 * @returns {{ text: string, turnEndExitCode: number | null, sawTurnEnd: boolean }}
 */
export function extractAgentText(events) {
  const parts = []
  let turnEndExitCode = null
  let sawTurnEnd = false
  for (const event of events) {
    if (event.kind === 'text') parts.push(event.text)
    if (event.kind === 'turn_end') {
      sawTurnEnd = true
      turnEndExitCode = event.exitCode ?? turnEndExitCode
    }
  }
  return { text: parts.join('\n'), turnEndExitCode, sawTurnEnd }
}

/**
 * Durable per-session routing state and audit trail.
 *
 * One JSON document per DSH session, written atomically (temp sibling + rename)
 * so a crash never leaves a half-written state. The in-process update queue
 * serializes read-modify-write cycles for the same session.
 *
 * @module instabox-bridge/core/state
 */
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalJson } from './canonical.js'

export const STATE_SCHEMA_VERSION = 1
export const PHASES = [
  'idle',
  'preparing',
  'transferring',
  'ingesting',
  'awaiting_ack',
  'delegated',
  'reclaiming',
  'reclaimed',
  'failed',
]

export class StateError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message)
    this.name = 'StateError'
    this.code = code
  }
}

/**
 * A fresh state document.
 * @param {string} sessionId
 * @param {object} [extra]
 * @returns {Record<string, unknown>}
 */
export function createState(sessionId, extra = {}) {
  const now = Date.now()
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    sessionId,
    phase: 'idle',
    createdAt: now,
    updatedAt: now,
    handoffId: null,
    box: null,
    conversationId: null,
    provider: null,
    model: null,
    originalRoute: null,
    ack: null,
    ackReplyText: null,
    ackReplyConsumed: false,
    lastRoutedKey: null,
    routed: [],
    pending: null,
    failures: { count: 0, lastError: null, lastAt: null },
    reclaimedAt: null,
    reclaimedReason: null,
    lastError: null,
    handoffAttempts: 0,
    ...extra,
  }
}

/** @param {unknown} state @returns {void} */
export function validateState(state) {
  if (state === null || typeof state !== 'object' || Array.isArray(state)) {
    throw new StateError('STATE_INVALID', 'state must be an object')
  }
  if (state.schemaVersion !== STATE_SCHEMA_VERSION) {
    throw new StateError('STATE_INVALID', `unsupported state schema version ${String(state.schemaVersion)}`)
  }
  if (typeof state.sessionId !== 'string' || state.sessionId.length === 0) {
    throw new StateError('STATE_INVALID', 'state.sessionId is required')
  }
  if (!PHASES.includes(state.phase)) {
    throw new StateError('STATE_INVALID', `unknown phase "${String(state.phase)}"`)
  }
  if (!Array.isArray(state.routed)) throw new StateError('STATE_INVALID', 'state.routed must be an array')
  if (state.pending !== null && (typeof state.pending !== 'object' || Array.isArray(state.pending))) {
    throw new StateError('STATE_INVALID', 'state.pending must be an object or null')
  }
}

/** @param {string} sessionId */
export function safeFileName(sessionId) {
  const cleaned = String(sessionId).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 160)
  if (cleaned.length === 0 || cleaned === '.' || cleaned === '..') {
    throw new StateError('STATE_INVALID', 'session id cannot be mapped to a safe file name')
  }
  return cleaned
}

export class SessionStateStore {
  /**
   * @param {object} options
   * @param {string} options.rootDir
   * @param {{ info?: Function, warn?: Function, error?: Function, debug?: Function }} [options.logger]
   */
  constructor({ rootDir, logger = console }) {
    this.rootDir = rootDir
    this.sessionsDir = join(rootDir, 'sessions')
    this.auditDir = join(rootDir, 'audit')
    this.logger = logger
    /** @type {Map<string, Promise<unknown>>} */
    this.queues = new Map()
  }

  /** @param {string} sessionId */
  fileFor(sessionId) {
    return join(this.sessionsDir, `${safeFileName(sessionId)}.json`)
  }

  async ensureDirs() {
    await mkdir(this.sessionsDir, { recursive: true })
    await mkdir(this.auditDir, { recursive: true })
  }

  /**
   * Load one session state.
   * @param {string} sessionId
   * @param {{ safe?: boolean }} [options] - safe: quarantine corrupt documents instead of throwing.
   * @returns {Promise<Record<string, unknown> | null>}
   */
  async load(sessionId, options = {}) {
    const file = this.fileFor(sessionId)
    let text
    try {
      text = await readFile(file, 'utf8')
    } catch (error) {
      if (error && error.code === 'ENOENT') return null
      throw error
    }
    let parsed
    try {
      parsed = JSON.parse(text)
      validateState(parsed)
    } catch (error) {
      if (options.safe === false) throw error
      const quarantine = `${file}.corrupt-${Date.now()}`
      try {
        await rename(file, quarantine)
      } catch {}
      this.logger.warn?.(`[instabox-bridge] quarantined corrupt state ${file}: ${error?.message ?? error}`)
      return null
    }
    return parsed
  }

  /**
   * Atomically persist one state document.
   * @param {Record<string, unknown>} state
   */
  async save(state) {
    validateState(state)
    state.updatedAt = Date.now()
    await this.ensureDirs()
    const file = this.fileFor(state.sessionId)
    const temp = `${file}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`
    await writeFile(temp, `${canonicalJson(state)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temp, file)
    return state
  }

  /**
   * Serialized read-modify-write with an optional create factory.
   * @param {string} sessionId
   * @param {(state: Record<string, unknown> | null) => (Record<string, unknown> | null | Promise<Record<string, unknown> | null>)} updater
   * @returns {Promise<Record<string, unknown> | null>}
   */
  async update(sessionId, updater) {
    const previous = this.queues.get(sessionId) ?? Promise.resolve()
    const next = previous.then(async () => {
      const current = await this.load(sessionId)
      const result = await updater(current)
      if (result === null || result === undefined) return null
      return this.save(result)
    })
    this.queues.set(
      sessionId,
      next.catch(() => {}),
    )
    return next
  }

  /** @returns {Promise<Array<Record<string, unknown>>>} */
  async list() {
    await this.ensureDirs()
    const names = await readdir(this.sessionsDir)
    const states = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const sessionId = name.slice(0, -'.json'.length)
      const state = await this.load(sessionId)
      if (state) states.push(state)
    }
    return states
  }

  /**
   * Append a redacted audit entry (never a prompt body or credential).
   * @param {string} sessionId
   * @param {Record<string, unknown>} entry
   */
  async audit(sessionId, entry) {
    await this.ensureDirs()
    const file = join(this.auditDir, `${safeFileName(sessionId)}.jsonl`)
    await appendFile(file, `${canonicalJson({ time: Date.now(), ...entry })}\n`, 'utf8')
  }

  /** @param {string} sessionId */
  async remove(sessionId) {
    await rm(this.fileFor(sessionId), { force: true })
  }
}

/**
 * Keep the routed-turn ledger bounded.
 * @param {Array<Record<string, unknown>>} routed
 * @param {number} limit
 * @returns {Array<Record<string, unknown>>}
 */
export function trimRouted(routed, limit) {
  if (routed.length <= limit) return routed
  return routed.slice(routed.length - limit)
}

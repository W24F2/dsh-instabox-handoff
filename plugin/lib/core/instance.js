/**
 * InstaBox instance lifecycle: connect, create, health, ensure-running,
 * wake/resume/start, and conversation recovery. Only documented CLI commands.
 *
 * @module instabox-bridge/core/instance
 */
import { InstaBoxError, EXIT } from './client.js'

const RUNNING_STATES = new Set(['running', 'ready', 'active'])
const PAUSED_STATES = new Set(['paused', 'suspended', 'sleeping'])
const STOPPED_STATES = new Set(['stopped', 'halted', 'off'])

export class InstanceError extends Error {
  /** @param {string} code @param {string} message @param {object} [extra] */
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'InstanceError'
    this.code = code
    Object.assign(this, extra)
  }
}

/**
 * @param {object} box - `instabox get --json` result
 * @returns {string} normalized state word
 */
export function boxState(box) {
  const raw = String(box?.state ?? box?.status ?? box?.phase ?? '').toLowerCase()
  if (RUNNING_STATES.has(raw)) return 'running'
  if (PAUSED_STATES.has(raw)) return 'paused'
  if (STOPPED_STATES.has(raw)) return 'stopped'
  if (raw.includes('creat') || raw.includes('start') || raw.includes('boot')) return 'starting'
  if (raw.includes('fail') || raw.includes('error')) return 'failed'
  return raw || 'unknown'
}

/** @param {object} box */
export function boxId(box) {
  return box?.id ?? box?.machineId ?? box?.name ?? null
}

/** @param {object} box */
export function boxName(box) {
  return box?.name ?? box?.id ?? null
}

export class InstanceManager {
  /**
   * @param {object} options
   * @param {object} options.client - InstaBoxClient
   * @param {object} options.config - normalized config
   * @param {object} options.state - SessionStateStore
   * @param {{ info?: Function, warn?: Function, error?: Function, debug?: Function }} [options.logger]
   */
  constructor({ client, config, state, logger = console }) {
    this.client = client
    this.config = config
    this.state = state
    this.logger = logger
  }

  /**
   * Resolve the target box: connect to an existing one or create a new one.
   * @param {string} sessionId
   * @param {object} [opts]
   * @param {AbortSignal} [opts.signal]
   * @returns {Promise<{ name: string, id: string | null, created: boolean, state: string }>}
   */
  async ensure(sessionId, opts = {}) {
    const inst = this.config.instance
    // 1. Try to connect to a configured/existing box.
    const existing = await this.findExisting(sessionId, opts)
    if (existing) {
      await this.ensureRunning(existing, opts)
      return { name: boxName(existing), id: boxId(existing), created: false, state: boxState(existing) }
    }

    // 2. Create when configured.
    if (inst.mode === 'create' || inst.createOnMissing) {
      const name = inst.name ?? `dsh-${sessionId.slice(0, 12).replace(/[^a-z0-9-]/gi, '-')}`
      const created = await this.create(name, sessionId, opts)
      await this.ensureRunning(created, opts)
      return { name: boxName(created) ?? name, id: boxId(created), created: true, state: boxState(created) }
    }

    throw new InstanceError(
      'NO_INSTANCE',
      `no InstaBox instance found for session ${sessionId}; set instance.name or instance.mode=create`,
    )
  }

  /**
   * Find an existing box by configured name, or by session metadata tag.
   * @param {string} sessionId
   * @param {object} [opts]
   * @returns {Promise<object | null>}
   */
  async findExisting(sessionId, opts = {}) {
    const inst = this.config.instance
    if (inst.name) {
      try {
        const box = await this.client.get(inst.name, { signal: opts.signal })
        if (box) return box
      } catch (error) {
        if (error instanceof InstaBoxError && error.exitCode === EXIT.NOT_FOUND) {
          // fall through to metadata search
        } else if (error.retryable) {
          throw error
        }
        // Other errors (auth, etc.) propagate.
        if (error.exitCode === EXIT.AUTH) throw error
      }
    }
    // Search by session metadata tag.
    try {
      const list = await this.client.list({ signal: opts.signal })
      const machines = Array.isArray(list) ? list : list?.machines ?? list?.items ?? []
      for (const box of machines) {
        const meta = box?.metadata ?? box?.meta ?? {}
        if (meta.session === sessionId || meta['instabox-bridge.session'] === sessionId) return box
      }
    } catch (error) {
      this.logger.debug?.(`[instabox-bridge] list failed during discovery: ${error?.message ?? error}`)
    }
    return null
  }

  /**
   * Create a box with session metadata.
   * @param {string} name
   * @param {string} sessionId
   * @param {object} [opts]
   * @returns {Promise<object>}
   */
  async create(name, sessionId, opts = {}) {
    const inst = this.config.instance
    const meta = { ...(inst.meta ?? {}), session: sessionId, 'instabox-bridge.session': sessionId }
    try {
      return await this.client.create({
        name,
        meta,
        template: inst.template,
        vcpus: inst.vcpus,
        memMib: inst.memMib,
        autoSuspend: inst.autoSuspend,
        secrets: inst.secrets,
        org: inst.org,
        readyTimeoutMs: inst.readyTimeoutMs,
        signal: opts.signal,
      })
    } catch (error) {
      if (error instanceof InstaBoxError && error.exitCode === EXIT.CREATE_TIMEOUT) {
        throw new InstanceError('CREATE_TIMEOUT', `box ${name} was not ready in time`, { retryable: true })
      }
      throw error
    }
  }

  /**
   * Ensure the box is running and responsive.
   * @param {object} box
   * @param {object} [opts]
   * @returns {Promise<object>} the (possibly updated) box
   */
  async ensureRunning(box, opts = {}) {
    const name = boxName(box)
    if (!name) throw new InstanceError('NO_BOX', 'box has no name or id')
    let current = box
    let state = boxState(current)

    if (state === 'running') {
      // Verify responsiveness with a trivial exec.
      const probe = await this.probe(name, opts)
      if (probe.ok) return current
      // Fall through to restart if the probe fails.
      this.logger.warn?.(`[instabox-bridge] box ${name} probe failed; attempting restart`)
      await this.client.restart(name, opts).catch(() => {})
      await this.waitForState(name, 'running', opts)
      return this.client.get(name, opts)
    }

    if (state === 'paused') {
      // A box paused by itself wakes on exec; a user-paused box needs resume.
      try {
        await this.client.resume(name, opts)
      } catch {
        await this.client.wake(name, opts).catch(() => {})
      }
      await this.waitForState(name, 'running', opts)
      return this.client.get(name, opts)
    }

    if (state === 'stopped' || state === 'failed' || state === 'unknown') {
      await this.client.start(name, opts)
      await this.waitForState(name, 'running', opts)
      return this.client.get(name, opts)
    }

    if (state === 'starting') {
      await this.waitForState(name, 'running', opts)
      return this.client.get(name, opts)
    }

    throw new InstanceError('UNREACHABLE', `box ${name} is in unsupported state "${state}"`)
  }

  /**
   * Lightweight responsiveness probe.
   * @param {string} name
   * @param {object} [opts]
   * @returns {Promise<{ ok: boolean, detail?: string }>}
   */
  async probe(name, opts = {}) {
    try {
      const result = await this.client.exec(name, ['true'], { timeoutMs: 15000, signal: opts.signal })
      return { ok: result.exitCode === 0, detail: result.stdout }
    } catch (error) {
      return { ok: false, detail: error?.message ?? String(error) }
    }
  }

  /**
   * Wait for a box to reach a target state.
   * @param {string} name
   * @param {string} target
   * @param {object} [opts]
   */
  async waitForState(name, target, opts = {}) {
    const deadline = Date.now() + (opts.timeoutMs ?? this.config.instance.readyTimeoutMs)
    let lastState = 'unknown'
    while (Date.now() < deadline) {
      try {
        const box = await this.client.get(name, { signal: opts.signal })
        lastState = boxState(box)
        if (lastState === target) return box
        if (lastState === 'failed') {
          throw new InstanceError('BOX_FAILED', `box ${name} entered failed state`, { box })
        }
      } catch (error) {
        if (error instanceof InstanceError) throw error
        // Transient get failures are retried until the deadline.
      }
      await sleep(opts.pollMs ?? 2000, opts.signal)
    }
    throw new InstanceError('WAIT_TIMEOUT', `box ${name} did not reach "${target}" (last: ${lastState})`, {
      retryable: true,
    })
  }

  /**
   * Verify the box-side agent is reachable (provider key present is the
   * box's responsibility; we only check the CLI surface responds).
   * @param {string} name
   * @param {object} [opts]
   */
  async healthCheck(name, opts = {}) {
    const probe = await this.probe(name, opts)
    if (!probe.ok) throw new InstanceError('UNHEALTHY', `box ${name} is not responsive: ${probe.detail}`)
    try {
      const conversations = await this.client.agentList(name, { signal: opts.signal })
      return { ok: true, conversations: Array.isArray(conversations) ? conversations.length : 0 }
    } catch (error) {
      // agent ls failing is not fatal; the box may simply have no conversations.
      return { ok: true, conversations: 0, agentListError: error?.message }
    }
  }
}

/** @param {number} ms @param {AbortSignal} [signal] */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'))
    const timer = setTimeout(resolve, ms)
    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(new Error('aborted'))
      }, { once: true })
    }
  })
}

/**
 * Configuration normalization with explicit defaults and loud validation.
 * No external schema dependency: the DSH plugin entry wraps this in a
 * schemastery schema, while tests and the orchestrator use the normalized
 * plain object.
 *
 * @module instabox-bridge/core/config
 */

export class ConfigError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message)
    this.name = 'ConfigError'
    this.code = 'CONFIG_INVALID'
  }
}

export const DEFAULT_BOX_DIR = '/data/instabox-bridge'

/**
 * @param {object} input
 * @returns {object}
 */
export function normalizeConfig(input = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ConfigError('config must be an object')
  }
  const raw = input
  const cli = raw.cli ?? {}
  const instance = raw.instance ?? {}
  const handoff = raw.handoff ?? {}
  const routing = raw.routing ?? {}
  const sidecar = raw.boxSidecar ?? {}

  const mode = instance.mode ?? 'connect'
  if (!['connect', 'create'].includes(mode)) throw new ConfigError('instance.mode must be "connect" or "create"')

  const config = {
    enabled: raw.enabled !== false,
    providerName: nonEmptyString(raw.providerName, 'instabox', 'providerName', /^[a-z0-9-]+$/),
    cli: {
      program: nonEmptyString(cli.program, 'instabox', 'cli.program'),
      argsPrefix: stringArray(cli.argsPrefix ?? [], 'cli.argsPrefix'),
      cwd: optionalString(cli.cwd, 'cli.cwd'),
      timeoutMs: positiveInteger(cli.timeoutMs, 120000, 'cli.timeoutMs'),
      envPassthrough: stringArray(cli.envPassthrough ?? [], 'cli.envPassthrough'),
      runner: cli.runner === 'file' ? 'file' : 'pipe',
    },
    instance: {
      mode,
      name: optionalString(instance.name, 'instance.name'),
      org: optionalString(instance.org, 'instance.org'),
      template: optionalString(instance.template, 'instance.template'),
      vcpus: optionalPositiveInteger(instance.vcpus, 'instance.vcpus'),
      memMib: optionalPositiveInteger(instance.memMib, 'instance.memMib'),
      autoSuspend: optionalString(instance.autoSuspend, 'instance.autoSuspend'),
      meta: plainObject(instance.meta ?? {}, 'instance.meta'),
      createOnMissing: instance.createOnMissing ?? mode === 'create',
      secrets: optionalString(instance.secrets, 'instance.secrets'),
      readyTimeoutMs: positiveInteger(instance.readyTimeoutMs, 300000, 'instance.readyTimeoutMs'),
    },
    handoff: {
      timeoutMs: positiveInteger(handoff.timeoutMs, 180000, 'handoff.timeoutMs'),
      ackTimeoutMs: positiveInteger(handoff.ackTimeoutMs, 120000, 'handoff.ackTimeoutMs'),
      ingestTimeoutMs: positiveInteger(handoff.ingestTimeoutMs, 300000, 'handoff.ingestTimeoutMs'),
      maxAttempts: positiveInteger(handoff.maxAttempts, 3, 'handoff.maxAttempts'),
      retryBackoffMs: positiveInteger(handoff.retryBackoffMs, 1500, 'handoff.retryBackoffMs'),
      requireAgentAck: handoff.requireAgentAck !== false,
      maxAttachmentBytes: positiveInteger(handoff.maxAttachmentBytes, 25 * 1024 * 1024, 'handoff.maxAttachmentBytes'),
      maxPayloadBytes: positiveInteger(handoff.maxPayloadBytes, 32 * 1024 * 1024, 'handoff.maxPayloadBytes'),
      transferImages: handoff.transferImages !== false,
      redactMessageText: handoff.redactMessageText !== false,
      reason: optionalString(handoff.reason, 'handoff.reason'),
    },
    routing: {
      turnTimeoutMs: positiveInteger(routing.turnTimeoutMs, 600000, 'routing.turnTimeoutMs'),
      pollIntervalMs: positiveInteger(routing.pollIntervalMs, 40, 'routing.pollIntervalMs'),
      failoverOnError: routing.failoverOnError !== false,
      maxConsecutiveFailures: positiveInteger(routing.maxConsecutiveFailures, 2, 'routing.maxConsecutiveFailures'),
      dedupeLimit: positiveInteger(routing.dedupeLimit, 50, 'routing.dedupeLimit'),
      uncertainPolicy: routing.uncertainPolicy === 'auto-retry' ? 'auto-retry' : 'fail-closed',
    },
    boxSidecar: {
      dir: normalizeBoxPath(sidecar.dir ?? DEFAULT_BOX_DIR, 'boxSidecar.dir'),
      nodePath: nonEmptyString(sidecar.nodePath, 'node', 'boxSidecar.nodePath'),
      verifyTimeoutMs: positiveInteger(sidecar.verifyTimeoutMs, 60000, 'boxSidecar.verifyTimeoutMs'),
    },
    stateDir: optionalString(raw.stateDir, 'stateDir'),
    logLevel: ['debug', 'info', 'warn', 'error', 'silent'].includes(raw.logLevel) ? raw.logLevel : 'info',
    preferences: plainObject(raw.preferences ?? {}, 'preferences'),
    provider: optionalString(raw.provider, 'provider'),
    model: optionalString(raw.model, 'model'),
  }

  if (!config.instance.name && config.instance.mode === 'create' && instance.name === undefined) {
    // A deterministic name is produced per session at handoff time; nothing to
    // validate here.
  }
  if (config.instance.mode === 'connect' && !config.instance.name && !config.instance.createOnMissing) {
    // Allowed: the client discovers a box tagged with this session's id.
  }
  return config
}

/** @param {unknown} value @param {string} fallback @param {string} path @param {RegExp} [pattern] */
function nonEmptyString(value, fallback, path, pattern) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value !== 'string') throw new ConfigError(`${path} must be a string`)
  const trimmed = value.trim()
  if (trimmed.length === 0) throw new ConfigError(`${path} must not be empty`)
  if (pattern && !pattern.test(trimmed)) throw new ConfigError(`${path} must match ${pattern}`)
  return trimmed
}

/** @param {unknown} value @param {string} path */
function optionalString(value, path) {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new ConfigError(`${path} must be a string`)
  return value.trim()
}

/** @param {unknown} value @param {string} path */
function optionalPositiveInteger(value, path) {
  if (value === undefined || value === null) return undefined
  if (!Number.isInteger(value) || value <= 0) throw new ConfigError(`${path} must be a positive integer`)
  return value
}

/** @param {unknown} value @param {number} fallback @param {string} path */
function positiveInteger(value, fallback, path) {
  if (value === undefined || value === null) return fallback
  if (!Number.isInteger(value) || value <= 0) throw new ConfigError(`${path} must be a positive integer`)
  return value
}

/** @param {unknown} value @param {string} path */
function stringArray(value, path) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new ConfigError(`${path} must be an array of strings`)
  }
  return [...value]
}

/** @param {unknown} value @param {string} path */
function plainObject(value, path) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConfigError(`${path} must be an object`)
  }
  return { ...value }
}

/**
 * Normalize a POSIX box-absolute path under a fixed root and refuse traversal.
 * @param {unknown} value
 * @param {string} path
 * @returns {string}
 */
export function normalizeBoxPath(value, path) {
  if (typeof value !== 'string' || value.length === 0) throw new ConfigError(`${path} must be a string`)
  const trimmed = value.replace(/\\/g, '/').replace(/\/+$/, '')
  if (!trimmed.startsWith('/data/')) throw new ConfigError(`${path} must be under /data (got ${value})`)
  if (!/^[\/A-Za-z0-9._-]+$/.test(trimmed)) throw new ConfigError(`${path} contains unsupported characters`)
  const segments = trimmed.split('/').filter(Boolean)
  if (segments.length < 2 || segments[1] === '..') throw new ConfigError(`${path} must not contain path traversal`)
  return trimmed
}

/**
 * Resolve the harness home for default state placement.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolveDshHome(env = process.env) {
  const fromEnv = env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim()
  const home = env.USERPROFILE || env.HOME || '.'
  return `${home.replace(/\\/g, '/')}/.dsh`
}

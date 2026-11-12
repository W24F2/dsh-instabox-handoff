/**
 * Secret exclusion and redaction for handoff payloads and audit logs.
 *
 * Two independent passes:
 *  1. Values of known credential environment variables are replaced literally
 *     wherever they appear (they are only ever read, never persisted).
 *  2. Secret-shaped tokens and credential-assignment snippets are replaced by a
 *     typed marker.
 *
 * A conservative set of credential-named object keys is blanked entirely, so a
 * payload can never carry `{ apiKey: "..." }` even when the value does not look
 * like a key. Tool JSON schemas are left structurally intact: a schema *name* is
 * a map key under `properties`, which is not a credential-named key itself.
 *
 * @module instabox-bridge/core/redact
 */
import { canonicalize } from './canonical.js'

/** Environment variables whose values must never reach a payload or log. */
export const DEFAULT_SECRET_ENV_NAMES = [
  'INSTABOX_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'DEEPSEEK_API_KEY',
  'GITHUB_TOKEN',
  'GH_TOKEN',
]

/** Keys whose whole value is replaced, regardless of shape. */
const SENSITIVE_KEYS = new Set([
  'apikey',
  'api_key',
  'api-key',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'clientsecret',
  'client_secret',
  'privatekey',
  'private_key',
  'credentials',
  'authorization',
  'password',
  'secret',
])

/** Ordered token patterns and their marker. */
const TOKEN_PATTERNS = [
  { kind: 'instabox-key', regex: /ibk_[A-Za-z0-9_-]{8,}/g },
  { kind: 'deepseek-key', regex: /sk-[A-Za-z0-9_-]{16,}/g },
  { kind: 'github-token', regex: /github_pat_[A-Za-z0-9_]{20,}/g },
  { kind: 'github-token', regex: /gh[pousr]_[A-Za-z0-9]{16,}/g },
  { kind: 'aws-key', regex: /AKIA[0-9A-Z]{16}/g },
  { kind: 'slack-token', regex: /xox[abprs]-[A-Za-z0-9-]{10,}/g },
  { kind: 'bearer', regex: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g },
  {
    kind: 'credential-assignment',
    regex: /\b(api[_-]?key|access[_-]?token|auth[_-]?token|secret|password)\s*[:=]\s*["']?[^\s"',;]{8,}/gi,
  },
]

/** @param {string} key */
function isSensitiveKey(key) {
  const normalized = key.toLowerCase().replace(/[^a-z0-9_-]/g, '')
  return SENSITIVE_KEYS.has(normalized)
}

/**
 * Collect literal secret values from an environment.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string[]} [names]
 * @returns {string[]}
 */
export function collectEnvSecrets(env = process.env, names = DEFAULT_SECRET_ENV_NAMES) {
  const values = []
  for (const name of names) {
    const raw = env[name]
    if (typeof raw === 'string' && raw.trim().length >= 8) values.push(raw.trim())
  }
  return values
}

/**
 * Build a redactor.
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {string[]} [options.secretEnvNames]
 * @param {string[]} [options.extraSecrets]
 * @param {number} [options.maxRecords]
 * @returns {{ redact(value: unknown): { value: unknown, redactions: Array<{ path: string, kind: string }> }, redactText(text: string, path?: string): { text: string, kinds: string[] } }}
 */
export function createRedactor(options = {}) {
  const {
    env = process.env,
    secretEnvNames = DEFAULT_SECRET_ENV_NAMES,
    extraSecrets = [],
    maxRecords = 200,
  } = options
  const secrets = [...collectEnvSecrets(env, secretEnvNames), ...extraSecrets]
    .map((value) => String(value ?? '').trim())
    .filter((value) => value.length >= 8)

  const redactions = []

  /** @param {string} path @param {string} kind */
  function record(path, kind) {
    if (redactions.length >= maxRecords) return
    if (redactions.some((entry) => entry.path === path && entry.kind === kind)) return
    redactions.push({ path, kind })
  }

  /**
   * @param {string} text
   * @param {string} path
   * @returns {string}
   */
  function redactString(text, path) {
    let result = text
    for (const secret of secrets) {
      if (secret && result.includes(secret)) {
        result = result.split(secret).join('[redacted:secret-value]')
        record(path, 'secret-value')
      }
    }
    for (const pattern of TOKEN_PATTERNS) {
      if (!pattern.regex.test(result)) continue
      pattern.regex.lastIndex = 0
      result = result.replace(pattern.regex, `[redacted:${pattern.kind}]`)
      record(path, pattern.kind)
    }
    return result
  }

  /**
   * @param {unknown} value
   * @param {string} path
   * @returns {unknown}
   */
  function walk(value, path) {
    if (typeof value === 'string') return redactString(value, path)
    if (value === null || typeof value !== 'object') return value
    if (Array.isArray(value)) {
      return value.map((member, index) => walk(member, `${path}[${index}]`))
    }
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) return value
    const out = {}
    for (const [key, member] of Object.entries(value)) {
      if (isSensitiveKey(key) && (typeof member === 'string' || typeof member === 'number')) {
        out[key] = '[redacted:sensitive-field]'
        record(`${path}.${key}`, 'sensitive-field')
        continue
      }
      out[key] = walk(member, `${path}.${key}`)
    }
    return out
  }

  return {
    redact(value) {
      redactions.length = 0
      const redacted = walk(canonicalize(value), '$')
      return { value: redacted, redactions: [...redactions] }
    },
    redactText(text, path = '$') {
      const kinds = []
      const result = redactString(String(text), path)
      for (const entry of redactions) if (entry.path === path) kinds.push(entry.kind)
      return { text: result, kinds }
    },
  }
}

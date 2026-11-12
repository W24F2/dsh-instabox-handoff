/**
 * Deterministic JSON: one accepted representation for digests and storage.
 * Object keys are sorted, `undefined` object members are dropped, array holes
 * and `undefined` members become `null` (the same value JSON.stringify emits),
 * and non-JSON values, cycles, and excessive depth are refused loudly.
 *
 * @module instabox-bridge/core/canonical
 */
import { createHash } from 'node:crypto'

export class CanonicalJsonError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message)
    this.name = 'CanonicalJsonError'
    this.code = 'CANONICAL_JSON'
  }
}

const MAX_DEPTH = 64

/**
 * Recursively copy a lossless-JSON value into a key-sorted plain structure.
 * @param {unknown} value
 * @returns {unknown}
 */
export function canonicalize(value) {
  return cloneValue(value, [], '$', 0)
}

/**
 * @param {unknown} value
 * @param {unknown[]} stack
 * @param {string} path
 * @param {number} depth
 * @returns {unknown}
 */
function cloneValue(value, stack, path, depth) {
  if (depth > MAX_DEPTH) throw new CanonicalJsonError(`${path}: nesting exceeds ${MAX_DEPTH} levels`)
  if (value === null) return null
  const type = typeof value
  if (type === 'string' || type === 'boolean') return value
  if (type === 'number') {
    if (!Number.isFinite(value)) throw new CanonicalJsonError(`${path}: non-finite number is not JSON`)
    return value
  }
  if (type === 'undefined') return undefined
  if (type === 'bigint' || type === 'function' || type === 'symbol') {
    throw new CanonicalJsonError(`${path}: ${type} is not a JSON value`)
  }
  if (Array.isArray(value)) {
    if (stack.includes(value)) throw new CanonicalJsonError(`${path}: cyclic array`)
    stack.push(value)
    const out = value.map((member, index) => {
      const cloned = cloneValue(member, stack, `${path}[${index}]`, depth + 1)
      return cloned === undefined ? null : cloned
    })
    stack.pop()
    return out
  }
  if (type === 'object') {
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) {
      throw new CanonicalJsonError(`${path}: only plain objects are JSON values`)
    }
    if (stack.includes(value)) throw new CanonicalJsonError(`${path}: cyclic object`)
    stack.push(value)
    const out = {}
    for (const key of Object.keys(value).sort()) {
      const cloned = cloneValue(value[key], stack, `${path}.${key}`, depth + 1)
      if (cloned !== undefined) out[key] = cloned
    }
    stack.pop()
    return out
  }
  throw new CanonicalJsonError(`${path}: unsupported value`)
}

/**
 * Serialize a lossless-JSON value deterministically.
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  const cloned = canonicalize(value)
  if (cloned === undefined) throw new CanonicalJsonError('$: undefined is not a JSON document')
  return JSON.stringify(cloned)
}

/**
 * Stable SHA-256 over canonical JSON (or raw bytes).
 * @param {string | Uint8Array} input
 * @returns {string} lowercase hex
 */
export function sha256Hex(input) {
  const hash = createHash('sha256')
  hash.update(typeof input === 'string' ? input : Buffer.from(input))
  return hash.digest('hex')
}

/**
 * Digest of a payload document, excluding its own `digest` field.
 * @param {Record<string, unknown>} payload
 * @returns {string}
 */
export function digestOf(payload) {
  const copy = { ...payload }
  delete copy.digest
  return sha256Hex(canonicalJson(copy))
}

/**
 * Byte length of a canonical document.
 * @param {unknown} value
 * @returns {number}
 */
export function canonicalByteLength(value) {
  return Buffer.byteLength(canonicalJson(value), 'utf8')
}

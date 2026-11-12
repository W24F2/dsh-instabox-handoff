import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CanonicalJsonError, canonicalJson, canonicalize, digestOf, sha256Hex } from '../../plugin/lib/core/canonical.js'

test('canonical JSON sorts keys and drops undefined object members', () => {
  assert.equal(canonicalJson({ b: 1, a: 2, c: undefined }), '{"a":2,"b":1}')
  assert.equal(canonicalJson({ z: { y: 1, x: 2 } }), '{"z":{"x":2,"y":1}}')
})

test('undefined array members become null like JSON.stringify', () => {
  assert.equal(canonicalJson([1, undefined, 3]), '[1,null,3]')
})

test('non-JSON values and cycles are refused', () => {
  assert.throws(() => canonicalJson({ n: Number.NaN }), CanonicalJsonError)
  assert.throws(() => canonicalJson({ big: 1n }), CanonicalJsonError)
  const cyclic = { a: {} }
  cyclic.a.self = cyclic
  assert.throws(() => canonicalize(cyclic), /cyclic/)
  assert.throws(() => canonicalJson(new Date()), /plain objects/)
})

test('sha256 matches the standard vector and digests ignore key order', () => {
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  assert.equal(digestOf({ a: 1, b: 2 }), digestOf({ b: 2, a: 1 }))
  assert.notEqual(digestOf({ a: 1, b: 2 }), digestOf({ a: 1, b: 3 }))
})

test('digestOf drops only the top-level digest field', () => {
  const payload = { x: 1, digest: 'ignored' }
  assert.equal(digestOf(payload), digestOf({ x: 1 }))
})

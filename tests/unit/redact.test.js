import assert from 'node:assert/strict'
import { test } from 'node:test'
import { collectEnvSecrets, createRedactor } from '../../plugin/lib/core/redact.js'

test('literal environment secrets are removed', () => {
  const env = { INSTABOX_API_KEY: 'ibk_livevalue_0123456789', ANTHROPIC_API_KEY: 'sk-ant-verysecretvalue1234567890' }
  const redactor = createRedactor({ env })
  const result = redactor.redact({ note: `key is ibk_livevalue_0123456789 and sk-ant-verysecretvalue1234567890` })
  assert.equal(result.value.note, 'key is [redacted:secret-value] and [redacted:secret-value]')
  assert.equal(result.redactions.length, 1)
})

test('secret-shaped tokens are redacted without env values', () => {
  const redactor = createRedactor({ env: {} })
  const result = redactor.redact({
    text: 'sk-abcdefghijklmnopqrstuvwx gh p? github_pat_abcdefghijklmnopqrstuv AKIAIOSFODNN7EXAMPLE',
  })
  assert.doesNotMatch(JSON.stringify(result.value), /sk-abcdefghijklmnopqrstuvwx/)
  assert.doesNotMatch(JSON.stringify(result.value), /AKIAIOSFODNN7EXAMPLE/)
  assert.ok(result.redactions.length >= 2)
})

test('credential-named keys are blanked but tool schema property names survive', () => {
  const redactor = createRedactor({ env: {} })
  const value = {
    apiKey: 'plainlookingvalue',
    password: 'x',
    properties: { token: { type: 'string' }, password: { type: 'string' } },
  }
  const result = redactor.redact(value)
  assert.equal(result.value.apiKey, '[redacted:sensitive-field]')
  assert.equal(result.value.password, '[redacted:sensitive-field]')
  assert.equal(result.value.properties.token.type, 'string')
  assert.equal(result.value.properties.password.type, 'string')
})

test('redaction never mutates the input and reports text kinds', () => {
  const redactor = createRedactor({ env: {} })
  const source = { text: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz' }
  const before = JSON.stringify(source)
  const result = redactor.redact(source)
  assert.equal(JSON.stringify(source), before)
  assert.doesNotMatch(result.value.text, /abcdefghijklmnopqrstuvwxyz/)
  assert.deepEqual(redactor.redactText('nothing here', '$').kinds, [])
})

test('collectEnvSecrets ignores short values', () => {
  assert.deepEqual(collectEnvSecrets({ INSTABOX_API_KEY: 'short' }, ['INSTABOX_API_KEY']), [])
  assert.deepEqual(collectEnvSecrets({ INSTABOX_API_KEY: 'a'.repeat(20) }, ['INSTABOX_API_KEY']), ['a'.repeat(20)])
})

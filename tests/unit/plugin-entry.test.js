import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as plugin from '../../plugin/lib/index.js'

// The entry point is what the DSH loader imports. A syntax error or a non-async
// `apply` here means the plugin silently never loads, so it gets its own tests.

test('entry exports the Cordis plugin contract', () => {
  assert.equal(plugin.name, 'instabox-bridge')
  assert.deepEqual(plugin.inject, ['tools', 'commands', 'llm', 'sessions', 'agents'])
  assert.equal(typeof plugin.apply, 'function')
  assert.equal(plugin.apply.constructor.name, 'AsyncFunction', 'apply awaits file reads, so it must be async')
  assert.equal(typeof plugin.Config, 'object')
})

test('every service the plugin injects is optional-chained in apply()', () => {
  // A missing service must degrade, not throw; the loader can supply a profile
  // that lacks e.g. `llm`.
  const ctx = { logger: { info() {}, warn() {}, error() {}, debug() {} } }
  assert.doesNotThrow(() => {
    const config = plugin.Config
    assert.equal(config.properties.handoff.properties.includeMemory.default, true)
    assert.equal(config.properties.handoff.properties.memoryDailyDays.default, 7)
    assert.equal(config.properties.handoff.properties.maxMemoryBytes.default, 2097152)
  })
})

test('apply() runs against a minimal stub context', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'ibs-plugin-'))
  const registered = { tools: [], commands: [] }
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    tools: { register: (def) => registered.tools.push(def.name) },
    commands: { register: (def) => registered.commands.push(def.name) },
  }

  await assert.doesNotReject(plugin.apply(ctx, { enabled: true, stateDir }))

  assert.deepEqual(registered.tools.sort(), ['instabox_handoff', 'instabox_reclaim', 'instabox_status'])
  assert.deepEqual(registered.commands.sort(), ['handoff', 'handoff-status', 'reclaim'])
})

test('apply() returns early when disabled', async () => {
  const calls = []
  const ctx = {
    logger: { info() {}, warn() {} },
    tools: { register: () => calls.push('tool') },
    commands: { register: () => calls.push('command') },
  }
  await plugin.apply(ctx, { enabled: false })
  assert.deepEqual(calls, [])
})

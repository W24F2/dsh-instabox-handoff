import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeConfig } from '../../plugin/lib/core/config.js'
import { SessionStateStore, createState } from '../../plugin/lib/core/state.js'
import { createClient } from '../../plugin/lib/core/client.js'
import { InstanceManager } from '../../plugin/lib/core/instance.js'
import { MessageRouter } from '../../plugin/lib/core/router.js'
import { Orchestrator } from '../../plugin/lib/core/orchestrator.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FAKE_CLI = join(__dirname, '..', 'fixtures', 'fake-instabox.mjs')
const SIDECAR = join(__dirname, '..', '..', 'plugin', 'box-side', 'verify.mjs')

function makeConfig(overrides = {}) {
  const stateFile = join(mkdtempSync(join(tmpdir(), 'ibs-fake-')), 'state.json')
  process.env.FAKE_INSTABOX_STATE = stateFile
  return normalizeConfig({
    enabled: true,
    cli: {
      program: process.execPath,
      argsPrefix: [FAKE_CLI],
      runner: 'file',
      timeoutMs: 30000,
    },
    instance: {
      mode: 'create',
      name: 'test-box',
      readyTimeoutMs: 30000,
    },
    handoff: {
      timeoutMs: 60000,
      ackTimeoutMs: 30000,
      ingestTimeoutMs: 30000,
      maxAttempts: 2,
      retryBackoffMs: 100,
    },
    routing: {
      turnTimeoutMs: 30000,
      pollIntervalMs: 10,
      failoverOnError: true,
      maxConsecutiveFailures: 2,
      dedupeLimit: 10,
    },
    boxSidecar: {
      dir: '/data/instabox-bridge',
      nodePath: process.execPath,
      verifyTimeoutMs: 30000,
    },
    stateDir: join(mkdtempSync(join(tmpdir(), 'ibs-state-')), 'state'),
    ...overrides,
  })
}

function makeStack(config) {
  const state = new SessionStateStore({ rootDir: config.stateDir })
  const client = createClient(config)
  const instance = new InstanceManager({ client, config, state })
  const router = new MessageRouter({ client, state, config })
  const sidecarSource = readFileSync(SIDECAR, 'utf8')
  const memoryReader = async () => ({
    capturedAt: Date.now(),
    root: 'C:/memories',
    projectPath: 'C:/work',
    projectKey: 'abcdef123456',
    project: { path: 'projects/abcdef123456/MEMORY.md', text: '# project log\nfact\n', truncated: false, bytes: 20 },
    daily: [
      { date: '2026-11-12', path: 'daily/2026-11-12.md', text: 'daily entry\n', truncated: false, bytes: 13 },
    ],
    fileCount: 2,
    bytes: 33,
    truncated: false,
  })
  const orchestrator = new Orchestrator({
    client,
    instance,
    state,
    router,
    config,
    memoryReader,
    sidecarSource,
    sessionReader: async (sessionId) => ({
      events: [
        { seq: 0, time: 1000, type: 'turn/start', data: { turn: 1 } },
        { seq: 1, time: 1010, type: 'user/message', data: { id: 'm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Hello box' }] } },
        { seq: 2, time: 1020, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
      ],
      header: { createdAt: 1000, cwd: 'C:/work' },
      agentStatus: 'idle',
      inbox: null,
      agent: null,
    }),
  })
  return { state, client, instance, router, orchestrator }
}

test('full handoff: create box, transfer, verify, agent ack, delegated', async () => {
  const config = makeConfig()
  const { state, orchestrator } = makeStack(config)
  const result = await orchestrator.handoff('session-e2e-1', { reason: 'test' })
  assert.equal(result.phase, 'delegated')
  assert.equal(result.box.name, 'test-box')
  assert.ok(result.conversationId)
  assert.ok(result.ack.digestMatch)
  assert.equal(result.ack.schemaValid, true)
  // The ACK reply contains the marker and confirmation text.
  assert.ok(result.ackReplyText.includes('instabox-handoff:ack'))
  assert.ok(result.ackReplyText.includes('Context ingested'))

  const loaded = await state.load('session-e2e-1')
  assert.equal(loaded.phase, 'delegated')
  assert.equal(loaded.originalRoute.provider, 'unknown')
  // The chat memory capture is summarized into state and confirmed by the box verifier.
  assert.deepEqual(loaded.memory, {
    projectKey: 'abcdef123456',
    dailyCount: 1,
    fileCount: 2,
    bytes: 33,
    truncated: false,
  })
  assert.equal(loaded.ack.schemaValid, true, 'box verifier accepted the payload with a memory section')
  assert.equal(loaded.ack.memoryFileCount, 2, 'box verifier counted the memory files it received')
})

test('subsequent messages route to box and replies are cached', async () => {
  const config = makeConfig()
  const { state, orchestrator, router } = makeStack(config)
  await orchestrator.handoff('session-e2e-2', {})
  const st = await state.load('session-e2e-2')

  const messages = [{ id: 'u2', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'What is 2+2?' }] }]
  const key = 'test-key-1'
  const reply1 = await router.route('session-e2e-2', st, key, messages)
  assert.ok(reply1.text.includes('InstaBox agent received'))

  // The reply should contain the user's new message text.
  assert.ok(reply1.text.includes('What is 2+2?'))

  // Same key returns cached reply without re-prompting.
  const reply2 = await router.route('session-e2e-2', st, key, messages)
  // The cached reply is the same object content; compare all fields.
  assert.equal(reply2.text, reply1.text)
  assert.equal(reply2.exitCode, reply1.exitCode)
  assert.equal(reply2.turnEndExitCode, reply1.turnEndExitCode)
  assert.equal(reply2.sawTurnEnd, reply1.sawTurnEnd)

  // Reload state after cache check to verify no duplicate entries.
  const loadedMid = await state.load('session-e2e-2')
  assert.equal(loadedMid.routed.length, 1)
  assert.equal(loadedMid.lastRoutedKey, key)
})

test('reclaim returns control and preserves state', async () => {
  const config = makeConfig()
  const { state, orchestrator } = makeStack(config)
  await orchestrator.handoff('session-e2e-3', {})
  const reclaimed = await orchestrator.reclaim('session-e2e-3', { reason: 'test reclaim' })
  assert.equal(reclaimed.phase, 'reclaimed')
  assert.equal(reclaimed.reclaimedReason, 'test reclaim')
  assert.ok(reclaimed.box.name)
})

test('handoff failure leaves session in failed phase, not delegated', async () => {
  const config = makeConfig({
    cli: { program: process.execPath, argsPrefix: [FAKE_CLI], runner: 'file', timeoutMs: 30000 },
    instance: { mode: 'create', name: 'fail-box' },
  })
  // Force a verifier failure by using a bogus node path.
  config.boxSidecar.nodePath = 'nonexistent-node-binary'
  const { state, orchestrator } = makeStack(config)
  const result = await orchestrator.handoff('session-e2e-4', {}).catch((e) => e)
  assert.ok(result instanceof Error, `expected rejection, got ${JSON.stringify(result)}`)
  const loaded = await state.load('session-e2e-4')
  assert.equal(loaded.phase, 'failed')
  assert.ok(loaded.lastError)
})

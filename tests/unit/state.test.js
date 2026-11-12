import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createState, SessionStateStore, StateError, safeFileName, trimRouted, validateState } from '../../plugin/lib/core/state.js'

test('createState produces a valid idle document', () => {
  const state = createState('session-1')
  assert.equal(state.phase, 'idle')
  assert.equal(state.sessionId, 'session-1')
  assert.equal(state.schemaVersion, 1)
  assert.doesNotThrow(() => validateState(state))
})

test('validateState rejects bad documents', () => {
  assert.throws(() => validateState(null), StateError)
  assert.throws(() => validateState({ schemaVersion: 2, sessionId: 'x', phase: 'idle', routed: [] }), /schema version/)
  assert.throws(() => validateState({ schemaVersion: 1, sessionId: 'x', phase: 'bogus', routed: [] }), /unknown phase/)
})

test('safeFileName sanitizes session ids', () => {
  assert.equal(safeFileName('session-abc'), 'session-abc')
  assert.equal(safeFileName('a/b\\c:d'), 'a_b_c_d')
  assert.throws(() => safeFileName('..'), StateError)
})

test('save and load round-trip atomically', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ibs-state-'))
  const s = new SessionStateStore({ rootDir: dir })
  const state = createState('s1', { phase: 'delegated', box: { name: 'b1' } })
  await s.save(state)
  const loaded = await s.load('s1')
  assert.equal(loaded.phase, 'delegated')
  assert.equal(loaded.box.name, 'b1')
  await rm(dir, { recursive: true, force: true })
})

test('load returns null for missing and quarantines corrupt files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ibs-state-'))
  const s = new SessionStateStore({ rootDir: dir })
  assert.equal(await s.load('missing'), null)
  await s.ensureDirs()
  const { writeFile } = await import('node:fs/promises')
  await writeFile(s.fileFor('bad'), 'not json{{{', 'utf8')
  assert.equal(await s.load('bad'), null)
  // corrupt file was renamed away
  const names = await import('node:fs/promises').then((fs) => fs.readdir(s.sessionsDir))
  assert.ok(names.some((n) => n.includes('.corrupt-')))
  await rm(dir, { recursive: true, force: true })
})

test('update serializes read-modify-write per session', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ibs-state-'))
  const s = new SessionStateStore({ rootDir: dir })
  await Promise.all([
    s.update('s2', async (state) => {
      const next = state ?? createState('s2')
      next.failures = { count: (next.failures?.count ?? 0) + 1, lastError: null, lastAt: null }
      return next
    }),
    s.update('s2', async (state) => {
      const next = state ?? createState('s2')
      next.failures = { count: (next.failures?.count ?? 0) + 1, lastError: null, lastAt: null }
      return next
    }),
  ])
  const loaded = await s.load('s2')
  assert.equal(loaded.failures.count, 2)
  await rm(dir, { recursive: true, force: true })
})

test('audit appends JSONL entries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ibs-state-'))
  const s = new SessionStateStore({ rootDir: dir })
  await s.audit('s3', { event: 'handoff-start', handoffId: 'h1' })
  await s.audit('s3', { event: 'handoff-done' })
  const text = await readFile(join(dir, 'audit', 's3.jsonl'), 'utf8')
  const lines = text.trim().split('\n')
  assert.equal(lines.length, 2)
  assert.equal(JSON.parse(lines[0]).event, 'handoff-start')
  await rm(dir, { recursive: true, force: true })
})

test('trimRouted keeps the newest entries', () => {
  const routed = Array.from({ length: 10 }, (_, i) => ({ key: `k${i}` }))
  const trimmed = trimRouted(routed, 3)
  assert.deepEqual(trimmed.map((r) => r.key), ['k7', 'k8', 'k9'])
})

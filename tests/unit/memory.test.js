import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  projectMemoryKey,
  readChatMemory,
  resolveMemoryRoot,
  summarizeMemory,
} from '../../plugin/lib/core/memory.js'

/** Build a memory root with one project log and N daily journals. */
function makeMemoryRoot({ projectKey, projectText = '# project log\nfact one\n', days = [] } = {}) {
  const root = join(mkdtempSync(join(tmpdir(), 'ibs-memory-')), 'memories')
  mkdirSync(join(root, 'projects', projectKey), { recursive: true })
  writeFileSync(join(root, 'projects', projectKey, 'MEMORY.md'), projectText, 'utf8')
  mkdirSync(join(root, 'daily'), { recursive: true })
  for (const [date, text] of days) {
    writeFileSync(join(root, 'daily', `${date}.md`), text, 'utf8')
  }
  return root
}

test('projectMemoryKey is the 12-hex sha1 prefix of the resolved path', () => {
  const key = projectMemoryKey('C:/work')
  assert.match(key, /^[0-9a-f]{12}$/)
  assert.equal(projectMemoryKey('C:/work'), key)
  assert.notEqual(projectMemoryKey('C:/other'), key)
})

test('resolveMemoryRoot honours an explicit DSH home over the environment', () => {
  const home = 'C:/dsh-home'
  assert.match(resolveMemoryRoot({ dshHome: home }), /memories$/)
  assert.match(resolveMemoryRoot({ env: { DSH_HOME: 'C:/from-env' }, home: 'C:/user' }), /from-env[\\/]memories$/)
})

test('reads the project log and the newest daily journals', async () => {
  const cwd = 'C:/work/project-a'
  const key = projectMemoryKey(cwd)
  const root = makeMemoryRoot({
    projectKey: key,
    days: [
      ['2026-11-10', 'old entry'],
      ['2026-11-11', 'middle entry'],
      ['2026-11-12', 'newest entry'],
    ],
  })

  const memory = await readChatMemory({ dshHome: join(root, '..'), cwd, dailyDays: 2 })

  assert.equal(memory.projectKey, key)
  assert.ok(memory.project, 'project log should be captured')
  assert.equal(memory.project.path, `projects/${key}/MEMORY.md`)
  assert.match(memory.project.text, /project log/)
  assert.equal(memory.daily.length, 2, 'dailyDays caps the number of journals')
  assert.deepEqual(memory.daily.map((d) => d.date), ['2026-11-12', '2026-11-11'])
  assert.equal(memory.fileCount, 3)
  assert.equal(memory.truncated, false)
  assert.ok(memory.bytes > 0)
})

test('a missing memory tree yields an empty capture, never an error', async () => {
  const memory = await readChatMemory({
    dshHome: join(mkdtempSync(join(tmpdir(), 'ibs-empty-')), 'does-not-exist'),
    cwd: 'C:/work',
  })

  assert.equal(memory.project, null)
  assert.deepEqual(memory.daily, [])
  assert.equal(memory.fileCount, 0)
  assert.equal(memory.bytes, 0)
})

test('maxBytes is enforced and reported as truncation', async () => {
  const cwd = 'C:/work/truncated'
  const key = projectMemoryKey(cwd)
  const root = makeMemoryRoot({
    projectKey: key,
    projectText: 'A'.repeat(400),
    days: [['2026-11-12', 'B'.repeat(400)]],
  })

  const memory = await readChatMemory({ dshHome: join(root, '..'), cwd, maxBytes: 300 })

  assert.equal(memory.truncated, true)
  assert.ok(memory.bytes <= 300, `bytes ${memory.bytes} must respect the cap`)
  assert.equal(memory.project.truncated, true)
  assert.equal(memory.project.bytes, 300)
})

test('summarizeMemory exposes counts without file contents', async () => {
  const cwd = 'C:/work/summary'
  const key = projectMemoryKey(cwd)
  const root = makeMemoryRoot({ projectKey: key, days: [['2026-11-12', 'entry']] })
  const memory = await readChatMemory({ dshHome: join(root, '..'), cwd })

  const summary = summarizeMemory(memory)
  assert.deepEqual(Object.keys(summary).sort(), ['bytes', 'dailyCount', 'fileCount', 'projectKey', 'truncated'])
  assert.equal(summary.projectKey, key)
  assert.equal(summary.dailyCount, 1)
  assert.equal(summary.fileCount, 2)
  assert.equal(JSON.stringify(summary).includes('entry'), false, 'summary must not leak file text')
})

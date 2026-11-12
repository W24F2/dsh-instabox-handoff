import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RunnerError, minimalEnv, run } from '../../plugin/lib/core/runner.js'

const PIPE_OK = process.env.INSTABOX_BRIDGE_TEST_PIPE === '1'
const RUNNER = PIPE_OK ? 'pipe' : 'file'

test('runner executes and captures output', async () => {
  const result = await run({
    program: process.execPath,
    args: ['-e', 'console.log("hello"); console.error("warn")'],
    runner: RUNNER,
    timeoutMs: 10000,
  })
  assert.equal(result.exitCode, 0)
  assert.equal(result.stdout.trim(), 'hello')
  assert.equal(result.stderr.trim(), 'warn')
  assert.equal(result.timedOut, false)
})

test('file runner executes and captures output', async () => {
  const result = await run({
    program: process.execPath,
    args: ['-e', 'console.log("file-ok")'],
    runner: 'file',
    timeoutMs: 10000,
  })
  assert.equal(result.exitCode, 0)
  assert.equal(result.stdout.trim(), 'file-ok')
})

test('non-zero exit code is reported, not thrown', async () => {
  const result = await run({
    program: process.execPath,
    args: ['-e', 'process.exit(3)'],
    runner: RUNNER,
    timeoutMs: 10000,
  })
  assert.equal(result.exitCode, 3)
})

test('missing program resolves with an error field', async () => {
  const result = await run({
    program: 'definitely-not-a-real-program-xyz',
    args: [],
    runner: RUNNER,
    timeoutMs: 10000,
  })
  assert.equal(result.exitCode, -1)
  assert.ok(result.error)
})

test('timeout kills the child and marks timedOut', async () => {
  const result = await run({
    program: process.execPath,
    args: ['-e', 'setTimeout(() => {}, 60000)'],
    runner: RUNNER,
    timeoutMs: 300,
  })
  assert.equal(result.timedOut, true)
})

test('minimalEnv keeps only allow-listed variables', () => {
  const env = minimalEnv({
    PATH: '/usr/bin',
    HOME: '/home/x',
    INSTABOX_API_KEY: 'ibk_secret',
    MY_SECRET: 'should-not-pass',
    OTHER: 'no',
  })
  assert.equal(env.PATH, '/usr/bin')
  assert.equal(env.INSTABOX_API_KEY, 'ibk_secret')
  assert.equal(env.MY_SECRET, undefined)
  assert.equal(env.OTHER, undefined)
})

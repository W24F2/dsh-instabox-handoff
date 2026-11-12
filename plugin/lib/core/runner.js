/**
 * Child process runner with an injectable file-backed transport.
 *
 * Production (inside DSH) uses normal piped stdio. The workspace sandbox
 * forbids piped stdio from Node (`EPERM`), so tests configure
 * `cli.runner = 'file'` (or set `INSTABOX_BRIDGE_RUNNER=file`): stdout/stderr
 * go to temporary files which are read after exit. The public contract —
 * resolve on exit code, reject on spawn failure — is identical.
 *
 * @module instabox-bridge/core/runner
 */
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export class RunnerError extends Error {
  /** @param {string} code @param {string} message @param {object} [extra] */
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'RunnerError'
    this.code = code
    Object.assign(this, extra)
  }
}

/**
 * Run a command to completion.
 * @param {object} options
 * @param {string} options.program
 * @param {string[]} options.args
 * @param {string} [options.cwd]
 * @param {NodeJS.ProcessEnv} [options.env] - complete environment; defaults to a minimal safe env
 * @param {number} [options.timeoutMs]
 * @param {'pipe' | 'file'} [options.runner]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ exitCode: number, signal: string | null, stdout: string, stderr: string, timedOut: boolean, durationMs: number, error?: string }>}
 */
export function run(options) {
  const {
    program,
    args = [],
    cwd,
    env,
    timeoutMs = 120000,
    runner = 'pipe',
    signal,
  } = options

  return new Promise(async (resolve, reject) => {
    const started = Date.now()
    let outFile = null
    let errFile = null
    let workDir = null
    let child = null

    const finish = async (result) => {
      if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => {})
      resolve({ ...result, durationMs: Date.now() - started })
    }

    try {
      if (runner === 'file') {
        workDir = await mkdtemp(join(tmpdir(), 'instabox-bridge-'))
        outFile = join(workDir, 'stdout')
        errFile = join(workDir, 'stderr')
        const { openSync, closeSync } = await import('node:fs')
        const outFd = openSync(outFile, 'w')
        const errFd = openSync(errFile, 'w')
        child = spawn(program, args, {
          cwd,
          env: env ?? minimalEnv(),
          stdio: ['ignore', outFd, errFd],
          windowsHide: true,
        })
        closeSync(outFd)
        closeSync(errFd)
      } else {
        child = spawn(program, args, {
          cwd,
          env: env ?? minimalEnv(),
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        })
      }
    } catch (error) {
      reject(new RunnerError('SPAWN_FAILED', `failed to start ${program}: ${error?.message ?? error}`))
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false

    const onAbort = () => {
      if (child && !child.killed) child.kill('SIGTERM')
    }
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }

    const timeout = setTimeout(() => {
      timedOut = true
      if (child && !child.killed) child.kill('SIGTERM')
      // Give the child a short grace period before SIGKILL.
      setTimeout(() => {
        if (child && !child.killed) child.kill('SIGKILL')
      }, 5000).unref()
    }, timeoutMs)

    const collect = (stream, name) => {
      if (!stream) return
      stream.on('data', (chunk) => {
        if (name === 'stdout') stdout += chunk.toString('utf8')
        else stderr += chunk.toString('utf8')
        if (stdout.length + stderr.length > 64 * 1024 * 1024) {
          // Safety valve: unbounded capture would be a memory problem.
          if (name === 'stdout') stdout = stdout.slice(0, 32 * 1024 * 1024)
          else stderr = stderr.slice(0, 32 * 1024 * 1024)
        }
      })
    }

    if (runner === 'pipe') {
      collect(child.stdout, 'stdout')
      collect(child.stderr, 'stderr')
    }

    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (signal) signal.removeEventListener('abort', onAbort)
      finish({
        exitCode: -1,
        signal: null,
        stdout,
        stderr,
        timedOut,
        error: error?.code === 'ENOENT' ? `program not found: ${program}` : error?.message ?? String(error),
      })
    })

    child.on('close', async (exitCode, killSignal) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (signal) signal.removeEventListener('abort', onAbort)
      if (runner === 'file') {
        try {
          stdout = await readFile(outFile, 'utf8')
          stderr = await readFile(errFile, 'utf8')
        } catch {}
      }
      finish({
        exitCode: typeof exitCode === 'number' ? exitCode : -1,
        signal: killSignal ?? null,
        stdout,
        stderr,
        timedOut,
        ...(timedOut ? { error: `timed out after ${timeoutMs}ms` } : {}),
      })
    })
  })
}

/**
 * Minimal environment for CLI children: PATH, HOME, TMPDIR and the documented
 * InstaBox variables only. Everything else is intentionally omitted so a
 * credential in the parent's environment cannot leak into argv-visible places
 * unless explicitly allow-listed.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string[]} [extraNames]
 * @returns {NodeJS.ProcessEnv}
 */
export function minimalEnv(env = process.env, extraNames = []) {
  const names = new Set([
    'PATH',
    'HOME',
    'USERPROFILE',
    'TMPDIR',
    'TEMP',
    'TMP',
    'SystemRoot',
    'WINDIR',
    'ComSpec',
    'PATHEXT',
    'INSTABOX_API_KEY',
    'INSTABOX_NO_UPDATE_CHECK',
    'INSTABOX_CONFIG',
    ...extraNames,
  ])
  /** @type {NodeJS.ProcessEnv} */
  const out = {}
  for (const name of names) {
    const value = env[name]
    if (typeof value === 'string' && value.length > 0) out[name] = value
  }
  return out
}

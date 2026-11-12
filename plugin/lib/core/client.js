/**
 * InstaBox CLI client. Only documented `instabox` commands are used; no HTTP
 * endpoints are invented. Authentication is by the CLI's own sign-in or
 * `INSTABOX_API_KEY`, which the caller's environment supplies to the child —
 * never stored, logged, or placed in arguments.
 *
 * @module instabox-bridge/core/client
 */
import { spawn } from 'node:child_process'
import { RunnerError, minimalEnv, run } from './runner.js'

/** Documented exit codes from the instabox CLI contract. */
export const EXIT = {
  USAGE: 2,
  AUTH: 3,
  NOT_FOUND: 4,
  QUOTA: 5,
  CREATE_TIMEOUT: 6,
  RETRYABLE: 75,
  TIMEOUT: 124,
}

export class InstaBoxError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {object} [extra]
   */
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'InstaBoxError'
    this.code = code
    Object.assign(this, extra)
  }
}

/**
 * Map a CLI result to a typed error, or null when it succeeded.
 * @param {{ exitCode: number, stdout?: string, stderr?: string, timedOut?: boolean, error?: string }} result
 * @param {string} command
 * @returns {InstaBoxError | null}
 */
export function classifyCliResult(result, command) {
  if (result.timedOut) {
    return new InstaBoxError('CLI_TIMEOUT', `${command} timed out`, { retryable: true, exitCode: result.exitCode })
  }
  if (result.error) {
    return new InstaBoxError('CLI_SPAWN_FAILED', `${command}: ${result.error}`, { retryable: false, exitCode: result.exitCode })
  }
  if (result.exitCode === 0) return null
  const stderr = (result.stderr ?? '').trim()
  const stdout = (result.stdout ?? '').trim()
  const body = stderr || stdout || `exit code ${result.exitCode}`
  const code = `CLI_EXIT_${result.exitCode}`
  const retryable = result.exitCode === EXIT.RETRYABLE || result.exitCode >= 500
  return new InstaBoxError(code, `${command} failed: ${body.slice(0, 400)}`, {
    retryable,
    exitCode: result.exitCode,
    stderr: stderr.slice(0, 2000),
    stdout: stdout.slice(0, 2000),
  })
}

export class InstaBoxClient {
  /**
   * @param {object} options
   * @param {object} options.config - normalized config (see core/config.js)
   * @param {{ info?: Function, warn?: Function, error?: Function, debug?: Function }} [options.logger]
   * @param {(command: string[], opts?: object) => Promise<any>} [options.exec] - test hook
   */
  constructor({ config, logger = console, exec } = {}) {
    this.config = config
    this.logger = logger
    this._exec = exec ?? null
  }

  /** @param {string[]} args @param {object} [opts] */
  async cli(args, opts = {}) {
    const cli = this.config.cli
    const fullArgs = [...cli.argsPrefix, ...args]
    if (this._exec) return this._exec(fullArgs, opts)
    const env = minimalEnv(process.env, cli.envPassthrough)
    // Tests set FAKE_INSTABOX_STATE for the fake CLI; pass it through.
    if (process.env.FAKE_INSTABOX_STATE) env.FAKE_INSTABOX_STATE = process.env.FAKE_INSTABOX_STATE
    if (process.env.FAKE_INSTABOX_FAIL) env.FAKE_INSTABOX_FAIL = process.env.FAKE_INSTABOX_FAIL
    const result = await run({
      program: cli.program,
      args: fullArgs,
      cwd: cli.cwd,
      env,
      timeoutMs: opts.timeoutMs ?? cli.timeoutMs,
      runner: cli.runner,
      signal: opts.signal,
    })
    const error = classifyCliResult(result, `instabox ${args[0] ?? ''}`)
    if (error) throw error
    return result
  }

  /**
   * Run a command that prints JSON (`--json`); returns the parsed object.
   * @param {string[]} args
   * @param {object} [opts]
   * @returns {Promise<any>}
   */
  async cliJson(args, opts = {}) {
    const result = await this.cli([...args, '--json'], opts)
    const text = (result.stdout ?? '').trim()
    if (!text) return null
    try {
      return JSON.parse(text)
    } catch {
      // Some commands print a human line before JSON; take the last object.
      const start = text.lastIndexOf('{')
      const end = text.lastIndexOf('}')
      if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1))
      throw new InstaBoxError('CLI_JSON_PARSE', `could not parse JSON from instabox ${args[0]}`, {
        stdout: text.slice(0, 500),
      })
    }
  }

  /** @param {object} [opts] */
  async whoami(opts = {}) {
    return this.cliJson(['whoami'], opts)
  }

  /** @param {string} nameOrId @param {object} [opts] */
  async get(nameOrId, opts = {}) {
    return this.cliJson(['get', nameOrId], opts)
  }

  /** @param {object} [opts] */
  async list(opts = {}) {
    const result = await this.cli(['ls'], opts)
    // `ls` prints a table; `--json` gives an array. Prefer JSON.
    try {
      return await this.cliJson(['ls'], opts)
    } catch {
      return { raw: result.stdout }
    }
  }

  /**
   * Create a box. Only documented flags are passed.
   * @param {object} spec
   * @param {string} spec.name
   * @param {object} [spec.meta]
   * @param {string} [spec.template]
   * @param {number} [spec.vcpus]
   * @param {number} [spec.memMib]
   * @param {string} [spec.autoSuspend]
   * @param {string} [spec.secrets]
   * @param {string} [spec.org]
   * @param {number} [spec.readyTimeoutMs]
   * @param {AbortSignal} [spec.signal]
   */
  async create(spec) {
    const args = ['create', '--name', spec.name, '--json']
    if (spec.meta) for (const [k, v] of Object.entries(spec.meta)) args.push('--meta', `${k}=${v}`)
    if (spec.template) args.push('--template', spec.template)
    if (spec.vcpus) args.push('--vcpus', String(spec.vcpus))
    if (spec.memMib) args.push('--mem-mib', String(spec.memMib))
    if (spec.autoSuspend) args.push('--auto-suspend', spec.autoSuspend)
    if (spec.secrets) args.push('--secrets', spec.secrets)
    if (spec.org) args.push('--org', spec.org)
    if (spec.readyTimeoutMs) args.push('--ready-timeout', `${Math.round(spec.readyTimeoutMs / 1000)}s`)
    return this.cliJson(args, { signal: spec.signal, timeoutMs: this.config.instance.readyTimeoutMs })
  }

  /** @param {string} nameOrId @param {object} [opts] */
  async start(nameOrId, opts = {}) {
    return this.cliJson(['start', nameOrId], opts)
  }

  /** @param {string} nameOrId @param {object} [opts] */
  async resume(nameOrId, opts = {}) {
    return this.cliJson(['resume', nameOrId], opts)
  }

  /** @param {string} nameOrId @param {object} [opts] */
  async wake(nameOrId, opts = {}) {
    return this.cliJson(['wake', nameOrId], opts)
  }

  /** @param {string} nameOrId @param {object} [opts] */
  async stop(nameOrId, opts = {}) {
    return this.cliJson(['stop', nameOrId], opts)
  }

  /** @param {string} nameOrId @param {object} [opts] */
  async restart(nameOrId, opts = {}) {
    return this.cliJson(['restart', nameOrId], opts)
  }

  /**
   * Run a command in the box. `args` is the argv after `--`.
   * @param {string} nameOrId
   * @param {string[]} commandArgs
   * @param {object} [opts]
   * @param {string} [opts.cwd]
   * @param {number} [opts.timeoutMs]
   * @param {AbortSignal} [opts.signal]
   * @param {boolean} [opts.json]
   */
  async exec(nameOrId, commandArgs, opts = {}) {
    const args = ['exec', nameOrId]
    if (opts.cwd) args.push('--cwd', opts.cwd)
    if (opts.timeoutMs) args.push('--timeout', `${Math.max(1, Math.round(opts.timeoutMs / 1000))}s`)
    if (opts.json !== false) args.push('--json')
    args.push('--', ...commandArgs)
    if (opts.json === false) {
      return this.cli(args, { signal: opts.signal, timeoutMs: (opts.timeoutMs ?? 60000) + 10000 })
    }
    const result = await this.cli(args, { signal: opts.signal, timeoutMs: (opts.timeoutMs ?? 60000) + 10000 })
    const text = (result.stdout ?? '').trim()
    if (!text) return { exitCode: 0, stdout: '', stderr: '', raw: false }
    try {
      const parsed = JSON.parse(text)
      // `exec --json` returns { exitCode, stdout, stderr, ... } where stdout is
      // the command's own stdout. We unwrap it so callers get the command's
      // output directly, while preserving the exit code.
      if (parsed && typeof parsed === 'object' && 'stdout' in parsed) {
        return {
          exitCode: typeof parsed.exitCode === 'number' ? parsed.exitCode : result.exitCode,
          stdout: String(parsed.stdout ?? ''),
          stderr: String(parsed.stderr ?? ''),
          raw: false,
        }
      }
      return { exitCode: result.exitCode, stdout: text, stderr: result.stderr ?? '', raw: true }
    } catch {
      return { exitCode: result.exitCode, stdout: text, stderr: result.stderr ?? '', raw: true }
    }
  }

  /**
   * Push a local file or directory into the box.
   * @param {string} nameOrId
   * @param {string} localPath
   * @param {string} remotePath
   * @param {object} [opts]
   */
  async push(nameOrId, localPath, remotePath, opts = {}) {
    return this.cli(['push', nameOrId, localPath, remotePath], { signal: opts.signal, timeoutMs: opts.timeoutMs ?? 300000 })
  }

  /**
   * Pull a file or directory out of the box.
   * @param {string} nameOrId
   * @param {string} remotePath
   * @param {string} localPath
   * @param {object} [opts]
   */
  async pull(nameOrId, remotePath, localPath, opts = {}) {
    return this.cli(['pull', nameOrId, remotePath, localPath], { signal: opts.signal, timeoutMs: opts.timeoutMs ?? 300000 })
  }

  /**
   * List files in the box (`instabox files`).
   * @param {string} nameOrId
   * @param {string} remotePath
   * @param {object} [opts]
   */
  async files(nameOrId, remotePath, opts = {}) {
    return this.cli(['files', nameOrId, remotePath], { signal: opts.signal })
  }

  /** @param {string} nameOrId @param {object} [opts] */
  async logs(nameOrId, opts = {}) {
    return this.cliJson(['logs', nameOrId], opts)
  }

  /** @param {string} nameOrId @param {object} [opts] */
  async ps(nameOrId, opts = {}) {
    return this.cliJson(['ps', nameOrId], opts)
  }

  /** @param {string} nameOrId @param {object} [opts] */
  async history(nameOrId, opts = {}) {
    return this.cliJson(['history', nameOrId], opts)
  }

  // ---- `instabox agent` subcommands (documented autonomous-agent surface) ----

  /**
   * Start a turn in the box agent.
   * @param {string} nameOrId
   * @param {string} prompt
   * @param {object} [opts]
   * @param {boolean} [opts.newConversation]
   * @param {string} [opts.resumeConversationId]
   * @param {string} [opts.provider]
   * @param {string} [opts.model]
   * @param {string} [opts.cwd]
   * @param {AbortSignal} [opts.signal]
   */
  async agentPrompt(nameOrId, prompt, opts = {}) {
    const args = ['agent', 'prompt', nameOrId]
    if (opts.newConversation) args.push('--new')
    if (opts.resumeConversationId) args.push('--resume', opts.resumeConversationId)
    if (opts.provider) args.push('--provider', opts.provider)
    if (opts.model) args.push('--model', opts.model)
    if (opts.cwd) args.push('--cwd', opts.cwd)
    args.push(prompt)
    return this.cliJson(args, { signal: opts.signal })
  }

  /**
   * Read agent events. With `follow`, the caller consumes the stream itself;
   * this method collects until the process exits or `signal` aborts.
   * @param {string} nameOrId
   * @param {object} [opts]
   * @param {string} [opts.conversationId]
   * @param {boolean} [opts.follow]
   * @param {number} [opts.timeoutMs]
   * @param {AbortSignal} [opts.signal]
   * @returns {Promise<{ stdout: string, exitCode: number }>}
   */
  async agentEvents(nameOrId, opts = {}) {
    const args = ['agent', 'events', nameOrId, '--json']
    if (opts.conversationId) args.push('-c', opts.conversationId)
    if (opts.follow) args.push('-f')
    const result = await this.cli(args, {
      signal: opts.signal,
      timeoutMs: opts.timeoutMs ?? this.config.routing?.turnTimeoutMs ?? 600000,
    })
    return { stdout: result.stdout ?? '', exitCode: result.exitCode, stderr: result.stderr ?? '' }
  }

  /**
   * Stream agent events line-by-line as they arrive. Uses `-f` and parses
   * each complete JSONL line via `onLine`; resolves when the process exits.
   * Falls back to the file runner when piped stdio is unavailable (sandbox).
   * @param {string} nameOrId
   * @param {object} opts - { conversationId?, timeoutMs?, signal?, onLine? }
   * @returns {Promise<{ exitCode: number, stderr: string }>}
   */
  async agentEventsStream(nameOrId, opts = {}) {
    const { onLine, ...rest } = opts
    const cli = this.config.cli
    const args = ['agent', 'events', nameOrId, '--json']
    if (rest.conversationId) args.push('-c', rest.conversationId)
    args.push('-f')
    const fullArgs = [...cli.argsPrefix, ...args]
    const env = minimalEnv(process.env, cli.envPassthrough)
    if (process.env.FAKE_INSTABOX_STATE) env.FAKE_INSTABOX_STATE = process.env.FAKE_INSTABOX_STATE
    const timeoutMs = rest.timeoutMs ?? this.config.routing?.turnTimeoutMs ?? 600000

    // File runner: spawn with stdout/stderr to temp files, then read lines
    // incrementally. This works in sandboxes that block piped stdio.
    if (cli.runner === 'file') {
      return this._agentEventsStreamFile(nameOrId, fullArgs, env, cli, timeoutMs, rest.signal, onLine)
    }

    return new Promise((resolve, reject) => {
      let child
      try {
        child = spawn(cli.program, fullArgs, {
          cwd: cli.cwd,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        })
      } catch (error) {
        reject(new InstaBoxError('CLI_SPAWN_FAILED', `instabox agent events: ${error?.message ?? error}`))
        return
      }
      let buf = ''
      let stderr = ''
      const timer = setTimeout(() => {
        if (child && !child.killed) child.kill('SIGTERM')
      }, timeoutMs)
      child.stdout.on('data', (chunk) => {
        buf += chunk.toString('utf8')
        let idx
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx)
          buf = buf.slice(idx + 1)
          if (line.trim() && onLine) {
            try { onLine(line) } catch {}
          }
        }
      })
      child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
      child.on('error', (err) => {
        clearTimeout(timer)
        reject(new InstaBoxError('CLI_SPAWN_FAILED', `instabox agent events: ${err?.message ?? err}`))
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (buf.trim() && onLine) {
          try { onLine(buf) } catch {}
        }
        resolve({ exitCode: code ?? -1, stderr })
      })
      if (rest.signal) {
        if (rest.signal.aborted) child.kill('SIGTERM')
        else rest.signal.addEventListener('abort', () => child.kill('SIGTERM'), { once: true })
      }
    })
  }

  /** @private */
  async _agentEventsStreamFile(nameOrId, fullArgs, env, cli, timeoutMs, signal, onLine) {
    const { mkdtemp, readFile, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { openSync, closeSync, existsSync } = await import('node:fs')
    const workDir = await mkdtemp(join(tmpdir(), 'instabox-bridge-events-'))
    const outFile = join(workDir, 'stdout')
    const errFile = join(workDir, 'stderr')
    let child
    try {
      const outFd = openSync(outFile, 'w')
      const errFd = openSync(errFile, 'w')
      child = spawn(cli.program, fullArgs, {
        cwd: cli.cwd,
        env,
        stdio: ['ignore', outFd, errFd],
        windowsHide: true,
      })
      closeSync(outFd)
      closeSync(errFd)
    } catch (error) {
      await rm(workDir, { recursive: true, force: true }).catch(() => {})
      throw new InstaBoxError('CLI_SPAWN_FAILED', `instabox agent events: ${error?.message ?? error}`)
    }

    return new Promise((resolve, reject) => {
      let stderr = ''
      let lastSize = 0
      let buf = ''
      const timer = setTimeout(() => {
        if (child && !child.killed) child.kill('SIGTERM')
      }, timeoutMs)
      const poll = setInterval(async () => {
        try {
          if (!existsSync(outFile)) return
          const { statSync } = await import('node:fs')
          const size = statSync(outFile).size
          if (size <= lastSize) return
          const text = await readFile(outFile, 'utf8')
          const newText = text.slice(lastSize)
          lastSize = size
          buf += newText
          let idx
          while ((idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx)
            buf = buf.slice(idx + 1)
            if (line.trim() && onLine) {
              try { onLine(line) } catch {}
            }
          }
        } catch {}
      }, 50)
      child.on('error', (err) => {
        clearTimeout(timer)
        clearInterval(poll)
        rm(workDir, { recursive: true, force: true }).catch(() => {})
        reject(new InstaBoxError('CLI_SPAWN_FAILED', `instabox agent events: ${err?.message ?? err}`))
      })
      child.on('close', async (code) => {
        clearTimeout(timer)
        clearInterval(poll)
        try {
          const text = await readFile(outFile, 'utf8')
          buf += text.slice(lastSize)
          if (buf.trim() && onLine) {
            for (const line of buf.split('\n')) {
              if (line.trim()) { try { onLine(line) } catch {} }
            }
          }
          stderr = await readFile(errFile, 'utf8').catch(() => '')
        } catch {}
        await rm(workDir, { recursive: true, force: true }).catch(() => {})
        resolve({ exitCode: code ?? -1, stderr })
      })
      if (signal) {
        if (signal.aborted) child.kill('SIGTERM')
        else signal.addEventListener('abort', () => child.kill('SIGTERM'), { once: true })
      }
    })
  }

  /**
   * Steer a running turn.
   * @param {string} nameOrId
   * @param {string} text
   * @param {object} [opts]
   */
  async agentSteer(nameOrId, text, opts = {}) {
    const args = ['agent', 'steer', nameOrId]
    if (opts.conversationId) args.push('-c', opts.conversationId)
    args.push(text)
    return this.cliJson(args, { signal: opts.signal })
  }

  /**
   * Interrupt the running turn.
   * @param {string} nameOrId
   * @param {object} [opts]
   */
  async agentInterrupt(nameOrId, opts = {}) {
    const args = ['agent', 'interrupt', nameOrId]
    if (opts.conversationId) args.push('-c', opts.conversationId)
    return this.cliJson(args, { signal: opts.signal })
  }

  /**
   * List agent conversations in the box.
   * @param {string} nameOrId
   * @param {object} [opts]
   */
  async agentList(nameOrId, opts = {}) {
    return this.cliJson(['agent', 'ls', nameOrId], opts)
  }

  /** @param {object} [opts] */
  async version(opts = {}) {
    return this.cliJson(['version'], opts)
  }
}

/**
 * Create a client from normalized config.
 * @param {object} config
 * @param {object} [logger]
 * @param {(command: string[], opts?: object) => Promise<any>} [exec]
 * @returns {InstaBoxClient}
 */
export function createClient(config, logger, exec) {
  return new InstaBoxClient({ config, logger, exec })
}

/**
 * Capture the harness's chat memory for a handoff.
 *
 * "Chat memory" is two things:
 *  - the conversation transcript, which `serialize.js` already projects from the
 *    session event log, and
 *  - the durable memory tracks the harness keeps outside the session:
 *      * `<memories>/projects/<key>/MEMORY.md` — the project log for the cwd,
 *      * `<memories>/daily/<YYYY-MM-DD>.md` — the daily journal.
 *
 * The project directory name is the first 12 hex characters of the SHA-1 of the
 * absolute project path. This is the naming scheme the harness itself uses, so
 * the same key is reproduced here rather than reversed from a directory listing.
 *
 * Everything is read-only, size-capped, and safe to run when no memory exists:
 * a missing root or missing file yields an empty capture, never a rejection.
 *
 * @module instabox-bridge/core/memory
 */
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** Hard ceiling for the whole capture, regardless of config. */
export const DEFAULT_MAX_MEMORY_BYTES = 2 * 1024 * 1024
/** How many daily journals to include by default. */
export const DEFAULT_DAILY_DAYS = 7

const DAILY_FILE = /^\d{4}-\d{2}-\d{2}\.md$/

/**
 * The harness's project-memory directory key for an absolute path.
 * @param {string} projectPath
 * @returns {string} 12 lowercase hex characters
 */
export function projectMemoryKey(projectPath) {
  return createHash('sha1').update(resolve(projectPath)).digest('hex').slice(0, 12)
}

/**
 * Resolve the memory root the harness writes to.
 * @param {object} [options]
 * @param {string} [options.dshHome] explicit DSH home
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {string} [options.home]
 * @returns {string}
 */
export function resolveMemoryRoot({ dshHome, env = process.env, home = homedir() } = {}) {
  const base = dshHome || env.DSH_HOME || join(home, '.dsh')
  return join(base, 'memories')
}

/**
 * @typedef {{ path: string, text: string, truncated: boolean, bytes: number }} MemoryFile
 * @typedef {{
 *   capturedAt: number,
 *   root: string,
 *   projectPath: string,
 *   projectKey: string,
 *   project: MemoryFile | null,
 *   daily: Array<MemoryFile & { date: string }>,
 *   fileCount: number,
 *   bytes: number,
 *   truncated: boolean,
 * }} ChatMemory
 */

/**
 * Read the durable memory tracks for a working directory.
 * @param {object} [options]
 * @param {string} [options.dshHome]
 * @param {string} [options.cwd]
 * @param {number} [options.dailyDays]
 * @param {number} [options.maxBytes]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {string} [options.home]
 * @returns {Promise<ChatMemory>}
 */
export async function readChatMemory(options = {}) {
  const {
    dshHome,
    cwd = process.cwd(),
    dailyDays = DEFAULT_DAILY_DAYS,
    maxBytes = DEFAULT_MAX_MEMORY_BYTES,
    env = process.env,
    home = homedir(),
  } = options

  const root = resolveMemoryRoot({ dshHome, env, home })
  const projectPath = resolve(cwd)
  const projectKey = projectMemoryKey(projectPath)
  const budget = Math.max(0, Math.trunc(Number(maxBytes) || DEFAULT_MAX_MEMORY_BYTES))

  /** @type {ChatMemory} */
  const memory = {
    capturedAt: Date.now(),
    root,
    projectPath,
    projectKey,
    project: null,
    daily: [],
    fileCount: 0,
    bytes: 0,
    truncated: false,
  }
  /** @type {string[]} */
   const skipped = []

  // Newest first so a tight budget keeps the most recent journal entries.
  const dailyFiles = await listDailyFiles(join(root, 'daily')).catch(() => [])

  /** @type {Array<{ kind: 'project' | 'daily', date?: string, relPath: string, filesystemPath: string }>} */
  const candidates = []
  const projectFile = join('projects', projectKey, 'MEMORY.md')
  candidates.push({
    kind: 'project',
    relPath: projectFile.split('\\').join('/'),
    filesystemPath: join(root, projectFile),
  })
  for (const file of dailyFiles.slice(0, Math.max(0, Math.trunc(Number(dailyDays) || DEFAULT_DAILY_DAYS)))) {
    candidates.push({
      kind: 'daily',
      date: file.slice(0, 10),
      relPath: `daily/${file}`,
      filesystemPath: join(root, 'daily', file),
    })
  }

  for (const candidate of candidates) {
    if (memory.bytes >= budget) {
      memory.truncated = true
      skipped.push(candidate.relPath)
      continue
    }
    let text
    try {
      text = await readFile(candidate.filesystemPath, 'utf8')
    } catch {
      continue // absent memory track is normal, not an error
    }
    const remaining = budget - memory.bytes
    let truncated = false
    if (text.length > remaining) {
      text = text.slice(0, Math.max(0, remaining))
      truncated = true
      memory.truncated = true
    }
    // Keep the payload free of NUL bytes, which some JSON readers reject.
    text = text.replace(/\u0000/g, '')
    const bytes = Buffer.byteLength(text, 'utf8')
    memory.bytes += bytes
    memory.fileCount += 1

    /** @type {MemoryFile} */
    const entry = { path: candidate.relPath, text, truncated, bytes }
    if (candidate.kind === 'project') {
      memory.project = entry
    } else {
      memory.daily.push({ ...entry, date: candidate.date })
    }
  }

  return memory
}

/**
 * Compact summary of a capture, safe to store in session state and log.
 * @param {ChatMemory} memory
 * @returns {{ projectKey: string, dailyCount: number, fileCount: number, bytes: number, truncated: boolean }}
 */
export function summarizeMemory(memory) {
  return {
    projectKey: memory.projectKey,
    dailyCount: memory.daily.length,
    fileCount: memory.fileCount,
    bytes: memory.bytes,
    truncated: memory.truncated,
  }
}

/**
 * @param {string} dailyDir
 * @returns {Promise<string[]>} file names newest-first
 */
async function listDailyFiles(dailyDir) {
  const entries = await readdir(dailyDir)
  return entries
    .filter((name) => DAILY_FILE.test(name))
    .sort()
    .reverse()
}

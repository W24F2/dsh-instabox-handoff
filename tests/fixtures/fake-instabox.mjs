/**
 * Stateful fake `instabox` CLI for hermetic integration tests.
 * Implements only the documented commands the bridge uses, with injectable
 * failure modes. State lives in a JSON file so multiple invocations see the
 * same boxes/conversations.
 *
 * @module tests/fixtures/fake-instabox
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

const STATE_VERSION = 1

function loadState(file) {
  if (!existsSync(file)) return { version: STATE_VERSION, boxes: {}, conversations: {}, files: {} }
  return JSON.parse(readFileSync(file, 'utf8'))
}
function saveState(file, state) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(state, null, 2), 'utf8')
}

function json(out, obj, code = 0) {
  process.stdout.write(JSON.stringify(obj) + '\n')
  process.exit(code)
}
function err(msg, code = 1) {
  process.stderr.write(msg + '\n')
  process.exit(code)
}

const stateFile = process.env.FAKE_INSTABOX_STATE
if (!stateFile) err('FAKE_INSTABOX_STATE not set', 2)
const state = loadState(stateFile)
const args = process.argv.slice(2)

// Failure injection via env vars.
const failNext = process.env.FAKE_INSTABOX_FAIL
if (failNext) {
  const [cmd, code] = failNext.split(':')
  if (args[0] === cmd || args.join(' ').startsWith(cmd)) {
    delete process.env.FAKE_INSTABOX_FAIL
    err(`injected failure for ${cmd}`, parseInt(code ?? '1', 10))
  }
}

const cmd = args[0]
const sub = args[1]
// Box name is args[1] for all commands (the subcommand position).
// For `exec`, it's between `exec` and `--`.
const execSep = cmd === 'exec' ? args.indexOf('--') : -1
const execArgs = cmd === 'exec' ? args.slice(1, execSep >= 0 ? execSep : undefined) : []
const target = cmd === 'exec'
  ? execArgs.find((a) => !a.startsWith('-') && !/^\d+s$/.test(a))
  : cmd === 'agent'
    ? args[2] // agent <sub> <box> ...
    : args[1]

function getBox(nameOrId) {
  return state.boxes[nameOrId] ?? state.boxes[Object.keys(state.boxes).find((k) => state.boxes[k].id === nameOrId)]
}
function boxJson(box) {
  return {
    id: box.id,
    name: box.name,
    state: box.state,
    metadata: box.metadata ?? {},
    template: box.template ?? 'agent-browser',
    createdAt: box.createdAt,
  }
}

switch (cmd) {
  case 'whoami':
    json(process.stdout, { user: 'test', org: 'test-org' })
    break

  case 'version':
    json(process.stdout, { version: '0.0.0-fake', cli: 'instabox' })
    break

  case 'get': {
    const box = getBox(target)
    if (!box) err(`box not found: ${target}`, 4)
    json(process.stdout, boxJson(box))
    break
  }

  case 'ls': {
    const machines = Object.values(state.boxes).map(boxJson)
    if (args.includes('--json')) json(process.stdout, machines)
    else {
      process.stdout.write(machines.map((b) => `${b.name}\t${b.state}`).join('\n') + '\n')
      process.exit(0)
    }
    break
  }

  case 'create': {
    const nameIdx = args.indexOf('--name')
    const name = nameIdx >= 0 ? args[nameIdx + 1] : `box-${randomUUID().slice(0, 8)}`
    const meta = {}
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] === '--meta' && args[i + 1]) {
        const [k, v] = args[i + 1].split('=')
        meta[k] = v
      }
    }
    const box = {
      id: `m_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      name,
      state: 'running',
      metadata: meta,
      template: 'agent-browser',
      createdAt: new Date().toISOString(),
    }
    state.boxes[name] = box
    state.boxes[box.id] = box
    saveState(stateFile, state)
    json(process.stdout, boxJson(box))
    break
  }

  case 'start': case 'resume': case 'wake': {
    const box = getBox(target)
    if (!box) err(`box not found: ${target}`, 4)
    box.state = 'running'
    saveState(stateFile, state)
    json(process.stdout, boxJson(box))
    break
  }

  case 'stop': {
    const box = getBox(target)
    if (!box) err(`box not found: ${target}`, 4)
    box.state = 'stopped'
    saveState(stateFile, state)
    json(process.stdout, boxJson(box))
    break
  }

  case 'restart': {
    const box = getBox(target)
    if (!box) err(`box not found: ${target}`, 4)
    box.state = 'running'
    saveState(stateFile, state)
    json(process.stdout, boxJson(box))
    break
  }

  case 'exec': {
    const box = getBox(target)
    if (!box) err(`box not found: ${target}`, 4)
    if (box.state !== 'running') err(`box ${target} is ${box.state}`, 75)
    const sep = args.indexOf('--')
    const cmdArgs = sep >= 0 ? args.slice(sep + 1) : []
    // Simulate common commands.
    if (cmdArgs[0] === 'true') {
      json(process.stdout, { exitCode: 0, stdout: '', stderr: '' })
    } else if (cmdArgs[0] === 'node' && cmdArgs[1] === '-e') {
      // Probe or inline script; emulate success.
      json(process.stdout, { exitCode: 0, stdout: '', stderr: '' })
    } else if (cmdArgs[0] === 'cat') {
      const path = cmdArgs[1]
      const content = state.files[path]
      if (content === undefined) err(`no such file: ${path}`, 1)
      json(process.stdout, { exitCode: 0, stdout: Buffer.from(content, 'base64').toString('utf8'), stderr: '' })
    } else if (cmdArgs[0] === 'mkdir') {
      json(process.stdout, { exitCode: 0, stdout: '', stderr: '' })
    } else if (cmdArgs[0] === 'rm') {
      json(process.stdout, { exitCode: 0, stdout: '', stderr: '' })
    } else if (cmdArgs[0] === 'nonexistent-node-binary' || cmdArgs[0]?.includes('nonexistent')) {
      err(`spawn ${cmdArgs[0]}: ENOENT`, 1)
    } else if (cmdArgs[0]?.includes('node') || cmdArgs[1]?.endsWith('verify.mjs')) {
      // Run the verifier logic inline (simplified: read payload, write ack).
      const verifyIdx = cmdArgs.findIndex((a) => a.endsWith('verify.mjs'))
      if (verifyIdx < 0) {
        json(process.stdout, { exitCode: 0, stdout: '', stderr: '' })
      }
      // If the node binary itself is bogus, fail like a real spawn would.
      const nodeBin = cmdArgs[0]
      if (nodeBin && !nodeBin.includes('node') && !nodeBin.endsWith('node.exe') && nodeBin !== 'node') {
        err(`spawn ${nodeBin}: ENOENT`, 1)
      }
      // The verifier needs the payload file to exist.
      const payloadPath = cmdArgs[verifyIdx + 1]
      const ackPath = cmdArgs[verifyIdx + 2]
      const payloadRaw = state.files[payloadPath]
      if (payloadRaw === undefined) err(`no such file: ${payloadPath}`, 1)
      const payload = JSON.parse(Buffer.from(payloadRaw, 'base64').toString('utf8'))
      const { createHash } = await import('node:crypto')
      const canon = (v) => v === null || typeof v !== 'object' ? v : Array.isArray(v) ? v.map(canon) : Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k])]).filter(([,x]) => x !== undefined))
      const digest = createHash('sha256').update(JSON.stringify(canon({ ...payload, digest: undefined }))).digest('hex')
      const ack = {
        protocol: 'instabox-handoff-ack/v1',
        handoffId: payload.handoffId,
        digest: payload.digest,
        digestMatch: payload.digest === digest || payload.digest === createHash('sha256').update(JSON.stringify(canon(payload))).digest('hex'),
        schemaValid: true,
        messageCount: payload.conversation?.messages?.length ?? 0,
        attachmentCount: payload.attachments?.length ?? 0,
        memoryFileCount: payload.memory?.fileCount ?? 0,
        receivedAt: Date.now(),
      }
      state.files[ackPath] = Buffer.from(JSON.stringify(ack, null, 2), 'utf8').toString('base64')
      saveState(stateFile, state)
      json(process.stdout, { exitCode: 0, stdout: JSON.stringify({ ok: true }), stderr: '' })
    } else {
      json(process.stdout, { exitCode: 0, stdout: '', stderr: '' })
    }
    break
  }

  case 'push': {
    const box = getBox(target)
    if (!box) err(`box not found: ${target}`, 4)
    // args: push <box> <local> <remote>
    const local = args[args.indexOf(target) + 1]
    const remote = args[args.indexOf(target) + 2]
    if (!local || !remote) err('push requires local and remote paths', 2)
    const content = readFileSync(local)
    state.files[remote] = content.toString('base64')
    state.files[remote + '.b64'] = true
    saveState(stateFile, state)
    process.stdout.write('')
    process.exit(0)
  }

  case 'pull': {
    const box = getBox(target)
    if (!box) err(`box not found: ${target}`, 4)
    const remote = args[args.indexOf(target) + 1]
    const local = args[args.indexOf(target) + 2]
    const content = state.files[remote]
    if (content === undefined) err(`no such file: ${remote}`, 4)
    writeFileSync(local, Buffer.from(content, 'base64'))
    process.exit(0)
  }

  case 'files': {
    const box = getBox(target)
    if (!box) err(`box not found: ${target}`, 4)
    const remote = args[args.indexOf(target) + 1]
    const prefix = remote.endsWith('/') ? remote : remote + '/'
    const entries = Object.keys(state.files).filter((k) => k.startsWith(prefix) && !k.endsWith('.b64'))
    process.stdout.write(entries.map((e) => e.slice(prefix.length)).join('\n') + '\n')
    process.exit(0)
  }

  case 'logs': {
    const box = getBox(target)
    if (!box) err(`box not found: ${target}`, 4)
    json(process.stdout, { logs: 'fake logs' })
    break
  }

  case 'agent': {
    const sub2 = args[1]
    const box = getBox(target)
    if (!box) err(`box not found: ${target}`, 4)
    if (box.state !== 'running') err(`box ${target} is ${box.state}`, 75)

    if (sub2 === 'prompt') {
      // args: agent prompt <box> [flags] <prompt...>
      const boxIdx = args.indexOf('prompt') + 1
      const promptArgs = args.slice(boxIdx + 1)
      // Remove flags and their values; the last remaining arg is the prompt.
      const flagSet = new Set(['--new', '--provider', '--model', '--cwd', '--resume', '--attach', '-f', '--json'])
      const positional = []
      for (let i = 0; i < promptArgs.length; i += 1) {
        const a = promptArgs[i]
        if (flagSet.has(a)) {
          if (['--provider', '--model', '--cwd', '--resume', '--attach'].includes(a)) i += 1
          continue
        }
        if (a.startsWith('-')) continue
        positional.push(a)
      }
      const prompt = positional.join(' ')
      const newConv = args.includes('--new')
      const resumeIdx = args.indexOf('--resume')
      const resumeId = resumeIdx >= 0 ? args[resumeIdx + 1] : null
      const convId = newConv || !resumeId ? `conv_${randomUUID().slice(0, 8)}` : resumeId
      if (!state.conversations[convId]) {
        state.conversations[convId] = { id: convId, box: box.name, messages: [], status: 'idle' }
      }
      const conv = state.conversations[convId]
      conv.messages.push({ role: 'user', text: prompt, at: Date.now() })
      conv.status = 'running'
      // Simulate an immediate assistant reply for tests.
      // If the prompt contains an ACK marker instruction, echo the marker.
      const ackMatch = /\[instabox-handoff:ack ([A-Za-z0-9_-]+) ([0-9a-f]+)\]/.exec(prompt)
      let reply
      if (ackMatch) {
        reply = `[instabox-handoff:ack ${ackMatch[1]} ${ackMatch[2]}]\nContext ingested; ready for the next message.`
      } else if (prompt.includes('--- NEW USER MESSAGE ---')) {
        // Extract the user text after the marker.
        const idx = prompt.indexOf('--- NEW USER MESSAGE ---')
        const userText = prompt.slice(idx + '--- NEW USER MESSAGE ---'.length).trim()
        reply = `InstaBox agent received: ${userText.slice(0, 80)}`
      } else {
        reply = `InstaBox agent received: ${prompt.slice(0, 80)}`
      }
      conv.messages.push({ role: 'assistant', text: reply, at: Date.now() })
      conv.status = 'idle'
      state.agentTurns = state.agentTurns ?? {}
      state.agentTurns[`${box.name}:${convId}`] = { reply, prompt, at: Date.now() }
      saveState(stateFile, state)
      json(process.stdout, { conversationId: convId, turn: conv.messages.length, jobId: `job_${randomUUID().slice(0, 8)}`, pid: 1234 })
    }

    if (sub2 === 'events') {
      const convIdx = args.indexOf('-c')
      const convId = convIdx >= 0 ? args[convIdx + 1] : null
      const follow = args.includes('-f')
      // Emit stored events for the conversation.
      // For --json, only emit events from the CURRENT turn (messages added since last prompt).
      // Find the last user message to determine turn boundaries.
      const conv = convId ? state.conversations[convId] : Object.values(state.conversations)[0]
      const events = []
      if (conv) {
        const messages = conv.messages
        // Find the index of the last user message (which marks turn boundaries).
        let lastUserIdx = -1
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role === 'user') { lastUserIdx = i; break }
        }
        // Emit only events from messages added AFTER the last user message.
        // For a freshly created conversation (no prior messages), emit all.
        const startIdx = lastUserIdx >= 0 ? lastUserIdx : 0
        for (let i = startIdx; i < messages.length; i++) {
          const msg = messages[i]
          events.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: msg.text }] } }))
        }
        events.push(JSON.stringify({ type: 'instabox.turn_end', data: { exitCode: 0 } }))
      }
      process.stdout.write(events.join('\n') + '\n')
      process.exit(0)
    }

    if (sub2 === 'ls') {
      const convs = Object.values(state.conversations).filter((c) => c.box === box.name)
      json(process.stdout, convs.map((c) => ({ id: c.id, status: c.status, messages: c.messages.length })))
    }

    if (sub2 === 'steer') {
      json(process.stdout, { ok: true })
    }
    if (sub2 === 'interrupt') {
      json(process.stdout, { ok: true })
    }
    break
  }

  default:
    err(`unknown command: ${cmd}`, 2)
}

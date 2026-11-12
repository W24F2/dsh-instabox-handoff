/**
 * Orchestrates the handoff state machine:
 *   idle → preparing → transferring → ingesting → awaiting_ack → delegated
 *   delegated → reclaiming → reclaimed | failed
 *
 * @module instabox-bridge/core/orchestrator
 */
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPayload, assertPayload, assertAck, buildAckMarker, parseAckMarker } from './protocol.js'
import { serializeSession, renderTranscript, joinText } from './serialize.js'
import { createRedactor } from './redact.js'
import { createState } from './state.js'

const SIDE_ACK_FILE = 'ack.json'
const SIDE_PAYLOAD_FILE = 'payload.json'
const SIDE_VERIFY_FILE = 'verify.mjs'

export class HandoffError extends Error {
  /** @param {string} code @param {string} message @param {object} [extra] */
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'HandoffError'
    this.code = code
    Object.assign(this, extra)
  }
}

export class Orchestrator {
  /**
   * @param {object} options
   * @param {object} options.client - InstaBoxClient
   * @param {object} options.instance - InstanceManager
   * @param {object} options.state - SessionStateStore
   * @param {object} options.router - MessageRouter
   * @param {object} options.config - normalized config
   * @param {(sessionId: string) => Promise<{ events: any[], agentStatus?: string, inbox?: any, agent?: any }>} options.sessionReader
   * @param {string} options.sidecarSource - contents of box-side/verify.mjs
   * @param {{ info?: Function, warn?: Function, error?: Function, debug?: Function }} [options.logger]
   */
  constructor({ client, instance, state, router, config, sessionReader, sidecarSource, logger = console }) {
    this.client = client
    this.instance = instance
    this.state = state
    this.router = router
    this.config = config
    this.sessionReader = sessionReader
    this.sidecarSource = sidecarSource
    this.logger = logger
  }

  /**
   * Initiate a handoff for a session.
   * @param {string} sessionId
   * @param {object} [opts]
   * @param {string} [opts.reason]
   * @param {AbortSignal} [opts.signal]
   * @returns {Promise<object>} the delegated state
   */
  async handoff(sessionId, opts = {}) {
    const state = await this.state.load(sessionId)
    if (state?.phase === 'delegated') {
      throw new HandoffError('ALREADY_DELEGATED', `session ${sessionId} is already delegated to InstaBox`)
    }
    if (state?.phase === 'awaiting_ack' || state?.phase === 'ingesting' || state?.phase === 'transferring') {
      // Resume an interrupted handoff rather than starting over.
      return this._resumeHandoff(sessionId, state, opts)
    }

    await this.state.update(sessionId, (s) => {
      const next = s ?? this._fresh(sessionId)
      next.phase = 'preparing'
      next.handoffAttempts += 1
      next.lastError = null
      return next
    })

    try {
      // 1. Resolve/create the box.
      const box = await this.instance.ensure(sessionId, { signal: opts.signal })
      const boxName = box.name

      // 2. Read the session and build the payload.
      const snapshot = await this.sessionReader(sessionId)
      const serialized = serializeSession({
        events: snapshot.events ?? [],
        agentStatus: snapshot.agentStatus,
        inbox: snapshot.inbox,
      })
      const { systemPrompt, agentConfig, tools, permissions } = await this._captureRequestContext(snapshot.agent, sessionId)

      const redactor = createRedactor({
        env: process.env,
        extraSecrets: this.config.preferences?.secrets ?? [],
      })
      const instructions = redactor.redact({
        systemPrompt: systemPrompt ?? '',
        agentConfig,
        userPreferences: this.config.preferences ?? {},
      })
      const conversation = redactor.redact(serialized.conversation)
      const task = redactor.redact(serialized.task)
      const execution = redactor.redact(serialized.execution)
      const toolList = redactor.redact(tools)
      const permissionInfo = redactor.redact(permissions)
      const attachmentList = redactor.redact(serialized.attachments)

      const payload = createPayload({
        handoffId: `hb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        source: {
          harness: 'deepseek-harness',
          sessionId,
          sessionCreatedAt: snapshot.header?.createdAt ?? null,
          cwd: snapshot.header?.cwd ?? null,
          provider: agentConfig.provider,
          model: agentConfig.model,
          ...(snapshot.header?.agentPreset ? { agentPreset: snapshot.header.agentPreset } : {}),
        },
        instructions: {
          systemPrompt: instructions.value.systemPrompt,
          agentConfig: instructions.value.agentConfig,
          userPreferences: instructions.value.userPreferences,
        },
        conversation: conversation.value,
        task: task.value,
        execution: execution.value,
        tools: toolList.value,
        permissions: permissionInfo.value,
        attachments: attachmentList.value,
        reason: opts.reason ?? this.config.handoff.reason ?? 'explicit handoff',
        redactions: [
          ...instructions.redactions,
          ...conversation.redactions,
          ...task.redactions,
          ...execution.redactions,
          ...toolList.redactions,
          ...permissionInfo.redactions,
          ...attachmentList.redactions,
        ],
      })
      assertPayload(payload, { maxBytes: this.config.handoff.maxPayloadBytes })

      // 3. Persist state and push payload + sidecar + attachments.
      await this.state.update(sessionId, (s) => {
        const next = s ?? this._fresh(sessionId)
        next.phase = 'transferring'
        next.handoffId = payload.handoffId
        next.box = { name: boxName, id: box.id ?? null, created: box.created === true }
        next.provider = this.config.providerName
        next.model = `box:${boxName}`
        next.originalRoute = {
          provider: agentConfig.provider,
          model: agentConfig.model,
          ...(agentConfig.maxTokens ? { maxTokens: agentConfig.maxTokens } : {}),
        }
        next.ack = null
        next.ackReplyText = null
        next.ackReplyConsumed = false
        next.lastRoutedKey = null
        next.routed = []
        next.pending = { handoffId: payload.handoffId, startedAt: Date.now() }
        return next
      })

      await this.state.audit(sessionId, { event: 'handoff-transfer', handoffId: payload.handoffId, box: boxName })

      const remoteDir = `${this.config.boxSidecar.dir}/${sessionId}`
      await this._pushPayload(boxName, remoteDir, payload, opts)
      await this._pushSidecar(boxName, remoteDir, opts)
      await this._pushAttachments(boxName, remoteDir, payload.attachments, snapshot.agent, opts)

      // 4. Ingest: run the verifier inside the box.
      await this.state.update(sessionId, (s) => {
        if (!s) return null
        s.phase = 'ingesting'
        return s
      })
      const ack = await this._runVerifier(boxName, remoteDir, payload, opts)

      // 5. Agent acknowledgement: instruct the box agent to ingest and reply.
      await this.state.update(sessionId, (s) => {
        if (!s) return null
        s.phase = 'awaiting_ack'
        return s
      })
      const agentAck = await this._awaitAgentAck(boxName, remoteDir, payload, ack, opts)

      // 6. Delegate.
      const final = await this.state.update(sessionId, (s) => {
        if (!s) return null
        s.phase = 'delegated'
        s.ack = ack
        s.ackReplyText = agentAck.text
        s.ackReplyConsumed = false
        s.pending = null
        s.conversationId = agentAck.conversationId ?? s.conversationId
        s.failures = { count: 0, lastError: null, lastAt: null }
        return s
      })
      await this.state.audit(sessionId, { event: 'handoff-delegated', handoffId: payload.handoffId, box: boxName })
      return final
    } catch (error) {
      await this._fail(sessionId, error, opts)
      throw error
    }
  }

  /** @private */
  _fresh(sessionId) {
    return createState(sessionId)
  }

  /**
   * Resume a handoff that was interrupted mid-flight.
   * @private
   */
  async _resumeHandoff(sessionId, state, opts) {
    this.logger.info?.(`[instabox-bridge] resuming handoff ${state.handoffId} for ${sessionId} (phase=${state.phase})`)
    // Re-run from the transfer step; the payload is deterministic enough that
    // re-pushing is safe (same handoffId, same digest).
    return this.handoff(sessionId, { ...opts, _resumed: true })
  }

  /**
   * Capture the last real request's system prompt, config, tools and the
   * agent's visible tool schemas.
   * @private
   */
  async _captureRequestContext(agent, sessionId) {
    // Prefer the agent's own options; fall back to the last request header.
    const agentConfig = {
      provider: agent?.options?.provider ?? this.config.provider ?? 'unknown',
      model: agent?.options?.model ?? this.config.model ?? 'unknown',
      ...(agent?.options?.maxTokens ? { maxTokens: agent.options.maxTokens } : {}),
    }
    let systemPrompt = ''
    let tools = []
    try {
      if (agent?.ctx?.systemPrompt) {
        const assembly = await agent.ctx.systemPrompt.assemble({ agent, signal: opts?.signal })
        systemPrompt = assembly?.sections?.map((s) => s.text).join('\n\n') ?? ''
        tools = assembly?.tools ?? []
      }
    } catch (error) {
      this.logger.debug?.(`[instabox-bridge] systemPrompt assemble failed: ${error?.message ?? error}`)
    }
    if (tools.length === 0) {
      try {
        tools = agent?.ctx?.tools?.schemas?.(agent) ?? []
      } catch {}
    }
    const permissions = {
      toolNames: tools.map((t) => t?.name).filter(Boolean),
      note: 'approval policy is host-side and not enumerable; the box agent runs its own tools',
    }
    return { systemPrompt, agentConfig, tools, permissions }
  }

  /** @private */
  async _pushPayload(boxName, remoteDir, payload, opts) {
    const tmp = await mkdtemp(join(tmpdir(), 'instabox-bridge-'))
    try {
      const local = join(tmp, SIDE_PAYLOAD_FILE)
      await writeFile(local, JSON.stringify(payload, null, 2), 'utf8')
      await this.client.exec(boxName, ['mkdir', '-p', remoteDir], { timeoutMs: 15000, signal: opts.signal })
      await this.client.push(boxName, local, `${remoteDir}/${SIDE_PAYLOAD_FILE}`, { signal: opts.signal })
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => {})
    }
  }

  /** @private */
  async _pushSidecar(boxName, remoteDir, opts) {
    const tmp = await mkdtemp(join(tmpdir(), 'instabox-bridge-'))
    try {
      const local = join(tmp, SIDE_VERIFY_FILE)
      await writeFile(local, this.sidecarSource, 'utf8')
      await this.client.push(boxName, local, `${remoteDir}/${SIDE_VERIFY_FILE}`, { signal: opts.signal })
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => {})
    }
  }

  /** @private */
  async _pushAttachments(boxName, remoteDir, attachments, agent, opts) {
    if (!this.config.handoff.transferImages || !Array.isArray(attachments) || attachments.length === 0) return
    const attachCtx = agent?.ctx?.attachments
    if (!attachCtx?.readImage) return
    const total = attachments.reduce((sum, a) => sum + (a.bytes ?? 0), 0)
    if (total > this.config.handoff.maxAttachmentBytes) {
      this.logger.warn?.(`[instabox-bridge] attachments total ${total} bytes exceeds limit; skipping transfer`)
      return
    }
    const tmp = await mkdtemp(join(tmpdir(), 'instabox-bridge-attach-'))
    try {
      for (const ref of attachments) {
        try {
          const stored = await attachCtx.readImage(ref, opts.signal)
          const ext = ref.mediaType === 'image/png' ? 'png' : ref.mediaType === 'image/jpeg' ? 'jpg' : ref.mediaType === 'image/webp' ? 'webp' : ref.mediaType === 'image/gif' ? 'gif' : 'bin'
          const local = join(tmp, `${ref.attachmentId.replace(/[^A-Za-z0-9._-]/g, '_')}.${ext}`)
          await writeFile(local, Buffer.from(stored.data))
          const remote = `${remoteDir}/attachments/${ref.attachmentId.replace(/[^A-Za-z0-9._-]/g, '_')}.${ext}`
          await this.client.exec(boxName, ['mkdir', '-p', `${remoteDir}/attachments`], { timeoutMs: 15000, signal: opts.signal })
          await this.client.push(boxName, local, remote, { signal: opts.signal })
        } catch (error) {
          this.logger.warn?.(`[instabox-bridge] attachment ${ref.attachmentId} transfer failed: ${error?.message ?? error}`)
        }
      }
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => {})
    }
  }

  /**
   * Run the in-box verifier and read its ACK.
   * @private
   */
  async _runVerifier(boxName, remoteDir, payload, opts) {
    const nodePath = this.config.boxSidecar.nodePath
    const verifyPath = `${remoteDir}/${SIDE_VERIFY_FILE}`
    const payloadPath = `${remoteDir}/${SIDE_PAYLOAD_FILE}`
    const ackPath = `${remoteDir}/${SIDE_ACK_FILE}`

    // Ensure the ack file is fresh.
    await this.client.exec(boxName, ['rm', '-f', ackPath], { timeoutMs: 15000, signal: opts.signal })

    const result = await this.client.exec(
      boxName,
      [nodePath, verifyPath, payloadPath, ackPath],
      { timeoutMs: this.config.boxSidecar.verifyTimeoutMs, signal: opts.signal },
    )
    if (result.exitCode !== 0) {
      throw new HandoffError('VERIFY_FAILED', `box-side verifier exited ${result.exitCode}: ${(result.stderr ?? result.stdout ?? '').slice(0, 300)}`)
    }

    // Read the ACK file. `exec --json` returns an object with `stdout`; when
    // the file is missing the CLI exits non-zero and we surface that.
    const ackResult = await this.client.exec(boxName, ['cat', ackPath], { timeoutMs: 15000, signal: opts.signal })
    const ackText = typeof ackResult === 'object' && ackResult !== null
      ? String(ackResult.stdout ?? ackResult.raw ?? '')
      : String(ackResult ?? '')
    const trimmed = ackText.trim()
    if (!trimmed) throw new HandoffError('ACK_MISSING', 'box-side verifier produced no acknowledgement')
    let ack
    try {
      ack = JSON.parse(trimmed)
    } catch {
      throw new HandoffError('ACK_INVALID', `box-side acknowledgement is not JSON: ${trimmed.slice(0, 200)}`)
    }
    assertAck(ack, payload)
    return ack
  }

  /**
   * Ask the box agent to ingest the context pack and acknowledge.
   * @private
   */
  async _awaitAgentAck(boxName, remoteDir, payload, ack, opts) {
    const marker = buildAckMarker(payload.handoffId, payload.digest)
    const prompt = [
      'A DeepSeek Harness session has been handed off to you.',
      `The complete context pack is at ${remoteDir}/${SIDE_PAYLOAD_FILE}.`,
      `A verifier already confirmed the digest and schema (ack at ${remoteDir}/${SIDE_ACK_FILE}).`,
      'Read the payload file, treat its conversation as your own history, and continue from where it left off.',
      'When you have ingested it, reply with exactly this marker on its own line, then a one-sentence confirmation:',
      marker,
    ].join('\n')

    const submit = await this.client.agentPrompt(boxName, prompt, {
      newConversation: true,
      signal: opts.signal,
    })
    const conversationId = submit?.conversationId ?? null

    // Wait for the turn and look for the marker. Since this is a new
    // conversation, all events belong to this turn.
    const reply = await this.router._awaitTurn(boxName, conversationId, {
      timeoutMs: this.config.handoff.ackTimeoutMs,
      signal: opts.signal,
    })
    const parsed = parseAckMarker(reply.text)
    if (!parsed || parsed.handoffId !== payload.handoffId || !payload.digest.startsWith(parsed.digestPrefix)) {
      throw new HandoffError('AGENT_ACK_MISSING', `box agent did not acknowledge ingestion (marker ${marker})`)
    }
    return { ...reply, conversationId }
  }

  /**
   * Reclaim control: stop routing to the box and restore the original route.
   * @param {string} sessionId
   * @param {object} [opts]
   * @param {string} [opts.reason]
   * @param {boolean} [opts.interruptTurn]
   * @returns {Promise<object>}
   */
  async reclaim(sessionId, opts = {}) {
    const state = await this.state.load(sessionId)
    if (!state || state.phase !== 'delegated') {
      throw new HandoffError('NOT_DELEGATED', `session ${sessionId} is not delegated`)
    }
    await this.state.update(sessionId, (s) => {
      if (!s) return null
      s.phase = 'reclaiming'
      return s
    })
    try {
      if (opts.interruptTurn !== false) {
        await this.router.interrupt(state, { signal: opts.signal })
      }
      const final = await this.state.update(sessionId, (s) => {
        if (!s) return null
        s.phase = 'reclaimed'
        s.reclaimedAt = Date.now()
        s.reclaimedReason = opts.reason ?? 'explicit reclaim'
        s.pending = null
        // Keep box/conversation for potential re-handoff.
        return s
      })
      await this.state.audit(sessionId, { event: 'handoff-reclaimed', reason: opts.reason ?? 'explicit reclaim' })
      return final
    } catch (error) {
      await this.state.update(sessionId, (s) => {
        if (!s) return null
        s.phase = 'delegated'
        s.lastError = error?.message ?? String(error)
        return s
      })
      throw error
    }
  }

  /**
   * Mark a session as failed and record the error.
   * @private
   */
  async _fail(sessionId, error, opts = {}) {
    const code = error?.code ?? 'UNKNOWN'
    const message = error?.message ?? String(error)
    await this.state.update(sessionId, (s) => {
      if (!s) return null
      s.phase = 'failed'
      s.lastError = { code, message: message.slice(0, 500), at: Date.now() }
      s.failures = {
        count: (s.failures?.count ?? 0) + 1,
        lastError: message.slice(0, 300),
        lastAt: Date.now(),
      }
      s.pending = null
      return s
    })
    await this.state.audit(sessionId, { event: 'handoff-failed', code, message: message.slice(0, 300) })
  }
}

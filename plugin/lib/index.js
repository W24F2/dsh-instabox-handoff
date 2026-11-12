/**
 * DeepSeek Harness plugin entry: wires the InstaBox bridge into the harness.
 *
 * Exports the Cordis plugin contract (`name`, `inject`, `Config`, `apply`).
 * All heavy lifting lives in `lib/core/*`; this file only adapts harness
 * services to the bridge's plain-object interfaces.
 *
 * @module instabox-bridge/plugin
 */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeConfig, resolveDshHome } from './core/config.js'
import { createState, SessionStateStore } from './core/state.js'
import { createClient } from './core/client.js'
import { InstanceManager } from './core/instance.js'
import { MessageRouter } from './core/router.js'
import { Orchestrator } from './core/orchestrator.js'
import { InstaBoxAdapter } from './core/adapter.js'
import { classifyError, recoveryPlan, shouldFailover } from './core/recovery.js'

export const name = 'instabox-bridge'
export const inject = ['tools', 'commands', 'llm', 'sessions', 'agents']

/** @type {object} schemastery-compatible config shape */
export const Config = {
  type: 'object',
  properties: {
    enabled: { type: 'boolean', default: true },
    providerName: { type: 'string', default: 'instabox' },
    cli: {
      type: 'object',
      properties: {
        program: { type: 'string', default: 'instabox' },
        argsPrefix: { type: 'array', items: { type: 'string' }, default: [] },
        cwd: { type: 'string' },
        timeoutMs: { type: 'number', default: 120000 },
        envPassthrough: { type: 'array', items: { type: 'string' }, default: [] },
        runner: { type: 'string', enum: ['pipe', 'file'], default: 'pipe' },
      },
    },
    instance: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['connect', 'create'], default: 'connect' },
        name: { type: 'string' },
        org: { type: 'string' },
        template: { type: 'string' },
        vcpus: { type: 'number' },
        memMib: { type: 'number' },
        autoSuspend: { type: 'string' },
        meta: { type: 'object' },
        createOnMissing: { type: 'boolean' },
        secrets: { type: 'string' },
        readyTimeoutMs: { type: 'number', default: 300000 },
      },
    },
    handoff: {
      type: 'object',
      properties: {
        timeoutMs: { type: 'number', default: 180000 },
        ackTimeoutMs: { type: 'number', default: 120000 },
        ingestTimeoutMs: { type: 'number', default: 300000 },
        maxAttempts: { type: 'number', default: 3 },
        retryBackoffMs: { type: 'number', default: 1500 },
        requireAgentAck: { type: 'boolean', default: true },
        maxAttachmentBytes: { type: 'number', default: 26214400 },
        maxPayloadBytes: { type: 'number', default: 33554432 },
        transferImages: { type: 'boolean', default: true },
        redactMessageText: { type: 'boolean', default: true },
        reason: { type: 'string' },
      },
    },
    routing: {
      type: 'object',
      properties: {
        turnTimeoutMs: { type: 'number', default: 600000 },
        pollIntervalMs: { type: 'number', default: 40 },
        failoverOnError: { type: 'boolean', default: true },
        maxConsecutiveFailures: { type: 'number', default: 2 },
        dedupeLimit: { type: 'number', default: 50 },
        uncertainPolicy: { type: 'string', enum: ['fail-closed', 'auto-retry'], default: 'fail-closed' },
      },
    },
    boxSidecar: {
      type: 'object',
      properties: {
        dir: { type: 'string', default: '/data/instabox-bridge' },
        nodePath: { type: 'string', default: 'node' },
        verifyTimeoutMs: { type: 'number', default: 60000 },
      },
    },
    stateDir: { type: 'string' },
    logLevel: { type: 'string', enum: ['debug', 'info', 'warn', 'error', 'silent'], default: 'info' },
    preferences: { type: 'object' },
    provider: { type: 'string' },
    model: { type: 'string' },
  },
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const SIDECAR_PATH = join(__dirname, '..', 'box-side', 'verify.mjs')

/**
 * @param {object} ctx - Cordis context
 * @param {object} rawConfig - plugin config
 */
export function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig)
  if (!config.enabled) {
    ctx.logger?.info?.('[instabox-bridge] disabled by config')
    return
  }

  const stateDir = config.stateDir ?? join(resolveDshHome(), 'instabox-bridge')
  const state = new SessionStateStore({ rootDir: stateDir, logger: ctx.logger ?? console })
  const client = createClient(config, ctx.logger ?? console)
  const instance = new InstanceManager({ client, config, state, logger: ctx.logger ?? console })
  const router = new MessageRouter({ client, state, config, logger: ctx.logger ?? console })

  // Session reader: pull events + agent handle for a session id.
  const sessionReader = async (sessionId) => {
    const agent = ctx.agents?.get?.(sessionId)
    const session = agent?.session ?? ctx.sessions?.get?.(sessionId)
    let events = []
    let header = null
    if (session?.events) {
      events = [...session.events]
      header = session.header ?? null
    } else if (ctx.sessionPersistence?.inspect) {
      const stored = await ctx.sessionPersistence.inspect(sessionId)
      events = stored?.events ?? []
      header = stored?.meta ?? null
    }
    return {
      events,
      header,
      agentStatus: agent?.status ?? null,
      inbox: agent?.inbox ? { nextTurn: agent.inbox.nextTurn, nextStep: agent.inbox.nextStep } : null,
      agent,
    }
  }

  const sidecarSource = await readFile(SIDECAR_PATH, 'utf8')
  const orchestrator = new Orchestrator({
    client,
    instance,
    state,
    router,
    config,
    sessionReader,
    sidecarSource,
    logger: ctx.logger ?? console,
  })

  const adapter = new InstaBoxAdapter({ router, state, config, logger: ctx.logger ?? console })

  // Register the LLM adapter for the `instabox` provider route.
  try {
    ctx.llm?.registerAdapter?.([config.providerName], adapter)
  } catch (error) {
    ctx.logger?.warn?.(`[instabox-bridge] failed to register LLM adapter: ${error?.message ?? error}`)
  }

  // ---- Global listeners: adopt delegated sessions after restart ----
  const adopted = new Set()
  const adoptDelegated = async (agent) => {
    const sessionId = String(agent?.id ?? agent?.session?.id ?? '')
    if (!sessionId || adopted.has(sessionId)) return
    const st = await state.load(sessionId)
    if (!st || st.phase !== 'delegated') return
    adopted.add(sessionId)
    installRouteListener(agent, st)
    ctx.logger?.info?.(`[instabox-bridge] adopted delegated session ${sessionId} (box=${st.box?.name})`)
  }

  ctx.on?.('agent/created', async (payload) => {
    try { await adoptDelegated(payload?.agent) } catch {}
  })
  ctx.on?.('agent/session-start', async (payload) => {
    try { await adoptDelegated(payload?.agent) } catch {}
  })

  // Also adopt any already-live agents on plugin load.
  try {
    for (const agent of ctx.agents?.list?.() ?? []) {
      await adoptDelegated(agent)
    }
  } catch {}

  // ---- Per-agent route listener ----
  function installRouteListener(agent, st) {
    const sessionId = String(agent.id)
    const dispose = agent.ctx.on('agent/request', async (payload, next) => {
      const current = await state.load(sessionId)
      if (!current || current.phase !== 'delegated') {
        return next()
      }
      const base = await next()
      return {
        ...base,
        provider: config.providerName,
        model: `box:${current.box?.name ?? 'default'}`,
      }
    }, { prepend: true })
    // Store the disposer on the state for cleanup on reclaim.
    state.update(sessionId, (s) => {
      if (!s) return null
      s._routeDisposer = dispose
      return s
    }).catch(() => {})
    agent._instaboxRouteDisposer = dispose
    return dispose
  }

  // ---- Failover listener: reclaim on repeated box failures ----
  ctx.on?.('agent/request-error', async (payload) => {
    const agent = payload?.agent
    const sessionId = String(agent?.id ?? '')
    if (!sessionId) return undefined
    const st = await state.load(sessionId)
    if (!st || st.phase !== 'delegated') return undefined
    const { retryable, fatal } = classifyError(payload?.failure)
    if (fatal || shouldFailover(st, config.routing.maxConsecutiveFailures)) {
      if (config.routing.failoverOnError) {
        try {
          await orchestrator.reclaim(sessionId, { reason: `auto-failover: ${payload?.failure?.code ?? 'error'}`, interruptTurn: true })
        } catch {}
      }
    }
    return undefined
  })

  // ---- Tools ----
  const toolDefs = [
    {
      name: 'instabox_handoff',
      description: 'Hand the current conversation off to a persistent InstaBox-hosted agent. The box receives the full context and takes over subsequent messages until reclaimed.',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Why the handoff is being initiated' },
        },
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args, exec) {
        const agent = exec?.agent
        const sessionId = String(agent?.id ?? agent?.session?.id ?? '')
        if (!sessionId) return { error: 'no agent context' }
        try {
          const result = await orchestrator.handoff(sessionId, {
            reason: args?.reason,
            signal: exec?.signal,
          })
          return {
            phase: result.phase,
            box: result.box?.name,
            conversationId: result.conversationId,
            message: `Conversation handed off to InstaBox box "${result.box?.name}". Subsequent messages will be handled by the box agent.`,
          }
        } catch (error) {
          return { error: error?.message ?? String(error), code: error?.code }
        }
      },
    },
    {
      name: 'instabox_status',
      description: 'Show the current InstaBox handoff status for this session.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(_args, exec) {
        const agent = exec?.agent
        const sessionId = String(agent?.id ?? agent?.session?.id ?? '')
        const st = await state.load(sessionId)
        if (!st) return { phase: 'idle', message: 'No handoff state for this session.' }
        return {
          phase: st.phase,
          box: st.box?.name,
          conversationId: st.conversationId,
          ack: st.ack ? { digestMatch: st.ack.digestMatch, schemaValid: st.ack.schemaValid } : null,
          lastError: st.lastError,
          pending: st.pending,
          failures: st.failures,
        }
      },
    },
    {
      name: 'instabox_reclaim',
      description: 'Reclaim control of the conversation from the InstaBox agent and return to DeepSeek.',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string' },
          interruptTurn: { type: 'boolean', default: true },
        },
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args, exec) {
        const agent = exec?.agent
        const sessionId = String(agent?.id ?? agent?.session?.id ?? '')
        try {
          const result = await orchestrator.reclaim(sessionId, {
            reason: args?.reason,
            interruptTurn: args?.interruptTurn !== false,
            signal: exec?.signal,
          })
          return { phase: result.phase, reclaimedAt: result.reclaimedAt, message: 'Control reclaimed; DeepSeek is handling this conversation again.' }
        } catch (error) {
          return { error: error?.message ?? String(error), code: error?.code }
        }
      },
    },
  ]

  for (const def of toolDefs) {
    try {
      ctx.tools?.register?.(def)
    } catch (error) {
      ctx.logger?.warn?.(`[instabox-bridge] failed to register tool ${def.name}: ${error?.message ?? error}`)
    }
  }

  // ---- Commands ----
  const commands = [
    {
      name: 'handoff',
      description: 'Hand this conversation off to an InstaBox agent',
      input: { hint: '[reason]' },
      handler: async (invocation) => {
        const sessionId = String(invocation.agent?.id ?? '')
        try {
          const result = await orchestrator.handoff(sessionId, { reason: invocation.rawInput?.trim() || undefined })
          return { kind: 'success', text: `Handoff complete → box "${result.box?.name}" (conversation ${result.conversationId ?? 'new'})` }
        } catch (error) {
          return { kind: 'error', text: `Handoff failed: ${error?.message ?? error}` }
        }
      },
    },
    {
      name: 'handoff-status',
      description: 'Show InstaBox handoff status',
      handler: async (invocation) => {
        const sessionId = String(invocation.agent?.id ?? '')
        const st = await state.load(sessionId)
        if (!st) return { kind: 'success', text: 'No handoff state.' }
        return {
          kind: 'success',
          text: `phase=${st.phase} box=${st.box?.name ?? '-'} conv=${st.conversationId ?? '-'} err=${st.lastError?.message ?? '-'}`,
        }
      },
    },
    {
      name: 'reclaim',
      description: 'Reclaim this conversation from InstaBox',
      handler: async (invocation) => {
        const sessionId = String(invocation.agent?.id ?? '')
        try {
          await orchestrator.reclaim(sessionId, { reason: invocation.rawInput?.trim() || 'user command' })
          return { kind: 'success', text: 'Control reclaimed.' }
        } catch (error) {
          return { kind: 'error', text: `Reclaim failed: ${error?.message ?? error}` }
        }
      },
    },
  ]

  for (const def of commands) {
    try {
      ctx.commands?.register?.(def)
    } catch (error) {
      ctx.logger?.warn?.(`[instabox-bridge] failed to register command ${def.name}: ${error?.message ?? error}`)
    }
  }

  ctx.logger?.info?.('[instabox-bridge] plugin loaded')
}

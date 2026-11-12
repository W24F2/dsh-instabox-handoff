/**
 * Recovery and failover policy.
 *
 * @module instabox-bridge/core/recovery
 */
import { InstanceError } from './instance.js'
import { InstaBoxError, EXIT } from './client.js'
import { HandoffError } from './orchestrator.js'
import { RoutingError } from './router.js'

/**
 * Classify an error for retry/failover decisions.
 * @param {unknown} error
 * @returns {{ retryable: boolean, fatal: boolean, code: string, message: string }}
 */
export function classifyError(error) {
  const code = error?.code ?? 'UNKNOWN'
  const message = error?.message ?? String(error)

  // InstaBox CLI exit codes.
  if (error instanceof InstaBoxError) {
    if (error.exitCode === EXIT.AUTH) return { retryable: false, fatal: true, code: 'AUTH', message }
    if (error.exitCode === EXIT.NOT_FOUND) return { retryable: false, fatal: true, code: 'NOT_FOUND', message }
    if (error.exitCode === EXIT.QUOTA) return { retryable: false, fatal: true, code: 'QUOTA', message }
    if (error.exitCode === EXIT.RETRYABLE || error.retryable) {
      return { retryable: true, fatal: false, code, message }
    }
    return { retryable: false, fatal: false, code, message }
  }

  if (error instanceof InstanceError) {
    return { retryable: error.retryable === true, fatal: !error.retryable, code, message }
  }
  if (error instanceof HandoffError) {
    return { retryable: false, fatal: true, code, message }
  }
  if (error instanceof RoutingError) {
    return { retryable: false, fatal: false, code, message }
  }

  // Generic errors: retry once, then fail.
  return { retryable: true, fatal: false, code, message }
}

/**
 * Decide whether a failed delegated turn should trigger automatic reclaim.
 * @param {object} state
 * @param {number} maxConsecutive
 * @returns {boolean}
 */
export function shouldFailover(state, maxConsecutive) {
  const failures = state?.failures?.count ?? 0
  return failures >= maxConsecutive
}

/**
 * Build a recovery plan for a session after a DSH restart.
 * @param {object} state
 * @returns {{ action: 'resume-delegation' | 'reconcile-pending' | 'reclaim' | 'none', reason: string }}
 */
export function recoveryPlan(state) {
  if (!state) return { action: 'none', reason: 'no state' }
  switch (state.phase) {
    case 'delegated':
      return { action: 'resume-delegation', reason: 'delegated session found; re-installing route listener' }
    case 'awaiting_ack':
    case 'ingesting':
    case 'transferring':
    case 'preparing':
      return { action: 'reconcile-pending', reason: `handoff in progress (phase=${state.phase}); will resume or fail safe` }
    case 'reclaiming':
      return { action: 'reclaim', reason: 'reclaim was in progress; completing it' }
    case 'reclaimed':
    case 'failed':
    case 'idle':
    default:
      return { action: 'none', reason: `phase=${state.phase}` }
  }
}

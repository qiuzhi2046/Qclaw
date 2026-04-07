import type { ManagedChannelPluginRepairResult } from '../../src/shared/managed-channel-plugin-lifecycle'
import { buildManagedChannelRepairOutcome } from '../../src/shared/managed-channel-repair'
import { sendRepairResult, type RepairResultEvent } from './renderer-notification-bridge'

export type RepairTrigger = 'user-manual' | 'startup' | 'gateway-self-heal' | 'page-load' | 'channel-connect'

/**
 * Unified repair result notification.
 *
 * Rules:
 * - user-manual: detailed progress modal (handled by UI)
 * - startup: short toast (yellow=success, red=failure)
 * - gateway-self-heal: toast + "go to plugin center" link
 * - page-load: silent (no notification)
 * - channel-connect: inline in ChannelConnect page
 */
export function notifyRepairResult(
  result: ManagedChannelPluginRepairResult,
  trigger: RepairTrigger
): void {
  if (trigger === 'page-load') return

  const outcome = buildManagedChannelRepairOutcome(result)
  const event: RepairResultEvent = {
    channelId: result.channelId,
    kind: result.kind,
    ok: outcome.ok,
    summary: outcome.summary,
    retryable: result.kind === 'gateway-reload-failed' ? result.retryable : undefined,
    trigger,
    timestamp: Date.now(),
  }
  sendRepairResult(event)
}

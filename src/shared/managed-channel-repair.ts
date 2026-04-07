import type {
  ManagedChannelPluginRepairResult,
  ManagedChannelPluginStatusView,
} from './managed-channel-plugin-lifecycle'

export interface ManagedChannelRepairOutcome {
  ok: boolean
  summary: string
  log: string
  nextAction: 'launch-interactive-installer' | null
}

export interface ManagedChannelRepairFlowOutcome extends ManagedChannelRepairOutcome {
  result: ManagedChannelPluginRepairResult
}

interface ManagedChannelRepairApi {
  getManagedChannelPluginStatus: (channelId: string) => Promise<ManagedChannelPluginStatusView | null>
  repairManagedChannelPlugin: (channelId: string) => Promise<ManagedChannelPluginRepairResult>
}

function joinText(parts: Array<string | null | undefined>): string {
  return parts
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join('\n')
}

function getFailureSummary(result: ManagedChannelPluginRepairResult): string {
  if (result.kind === 'gateway-reload-failed') {
    const base = result.reloadReason
    return result.retryable ? `${base}（可重试）` : base
  }
  if (result.kind === 'install-failed' || result.kind === 'repair-failed') return result.error
  if (result.kind === 'config-sync-required') return result.reason
  if (result.kind === 'plugin-ready-channel-not-ready') return result.blockingReason
  if (result.kind === 'capability-blocked') {
    return result.missingCapabilities.join('；') || result.status.summary
  }
  if (result.kind === 'quarantine-failed') {
    return result.status.summary || `插件隔离失败：${result.failureKind}`
  }
  if (result.kind === 'manual-action-required') return result.reason
  return result.status.summary
}

function getRepairLogSuffix(result: ManagedChannelPluginRepairResult): string {
  const parts: string[] = []
  if ('failedPhase' in result && result.failedPhase) {
    parts.push(`失败阶段：${result.failedPhase}`)
  }
  if ('rolledBack' in result && result.rolledBack) {
    parts.push('配置已回滚')
  }
  if ('rollbackError' in result && result.rollbackError) {
    parts.push(`回滚失败：${result.rollbackError}`)
  }
  return parts.length > 0 ? `\n  （${parts.join('；')}）` : ''
}

export function buildManagedChannelRepairOutcome(
  result: ManagedChannelPluginRepairResult
): ManagedChannelRepairOutcome {
  if (result.kind === 'ok') {
    return {
      ok: true,
      summary: result.status.summary,
      log: `✅ ${result.status.summary}`,
      nextAction: null,
    }
  }

  if (result.kind === 'manual-action-required') {
    return {
      ok: true,
      summary: result.reason,
      log: `⚠️ ${result.reason}`,
      nextAction: 'launch-interactive-installer',
    }
  }

  const summary = getFailureSummary(result)
  return {
    ok: false,
    summary,
    log: `❌ ${summary}${getRepairLogSuffix(result)}`,
    nextAction: null,
  }
}

export async function runManagedChannelRepairFlow(
  api: ManagedChannelRepairApi,
  channelId: string
): Promise<ManagedChannelRepairFlowOutcome> {
  const currentStatus = await api.getManagedChannelPluginStatus(channelId).catch(() => null)
  const result = await api.repairManagedChannelPlugin(channelId)
  const outcome = buildManagedChannelRepairOutcome(result)

  return {
    ...outcome,
    log: joinText([
      currentStatus ? `🔎 ${currentStatus.summary}` : '',
      outcome.log,
    ]),
    result,
  }
}

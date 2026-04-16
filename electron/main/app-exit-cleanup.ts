import { cancelActiveCommands } from './cli'
import type { GatewayRecoveryResult } from './gateway-lifecycle-controller'
import { stopFeishuInstallerSession } from './feishu-installer-session'
import { stopWeixinInstallerSession } from './weixin-installer-session'

const EXIT_CANCEL_DOMAINS = [
  'gateway',
  'config-write',
  'chat',
  'oauth',
  'capabilities',
  'models',
  'env',
  'plugin-install',
  'feishu-installer',
  'weixin-installer',
  'upgrade',
  'env-setup',
  'global',
] as const

const APP_EXIT_GATEWAY_RECOVERY_TIMEOUT_MS = 5_000

export interface AppExitCleanupResult {
  canceledDomains: string[]
  failedDomains: string[]
  gatewayRecovery: GatewayRecoveryResult
  installerStopped: boolean
}

function shouldLogCleanupSummary(): boolean {
  return process.env.NODE_ENV !== 'test'
}

export async function runAppExitCleanup(): Promise<AppExitCleanupResult> {
  const domainCancelResult = await cancelActiveCommands([...EXIT_CANCEL_DOMAINS])
    .catch(() => ({
      canceledDomains: [] as string[],
      failedDomains: [...EXIT_CANCEL_DOMAINS] as string[],
      untouchedDomains: [] as string[],
    }))
  const canceledDomains = [...domainCancelResult.canceledDomains]
  const failedDomains = [...domainCancelResult.failedDomains]

  let installerStopped = false
  let gatewayRecovery: GatewayRecoveryResult = {
    ok: true,
    recovered: false,
    skipped: true,
    message: '没有需要恢复的飞书安装器网关。',
  }
  try {
    const [feishuStopResult, weixinStopResult] = await Promise.all([
      stopFeishuInstallerSession({
        recoverGateway: true,
        recoveryTimeoutMs: APP_EXIT_GATEWAY_RECOVERY_TIMEOUT_MS,
      }),
      stopWeixinInstallerSession(),
    ])
    gatewayRecovery = feishuStopResult?.gatewayRecovery || gatewayRecovery
    installerStopped = Boolean(feishuStopResult?.ok) && Boolean(weixinStopResult?.ok)
  } catch {
    installerStopped = false
    gatewayRecovery = {
      ok: false,
      recovered: false,
      skipped: false,
      message: '应用退出清理时安装器停止或网关恢复失败。',
    }
  }

  if (shouldLogCleanupSummary()) {
    console.info(
      `[app-exit-cleanup] canceledDomains=${canceledDomains.join(',') || '-'} failedDomains=${failedDomains.join(',') || '-'} installerStopped=${installerStopped}`
    )
  }

  return {
    canceledDomains,
    failedDomains,
    gatewayRecovery,
    installerStopped,
  }
}

import { pollWithBackoff } from '../../src/shared/polling'
import { UI_RUNTIME_DEFAULTS } from '../../src/shared/runtime-policies'
import { classifyGatewayRuntimeState } from '../../src/shared/gateway-runtime-diagnostics'
import type { CliResult, GatewayStatusCheckResult } from './cli'
import {
  gatewayHealth,
  gatewayForceRestart,
  gatewayRestart,
  gatewayStart,
  gatewayStatus,
  gatewayStop,
} from './cli'
import { appendEnvCheckDiagnostic } from './env-check-diagnostics'
import type {
  GatewayBootstrapProgressState,
  GatewayEnsureRunningResult,
} from './openclaw-gateway-service'
import type { WindowsGatewayOwnerSnapshot } from './platforms/windows/windows-channel-runtime-snapshot'
import type { WindowsActiveRuntimeSnapshot } from './platforms/windows/windows-runtime-policy'
import {
  buildWindowsGatewayOwnerSnapshotFromLauncherIntegrity,
  inspectWindowsGatewayLauncherIntegrity,
} from './platforms/windows/windows-platform-ops'
import { getSelectedWindowsActiveRuntimeSnapshot } from './windows-active-runtime'

type GatewayLifecycleMutationAction =
  | 'ensure'
  | 'start'
  | 'restart'
  | 'reload'
  | 'stop'

interface GatewayLifecycleMutation {
  key: string
  action: GatewayLifecycleMutationAction
  reason: string
  startedAt: number
}

export interface GatewayLifecycleState {
  busy: boolean
  inFlight: {
    key: string
    action: GatewayLifecycleMutationAction
    reason: string
    startedAt: string
  } | null
  sharedKeys: string[]
}

export interface EnsureGatewayReadyOptions {
  onStateChange?: (state: GatewayBootstrapProgressState) => void
  skipRuntimePrecheck?: boolean
}

export interface ReloadGatewayForConfigChangeOptions {
  preferEnsureWhenNotRunning?: boolean
  ensureOptions?: EnsureGatewayReadyOptions
}

export interface GatewayReloadResult extends CliResult {
  running?: boolean
  summary?: string
  stateCode?: string
}

export interface GatewayInstallerStopSnapshot {
  gatewayOwner: WindowsGatewayOwnerSnapshot | null
  runtimeSnapshot: WindowsActiveRuntimeSnapshot | null
  stopped: boolean
  wasOwnedByQclaw: boolean
  wasRunning: boolean
}

export interface GatewayInstallerStopResult {
  ok: boolean
  skipped: boolean
  stopped: boolean
  stopResult: CliResult | null
  snapshot: GatewayInstallerStopSnapshot
}

export interface GatewayRecoveryResult {
  ok: boolean
  recovered: boolean
  skipped: boolean
  code?: number | null
  message?: string
  stderr?: string
  stdout?: string
}

let lifecycleMutationQueue: Promise<void> = Promise.resolve()
let inFlightMutation: GatewayLifecycleMutation | null = null
const sharedMutations = new Map<string, Promise<unknown>>()

function enqueueLifecycleMutation<T>(task: () => Promise<T>): Promise<T> {
  const runTask = lifecycleMutationQueue.then(task, task)
  lifecycleMutationQueue = runTask.then(
    () => undefined,
    () => undefined
  )
  return runTask
}

function runSharedLifecycleMutation<T>(
  key: string,
  action: GatewayLifecycleMutationAction,
  reason: string,
  task: () => Promise<T>
): Promise<T> {
  const existing = sharedMutations.get(key)
  if (existing) {
    return existing as Promise<T>
  }

  const mutation: GatewayLifecycleMutation = {
    key,
    action,
    reason,
    startedAt: Date.now(),
  }

  const scheduled = enqueueLifecycleMutation(async () => {
    inFlightMutation = mutation
    try {
      return await task()
    } finally {
      if (inFlightMutation === mutation) {
        inFlightMutation = null
      }
    }
  })

  sharedMutations.set(key, scheduled)
  return scheduled.finally(() => {
    if (sharedMutations.get(key) === scheduled) {
      sharedMutations.delete(key)
    }
  })
}

async function ensureGatewayRunningDirect(
  options: EnsureGatewayReadyOptions = {}
): Promise<GatewayEnsureRunningResult> {
  const gatewayService = await import('./openclaw-gateway-service')
  return gatewayService.ensureGatewayRunning(options)
}

async function waitForGatewayHealthyAfterReload(
  restartResult: CliResult
): Promise<GatewayReloadResult> {
  let lastStatus: GatewayStatusCheckResult = {
    running: false,
    raw: '',
    stderr: '',
    code: null,
    stateCode: 'gateway_not_running',
    summary: '网关重载后尚未恢复可用',
  }

  const readiness = await pollWithBackoff({
    policy: UI_RUNTIME_DEFAULTS.gatewayReadiness.poll,
    execute: async () => {
      const status = await gatewayStatus().catch((): GatewayStatusCheckResult => ({
        running: false,
        raw: '',
        stderr: '',
        code: null,
        stateCode: 'gateway_not_running',
        summary: '网关重载后尚未恢复可用',
      }))
      if (status.running) {
        lastStatus = status
        return lastStatus
      }

      const health = await gatewayHealth().catch(() => null)
      lastStatus = health?.running
        ? {
            ...health,
            rpcReachable: status.rpcReachable,
            summary: health.summary || status.summary || '网关已确认可用',
          }
        : status
      return lastStatus
    },
    isSuccess: (value) => Boolean(value.running),
  })

  if (readiness.ok && readiness.value?.running) {
    return {
      ...restartResult,
      ok: true,
      code: 0,
      running: true,
      stateCode: 'healthy',
      summary: readiness.value.summary || '网关已重载并确认可用',
      stdout: readiness.value.raw || restartResult.stdout,
      stderr: readiness.value.stderr || restartResult.stderr,
    }
  }

  const failedStatus = readiness.value || lastStatus
  const classification = classifyGatewayRuntimeState({
    ok: false,
    running: false,
    stdout: failedStatus.raw || restartResult.stdout,
    stderr: failedStatus.stderr || restartResult.stderr || '网关重载后健康检查未通过',
    diagnostics: {
      lastHealth: failedStatus,
    },
    stateCode: failedStatus.stateCode,
    summary: failedStatus.summary,
  })

  return {
    ok: false,
    code: failedStatus.code ?? 1,
    stdout: failedStatus.raw || restartResult.stdout,
    stderr: failedStatus.stderr || restartResult.stderr || classification.summary,
    running: false,
    stateCode: classification.stateCode,
    summary: classification.summary,
  }
}

function cloneWindowsActiveRuntimeSnapshot(
  snapshot: WindowsActiveRuntimeSnapshot | null | undefined
): WindowsActiveRuntimeSnapshot | null {
  return snapshot ? { ...snapshot } : null
}

function isQclawManagedWindowsGatewayOwner(
  owner: WindowsGatewayOwnerSnapshot | null | undefined
): boolean {
  return owner?.ownerKind === 'scheduled-task' || owner?.ownerKind === 'startup-folder'
}

async function captureGatewayInstallerStopSnapshot(): Promise<GatewayInstallerStopSnapshot> {
  const status = await gatewayStatus().catch((): GatewayStatusCheckResult => ({
    running: false,
    raw: '',
    stderr: '',
    code: null,
    stateCode: 'gateway_not_running',
    summary: '无法确认网关状态',
  }))
  const wasRunning = Boolean(status?.running)

  if (process.platform !== 'win32') {
    return {
      gatewayOwner: null,
      runtimeSnapshot: null,
      stopped: false,
      wasOwnedByQclaw: wasRunning,
      wasRunning,
    }
  }

  const runtimeSnapshot = cloneWindowsActiveRuntimeSnapshot(getSelectedWindowsActiveRuntimeSnapshot())
  let gatewayOwner: WindowsGatewayOwnerSnapshot | null = null
  if (runtimeSnapshot?.stateDir) {
    try {
      const launcherIntegrity = await inspectWindowsGatewayLauncherIntegrity({
        homeDir: runtimeSnapshot.stateDir,
      })
      gatewayOwner = buildWindowsGatewayOwnerSnapshotFromLauncherIntegrity(launcherIntegrity)
    } catch {
      gatewayOwner = {
        ownerKind: 'unknown',
        ownerLauncherPath: '',
        ownerTaskName: '',
      }
    }
  }

  return {
    gatewayOwner,
    runtimeSnapshot,
    stopped: false,
    wasOwnedByQclaw: isQclawManagedWindowsGatewayOwner(gatewayOwner),
    wasRunning,
  }
}

export function getGatewayLifecycleState(): GatewayLifecycleState {
  return {
    busy: Boolean(inFlightMutation),
    inFlight: inFlightMutation
      ? {
          key: inFlightMutation.key,
          action: inFlightMutation.action,
          reason: inFlightMutation.reason,
          startedAt: new Date(inFlightMutation.startedAt).toISOString(),
        }
      : null,
    sharedKeys: Array.from(sharedMutations.keys()),
  }
}

export async function ensureGatewayReady(
  options: EnsureGatewayReadyOptions = {},
  reason = 'ensure-ready'
): Promise<GatewayEnsureRunningResult> {
  const key = options.skipRuntimePrecheck ? 'ensure:skip-runtime-precheck' : 'ensure:strict'
  await appendEnvCheckDiagnostic('gateway-lifecycle-ensure-requested', {
    key,
    reason,
    skipRuntimePrecheck: Boolean(options.skipRuntimePrecheck),
  })
  return runSharedLifecycleMutation(key, 'ensure', reason, async () => {
    const result = await ensureGatewayRunningDirect(options)
    await appendEnvCheckDiagnostic('gateway-lifecycle-ensure-result', {
      key,
      reason,
      ok: result.ok,
      running: result.running,
      summary: result.summary || result.stderr || result.stdout || '',
      stateCode: result.stateCode || null,
    })
    return result
  })
}

export async function startGatewayLifecycle(reason = 'start'): Promise<CliResult> {
  return runSharedLifecycleMutation('start', 'start', reason, () => gatewayStart())
}

export async function restartGatewayLifecycle(reason = 'restart'): Promise<CliResult> {
  return runSharedLifecycleMutation('restart', 'restart', reason, () => gatewayRestart())
}

export async function forceRestartGatewayLifecycle(reason = 'force-restart'): Promise<GatewayReloadResult> {
  return runSharedLifecycleMutation('force-restart', 'restart', reason, async () => {
    const restartResult = await gatewayForceRestart()
    if (!restartResult.ok) {
      return restartResult
    }

    return waitForGatewayHealthyAfterReload(restartResult)
  })
}

export async function reloadGatewayForConfigChange(
  reason: string,
  options: ReloadGatewayForConfigChangeOptions = {}
): Promise<GatewayReloadResult> {
  return runSharedLifecycleMutation('reload', 'reload', reason, async () => {
    const preferEnsureWhenNotRunning = options.preferEnsureWhenNotRunning !== false
    if (preferEnsureWhenNotRunning) {
      const status = await gatewayStatus().catch(() => ({ running: false }))
      if (!status?.running) {
        return ensureGatewayRunningDirect(options.ensureOptions)
      }
    }

    const restartResult = await gatewayRestart()
    if (!restartResult.ok) {
      return restartResult
    }

    return waitForGatewayHealthyAfterReload(restartResult)
  })
}

export async function stopGatewayIfOwned(reason = 'stop'): Promise<CliResult> {
  return runSharedLifecycleMutation('stop', 'stop', reason, () => gatewayStop())
}

export async function stopGatewayForInstaller(
  reason = 'installer-stop'
): Promise<GatewayInstallerStopResult> {
  return runSharedLifecycleMutation('installer-stop', 'stop', reason, async () => {
    const snapshot = await captureGatewayInstallerStopSnapshot()
    await appendEnvCheckDiagnostic('gateway-installer-stop-snapshot', {
      reason,
      wasRunning: snapshot.wasRunning,
      wasOwnedByQclaw: snapshot.wasOwnedByQclaw,
      ownerKind: snapshot.gatewayOwner?.ownerKind || null,
      stateDir: snapshot.runtimeSnapshot?.stateDir || null,
    })

    if (!snapshot.wasRunning || !snapshot.wasOwnedByQclaw) {
      return {
        ok: true,
        skipped: true,
        stopped: false,
        stopResult: null,
        snapshot,
      }
    }

    const stopResult = await gatewayStop({
      activeRuntimeSnapshot: snapshot.runtimeSnapshot || undefined,
    })
    const stopped = Boolean(stopResult.ok)
    const nextSnapshot = {
      ...snapshot,
      stopped,
    }
    await appendEnvCheckDiagnostic('gateway-installer-stop-result', {
      reason,
      ok: stopResult.ok,
      stopped,
      code: stopResult.code ?? null,
    })

    return {
      ok: stopResult.ok,
      skipped: false,
      stopped,
      stopResult,
      snapshot: nextSnapshot,
    }
  })
}

export async function recoverGatewayForInstaller(
  snapshot: GatewayInstallerStopSnapshot | null | undefined,
  reason = 'installer-recovery'
): Promise<GatewayRecoveryResult> {
  return runSharedLifecycleMutation('installer-recovery', 'start', reason, async () => {
    const stopSnapshot = snapshot || null
    if (
      !stopSnapshot
      || !stopSnapshot.stopped
      || !stopSnapshot.wasRunning
      || !stopSnapshot.wasOwnedByQclaw
    ) {
      return {
        ok: true,
        recovered: false,
        skipped: true,
        message: 'Qclaw 未停止托管网关，已跳过恢复。',
      }
    }

    await appendEnvCheckDiagnostic('gateway-installer-recovery-start', {
      reason,
      ownerKind: stopSnapshot.gatewayOwner?.ownerKind || null,
      stateDir: stopSnapshot.runtimeSnapshot?.stateDir || null,
    })
    const startResult = await gatewayStart({
      activeRuntimeSnapshot: stopSnapshot.runtimeSnapshot || undefined,
      configRepairPreflightHomeDir: stopSnapshot.runtimeSnapshot?.stateDir || undefined,
    })
    await appendEnvCheckDiagnostic('gateway-installer-recovery-result', {
      reason,
      ok: startResult.ok,
      code: startResult.code ?? null,
    })

    return {
      ok: startResult.ok,
      recovered: Boolean(startResult.ok),
      skipped: false,
      code: startResult.code,
      stdout: startResult.stdout,
      stderr: startResult.stderr,
      message: startResult.ok
        ? '安装器结束后网关已恢复。'
        : startResult.stderr || startResult.stdout || '安装器结束后网关恢复失败。',
    }
  })
}

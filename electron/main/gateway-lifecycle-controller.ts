import { pollWithBackoff } from '../../src/shared/polling'
import { UI_RUNTIME_DEFAULTS } from '../../src/shared/runtime-policies'
import { classifyGatewayRuntimeState } from '../../src/shared/gateway-runtime-diagnostics'
import type { CliResult, GatewayHealthCheckResult } from './cli'
import {
  gatewayHealth,
  gatewayRestart,
  gatewayStart,
  gatewayStop,
} from './cli'
import type {
  GatewayBootstrapProgressState,
  GatewayEnsureRunningResult,
} from './openclaw-gateway-service'

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
  let lastHealth: GatewayHealthCheckResult = {
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
      lastHealth = await gatewayHealth().catch(() => ({
        running: false,
        raw: '',
        stderr: '',
        code: null,
        stateCode: 'gateway_not_running',
        summary: '网关重载后尚未恢复可用',
      }))
      return lastHealth
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

  const failedHealth = readiness.value || lastHealth
  const classification = classifyGatewayRuntimeState({
    ok: false,
    running: false,
    stdout: failedHealth.raw || restartResult.stdout,
    stderr: failedHealth.stderr || restartResult.stderr || '网关重载后健康检查未通过',
    diagnostics: {
      lastHealth: failedHealth,
    },
    stateCode: failedHealth.stateCode,
    summary: failedHealth.summary,
  })

  return {
    ok: false,
    code: failedHealth.code ?? 1,
    stdout: failedHealth.raw || restartResult.stdout,
    stderr: failedHealth.stderr || restartResult.stderr || classification.summary,
    running: false,
    stateCode: classification.stateCode,
    summary: classification.summary,
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
  return runSharedLifecycleMutation(key, 'ensure', reason, () =>
    ensureGatewayRunningDirect(options)
  )
}

export async function startGatewayLifecycle(reason = 'start'): Promise<CliResult> {
  return runSharedLifecycleMutation('start', 'start', reason, () => gatewayStart())
}

export async function restartGatewayLifecycle(reason = 'restart'): Promise<CliResult> {
  return runSharedLifecycleMutation('restart', 'restart', reason, () => gatewayRestart())
}

export async function reloadGatewayForConfigChange(
  reason: string,
  options: ReloadGatewayForConfigChangeOptions = {}
): Promise<GatewayReloadResult> {
  return runSharedLifecycleMutation('reload', 'reload', reason, async () => {
    const preferEnsureWhenNotRunning = options.preferEnsureWhenNotRunning !== false
    if (preferEnsureWhenNotRunning) {
      const health = await gatewayHealth().catch(() => ({ running: false }))
      if (!health?.running) {
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

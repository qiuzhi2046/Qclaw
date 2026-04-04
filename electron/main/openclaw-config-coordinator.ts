import type { OpenClawInstallCandidate } from '../../src/shared/openclaw-phase1'
import type {
  OpenClawConfigPatchWriteRequest,
  OpenClawGuardedWriteResult,
} from '../../src/shared/openclaw-phase2'
import { collectChangedJsonPaths } from './openclaw-config-diff'
import { resolveGatewayApplyAction } from './gateway-apply-policy'
import { readConfig, runCli } from './cli'
import { restartGatewayLifecycle } from './gateway-lifecycle-controller'
import { guardedWriteConfig } from './openclaw-config-guard'

let configWriteQueue: Promise<void> = Promise.resolve()

export interface ApplyConfigPatchGuardedOptions {
  applyGatewayPolicy?: boolean
}

function enqueueConfigWriteTask<T>(task: () => Promise<T>): Promise<T> {
  const runTask = configWriteQueue.then(task, task)
  configWriteQueue = runTask.then(
    () => undefined,
    () => undefined
  )
  return runTask
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function cloneJsonValue<T>(value: T): T {
  if (value === undefined) return value
  return JSON.parse(JSON.stringify(value)) as T
}

function normalizeConfig(config: Record<string, any> | null | undefined): Record<string, any> {
  if (!isPlainObject(config)) return {}
  return cloneJsonValue(config)
}

function isDeepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true

  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return false
    for (let index = 0; index < left.length; index += 1) {
      if (!isDeepEqual(left[index], right[index])) return false
    }
    return true
  }

  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left)
    const rightKeys = Object.keys(right)
    if (leftKeys.length !== rightKeys.length) return false
    for (const key of leftKeys) {
      if (!Object.prototype.hasOwnProperty.call(right, key)) return false
      if (!isDeepEqual(left[key], right[key])) return false
    }
    return true
  }

  return false
}

/**
 * Rebase renderer-side config edits (before -> after) onto the latest config snapshot.
 * Unchanged fields keep latest values to reduce concurrent overwrite risk.
 */
function rebaseConfigValue(base: unknown, desired: unknown, latest: unknown): unknown {
  if (isDeepEqual(base, desired)) {
    return cloneJsonValue(latest)
  }

  if (isPlainObject(base) && isPlainObject(desired)) {
    const latestObject = isPlainObject(latest) ? cloneJsonValue(latest) : {}
    const result: Record<string, any> = { ...latestObject }
    const keys = new Set([...Object.keys(base), ...Object.keys(desired)])

    for (const key of keys) {
      const baseHas = Object.prototype.hasOwnProperty.call(base, key)
      const desiredHas = Object.prototype.hasOwnProperty.call(desired, key)

      if (!desiredHas) {
        if (baseHas) {
          delete result[key]
        }
        continue
      }

      if (!baseHas) {
        result[key] = cloneJsonValue(desired[key])
        continue
      }

      const baseValue = base[key]
      const desiredValue = desired[key]
      if (isDeepEqual(baseValue, desiredValue)) {
        continue
      }

      if (isPlainObject(baseValue) && isPlainObject(desiredValue)) {
        const latestValue = Object.prototype.hasOwnProperty.call(result, key) ? result[key] : undefined
        result[key] = rebaseConfigValue(baseValue, desiredValue, latestValue)
        continue
      }

      result[key] = cloneJsonValue(desiredValue)
    }

    return result
  }

  return cloneJsonValue(desired)
}

function buildNoopResult(): OpenClawGuardedWriteResult {
  return {
    ok: true,
    blocked: false,
    wrote: false,
    target: 'config',
    snapshotCreated: false,
    snapshot: null,
    changedJsonPaths: [],
    ownershipSummary: null,
    message: '配置没有发生变化，无需写入。',
  }
}

function appendMessage(baseMessage: string | undefined, extraMessage: string): string {
  const normalizedBase = String(baseMessage || '').trim()
  if (!normalizedBase) return extraMessage
  return `${normalizedBase} ${extraMessage}`
}

async function applyGatewayDecision(action: 'none' | 'hot-reload' | 'restart'): Promise<{
  ok: boolean
  mode: 'none' | 'hot-reload' | 'restart'
  note?: string
}> {
  if (action === 'none') {
    return {
      ok: true,
      mode: 'none',
    }
  }

  if (action === 'restart') {
    const restartResult = await restartGatewayLifecycle('config-coordinator-policy-restart')
    return {
      ok: Boolean(restartResult?.ok),
      mode: 'restart',
      note: restartResult?.stderr || restartResult?.stdout || '',
    }
  }

  const hotReloadResult = await runCli(['secrets', 'reload'], undefined, 'config-write')
  if (hotReloadResult.ok) {
    return {
      ok: true,
      mode: 'hot-reload',
    }
  }

  const restartResult = await restartGatewayLifecycle('config-coordinator-hot-reload-fallback')
  if (restartResult.ok) {
    return {
      ok: true,
      mode: 'restart',
      note: 'hot-reload failed, fallback to restart',
    }
  }

  return {
    ok: false,
    mode: 'restart',
    note:
      restartResult.stderr ||
      hotReloadResult.stderr ||
      hotReloadResult.stdout ||
      'gateway apply action failed',
  }
}

export async function applyConfigPatchGuarded(
  request: OpenClawConfigPatchWriteRequest,
  preferredCandidate?: OpenClawInstallCandidate | null,
  options: ApplyConfigPatchGuardedOptions = {}
): Promise<OpenClawGuardedWriteResult> {
  return enqueueConfigWriteTask(async () => {
    const beforeConfig = normalizeConfig(request.beforeConfig)
    const afterConfig = normalizeConfig(request.afterConfig)
    const requestedChangedJsonPaths = collectChangedJsonPaths(beforeConfig, afterConfig)
    if (requestedChangedJsonPaths.length === 0) {
      return buildNoopResult()
    }

    const latestConfig = normalizeConfig(await readConfig().catch(() => null))
    const rebasedConfig = rebaseConfigValue(beforeConfig, afterConfig, latestConfig)
    const nextConfig = normalizeConfig(isPlainObject(rebasedConfig) ? rebasedConfig : null)

    const writeResult = await guardedWriteConfig(
      {
        config: nextConfig,
        reason: request.reason,
      },
      preferredCandidate
    )

    if (writeResult.ok && writeResult.wrote && options.applyGatewayPolicy !== false) {
      const decision = resolveGatewayApplyAction({
        changedJsonPaths: writeResult.changedJsonPaths,
      })
      const applyResult = await applyGatewayDecision(decision.action)
      const gatewayApply = {
        ok: applyResult.ok,
        requestedAction: decision.action,
        appliedAction: applyResult.mode,
        ...(applyResult.note ? { note: applyResult.note } : {}),
      } as const
      if (!applyResult.ok) {
        return {
          ...writeResult,
          gatewayApply,
          message: appendMessage(
            writeResult.message,
            `配置写入成功，但网关生效动作失败（action=${decision.action}）。请稍后手动重载网关。`
          ),
        }
      }

      if (process.env.NODE_ENV !== 'test') {
        console.info(
          `[gateway-policy] reason=${request.reason || 'unknown'} policyAction=${decision.action} appliedAction=${applyResult.mode} policyReason=${decision.reason} changedPaths=${writeResult.changedJsonPaths.join(',')} note=${applyResult.note || '-'}`
        )
      }

      return {
        ...writeResult,
        gatewayApply,
      }
    }

    return writeResult
  })
}

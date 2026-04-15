import type { CliResult, GatewayStatusCheckResult } from './cli'
import type { GatewayReloadResult } from './gateway-lifecycle-controller'
import type { GatewayEnsureRunningResult } from './openclaw-gateway-service'
import type { GatewayRuntimeStateCode } from '../../src/shared/gateway-runtime-state'
import { applyGatewaySecretAction } from './gateway-secret-apply'
import { MAIN_RUNTIME_POLICY } from './runtime-policy'

export type GatewayRuntimeMutationKind =
  | 'auth-onboard'
  | 'auth-onboard-custom'
  | 'model-change'
  | 'channel-change'

export type GatewayRuntimeMutationAction =
  | 'none'
  | 'ensure'
  | 'reload'
  | 'defer-token-apply'
  | 'apply-token-and-ensure'

export type GatewayRuntimeMutationFailureStage =
  | 'none'
  | 'token-apply'
  | 'runtime-confirm'
  | 'reload'

export interface GatewayRuntimeMutationRequest {
  kind: GatewayRuntimeMutationKind
  reason: string
  gatewayTokenChanged?: boolean
  preferEnsureWhenNotRunning?: boolean
  skipRuntimePrecheck?: boolean
}

interface GatewayRuntimeMutationOptions {
  ensureGatewayRunning?: (options?: { skipRuntimePrecheck?: boolean }) => Promise<GatewayEnsureRunningResult>
  readGatewayStatus?: () => Promise<GatewayStatusCheckResult>
  reloadGateway?: (
    reason: string,
    options?: {
      preferEnsureWhenNotRunning?: boolean
      ensureOptions?: {
        skipRuntimePrecheck?: boolean
      }
    }
  ) => Promise<GatewayReloadResult>
  runCommand?: (args: string[], timeout?: number) => Promise<CliResult>
}

export interface GatewayRuntimeMutationResult extends CliResult {
  action: GatewayRuntimeMutationAction
  attemptedCommands: string[][]
  failureStage: GatewayRuntimeMutationFailureStage
  running: boolean
  summary: string
  stateCode?: GatewayRuntimeStateCode
  safeToRetry?: boolean
  reasonDetail?: GatewayEnsureRunningResult['reasonDetail']
  autoPortMigrated?: boolean
  effectivePort?: number
  appliedAction?: 'hot-reload' | 'restart'
}

const KNOWN_GATEWAY_STATE_CODES = new Set<GatewayRuntimeStateCode>([
  'healthy',
  'service_missing',
  'service_install_failed',
  'service_loaded_but_stale',
  'gateway_not_running',
  'port_conflict_same_gateway',
  'port_conflict_foreign_process',
  'token_mismatch',
  'websocket_1006',
  'auth_missing',
  'plugin_allowlist_warning',
  'plugin_load_failure',
  'config_invalid',
  'network_blocked',
  'unknown_runtime_failure',
])

function normalizeGatewayStateCode(value: unknown): GatewayRuntimeStateCode | undefined {
  const normalized = String(value || '').trim()
  if (!normalized) return undefined
  return KNOWN_GATEWAY_STATE_CODES.has(normalized as GatewayRuntimeStateCode)
    ? (normalized as GatewayRuntimeStateCode)
    : undefined
}

function createGatewayRuntimeFailure(params: {
  action: GatewayRuntimeMutationAction
  attemptedCommands: string[][]
  failureStage: GatewayRuntimeMutationFailureStage
  summary: string
  code?: number | null
  stdout?: string
  stderr?: string
  stateCode?: GatewayRuntimeStateCode
  safeToRetry?: boolean
  reasonDetail?: GatewayEnsureRunningResult['reasonDetail']
  appliedAction?: 'hot-reload' | 'restart'
}): GatewayRuntimeMutationResult {
  return {
    ok: false,
    action: params.action,
    attemptedCommands: params.attemptedCommands,
    failureStage: params.failureStage,
    running: false,
    summary: params.summary,
    stateCode: params.stateCode,
    safeToRetry: params.safeToRetry,
    reasonDetail: params.reasonDetail,
    appliedAction: params.appliedAction,
    code: params.code ?? 1,
    stdout: params.stdout || '',
    stderr: params.stderr || params.summary,
  }
}

function fromEnsureResult(
  action: Extract<GatewayRuntimeMutationAction, 'ensure' | 'apply-token-and-ensure'>,
  failureStage: GatewayRuntimeMutationFailureStage,
  result: GatewayEnsureRunningResult,
  attemptedCommands: string[][],
  extras: Partial<Pick<GatewayRuntimeMutationResult, 'appliedAction'>> = {}
): GatewayRuntimeMutationResult {
  return {
    ...result,
    action,
    attemptedCommands: [...attemptedCommands, ...(result.attemptedCommands || [])],
    failureStage,
    summary: result.summary || result.stderr || result.stdout || '',
    appliedAction: extras.appliedAction,
  }
}

function fromReloadResult(
  result: GatewayReloadResult,
  attemptedCommands: string[][] = []
): GatewayRuntimeMutationResult {
  return {
    ...result,
    action: 'reload',
    attemptedCommands,
    failureStage: result.ok ? 'none' : 'reload',
    running: result.running === true,
    summary: result.summary || result.stderr || result.stdout || '',
    stateCode: normalizeGatewayStateCode(result.stateCode),
  }
}

function buildTokenApplyFailureSummary(note: string): string {
  const detail = String(note || '').trim() || '网关未接受最新认证密钥'
  return `认证变更已写入，但网关 token apply 失败：${detail}`
}

function buildDeferredTokenApplySummary(): string {
  return '认证变更已写入；当前网关未运行，将在下一次启动网关时应用最新 token。'
}

async function defaultRunCommandForGatewayMutation(
  request: GatewayRuntimeMutationRequest,
  args: string[],
  timeout?: number
): Promise<CliResult> {
  const { runCli } = await import('./cli')
  return runCli(
    args,
    timeout ?? MAIN_RUNTIME_POLICY.cli.defaultCommandTimeoutMs,
    request.kind.startsWith('auth-') ? 'oauth' : 'gateway'
  )
}

async function readGatewayStatusForMutation(
  readGatewayStatus?: () => Promise<GatewayStatusCheckResult>
): Promise<GatewayStatusCheckResult> {
  try {
    return await Promise.resolve(
      (readGatewayStatus || (async () => {
        const { gatewayStatus } = await import('./cli')
        return gatewayStatus()
      }))()
    )
  } catch (error) {
    console.error('Failed to read gateway status before reconciling runtime mutation', error)
    return {
      running: false,
      raw: '',
      stderr: '',
      code: null,
      stateCode: 'gateway_not_running',
      summary: '网关当前未运行',
    }
  }
}

export async function reconcileGatewayRuntimeMutation(
  request: GatewayRuntimeMutationRequest,
  options: GatewayRuntimeMutationOptions = {}
): Promise<GatewayRuntimeMutationResult> {
  const attemptedCommands: string[][] = []
  const ensureGatewayRunning =
    options.ensureGatewayRunning
    || ((ensureOptions?: { skipRuntimePrecheck?: boolean }) =>
      import('./gateway-lifecycle-controller').then(({ ensureGatewayReady }) =>
        ensureGatewayReady(
          {
            skipRuntimePrecheck: ensureOptions?.skipRuntimePrecheck,
          },
          request.reason
        )
      ))
  const reloadGateway =
    options.reloadGateway
    || ((reason: string, reloadOptions?: {
      preferEnsureWhenNotRunning?: boolean
      ensureOptions?: {
        skipRuntimePrecheck?: boolean
      }
    }) =>
      import('./gateway-lifecycle-controller').then(({ reloadGatewayForConfigChange }) =>
        reloadGatewayForConfigChange(reason, reloadOptions)
      ))
  const runCommand =
    options.runCommand
    || ((args: string[], timeout?: number) => defaultRunCommandForGatewayMutation(request, args, timeout))

  if (request.gatewayTokenChanged) {
    const gatewayStatusResult = await readGatewayStatusForMutation(options.readGatewayStatus)
    if (!gatewayStatusResult.running) {
      return {
        ok: true,
        action: 'defer-token-apply',
        attemptedCommands,
        failureStage: 'none',
        running: false,
        summary: buildDeferredTokenApplySummary(),
        stateCode: normalizeGatewayStateCode(gatewayStatusResult.stateCode) || 'gateway_not_running',
        safeToRetry: true,
        code: gatewayStatusResult.code ?? 0,
        stdout: gatewayStatusResult.raw || '',
        stderr: gatewayStatusResult.stderr || '',
      }
    }

    const applyResult = await applyGatewaySecretAction({
      requestedAction: 'hot-reload',
      runCommand,
      attemptedCommands,
    })
    if (!applyResult.ok) {
      return createGatewayRuntimeFailure({
        action: 'apply-token-and-ensure',
        attemptedCommands,
        failureStage: 'token-apply',
        summary: buildTokenApplyFailureSummary(applyResult.note || ''),
        appliedAction: applyResult.appliedAction,
      })
    }

    const ensured = await ensureGatewayRunning({
      skipRuntimePrecheck: request.skipRuntimePrecheck,
    })
    return fromEnsureResult(
      'apply-token-and-ensure',
      ensured.ok && ensured.running ? 'none' : 'runtime-confirm',
      ensured,
      attemptedCommands,
      {
        appliedAction: applyResult.appliedAction,
      }
    )
  }

  const preferEnsureWhenNotRunning =
    request.kind.startsWith('auth-') || request.preferEnsureWhenNotRunning !== false
  const gatewayStatusResult = await readGatewayStatusForMutation(options.readGatewayStatus)
  const requiresGatewayReload = request.kind === 'model-change' || request.kind === 'channel-change'

  if (!gatewayStatusResult.running && preferEnsureWhenNotRunning) {
    const ensured = await ensureGatewayRunning({
      skipRuntimePrecheck: request.skipRuntimePrecheck,
    })
    return fromEnsureResult(
      'ensure',
      ensured.ok && ensured.running ? 'none' : 'runtime-confirm',
      ensured,
      attemptedCommands
    )
  }

  if (requiresGatewayReload) {
    const reloadResult = await reloadGateway(request.reason, {
      preferEnsureWhenNotRunning: request.preferEnsureWhenNotRunning !== false,
      ensureOptions: {
        skipRuntimePrecheck: request.skipRuntimePrecheck,
      },
    })
    return fromReloadResult(reloadResult, attemptedCommands)
  }

  return {
    ok: true,
    action: 'none',
    attemptedCommands,
    failureStage: 'none',
    running: gatewayStatusResult.running === true,
    summary: gatewayStatusResult.summary || 'gateway already settled',
    stateCode: normalizeGatewayStateCode(gatewayStatusResult.stateCode),
    code: gatewayStatusResult.code ?? 0,
    stdout: gatewayStatusResult.raw || '',
    stderr: gatewayStatusResult.stderr || '',
  }
}

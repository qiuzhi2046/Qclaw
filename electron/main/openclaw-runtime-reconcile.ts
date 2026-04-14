import {
  createDefaultOpenClawRuntimeReconcileStore,
  type GatewayBlockingReason,
  type GatewayLauncherMode,
  type OpenClawRuntimeReconcileStore,
  type ReconcileActionSummary,
  type RuntimeReconcileStateCode,
  type RuntimeMutationSource,
  type UpgradeCompatibilityAssessment,
} from '../../src/shared/gateway-runtime-reconcile-state'
import type {
  GatewayRuntimeReasonDetail,
  GatewayRuntimeStateCode,
} from '../../src/shared/gateway-runtime-state'
import { sanitizeGatewayRuntimeReasonDetail } from '../../src/shared/gateway-runtime-reason-detail'
import { atomicWriteJson } from './atomic-write'
import {
  assessOpenClawUpgradeCompatibility,
  detectOpenClawVersionBand,
  inferCompatibilityBlockingReason,
} from './openclaw-upgrade-compatibility'

const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs')
const os = process.getBuiltinModule('node:os') as typeof import('node:os')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')
const { readFile } = fs.promises
const { homedir } = os

const STORE_RELATIVE_PATH = path.join('runtime', 'openclaw-runtime-reconcile.json')

function resolveUserDataDirectory(): string {
  return String(process.env.QCLAW_USER_DATA_DIR || path.join(homedir(), '.qclaw-lite')).trim()
}

export function resolveOpenClawRuntimeReconcileStorePath(): string {
  return path.join(resolveUserDataDirectory(), STORE_RELATIVE_PATH)
}

function sanitizeReconcileActionSummary(value: unknown): ReconcileActionSummary | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const kind = String(record.kind || '').trim()
  const action = String(record.action || '').trim()
  const outcome = String(record.outcome || '').trim()
  if (!kind || !action || !outcome) return null
  if (kind !== 'probe' && kind !== 'repair' && kind !== 'migration') return null
  if (outcome !== 'scheduled' && outcome !== 'succeeded' && outcome !== 'skipped' && outcome !== 'failed') {
    return null
  }

  return {
    kind,
    action,
    outcome,
    detail: String(record.detail || '').trim() || undefined,
    changedPaths: Array.isArray(record.changedPaths)
      ? record.changedPaths.map((item) => String(item || '').trim()).filter(Boolean)
      : undefined,
  }
}

function sanitizeRuntimeMutationSource(value: unknown): RuntimeMutationSource | null {
  const normalized = String(value || '').trim()
  if (
    normalized === 'startup' ||
    normalized === 'config' ||
    normalized === 'env' ||
    normalized === 'auth' ||
    normalized === 'plugin-install' ||
    normalized === 'gateway-bootstrap' ||
    normalized === 'manual'
  ) {
    return normalized
  }
  return null
}

function sanitizeGatewayBlockingReason(value: unknown): GatewayBlockingReason {
  const normalized = String(value || '').trim()
  if (
    normalized === 'none' ||
    normalized === 'upgrade_incompatible_config' ||
    normalized === 'machine_local_auth_missing' ||
    normalized === 'runtime_token_stale' ||
    normalized === 'provider_plugin_not_ready' ||
    normalized === 'control_ui_handshake_failed' ||
    normalized === 'service_generation_stale' ||
    normalized === 'legacy_env_alias_detected' ||
    normalized === 'unknown_future_version' ||
    normalized === 'unknown_runtime_state'
  ) {
    return normalized
  }
  return 'unknown_runtime_state'
}

function clampRevision(value: unknown, fallback = 0): number {
  const normalized = Number(value)
  return Number.isFinite(normalized) ? Math.max(0, Math.trunc(normalized)) : Math.max(0, Math.trunc(fallback))
}

export function resolveGatewayBlockingReasonFromState(params: {
  gatewayStateCode?: GatewayRuntimeStateCode | null
  compatibility?: UpgradeCompatibilityAssessment | null
  fallbackReason?: GatewayBlockingReason | null
}): GatewayBlockingReason {
  const compatibilityReason =
    params.compatibility ? inferCompatibilityBlockingReason(params.compatibility) : null
  if (compatibilityReason) {
    return compatibilityReason
  }

  switch (params.gatewayStateCode) {
    case 'healthy':
      return 'none'
    case 'config_invalid':
      return 'upgrade_incompatible_config'
    case 'auth_missing':
      return 'machine_local_auth_missing'
    case 'token_mismatch':
      return 'runtime_token_stale'
    case 'plugin_load_failure':
    case 'plugin_allowlist_warning':
      return 'provider_plugin_not_ready'
    case 'websocket_1006':
      return 'control_ui_handshake_failed'
    case 'service_missing':
    case 'service_install_failed':
    case 'service_loaded_but_stale':
    case 'gateway_not_running':
    case 'port_conflict_same_gateway':
    case 'port_conflict_foreign_process':
      return 'service_generation_stale'
    case 'network_blocked':
    case 'unknown_runtime_failure':
    default:
      return sanitizeGatewayBlockingReason(params.fallbackReason)
  }
}

export function resolveRuntimeReconcileStateCode(
  blockingReason: GatewayBlockingReason,
  safeToRetry: boolean
): RuntimeReconcileStateCode {
  if (blockingReason === 'none') return 'ready'
  if (
    blockingReason === 'upgrade_incompatible_config' ||
    blockingReason === 'machine_local_auth_missing' ||
    blockingReason === 'provider_plugin_not_ready' ||
    blockingReason === 'legacy_env_alias_detected' ||
    blockingReason === 'unknown_future_version'
  ) {
    return 'blocked'
  }
  return safeToRetry ? 'degraded' : 'blocked'
}

function sanitizeGatewayLauncherMode(value: unknown): GatewayLauncherMode | null {
  const normalized = String(value || '').trim()
  if (normalized === 'schtasks' || normalized === 'startup-fallback') {
    return normalized
  }
  return null
}

function sanitizeStore(value: unknown): OpenClawRuntimeReconcileStore {
  const fallback = createDefaultOpenClawRuntimeReconcileStore()
  if (!value || typeof value !== 'object') return fallback

  const record = value as Record<string, unknown>
  const lastSeenOpenClawVersion = String(record.lastSeenOpenClawVersion || '').trim() || null
  const lastCompatibility = assessOpenClawUpgradeCompatibility({
    currentVersion:
      value &&
      typeof value === 'object' &&
      typeof (value as Record<string, unknown>).lastCompatibility === 'object'
        ? String(((value as Record<string, unknown>).lastCompatibility as Record<string, unknown>).currentVersion || '')
        : lastSeenOpenClawVersion,
    previousVersion:
      value &&
      typeof value === 'object' &&
      typeof (value as Record<string, unknown>).lastCompatibility === 'object'
        ? String(((value as Record<string, unknown>).lastCompatibility as Record<string, unknown>).previousVersion || '')
        : null,
    assessedAt:
      value &&
      typeof value === 'object' &&
      typeof (value as Record<string, unknown>).lastCompatibility === 'object'
        ? String(((value as Record<string, unknown>).lastCompatibility as Record<string, unknown>).assessedAt || '')
        : undefined,
  })

  const runtimeRecord =
    record.runtime && typeof record.runtime === 'object' ? (record.runtime as Record<string, unknown>) : {}
  const desiredRevision = clampRevision(runtimeRecord.desiredRevision)
  const appliedRevision = clampRevision(runtimeRecord.appliedRevision)

  return {
    version: 1,
    lastSeenOpenClawVersion,
    lastSeenVersionBand: detectOpenClawVersionBand(lastSeenOpenClawVersion),
    lastSeenAt: String(record.lastSeenAt || '').trim() || null,
    lastCompatibility,
    runtime: {
      stateCode:
        runtimeRecord.stateCode === 'pending' ||
        runtimeRecord.stateCode === 'in_progress' ||
        runtimeRecord.stateCode === 'ready' ||
        runtimeRecord.stateCode === 'degraded' ||
        runtimeRecord.stateCode === 'blocked'
          ? runtimeRecord.stateCode
          : fallback.runtime.stateCode,
      desiredRevision,
      appliedRevision,
      pendingReasons: Array.isArray(runtimeRecord.pendingReasons)
        ? runtimeRecord.pendingReasons.map((item) => String(item || '').trim()).filter(Boolean)
        : [],
      lastMutationSource: sanitizeRuntimeMutationSource(runtimeRecord.lastMutationSource),
      blockingReason: sanitizeGatewayBlockingReason(runtimeRecord.blockingReason),
      blockingDetail: sanitizeGatewayRuntimeReasonDetail(runtimeRecord.blockingDetail),
      safeToRetry:
        typeof runtimeRecord.safeToRetry === 'boolean'
          ? runtimeRecord.safeToRetry
          : fallback.runtime.safeToRetry,
      lastReconcileAt: String(runtimeRecord.lastReconcileAt || '').trim() || null,
      lastReconcileSummary: String(runtimeRecord.lastReconcileSummary || '').trim() || null,
      lastActions: Array.isArray(runtimeRecord.lastActions)
        ? runtimeRecord.lastActions
            .map(sanitizeReconcileActionSummary)
            .filter((item): item is ReconcileActionSummary => Boolean(item))
        : [],
      launcherMode: sanitizeGatewayLauncherMode(runtimeRecord.launcherMode),
    },
  }
}

async function saveStore(store: OpenClawRuntimeReconcileStore): Promise<OpenClawRuntimeReconcileStore> {
  await atomicWriteJson(resolveOpenClawRuntimeReconcileStorePath(), store, {
    description: 'OpenClaw runtime reconcile 状态',
  })
  return store
}

export async function readOpenClawRuntimeReconcileStore(): Promise<OpenClawRuntimeReconcileStore> {
  try {
    const raw = await readFile(resolveOpenClawRuntimeReconcileStorePath(), 'utf8')
    return sanitizeStore(JSON.parse(raw))
  } catch {
    return createDefaultOpenClawRuntimeReconcileStore()
  }
}

export async function recordObservedOpenClawVersion(
  currentVersion: string | null | undefined,
  options: { seenAt?: string } = {}
): Promise<OpenClawRuntimeReconcileStore> {
  const seenAt = String(options.seenAt || new Date().toISOString())
  const store = await readOpenClawRuntimeReconcileStore()
  const compatibility = assessOpenClawUpgradeCompatibility({
    currentVersion,
    previousVersion: store.lastSeenOpenClawVersion,
    assessedAt: seenAt,
  })

  return saveStore({
    ...store,
    lastSeenOpenClawVersion: compatibility.currentVersion,
    lastSeenVersionBand: compatibility.currentBand,
    lastSeenAt: seenAt,
    lastCompatibility: compatibility,
  })
}

export async function issueDesiredRuntimeRevision(
  source: RuntimeMutationSource,
  pendingReason: string,
  options: {
    requestedAt?: string
    actions?: ReconcileActionSummary[]
  } = {}
): Promise<OpenClawRuntimeReconcileStore> {
  const requestedAt = String(options.requestedAt || new Date().toISOString())
  const store = await readOpenClawRuntimeReconcileStore()
  const desiredRevision = Math.max(store.runtime.desiredRevision, store.runtime.appliedRevision) + 1
  const pendingReasons = Array.from(
    new Set([...store.runtime.pendingReasons, String(pendingReason || '').trim()].filter(Boolean))
  )

  return saveStore({
    ...store,
    runtime: {
      ...store.runtime,
      stateCode: 'pending',
      desiredRevision,
      pendingReasons,
      lastMutationSource: source,
      blockingReason: 'unknown_runtime_state',
      blockingDetail: null,
      lastReconcileAt: requestedAt,
      lastReconcileSummary: `已申请运行状态修订 ${desiredRevision}，等待网关消费最新变更。`,
      lastActions: options.actions ? [...options.actions] : store.runtime.lastActions,
    },
  })
}

export async function markRuntimeRevisionInProgress(
  revision: number,
  options: {
    startedAt?: string
    summary?: string
    blockingReason?: OpenClawRuntimeReconcileStore['runtime']['blockingReason']
    blockingDetail?: GatewayRuntimeReasonDetail | null
    actions?: ReconcileActionSummary[]
  } = {}
): Promise<OpenClawRuntimeReconcileStore> {
  const startedAt = String(options.startedAt || new Date().toISOString())
  const store = await readOpenClawRuntimeReconcileStore()
  const nextRevision = Math.max(store.runtime.desiredRevision, clampRevision(revision, store.runtime.desiredRevision))

  return saveStore({
    ...store,
    runtime: {
      ...store.runtime,
      stateCode: 'in_progress',
      desiredRevision: nextRevision,
      blockingReason: sanitizeGatewayBlockingReason(options.blockingReason),
      blockingDetail: sanitizeGatewayRuntimeReasonDetail(options.blockingDetail),
      lastReconcileAt: startedAt,
      lastReconcileSummary:
        options.summary || `正在应用运行状态修订 ${nextRevision}，等待网关/Auth 链路确认消费。`,
      lastActions: options.actions ? [...options.actions] : store.runtime.lastActions,
    },
  })
}

export async function confirmRuntimeReconcile(params: {
  confirmed: boolean
  revision?: number
  confirmedAt?: string
  summary?: string
  blockingReason?: GatewayBlockingReason
  blockingDetail?: GatewayRuntimeReasonDetail | null
  safeToRetry?: boolean
  stateCode?: Exclude<RuntimeReconcileStateCode, 'idle' | 'pending' | 'in_progress'>
  actions?: ReconcileActionSummary[]
  appliedRevision?: number
  launcherMode?: GatewayLauncherMode | null
}): Promise<OpenClawRuntimeReconcileStore> {
  const confirmedAt = String(params.confirmedAt || new Date().toISOString())
  const store = await readOpenClawRuntimeReconcileStore()
  const revision = clampRevision(
    params.revision,
    Math.max(store.runtime.desiredRevision, store.runtime.appliedRevision)
  )
  const resolvedLauncherMode =
    params.launcherMode !== undefined
      ? sanitizeGatewayLauncherMode(params.launcherMode)
      : store.runtime.launcherMode

  if (params.confirmed) {
    const nextAppliedRevision = Math.max(
      store.runtime.appliedRevision,
      clampRevision(params.appliedRevision, revision)
    )
    const fullyApplied = nextAppliedRevision >= store.runtime.desiredRevision
    const readyState = fullyApplied ? 'ready' : 'degraded'
    const degradedReason =
      fullyApplied
        ? 'none'
        : sanitizeGatewayBlockingReason(params.blockingReason || store.runtime.blockingReason)
    const blockingDetail =
      fullyApplied
        ? null
        : sanitizeGatewayRuntimeReasonDetail(params.blockingDetail) || store.runtime.blockingDetail

    return saveStore({
      ...store,
      runtime: {
        ...store.runtime,
        stateCode: params.stateCode || readyState,
        appliedRevision: nextAppliedRevision,
        pendingReasons: fullyApplied ? [] : store.runtime.pendingReasons,
        blockingReason: params.stateCode === 'blocked' ? degradedReason : fullyApplied ? 'none' : degradedReason,
        blockingDetail,
        safeToRetry: typeof params.safeToRetry === 'boolean' ? params.safeToRetry : store.runtime.safeToRetry,
        lastReconcileAt: confirmedAt,
        lastReconcileSummary:
          params.summary ||
          (fullyApplied
            ? `运行状态修订 ${nextAppliedRevision} 已确认生效。`
            : `运行状态修订 ${nextAppliedRevision} 已部分生效，仍有待确认的变更。`),
        lastActions: params.actions ? [...params.actions] : store.runtime.lastActions,
        launcherMode: resolvedLauncherMode,
      },
    })
  }

  const blockingReason = sanitizeGatewayBlockingReason(params.blockingReason)
  const blockingDetail = sanitizeGatewayRuntimeReasonDetail(params.blockingDetail)
  const safeToRetry = typeof params.safeToRetry === 'boolean' ? params.safeToRetry : store.runtime.safeToRetry
  const stateCode = params.stateCode || resolveRuntimeReconcileStateCode(blockingReason, safeToRetry)

  return saveStore({
    ...store,
    runtime: {
      ...store.runtime,
      stateCode,
      blockingReason,
      blockingDetail,
      safeToRetry,
      lastReconcileAt: confirmedAt,
      lastReconcileSummary:
        params.summary || `运行状态修订 ${revision} 尚未确认完成，当前阻塞原因为 ${blockingReason}。`,
      lastActions: params.actions ? [...params.actions] : store.runtime.lastActions,
      launcherMode: resolvedLauncherMode,
    },
  })
}

export async function markRuntimeRevisionApplied(
  revision: number,
  options: {
    appliedAt?: string
    summary?: string
    blockingReason?: OpenClawRuntimeReconcileStore['runtime']['blockingReason']
    blockingDetail?: GatewayRuntimeReasonDetail | null
    safeToRetry?: boolean
    actions?: ReconcileActionSummary[]
  } = {}
): Promise<OpenClawRuntimeReconcileStore> {
  const appliedAt = String(options.appliedAt || new Date().toISOString())
  return confirmRuntimeReconcile({
    confirmed: true,
    revision,
    confirmedAt: appliedAt,
    summary: options.summary,
    blockingReason: options.blockingReason,
    blockingDetail: options.blockingDetail,
    safeToRetry: options.safeToRetry,
    actions: options.actions,
  })
}

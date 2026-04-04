import type { GatewayRuntimeReasonDetail } from './gateway-runtime-state'

export type OpenClawVersionBand =
  | 'unknown'
  | 'pre_2026_3_7'
  | 'openclaw_2026_3_7_to_2026_3_11'
  | 'openclaw_2026_3_12_to_2026_3_13'
  | 'openclaw_2026_3_14_to_2026_3_21'
  | 'openclaw_2026_3_22'
  | 'openclaw_2026_3_23_to_2026_3_24'
  | 'openclaw_2026_3_25_to_2026_3_28'
  | 'unknown_future'

export type UpgradeCompatibilityStatus =
  | 'not_evaluated'
  | 'first_observed'
  | 'steady_state'
  | 'upgrade_detected'
  | 'downgrade_detected'
  | 'unknown_current_version'
  | 'unknown_future_version'

export type GatewayBlockingReason =
  | 'none'
  | 'upgrade_incompatible_config'
  | 'machine_local_auth_missing'
  | 'runtime_token_stale'
  | 'provider_plugin_not_ready'
  | 'control_ui_handshake_failed'
  | 'service_generation_stale'
  | 'legacy_env_alias_detected'
  | 'unknown_future_version'
  | 'unknown_runtime_state'

export type RuntimeReconcileStateCode =
  | 'idle'
  | 'pending'
  | 'in_progress'
  | 'ready'
  | 'degraded'
  | 'blocked'

export type RuntimeMutationSource =
  | 'startup'
  | 'config'
  | 'env'
  | 'auth'
  | 'plugin-install'
  | 'gateway-bootstrap'
  | 'manual'

export interface ReconcileActionSummary {
  kind: 'probe' | 'repair' | 'migration'
  action: string
  outcome: 'scheduled' | 'succeeded' | 'skipped' | 'failed'
  detail?: string
  changedPaths?: string[]
}

export interface UpgradeCompatibilityAssessment {
  status: UpgradeCompatibilityStatus
  currentVersion: string | null
  currentBand: OpenClawVersionBand
  previousVersion: string | null
  previousBand: OpenClawVersionBand
  conservativeMode: boolean
  warningCodes: string[]
  summary: string
  assessedAt: string
}

export interface RuntimeReconcileState {
  stateCode: RuntimeReconcileStateCode
  desiredRevision: number
  appliedRevision: number
  pendingReasons: string[]
  lastMutationSource: RuntimeMutationSource | null
  blockingReason: GatewayBlockingReason
  blockingDetail: GatewayRuntimeReasonDetail | null
  safeToRetry: boolean
  lastReconcileAt: string | null
  lastReconcileSummary: string | null
  lastActions: ReconcileActionSummary[]
}

export interface OpenClawRuntimeReconcileStore {
  version: 1
  lastSeenOpenClawVersion: string | null
  lastSeenVersionBand: OpenClawVersionBand
  lastSeenAt: string | null
  lastCompatibility: UpgradeCompatibilityAssessment
  runtime: RuntimeReconcileState
}

export function createDefaultUpgradeCompatibilityAssessment(): UpgradeCompatibilityAssessment {
  return {
    status: 'not_evaluated',
    currentVersion: null,
    currentBand: 'unknown',
    previousVersion: null,
    previousBand: 'unknown',
    conservativeMode: false,
    warningCodes: [],
    summary: '尚未执行 OpenClaw 升级兼容评估。',
    assessedAt: new Date(0).toISOString(),
  }
}

export function createDefaultRuntimeReconcileState(): RuntimeReconcileState {
  return {
    stateCode: 'idle',
    desiredRevision: 0,
    appliedRevision: 0,
    pendingReasons: [],
    lastMutationSource: null,
    blockingReason: 'none',
    blockingDetail: null,
    safeToRetry: true,
    lastReconcileAt: null,
    lastReconcileSummary: null,
    lastActions: [],
  }
}

export function createDefaultOpenClawRuntimeReconcileStore(): OpenClawRuntimeReconcileStore {
  return {
    version: 1,
    lastSeenOpenClawVersion: null,
    lastSeenVersionBand: 'unknown',
    lastSeenAt: null,
    lastCompatibility: createDefaultUpgradeCompatibilityAssessment(),
    runtime: createDefaultRuntimeReconcileState(),
  }
}

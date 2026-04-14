import type { OpenClawInstallCandidate } from './openclaw-phase1'

export type OpenClawBackupType =
  | 'baseline-backup'
  | 'manual-backup'
  | 'config-snapshot'
  | 'cleanup-backup'
  | 'restore-preflight'
  | 'upgrade-preflight'
  | 'unknown'

export type OpenClawBackupStrategyId =
  | 'full-state'
  | 'config-only'
  | 'takeover-safeguard'
  | 'unknown'

export type OpenClawBackupHomeCaptureMode = 'none' | 'essential-state' | 'full-home'

export interface OpenClawBackupScopeAvailability {
  hasConfigData: boolean
  hasMemoryData: boolean
  hasEnvData: boolean
  hasCredentialsData: boolean
}

export interface OpenClawBackupEntry {
  backupId: string
  createdAt: string
  archivePath: string
  manifestPath: string
  type: OpenClawBackupType
  strategyId?: OpenClawBackupStrategyId
  homeCaptureMode?: OpenClawBackupHomeCaptureMode
  installFingerprint: string | null
  sourceVersion: string | null
  sourceConfigPath?: string | null
  sourceStateRoot?: string | null
  scopeAvailability: OpenClawBackupScopeAvailability
}

export interface OpenClawBackupRootInfo {
  rootDirectory: string
  displayRootDirectory: string
}

export interface OpenClawBackupListResult {
  rootDirectory: string
  preferredRootDirectory?: string
  fallbackRootDirectory?: string | null
  usedFallbackRoot?: boolean
  searchedRootDirectories?: string[]
  warnings?: string[]
  entries: OpenClawBackupEntry[]
}

export interface OpenClawManualBackupRunResult {
  ok: boolean
  backup: OpenClawBackupEntry | null
  message?: string
  errorCode?: 'no_active_install' | 'backup_failed'
}

export interface OpenClawDataCleanupRunRequest {
  targetPath: string
  backupBeforeDelete?: boolean
}

export interface OpenClawDataCleanupRunResult {
  ok: boolean
  deletedPath: string | null
  existedBefore: boolean
  backupCreated: OpenClawBackupEntry | null
  warnings: string[]
  message?: string
  errorCode?: 'invalid_target' | 'backup_failed' | 'delete_failed'
}

export interface OpenClawBackupDeleteResult {
  ok: boolean
  deletedBackupIds: string[]
  deletedCount: number
  warnings: string[]
  errors: string[]
  message?: string
  errorCode?: 'backup_not_found' | 'delete_failed'
}

export type OpenClawCleanupActionType =
  | 'remove-openclaw'
  | 'qclaw-uninstall-keep-openclaw'
  | 'qclaw-uninstall-remove-openclaw'

export interface OpenClawCleanupPreviewRequest {
  actionType: OpenClawCleanupActionType
  backupBeforeDelete: boolean
  selectedCandidateIds?: string[]
}

export interface OpenClawCleanupRunRequest extends OpenClawCleanupPreviewRequest {
  selectedCandidateIds?: string[]
}

export interface OpenClawCleanupPreviewResult {
  ok: boolean
  canRun: boolean
  actionType: OpenClawCleanupActionType
  activeCandidate: OpenClawInstallCandidate | null
  deleteItems: string[]
  keepItems: string[]
  backupItems: string[]
  warnings: string[]
  blockedReasons: string[]
  backupDirectory: string
  availableCandidates?: OpenClawInstallCandidate[]
  selectedCandidateIds?: string[]
  manualNextStep?: string
}

export type OpenClawCleanupCandidateFinalStatus = 'success' | 'partial' | 'failed' | 'skipped'

export interface OpenClawCleanupStepResult {
  attempted: boolean
  ok: boolean
  message?: string
  command?: string
  errors?: string[]
}

export interface OpenClawCleanupVerificationResult {
  checked: boolean
  stateRemoved: boolean
  programRemoved: boolean
  commandAvailable: boolean
  commandResolvedBinaryPath: string | null
  commandPointsToTarget: boolean | null
  remainingPaths: string[]
  notes: string[]
}

export interface OpenClawCleanupCandidateResult {
  candidateId: string
  installSource?: string
  displayStateRoot?: string
  binaryPath?: string
  finalStatus: OpenClawCleanupCandidateFinalStatus
  stateCleanup?: OpenClawCleanupStepResult
  programUninstall?: OpenClawCleanupStepResult
  verification?: OpenClawCleanupVerificationResult
  message?: string
  warnings: string[]
  errors: string[]
}

export interface OpenClawCleanupSummary {
  total: number
  success: number
  partial: number
  failed: number
  skipped: number
}

export interface OpenClawCleanupRunResult {
  ok: boolean
  blocked: boolean
  actionType: OpenClawCleanupActionType
  backupCreated: OpenClawBackupEntry | null
  warnings: string[]
  errors: string[]
  summary?: OpenClawCleanupSummary
  perCandidateResults?: OpenClawCleanupCandidateResult[]
  message?: string
  manualNextStep?: string
}

export type OpenClawRestoreScope = 'config' | 'memory' | 'all'

export interface OpenClawRestorePreviewResult {
  ok: boolean
  backup: OpenClawBackupEntry | null
  availableScopes: OpenClawRestoreScope[]
  restoreItems: string[]
  warnings: string[]
  blockedReasons: string[]
}

export interface OpenClawRestoreRunResult {
  ok: boolean
  backup: OpenClawBackupEntry | null
  scope: OpenClawRestoreScope
  preflightSnapshot: OpenClawBackupEntry | null
  restoredItems: string[]
  warnings: string[]
  message?: string
  errorCode?: 'backup_not_found' | 'scope_unavailable' | 'preflight_failed' | 'restore_failed' | 'runtime_apply_failed'
  gatewayApply?: {
    ok: boolean
    requestedAction: 'none' | 'hot-reload' | 'restart'
    appliedAction: 'none' | 'hot-reload' | 'restart'
    note?: string
  }
}

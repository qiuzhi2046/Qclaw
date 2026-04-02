import type { OpenClawBaselineBackupRecord, OpenClawInstallCandidate } from './openclaw-phase1'

export type OpenClawManagedFileKind = 'config' | 'env' | 'credentials' | 'backup-manifest'

export interface OpenClawManagedFileRecord {
  filePath: string
  kind: OpenClawManagedFileKind
  source: 'qclaw-lite'
  firstManagedAt: string
  lastManagedAt: string
}

export interface OpenClawJsonPathOwnershipRecord {
  filePath: string
  jsonPath: string
  source: 'qclaw-lite'
  firstManagedAt: string
  lastManagedAt: string
}

export type OpenClawShellManagedBlockType = 'openclaw-shell-init'

export interface OpenClawShellManagedBlockRecord {
  filePath: string
  blockId: string
  blockType: OpenClawShellManagedBlockType
  startMarker: string
  endMarker: string
  source: 'qclaw-lite'
  firstManagedAt: string
  lastManagedAt: string
}

export interface OpenClawConfigSnapshotRecord {
  snapshotId: string
  createdAt: string
  archivePath: string
  installFingerprint: string
  snapshotType: 'config-snapshot'
}

export interface OpenClawOwnershipCandidateSnapshot {
  candidateId: string
  version: string
  binaryPath: string
  resolvedBinaryPath: string
  packageRoot: string
  installSource: string
  configPath: string
  stateRoot: string
}

export interface OpenClawOwnershipEntry {
  installFingerprint: string
  createdAt: string
  updatedAt: string
  candidate: OpenClawOwnershipCandidateSnapshot
  firstManagedWriteSnapshot: OpenClawConfigSnapshotRecord | null
  files: OpenClawManagedFileRecord[]
  jsonPaths: OpenClawJsonPathOwnershipRecord[]
  shellBlocks: OpenClawShellManagedBlockRecord[]
}

export interface OpenClawOwnershipStore {
  version: 1
  installs: OpenClawOwnershipEntry[]
}

export interface OpenClawOwnershipSummary {
  fileCount: number
  jsonPathCount: number
  shellBlockCount: number
  managedFiles: string[]
  managedJsonPaths: string[]
  managedShellBlockFiles: string[]
  firstManagedWriteSnapshot: OpenClawConfigSnapshotRecord | null
  updatedAt: string
}

export interface OpenClawOwnershipChangeList {
  installFingerprint: string
  filePaths: string[]
  jsonPaths: string[]
  shellBlockFiles: string[]
  updatedAt: string
}

export interface OpenClawDataGuardSummary {
  ok: boolean
  activeCandidate: OpenClawInstallCandidate | null
  baselineBackup: OpenClawBaselineBackupRecord | null
  backupDirectory: string
  firstManagedWriteSnapshot: OpenClawConfigSnapshotRecord | null
  ownershipSummary: OpenClawOwnershipSummary | null
  managedScopes: string[]
  untouchedScopes: string[]
  warnings: string[]
  message?: string
}

export type OpenClawGuardedWriteReason =
  | 'channel-connect-sanitize'
  | 'channel-connect-onboard-prepare'
  | 'channel-connect-configure'
  | 'channels-remove-channel'
  | 'dashboard-remove-linked-model'
  | 'dashboard-add-feishu-bot'
  | 'dashboard-delete-feishu-bot'
  | 'managed-channel-plugin-repair'
  | 'pairing-allowfrom-sync'
  | 'gateway-port-recovery'
  | 'knowledge-base-sync'
  | 'unknown'

export interface OpenClawGuardPrepareResult {
  ok: boolean
  blocked: boolean
  prepared: boolean
  snapshotCreated: boolean
  snapshot: OpenClawConfigSnapshotRecord | null
  ownershipSummary: OpenClawOwnershipSummary | null
  message?: string
  errorCode?: 'no_active_install' | 'baseline_backup_required' | 'snapshot_failed'
}

export interface OpenClawGuardedConfigWriteRequest {
  config: Record<string, any>
  reason?: OpenClawGuardedWriteReason
}

export interface OpenClawConfigPatchWriteRequest {
  beforeConfig: Record<string, any> | null
  afterConfig: Record<string, any>
  reason?: OpenClawGuardedWriteReason
}

export interface OpenClawGuardedEnvWriteRequest {
  updates: Record<string, string>
  reason?: OpenClawGuardedWriteReason
}

export interface OpenClawGuardedWriteResult {
  ok: boolean
  blocked: boolean
  wrote: boolean
  target: 'config' | 'env'
  snapshotCreated: boolean
  snapshot: OpenClawConfigSnapshotRecord | null
  changedJsonPaths: string[]
  ownershipSummary: OpenClawOwnershipSummary | null
  message?: string
  errorCode?: 'no_active_install' | 'baseline_backup_required' | 'snapshot_failed' | 'write_failed'
  gatewayApply?: {
    ok: boolean
    requestedAction: 'none' | 'hot-reload' | 'restart'
    appliedAction: 'none' | 'hot-reload' | 'restart'
    note?: string
  }
}

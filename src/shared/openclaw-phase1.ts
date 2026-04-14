export interface WindowsSelectedRuntimeView {
  readonly hostPackageRoot: string
  readonly nodePath: string
  readonly openclawPath: string
  readonly stateDir: string
}

export interface WindowsGatewayOwnerSnapshotView {
  readonly ownerKind: string
  readonly ownerLauncherPath: string
  readonly ownerTaskName: string
}

export interface WindowsManagedPluginSnapshotView {
  readonly allowedInConfig: boolean
  readonly configured: boolean
  readonly installedOnDisk: boolean
  readonly loaded: boolean
  readonly ready: boolean
  readonly registered: boolean
}

export interface WindowsResolvedChannelBindingView {
  readonly accountId: string
  readonly agentId: string
  readonly channelId: string
  readonly source: string
}

export interface WindowsChannelRuntimeSnapshotView extends WindowsSelectedRuntimeView {
  readonly gatewayOwner: WindowsGatewayOwnerSnapshotView
  readonly managedPlugin: WindowsManagedPluginSnapshotView
  readonly resolvedBinding: WindowsResolvedChannelBindingView
}

export type OpenClawInstallSource =
  | 'qclaw-bundled'
  | 'qclaw-managed'
  | 'npm-global'
  | 'homebrew'
  | 'nvm'
  | 'fnm'
  | 'asdf'
  | 'mise'
  | 'volta'
  | 'custom'
  | 'unknown'

export type OpenClawOwnershipState =
  | 'external-preexisting'
  | 'qclaw-installed'
  | 'mixed-managed'
  | 'unknown-external'

export interface OpenClawBaselineBackupRecord {
  backupId: string
  createdAt: string
  archivePath: string
  installFingerprint: string
}

export interface OpenClawBaselineBackupManualAction {
  sourcePath: string
  displaySourcePath: string
  suggestedArchivePath: string
  displaySuggestedArchivePath: string
}

export interface OpenClawBaselineBackupBypassRecord
  extends OpenClawBaselineBackupManualAction {
  installFingerprint: string
  skippedAt: string
  reason: 'manual-backup-required'
}

export interface OpenClawInstallCandidate {
  candidateId: string
  binaryPath: string
  resolvedBinaryPath: string
  packageRoot: string
  version: string
  installSource: OpenClawInstallSource
  isPathActive: boolean
  configPath: string
  stateRoot: string
  displayConfigPath: string
  displayStateRoot: string
  ownershipState: OpenClawOwnershipState
  installFingerprint: string
  baselineBackup: OpenClawBaselineBackupRecord | null
  baselineBackupBypass: OpenClawBaselineBackupBypassRecord | null
}

export interface OpenClawHistoryDataCandidate {
  path: string
  displayPath: string
  reason: 'default-home-dir' | 'runtime-state-root'
}

export type WindowsGatewayOwnerState =
  | 'healthy'
  | 'service-missing'
  | 'launcher-missing'
  | 'unknown'

export interface OpenClawDiscoveryResult {
  status: 'installed' | 'history-only' | 'absent'
  candidates: OpenClawInstallCandidate[]
  activeCandidateId: string | null
  hasMultipleCandidates: boolean
  historyDataCandidates: OpenClawHistoryDataCandidate[]
  errors: string[]
  warnings: string[]
  defaultBackupDirectory: string
  windowsGatewayOwnerState?: WindowsGatewayOwnerState | null
}

export interface OpenClawLatestVersionCheckResult {
  ok: boolean
  latestVersion: string
  checkedAt: string
  source: 'npm-registry'
  error?: string
}

export type OpenClawVersionStatus =
  | 'absent'
  | 'equal'
  | 'outdated'
  | 'newer'
  | 'latest-unknown'
  | 'unknown'

export interface OpenClawClassificationResult {
  versionStatus: OpenClawVersionStatus
  activeCandidate: OpenClawInstallCandidate | null
  latestVersion: string | null
  canContinue: boolean
  canUpgradeInPlace: boolean
  warnings: string[]
}

export interface OpenClawBaselineBackupEnsureResult {
  ok: boolean
  created: boolean
  backup: OpenClawBaselineBackupRecord | null
  errorCode?: 'backup_failed' | 'invalid_candidate' | 'not_required'
  message?: string
  manualBackupAction?: OpenClawBaselineBackupManualAction
}

export interface OpenClawBaselineBackupSkipResult {
  ok: boolean
  bypass: OpenClawBaselineBackupBypassRecord | null
  errorCode?: 'invalid_candidate' | 'not_required' | 'skip_failed'
  message?: string
}

export interface EnvCheckReadyPayload {
  hadOpenClawInstalled: boolean
  installedOpenClawDuringCheck: boolean
  gatewayRunning: boolean
  sharedConfigInitialized: boolean
  discoveryResult?: OpenClawDiscoveryResult | null
}

export interface OpenClawInstallDecision {
  machineStatus: OpenClawDiscoveryResult['status']
  hadOpenClawInstalled: boolean
  shouldFreshInstall: boolean
  requiresRecovery: boolean
}

function hasMeaningfulConfigValue(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => hasMeaningfulConfigValue(item))
  }

  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some((item) => hasMeaningfulConfigValue(item))
  }

  if (typeof value === 'string') {
    return value.trim().length > 0
  }

  return typeof value === 'number' || typeof value === 'boolean'
}

export function hasInitializedOpenClawConfig(
  configData: Record<string, any> | null | undefined
): boolean {
  if (!configData || typeof configData !== 'object') return false
  return Object.values(configData).some((value) => hasMeaningfulConfigValue(value))
}

export function shouldRouteToSetupAfterPhase1(
  envSummary: EnvCheckReadyPayload | null | undefined
): boolean {
  if (!envSummary) return false
  return !envSummary.sharedConfigInitialized
}

export function resolveOpenClawInstallDecision(input: {
  discovery: OpenClawDiscoveryResult | null | undefined
  cliInstalled: boolean
}): OpenClawInstallDecision {
  const machineStatus: OpenClawDiscoveryResult['status'] =
    input.discovery?.status || (input.cliInstalled ? 'installed' : 'absent')

  return {
    machineStatus,
    hadOpenClawInstalled: machineStatus === 'installed',
    shouldFreshInstall: machineStatus === 'absent',
    requiresRecovery: machineStatus === 'history-only',
  }
}

function normalizeVersionPart(raw: string): number | null {
  const trimmed = String(raw || '').trim()
  if (!trimmed) return null
  if (!/^\d+$/.test(trimmed)) return null
  return Number.parseInt(trimmed, 10)
}

export function normalizeVersionCore(value: string | null | undefined): string {
  const trimmed = String(value || '').trim()
  if (trimmed.startsWith('OpenClaw')) {
    return trimmed.match(/\d{4}\.\d+\.\d+/)?.[0] || trimmed
  }
  return trimmed
    .replace(/^v/i, '')
    .split('-')[0]
    .trim()
}

export function compareLooseVersions(left: string, right: string): number {
  const normalizedLeft = normalizeVersionCore(left)
  const normalizedRight = normalizeVersionCore(right)
  const leftParts = normalizedLeft.split('.')
  const rightParts = normalizedRight.split('.')

  const maxLength = Math.max(leftParts.length, rightParts.length)
  for (let index = 0; index < maxLength; index += 1) {
    const leftPart = normalizeVersionPart(leftParts[index] || '0')
    const rightPart = normalizeVersionPart(rightParts[index] || '0')

    if (leftPart === null || rightPart === null) {
      return normalizedLeft.localeCompare(normalizedRight)
    }

    if (leftPart > rightPart) return 1
    if (leftPart < rightPart) return -1
  }

  return 0
}

export function isQclawOwnedOpenClawSource(
  source: OpenClawInstallSource | null | undefined
): boolean {
  return source === 'qclaw-bundled' || source === 'qclaw-managed'
}

export function supportsQclawAutoRepair(
  source: OpenClawInstallSource | null | undefined
): boolean {
  return isQclawOwnedOpenClawSource(source)
}

export function requiresManualUserIntervention(
  source: OpenClawInstallSource | null | undefined
): boolean {
  if (!source) return true
  return source === 'custom' || source === 'unknown'
}

export function isUpgradeableInstallSource(source: OpenClawInstallSource): boolean {
  return !requiresManualUserIntervention(source)
}

export function shouldEnsureBaselineBackup(
  candidate: OpenClawInstallCandidate | null | undefined
): boolean {
  if (!candidate) return false
  if (candidate.baselineBackup) return false
  if (candidate.baselineBackupBypass) return false
  return (
    candidate.ownershipState === 'external-preexisting' ||
    candidate.ownershipState === 'unknown-external'
  )
}

export function canSkipFailedBaselineBackup(
  result: OpenClawBaselineBackupEnsureResult | null | undefined
): boolean {
  return Boolean(
    result &&
      !result.ok &&
      result.errorCode === 'backup_failed' &&
      result.manualBackupAction
  )
}

export function buildManualBackupWarning(
  action:
    | OpenClawBaselineBackupManualAction
    | OpenClawBaselineBackupBypassRecord
    | null
    | undefined
): string {
  if (!action) return '自动备份失败，请手动备份。'
  const sourcePath = String(action.displaySourcePath || action.sourcePath || '').trim()
  const targetPath = String(action.displaySuggestedArchivePath || action.suggestedArchivePath || '').trim()
  if (!sourcePath || !targetPath) return '自动备份失败，请手动备份。'
  return `自动备份失败，请手动备份。请将 ${sourcePath} 复制到 ${targetPath}。`
}

function appendUniqueWarning(warnings: string[], warning: string): string[] {
  return warnings.includes(warning) ? warnings : [warning, ...warnings]
}

export function applyBaselineBackupRecordToDiscovery(
  discovery: OpenClawDiscoveryResult | null | undefined,
  backup: OpenClawBaselineBackupRecord | null | undefined
): OpenClawDiscoveryResult | null {
  if (!discovery || !backup || !discovery.activeCandidateId) return discovery || null
  return {
    ...discovery,
    candidates: discovery.candidates.map((candidate) =>
      candidate.candidateId === discovery.activeCandidateId
        ? { ...candidate, baselineBackup: backup, baselineBackupBypass: null }
        : candidate
    ),
  }
}

export function applyBaselineBackupBypassToDiscovery(
  discovery: OpenClawDiscoveryResult | null | undefined,
  bypass: OpenClawBaselineBackupBypassRecord | null | undefined
): OpenClawDiscoveryResult | null {
  if (!discovery || !bypass || !discovery.activeCandidateId) return discovery || null
  const warning = buildManualBackupWarning(bypass)
  return {
    ...discovery,
    candidates: discovery.candidates.map((candidate) =>
      candidate.candidateId === discovery.activeCandidateId
        ? { ...candidate, baselineBackup: null, baselineBackupBypass: bypass }
        : candidate
    ),
    warnings: appendUniqueWarning(discovery.warnings, warning),
  }
}

export function classifyOpenClawPhase1(
  discovery: OpenClawDiscoveryResult,
  latestCheck: OpenClawLatestVersionCheckResult | null
): OpenClawClassificationResult {
  const activeCandidate =
    discovery.candidates.find((candidate) => candidate.candidateId === discovery.activeCandidateId) || null

  if (!activeCandidate) {
    return {
      versionStatus: 'absent',
      activeCandidate: null,
      latestVersion: latestCheck?.ok ? latestCheck.latestVersion : null,
      canContinue: true,
      canUpgradeInPlace: false,
      warnings: [...discovery.warnings],
    }
  }

  if (!latestCheck || !latestCheck.ok || !latestCheck.latestVersion) {
    return {
      versionStatus: 'latest-unknown',
      activeCandidate,
      latestVersion: null,
      canContinue: true,
      canUpgradeInPlace: false,
      warnings: [
        ...discovery.warnings,
        latestCheck?.error ? '最新版本检查失败，可以先继续使用，稍后再重试。' : '最新版本暂时不可判断。',
      ],
    }
  }

  const compared = compareLooseVersions(activeCandidate.version, latestCheck.latestVersion)
  const versionStatus: OpenClawVersionStatus =
    compared === 0 ? 'equal' : compared < 0 ? 'outdated' : 'newer'

  return {
    versionStatus,
    activeCandidate,
    latestVersion: latestCheck.latestVersion,
    canContinue: true,
    canUpgradeInPlace: versionStatus === 'outdated' && isUpgradeableInstallSource(activeCandidate.installSource),
    warnings: [...discovery.warnings],
  }
}

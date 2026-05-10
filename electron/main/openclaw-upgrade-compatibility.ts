import type {
  GatewayBlockingReason,
  OpenClawVersionBand,
  UpgradeCompatibilityAssessment,
  UpgradeCompatibilityStatus,
} from '../../src/shared/gateway-runtime-reconcile-state'

interface ParsedOpenClawVersion {
  major: number
  minor: number
  patch: number
}

function parseOpenClawVersion(version: string | null | undefined): ParsedOpenClawVersion | null {
  const normalized = String(version || '').trim()
  if (!normalized) return null

  const match = normalized.match(/v?(\d+)\.(\d+)\.(\d+)/i)
  if (!match) return null

  const major = Number.parseInt(match[1], 10)
  const minor = Number.parseInt(match[2], 10)
  const patch = Number.parseInt(match[3], 10)
  if (![major, minor, patch].every(Number.isFinite)) return null

  return { major, minor, patch }
}

export function normalizeOpenClawVersion(version: string | null | undefined): string | null {
  const parsed = parseOpenClawVersion(version)
  if (!parsed) return null
  return `${parsed.major}.${parsed.minor}.${parsed.patch}`
}

export function compareOpenClawVersions(
  left: string | null | undefined,
  right: string | null | undefined
): number {
  const parsedLeft = parseOpenClawVersion(left)
  const parsedRight = parseOpenClawVersion(right)

  if (!parsedLeft && !parsedRight) return 0
  if (!parsedLeft) return -1
  if (!parsedRight) return 1

  if (parsedLeft.major !== parsedRight.major) return parsedLeft.major - parsedRight.major
  if (parsedLeft.minor !== parsedRight.minor) return parsedLeft.minor - parsedRight.minor
  return parsedLeft.patch - parsedRight.patch
}

export function detectOpenClawVersionBand(version: string | null | undefined): OpenClawVersionBand {
  const normalized = normalizeOpenClawVersion(version)
  if (!normalized) return 'unknown'

  if (compareOpenClawVersions(normalized, '2026.3.7') < 0) return 'pre_2026_3_7'
  if (compareOpenClawVersions(normalized, '2026.3.11') <= 0) return 'openclaw_2026_3_7_to_2026_3_11'
  if (compareOpenClawVersions(normalized, '2026.3.13') <= 0) return 'openclaw_2026_3_12_to_2026_3_13'
  if (compareOpenClawVersions(normalized, '2026.3.21') <= 0) return 'openclaw_2026_3_14_to_2026_3_21'
  if (compareOpenClawVersions(normalized, '2026.3.22') === 0) return 'openclaw_2026_3_22'
  if (compareOpenClawVersions(normalized, '2026.3.28') <= 0) return 'openclaw_2026_3_23_to_2026_3_28'
  return 'unknown_future'
}

function resolveCompatibilityStatus(
  currentVersion: string | null,
  previousVersion: string | null,
  currentBand: OpenClawVersionBand
): UpgradeCompatibilityStatus {
  if (!currentVersion) return 'unknown_current_version'
  if (currentBand === 'unknown_future') return 'unknown_future_version'
  if (!previousVersion) return 'first_observed'

  const comparison = compareOpenClawVersions(currentVersion, previousVersion)
  if (comparison > 0) return 'upgrade_detected'
  if (comparison < 0) return 'downgrade_detected'
  return 'steady_state'
}

function buildWarningCodes(
  currentVersion: string | null,
  previousVersion: string | null,
  status: UpgradeCompatibilityStatus,
  currentBand: OpenClawVersionBand
): string[] {
  const warnings: string[] = []
  if (!currentVersion) return ['version_unparseable']
  if (currentBand === 'unknown_future') return ['version_unknown_future']

  if (currentBand === 'openclaw_2026_3_22') {
    if (status === 'upgrade_detected' || status === 'downgrade_detected') {
      warnings.push('runtime_reconcile_required')
    }

    if (previousVersion && compareOpenClawVersions(previousVersion, '2026.3.22') < 0) {
      warnings.push(
        'legacy_env_alias_removed_in_2026_3_22',
        'bundled_plugin_runtime_changed_in_2026_3_22',
        'clawhub_resolution_changed_in_2026_3_22',
        'official_doctor_fix_migration_prioritized_in_2026_3_22'
      )
    }
  }

  if (currentBand === 'openclaw_2026_3_23_to_2026_3_28') {
    if (status === 'upgrade_detected' || status === 'downgrade_detected') {
      warnings.push('runtime_reconcile_required', 'official_doctor_fix_migration_prioritized_in_2026_3_28_pin_window')
    }
  }

  return warnings
}

function build2026_3_22CompatibilitySuffix(warningCodes: string[]): string {
  if (warningCodes.length === 0) return ''

  const details: string[] = []
  if (warningCodes.includes('runtime_reconcile_required')) {
    details.push('需要重新确认网关/Auth 运行状态是否已消费最新配置')
  }
  if (warningCodes.includes('legacy_env_alias_removed_in_2026_3_22')) {
    details.push('3.22 已移除 legacy env alias，不能把 alias 漂移误判成单一 gateway 故障')
  }
  if (warningCodes.includes('bundled_plugin_runtime_changed_in_2026_3_22')) {
    details.push('provider/skill discovery 已继续向 bundled plugin 收敛')
  }
  if (warningCodes.includes('clawhub_resolution_changed_in_2026_3_22')) {
    details.push('裸 plugins install 已改为先 ClawHub 再 npm 的解析顺序')
  }
  if (warningCodes.includes('official_doctor_fix_migration_prioritized_in_2026_3_22')) {
    details.push('3.22 的浏览器旧配置迁移应优先复用官方 doctor --fix 路径')
  }

  return details.length > 0 ? ` ${details.join('；')}。` : ''
}

function build2026_3_28CompatibilitySuffix(warningCodes: string[]): string {
  if (warningCodes.length === 0) return ''

  const details: string[] = []
  if (warningCodes.includes('runtime_reconcile_required')) {
    details.push('需要重新确认网关/Auth 运行状态是否已消费当前 pinned 版本的配置')
  }
  if (warningCodes.includes('official_doctor_fix_migration_prioritized_in_2026_3_28_pin_window')) {
    details.push('回退到 3.28 时应优先复用官方 doctor --fix 迁移路径')
  }

  return details.length > 0 ? ` ${details.join('；')}。` : ''
}

function buildSummary(
  status: UpgradeCompatibilityStatus,
  currentVersion: string | null,
  previousVersion: string | null,
  currentBand: OpenClawVersionBand,
  warningCodes: string[]
): string {
  const suffix =
    currentBand === 'openclaw_2026_3_22'
      ? build2026_3_22CompatibilitySuffix(warningCodes)
      : currentBand === 'openclaw_2026_3_23_to_2026_3_28'
        ? build2026_3_28CompatibilitySuffix(warningCodes)
        : ''
  switch (status) {
    case 'first_observed':
      return `首次记录到 OpenClaw 版本 ${currentVersion}，当前版本段为 ${currentBand}。${suffix}`.trim()
    case 'upgrade_detected':
      return `检测到 OpenClaw 从 ${previousVersion} 升级到 ${currentVersion}。${suffix}`.trim()
    case 'downgrade_detected':
      return `检测到 OpenClaw 从 ${previousVersion} 回退到 ${currentVersion}。${suffix}`.trim()
    case 'steady_state':
      return `OpenClaw 版本维持在 ${currentVersion}，当前版本段为 ${currentBand}。${suffix}`.trim()
    case 'unknown_future_version':
      return `OpenClaw 版本 ${currentVersion} 超出当前审计范围，应进入保守兼容模式。`
    case 'unknown_current_version':
      return '当前 OpenClaw 版本无法可靠解析，应进入保守兼容模式。'
    default:
      return 'OpenClaw 兼容状态尚未评估。'
  }
}

export function assessOpenClawUpgradeCompatibility(params: {
  currentVersion: string | null | undefined
  previousVersion?: string | null | undefined
  assessedAt?: string
}): UpgradeCompatibilityAssessment {
  const currentVersion = normalizeOpenClawVersion(params.currentVersion)
  const previousVersion = normalizeOpenClawVersion(params.previousVersion)
  const currentBand = detectOpenClawVersionBand(currentVersion)
  const previousBand = detectOpenClawVersionBand(previousVersion)
  const status = resolveCompatibilityStatus(currentVersion, previousVersion, currentBand)
  const warningCodes = buildWarningCodes(currentVersion, previousVersion, status, currentBand)
  const assessedAt = String(params.assessedAt || new Date().toISOString())

  return {
    status,
    currentVersion,
    currentBand,
    previousVersion,
    previousBand,
    conservativeMode: status === 'unknown_current_version' || status === 'unknown_future_version',
    warningCodes,
    summary: buildSummary(status, currentVersion, previousVersion, currentBand, warningCodes),
    assessedAt,
  }
}

export function inferCompatibilityBlockingReason(
  assessment: Pick<UpgradeCompatibilityAssessment, 'conservativeMode' | 'warningCodes'>
): GatewayBlockingReason | null {
  if (assessment.conservativeMode) {
    return 'unknown_future_version'
  }

  return null
}

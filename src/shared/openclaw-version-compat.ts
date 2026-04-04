/**
 * OpenClaw 版本兼容性层
 * 
 * 提供新版本适配器与现有代码的兼容接口
 * 支持渐进式迁移，新旧系统可以共存
 */

import {
  type VersionAdapter,
  type VersionAdapterStatus,
  type VersionCapability,
  createVersionAdapter,
  createVersionAdapterWithProbe,
} from './openclaw-version-adapter'

// ==================== 兼容类型定义 ====================

/**
 * 兼容旧系统的版本策略状态
 */
export type LegacyVersionPolicyState =
  | 'below_min'
  | 'supported_not_target'
  | 'supported_target'
  | 'above_max'

/**
 * 兼容旧系统的版本执行策略
 */
export type LegacyVersionEnforcement =
  | 'none'
  | 'optional_upgrade'
  | 'auto_correct'
  | 'manual_block'

/**
 * 兼容旧系统的版本band
 */
export type LegacyVersionBand =
  | 'unknown'
  | 'pre_2026_3_7'
  | 'openclaw_2026_3_7_to_2026_3_11'
  | 'openclaw_2026_3_12_to_2026_3_13'
  | 'openclaw_2026_3_14_to_2026_3_21'
  | 'openclaw_2026_3_22'
  | 'openclaw_2026_3_23_to_2026_3_24'
  | 'unknown_future'

// ==================== 兼容接口 ====================

/**
 * 版本兼容性结果
 */
export interface VersionCompatResult {
  /** 版本号 */
  version: string | null
  /** 适配器状态 */
  adapterStatus: VersionAdapterStatus
  /** 是否进入保守模式 */
  conservativeMode: boolean
  /** 警告代码 */
  warningCodes: string[]
  /** 摘要信息 */
  summary: string
  /** 兼容的旧版band */
  legacyBand: LegacyVersionBand
  /** 兼容的旧版策略状态 */
  legacyPolicyState: LegacyVersionPolicyState
  /** 兼容的旧版执行策略 */
  legacyEnforcement: LegacyVersionEnforcement
  /** 功能支持情况 */
  capabilities: VersionCapability[]
}

// ==================== 版本解析工具 ====================

function parseVersionCore(version: string | null | undefined): string {
  return String(version || '').trim().replace(/^v/i, '').split('-')[0].trim()
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split('.').map(Number)
  const rightParts = right.split('.').map(Number)
  
  for (let i = 0; i < 3; i++) {
    const l = leftParts[i] || 0
    const r = rightParts[i] || 0
    if (l !== r) return l - r
  }
  return 0
}

// ==================== 版本band检测（兼容旧版） ====================

function detectLegacyVersionBand(version: string | null | undefined): LegacyVersionBand {
  const normalized = parseVersionCore(version)
  if (!normalized) return 'unknown'

  if (compareVersions(normalized, '2026.3.7') < 0) return 'pre_2026_3_7'
  if (compareVersions(normalized, '2026.3.11') <= 0) return 'openclaw_2026_3_7_to_2026_3_11'
  if (compareVersions(normalized, '2026.3.13') <= 0) return 'openclaw_2026_3_12_to_2026_3_13'
  if (compareVersions(normalized, '2026.3.21') <= 0) return 'openclaw_2026_3_14_to_2026_3_21'
  if (compareVersions(normalized, '2026.3.22') === 0) return 'openclaw_2026_3_22'
  if (compareVersions(normalized, '2026.3.24') <= 0) return 'openclaw_2026_3_23_to_2026_3_24'
  
  // 新版本：不再是unknown_future，而是根据实际能力判断
  return 'unknown_future'
}

// ==================== 版本策略状态检测（兼容旧版） ====================

function detectLegacyPolicyState(version: string | null | undefined): LegacyVersionPolicyState {
  const normalized = parseVersionCore(version)
  if (!normalized) return 'above_max'

  // 新策略：只要版本 >= 2026.3.22 就认为是支持的
  if (compareVersions(normalized, '2026.3.22') < 0) {
    return 'below_min'
  }

  // 检查是否是目标版本
  if (normalized === '2026.3.24') {
    return 'supported_target'
  }

  return 'supported_not_target'
}

// ==================== 版本执行策略检测（兼容旧版） ====================

function detectLegacyEnforcement(
  policyState: LegacyVersionPolicyState,
  canCorrect: boolean
): LegacyVersionEnforcement {
  switch (policyState) {
    case 'supported_target':
      return 'none'
    case 'supported_not_target':
      return canCorrect ? 'optional_upgrade' : 'manual_block'
    case 'below_min':
      return canCorrect ? 'auto_correct' : 'manual_block'
    case 'above_max':
    default:
      // 新策略：对于高于最大版本的情况，不再强制阻止
      return canCorrect ? 'optional_upgrade' : 'none'
  }
}

// ==================== 主要导出函数 ====================

/**
 * 评估版本兼容性（新版本适配器）
 */
export function assessVersionCompatibility(
  version: string | null | undefined,
  adapter: VersionAdapter | null
): VersionCompatResult {
  const normalizedVersion = parseVersionCore(version)
  
  // 获取适配器状态
  const adapterStatus = adapter?.getStatus() ?? 'experimental'
  
  // 判断是否进入保守模式
  // 新策略：只有在适配器明确标记为unsupported时才进入保守模式
  const conservativeMode = adapterStatus === 'unsupported'
  
  // 获取警告代码
  const warningCodes: string[] = []
  if (adapterStatus === 'experimental') {
    warningCodes.push('version_experimental')
  }
  if (adapterStatus === 'degraded') {
    warningCodes.push('version_degraded')
  }
  
  // 获取功能支持情况
  const capabilities = adapter?.getCapabilities() ?? []
  
  // 构建摘要
  const summary = buildCompatibilitySummary(
    normalizedVersion,
    adapterStatus,
    conservativeMode,
    capabilities
  )
  
  // 兼容旧版接口
  const legacyBand = detectLegacyVersionBand(normalizedVersion)
  const legacyPolicyState = detectLegacyPolicyState(normalizedVersion)
  const legacyEnforcement = detectLegacyEnforcement(legacyPolicyState, true)
  
  return {
    version: normalizedVersion,
    adapterStatus,
    conservativeMode,
    warningCodes,
    summary,
    legacyBand,
    legacyPolicyState,
    legacyEnforcement,
    capabilities,
  }
}

/**
 * 构建兼容性摘要
 */
function buildCompatibilitySummary(
  version: string | null,
  adapterStatus: VersionAdapterStatus,
  conservativeMode: boolean,
  capabilities: VersionCapability[]
): string {
  if (!version) {
    return 'OpenClaw 版本无法解析。'
  }

  const statusText = {
    supported: '完全支持',
    degraded: '降级支持',
    experimental: '实验性支持',
    unsupported: '不支持',
  }[adapterStatus]

  const supportedCount = capabilities.filter(c => c.supported).length
  const totalCount = capabilities.length

  if (conservativeMode) {
    return `OpenClaw ${version} 未通过兼容性检查（${statusText}），已进入保守模式。`
  }

  if (adapterStatus === 'experimental') {
    return `OpenClaw ${version} 为新版本，Qclaw 将尝试适配（${supportedCount}/${totalCount} 功能已确认支持）。`
  }

  if (adapterStatus === 'degraded') {
    const degradedCapabilities = capabilities
      .filter(c => c.level === 'partial' || !c.supported)
      .map(c => c.name)
      .join('、')
    return `OpenClaw ${version} 部分功能受限（${statusText}）：${degradedCapabilities}。`
  }

  return `OpenClaw ${version} 已确认兼容（${statusText}）。`
}

/**
 * 创建版本适配器并评估兼容性（异步）
 */
export async function assessVersionCompatibilityWithProbe(
  runCommand: (args: string[]) => Promise<{ ok: boolean; stdout: string; stderr: string }>
): Promise<VersionCompatResult> {
  const adapter = await createVersionAdapterWithProbe(runCommand)
  return assessVersionCompatibility(adapter.getVersion(), adapter)
}

/**
 * 检查功能是否支持（带降级提示）
 */
export function checkCapabilityWithHint(
  adapter: VersionAdapter | null,
  capabilityId: string
): { supported: boolean; hint: string | null } {
  if (!adapter) {
    return { supported: true, hint: '版本适配器未初始化' }
  }

  const supported = adapter.isCapabilitySupported(capabilityId)
  const hint = adapter.getCapabilityDegradeHint(capabilityId)

  return { supported, hint }
}

/**
 * 获取功能降级提示
 */
export function getCapabilityDegradeMessage(
  adapter: VersionAdapter | null,
  capabilityId: string
): string | null {
  const { supported, hint } = checkCapabilityWithHint(adapter, capabilityId)
  if (supported) return null
  return hint ?? `功能 ${capabilityId} 在当前版本不可用`
}

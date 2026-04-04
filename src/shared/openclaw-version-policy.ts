import type { OpenClawInstallSource } from './openclaw-phase1'
import { compareLooseVersions } from './openclaw-phase1'
import { type VersionAdapter, createVersionAdapter } from './openclaw-version-adapter'

export const MIN_SUPPORTED_OPENCLAW_VERSION = '2026.3.22'
/** @deprecated 不再使用硬编码上限，保留仅为兼容旧测试 */
export const MAX_SUPPORTED_OPENCLAW_VERSION = '2026.3.28'
/** 默认锁定版本，当未查询到 npm latest 时的回退值 */
export const PINNED_OPENCLAW_VERSION = '2026.3.28'

/**
 * 允许升级到最新版本的标志
 * 设为 true 后，高于 MAX_SUPPORTED 的版本不再被阻断
 */
export const ALLOW_LATEST_OPENCLAW_VERSION = true

/**
 * 动态目标版本（由 npm latest 查询结果填充）
 * 如果为 null 则使用 PINNED_OPENCLAW_VERSION
 */
let dynamicTargetVersion: string | null = null

/**
 * 设置动态目标版本（来自 npm registry latest 查询）
 */
export function setDynamicTargetVersion(version: string | null): void {
  dynamicTargetVersion = version
}

/**
 * 获取当前升级目标版本
 * 优先使用动态查询到的最新版本，否则回退到 PINNED_OPENCLAW_VERSION
 */
export function getEffectiveTargetVersion(): string {
  return dynamicTargetVersion || PINNED_OPENCLAW_VERSION
}

// 版本适配器实例（可选，用于新版本适配）
let versionAdapter: VersionAdapter | null = null

/**
 * 设置版本适配器
 */
export function setVersionAdapter(adapter: VersionAdapter | null): void {
  versionAdapter = adapter
}

/**
 * 获取版本适配器
 */
export function getVersionAdapter(): VersionAdapter | null {
  return versionAdapter
}

export type OpenClawVersionPolicyState =
  | 'below_min'
  | 'supported_not_target'
  | 'supported_target'
  | 'above_max'

export type OpenClawVersionEnforcement =
  | 'none'
  | 'optional_upgrade'
  | 'auto_correct'
  | 'manual_block'

export type OpenClawVersionTargetAction = 'none' | 'upgrade' | 'downgrade' | 'install'

export interface OpenClawInstallCandidatePaths {
  binaryPath?: string | null
  resolvedBinaryPath?: string | null
  packageRoot?: string | null
}

export interface OpenClawVersionEnforcementResult {
  normalizedVersion: string | null
  policyState: OpenClawVersionPolicyState
  enforcement: OpenClawVersionEnforcement
  targetAction: OpenClawVersionTargetAction
  targetVersion: string | null
  blocksContinue: boolean
  canSelfHeal: boolean
}

function normalizeVersionCore(value: string | null | undefined): string {
  if (value?.startsWith("OpenClaw")) {
    return value.match(/\d{4}\.\d+\.\d+/)?.[0] || value;
  }
  return String(value || '')
    .trim()
    .replace(/^v/i, '')
    .split('-')[0]
    .trim()
}

function normalizePathSignature(value: string | null | undefined): string {
  return String(value || '').replace(/\\/g, '/').toLowerCase()
}

export function isStrictOpenClawPolicyVersion(version: string | null | undefined): boolean {
  const normalized = normalizeVersionCore(version)
  if (!normalized) return false
  return normalized.split('.').every((part) => /^\d+$/.test(part))
}

export function normalizeOpenClawPolicyVersion(version: string | null | undefined): string | null {
  const normalized = normalizeVersionCore(version)
  return normalized || null
}

export function classifyOpenClawVersionLockState(
  version: string | null | undefined
): OpenClawVersionPolicyState {
  const normalizedVersion = normalizeOpenClawPolicyVersion(version) || '0.0.0'
  const effectiveTarget = getEffectiveTargetVersion()

  // 如果设置了版本适配器，使用适配器的判断
  if (versionAdapter) {
    const adapterStatus = versionAdapter.getStatus()
    
    // 如果适配器标记为supported或degraded，认为是支持的
    if (adapterStatus === 'supported' || adapterStatus === 'degraded') {
      // 检查是否是目标版本（或已是最新）
      if (normalizedVersion === effectiveTarget ||
          compareLooseVersions(normalizedVersion, effectiveTarget) >= 0) {
        return 'supported_target'
      }
      return 'supported_not_target'
    }
    
    // 如果是experimental，允许继续但标记为非目标
    if (adapterStatus === 'experimental') {
      // 检查是否已达目标版本
      if (compareLooseVersions(normalizedVersion, effectiveTarget) >= 0) {
        return 'supported_target'
      }
      return 'supported_not_target'
    }
    
    // 如果是unsupported，检查是否低于最小版本
    if (compareLooseVersions(normalizedVersion, MIN_SUPPORTED_OPENCLAW_VERSION) < 0) {
      return 'below_min'
    }
    return 'above_max'
  }

  // 低于最小支持版本
  if (compareLooseVersions(normalizedVersion, MIN_SUPPORTED_OPENCLAW_VERSION) < 0) {
    return 'below_min'
  }

  // 已达到或超过目标版本 → 视为已达标
  if (compareLooseVersions(normalizedVersion, effectiveTarget) >= 0) {
    return 'supported_target'
  }

  // 在支持范围内但未达目标
  if (ALLOW_LATEST_OPENCLAW_VERSION || compareLooseVersions(normalizedVersion, MAX_SUPPORTED_OPENCLAW_VERSION) <= 0) {
    return 'supported_not_target'
  }

  return 'above_max'
}

export function supportsPinnedOpenClawCorrection(
  installSource: OpenClawInstallSource | null | undefined,
  candidatePaths?: OpenClawInstallCandidatePaths | null
): boolean {
  if (!installSource) return false
  if (
    installSource === 'npm-global' ||
    installSource === 'nvm' ||
    installSource === 'fnm' ||
    installSource === 'asdf' ||
    installSource === 'mise' ||
    installSource === 'volta'
  ) {
    return true
  }

  if (installSource !== 'homebrew') return false

  const corpus = [
    candidatePaths?.binaryPath,
    candidatePaths?.resolvedBinaryPath,
    candidatePaths?.packageRoot,
  ]
    .map((value) => normalizePathSignature(value))
    .join('\n')
  const hasHomebrewCellarSignature =
    corpus.includes('/cellar/openclaw') || corpus.includes('/caskroom/openclaw')

  if (hasHomebrewCellarSignature) return false

  return (
    corpus.includes('/node_modules/openclaw') ||
    corpus.includes('/.npm-global/') ||
    corpus.includes('/appdata/roaming/npm/')
  )
}

export function resolveOpenClawVersionEnforcement(input: {
  version: string | null | undefined
  installSource: OpenClawInstallSource | null | undefined
  candidatePaths?: OpenClawInstallCandidatePaths | null
}): OpenClawVersionEnforcementResult {
  const normalizedVersion = normalizeOpenClawPolicyVersion(input.version)
  const effectiveTarget = getEffectiveTargetVersion()

  if (!isStrictOpenClawPolicyVersion(normalizedVersion)) {
    // 如果设置了版本适配器，使用适配器的判断
    if (versionAdapter) {
      const adapterStatus = versionAdapter.getStatus()
      
      // experimental 或 degraded 状态允许继续
      if (adapterStatus === 'experimental' || adapterStatus === 'degraded') {
        return {
          normalizedVersion,
          policyState: 'supported_not_target',
          enforcement: 'none',
          targetAction: 'none',
          targetVersion: null,
          blocksContinue: false,
          canSelfHeal: false,
        }
      }
    }
    
    return {
      normalizedVersion,
      policyState: 'above_max',
      enforcement: 'manual_block',
      targetAction: 'none',
      targetVersion: effectiveTarget,
      blocksContinue: true,
      canSelfHeal: false,
    }
  }
  const policyState = classifyOpenClawVersionLockState(normalizedVersion)
  const canCorrect = supportsPinnedOpenClawCorrection(input.installSource, input.candidatePaths)

  switch (policyState) {
    case 'supported_target':
      return {
        normalizedVersion,
        policyState,
        enforcement: 'none',
        targetAction: 'none',
        targetVersion: null,
        blocksContinue: false,
        canSelfHeal: false,
      }
    case 'supported_not_target':
      return {
        normalizedVersion,
        policyState,
        enforcement: canCorrect ? 'optional_upgrade' : 'manual_block',
        targetAction: 'upgrade',
        targetVersion: effectiveTarget,
        blocksContinue: false,
        canSelfHeal: canCorrect,
      }
    case 'below_min':
      return {
        normalizedVersion,
        policyState,
        enforcement: canCorrect ? 'auto_correct' : 'manual_block',
        targetAction: 'upgrade',
        targetVersion: effectiveTarget,
        blocksContinue: true,
        canSelfHeal: canCorrect,
      }
    case 'above_max':
    default:
      // 新策略：ALLOW_LATEST_OPENCLAW_VERSION 或适配器激活时，不再强制降级
      if (ALLOW_LATEST_OPENCLAW_VERSION || (versionAdapter && versionAdapter.getStatus() !== 'unsupported')) {
        return {
          normalizedVersion,
          policyState: 'supported_not_target',
          enforcement: canCorrect ? 'optional_upgrade' : 'none',
          targetAction: 'upgrade',
          targetVersion: effectiveTarget,
          blocksContinue: false,
          canSelfHeal: canCorrect,
        }
      }
      
      return {
        normalizedVersion,
        policyState,
        enforcement: canCorrect ? 'auto_correct' : 'manual_block',
        targetAction: 'downgrade',
        targetVersion: effectiveTarget,
        blocksContinue: true,
        canSelfHeal: canCorrect,
      }
  }
}

import type { OpenClawInstallSource } from './openclaw-phase1'
import { compareLooseVersions } from './openclaw-phase1'

export const MIN_SUPPORTED_OPENCLAW_VERSION = '2026.3.22'
export const MAX_SUPPORTED_OPENCLAW_VERSION = '2026.3.28'
export const PINNED_OPENCLAW_VERSION = '2026.3.28'

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

  if (compareLooseVersions(normalizedVersion, MIN_SUPPORTED_OPENCLAW_VERSION) < 0) {
    return 'below_min'
  }
  if (compareLooseVersions(normalizedVersion, MAX_SUPPORTED_OPENCLAW_VERSION) > 0) {
    return 'above_max'
  }
  if (compareLooseVersions(normalizedVersion, PINNED_OPENCLAW_VERSION) === 0) {
    return 'supported_target'
  }
  return 'supported_not_target'
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
  if (!isStrictOpenClawPolicyVersion(normalizedVersion)) {
    return {
      normalizedVersion,
      policyState: 'above_max',
      enforcement: 'manual_block',
      targetAction: 'none',
      targetVersion: PINNED_OPENCLAW_VERSION,
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
        targetVersion: PINNED_OPENCLAW_VERSION,
        blocksContinue: false,
        canSelfHeal: canCorrect,
      }
    case 'below_min':
      return {
        normalizedVersion,
        policyState,
        enforcement: canCorrect ? 'auto_correct' : 'manual_block',
        targetAction: 'upgrade',
        targetVersion: PINNED_OPENCLAW_VERSION,
        blocksContinue: true,
        canSelfHeal: canCorrect,
      }
    case 'above_max':
    default:
      return {
        normalizedVersion,
        policyState,
        enforcement: canCorrect ? 'auto_correct' : 'manual_block',
        targetAction: 'downgrade',
        targetVersion: PINNED_OPENCLAW_VERSION,
        blocksContinue: true,
        canSelfHeal: canCorrect,
      }
  }
}

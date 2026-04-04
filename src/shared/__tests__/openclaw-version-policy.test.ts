import { describe, expect, it, beforeEach } from 'vitest'

import {
  MIN_SUPPORTED_OPENCLAW_VERSION,
  PINNED_OPENCLAW_VERSION,
  ALLOW_LATEST_OPENCLAW_VERSION,
  classifyOpenClawVersionLockState,
  resolveOpenClawVersionEnforcement,
  supportsPinnedOpenClawCorrection,
  setDynamicTargetVersion,
  getEffectiveTargetVersion,
} from '../openclaw-version-policy'

describe('openclaw version policy', () => {
  beforeEach(() => {
    // 每个测试前重置动态目标版本
    setDynamicTargetVersion(null)
  })

  it('classifies versions against the supported window with ALLOW_LATEST enabled', () => {
    expect(MIN_SUPPORTED_OPENCLAW_VERSION).toBe('2026.3.22')
    expect(PINNED_OPENCLAW_VERSION).toBe('2026.3.28')
    expect(ALLOW_LATEST_OPENCLAW_VERSION).toBe(true)
    expect(classifyOpenClawVersionLockState('2026.3.21')).toBe('below_min')
    expect(classifyOpenClawVersionLockState('2026.3.22')).toBe('supported_not_target')
    expect(classifyOpenClawVersionLockState('2026.3.23')).toBe('supported_not_target')
    expect(classifyOpenClawVersionLockState('2026.3.28')).toBe('supported_target')
    // 高于 PINNED 的版本：因为 ALLOW_LATEST=true，视为已达标
    expect(classifyOpenClawVersionLockState('2026.3.30')).toBe('supported_target')
    expect(classifyOpenClawVersionLockState('2026.4.1')).toBe('supported_target')
  })

  it('treats versions above pinned as supported_not_target when dynamic target is higher', () => {
    setDynamicTargetVersion('2026.4.5')
    expect(classifyOpenClawVersionLockState('2026.3.28')).toBe('supported_not_target')
    expect(classifyOpenClawVersionLockState('2026.4.1')).toBe('supported_not_target')
    expect(classifyOpenClawVersionLockState('2026.4.5')).toBe('supported_target')
    expect(classifyOpenClawVersionLockState('2026.4.6')).toBe('supported_target')
  })

  it('getEffectiveTargetVersion returns dynamic target when set', () => {
    expect(getEffectiveTargetVersion()).toBe('2026.3.28')
    setDynamicTargetVersion('2026.4.2')
    expect(getEffectiveTargetVersion()).toBe('2026.4.2')
    setDynamicTargetVersion(null)
    expect(getEffectiveTargetVersion()).toBe('2026.3.28')
  })

  it('normalizes loose release tags before classifying', () => {
    expect(classifyOpenClawVersionLockState('v2026.3.28-2')).toBe('supported_target')
  })

  it('only auto-corrects sources that can be safely pinned in place', () => {
    expect(supportsPinnedOpenClawCorrection('npm-global')).toBe(true)
    expect(supportsPinnedOpenClawCorrection('nvm')).toBe(true)
    expect(supportsPinnedOpenClawCorrection('custom')).toBe(false)
    expect(supportsPinnedOpenClawCorrection('unknown')).toBe(false)
    expect(
      supportsPinnedOpenClawCorrection('homebrew', {
        packageRoot: '/tmp/homebrew/lib/node_modules/openclaw',
      })
    ).toBe(true)
    expect(
      supportsPinnedOpenClawCorrection('homebrew', {
        packageRoot: '/opt/homebrew/Cellar/openclaw/2026.3.25/libexec/lib/node_modules/openclaw',
      })
    ).toBe(false)
  })

  it('treats malformed versions as manual-blocked instead of auto-correctable', () => {
    expect(
      resolveOpenClawVersionEnforcement({
        version: 'openclaw 2026.3.25 (custom build)',
        installSource: 'npm-global',
      })
    ).toMatchObject({
      enforcement: 'manual_block',
      targetAction: 'none',
      targetVersion: '2026.3.28',
      blocksContinue: true,
      canSelfHeal: false,
    })
  })

  it('resolves explicit enforcement for the supported range and out-of-range installs', () => {
    expect(
      resolveOpenClawVersionEnforcement({
        version: '2026.3.21',
        installSource: 'npm-global',
      })
    ).toMatchObject({
      policyState: 'below_min',
      enforcement: 'auto_correct',
      targetAction: 'upgrade',
      targetVersion: '2026.3.28',
      blocksContinue: true,
      canSelfHeal: true,
    })

    expect(
      resolveOpenClawVersionEnforcement({
        version: '2026.3.23',
        installSource: 'npm-global',
      })
    ).toMatchObject({
      policyState: 'supported_not_target',
      enforcement: 'optional_upgrade',
      targetAction: 'upgrade',
      targetVersion: '2026.3.28',
      blocksContinue: false,
      canSelfHeal: true,
    })

    expect(
      resolveOpenClawVersionEnforcement({
        version: '2026.3.23',
        installSource: 'custom',
      })
    ).toMatchObject({
      policyState: 'supported_not_target',
      enforcement: 'manual_block',
      targetAction: 'upgrade',
      targetVersion: '2026.3.28',
      blocksContinue: false,
      canSelfHeal: false,
    })

    expect(
      resolveOpenClawVersionEnforcement({
        version: '2026.3.28',
        installSource: 'npm-global',
      })
    ).toMatchObject({
      policyState: 'supported_target',
      enforcement: 'none',
      targetAction: 'none',
      targetVersion: null,
      blocksContinue: false,
      canSelfHeal: false,
    })

    // 高于 PINNED：不再阻断，允许继续（ALLOW_LATEST=true）
    expect(
      resolveOpenClawVersionEnforcement({
        version: '2026.3.30',
        installSource: 'npm-global',
      })
    ).toMatchObject({
      policyState: 'supported_target',
      enforcement: 'none',
      targetAction: 'none',
      blocksContinue: false,
    })

    expect(
      resolveOpenClawVersionEnforcement({
        version: '2026.3.30',
        installSource: 'custom',
      })
    ).toMatchObject({
      policyState: 'supported_target',
      enforcement: 'none',
      targetAction: 'none',
      blocksContinue: false,
    })
  })

  it('suggests upgrading to dynamic target when set', () => {
    setDynamicTargetVersion('2026.4.5')

    expect(
      resolveOpenClawVersionEnforcement({
        version: '2026.3.28',
        installSource: 'npm-global',
      })
    ).toMatchObject({
      policyState: 'supported_not_target',
      enforcement: 'optional_upgrade',
      targetAction: 'upgrade',
      targetVersion: '2026.4.5',
      blocksContinue: false,
    })

    // 已是最新
    expect(
      resolveOpenClawVersionEnforcement({
        version: '2026.4.5',
        installSource: 'npm-global',
      })
    ).toMatchObject({
      policyState: 'supported_target',
      enforcement: 'none',
      targetAction: 'none',
      blocksContinue: false,
    })
  })
})

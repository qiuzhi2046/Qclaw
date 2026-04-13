import { describe, expect, it } from 'vitest'

import {
  MAX_SUPPORTED_OPENCLAW_VERSION,
  MIN_SUPPORTED_OPENCLAW_VERSION,
  PINNED_OPENCLAW_VERSION,
  classifyOpenClawVersionLockState,
  resolveOpenClawVersionEnforcement,
  supportsPinnedOpenClawCorrection,
} from '../openclaw-version-policy'

describe('openclaw version policy', () => {
  it('classifies versions against the fixed supported window', () => {
    expect(MIN_SUPPORTED_OPENCLAW_VERSION).toBe('2026.4.12')
    expect(MAX_SUPPORTED_OPENCLAW_VERSION).toBe('2026.4.12')
    expect(PINNED_OPENCLAW_VERSION).toBe('2026.4.12')
    expect(classifyOpenClawVersionLockState('2026.4.10')).toBe('below_min')
    expect(classifyOpenClawVersionLockState('2026.4.12')).toBe('supported_target')
    expect(classifyOpenClawVersionLockState('2026.4.13')).toBe('above_max')
  })

  it('normalizes loose release tags before classifying', () => {
    expect(classifyOpenClawVersionLockState('v2026.4.12-2')).toBe('supported_target')
  })

  it('only auto-corrects sources that can be safely pinned in place', () => {
    expect(supportsPinnedOpenClawCorrection('npm-global')).toBe(true)
    expect(supportsPinnedOpenClawCorrection('nvm')).toBe(true)
    expect(supportsPinnedOpenClawCorrection('custom')).toBe(false)
    expect(supportsPinnedOpenClawCorrection('unknown')).toBe(false)
    expect(supportsPinnedOpenClawCorrection('qclaw-bundled', null, 'win32')).toBe(true)
    expect(supportsPinnedOpenClawCorrection('qclaw-managed', null, 'win32')).toBe(true)
    expect(supportsPinnedOpenClawCorrection('qclaw-bundled', null, 'darwin')).toBe(false)
    expect(supportsPinnedOpenClawCorrection('qclaw-managed', null, 'linux')).toBe(false)
    expect(
      supportsPinnedOpenClawCorrection('homebrew', {
        packageRoot: '/tmp/homebrew/lib/node_modules/openclaw',
      })
    ).toBe(true)
    expect(
      supportsPinnedOpenClawCorrection('homebrew', {
        packageRoot: '/opt/homebrew/Cellar/openclaw/2026.4.13/libexec/lib/node_modules/openclaw',
      })
    ).toBe(false)
  })

  it('treats malformed versions as manual-blocked instead of auto-correctable', () => {
    expect(
      resolveOpenClawVersionEnforcement({
        version: 'openclaw 2026.4.13 (custom build)',
        installSource: 'npm-global',
      })
    ).toMatchObject({
      enforcement: 'manual_block',
      targetAction: 'none',
      targetVersion: '2026.4.12',
      blocksContinue: true,
      canSelfHeal: false,
    })
  })

  it('resolves explicit enforcement for the supported range and out-of-range installs', () => {
    expect(
      resolveOpenClawVersionEnforcement({
        version: '2026.4.10',
        installSource: 'npm-global',
      })
    ).toMatchObject({
      policyState: 'below_min',
      enforcement: 'auto_correct',
      targetAction: 'upgrade',
      targetVersion: '2026.4.12',
      blocksContinue: true,
      canSelfHeal: true,
    })

    expect(
      resolveOpenClawVersionEnforcement({
        version: '2026.4.10',
        installSource: 'custom',
      })
    ).toMatchObject({
      policyState: 'below_min',
      enforcement: 'manual_block',
      targetAction: 'upgrade',
      targetVersion: '2026.4.12',
      blocksContinue: true,
      canSelfHeal: false,
    })

    expect(
      resolveOpenClawVersionEnforcement({
        version: '2026.4.12',
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

    expect(
      resolveOpenClawVersionEnforcement({
        version: '2026.4.13',
        installSource: 'npm-global',
      })
    ).toMatchObject({
      policyState: 'above_max',
      enforcement: 'auto_correct',
      targetAction: 'downgrade',
      targetVersion: '2026.4.12',
      blocksContinue: true,
      canSelfHeal: true,
    })

    expect(
      resolveOpenClawVersionEnforcement({
        version: '2026.4.13',
        installSource: 'custom',
      })
    ).toMatchObject({
      policyState: 'above_max',
      enforcement: 'manual_block',
      targetAction: 'downgrade',
      targetVersion: '2026.4.12',
      blocksContinue: true,
      canSelfHeal: false,
    })

    expect(
      resolveOpenClawVersionEnforcement({
        version: '2026.4.13',
        installSource: 'qclaw-managed',
        platform: 'win32',
      })
    ).toMatchObject({
      policyState: 'above_max',
      enforcement: 'auto_correct',
      targetAction: 'downgrade',
      targetVersion: '2026.4.12',
      blocksContinue: true,
      canSelfHeal: true,
    })

    expect(
      resolveOpenClawVersionEnforcement({
        version: '2026.4.10',
        installSource: 'qclaw-bundled',
        platform: 'win32',
      })
    ).toMatchObject({
      policyState: 'below_min',
      enforcement: 'auto_correct',
      targetAction: 'upgrade',
      targetVersion: '2026.4.12',
      blocksContinue: true,
      canSelfHeal: true,
    })
  })
})

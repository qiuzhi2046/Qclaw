import { describe, expect, it } from 'vitest'
import { summarizeOpenClaw, summarizeQClaw } from '../UpdateCenter'
import type { CombinedUpdateCheckResult } from '../../shared/openclaw-phase4'

function createCombinedUpdateCheck(
  overrides: Partial<CombinedUpdateCheckResult['openclaw']> = {}
): CombinedUpdateCheckResult {
  return {
    ok: true,
    warnings: [],
    canRun: false,
    openclaw: {
      ok: true,
      activeCandidate: null,
      currentVersion: '2026.3.23',
      targetVersion: '2026.3.24',
      latestCheck: null,
      policyState: 'supported_not_target',
      enforcement: 'optional_upgrade',
      targetAction: 'upgrade',
      blocksContinue: false,
      canSelfHeal: true,
      canAutoUpgrade: true,
      upToDate: false,
      gatewayRunning: false,
      warnings: [],
      ...overrides,
    },
    qclaw: {
      ok: true,
      supported: true,
      configured: true,
      currentVersion: '2.2.0',
      availableVersion: '2.3.0',
      status: 'available',
      progressPercent: null,
      downloaded: false,
    },
  }
}

describe('UpdateCenter summaries', () => {
  it('keeps supported optional openclaw upgrades summarized as a version hop', () => {
    expect(summarizeOpenClaw(createCombinedUpdateCheck())).toBe('2026.3.23 → 2026.3.24')
  })

  it('keeps manual-block summaries aligned with env-check wording', () => {
    expect(
      summarizeOpenClaw(
        createCombinedUpdateCheck({
          enforcement: 'manual_block',
          blocksContinue: true,
          canSelfHeal: false,
          canAutoUpgrade: false,
          policyState: 'above_max',
          targetAction: 'downgrade',
          manualHint: '请手动回退到 2026.3.24',
          errorCode: 'manual_only',
        })
      )
    ).toContain('手动调整到 2026.3.24')
  })

  it('keeps auto-correct summaries pointing users back to startup repair', () => {
    expect(
      summarizeOpenClaw(
        createCombinedUpdateCheck({
          enforcement: 'auto_correct',
          blocksContinue: true,
          policyState: 'below_min',
        })
      )
    ).toContain('启动阶段会先自动修复到 2026.3.24')
  })

  it('summarizes qclaw updates from current to available version', () => {
    expect(summarizeQClaw(createCombinedUpdateCheck())).toBe('2.2.0 → 2.3.0')
  })
})

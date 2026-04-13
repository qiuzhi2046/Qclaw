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
      currentVersion: '2026.4.11',
      targetVersion: null,
      latestCheck: null,
      policyState: 'supported_target',
      enforcement: 'none',
      targetAction: 'none',
      blocksContinue: false,
      canSelfHeal: false,
      canAutoUpgrade: false,
      upToDate: true,
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
  it('reports the pinned version as conforming when policyState is supported_target', () => {
    expect(summarizeOpenClaw(createCombinedUpdateCheck())).toBe('当前版本符合要求')
  })

  it('reports below-min installs as requiring manual adjustment', () => {
    expect(
      summarizeOpenClaw(
        createCombinedUpdateCheck({
          currentVersion: '2026.4.10',
          targetVersion: '2026.4.11',
          enforcement: 'manual_block',
          blocksContinue: true,
          canSelfHeal: false,
          canAutoUpgrade: false,
          policyState: 'below_min',
          targetAction: 'upgrade',
          manualHint: '请在原安装位置手动切换到 2026.4.11',
          errorCode: 'manual_only',
        })
      )
    ).toContain('手动调整到 2026.4.11')
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
    ).toContain('启动阶段会先自动修复到 2026.4.11')
  })

  it('summarizes qclaw updates from current to available version', () => {
    expect(summarizeQClaw(createCombinedUpdateCheck())).toBe('2.2.0 → 2.3.0')
  })
})

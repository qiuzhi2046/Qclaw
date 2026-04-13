import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  checkOpenClawUpgradeMock,
  runOpenClawUpgradeMock,
  checkQClawUpdateMock,
  downloadQClawUpdateMock,
  getQClawUpdateStatusMock,
  installQClawUpdateMock,
} = vi.hoisted(() => ({
  checkOpenClawUpgradeMock: vi.fn(),
  runOpenClawUpgradeMock: vi.fn(),
  checkQClawUpdateMock: vi.fn(),
  downloadQClawUpdateMock: vi.fn(),
  getQClawUpdateStatusMock: vi.fn(),
  installQClawUpdateMock: vi.fn(),
}))

vi.mock('../openclaw-upgrade-service', () => ({
  checkOpenClawUpgrade: checkOpenClawUpgradeMock,
  runOpenClawUpgrade: runOpenClawUpgradeMock,
}))

vi.mock('../qclaw-update-service', () => ({
  checkQClawUpdate: checkQClawUpdateMock,
  downloadQClawUpdate: downloadQClawUpdateMock,
  getQClawUpdateStatus: getQClawUpdateStatusMock,
  installQClawUpdate: installQClawUpdateMock,
}))

import { checkCombinedUpdate, runCombinedUpdate } from '../combined-update-orchestrator'

describe('combined update orchestrator', () => {
  beforeEach(() => {
    checkOpenClawUpgradeMock.mockReset()
    runOpenClawUpgradeMock.mockReset()
    checkQClawUpdateMock.mockReset()
    downloadQClawUpdateMock.mockReset()
    getQClawUpdateStatusMock.mockReset()
    installQClawUpdateMock.mockReset()

    getQClawUpdateStatusMock.mockResolvedValue({
      ok: true,
      supported: true,
      configured: true,
      currentVersion: '2.2.0',
      availableVersion: '2.3.0',
      status: 'available',
      progressPercent: null,
      downloaded: false,
    })
    checkQClawUpdateMock.mockResolvedValue({
      ok: true,
      supported: true,
      configured: true,
      currentVersion: '2.2.0',
      availableVersion: '2.3.0',
      status: 'available',
      progressPercent: null,
      downloaded: false,
    })
    downloadQClawUpdateMock.mockResolvedValue({
      ok: true,
      status: {
        ok: true,
        supported: true,
        configured: true,
        currentVersion: '2.2.0',
        availableVersion: '2.3.0',
        status: 'downloaded',
        progressPercent: 100,
        downloaded: true,
      },
    })
    runOpenClawUpgradeMock.mockResolvedValue({
      ok: true,
      blocked: false,
      currentVersion: '2026.4.12',
      targetVersion: '2026.4.12',
      installSource: 'npm-global',
      backupCreated: null,
      gatewayWasRunning: false,
      gatewayRestored: true,
      warnings: [],
    })
    installQClawUpdateMock.mockResolvedValue({
      ok: true,
      status: {
        ok: true,
        supported: true,
        configured: true,
        currentVersion: '2.2.0',
        availableVersion: '2.3.0',
        status: 'downloaded',
        progressPercent: 100,
        downloaded: true,
      },
    })
  })

  it('blocks combined update when openclaw is below the minimum supported version', async () => {
    checkOpenClawUpgradeMock.mockResolvedValue({
      ok: false,
      activeCandidate: null,
      currentVersion: '2026.4.10',
      targetVersion: '2026.4.12',
      latestCheck: null,
      policyState: 'below_min',
      enforcement: 'manual_block',
      targetAction: 'upgrade',
      blocksContinue: true,
      canSelfHeal: false,
      canAutoUpgrade: false,
      upToDate: false,
      gatewayRunning: false,
      warnings: [],
      manualHint: '请在原安装位置手动切换到 2026.4.12',
      errorCode: 'manual_only',
    })

    const result = await checkCombinedUpdate()

    expect(result.canRun).toBe(false)
  })

  it('does not allow combined update for manual_block states', async () => {
    checkOpenClawUpgradeMock.mockResolvedValue({
      ok: false,
      activeCandidate: null,
      currentVersion: '2026.3.25',
      targetVersion: '2026.4.12',
      latestCheck: null,
      policyState: 'above_max',
      enforcement: 'manual_block',
      targetAction: 'downgrade',
      blocksContinue: true,
      canSelfHeal: false,
      canAutoUpgrade: false,
      upToDate: false,
      gatewayRunning: false,
      warnings: [],
      manualHint: '请手动回退到 2026.4.12',
      errorCode: 'manual_only',
    })

    const result = await checkCombinedUpdate()

    expect(result.canRun).toBe(false)
  })

  it('does not allow combined update for startup auto-correction states', async () => {
    checkOpenClawUpgradeMock.mockResolvedValue({
      ok: true,
      activeCandidate: null,
      currentVersion: '2026.3.21',
      targetVersion: '2026.4.12',
      latestCheck: null,
      policyState: 'below_min',
      enforcement: 'auto_correct',
      targetAction: 'upgrade',
      blocksContinue: true,
      canSelfHeal: true,
      canAutoUpgrade: true,
      upToDate: false,
      gatewayRunning: false,
      warnings: [],
    })

    const result = await checkCombinedUpdate()

    expect(result.canRun).toBe(false)
  })

  it('blocks runCombinedUpdate when openclaw is not in the optional-upgrade state', async () => {
    checkOpenClawUpgradeMock.mockResolvedValue({
      ok: false,
      activeCandidate: null,
      currentVersion: '2026.3.25',
      targetVersion: '2026.4.12',
      latestCheck: null,
      policyState: 'above_max',
      enforcement: 'manual_block',
      targetAction: 'downgrade',
      blocksContinue: true,
      canSelfHeal: false,
      canAutoUpgrade: false,
      upToDate: false,
      gatewayRunning: false,
      warnings: [],
      manualHint: '请手动回退到 2026.4.12',
      errorCode: 'manual_only',
    })

    const result = await runCombinedUpdate()

    expect(result.ok).toBe(false)
    expect(result.blocked).toBe(true)
    expect(result.errorCode).toBe('openclaw_blocked')
    expect(runOpenClawUpgradeMock).not.toHaveBeenCalled()
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { discoverOpenClawInstallationsMock, resolveBackupRootDirectoryMock } = vi.hoisted(() => ({
  discoverOpenClawInstallationsMock: vi.fn(),
  resolveBackupRootDirectoryMock: vi.fn(() => '/Users/test/Documents/Qclaw Lite Backups'),
}))

vi.mock('../openclaw-install-discovery', () => ({
  discoverOpenClawInstallations: discoverOpenClawInstallationsMock,
}))

vi.mock('../openclaw-backup-index', () => ({
  resolveBackupRootDirectory: resolveBackupRootDirectoryMock,
}))

import { buildOpenClawCleanupPreview } from '../openclaw-cleanup-planner'

describe('openclaw cleanup planner', () => {
  beforeEach(() => {
    discoverOpenClawInstallationsMock.mockReset()
    resolveBackupRootDirectoryMock.mockClear()
  })

  it('allows cleanup preview for custom installs and surfaces warning', async () => {
    discoverOpenClawInstallationsMock.mockResolvedValue({
      candidates: [
        {
          candidateId: 'candidate-1',
          binaryPath: '/opt/tools/openclaw/bin/openclaw',
          resolvedBinaryPath: '/opt/tools/openclaw/bin/openclaw',
          packageRoot: '/opt/tools/openclaw',
          version: '1.2.3',
          installSource: 'custom',
          isPathActive: true,
          configPath: '/Users/test/.openclaw/openclaw.json',
          stateRoot: '/Users/test/.openclaw',
          displayConfigPath: '~/.openclaw/openclaw.json',
          displayStateRoot: '~/.openclaw',
          ownershipState: 'mixed-managed',
          installFingerprint: 'fingerprint-1',
          baselineBackup: null,
          baselineBackupBypass: null,
        },
      ],
    })

    const preview = await buildOpenClawCleanupPreview({
      actionType: 'remove-openclaw',
      backupBeforeDelete: true,
    })

    expect(preview.canRun).toBe(true)
    expect(preview.blockedReasons).toEqual([])
    expect(preview.warnings.some((warning) => warning.includes('custom'))).toBe(true)
    expect(preview.backupItems[0]).toContain('完整状态备份')
    expect(preview.deleteItems.some((item) => item.includes('网关服务'))).toBe(true)
  })

  it('keeps openclaw intact when preparing qclaw uninstall only', async () => {
    discoverOpenClawInstallationsMock.mockResolvedValue({
      candidates: [],
    })

    const preview = await buildOpenClawCleanupPreview({
      actionType: 'qclaw-uninstall-keep-openclaw',
      backupBeforeDelete: false,
    })

    expect(preview.canRun).toBe(true)
    expect(preview.deleteItems).toEqual([])
    expect(preview.keepItems[0]).toContain('OpenClaw 程序本体')
    expect(preview.manualNextStep).toBeTruthy()
  })

  it('exposes selected and available candidates in cleanup preview', async () => {
    const candidate = {
      candidateId: 'candidate-1',
      binaryPath: '/usr/local/bin/openclaw',
      resolvedBinaryPath: '/usr/local/bin/openclaw',
      packageRoot: '/usr/local/lib/node_modules/openclaw',
      version: '1.2.3',
      installSource: 'npm-global',
      isPathActive: true,
      configPath: '/Users/test/.openclaw/openclaw.json',
      stateRoot: '/Users/test/.openclaw',
      displayConfigPath: '~/.openclaw/openclaw.json',
      displayStateRoot: '~/.openclaw',
      ownershipState: 'mixed-managed',
      installFingerprint: 'fingerprint-1',
      baselineBackup: null,
      baselineBackupBypass: null,
    }

    discoverOpenClawInstallationsMock.mockResolvedValue({
      candidates: [candidate],
    })

    const preview = await buildOpenClawCleanupPreview({
      actionType: 'remove-openclaw',
      backupBeforeDelete: false,
      selectedCandidateIds: ['candidate-1'],
    })

    expect(preview.availableCandidates).toEqual([candidate])
    expect(preview.selectedCandidateIds).toEqual(['candidate-1'])
    expect(preview.deleteItems.some((item) => item.includes('已选择 1')) || preview.deleteItems.some((item) => item.includes('将清理'))).toBe(true)
  })

  it('warns when some selected candidates are missing and still plans for available ones', async () => {
    const candidate = {
      candidateId: 'candidate-1',
      binaryPath: '/usr/local/bin/openclaw',
      resolvedBinaryPath: '/usr/local/bin/openclaw',
      packageRoot: '/usr/local/lib/node_modules/openclaw',
      version: '1.2.3',
      installSource: 'npm-global',
      isPathActive: true,
      configPath: '/Users/test/.openclaw/openclaw.json',
      stateRoot: '/Users/test/.openclaw',
      displayConfigPath: '~/.openclaw/openclaw.json',
      displayStateRoot: '~/.openclaw',
      ownershipState: 'mixed-managed',
      installFingerprint: 'fingerprint-1',
      baselineBackup: null,
      baselineBackupBypass: null,
    }

    discoverOpenClawInstallationsMock.mockResolvedValue({
      candidates: [candidate],
      warnings: [],
    })

    const preview = await buildOpenClawCleanupPreview({
      actionType: 'remove-openclaw',
      backupBeforeDelete: false,
      selectedCandidateIds: ['candidate-1', 'missing-2'],
    })

    expect(preview.canRun).toBe(true)
    expect(preview.warnings.some((warning) => warning.includes('未检测到'))).toBe(true)
    expect(preview.deleteItems.some((item) => item.includes('将清理'))).toBe(true)
  })
})

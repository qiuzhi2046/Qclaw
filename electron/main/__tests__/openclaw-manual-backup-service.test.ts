import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fs = (process.getBuiltinModule('node:fs') as typeof import('node:fs')).promises
const path = process.getBuiltinModule('node:path') as typeof import('node:path')

const {
  discoverOpenClawInstallationsMock,
  createManagedBackupArchiveMock,
} = vi.hoisted(() => ({
  discoverOpenClawInstallationsMock: vi.fn(),
  createManagedBackupArchiveMock: vi.fn(),
}))

vi.mock('../openclaw-install-discovery', () => ({
  discoverOpenClawInstallations: discoverOpenClawInstallationsMock,
}))

vi.mock('../openclaw-backup-index', () => ({
  createManagedBackupArchive: createManagedBackupArchiveMock,
}))

import { runOpenClawManualBackup } from '../openclaw-manual-backup-service'

function buildCandidate(candidateId: string) {
  return {
    candidateId,
    binaryPath: '/usr/local/bin/openclaw',
    resolvedBinaryPath: '/usr/local/bin/openclaw',
    packageRoot: '/usr/local/lib/node_modules/openclaw',
    version: '2026.3.19',
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
  } as const
}

describe('openclaw manual backup service', () => {
  const tempDirs: string[] = []

  beforeEach(() => {
    discoverOpenClawInstallationsMock.mockReset()
    createManagedBackupArchiveMock.mockReset()
  })

  afterEach(async () => {
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  it('returns no_active_install when there is no candidate', async () => {
    discoverOpenClawInstallationsMock.mockResolvedValue({
      candidates: [],
    })

    const result = await runOpenClawManualBackup()

    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('no_active_install')
    expect(result.backup).toBeNull()
    expect(createManagedBackupArchiveMock).not.toHaveBeenCalled()
  })

  it('creates a manual backup when full-state data is present', async () => {
    const candidate = buildCandidate('candidate-1')
    discoverOpenClawInstallationsMock.mockResolvedValue({
      candidates: [candidate],
    })
    createManagedBackupArchiveMock.mockResolvedValue({
      backupId: 'manual-backup-1',
      createdAt: '2026-03-20T00:00:00.000Z',
      archivePath: '/tmp/manual-backup-1',
      manifestPath: '/tmp/manual-backup-1/manifest.json',
      type: 'manual-backup',
      installFingerprint: candidate.installFingerprint,
      sourceVersion: candidate.version,
      scopeAvailability: {
        hasConfigData: true,
        hasMemoryData: true,
        hasEnvData: true,
        hasCredentialsData: true,
      },
    })

    const result = await runOpenClawManualBackup()

    expect(result.ok).toBe(true)
    expect(result.backup?.type).toBe('manual-backup')
    expect(result.errorCode).toBeUndefined()
    expect(createManagedBackupArchiveMock).toHaveBeenCalledWith({
      candidate,
      backupType: 'manual-backup',
      strategyId: 'full-state',
    })
  })

  it('rejects and removes an empty backup archive', async () => {
    const candidate = buildCandidate('candidate-2')
    discoverOpenClawInstallationsMock.mockResolvedValue({
      candidates: [candidate],
    })

    const archivePath = path.join('/tmp', `qclaw-empty-manual-backup-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    tempDirs.push(archivePath)
    await fs.mkdir(archivePath, { recursive: true })
    await fs.writeFile(path.join(archivePath, 'manifest.json'), '{}', 'utf8')

    createManagedBackupArchiveMock.mockResolvedValue({
      backupId: 'manual-backup-empty',
      createdAt: '2026-03-20T00:00:00.000Z',
      archivePath,
      manifestPath: path.join(archivePath, 'manifest.json'),
      type: 'manual-backup',
      installFingerprint: candidate.installFingerprint,
      sourceVersion: candidate.version,
      scopeAvailability: {
        hasConfigData: false,
        hasMemoryData: false,
        hasEnvData: false,
        hasCredentialsData: false,
      },
    })

    const result = await runOpenClawManualBackup()

    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('backup_failed')
    expect(result.backup).toBeNull()
    await expect(fs.access(archivePath)).rejects.toThrow()
  })
})

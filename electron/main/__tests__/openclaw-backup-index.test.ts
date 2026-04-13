import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createManagedBackupArchive,
  createStateRootBackupArchive,
  deleteAllOpenClawBackups,
  deleteOpenClawBackup,
  listOpenClawBackups,
  resolveOpenClawBackupDirectoryToOpen,
} from '../openclaw-backup-index'
import { getBaselineBackupBypassStatus } from '../openclaw-baseline-backup-gate'

const fs = (process.getBuiltinModule('node:fs') as typeof import('node:fs')).promises
const path = process.getBuiltinModule('node:path') as typeof import('node:path')

describe('openclaw backup index', () => {
  const originalBackupDir = process.env.QCLAW_BACKUP_DIR
  const originalUserDataDir = process.env.QCLAW_USER_DATA_DIR
  let backupDir = ''
  let userDataDir = ''

  beforeEach(async () => {
    backupDir = path.join('/tmp', `qclaw-backup-index-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    userDataDir = path.join('/tmp', `qclaw-backup-index-user-data-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    process.env.QCLAW_BACKUP_DIR = backupDir
    process.env.QCLAW_USER_DATA_DIR = userDataDir
    await fs.rm(backupDir, { recursive: true, force: true })
    await fs.rm(userDataDir, { recursive: true, force: true })
    await fs.mkdir(path.join(backupDir, 'baseline-a'), { recursive: true })
    await fs.mkdir(path.join(backupDir, 'snapshot-b'), { recursive: true })
    await fs.mkdir(path.join(backupDir, 'upgrade-c'), { recursive: true })
    await fs.writeFile(
      path.join(backupDir, 'baseline-a', 'manifest.json'),
      JSON.stringify(
        {
          backupId: 'baseline-a',
          createdAt: '2026-03-13T08:00:00.000Z',
          archivePath: path.join(backupDir, 'baseline-a'),
          backupType: 'baseline-backup',
          installFingerprint: 'fingerprint-a',
          candidate: {
            version: '1.0.0',
            stateRoot: '/Users/test/.openclaw',
          },
        },
        null,
        2
      ),
      'utf8'
    )
    await fs.mkdir(path.join(backupDir, 'baseline-a', 'openclaw-home'), { recursive: true })
    await fs.writeFile(path.join(backupDir, 'baseline-a', 'openclaw-home', 'openclaw.json'), '{}', 'utf8')

    await fs.writeFile(
      path.join(backupDir, 'snapshot-b', 'manifest.json'),
      JSON.stringify(
        {
          snapshotId: 'snapshot-b',
          createdAt: '2026-03-13T09:00:00.000Z',
          archivePath: path.join(backupDir, 'snapshot-b'),
          snapshotType: 'config-snapshot',
          installFingerprint: 'fingerprint-b',
          candidate: {
            version: '1.1.0',
          },
        },
        null,
        2
      ),
      'utf8'
    )
    await fs.writeFile(path.join(backupDir, 'snapshot-b', 'openclaw.json'), '{}', 'utf8')
    await fs.writeFile(path.join(backupDir, 'snapshot-b', '.env'), 'OPENAI_API_KEY=sk-test', 'utf8')

    await fs.writeFile(
      path.join(backupDir, 'upgrade-c', 'manifest.json'),
      JSON.stringify(
        {
          backupId: 'upgrade-c',
          createdAt: '2026-03-13T10:00:00.000Z',
          archivePath: path.join(backupDir, 'upgrade-c'),
          backupType: 'upgrade-preflight',
          installFingerprint: 'fingerprint-c',
          candidate: {
            version: '1.2.0',
          },
        },
        null,
        2
      ),
      'utf8'
    )
    await fs.writeFile(path.join(backupDir, 'upgrade-c', 'openclaw.json'), '{}', 'utf8')
  })

  afterEach(async () => {
    await fs.rm(backupDir, { recursive: true, force: true })
    await fs.rm(userDataDir, { recursive: true, force: true })
    if (originalBackupDir === undefined) {
      delete process.env.QCLAW_BACKUP_DIR
    } else {
      process.env.QCLAW_BACKUP_DIR = originalBackupDir
    }
    if (originalUserDataDir === undefined) {
      delete process.env.QCLAW_USER_DATA_DIR
      return
    }
    process.env.QCLAW_USER_DATA_DIR = originalUserDataDir
  })

  it('lists known backups in reverse chronological order and infers available scopes', async () => {
    const result = await listOpenClawBackups()

    expect(result.rootDirectory).toBe(backupDir)
    expect(result.entries.map((entry) => entry.backupId)).toEqual(['upgrade-c', 'snapshot-b', 'baseline-a'])
    expect(result.entries[0]?.type).toBe('upgrade-preflight')
    expect(result.entries[0]?.scopeAvailability).toEqual({
      hasConfigData: true,
      hasMemoryData: false,
      hasEnvData: false,
      hasCredentialsData: false,
    })
    expect(result.entries[1]?.scopeAvailability).toEqual({
      hasConfigData: true,
      hasMemoryData: false,
      hasEnvData: true,
      hasCredentialsData: false,
    })
    expect(result.entries[2]?.scopeAvailability.hasMemoryData).toBe(true)
  })

  it('deletes a single backup by id', async () => {
    const result = await deleteOpenClawBackup('snapshot-b')

    expect(result.ok).toBe(true)
    expect(result.deletedBackupIds).toEqual(['snapshot-b'])

    const nextList = await listOpenClawBackups()
    expect(nextList.entries.map((entry) => entry.backupId)).toEqual(['upgrade-c', 'baseline-a'])
  })

  it('records a baseline bypass after deleting a baseline backup so guarded writes stay unblocked', async () => {
    const result = await deleteOpenClawBackup('baseline-a')

    expect(result.ok).toBe(true)
    expect(result.warnings).toEqual([])
    await expect(getBaselineBackupBypassStatus('fingerprint-a')).resolves.toMatchObject({
      installFingerprint: 'fingerprint-a',
      reason: 'manual-backup-required',
      sourcePath: '/Users/test/.openclaw',
    })
  })

  it('deletes all indexed backups', async () => {
    const result = await deleteAllOpenClawBackups()

    expect(result.ok).toBe(true)
    expect(result.deletedCount).toBe(3)

    const nextList = await listOpenClawBackups()
    expect(nextList.entries).toEqual([])
    await expect(getBaselineBackupBypassStatus('fingerprint-a')).resolves.toMatchObject({
      installFingerprint: 'fingerprint-a',
      reason: 'manual-backup-required',
    })
  })

  it('deletes only the scanned backup directory even when manifest archivePath points elsewhere', async () => {
    const outsideDir = path.join('/tmp', `qclaw-backup-index-outside-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    await fs.mkdir(outsideDir, { recursive: true })
    await fs.writeFile(path.join(outsideDir, 'keep.txt'), 'safe', 'utf8')

    try {
      await fs.writeFile(
        path.join(backupDir, 'baseline-a', 'manifest.json'),
        JSON.stringify(
          {
            backupId: 'baseline-a',
            createdAt: '2026-03-13T08:00:00.000Z',
            archivePath: outsideDir,
            backupType: 'baseline-backup',
            installFingerprint: 'fingerprint-a',
            candidate: {
              version: '1.0.0',
            },
          },
          null,
          2
        ),
        'utf8'
      )

      const result = await deleteOpenClawBackup('baseline-a')

      expect(result.ok).toBe(true)
      await expect(fs.access(path.join(backupDir, 'baseline-a'))).rejects.toThrow()
      await expect(fs.access(path.join(outsideDir, 'keep.txt'))).resolves.toBeUndefined()
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true })
    }
  })

  it('creates history-only backups under a single safe directory name so they remain listable', async () => {
    const historyRoot = path.join('/tmp', `qclaw-history-root-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    await fs.mkdir(historyRoot, { recursive: true })
    await fs.writeFile(path.join(historyRoot, 'openclaw.json'), '{}', 'utf8')

    try {
      const backup = await createStateRootBackupArchive({
        stateRoot: historyRoot,
        backupType: 'cleanup-backup',
      })

      expect(path.dirname(backup.archivePath)).toBe(backupDir)
      expect(backup.backupId).not.toContain('/')
      expect(backup.backupId).not.toContain('\\')

      const nextList = await listOpenClawBackups()
      expect(nextList.entries.some((entry) => entry.backupId === backup.backupId)).toBe(true)
    } finally {
      await fs.rm(historyRoot, { recursive: true, force: true })
    }
  })

  it('includes external config files when creating full-state managed backups', async () => {
    const stateRoot = path.join('/tmp', `qclaw-managed-backup-state-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    const externalConfigDir = path.join('/tmp', `qclaw-managed-backup-config-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    const externalConfigPath = path.join(externalConfigDir, 'custom-openclaw.json')
    await fs.mkdir(path.join(stateRoot, 'memory'), { recursive: true })
    await fs.mkdir(externalConfigDir, { recursive: true })
    await fs.writeFile(path.join(stateRoot, 'memory', 'note.txt'), 'hello', 'utf8')
    await fs.writeFile(externalConfigPath, '{"provider":"openai"}', 'utf8')

    try {
      const backup = await createManagedBackupArchive({
        candidate: {
          candidateId: 'managed-candidate',
          binaryPath: '/tmp/openclaw-managed',
          resolvedBinaryPath: '/tmp/openclaw-managed',
          packageRoot: '/tmp',
          version: '2026.3.13',
          installSource: 'custom',
          isPathActive: true,
          configPath: externalConfigPath,
          stateRoot,
          displayConfigPath: externalConfigPath,
          displayStateRoot: stateRoot,
          ownershipState: 'external-preexisting',
          installFingerprint: 'managed-fingerprint',
          baselineBackup: null,
          baselineBackupBypass: null,
        },
        backupType: 'manual-backup',
        copyMode: 'full-state',
      })

      await expect(fs.readFile(path.join(backup.archivePath, 'openclaw-home', 'memory', 'note.txt'), 'utf8')).resolves.toBe('hello')
      await expect(fs.readFile(path.join(backup.archivePath, 'openclaw.json'), 'utf8')).resolves.toContain('"provider":"openai"')
      expect(backup.scopeAvailability).toEqual({
        hasConfigData: true,
        hasMemoryData: true,
        hasEnvData: false,
        hasCredentialsData: false,
      })
    } finally {
      await fs.rm(stateRoot, { recursive: true, force: true })
      await fs.rm(externalConfigDir, { recursive: true, force: true })
    }
  })

  it('falls back to a writable app-owned backup root when the preferred root is blocked', async () => {
    const blockedRoot = path.join('/tmp', `qclaw-backup-index-blocked-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    const stateRoot = path.join('/tmp', `qclaw-managed-backup-fallback-state-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    const configPath = path.join(stateRoot, 'openclaw.json')
    await fs.writeFile(blockedRoot, 'not-a-directory', 'utf8')
    await fs.mkdir(stateRoot, { recursive: true })
    await fs.writeFile(configPath, '{"provider":"openai"}', 'utf8')
    process.env.QCLAW_BACKUP_DIR = blockedRoot

    try {
      const backup = await createManagedBackupArchive({
        candidate: {
          candidateId: 'managed-candidate-fallback',
          binaryPath: '/tmp/openclaw-managed',
          resolvedBinaryPath: '/tmp/openclaw-managed',
          packageRoot: '/tmp',
          version: '2026.4.12',
          installSource: 'custom',
          isPathActive: true,
          configPath,
          stateRoot,
          displayConfigPath: configPath,
          displayStateRoot: stateRoot,
          ownershipState: 'external-preexisting',
          installFingerprint: 'managed-fingerprint-fallback',
          baselineBackup: null,
          baselineBackupBypass: null,
        },
        backupType: 'upgrade-preflight',
        copyMode: 'config-only',
      })

      expect(backup.archivePath).toContain(path.join(userDataDir, 'backups'))

      const nextList = await listOpenClawBackups()
      expect(nextList.rootDirectory).toBe(path.join(userDataDir, 'backups'))
      expect(nextList.entries.some((entry) => entry.backupId === backup.backupId)).toBe(true)
    } finally {
      await fs.rm(blockedRoot, { recursive: true, force: true }).catch(() => undefined)
      await fs.rm(stateRoot, { recursive: true, force: true })
    }
  })

  it('opens the requested backup directory when the entry lives outside the current effective root', async () => {
    const fallbackRoot = path.join(userDataDir, 'backups')
    const fallbackEntryPath = path.join(fallbackRoot, 'fallback-visible')
    await fs.mkdir(fallbackEntryPath, { recursive: true })
    await fs.writeFile(
      path.join(fallbackEntryPath, 'manifest.json'),
      JSON.stringify(
        {
          backupId: 'fallback-visible',
          createdAt: '2026-03-13T11:00:00.000Z',
          archivePath: fallbackEntryPath,
          backupType: 'upgrade-preflight',
          installFingerprint: 'fingerprint-fallback-visible',
          candidate: {
            version: '2026.4.12',
          },
        },
        null,
        2
      ),
      'utf8'
    )

    const targetPath = await resolveOpenClawBackupDirectoryToOpen(fallbackEntryPath)

    expect(targetPath).toBe(fallbackEntryPath)
  })
})

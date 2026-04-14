import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { OpenClawInstallCandidate } from '../../../src/shared/openclaw-phase1'
import {
  ensureBaselineBackup,
  getBaselineBackupBypassStatus,
  skipBaselineBackup,
} from '../openclaw-baseline-backup-gate'

const fs = (process.getBuiltinModule('node:fs') as typeof import('node:fs')).promises
const path = process.getBuiltinModule('node:path') as typeof import('node:path')

function createCandidate(overrides: Partial<OpenClawInstallCandidate> = {}): OpenClawInstallCandidate {
  return {
    candidateId: 'candidate-1',
    binaryPath: '/usr/local/bin/openclaw',
    resolvedBinaryPath: '/usr/local/bin/openclaw',
    packageRoot: '/usr/local/lib/node_modules/openclaw',
    version: '2026.3.12',
    installSource: 'npm-global',
    isPathActive: true,
    configPath: '/tmp/state/openclaw.json',
    stateRoot: '/tmp/state',
    displayConfigPath: '/tmp/state/openclaw.json',
    displayStateRoot: '/tmp/state',
    ownershipState: 'external-preexisting',
    installFingerprint: 'install-fingerprint-1',
    baselineBackup: null,
    baselineBackupBypass: null,
    ...overrides,
  }
}

describe('openclaw baseline backup gate', () => {
  const originalUserDataDir = process.env.QCLAW_USER_DATA_DIR
  const originalBackupDir = process.env.QCLAW_BACKUP_DIR

  let tempRoot = ''
  let userDataDir = ''
  let backupDir = ''
  let stateRoot = ''

  beforeEach(async () => {
    tempRoot = path.join('/tmp', `qclaw-baseline-gate-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    userDataDir = path.join(tempRoot, 'user-data')
    backupDir = path.join(tempRoot, 'backups')
    stateRoot = path.join(tempRoot, 'openclaw-home')

    process.env.QCLAW_USER_DATA_DIR = userDataDir
    process.env.QCLAW_BACKUP_DIR = backupDir

    await fs.rm(tempRoot, { recursive: true, force: true })
    await fs.mkdir(path.join(stateRoot, 'identity'), { recursive: true })
    await fs.mkdir(path.join(stateRoot, 'credentials'), { recursive: true })
    await fs.mkdir(path.join(stateRoot, 'memory'), { recursive: true })
    await fs.mkdir(path.join(stateRoot, 'extensions', 'openclaw-lark', 'node_modules'), { recursive: true })
    await fs.writeFile(path.join(stateRoot, 'openclaw.json'), '{"provider":"openai"}', 'utf8')
    await fs.writeFile(path.join(stateRoot, '.env'), 'OPENAI_API_KEY=test\n', 'utf8')
    await fs.writeFile(path.join(stateRoot, 'credentials', 'token.json'), '{"token":"secret"}', 'utf8')
    await fs.writeFile(path.join(stateRoot, 'memory', 'note.txt'), 'memory', 'utf8')
    await fs.writeFile(
      path.join(stateRoot, 'extensions', 'openclaw-lark', 'node_modules', 'package.json'),
      '{"name":"openclaw-lark-runtime"}',
      'utf8'
    )
    await fs.writeFile(path.join(stateRoot, 'identity', 'device.json'), '{"device":"test"}', 'utf8')
  })

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true })
    if (originalUserDataDir === undefined) {
      delete process.env.QCLAW_USER_DATA_DIR
    } else {
      process.env.QCLAW_USER_DATA_DIR = originalUserDataDir
    }
    if (originalBackupDir === undefined) {
      delete process.env.QCLAW_BACKUP_DIR
    } else {
      process.env.QCLAW_BACKUP_DIR = originalBackupDir
    }
  })

  it('falls back to an app-owned backup root when the preferred root is blocked', async () => {
    const brokenBackupRoot = path.join(tempRoot, 'backup-root-file')
    await fs.writeFile(brokenBackupRoot, 'not-a-directory', 'utf8')
    process.env.QCLAW_BACKUP_DIR = brokenBackupRoot

    const result = await ensureBaselineBackup(
      createCandidate({
        stateRoot,
        configPath: path.join(stateRoot, 'openclaw.json'),
        displayStateRoot: stateRoot,
        displayConfigPath: path.join(stateRoot, 'openclaw.json'),
      })
    )

    expect(result.ok).toBe(true)
    expect(result.created).toBe(true)
    expect(result.backup?.archivePath).toContain(path.join(userDataDir, 'backups'))
  })

  it('returns manual backup guidance when both the preferred root and fallback root are blocked', async () => {
    const brokenBackupRoot = path.join(tempRoot, 'backup-root-file')
    const brokenUserDataFile = path.join(tempRoot, 'user-data-file')
    await fs.writeFile(brokenBackupRoot, 'not-a-directory', 'utf8')
    await fs.writeFile(brokenUserDataFile, 'not-a-directory', 'utf8')
    process.env.QCLAW_BACKUP_DIR = brokenBackupRoot
    process.env.QCLAW_USER_DATA_DIR = brokenUserDataFile

    const result = await ensureBaselineBackup(
      createCandidate({
        stateRoot,
        configPath: path.join(stateRoot, 'openclaw.json'),
        displayStateRoot: stateRoot,
        displayConfigPath: path.join(stateRoot, 'openclaw.json'),
      })
    )

    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('backup_failed')
    expect(result.manualBackupAction).toMatchObject({
      sourcePath: stateRoot,
      displaySourcePath: stateRoot,
    })
    expect(result.manualBackupAction?.suggestedArchivePath).toContain('baseline-')
  })

  it('persists a manual-backup bypass for the install fingerprint', async () => {
    const candidate = createCandidate({
      stateRoot,
      configPath: path.join(stateRoot, 'openclaw.json'),
      displayStateRoot: stateRoot,
      displayConfigPath: path.join(stateRoot, 'openclaw.json'),
    })

    const result = await skipBaselineBackup(candidate)

    expect(result.ok).toBe(true)
    expect(result.bypass).toMatchObject({
      installFingerprint: candidate.installFingerprint,
      sourcePath: stateRoot,
    })

    const persisted = await getBaselineBackupBypassStatus(candidate.installFingerprint)
    expect(persisted).toMatchObject({
      installFingerprint: candidate.installFingerprint,
      sourcePath: stateRoot,
    })
  })

  it('clears any persisted bypass after a real backup succeeds', async () => {
    const candidate = createCandidate({
      stateRoot,
      configPath: path.join(stateRoot, 'openclaw.json'),
      displayStateRoot: stateRoot,
      displayConfigPath: path.join(stateRoot, 'openclaw.json'),
    })

    await skipBaselineBackup(candidate)
    expect(await getBaselineBackupBypassStatus(candidate.installFingerprint)).not.toBeNull()

    const result = await ensureBaselineBackup(candidate)

    expect(result.ok).toBe(true)
    expect(result.created).toBe(true)
    expect(result.backup?.archivePath).toContain(backupDir)
    expect(await getBaselineBackupBypassStatus(candidate.installFingerprint)).toBeNull()
  })

  it('creates a safeguard baseline backup with config and memory but without extension runtimes', async () => {
    const candidate = createCandidate({
      stateRoot,
      configPath: path.join(stateRoot, 'openclaw.json'),
      displayStateRoot: stateRoot,
      displayConfigPath: path.join(stateRoot, 'openclaw.json'),
    })

    const result = await ensureBaselineBackup(candidate)

    expect(result.ok).toBe(true)
    expect(result.backup).not.toBeNull()

    const archivePath = result.backup?.archivePath || ''
    const manifest = JSON.parse(await fs.readFile(path.join(archivePath, 'manifest.json'), 'utf8')) as {
      homeCaptureMode?: string
      strategyId?: string
    }

    expect(manifest.strategyId).toBe('takeover-safeguard')
    expect(manifest.homeCaptureMode).toBe('essential-state')
    await expect(fs.readFile(path.join(archivePath, 'openclaw.json'), 'utf8')).resolves.toContain('"provider":"openai"')
    await expect(fs.readFile(path.join(archivePath, '.env'), 'utf8')).resolves.toContain('OPENAI_API_KEY=test')
    await expect(fs.readFile(path.join(archivePath, 'credentials', 'token.json'), 'utf8')).resolves.toContain('"secret"')
    await expect(fs.readFile(path.join(archivePath, 'openclaw-home', 'memory', 'note.txt'), 'utf8')).resolves.toBe('memory')
    await expect(fs.readFile(path.join(archivePath, 'openclaw-home', 'identity', 'device.json'), 'utf8')).resolves.toContain(
      '"device":"test"'
    )
    await expect(
      fs.access(path.join(archivePath, 'openclaw-home', 'extensions', 'openclaw-lark', 'node_modules', 'package.json'))
    ).rejects.toThrow()
  })
})

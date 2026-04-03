import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  getOpenClawBackupEntryMock,
  createManagedBackupArchiveMock,
  createStateRootBackupArchiveMock,
  discoverOpenClawInstallationsMock,
  applyGatewaySecretActionMock,
  reloadGatewayForConfigChangeMock,
  runCliMock,
  runCliWithBinaryMock,
  readRuntimeEnvFileMock,
} = vi.hoisted(() => ({
  getOpenClawBackupEntryMock: vi.fn(),
  createManagedBackupArchiveMock: vi.fn(),
  createStateRootBackupArchiveMock: vi.fn(),
  discoverOpenClawInstallationsMock: vi.fn(),
  applyGatewaySecretActionMock: vi.fn(),
  reloadGatewayForConfigChangeMock: vi.fn(),
  runCliMock: vi.fn(),
  runCliWithBinaryMock: vi.fn(),
  readRuntimeEnvFileMock: vi.fn(),
}))

vi.mock('../openclaw-backup-index', () => ({
  getOpenClawBackupEntry: getOpenClawBackupEntryMock,
  createManagedBackupArchive: createManagedBackupArchiveMock,
  createStateRootBackupArchive: createStateRootBackupArchiveMock,
}))

vi.mock('../openclaw-install-discovery', () => ({
  discoverOpenClawInstallations: discoverOpenClawInstallationsMock,
}))

vi.mock('../gateway-secret-apply', () => ({
  applyGatewaySecretAction: applyGatewaySecretActionMock,
}))

vi.mock('../gateway-lifecycle-controller', () => ({
  reloadGatewayForConfigChange: reloadGatewayForConfigChangeMock,
}))

vi.mock('../cli', () => ({
  runCli: runCliMock,
  runCliWithBinary: runCliWithBinaryMock,
  readEnvFile: readRuntimeEnvFileMock,
}))

import { runOpenClawRestore } from '../openclaw-restore-service'

const fs = (process.getBuiltinModule('node:fs') as typeof import('node:fs')).promises
const path = process.getBuiltinModule('node:path') as typeof import('node:path')

describe('openclaw restore service', () => {
  let rootDir = ''

  beforeEach(async () => {
    rootDir = path.join('/tmp', `qclaw-restore-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    await fs.mkdir(rootDir, { recursive: true })

    getOpenClawBackupEntryMock.mockReset()
    createManagedBackupArchiveMock.mockReset()
    createStateRootBackupArchiveMock.mockReset()
    discoverOpenClawInstallationsMock.mockReset()
    applyGatewaySecretActionMock.mockReset()
    reloadGatewayForConfigChangeMock.mockReset()
    runCliMock.mockReset()
    runCliWithBinaryMock.mockReset()
    readRuntimeEnvFileMock.mockReset()

    createManagedBackupArchiveMock.mockResolvedValue({
      backupId: 'restore-preflight-managed-1',
      createdAt: '2026-03-20T00:00:00.000Z',
      archivePath: path.join(rootDir, 'restore-preflight-managed-1'),
      manifestPath: path.join(rootDir, 'restore-preflight-managed-1', 'manifest.json'),
      type: 'restore-preflight',
      installFingerprint: 'restore-preflight-fingerprint',
      sourceVersion: '2026.3.13',
      sourceConfigPath: null,
      sourceStateRoot: null,
      scopeAvailability: {
        hasConfigData: true,
        hasMemoryData: true,
        hasEnvData: true,
        hasCredentialsData: false,
      },
    })
    createStateRootBackupArchiveMock.mockResolvedValue({
      backupId: 'restore-preflight-1',
      createdAt: '2026-03-20T00:00:00.000Z',
      archivePath: path.join(rootDir, 'restore-preflight-1'),
      manifestPath: path.join(rootDir, 'restore-preflight-1', 'manifest.json'),
      type: 'restore-preflight',
      installFingerprint: null,
      sourceVersion: null,
      sourceConfigPath: null,
      sourceStateRoot: null,
      scopeAvailability: {
        hasConfigData: true,
        hasMemoryData: true,
        hasEnvData: true,
        hasCredentialsData: false,
      },
    })
    reloadGatewayForConfigChangeMock.mockResolvedValue({
      ok: true,
      stdout: 'Gateway restarted',
      stderr: '',
      code: 0,
    })
    runCliWithBinaryMock.mockImplementation(async (_binaryPath: string, args: string[]) => {
      if (args[0] === 'health') {
        return {
          ok: true,
          stdout: '{"status":"ok"}',
          stderr: '',
          code: 0,
        }
      }
      if (args[0] === 'gateway' && args[1] === 'restart') {
        return {
          ok: true,
          stdout: 'Gateway restarted',
          stderr: '',
          code: 0,
        }
      }
      if (args[0] === 'gateway' && args[1] === 'start') {
        return {
          ok: true,
          stdout: 'Gateway started',
          stderr: '',
          code: 0,
        }
      }
      return {
        ok: true,
        stdout: '',
        stderr: '',
        code: 0,
      }
    })
    applyGatewaySecretActionMock.mockResolvedValue({
      ok: true,
      requestedAction: 'hot-reload',
      appliedAction: 'hot-reload',
    })
    readRuntimeEnvFileMock.mockResolvedValue({})
    discoverOpenClawInstallationsMock.mockResolvedValue({
      status: 'installed',
      candidates: [],
      activeCandidateId: null,
      hasMultipleCandidates: false,
      historyDataCandidates: [],
      errors: [],
      warnings: [],
      defaultBackupDirectory: rootDir,
    })
  })

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true })
  })

  it('restores config to the backup source paths and reloads gateway for model config changes', async () => {
    const archivePath = path.join(rootDir, 'backup-1')
    const targetStateRoot = path.join(rootDir, 'target-home')
    const wrongStateRoot = path.join(rootDir, 'wrong-home')
    await fs.mkdir(path.join(archivePath, 'openclaw-home'), { recursive: true })
    await fs.mkdir(targetStateRoot, { recursive: true })
    await fs.mkdir(wrongStateRoot, { recursive: true })

    const restoredConfig = {
      defaultModel: 'openai/gpt-5',
    }
    await fs.writeFile(
      path.join(archivePath, 'openclaw-home', 'openclaw.json'),
      JSON.stringify(restoredConfig, null, 2),
      'utf8'
    )
    await fs.chmod(path.join(archivePath, 'openclaw-home', 'openclaw.json'), 0o600)
    await fs.writeFile(
      path.join(targetStateRoot, 'openclaw.json'),
      JSON.stringify(
        {
          agents: {
            defaults: {
              model: {
                primary: 'anthropic/claude-opus-4-6',
              },
            },
          },
        },
        null,
        2
      ),
      'utf8'
    )
    await fs.writeFile(
      path.join(wrongStateRoot, 'openclaw.json'),
      JSON.stringify({ sentinel: 'wrong-target' }, null, 2),
      'utf8'
    )

    getOpenClawBackupEntryMock.mockResolvedValue({
      backupId: 'backup-1',
      createdAt: '2026-03-20T00:00:00.000Z',
      archivePath,
      manifestPath: path.join(archivePath, 'manifest.json'),
      type: 'manual-backup',
      installFingerprint: 'backup-fingerprint',
      sourceVersion: '2026.3.13',
      sourceConfigPath: path.join(targetStateRoot, 'openclaw.json'),
      sourceStateRoot: targetStateRoot,
      scopeAvailability: {
        hasConfigData: true,
        hasMemoryData: true,
        hasEnvData: false,
        hasCredentialsData: false,
      },
    })
    discoverOpenClawInstallationsMock.mockResolvedValue({
      status: 'installed',
      candidates: [
        {
          candidateId: 'wrong-candidate',
          binaryPath: '/tmp/openclaw',
          resolvedBinaryPath: '/tmp/openclaw',
          packageRoot: '/tmp',
          version: '2026.3.13',
          installSource: 'custom',
          isPathActive: true,
          configPath: path.join(wrongStateRoot, 'openclaw.json'),
          stateRoot: wrongStateRoot,
          displayConfigPath: path.join(wrongStateRoot, 'openclaw.json'),
          displayStateRoot: wrongStateRoot,
          ownershipState: 'external-preexisting',
          installFingerprint: 'wrong-fingerprint',
          baselineBackup: null,
          baselineBackupBypass: null,
        },
        {
          candidateId: 'target-candidate',
          binaryPath: '/tmp/openclaw-target',
          resolvedBinaryPath: '/tmp/openclaw-target',
          packageRoot: '/tmp',
          version: '2026.3.13',
          installSource: 'custom',
          isPathActive: false,
          configPath: path.join(targetStateRoot, 'openclaw.json'),
          stateRoot: targetStateRoot,
          displayConfigPath: path.join(targetStateRoot, 'openclaw.json'),
          displayStateRoot: targetStateRoot,
          ownershipState: 'external-preexisting',
          installFingerprint: 'target-fingerprint',
          baselineBackup: null,
          baselineBackupBypass: null,
        },
      ],
      activeCandidateId: 'wrong-candidate',
      hasMultipleCandidates: false,
      historyDataCandidates: [],
      errors: [],
      warnings: [],
      defaultBackupDirectory: rootDir,
    })

    const result = await runOpenClawRestore('backup-1', 'config')

    expect(result.ok).toBe(true)
    expect(result.warnings).toContain('备份中的顶层 defaultModel 已在恢复时迁移到 agents.defaults.model.primary。')
    expect(result.gatewayApply).toEqual({
      ok: true,
      requestedAction: 'restart',
      appliedAction: 'restart',
      note: 'Gateway restarted',
    })
    expect(reloadGatewayForConfigChangeMock).not.toHaveBeenCalled()
    expect(runCliWithBinaryMock).toHaveBeenCalledWith(
      '/tmp/openclaw-target',
      ['health', '--json'],
      expect.any(Number),
      'gateway',
      undefined
    )
    expect(runCliWithBinaryMock).toHaveBeenCalledWith(
      '/tmp/openclaw-target',
      ['gateway', 'restart'],
      expect.any(Number),
      'gateway',
      undefined
    )
    expect(applyGatewaySecretActionMock).not.toHaveBeenCalled()
    await expect(fs.readFile(path.join(targetStateRoot, 'openclaw.json'), 'utf8')).resolves.toContain('"primary": "openai/gpt-5"')
    await expect(fs.readFile(path.join(targetStateRoot, 'openclaw.json'), 'utf8')).resolves.not.toContain('"defaultModel"')
    await expect(fs.readFile(path.join(wrongStateRoot, 'openclaw.json'), 'utf8')).resolves.toContain('wrong-target')
    expect((await fs.stat(path.join(targetStateRoot, 'openclaw.json'))).mode & 0o777).toBe(
      process.platform === 'win32' ? 0o666 : 0o600
    )
    expect(createManagedBackupArchiveMock).toHaveBeenCalledWith({
      candidate: expect.objectContaining({
        stateRoot: targetStateRoot,
        configPath: path.join(targetStateRoot, 'openclaw.json'),
      }),
      backupType: 'restore-preflight',
      copyMode: 'full-state',
    })
  })

  it('reuses the official doctor repair flow for restored 3.22 browser migration keys', async () => {
    const archivePath = path.join(rootDir, 'backup-browser-migration')
    const targetStateRoot = path.join(rootDir, 'target-home-browser-migration')
    await fs.mkdir(path.join(archivePath, 'openclaw-home'), { recursive: true })
    await fs.mkdir(targetStateRoot, { recursive: true })

    await fs.writeFile(
      path.join(archivePath, 'openclaw-home', 'openclaw.json'),
      JSON.stringify(
        {
          browser: {
            relayBindHost: '127.0.0.1',
          },
        },
        null,
        2
      ),
      'utf8'
    )
    await fs.writeFile(path.join(targetStateRoot, 'openclaw.json'), JSON.stringify({}, null, 2), 'utf8')

    let doctorCheckCount = 0
    runCliWithBinaryMock.mockImplementation(async (_binaryPath: string, args: string[]) => {
      if (args[0] === 'doctor' && args[1] === '--non-interactive') {
        doctorCheckCount += 1
        if (doctorCheckCount === 1) {
          return {
            ok: false,
            stdout: '',
            stderr: 'Unknown config keys: browser.relayBindHost. Run "openclaw doctor --fix"',
            code: 1,
          }
        }
        return {
          ok: false,
          stdout: '',
          stderr: 'Unknown config keys: browser.relayBindHost. Run "openclaw doctor --fix"',
          code: 1,
        }
      }
      if (args[0] === 'doctor' && args[1] === '--fix') {
        return {
          ok: true,
          stdout: 'Migrated browser.relayBindHost',
          stderr: '',
          code: 0,
        }
      }
      return {
        ok: true,
        stdout: '',
        stderr: '',
        code: 0,
      }
    })

    getOpenClawBackupEntryMock.mockResolvedValue({
      backupId: 'backup-browser-migration',
      createdAt: '2026-03-20T00:00:00.000Z',
      archivePath,
      manifestPath: path.join(archivePath, 'manifest.json'),
      type: 'manual-backup',
      installFingerprint: 'backup-fingerprint-browser-migration',
      sourceVersion: '2026.3.13',
      sourceConfigPath: path.join(targetStateRoot, 'openclaw.json'),
      sourceStateRoot: targetStateRoot,
      scopeAvailability: {
        hasConfigData: true,
        hasMemoryData: true,
        hasEnvData: false,
        hasCredentialsData: false,
      },
    })
    discoverOpenClawInstallationsMock.mockResolvedValue({
      status: 'installed',
      candidates: [
        {
          candidateId: 'target-candidate-browser-migration',
          binaryPath: '/tmp/openclaw-browser-migration',
          resolvedBinaryPath: '/tmp/openclaw-browser-migration',
          packageRoot: '/tmp',
          version: '2026.3.13',
          installSource: 'custom',
          isPathActive: true,
          configPath: path.join(targetStateRoot, 'openclaw.json'),
          stateRoot: targetStateRoot,
          displayConfigPath: path.join(targetStateRoot, 'openclaw.json'),
          displayStateRoot: targetStateRoot,
          ownershipState: 'external-preexisting',
          installFingerprint: 'target-fingerprint-browser-migration',
          baselineBackup: null,
          baselineBackupBypass: null,
        },
      ],
      activeCandidateId: 'target-candidate-browser-migration',
      hasMultipleCandidates: false,
      historyDataCandidates: [],
      errors: [],
      warnings: [],
      defaultBackupDirectory: rootDir,
    })

    const result = await runOpenClawRestore('backup-browser-migration', 'config')

    expect(result.ok).toBe(true)
    expect(doctorCheckCount).toBe(1)
    expect(result.gatewayApply?.requestedAction).toBe('restart')
    expect(result.gatewayApply?.appliedAction).toBe('restart')
    expect(result.gatewayApply?.note).toContain('恢复后官方迁移执行完成。')
    expect(result.gatewayApply?.note).toContain('Migrated browser.relayBindHost')
    expect(result.gatewayApply?.note).toContain('Gateway restarted')
    expect(runCliWithBinaryMock).toHaveBeenCalledWith(
      '/tmp/openclaw-browser-migration',
      ['doctor', '--non-interactive'],
      expect.any(Number),
      'env-setup',
      undefined
    )
    expect(runCliWithBinaryMock).toHaveBeenCalledWith(
      '/tmp/openclaw-browser-migration',
      ['doctor', '--fix', '--non-interactive'],
      expect.any(Number),
      'env-setup',
      undefined
    )
    expect(reloadGatewayForConfigChangeMock).toHaveBeenCalledWith('restore-config', {
      preferEnsureWhenNotRunning: true,
    })
  })

  it('retries restore-target doctor diagnose once after stale plugin repair removes polluted plugin ids', async () => {
    const archivePath = path.join(rootDir, 'backup-browser-migration-stale-plugin')
    const targetStateRoot = path.join(rootDir, 'target-home-browser-migration-stale-plugin')
    await fs.mkdir(path.join(archivePath, 'openclaw-home'), { recursive: true })
    await fs.mkdir(targetStateRoot, { recursive: true })

    await fs.writeFile(
      path.join(archivePath, 'openclaw-home', 'openclaw.json'),
      JSON.stringify(
        {
          browser: {
            relayBindHost: '127.0.0.1',
          },
          plugins: {
            allow: ['fake-stale-plugin'],
          },
        },
        null,
        2
      ),
      'utf8'
    )
    await fs.writeFile(path.join(targetStateRoot, 'openclaw.json'), JSON.stringify({}, null, 2), 'utf8')

    let doctorCheckCount = 0
    runCliWithBinaryMock.mockImplementation(async (_binaryPath: string, args: string[]) => {
      if (args[0] === 'doctor' && args[1] === '--non-interactive') {
        doctorCheckCount += 1
        if (doctorCheckCount === 1) {
          return {
            ok: true,
            stdout:
              'Config warnings:\n- plugins.allow: plugin not found: fake-stale-plugin (stale config entry ignored; remove it from plugins config)',
            stderr: '',
            code: 0,
          }
        }
        return {
          ok: false,
          stdout: '',
          stderr: 'Unknown config keys: browser.relayBindHost. Run "openclaw doctor --fix"',
          code: 1,
        }
      }
      if (args[0] === 'doctor' && args[1] === '--fix') {
        return {
          ok: true,
          stdout: 'Migrated browser.relayBindHost',
          stderr: '',
          code: 0,
        }
      }
      return {
        ok: true,
        stdout: '',
        stderr: '',
        code: 0,
      }
    })

    getOpenClawBackupEntryMock.mockResolvedValue({
      backupId: 'backup-browser-migration-stale-plugin',
      createdAt: '2026-03-20T00:00:00.000Z',
      archivePath,
      manifestPath: path.join(archivePath, 'manifest.json'),
      type: 'manual-backup',
      installFingerprint: 'backup-fingerprint-browser-migration-stale-plugin',
      sourceVersion: '2026.3.13',
      sourceConfigPath: path.join(targetStateRoot, 'openclaw.json'),
      sourceStateRoot: targetStateRoot,
      scopeAvailability: {
        hasConfigData: true,
        hasMemoryData: true,
        hasEnvData: false,
        hasCredentialsData: false,
      },
    })
    discoverOpenClawInstallationsMock.mockResolvedValue({
      status: 'installed',
      candidates: [
        {
          candidateId: 'target-candidate-browser-migration-stale-plugin',
          binaryPath: '/tmp/openclaw-browser-migration-stale-plugin',
          resolvedBinaryPath: '/tmp/openclaw-browser-migration-stale-plugin',
          packageRoot: '/tmp',
          version: '2026.3.13',
          installSource: 'custom',
          isPathActive: true,
          configPath: path.join(targetStateRoot, 'openclaw.json'),
          stateRoot: targetStateRoot,
          displayConfigPath: path.join(targetStateRoot, 'openclaw.json'),
          displayStateRoot: targetStateRoot,
          ownershipState: 'external-preexisting',
          installFingerprint: 'target-fingerprint-browser-migration-stale-plugin',
          baselineBackup: null,
          baselineBackupBypass: null,
        },
      ],
      activeCandidateId: 'target-candidate-browser-migration-stale-plugin',
      hasMultipleCandidates: false,
      historyDataCandidates: [],
      errors: [],
      warnings: [],
      defaultBackupDirectory: rootDir,
    })

    const result = await runOpenClawRestore('backup-browser-migration-stale-plugin', 'config')

    expect(result.ok).toBe(true)
    expect(doctorCheckCount).toBe(2)
    expect(result.gatewayApply?.note).toContain('恢复后官方迁移执行完成。')
    expect(result.gatewayApply?.note).toContain('Migrated browser.relayBindHost')
    await expect(fs.readFile(path.join(targetStateRoot, 'openclaw.json'), 'utf8')).resolves.not.toContain('fake-stale-plugin')
    expect(runCliWithBinaryMock).toHaveBeenCalledWith(
      '/tmp/openclaw-browser-migration-stale-plugin',
      ['doctor', '--fix', '--non-interactive'],
      expect.any(Number),
      'env-setup',
      undefined
    )
  })

  it('falls back to the active install with a warning when backup source paths are not trusted', async () => {
    const archivePath = path.join(rootDir, 'backup-fallback')
    const activeStateRoot = path.join(rootDir, 'active-home')
    await fs.mkdir(path.join(archivePath, 'openclaw-home'), { recursive: true })
    await fs.mkdir(activeStateRoot, { recursive: true })

    await fs.writeFile(
      path.join(archivePath, 'openclaw-home', 'openclaw.json'),
      JSON.stringify({ agents: { defaults: { model: { primary: 'openai/gpt-5.4-pro' } } } }, null, 2),
      'utf8'
    )
    await fs.writeFile(path.join(activeStateRoot, 'openclaw.json'), JSON.stringify({}, null, 2), 'utf8')

    getOpenClawBackupEntryMock.mockResolvedValue({
      backupId: 'backup-fallback',
      createdAt: '2026-03-20T00:00:00.000Z',
      archivePath,
      manifestPath: path.join(archivePath, 'manifest.json'),
      type: 'manual-backup',
      installFingerprint: 'backup-fingerprint-fallback',
      sourceVersion: '2026.3.13',
      sourceConfigPath: '/tmp/untrusted/openclaw.json',
      sourceStateRoot: '/tmp/untrusted',
      scopeAvailability: {
        hasConfigData: true,
        hasMemoryData: true,
        hasEnvData: false,
        hasCredentialsData: false,
      },
    })
    discoverOpenClawInstallationsMock.mockResolvedValue({
      status: 'installed',
      candidates: [
        {
          candidateId: 'active-candidate',
          binaryPath: '/tmp/openclaw-active',
          resolvedBinaryPath: '/tmp/openclaw-active',
          packageRoot: '/tmp',
          version: '2026.3.13',
          installSource: 'custom',
          isPathActive: true,
          configPath: path.join(activeStateRoot, 'openclaw.json'),
          stateRoot: activeStateRoot,
          displayConfigPath: path.join(activeStateRoot, 'openclaw.json'),
          displayStateRoot: activeStateRoot,
          ownershipState: 'external-preexisting',
          installFingerprint: 'active-fingerprint',
          baselineBackup: null,
          baselineBackupBypass: null,
        },
      ],
      activeCandidateId: 'active-candidate',
      hasMultipleCandidates: false,
      historyDataCandidates: [],
      errors: [],
      warnings: [],
      defaultBackupDirectory: rootDir,
    })

    const result = await runOpenClawRestore('backup-fallback', 'config')

    expect(result.ok).toBe(true)
    expect(result.warnings).toContain('备份记录的原始恢复路径未匹配当前 OpenClaw 安装，已回退到当前活动安装。')
    await expect(fs.readFile(path.join(activeStateRoot, 'openclaw.json'), 'utf8')).resolves.toContain('openai/gpt-5.4-pro')
  })

  it('uses secrets hot-reload when restore only changes env secrets', async () => {
    const archivePath = path.join(rootDir, 'backup-2')
    const targetStateRoot = path.join(rootDir, 'target-home-2')
    await fs.mkdir(path.join(archivePath, 'openclaw-home'), { recursive: true })
    await fs.mkdir(targetStateRoot, { recursive: true })

    await fs.writeFile(path.join(archivePath, 'openclaw-home', 'openclaw.json'), JSON.stringify({}, null, 2), 'utf8')
    await fs.writeFile(path.join(archivePath, 'openclaw-home', '.env'), 'ANTHROPIC_API_KEY=new-secret\n', 'utf8')
    await fs.writeFile(path.join(targetStateRoot, 'openclaw.json'), JSON.stringify({}, null, 2), 'utf8')
    await fs.writeFile(path.join(targetStateRoot, '.env'), 'ANTHROPIC_API_KEY=old-secret\n', 'utf8')

    getOpenClawBackupEntryMock.mockResolvedValue({
      backupId: 'backup-2',
      createdAt: '2026-03-20T00:00:00.000Z',
      archivePath,
      manifestPath: path.join(archivePath, 'manifest.json'),
      type: 'manual-backup',
      installFingerprint: 'backup-fingerprint-2',
      sourceVersion: '2026.3.13',
      sourceConfigPath: path.join(targetStateRoot, 'openclaw.json'),
      sourceStateRoot: targetStateRoot,
      scopeAvailability: {
        hasConfigData: true,
        hasMemoryData: true,
        hasEnvData: true,
        hasCredentialsData: false,
      },
    })
    discoverOpenClawInstallationsMock.mockResolvedValue({
      status: 'installed',
      candidates: [
        {
          candidateId: 'target-candidate-2',
          binaryPath: '/tmp/openclaw-target-2',
          resolvedBinaryPath: '/tmp/openclaw-target-2',
          packageRoot: '/tmp',
          version: '2026.3.13',
          installSource: 'custom',
          isPathActive: true,
          configPath: path.join(targetStateRoot, 'openclaw.json'),
          stateRoot: targetStateRoot,
          displayConfigPath: path.join(targetStateRoot, 'openclaw.json'),
          displayStateRoot: targetStateRoot,
          ownershipState: 'external-preexisting',
          installFingerprint: 'target-fingerprint-2',
          baselineBackup: null,
          baselineBackupBypass: null,
        },
      ],
      activeCandidateId: 'target-candidate-2',
      hasMultipleCandidates: false,
      historyDataCandidates: [],
      errors: [],
      warnings: [],
      defaultBackupDirectory: rootDir,
    })

    const result = await runOpenClawRestore('backup-2', 'config')

    expect(result.ok).toBe(true)
    expect(applyGatewaySecretActionMock).toHaveBeenCalledWith({
      requestedAction: 'hot-reload',
      runCommand: expect.any(Function),
    })
    expect(reloadGatewayForConfigChangeMock).not.toHaveBeenCalled()
    expect(result.gatewayApply).toEqual({
      ok: true,
      requestedAction: 'hot-reload',
      appliedAction: 'hot-reload',
    })
    await expect(fs.readFile(path.join(targetStateRoot, '.env'), 'utf8')).resolves.toContain('new-secret')
  })

  it('forces a gateway restart when credentials are restored', async () => {
    const archivePath = path.join(rootDir, 'backup-3')
    const targetStateRoot = path.join(rootDir, 'target-home-3')
    await fs.mkdir(path.join(archivePath, 'openclaw-home', 'credentials'), { recursive: true })
    await fs.mkdir(path.join(targetStateRoot, 'credentials'), { recursive: true })

    await fs.writeFile(path.join(archivePath, 'openclaw-home', 'openclaw.json'), JSON.stringify({}, null, 2), 'utf8')
    await fs.writeFile(path.join(archivePath, 'openclaw-home', 'credentials', 'token.json'), '{"token":"new"}', 'utf8')
    await fs.writeFile(path.join(targetStateRoot, 'openclaw.json'), JSON.stringify({}, null, 2), 'utf8')
    await fs.writeFile(path.join(targetStateRoot, 'credentials', 'token.json'), '{"token":"old"}', 'utf8')

    getOpenClawBackupEntryMock.mockResolvedValue({
      backupId: 'backup-3',
      createdAt: '2026-03-20T00:00:00.000Z',
      archivePath,
      manifestPath: path.join(archivePath, 'manifest.json'),
      type: 'manual-backup',
      installFingerprint: 'backup-fingerprint-3',
      sourceVersion: '2026.3.13',
      sourceConfigPath: path.join(targetStateRoot, 'openclaw.json'),
      sourceStateRoot: targetStateRoot,
      scopeAvailability: {
        hasConfigData: true,
        hasMemoryData: true,
        hasEnvData: false,
        hasCredentialsData: true,
      },
    })
    discoverOpenClawInstallationsMock.mockResolvedValue({
      status: 'installed',
      candidates: [
        {
          candidateId: 'target-candidate-3',
          binaryPath: '/tmp/openclaw-target-3',
          resolvedBinaryPath: '/tmp/openclaw-target-3',
          packageRoot: '/tmp',
          version: '2026.3.13',
          installSource: 'custom',
          isPathActive: true,
          configPath: path.join(targetStateRoot, 'openclaw.json'),
          stateRoot: targetStateRoot,
          displayConfigPath: path.join(targetStateRoot, 'openclaw.json'),
          displayStateRoot: targetStateRoot,
          ownershipState: 'external-preexisting',
          installFingerprint: 'target-fingerprint-3',
          baselineBackup: null,
          baselineBackupBypass: null,
        },
      ],
      activeCandidateId: 'target-candidate-3',
      hasMultipleCandidates: false,
      historyDataCandidates: [],
      errors: [],
      warnings: [],
      defaultBackupDirectory: rootDir,
    })

    const result = await runOpenClawRestore('backup-3', 'config')

    expect(result.ok).toBe(true)
    expect(reloadGatewayForConfigChangeMock).toHaveBeenCalledWith('restore-config', {
      preferEnsureWhenNotRunning: true,
    })
    expect(applyGatewaySecretActionMock).not.toHaveBeenCalled()
    expect(result.gatewayApply).toEqual({
      ok: true,
      requestedAction: 'restart',
      appliedAction: 'restart',
      note: 'Gateway restarted',
    })
    await expect(fs.readFile(path.join(targetStateRoot, 'credentials', 'token.json'), 'utf8')).resolves.toContain('"new"')
  })

  it('restores external config files during all-scope restore', async () => {
    const archivePath = path.join(rootDir, 'backup-all-external-config')
    const targetStateRoot = path.join(rootDir, 'target-home-all')
    const targetConfigPath = path.join(rootDir, 'target-config', 'custom-openclaw.json')
    await fs.mkdir(path.join(archivePath, 'openclaw-home', 'memory'), { recursive: true })
    await fs.mkdir(path.join(targetStateRoot, 'memory'), { recursive: true })

    await fs.writeFile(path.join(archivePath, 'openclaw-home', 'memory', 'note.txt'), 'restored-memory', 'utf8')
    await fs.writeFile(
      path.join(archivePath, 'openclaw-home', 'openclaw.json'),
      JSON.stringify({ defaultModel: 'openai/gpt-legacy-home' }, null, 2),
      'utf8'
    )
    await fs.writeFile(
      path.join(archivePath, 'openclaw.json'),
      JSON.stringify({ agents: { defaults: { model: { primary: 'openai/gpt-5.4' } } } }, null, 2),
      'utf8'
    )
    await fs.writeFile(path.join(targetStateRoot, 'memory', 'note.txt'), 'old-memory', 'utf8')

    getOpenClawBackupEntryMock.mockResolvedValue({
      backupId: 'backup-all-external-config',
      createdAt: '2026-03-20T00:00:00.000Z',
      archivePath,
      manifestPath: path.join(archivePath, 'manifest.json'),
      type: 'manual-backup',
      installFingerprint: 'backup-fingerprint-all-external-config',
      sourceVersion: '2026.3.13',
      sourceConfigPath: targetConfigPath,
      sourceStateRoot: targetStateRoot,
      scopeAvailability: {
        hasConfigData: true,
        hasMemoryData: true,
        hasEnvData: false,
        hasCredentialsData: false,
      },
    })
    discoverOpenClawInstallationsMock.mockResolvedValue({
      status: 'installed',
      candidates: [
        {
          candidateId: 'target-candidate-all-external-config',
          binaryPath: '/tmp/openclaw-all-external-config',
          resolvedBinaryPath: '/tmp/openclaw-all-external-config',
          packageRoot: '/tmp',
          version: '2026.3.13',
          installSource: 'custom',
          isPathActive: true,
          configPath: targetConfigPath,
          stateRoot: targetStateRoot,
          displayConfigPath: targetConfigPath,
          displayStateRoot: targetStateRoot,
          ownershipState: 'external-preexisting',
          installFingerprint: 'target-fingerprint-all-external-config',
          baselineBackup: null,
          baselineBackupBypass: null,
        },
      ],
      activeCandidateId: 'target-candidate-all-external-config',
      hasMultipleCandidates: false,
      historyDataCandidates: [],
      errors: [],
      warnings: [],
      defaultBackupDirectory: rootDir,
    })

    const result = await runOpenClawRestore('backup-all-external-config', 'all')

    expect(result.ok).toBe(true)
    expect(result.warnings).toContain('备份中的顶层 defaultModel 已在恢复时迁移到 agents.defaults.model.primary。')
    expect(result.restoredItems).toContain('已整体恢复 openclaw-home（配置与记忆数据）')
    expect(result.restoredItems).toContain('已恢复 openclaw.json')
    await expect(fs.readFile(targetConfigPath, 'utf8')).resolves.toContain('openai/gpt-5.4')
    await expect(fs.readFile(targetConfigPath, 'utf8')).resolves.not.toContain('defaultModel')
    await expect(fs.readFile(path.join(targetStateRoot, 'openclaw.json'), 'utf8')).resolves.toContain('"primary": "openai/gpt-legacy-home"')
    await expect(fs.readFile(path.join(targetStateRoot, 'openclaw.json'), 'utf8')).resolves.not.toContain('"defaultModel"')
    await expect(fs.readFile(path.join(targetStateRoot, 'memory', 'note.txt'), 'utf8')).resolves.toBe('restored-memory')
  })

  it('uses the target install env when applying secrets to a non-active restore target', async () => {
    const archivePath = path.join(rootDir, 'backup-target-env')
    const targetStateRoot = path.join(rootDir, 'target-home-env')
    const wrongStateRoot = path.join(rootDir, 'wrong-home-env')
    await fs.mkdir(path.join(archivePath, 'openclaw-home'), { recursive: true })
    await fs.mkdir(targetStateRoot, { recursive: true })
    await fs.mkdir(wrongStateRoot, { recursive: true })

    await fs.writeFile(path.join(archivePath, 'openclaw-home', 'openclaw.json'), JSON.stringify({}, null, 2), 'utf8')
    await fs.writeFile(path.join(archivePath, 'openclaw-home', '.env'), 'ANTHROPIC_API_KEY=new-secret\n', 'utf8')
    await fs.writeFile(path.join(targetStateRoot, 'openclaw.json'), JSON.stringify({}, null, 2), 'utf8')
    await fs.writeFile(path.join(wrongStateRoot, 'openclaw.json'), JSON.stringify({}, null, 2), 'utf8')
    readRuntimeEnvFileMock.mockResolvedValue({
      ANTHROPIC_API_KEY: 'active-secret',
      UNUSED_SECRET: 'stale-secret',
    })
    applyGatewaySecretActionMock.mockImplementationOnce(async ({ requestedAction, runCommand }) => {
      const commandResult = await runCommand(['secrets', 'reload'], 999)
      expect(runCliWithBinaryMock).toHaveBeenCalledWith(
        '/tmp/openclaw-target-env',
        ['secrets', 'reload'],
        999,
        'config-write',
        {
          ANTHROPIC_API_KEY: 'new-secret',
          UNUSED_SECRET: undefined,
        }
      )
      return {
        ok: commandResult.ok,
        requestedAction,
        appliedAction: 'hot-reload',
      }
    })

    getOpenClawBackupEntryMock.mockResolvedValue({
      backupId: 'backup-target-env',
      createdAt: '2026-03-20T00:00:00.000Z',
      archivePath,
      manifestPath: path.join(archivePath, 'manifest.json'),
      type: 'manual-backup',
      installFingerprint: 'backup-fingerprint-target-env',
      sourceVersion: '2026.3.13',
      sourceConfigPath: path.join(targetStateRoot, 'openclaw.json'),
      sourceStateRoot: targetStateRoot,
      scopeAvailability: {
        hasConfigData: true,
        hasMemoryData: true,
        hasEnvData: true,
        hasCredentialsData: false,
      },
    })
    discoverOpenClawInstallationsMock.mockResolvedValue({
      status: 'installed',
      candidates: [
        {
          candidateId: 'wrong-candidate-env',
          binaryPath: '/tmp/openclaw-wrong-env',
          resolvedBinaryPath: '/tmp/openclaw-wrong-env',
          packageRoot: '/tmp',
          version: '2026.3.13',
          installSource: 'custom',
          isPathActive: true,
          configPath: path.join(wrongStateRoot, 'openclaw.json'),
          stateRoot: wrongStateRoot,
          displayConfigPath: path.join(wrongStateRoot, 'openclaw.json'),
          displayStateRoot: wrongStateRoot,
          ownershipState: 'external-preexisting',
          installFingerprint: 'wrong-fingerprint-env',
          baselineBackup: null,
          baselineBackupBypass: null,
        },
        {
          candidateId: 'target-candidate-env',
          binaryPath: '/tmp/openclaw-target-env',
          resolvedBinaryPath: '/tmp/openclaw-target-env',
          packageRoot: '/tmp',
          version: '2026.3.13',
          installSource: 'custom',
          isPathActive: false,
          configPath: path.join(targetStateRoot, 'openclaw.json'),
          stateRoot: targetStateRoot,
          displayConfigPath: path.join(targetStateRoot, 'openclaw.json'),
          displayStateRoot: targetStateRoot,
          ownershipState: 'external-preexisting',
          installFingerprint: 'target-fingerprint-env',
          baselineBackup: null,
          baselineBackupBypass: null,
        },
      ],
      activeCandidateId: 'wrong-candidate-env',
      hasMultipleCandidates: false,
      historyDataCandidates: [],
      errors: [],
      warnings: [],
      defaultBackupDirectory: rootDir,
    })

    const result = await runOpenClawRestore('backup-target-env', 'config')

    expect(result.ok).toBe(true)
    expect(result.gatewayApply).toEqual({
      ok: true,
      requestedAction: 'hot-reload',
      appliedAction: 'hot-reload',
    })
  })

  it('forces a gateway restart when all-scope restore removes existing credentials', async () => {
    const archivePath = path.join(rootDir, 'backup-remove-credentials')
    const targetStateRoot = path.join(rootDir, 'target-home-remove-credentials')
    await fs.mkdir(path.join(archivePath, 'openclaw-home', 'memory'), { recursive: true })
    await fs.mkdir(path.join(targetStateRoot, 'credentials'), { recursive: true })

    await fs.writeFile(path.join(archivePath, 'openclaw-home', 'openclaw.json'), JSON.stringify({}, null, 2), 'utf8')
    await fs.writeFile(path.join(archivePath, 'openclaw-home', 'memory', 'note.txt'), 'memory', 'utf8')
    await fs.writeFile(path.join(targetStateRoot, 'openclaw.json'), JSON.stringify({}, null, 2), 'utf8')
    await fs.writeFile(path.join(targetStateRoot, 'credentials', 'token.json'), '{"token":"old"}', 'utf8')

    getOpenClawBackupEntryMock.mockResolvedValue({
      backupId: 'backup-remove-credentials',
      createdAt: '2026-03-20T00:00:00.000Z',
      archivePath,
      manifestPath: path.join(archivePath, 'manifest.json'),
      type: 'manual-backup',
      installFingerprint: 'backup-fingerprint-remove-credentials',
      sourceVersion: '2026.3.13',
      sourceConfigPath: path.join(targetStateRoot, 'openclaw.json'),
      sourceStateRoot: targetStateRoot,
      scopeAvailability: {
        hasConfigData: true,
        hasMemoryData: true,
        hasEnvData: false,
        hasCredentialsData: false,
      },
    })
    discoverOpenClawInstallationsMock.mockResolvedValue({
      status: 'installed',
      candidates: [
        {
          candidateId: 'target-candidate-remove-credentials',
          binaryPath: '/tmp/openclaw-remove-credentials',
          resolvedBinaryPath: '/tmp/openclaw-remove-credentials',
          packageRoot: '/tmp',
          version: '2026.3.13',
          installSource: 'custom',
          isPathActive: true,
          configPath: path.join(targetStateRoot, 'openclaw.json'),
          stateRoot: targetStateRoot,
          displayConfigPath: path.join(targetStateRoot, 'openclaw.json'),
          displayStateRoot: targetStateRoot,
          ownershipState: 'external-preexisting',
          installFingerprint: 'target-fingerprint-remove-credentials',
          baselineBackup: null,
          baselineBackupBypass: null,
        },
      ],
      activeCandidateId: 'target-candidate-remove-credentials',
      hasMultipleCandidates: false,
      historyDataCandidates: [],
      errors: [],
      warnings: [],
      defaultBackupDirectory: rootDir,
    })

    const result = await runOpenClawRestore('backup-remove-credentials', 'all')

    expect(result.ok).toBe(true)
    expect(reloadGatewayForConfigChangeMock).toHaveBeenCalledWith('restore-config', {
      preferEnsureWhenNotRunning: true,
    })
    expect(result.gatewayApply).toEqual({
      ok: true,
      requestedAction: 'restart',
      appliedAction: 'restart',
      note: 'Gateway restarted',
    })
    await expect(fs.access(path.join(targetStateRoot, 'credentials'))).rejects.toThrow()
  })

  it('reports restore as unsuccessful when runtime apply fails after files are restored', async () => {
    const archivePath = path.join(rootDir, 'backup-runtime-fail')
    const targetStateRoot = path.join(rootDir, 'target-home-runtime-fail')
    await fs.mkdir(path.join(archivePath, 'openclaw-home', 'credentials'), { recursive: true })
    await fs.mkdir(path.join(targetStateRoot, 'credentials'), { recursive: true })

    await fs.writeFile(
      path.join(archivePath, 'openclaw-home', 'openclaw.json'),
      JSON.stringify({}, null, 2),
      'utf8'
    )
    await fs.writeFile(path.join(targetStateRoot, 'openclaw.json'), JSON.stringify({}, null, 2), 'utf8')
    await fs.writeFile(
      path.join(archivePath, 'openclaw-home', 'credentials', 'token.json'),
      '{"token":"new"}',
      'utf8'
    )
    await fs.writeFile(
      path.join(targetStateRoot, 'credentials', 'token.json'),
      '{"token":"old"}',
      'utf8'
    )

    getOpenClawBackupEntryMock.mockResolvedValue({
      backupId: 'backup-runtime-fail',
      createdAt: '2026-03-20T00:00:00.000Z',
      archivePath,
      manifestPath: path.join(archivePath, 'manifest.json'),
      type: 'manual-backup',
      installFingerprint: 'backup-fingerprint-runtime-fail',
      sourceVersion: '2026.3.13',
      sourceConfigPath: path.join(targetStateRoot, 'openclaw.json'),
      sourceStateRoot: targetStateRoot,
      scopeAvailability: {
        hasConfigData: true,
        hasMemoryData: true,
        hasEnvData: false,
        hasCredentialsData: true,
      },
    })
    discoverOpenClawInstallationsMock.mockResolvedValue({
      status: 'installed',
      candidates: [
        {
          candidateId: 'target-candidate-runtime-fail',
          binaryPath: '/tmp/openclaw-runtime-fail',
          resolvedBinaryPath: '/tmp/openclaw-runtime-fail',
          packageRoot: '/tmp',
          version: '2026.3.13',
          installSource: 'custom',
          isPathActive: true,
          configPath: path.join(targetStateRoot, 'openclaw.json'),
          stateRoot: targetStateRoot,
          displayConfigPath: path.join(targetStateRoot, 'openclaw.json'),
          displayStateRoot: targetStateRoot,
          ownershipState: 'external-preexisting',
          installFingerprint: 'target-fingerprint-runtime-fail',
          baselineBackup: null,
          baselineBackupBypass: null,
        },
      ],
      activeCandidateId: 'target-candidate-runtime-fail',
      hasMultipleCandidates: false,
      historyDataCandidates: [],
      errors: [],
      warnings: [],
      defaultBackupDirectory: rootDir,
    })
    reloadGatewayForConfigChangeMock.mockResolvedValueOnce({
      ok: false,
      stdout: '',
      stderr: 'restart failed',
      code: 1,
    })

    const result = await runOpenClawRestore('backup-runtime-fail', 'config')

    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('runtime_apply_failed')
    expect(result.restoredItems).toContain('已恢复 openclaw.json')
    expect(result.restoredItems).toContain('已恢复 credentials 目录')
    expect(result.message).toContain('运行时生效失败')
    expect(reloadGatewayForConfigChangeMock).toHaveBeenCalledWith('restore-config', {
      preferEnsureWhenNotRunning: true,
    })
    await expect(fs.readFile(path.join(targetStateRoot, 'credentials', 'token.json'), 'utf8')).resolves.toContain('"new"')
  })
})

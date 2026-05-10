import { beforeEach, describe, expect, it, vi } from 'vitest'

import { OPENCLAW_NPM_REGISTRY_MIRRORS } from '../openclaw-download-fallbacks'

const TEST_HOME = process.env.HOME || '/Users/test'
const fs = process.getBuiltinModule('node:fs/promises') as typeof import('node:fs/promises')
const os = process.getBuiltinModule('node:os') as typeof import('node:os')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')

const {
  discoverOpenClawInstallationsMock,
  checkOpenClawLatestVersionMock,
  gatewayHealthMock,
  checkOpenClawMock,
  gatewayStartMock,
  readConfigMock,
  runCliMock,
  runDirectMock,
  runDoctorMock,
  runShellMock,
  writeConfigMock,
  createManagedBackupArchiveMock,
  ensureWritableOpenClawBackupRootDirectoryMock,
  ensureManagedOpenClawNpmRuntimeMock,
  createPrivilegedOpenClawNpmCommandOptionsMock,
  probeOpenClawInstallPathMock,
  isOpenClawInstallPermissionFailureResultMock,
  buildMacNpmCommandMock,
  runMacOpenClawElevatedLifecycleTransactionMock,
} = vi.hoisted(() => ({
  discoverOpenClawInstallationsMock: vi.fn(),
  checkOpenClawLatestVersionMock: vi.fn(),
  gatewayHealthMock: vi.fn(),
  checkOpenClawMock: vi.fn(),
  gatewayStartMock: vi.fn(),
  readConfigMock: vi.fn(),
  runCliMock: vi.fn(),
  runDirectMock: vi.fn(),
  runDoctorMock: vi.fn(),
  runShellMock: vi.fn(),
  writeConfigMock: vi.fn(),
  createManagedBackupArchiveMock: vi.fn(),
  ensureWritableOpenClawBackupRootDirectoryMock: vi.fn(),
  ensureManagedOpenClawNpmRuntimeMock: vi.fn(),
  createPrivilegedOpenClawNpmCommandOptionsMock: vi.fn(),
  probeOpenClawInstallPathMock: vi.fn(),
  isOpenClawInstallPermissionFailureResultMock: vi.fn(),
  buildMacNpmCommandMock: vi.fn(() => 'npm install -g openclaw'),
  runMacOpenClawElevatedLifecycleTransactionMock: vi.fn(),
}))

vi.mock('../openclaw-install-discovery', () => ({
  discoverOpenClawInstallations: discoverOpenClawInstallationsMock,
}))

vi.mock('../openclaw-latest-version-service', () => ({
  checkOpenClawLatestVersion: checkOpenClawLatestVersionMock,
}))

vi.mock('../cli', () => ({
  checkOpenClaw: checkOpenClawMock,
  gatewayHealth: gatewayHealthMock,
  gatewayStart: gatewayStartMock,
  readConfig: readConfigMock,
  runCli: runCliMock,
  runDirect: runDirectMock,
  runDoctor: runDoctorMock,
  runShell: runShellMock,
  writeConfig: writeConfigMock,
}))

vi.mock('../openclaw-backup-index', () => ({
  createManagedBackupArchive: createManagedBackupArchiveMock,
}))

vi.mock('../openclaw-backup-roots', () => ({
  ensureWritableOpenClawBackupRootDirectory: ensureWritableOpenClawBackupRootDirectoryMock,
}))

vi.mock('../node-runtime', () => ({
  buildMacNpmCommand: buildMacNpmCommandMock,
  buildAppleScriptDoShellScript: vi.fn((command: string) => command),
}))

vi.mock('../runtime-working-directory', () => ({
  resolveSafeWorkingDirectory: vi.fn(() => '/tmp'),
}))

vi.mock('../openclaw-install-permissions', () => ({
  probeOpenClawInstallPath: probeOpenClawInstallPathMock,
  isOpenClawInstallPermissionFailureResult: isOpenClawInstallPermissionFailureResultMock,
}))

vi.mock('../openclaw-npm-runtime', () => ({
  ensureManagedOpenClawNpmRuntime: ensureManagedOpenClawNpmRuntimeMock,
  createPrivilegedOpenClawNpmCommandOptions: createPrivilegedOpenClawNpmCommandOptionsMock,
}))

vi.mock('../openclaw-elevated-lifecycle-transaction', () => ({
  runMacOpenClawElevatedLifecycleTransaction: runMacOpenClawElevatedLifecycleTransactionMock,
}))

import { checkOpenClawUpgrade, runOpenClawUpgrade } from '../openclaw-upgrade-service'

const itOnDarwin = process.platform === 'darwin' ? it : it.skip

describe('openclaw upgrade service', () => {
  beforeEach(() => {
    discoverOpenClawInstallationsMock.mockReset()
    checkOpenClawLatestVersionMock.mockReset()
    gatewayHealthMock.mockReset()
    checkOpenClawMock.mockReset()
    gatewayStartMock.mockReset()
    readConfigMock.mockReset()
    runCliMock.mockReset()
    runDirectMock.mockReset()
    runDoctorMock.mockReset()
    runShellMock.mockReset()
    writeConfigMock.mockReset()
    createManagedBackupArchiveMock.mockReset()
    ensureWritableOpenClawBackupRootDirectoryMock.mockReset()
    ensureManagedOpenClawNpmRuntimeMock.mockReset()
    createPrivilegedOpenClawNpmCommandOptionsMock.mockReset()
    probeOpenClawInstallPathMock.mockReset()
    isOpenClawInstallPermissionFailureResultMock.mockReset()
    buildMacNpmCommandMock.mockReset()
    runMacOpenClawElevatedLifecycleTransactionMock.mockReset()
    gatewayHealthMock.mockResolvedValue({ running: true, raw: '{}' })
    checkOpenClawMock.mockResolvedValue({ installed: true, version: '2026.3.28' })
    gatewayStartMock.mockResolvedValue({ ok: true, stdout: '', stderr: '', code: 0 })
    readConfigMock.mockResolvedValue({
      gateway: {
        mode: 'local',
      },
    })
    runCliMock.mockResolvedValue({ ok: true, stdout: '', stderr: '', code: 0 })
    runDirectMock.mockResolvedValue({ ok: true, stdout: '', stderr: '', code: 0 })
    runDoctorMock.mockResolvedValue({ ok: true, stdout: 'doctor ok', stderr: '', code: 0 })
    runShellMock.mockResolvedValue({ ok: true, stdout: '', stderr: '', code: 0 })
    writeConfigMock.mockResolvedValue(undefined)
    ensureManagedOpenClawNpmRuntimeMock.mockResolvedValue({
      commandOptions: {
        userConfigPath: '/tmp/openclaw-installer/npm/user.npmrc',
        globalConfigPath: '/tmp/openclaw-installer/npm/global.npmrc',
        cachePath: '/tmp/openclaw-installer/npm/cache',
        fetchTimeoutMs: 30000,
        fetchRetries: 2,
        noAudit: true,
        noFund: true,
      },
    })
    createPrivilegedOpenClawNpmCommandOptionsMock.mockImplementation((options: Record<string, unknown>) => ({
      ...options,
      cachePath: '/private/tmp/qclaw-openclaw-admin-npm-upgrade-fallback/cache',
    }))
    createManagedBackupArchiveMock.mockResolvedValue({
      backupId: 'backup-1',
      createdAt: '2026-03-18T00:00:00.000Z',
      archivePath: '/tmp/openclaw-upgrade-backup',
      installFingerprint: 'fingerprint-2',
      scopeAvailability: {
        hasConfigData: true,
        hasEnvData: true,
        hasCredentialsData: true,
        hasMemoryData: false,
      },
    })
    ensureWritableOpenClawBackupRootDirectoryMock.mockResolvedValue({
      preferredRootDirectory: '/Users/test/Documents/Qclaw Lite Backups',
      fallbackRootDirectory: '/Users/test/.qclaw-lite/backups',
      effectiveRootDirectory: '/Users/test/Documents/Qclaw Lite Backups',
      usedFallbackRoot: false,
      warnings: [],
    })
    probeOpenClawInstallPathMock.mockImplementation(async (pathname: string) => ({
      displayPath: pathname,
      exists: true,
      writable: true,
      checkPath: pathname,
      ownerUid: 501,
      ownerMatchesCurrentUser: true,
    }))
    isOpenClawInstallPermissionFailureResultMock.mockImplementation((result: { ok: boolean; stdout?: string; stderr?: string }) => {
      if (result.ok) return false
      return /eacces|permission denied|operation not permitted/i.test(
        `${String(result.stderr || '')}\n${String(result.stdout || '')}`
      )
    })
    buildMacNpmCommandMock.mockImplementation(() => 'npm install -g openclaw')
    runMacOpenClawElevatedLifecycleTransactionMock.mockResolvedValue({
      ok: true,
      stdout: '',
      stderr: '',
      code: 0,
      status: 'success',
      snapshot: {
        operation: 'upgrade',
        stateRootPath: `${TEST_HOME}/.openclaw`,
        fallbackStateRootUsed: false,
        targets: [],
      },
      lifecycle: {
        ok: true,
        code: 0,
      },
      repair: {
        ok: true,
        code: 0,
      },
      verification: {
        ok: true,
        failures: [],
      },
    })
  })

  it('marks custom out-of-range installs as manual_block against the pinned target', async () => {
    discoverOpenClawInstallationsMock.mockResolvedValue({
      candidates: [
        {
          candidateId: 'candidate-1',
          binaryPath: '/opt/tools/openclaw/bin/openclaw',
          resolvedBinaryPath: '/opt/tools/openclaw/bin/openclaw',
          packageRoot: '/opt/tools/openclaw',
          version: '1.0.0',
          installSource: 'custom',
          isPathActive: true,
          configPath: '/Users/test/.openclaw/openclaw.json',
          stateRoot: '/Users/test/.openclaw',
          displayConfigPath: '~/.openclaw/openclaw.json',
          displayStateRoot: '~/.openclaw',
          ownershipState: 'external-preexisting',
          installFingerprint: 'fingerprint-1',
          baselineBackup: null,
          baselineBackupBypass: null,
        },
      ],
      warnings: [],
    })

    const result = await checkOpenClawUpgrade()

    expect(result.currentVersion).toBe('1.0.0')
    expect(result.targetVersion).toBe('2026.3.28')
    expect(result.policyState).toBe('below_min')
    expect(result.enforcement).toBe('manual_block')
    expect(result.targetAction).toBe('upgrade')
    expect(result.canAutoUpgrade).toBe(false)
    expect(result.errorCode).toBe('manual_only')
    expect(result.manualHint).toContain('2026.3.28')
  })

  it('allows supported-range installs to continue without depending on latest lookup', async () => {
    discoverOpenClawInstallationsMock.mockResolvedValue({
      candidates: [
        {
          candidateId: 'candidate-1',
          binaryPath: '/usr/local/bin/openclaw',
          resolvedBinaryPath: '/usr/local/bin/openclaw',
          packageRoot: '/usr/local/lib/node_modules/openclaw',
          version: '2026.3.23',
          installSource: 'npm-global',
          isPathActive: true,
          configPath: '/Users/test/.openclaw/openclaw.json',
          stateRoot: '/Users/test/.openclaw',
          displayConfigPath: '~/.openclaw/openclaw.json',
          displayStateRoot: '~/.openclaw',
          ownershipState: 'external-preexisting',
          installFingerprint: 'fingerprint-2',
          baselineBackup: null,
          baselineBackupBypass: null,
        },
      ],
      warnings: [],
    })

    const result = await checkOpenClawUpgrade()

    expect(result.ok).toBe(true)
    expect(result.policyState).toBe('supported_not_target')
    expect(result.enforcement).toBe('optional_upgrade')
    expect(result.targetAction).toBe('upgrade')
    expect(result.targetVersion).toBe('2026.3.28')
    expect(result.errorCode).toBeUndefined()
  })

  it('keeps supported custom installs usable while withholding in-app upgrade execution', async () => {
    discoverOpenClawInstallationsMock.mockResolvedValue({
      candidates: [
        {
          candidateId: 'candidate-1',
          binaryPath: '/opt/tools/openclaw/bin/openclaw',
          resolvedBinaryPath: '/opt/tools/openclaw/bin/openclaw',
          packageRoot: '/opt/tools/openclaw',
          version: '2026.3.23',
          installSource: 'custom',
          isPathActive: true,
          configPath: '/Users/test/.openclaw/openclaw.json',
          stateRoot: '/Users/test/.openclaw',
          displayConfigPath: '~/.openclaw/openclaw.json',
          displayStateRoot: '~/.openclaw',
          ownershipState: 'external-preexisting',
          installFingerprint: 'fingerprint-2',
          baselineBackup: null,
          baselineBackupBypass: null,
        },
      ],
      warnings: [],
    })

    const result = await checkOpenClawUpgrade()

    expect(result.ok).toBe(true)
    expect(result.policyState).toBe('supported_not_target')
    expect(result.enforcement).toBe('manual_block')
    expect(result.targetAction).toBe('upgrade')
    expect(result.blocksContinue).toBe(false)
    expect(result.canAutoUpgrade).toBe(false)
    expect(result.errorCode).toBeUndefined()
    expect(result.manualHint).toContain('2026.3.28')
  })

  it('manual-blocks installs whose version string cannot be parsed safely', async () => {
    discoverOpenClawInstallationsMock.mockResolvedValue({
      candidates: [
        {
          candidateId: 'candidate-parse-failure',
          binaryPath: '/usr/local/bin/openclaw',
          resolvedBinaryPath: '/usr/local/lib/node_modules/openclaw/openclaw.mjs',
          packageRoot: '/usr/local/lib/node_modules/openclaw',
          version: 'openclaw 2026.3.29 (custom build)',
          installSource: 'npm-global',
          isPathActive: true,
          configPath: '/Users/test/.openclaw/openclaw.json',
          stateRoot: '/Users/test/.openclaw',
          displayConfigPath: '~/.openclaw/openclaw.json',
          displayStateRoot: '~/.openclaw',
          ownershipState: 'external-preexisting',
          installFingerprint: 'fingerprint-parse-failure',
          baselineBackup: null,
          baselineBackupBypass: null,
        },
      ],
      warnings: [],
    })

    const result = await checkOpenClawUpgrade()

    expect(result.ok).toBe(false)
    expect(result.enforcement).toBe('manual_block')
    expect(result.targetAction).toBe('none')
    expect(result.errorCode).toBe('manual_only')
    expect(result.manualHint).toContain('版本号无法可靠解析')
  })

  it('falls back to npm upgrade when Homebrew reports openclaw is not installed but layout is npm-global', async () => {
    gatewayHealthMock.mockResolvedValue({ running: false, raw: '{}' })
    discoverOpenClawInstallationsMock.mockResolvedValue({
      candidates: [
        {
          candidateId: 'candidate-1',
          binaryPath: '/tmp/homebrew-bin/openclaw',
          resolvedBinaryPath: '/tmp/homebrew/lib/node_modules/openclaw/openclaw.mjs',
          packageRoot: '/tmp/homebrew/lib/node_modules/openclaw',
          version: '2026.3.8',
          installSource: 'homebrew',
          isPathActive: true,
          configPath: '/Users/test/.openclaw/openclaw.json',
          stateRoot: '/Users/test/.openclaw',
          displayConfigPath: '~/.openclaw/openclaw.json',
          displayStateRoot: '~/.openclaw',
          ownershipState: 'external-preexisting',
          installFingerprint: 'fingerprint-2',
          baselineBackup: null,
          baselineBackupBypass: null,
        },
      ],
      warnings: [],
    })
    checkOpenClawLatestVersionMock.mockResolvedValue({
      ok: true,
      latestVersion: '2026.3.28',
      checkedAt: '2026-03-18T10:00:00.000Z',
      source: 'npm-registry',
    })
    runShellMock.mockResolvedValueOnce({
      ok: true,
      stdout: 'added 1 package',
      stderr: '',
      code: 0,
    })
    checkOpenClawMock.mockResolvedValue({
      installed: true,
      version: '2026.3.28',
    })

    const result = await runOpenClawUpgrade()

    expect(result.ok).toBe(true)
    expect(runShellMock).toHaveBeenCalledTimes(1)
    expect(runShellMock).toHaveBeenNthCalledWith(
      1,
      'npm',
      expect.arrayContaining([
        'install',
        '-g',
        'openclaw@2026.3.28',
        '--registry=https://registry.npmmirror.com',
        '--userconfig=/tmp/openclaw-installer/npm/user.npmrc',
        '--globalconfig=/tmp/openclaw-installer/npm/global.npmrc',
        '--cache=/tmp/openclaw-installer/npm/cache',
        '--fetch-timeout=30000',
        '--fetch-retries=2',
        '--no-audit',
        '--no-fund',
      ]),
      expect.any(Number),
      'upgrade'
    )
  })

  it('continues upgrading when the snapshot root falls back to an app-owned directory', async () => {
    gatewayHealthMock.mockResolvedValue({ running: false, raw: '{}' })
    discoverOpenClawInstallationsMock.mockResolvedValue({
      candidates: [
        {
          candidateId: 'candidate-1',
          binaryPath: '/usr/local/bin/openclaw',
          resolvedBinaryPath: '/usr/local/lib/node_modules/openclaw/openclaw.mjs',
          packageRoot: '/usr/local/lib/node_modules/openclaw',
          version: '2026.3.21',
          installSource: 'npm-global',
          isPathActive: true,
          configPath: '/Users/test/.openclaw/openclaw.json',
          stateRoot: '/Users/test/.openclaw',
          displayConfigPath: '~/.openclaw/openclaw.json',
          displayStateRoot: '~/.openclaw',
          ownershipState: 'external-preexisting',
          installFingerprint: 'fingerprint-2',
          baselineBackup: null,
          baselineBackupBypass: null,
        },
      ],
      warnings: [],
    })
    checkOpenClawLatestVersionMock.mockResolvedValue({
      ok: true,
      latestVersion: '2026.3.28',
      checkedAt: '2026-03-18T10:00:00.000Z',
      source: 'npm-registry',
    })
    ensureWritableOpenClawBackupRootDirectoryMock.mockResolvedValue({
      preferredRootDirectory: '/Users/test/Documents/Qclaw Lite Backups',
      fallbackRootDirectory: '/Users/test/.qclaw-lite/backups',
      effectiveRootDirectory: '/Users/test/.qclaw-lite/backups',
      usedFallbackRoot: true,
      warnings: ['首选备份目录不可写，已自动改用 /Users/test/.qclaw-lite/backups。'],
    })
    runShellMock.mockResolvedValue({
      ok: true,
      stdout: 'added 1 package',
      stderr: '',
      code: 0,
    })
    checkOpenClawMock.mockResolvedValue({
      installed: true,
      version: '2026.3.28',
    })

    const result = await runOpenClawUpgrade()

    expect(result.ok).toBe(true)
    expect(result.warnings).toContain('首选备份目录不可写，已自动改用 /Users/test/.qclaw-lite/backups。')
    expect(createManagedBackupArchiveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        rootResolution: expect.objectContaining({
          effectiveRootDirectory: '/Users/test/.qclaw-lite/backups',
          usedFallbackRoot: true,
        }),
      })
    )
  })

  itOnDarwin('repairs ownership drift before upgrading user-managed installs', async () => {
    gatewayHealthMock.mockResolvedValue({ running: false, raw: '{}' })
    discoverOpenClawInstallationsMock.mockResolvedValue({
      candidates: [
        {
          candidateId: 'candidate-nvm',
          binaryPath: `${TEST_HOME}/.nvm/versions/node/v22.22.1/bin/openclaw`,
          resolvedBinaryPath: `${TEST_HOME}/.nvm/versions/node/v22.22.1/lib/node_modules/openclaw/openclaw.mjs`,
          packageRoot: `${TEST_HOME}/.nvm/versions/node/v22.22.1/lib/node_modules/openclaw`,
          version: '2026.3.13',
          installSource: 'nvm',
          isPathActive: true,
          configPath: `${TEST_HOME}/.openclaw/openclaw.json`,
          stateRoot: `${TEST_HOME}/.openclaw`,
          displayConfigPath: '~/.openclaw/openclaw.json',
          displayStateRoot: '~/.openclaw',
          ownershipState: 'external-preexisting',
          installFingerprint: 'fingerprint-nvm',
          baselineBackup: null,
          baselineBackupBypass: null,
        },
      ],
      warnings: [],
    })
    checkOpenClawLatestVersionMock.mockResolvedValue({
      ok: true,
      latestVersion: '2026.3.28',
      checkedAt: '2026-03-23T10:00:00.000Z',
      source: 'npm-registry',
    })
    probeOpenClawInstallPathMock.mockImplementation(async (pathname: string) => ({
      displayPath: pathname,
      exists: true,
      writable: pathname.includes('/bin/') ? true : true,
      checkPath: pathname,
      ownerUid: 0,
      ownerMatchesCurrentUser: false,
    }))
    runDirectMock.mockResolvedValueOnce({ ok: true, stdout: '', stderr: '', code: 0 })
    checkOpenClawMock.mockResolvedValue({ installed: true, version: '2026.3.28' })

    const result = await runOpenClawUpgrade()

    expect(result.ok).toBe(true)
    const repairCall = runMacOpenClawElevatedLifecycleTransactionMock.mock.calls[0]?.[0]
    expect(repairCall).toBeDefined()
    expect(repairCall?.operation).toBe('upgrade')
    expect(String(repairCall?.lifecycleCommand || '')).toContain('chown -R')
    const repairCommand = repairCall?.lifecycleCommand
    expect(String(repairCommand || '')).toContain(') && (')
    expect(String(repairCommand || '')).toContain(`${TEST_HOME}/.nvm/versions/node/v22.22.1/lib/node_modules`)
    expect(String(repairCommand || '')).toContain(`${TEST_HOME}/.nvm/versions/node/v22.22.1/bin`)
    expect(runShellMock).not.toHaveBeenCalledWith(
      'npm',
      expect.any(Array),
      expect.any(Number),
      'upgrade'
    )
  })

  itOnDarwin('falls back to ownership repair after permission failures on user-managed installs', async () => {
    gatewayHealthMock.mockResolvedValue({ running: false, raw: '{}' })
    discoverOpenClawInstallationsMock.mockResolvedValue({
      candidates: [
        {
          candidateId: 'candidate-nvm',
          binaryPath: `${TEST_HOME}/.nvm/versions/node/v22.22.1/bin/openclaw`,
          resolvedBinaryPath: `${TEST_HOME}/.nvm/versions/node/v22.22.1/lib/node_modules/openclaw/openclaw.mjs`,
          packageRoot: `${TEST_HOME}/.nvm/versions/node/v22.22.1/lib/node_modules/openclaw`,
          version: '2026.3.13',
          installSource: 'nvm',
          isPathActive: true,
          configPath: `${TEST_HOME}/.openclaw/openclaw.json`,
          stateRoot: `${TEST_HOME}/.openclaw`,
          displayConfigPath: '~/.openclaw/openclaw.json',
          displayStateRoot: '~/.openclaw',
          ownershipState: 'external-preexisting',
          installFingerprint: 'fingerprint-nvm',
          baselineBackup: null,
          baselineBackupBypass: null,
        },
      ],
      warnings: [],
    })
    checkOpenClawLatestVersionMock.mockResolvedValue({
      ok: true,
      latestVersion: '2026.3.28',
      checkedAt: '2026-03-23T10:00:00.000Z',
      source: 'npm-registry',
    })
    runShellMock.mockResolvedValue({
      ok: false,
      stdout: '',
      stderr:
        `npm error code EACCES\nnpm error syscall rename\nnpm error path ${TEST_HOME}/.nvm/versions/node/v22.22.1/lib/node_modules/openclaw`,
      code: 1,
    })
    runDirectMock.mockResolvedValueOnce({ ok: true, stdout: '', stderr: '', code: 0 })
    checkOpenClawMock.mockResolvedValue({ installed: true, version: '2026.3.28' })

    const result = await runOpenClawUpgrade()

    expect(result.ok).toBe(true)
    expect(runShellMock).toHaveBeenCalledTimes(OPENCLAW_NPM_REGISTRY_MIRRORS.length)
    const repairCommand = runMacOpenClawElevatedLifecycleTransactionMock.mock.calls[0]?.[0]?.lifecycleCommand
    expect(String(repairCommand || '')).toContain(') && (')
    expect(String(repairCommand || '')).toContain(`${TEST_HOME}/.nvm/versions/node/v22.22.1/lib/node_modules`)
  })

  it('cleans stale npm rename targets and retries the same mirror for user-managed downgrades', async () => {
    const tempRoot = await fs.mkdtemp(path.join(TEST_HOME, '.qclaw-openclaw-enotempty-'))
    const packageRoot = path.join(tempRoot, '.n', 'lib', 'node_modules', 'openclaw')
    const renameDest = path.join(tempRoot, '.n', 'lib', 'node_modules', 'openclaw-7uodeuGm')

    try {
      await fs.mkdir(packageRoot, { recursive: true })
      await fs.mkdir(renameDest, { recursive: true })
      await fs.writeFile(path.join(packageRoot, 'package.json'), '{"name":"openclaw"}', 'utf8')
      await fs.writeFile(path.join(renameDest, 'stale.txt'), 'stale', 'utf8')

      gatewayHealthMock.mockResolvedValue({ running: false, raw: '{}' })
      discoverOpenClawInstallationsMock.mockResolvedValue({
        candidates: [
          {
            candidateId: 'candidate-n',
            binaryPath: path.join(tempRoot, '.n', 'bin', 'openclaw'),
            resolvedBinaryPath: path.join(packageRoot, 'openclaw.mjs'),
            packageRoot,
            version: '2026.3.31',
            installSource: 'npm-global',
            isPathActive: true,
            configPath: path.join(tempRoot, '.openclaw', 'openclaw.json'),
            stateRoot: path.join(tempRoot, '.openclaw'),
            displayConfigPath: '~/.openclaw/openclaw.json',
            displayStateRoot: '~/.openclaw',
            ownershipState: 'external-preexisting',
            installFingerprint: 'fingerprint-n',
            baselineBackup: null,
            baselineBackupBypass: null,
          },
        ],
        warnings: [],
      })
      runShellMock
        .mockResolvedValueOnce({
          ok: false,
          stdout: '',
          stderr: [
            'npm error code ENOTEMPTY',
            'npm error syscall rename',
            `npm error path ${packageRoot}`,
            `npm error dest ${renameDest}`,
            `npm error ENOTEMPTY: directory not empty, rename '${packageRoot}' -> '${renameDest}'`,
          ].join('\n'),
          code: 1,
        })
        .mockResolvedValueOnce({
          ok: true,
          stdout: 'changed 1 package',
          stderr: '',
          code: 0,
        })
      checkOpenClawMock.mockResolvedValue({ installed: true, version: '2026.3.24' })

      const result = await runOpenClawUpgrade()

      expect(result.ok).toBe(true)
      expect(runShellMock).toHaveBeenCalledTimes(2)
      const firstCallArgs = (runShellMock.mock.calls[0]?.[1] as string[] | undefined) || []
      const secondCallArgs = (runShellMock.mock.calls[1]?.[1] as string[] | undefined) || []
      expect(firstCallArgs).toContain('--registry=https://registry.npmmirror.com')
      expect(secondCallArgs).toContain('--registry=https://registry.npmmirror.com')
      await expect(fs.access(packageRoot)).resolves.toBeUndefined()
      await expect(fs.access(renameDest)).rejects.toThrow()
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('blocks the upgrade when both snapshot roots are unavailable', async () => {
    gatewayHealthMock.mockResolvedValue({ running: false, raw: '{}' })
    discoverOpenClawInstallationsMock.mockResolvedValue({
      candidates: [
        {
          candidateId: 'candidate-1',
          binaryPath: '/usr/local/bin/openclaw',
          resolvedBinaryPath: '/usr/local/lib/node_modules/openclaw/openclaw.mjs',
          packageRoot: '/usr/local/lib/node_modules/openclaw',
          version: '2026.3.21',
          installSource: 'npm-global',
          isPathActive: true,
          configPath: '/Users/test/.openclaw/openclaw.json',
          stateRoot: '/Users/test/.openclaw',
          displayConfigPath: '~/.openclaw/openclaw.json',
          displayStateRoot: '~/.openclaw',
          ownershipState: 'external-preexisting',
          installFingerprint: 'fingerprint-2',
          baselineBackup: null,
          baselineBackupBypass: null,
        },
      ],
      warnings: [],
    })
    checkOpenClawLatestVersionMock.mockResolvedValue({
      ok: true,
      latestVersion: '2026.3.28',
      checkedAt: '2026-03-18T10:00:00.000Z',
      source: 'npm-registry',
    })
    ensureWritableOpenClawBackupRootDirectoryMock.mockRejectedValue(
      new Error('OpenClaw 备份目录不可写。首选目录失败：/Users/test/Documents/Qclaw Lite Backups；备用目录失败：/Users/test/.qclaw-lite/backups')
    )

    const result = await runOpenClawUpgrade()

    expect(result.ok).toBe(false)
    expect(result.blocked).toBe(true)
    expect(result.errorCode).toBe('snapshot_failed')
    expect(createManagedBackupArchiveMock).not.toHaveBeenCalled()
    expect(result.message).toContain('OpenClaw 备份目录不可写')
  })

  itOnDarwin('maps elevated transaction snapshot failures to snapshot_failed at product level', async () => {
    gatewayHealthMock.mockResolvedValue({ running: false, raw: '{}' })
    discoverOpenClawInstallationsMock.mockResolvedValue({
      candidates: [
        {
          candidateId: 'candidate-1',
          binaryPath: '/usr/local/bin/openclaw',
          resolvedBinaryPath: '/usr/local/lib/node_modules/openclaw/openclaw.mjs',
          packageRoot: '/usr/local/lib/node_modules/openclaw',
          version: '2026.3.21',
          installSource: 'npm-global',
          isPathActive: true,
          configPath: '/Users/test/.openclaw/openclaw.json',
          stateRoot: '/Users/test/.openclaw',
          displayConfigPath: '~/.openclaw/openclaw.json',
          displayStateRoot: '~/.openclaw',
          ownershipState: 'external-preexisting',
          installFingerprint: 'fingerprint-2',
          baselineBackup: null,
          baselineBackupBypass: null,
        },
      ],
      warnings: [],
    })
    checkOpenClawLatestVersionMock.mockResolvedValue({
      ok: true,
      latestVersion: '2026.3.28',
      checkedAt: '2026-03-18T10:00:00.000Z',
      source: 'npm-registry',
    })
    runMacOpenClawElevatedLifecycleTransactionMock.mockResolvedValue({
      ok: false,
      stdout: '',
      stderr: 'repair snapshot failed',
      code: 1,
      status: 'snapshot_failed',
      snapshot: null,
      lifecycle: {
        ok: false,
        code: null,
      },
      repair: {
        ok: false,
        code: null,
      },
      verification: {
        ok: false,
        failures: [],
      },
    })

    const result = await runOpenClawUpgrade()

    expect(result.ok).toBe(false)
    expect(result.blocked).toBe(false)
    expect(result.errorCode).toBe('snapshot_failed')
    expect(result.message).toContain('repair snapshot failed')
  })

  itOnDarwin.each([
    'lifecycle_failed_environment_repaired',
    'post_repair_failed_after_lifecycle',
    'post_repair_verification_failed',
  ] as const)('surfaces %s at product level instead of collapsing to upgrade_failed', async (status) => {
    gatewayHealthMock.mockResolvedValue({ running: false, raw: '{}' })
    discoverOpenClawInstallationsMock.mockResolvedValue({
      candidates: [
        {
          candidateId: 'candidate-1',
          binaryPath: '/usr/local/bin/openclaw',
          resolvedBinaryPath: '/usr/local/lib/node_modules/openclaw/openclaw.mjs',
          packageRoot: '/usr/local/lib/node_modules/openclaw',
          version: '2026.3.21',
          installSource: 'npm-global',
          isPathActive: true,
          configPath: '/Users/test/.openclaw/openclaw.json',
          stateRoot: '/Users/test/.openclaw',
          displayConfigPath: '~/.openclaw/openclaw.json',
          displayStateRoot: '~/.openclaw',
          ownershipState: 'external-preexisting',
          installFingerprint: 'fingerprint-2',
          baselineBackup: null,
          baselineBackupBypass: null,
        },
      ],
      warnings: [],
    })
    checkOpenClawLatestVersionMock.mockResolvedValue({
      ok: true,
      latestVersion: '2026.3.28',
      checkedAt: '2026-03-18T10:00:00.000Z',
      source: 'npm-registry',
    })
    runMacOpenClawElevatedLifecycleTransactionMock.mockResolvedValue({
      ok: false,
      stdout: '',
      stderr: `transaction failed: ${status}`,
      code: 1,
      status,
      snapshot: {
        operation: 'upgrade',
        stateRootPath: '/Users/test/.openclaw',
        fallbackStateRootUsed: false,
        targets: [],
      },
      lifecycle: {
        ok: status !== 'lifecycle_failed_environment_repaired',
        code: status === 'lifecycle_failed_environment_repaired' ? 1 : 0,
      },
      repair: {
        ok: status !== 'post_repair_failed_after_lifecycle',
        code: status === 'post_repair_failed_after_lifecycle' ? 1 : 0,
      },
      verification: {
        ok: status !== 'post_repair_verification_failed',
        failures:
          status === 'post_repair_verification_failed'
            ? [
                {
                  role: 'stateRoot',
                  path: '/Users/test/.openclaw',
                  detail: 'owner mismatch',
                },
              ]
            : [],
      },
    })

    const result = await runOpenClawUpgrade()

    expect(result.ok).toBe(false)
    expect(result.blocked).toBe(false)
    expect(result.errorCode).toBe(status)
    expect(result.message).toContain(status)
  })

  it('treats a successful official doctor fix as a completed migration without post-fix keyword recheck', async () => {
    gatewayHealthMock.mockResolvedValue({ running: false, raw: '{}' })
    discoverOpenClawInstallationsMock.mockResolvedValue({
      candidates: [
        {
          candidateId: 'candidate-1',
          binaryPath: '/usr/local/bin/openclaw',
          resolvedBinaryPath: '/usr/local/lib/node_modules/openclaw/openclaw.mjs',
          packageRoot: '/usr/local/lib/node_modules/openclaw',
          version: '2026.3.13',
          installSource: 'npm-global',
          isPathActive: true,
          configPath: '/Users/test/.openclaw/openclaw.json',
          stateRoot: '/Users/test/.openclaw',
          displayConfigPath: '~/.openclaw/openclaw.json',
          displayStateRoot: '~/.openclaw',
          ownershipState: 'external-preexisting',
          installFingerprint: 'fingerprint-2',
          baselineBackup: null,
          baselineBackupBypass: null,
        },
      ],
      warnings: [],
    })
    checkOpenClawLatestVersionMock.mockResolvedValue({
      ok: true,
      latestVersion: '2026.3.22',
      checkedAt: '2026-03-24T10:00:00.000Z',
      source: 'npm-registry',
    })
    runShellMock.mockResolvedValue({
      ok: true,
      stdout: 'added 1 package',
      stderr: '',
      code: 0,
    })
    checkOpenClawMock.mockResolvedValue({ installed: true, version: '2026.3.28' })
    runDoctorMock
      .mockResolvedValueOnce({
        ok: false,
        stdout: 'Unknown config keys: defaultModel\nRun "openclaw doctor --fix" to remove these keys',
        stderr: '',
        code: 1,
      })
      .mockResolvedValueOnce({
        ok: true,
        stdout: 'Removed legacy browser config and unknown keys',
        stderr: '',
        code: 0,
      })
      .mockResolvedValueOnce({
        ok: false,
        stdout: 'Unknown config keys: defaultModel\nRun "openclaw doctor --fix" to remove these keys',
        stderr: '',
        code: 1,
      })

    const result = await runOpenClawUpgrade()

    expect(result.ok).toBe(true)
    expect(runDoctorMock).toHaveBeenNthCalledWith(1)
    expect(runDoctorMock).toHaveBeenNthCalledWith(2, { fix: true })
    expect(runDoctorMock).toHaveBeenCalledTimes(2)
    expect(result.message).toContain('官方迁移执行完成')
    expect(result.message).toContain('Removed legacy browser config and unknown keys')
  })

  it('skips doctor --fix after upgrade when the official self-check is already clean', async () => {
    gatewayHealthMock.mockResolvedValue({ running: false, raw: '{}' })
    discoverOpenClawInstallationsMock.mockResolvedValue({
      candidates: [
        {
          candidateId: 'candidate-1',
          binaryPath: '/usr/local/bin/openclaw',
          resolvedBinaryPath: '/usr/local/lib/node_modules/openclaw/openclaw.mjs',
          packageRoot: '/usr/local/lib/node_modules/openclaw',
          version: '2026.3.13',
          installSource: 'npm-global',
          isPathActive: true,
          configPath: '/Users/test/.openclaw/openclaw.json',
          stateRoot: '/Users/test/.openclaw',
          displayConfigPath: '~/.openclaw/openclaw.json',
          displayStateRoot: '~/.openclaw',
          ownershipState: 'external-preexisting',
          installFingerprint: 'fingerprint-2',
          baselineBackup: null,
          baselineBackupBypass: null,
        },
      ],
      warnings: [],
    })
    checkOpenClawLatestVersionMock.mockResolvedValue({
      ok: true,
      latestVersion: '2026.3.28',
      checkedAt: '2026-03-24T10:00:00.000Z',
      source: 'npm-registry',
    })
    runShellMock.mockResolvedValue({
      ok: true,
      stdout: 'added 1 package',
      stderr: '',
      code: 0,
    })
    checkOpenClawMock.mockResolvedValue({ installed: true, version: '2026.3.28' })
    runDoctorMock.mockResolvedValue({
      ok: true,
      stdout: 'doctor ok',
      stderr: '',
      code: 0,
    })

    const result = await runOpenClawUpgrade()

    expect(result.ok).toBe(true)
    expect(runDoctorMock).toHaveBeenCalledTimes(1)
    expect(runDoctorMock).toHaveBeenNthCalledWith(1)
    expect(result.message).toContain('已跳过 doctor --fix')
  })

  it('rolls back to the pre-repair config snapshot when official doctor fix fails after upgrade', async () => {
    gatewayHealthMock.mockResolvedValue({ running: false, raw: '{}' })
    discoverOpenClawInstallationsMock.mockResolvedValue({
      candidates: [
        {
          candidateId: 'candidate-1',
          binaryPath: '/usr/local/bin/openclaw',
          resolvedBinaryPath: '/usr/local/lib/node_modules/openclaw/openclaw.mjs',
          packageRoot: '/usr/local/lib/node_modules/openclaw',
          version: '2026.3.13',
          installSource: 'npm-global',
          isPathActive: true,
          configPath: '/Users/test/.openclaw/openclaw.json',
          stateRoot: '/Users/test/.openclaw',
          displayConfigPath: '~/.openclaw/openclaw.json',
          displayStateRoot: '~/.openclaw',
          ownershipState: 'external-preexisting',
          installFingerprint: 'fingerprint-2',
          baselineBackup: null,
          baselineBackupBypass: null,
        },
      ],
      warnings: [],
    })
    checkOpenClawLatestVersionMock.mockResolvedValue({
      ok: true,
      latestVersion: '2026.3.28',
      checkedAt: '2026-03-24T10:00:00.000Z',
      source: 'npm-registry',
    })
    runShellMock.mockResolvedValue({
      ok: true,
      stdout: 'added 1 package',
      stderr: '',
      code: 0,
    })
    checkOpenClawMock.mockResolvedValue({ installed: true, version: '2026.3.28' })
    runDoctorMock
      .mockResolvedValueOnce({
        ok: false,
        stdout: 'Run "openclaw doctor --fix" to migrate the browser config',
        stderr: '',
        code: 1,
      })
      .mockResolvedValueOnce({
        ok: false,
        stdout: '',
        stderr: 'repair failed',
        code: 1,
      })

    const result = await runOpenClawUpgrade()

    expect(result.ok).toBe(false)
    expect(writeConfigMock).toHaveBeenCalledWith({
      gateway: {
        mode: 'local',
      },
    })
    expect(result.message).toContain('已回滚到修复前配置快照')
  })

  it('restores the full state snapshot for auto-correct repairs when doctor fix fails', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'openclaw-upgrade-rollback-'))
    const stateRoot = path.join(tempRoot, 'live-home')
    const backupArchive = path.join(tempRoot, 'backup')

    try {
      await fs.mkdir(path.join(stateRoot, 'credentials'), { recursive: true })
      await fs.writeFile(path.join(stateRoot, 'openclaw.json'), JSON.stringify({ gateway: { mode: 'broken' } }, null, 2), 'utf8')
      await fs.writeFile(path.join(stateRoot, '.env'), 'API_KEY=broken\n', 'utf8')
      await fs.writeFile(path.join(stateRoot, 'credentials', 'token.json'), '{"token":"broken"}', 'utf8')

      await fs.mkdir(path.join(backupArchive, 'openclaw-home', 'credentials'), { recursive: true })
      await fs.writeFile(
        path.join(backupArchive, 'openclaw-home', 'openclaw.json'),
        JSON.stringify({ gateway: { mode: 'local' } }, null, 2),
        'utf8'
      )
      await fs.writeFile(path.join(backupArchive, 'openclaw-home', '.env'), 'API_KEY=restored\n', 'utf8')
      await fs.writeFile(
        path.join(backupArchive, 'openclaw-home', 'credentials', 'token.json'),
        '{"token":"restored"}',
        'utf8'
      )

      gatewayHealthMock.mockResolvedValue({ running: false, raw: '{}' })
      discoverOpenClawInstallationsMock.mockResolvedValue({
        candidates: [
          {
            candidateId: 'candidate-rollback',
            binaryPath: '/usr/local/bin/openclaw',
            resolvedBinaryPath: '/usr/local/lib/node_modules/openclaw/openclaw.mjs',
            packageRoot: '/usr/local/lib/node_modules/openclaw',
            version: '2026.3.13',
            installSource: 'npm-global',
            isPathActive: true,
            configPath: path.join(stateRoot, 'openclaw.json'),
            stateRoot,
            displayConfigPath: '~/.openclaw/openclaw.json',
            displayStateRoot: '~/.openclaw',
            ownershipState: 'qclaw-installed',
            installFingerprint: 'fingerprint-rollback',
            baselineBackup: null,
            baselineBackupBypass: null,
          },
        ],
        warnings: [],
      })
      createManagedBackupArchiveMock.mockResolvedValue({
        backupId: 'backup-rollback',
        createdAt: '2026-03-18T00:00:00.000Z',
        archivePath: backupArchive,
        installFingerprint: 'fingerprint-rollback',
        scopeAvailability: {
          hasConfigData: true,
          hasEnvData: true,
          hasCredentialsData: true,
          hasMemoryData: true,
        },
      })
      runShellMock.mockResolvedValue({
        ok: true,
        stdout: 'added 1 package',
        stderr: '',
        code: 0,
      })
      checkOpenClawMock.mockResolvedValue({ installed: true, version: '2026.3.28' })
      runDoctorMock
        .mockResolvedValueOnce({
          ok: false,
          stdout: 'Run "openclaw doctor --fix" to migrate the browser config',
          stderr: '',
          code: 1,
        })
        .mockResolvedValueOnce({
          ok: false,
          stdout: '',
          stderr: 'repair failed',
          code: 1,
        })

      const result = await runOpenClawUpgrade()

      expect(result.ok).toBe(false)
      expect(createManagedBackupArchiveMock).toHaveBeenCalledWith(
        expect.objectContaining({
          copyMode: 'full-state',
        })
      )
      await expect(fs.readFile(path.join(stateRoot, 'openclaw.json'), 'utf8')).resolves.toContain('"local"')
      await expect(fs.readFile(path.join(stateRoot, '.env'), 'utf8')).resolves.toContain('API_KEY=restored')
      await expect(fs.readFile(path.join(stateRoot, 'credentials', 'token.json'), 'utf8')).resolves.toContain(
        '"restored"'
      )
      expect(writeConfigMock).not.toHaveBeenCalled()
      expect(result.message).toContain('已回滚到修复前配置快照')
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('restores config-only env and credentials snapshots when doctor fix fails after an in-range upgrade', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'openclaw-upgrade-config-rollback-'))
    const stateRoot = path.join(tempRoot, 'live-home')
    const backupArchive = path.join(tempRoot, 'backup')

    try {
      await fs.mkdir(path.join(stateRoot, 'credentials'), { recursive: true })
      await fs.writeFile(path.join(stateRoot, '.env'), 'API_KEY=broken\n', 'utf8')
      await fs.writeFile(path.join(stateRoot, 'credentials', 'token.json'), '{"token":"broken"}', 'utf8')

      await fs.mkdir(path.join(backupArchive, 'credentials'), { recursive: true })
      await fs.writeFile(
        path.join(backupArchive, 'openclaw.json'),
        JSON.stringify({ gateway: { mode: 'local' } }, null, 2),
        'utf8'
      )
      await fs.writeFile(path.join(backupArchive, '.env'), 'API_KEY=restored\n', 'utf8')
      await fs.writeFile(path.join(backupArchive, 'credentials', 'token.json'), '{"token":"restored"}', 'utf8')

      gatewayHealthMock.mockResolvedValue({ running: false, raw: '{}' })
      discoverOpenClawInstallationsMock.mockResolvedValue({
        candidates: [
          {
            candidateId: 'candidate-config-rollback',
            binaryPath: '/usr/local/bin/openclaw',
            resolvedBinaryPath: '/usr/local/lib/node_modules/openclaw/openclaw.mjs',
            packageRoot: '/usr/local/lib/node_modules/openclaw',
            version: '2026.3.23',
            installSource: 'npm-global',
            isPathActive: true,
            configPath: path.join(stateRoot, 'openclaw.json'),
            stateRoot,
            displayConfigPath: '~/.openclaw/openclaw.json',
            displayStateRoot: '~/.openclaw',
            ownershipState: 'external-preexisting',
            installFingerprint: 'fingerprint-config-rollback',
            baselineBackup: null,
            baselineBackupBypass: null,
          },
        ],
        warnings: [],
      })
      createManagedBackupArchiveMock.mockResolvedValue({
        backupId: 'backup-config-rollback',
        createdAt: '2026-03-18T00:00:00.000Z',
        archivePath: backupArchive,
        installFingerprint: 'fingerprint-config-rollback',
        scopeAvailability: {
          hasConfigData: true,
          hasEnvData: true,
          hasCredentialsData: true,
          hasMemoryData: false,
        },
      })
      runShellMock.mockResolvedValue({
        ok: true,
        stdout: 'added 1 package',
        stderr: '',
        code: 0,
      })
      checkOpenClawMock.mockResolvedValue({ installed: true, version: '2026.3.28' })
      runDoctorMock
        .mockResolvedValueOnce({
          ok: false,
          stdout: 'Run "openclaw doctor --fix" to migrate the browser config',
          stderr: '',
          code: 1,
        })
        .mockResolvedValueOnce({
          ok: false,
          stdout: '',
          stderr: 'repair failed',
          code: 1,
        })

      const result = await runOpenClawUpgrade()

      expect(result.ok).toBe(false)
      expect(createManagedBackupArchiveMock).toHaveBeenCalledWith(
        expect.objectContaining({
          copyMode: 'config-only',
        })
      )
      await expect(fs.readFile(path.join(stateRoot, '.env'), 'utf8')).resolves.toContain('API_KEY=restored')
      await expect(fs.readFile(path.join(stateRoot, 'credentials', 'token.json'), 'utf8')).resolves.toContain(
        '"restored"'
      )
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('restores external config files alongside the full-state snapshot when doctor fix fails', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'openclaw-upgrade-external-config-rollback-'))
    const stateRoot = path.join(tempRoot, 'live-home')
    const configRoot = path.join(tempRoot, 'external-config')
    const backupArchive = path.join(tempRoot, 'backup')
    const externalConfigPath = path.join(configRoot, 'openclaw.json')

    try {
      await fs.mkdir(path.join(stateRoot, 'credentials'), { recursive: true })
      await fs.mkdir(configRoot, { recursive: true })
      await fs.writeFile(externalConfigPath, JSON.stringify({ gateway: { mode: 'broken' } }, null, 2), 'utf8')
      await fs.writeFile(path.join(stateRoot, '.env'), 'API_KEY=broken\n', 'utf8')
      await fs.writeFile(path.join(stateRoot, 'credentials', 'token.json'), '{"token":"broken"}', 'utf8')

      await fs.mkdir(path.join(backupArchive, 'openclaw-home', 'credentials'), { recursive: true })
      await fs.writeFile(path.join(backupArchive, 'openclaw-home', '.env'), 'API_KEY=restored\n', 'utf8')
      await fs.writeFile(
        path.join(backupArchive, 'openclaw-home', 'credentials', 'token.json'),
        '{"token":"restored"}',
        'utf8'
      )
      await fs.writeFile(
        path.join(backupArchive, 'openclaw.json'),
        JSON.stringify({ gateway: { mode: 'local' } }, null, 2),
        'utf8'
      )

      gatewayHealthMock.mockResolvedValue({ running: false, raw: '{}' })
      discoverOpenClawInstallationsMock.mockResolvedValue({
        candidates: [
          {
            candidateId: 'candidate-external-config-rollback',
            binaryPath: '/usr/local/bin/openclaw',
            resolvedBinaryPath: '/usr/local/lib/node_modules/openclaw/openclaw.mjs',
            packageRoot: '/usr/local/lib/node_modules/openclaw',
            version: '2026.3.13',
            installSource: 'npm-global',
            isPathActive: true,
            configPath: externalConfigPath,
            stateRoot,
            displayConfigPath: '~/.config/openclaw.json',
            displayStateRoot: '~/.openclaw',
            ownershipState: 'qclaw-installed',
            installFingerprint: 'fingerprint-external-config-rollback',
            baselineBackup: null,
            baselineBackupBypass: null,
          },
        ],
        warnings: [],
      })
      createManagedBackupArchiveMock.mockResolvedValue({
        backupId: 'backup-external-config-rollback',
        createdAt: '2026-03-18T00:00:00.000Z',
        archivePath: backupArchive,
        installFingerprint: 'fingerprint-external-config-rollback',
        scopeAvailability: {
          hasConfigData: true,
          hasEnvData: true,
          hasCredentialsData: true,
          hasMemoryData: true,
        },
      })
      runShellMock.mockResolvedValue({
        ok: true,
        stdout: 'added 1 package',
        stderr: '',
        code: 0,
      })
      checkOpenClawMock.mockResolvedValue({ installed: true, version: '2026.3.28' })
      runDoctorMock
        .mockResolvedValueOnce({
          ok: false,
          stdout: 'Run "openclaw doctor --fix" to migrate the browser config',
          stderr: '',
          code: 1,
        })
        .mockResolvedValueOnce({
          ok: false,
          stdout: '',
          stderr: 'repair failed',
          code: 1,
        })

      const result = await runOpenClawUpgrade()

      expect(result.ok).toBe(false)
      await expect(fs.readFile(externalConfigPath, 'utf8')).resolves.toContain('"local"')
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true })
    }
  })

  itOnDarwin('uses an isolated admin cache path for privileged npm-global upgrades', async () => {
    gatewayHealthMock.mockResolvedValue({ running: false, raw: '{}' })
    discoverOpenClawInstallationsMock.mockResolvedValue({
      candidates: [
        {
          candidateId: 'candidate-system',
          binaryPath: '/opt/homebrew/bin/openclaw',
          resolvedBinaryPath: '/opt/homebrew/lib/node_modules/openclaw/openclaw.mjs',
          packageRoot: '/opt/homebrew/lib/node_modules/openclaw',
          version: '2026.3.13',
          installSource: 'npm-global',
          isPathActive: true,
          configPath: `${TEST_HOME}/.openclaw/openclaw.json`,
          stateRoot: `${TEST_HOME}/.openclaw`,
          displayConfigPath: '~/.openclaw/openclaw.json',
          displayStateRoot: '~/.openclaw',
          ownershipState: 'external-preexisting',
          installFingerprint: 'fingerprint-system',
          baselineBackup: null,
          baselineBackupBypass: null,
        },
      ],
      warnings: [],
    })
    checkOpenClawLatestVersionMock.mockResolvedValue({
      ok: true,
      latestVersion: '2026.3.28',
      checkedAt: '2026-03-24T10:00:00.000Z',
      source: 'npm-registry',
    })
    checkOpenClawMock.mockResolvedValue({ installed: true, version: '2026.3.28' })

    const result = await runOpenClawUpgrade()

    expect(result.ok).toBe(true)
    expect(buildMacNpmCommandMock).toHaveBeenCalled()
    const adminInstallCall = buildMacNpmCommandMock.mock.calls.at(0) as unknown[] | undefined
    const adminInstallArgs = (adminInstallCall?.[0] as string[] | undefined) || []
    expect(adminInstallArgs).toEqual(expect.arrayContaining(['install', '-g', 'openclaw@2026.3.28']))
    expect(adminInstallArgs).not.toContain('--cache=/tmp/openclaw-installer/npm/cache')
    expect(adminInstallArgs.find((arg: string) => arg.startsWith('--cache='))).toBe(
      '--cache=/private/tmp/qclaw-openclaw-admin-npm-upgrade-fallback/cache'
    )
  })

  itOnDarwin('wraps privileged npm-global upgrades in a failure-safe transaction with status markers', async () => {
    gatewayHealthMock.mockResolvedValue({ running: false, raw: '{}' })
    discoverOpenClawInstallationsMock.mockResolvedValue({
      candidates: [
        {
          candidateId: 'candidate-system',
          binaryPath: '/opt/homebrew/bin/openclaw',
          resolvedBinaryPath: '/opt/homebrew/lib/node_modules/openclaw/openclaw.mjs',
          packageRoot: '/opt/homebrew/lib/node_modules/openclaw',
          version: '2026.3.13',
          installSource: 'npm-global',
          isPathActive: true,
          configPath: `${TEST_HOME}/.openclaw/openclaw.json`,
          stateRoot: `${TEST_HOME}/.openclaw`,
          displayConfigPath: '~/.openclaw/openclaw.json',
          displayStateRoot: '~/.openclaw',
          ownershipState: 'external-preexisting',
          installFingerprint: 'fingerprint-system',
          baselineBackup: null,
          baselineBackupBypass: null,
        },
      ],
      warnings: [],
    })
    checkOpenClawLatestVersionMock.mockResolvedValue({
      ok: true,
      latestVersion: '2026.3.28',
      checkedAt: '2026-03-24T10:00:00.000Z',
      source: 'npm-registry',
    })
    checkOpenClawMock.mockResolvedValue({ installed: true, version: '2026.3.28' })

    const result = await runOpenClawUpgrade()

    expect(result.ok).toBe(true)
    expect(runMacOpenClawElevatedLifecycleTransactionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'upgrade',
        preferredStateRootPath: `${TEST_HOME}/.openclaw`,
        includeManagedInstallerRoot: true,
        qclawSafeWorkDir: '/tmp',
      })
    )
    expect(String(runMacOpenClawElevatedLifecycleTransactionMock.mock.calls[0]?.[0]?.lifecycleCommand || '')).toContain('npm install -g openclaw')
  })
})

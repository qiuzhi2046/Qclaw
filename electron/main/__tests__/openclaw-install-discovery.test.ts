import { afterEach, describe, expect, it, vi } from 'vitest'
import { inferOpenClawInstallSource } from '../openclaw-install-discovery'

const fs = process.getBuiltinModule('fs') as typeof import('node:fs')
const os = process.getBuiltinModule('node:os') as typeof import('node:os')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')
const { createHash } = process.getBuiltinModule('node:crypto') as typeof import('node:crypto')

const {
  resolveOpenClawBinaryPathMock,
  readOpenClawPackageInfoMock,
  listExecutablePathCandidatesMock,
  getBaselineBackupStatusMock,
  getBaselineBackupBypassStatusMock,
  resolveRuntimeOpenClawPathsMock,
} = vi.hoisted(() => ({
  resolveOpenClawBinaryPathMock: vi.fn(),
  readOpenClawPackageInfoMock: vi.fn(),
  listExecutablePathCandidatesMock: vi.fn(),
  getBaselineBackupStatusMock: vi.fn(),
  getBaselineBackupBypassStatusMock: vi.fn(),
  resolveRuntimeOpenClawPathsMock: vi.fn(),
}))

vi.mock('../openclaw-package', () => ({
  resolveOpenClawBinaryPath: resolveOpenClawBinaryPathMock,
  readOpenClawPackageInfo: readOpenClawPackageInfoMock,
}))

vi.mock('../runtime-path-discovery', () => ({
  listExecutablePathCandidates: listExecutablePathCandidatesMock,
}))

vi.mock('../openclaw-baseline-backup-gate', async () => {
  const actual = await vi.importActual('../openclaw-baseline-backup-gate')
  return {
    ...(actual as object),
    getBaselineBackupStatus: getBaselineBackupStatusMock,
    getBaselineBackupBypassStatus: getBaselineBackupBypassStatusMock,
  }
})

vi.mock('../openclaw-runtime-paths', () => ({
  resolveRuntimeOpenClawPaths: resolveRuntimeOpenClawPathsMock,
}))

describe('inferOpenClawInstallSource', () => {
  it('detects Homebrew installs from Cellar paths', () => {
    expect(
      inferOpenClawInstallSource({
        binaryPath: '/opt/homebrew/bin/openclaw',
        resolvedBinaryPath: '/opt/homebrew/Cellar/openclaw/2026.3.8/bin/openclaw',
        packageRoot: '/opt/homebrew/Cellar/openclaw/2026.3.8/libexec/lib/node_modules/openclaw',
      })
    ).toBe('homebrew')
  })

  it('detects user-space Node manager installs', () => {
    expect(
      inferOpenClawInstallSource({
        binaryPath: '/Users/alice/.nvm/versions/node/v22.14.0/bin/openclaw',
      })
    ).toBe('nvm')
    expect(
      inferOpenClawInstallSource({
        binaryPath: '/Users/alice/.volta/bin/openclaw',
      })
    ).toBe('volta')
  })

  it('detects npm-global installs from common package layouts', () => {
    expect(
      inferOpenClawInstallSource({
        binaryPath: '/usr/local/bin/openclaw',
        packageRoot: '/usr/local/lib/node_modules/openclaw',
      })
    ).toBe('npm-global')
  })

  it('prefers npm-global when OpenClaw lives under node_modules even if Homebrew bin path is used', () => {
    expect(
      inferOpenClawInstallSource({
        binaryPath: '/opt/homebrew/bin/openclaw',
        resolvedBinaryPath: '/opt/homebrew/lib/node_modules/openclaw/openclaw.mjs',
        packageRoot: '/opt/homebrew/lib/node_modules/openclaw',
      })
    ).toBe('npm-global')
  })

  it('falls back to custom when it has enough path data but no known source signature', () => {
    expect(
      inferOpenClawInstallSource({
        binaryPath: '/opt/tools/openclaw/bin/openclaw',
        resolvedBinaryPath: '/opt/tools/openclaw/bin/openclaw',
        packageRoot: '/opt/tools/openclaw/app',
      })
    ).toBe('custom')
  })
})

describe('discoverOpenClawInstallations', () => {
  const tempDirs: string[] = []
  const originalUserDataDir = process.env.QCLAW_USER_DATA_DIR
  const originalHome = process.env.HOME
  const originalUserProfile = process.env.USERPROFILE

  function makeTempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qclaw-openclaw-discovery-'))
    tempDirs.push(dir)
    return dir
  }

  afterEach(() => {
    resolveOpenClawBinaryPathMock.mockReset()
    readOpenClawPackageInfoMock.mockReset()
    listExecutablePathCandidatesMock.mockReset()
    getBaselineBackupStatusMock.mockReset()
    getBaselineBackupBypassStatusMock.mockReset()
    resolveRuntimeOpenClawPathsMock.mockReset()
    if (originalUserDataDir === undefined) {
      delete process.env.QCLAW_USER_DATA_DIR
    } else {
      process.env.QCLAW_USER_DATA_DIR = originalUserDataDir
    }
    if (originalHome === undefined) {
      delete process.env.HOME
    } else {
      process.env.HOME = originalHome
    }
    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE
    } else {
      process.env.USERPROFILE = originalUserProfile
    }

    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()
      if (dir) fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('uses runtime-resolved config and state paths for externally managed installs', async () => {
    const installDir = makeTempDir()
    const stateRoot = path.join(installDir, 'profiles', 'team-a')
    fs.mkdirSync(stateRoot, { recursive: true })
    fs.writeFileSync(path.join(stateRoot, 'custom-openclaw.json'), '{}')

    const binaryPath = path.join(installDir, 'bin', 'openclaw')
    fs.mkdirSync(path.dirname(binaryPath), { recursive: true })
    fs.writeFileSync(binaryPath, '#!/bin/sh\n')

    resolveOpenClawBinaryPathMock.mockResolvedValue(binaryPath)
    listExecutablePathCandidatesMock.mockReturnValue([binaryPath])
    readOpenClawPackageInfoMock.mockResolvedValue({
      name: 'openclaw',
      version: '2026.3.12',
      packageRoot: '/usr/local/lib/node_modules/openclaw',
      packageJsonPath: '/usr/local/lib/node_modules/openclaw/package.json',
      binaryPath,
      resolvedBinaryPath: binaryPath,
    })
    resolveRuntimeOpenClawPathsMock.mockResolvedValue({
      homeDir: stateRoot,
      configFile: path.join(stateRoot, 'custom-openclaw.json'),
      envFile: path.join(stateRoot, '.env'),
      credentialsDir: path.join(stateRoot, 'credentials'),
      modelCatalogCacheFile: path.join(stateRoot, 'qclaw-model-catalog-cache.json'),
      displayHomeDir: stateRoot,
      displayConfigFile: path.join(stateRoot, 'custom-openclaw.json'),
      displayEnvFile: path.join(stateRoot, '.env'),
      displayCredentialsDir: path.join(stateRoot, 'credentials'),
      displayModelCatalogCacheFile: path.join(stateRoot, 'qclaw-model-catalog-cache.json'),
    })
    getBaselineBackupStatusMock.mockResolvedValue(null)
    getBaselineBackupBypassStatusMock.mockResolvedValue(null)

    const { discoverOpenClawInstallations } = await import('../openclaw-install-discovery')
    const result = await discoverOpenClawInstallations()

    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]).toMatchObject({
      version: '2026.3.12',
      configPath: path.join(stateRoot, 'custom-openclaw.json'),
      stateRoot,
      displayConfigPath: path.join(stateRoot, 'custom-openclaw.json'),
      displayStateRoot: stateRoot,
      ownershipState: 'external-preexisting',
    })
    expect(result.historyDataCandidates).toEqual([
      {
        path: stateRoot,
        displayPath: stateRoot,
        reason: 'runtime-state-root',
      },
    ])
  })

  it('attaches persisted manual-backup bypass guidance to the discovered candidate', async () => {
    const installDir = makeTempDir()
    const stateRoot = path.join(installDir, 'profiles', 'team-b')
    fs.mkdirSync(stateRoot, { recursive: true })
    fs.writeFileSync(path.join(stateRoot, 'custom-openclaw.json'), '{}')

    const binaryPath = path.join(installDir, 'bin', 'openclaw')
    fs.mkdirSync(path.dirname(binaryPath), { recursive: true })
    fs.writeFileSync(binaryPath, '#!/bin/sh\n')

    resolveOpenClawBinaryPathMock.mockResolvedValue(binaryPath)
    listExecutablePathCandidatesMock.mockReturnValue([binaryPath])
    readOpenClawPackageInfoMock.mockResolvedValue({
      name: 'openclaw',
      version: '2026.3.12',
      packageRoot: '/usr/local/lib/node_modules/openclaw',
      packageJsonPath: '/usr/local/lib/node_modules/openclaw/package.json',
      binaryPath,
      resolvedBinaryPath: binaryPath,
    })
    resolveRuntimeOpenClawPathsMock.mockResolvedValue({
      homeDir: stateRoot,
      configFile: path.join(stateRoot, 'custom-openclaw.json'),
      envFile: path.join(stateRoot, '.env'),
      credentialsDir: path.join(stateRoot, 'credentials'),
      modelCatalogCacheFile: path.join(stateRoot, 'qclaw-model-catalog-cache.json'),
      displayHomeDir: stateRoot,
      displayConfigFile: path.join(stateRoot, 'custom-openclaw.json'),
      displayEnvFile: path.join(stateRoot, '.env'),
      displayCredentialsDir: path.join(stateRoot, 'credentials'),
      displayModelCatalogCacheFile: path.join(stateRoot, 'qclaw-model-catalog-cache.json'),
    })
    getBaselineBackupStatusMock.mockResolvedValue(null)
    getBaselineBackupBypassStatusMock.mockResolvedValue({
      installFingerprint: 'persisted-bypass',
      skippedAt: '2026-03-14T06:00:00.000Z',
      reason: 'manual-backup-required',
      sourcePath: stateRoot,
      displaySourcePath: stateRoot,
      suggestedArchivePath: path.join('/tmp', 'manual-baseline'),
      displaySuggestedArchivePath: path.join('/tmp', 'manual-baseline'),
    })

    const { discoverOpenClawInstallations } = await import('../openclaw-install-discovery')
    const result = await discoverOpenClawInstallations()

    expect(result.candidates[0]?.baselineBackupBypass).toMatchObject({
      sourcePath: stateRoot,
      reason: 'manual-backup-required',
    })
  })

  it('treats legacy managed fingerprint lists as unverified and keeps preexisting installs external', async () => {
    const installDir = makeTempDir()
    const userDataDir = makeTempDir()
    process.env.QCLAW_USER_DATA_DIR = userDataDir

    const stateRoot = path.join(installDir, 'profiles', 'team-c')
    fs.mkdirSync(stateRoot, { recursive: true })
    fs.writeFileSync(path.join(stateRoot, 'openclaw.json'), '{}')

    const binaryPath = path.join(installDir, 'bin', 'openclaw')
    fs.mkdirSync(path.dirname(binaryPath), { recursive: true })
    fs.writeFileSync(binaryPath, '#!/bin/sh\n')

    resolveOpenClawBinaryPathMock.mockResolvedValue(binaryPath)
    listExecutablePathCandidatesMock.mockReturnValue([binaryPath])
    readOpenClawPackageInfoMock.mockResolvedValue({
      name: 'openclaw',
      version: '2026.3.12',
      packageRoot: path.join(installDir, 'lib', 'node_modules', 'openclaw'),
      packageJsonPath: path.join(installDir, 'lib', 'node_modules', 'openclaw', 'package.json'),
      binaryPath,
      resolvedBinaryPath: binaryPath,
    })
    resolveRuntimeOpenClawPathsMock.mockResolvedValue({
      homeDir: stateRoot,
      configFile: path.join(stateRoot, 'openclaw.json'),
      envFile: path.join(stateRoot, '.env'),
      credentialsDir: path.join(stateRoot, 'credentials'),
      modelCatalogCacheFile: path.join(stateRoot, 'qclaw-model-catalog-cache.json'),
      displayHomeDir: stateRoot,
      displayConfigFile: path.join(stateRoot, 'openclaw.json'),
      displayEnvFile: path.join(stateRoot, '.env'),
      displayCredentialsDir: path.join(stateRoot, 'credentials'),
      displayModelCatalogCacheFile: path.join(stateRoot, 'qclaw-model-catalog-cache.json'),
    })
    getBaselineBackupStatusMock.mockResolvedValue(null)
    getBaselineBackupBypassStatusMock.mockResolvedValue(null)

    const installFingerprint = createHash('sha256')
      .update([binaryPath, path.join(installDir, 'lib', 'node_modules', 'openclaw'), '2026.3.12', path.join(stateRoot, 'openclaw.json'), stateRoot].join('\n'))
      .digest('hex')

    const storeDir = path.join(userDataDir, 'data-guard')
    fs.mkdirSync(storeDir, { recursive: true })
    fs.writeFileSync(
      path.join(storeDir, 'managed-openclaw-installs.json'),
      JSON.stringify({
        version: 1,
        installFingerprints: [installFingerprint],
      }, null, 2)
    )

    const { discoverOpenClawInstallations } = await import('../openclaw-install-discovery')
    const result = await discoverOpenClawInstallations()

    expect(result.candidates[0]?.ownershipState).toBe('external-preexisting')
  })

  it('reports history-only when only historical state files exist', async () => {
    const homeDir = makeTempDir()
    process.env.HOME = homeDir
    process.env.USERPROFILE = homeDir

    const openClawHome = path.join(homeDir, '.openclaw')
    fs.mkdirSync(openClawHome, { recursive: true })
    fs.writeFileSync(path.join(openClawHome, 'openclaw.json'), '{}')

    resolveOpenClawBinaryPathMock.mockResolvedValue(null)
    listExecutablePathCandidatesMock.mockReturnValue([])

    const { discoverOpenClawInstallations } = await import('../openclaw-install-discovery')
    const result = await discoverOpenClawInstallations()

    expect(result.status).toBe('history-only')
    expect(result.candidates).toEqual([])
    expect(result.historyDataCandidates).toEqual([
      {
        path: openClawHome,
        displayPath: process.platform === 'win32' ? '~\\.openclaw' : '~/.openclaw',
        reason: 'default-home-dir',
      },
    ])
    expect(result.warnings).toContain('检测到历史 OpenClaw 数据，但当前机器缺少可执行 OpenClaw 运行环境。')
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { inferOpenClawInstallSource } from '../openclaw-install-discovery'
import { buildTestEnv } from './test-env'

const fs = process.getBuiltinModule('fs') as typeof import('node:fs')
const { EventEmitter } = process.getBuiltinModule('node:events') as typeof import('node:events')
const os = process.getBuiltinModule('node:os') as typeof import('node:os')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')
const { createHash } = process.getBuiltinModule('node:crypto') as typeof import('node:crypto')
type EventEmitterInstance = InstanceType<typeof EventEmitter>

const {
  resolveOpenClawBinaryPathMock,
  readOpenClawPackageInfoMock,
  listExecutablePathCandidatesMock,
  getBaselineBackupStatusMock,
  getBaselineBackupBypassStatusMock,
  resolveRuntimeOpenClawPathsMock,
  getSelectedWindowsActiveRuntimeSnapshotMock,
} = vi.hoisted(() => ({
  resolveOpenClawBinaryPathMock: vi.fn(),
  readOpenClawPackageInfoMock: vi.fn(),
  listExecutablePathCandidatesMock: vi.fn(),
  getBaselineBackupStatusMock: vi.fn(),
  getBaselineBackupBypassStatusMock: vi.fn(),
  resolveRuntimeOpenClawPathsMock: vi.fn(),
  getSelectedWindowsActiveRuntimeSnapshotMock: vi.fn(),
}))

const itOnWindows = process.platform === 'win32' ? it : it.skip

function writeManagedRuntimeVerificationArtifacts(baseDir: string, packageRoot: string): void {
  const nodeExecutable = path.join(baseDir, 'Qclaw', 'runtime', 'win32', 'node', 'v24.14.1', 'node.exe')
  fs.mkdirSync(packageRoot, { recursive: true })
  fs.writeFileSync(nodeExecutable, '')
  fs.writeFileSync(
    path.join(packageRoot, 'package.json'),
    JSON.stringify({
      name: 'openclaw',
      version: '2026.4.12',
    }, null, 2)
  )
  fs.writeFileSync(
    path.join(packageRoot, '.qclaw-managed-runtime.json'),
    JSON.stringify({
      generatedBy: 'qclaw',
      hostPackageRoot: packageRoot,
      nodeVersion: 'v24.14.1',
      schema: 'qclaw-managed-openclaw-runtime',
    }, null, 2)
  )
}

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

vi.mock('../windows-active-runtime', () => ({
  getSelectedWindowsActiveRuntimeSnapshot: getSelectedWindowsActiveRuntimeSnapshotMock,
}))

function createMockSpawnedProcess(result: {
  code?: number
  error?: Error
  stderr?: string
  stdout?: string
} = {}) {
  const proc = new EventEmitter() as EventEmitterInstance & {
    kill: () => void
    stderr: EventEmitterInstance
    stdout: EventEmitterInstance
  }
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  proc.kill = () => {}

  queueMicrotask(() => {
    if (result.stdout) proc.stdout.emit('data', result.stdout)
    if (result.stderr) proc.stderr.emit('data', result.stderr)
    if (result.error) {
      proc.emit('error', result.error)
      return
    }
    proc.emit('close', result.code ?? 0)
  })

  return proc
}

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

  it('detects Qclaw bundled installs from Windows resources paths', () => {
    expect(
      inferOpenClawInstallSource({
        binaryPath: 'D:\\qclaw\\resources\\cli\\openclaw.cmd',
        resolvedBinaryPath: 'D:\\qclaw\\resources\\cli\\openclaw.cmd',
        packageRoot: 'D:\\qclaw\\resources\\openclaw',
        platform: 'win32',
        resourcesPath: 'D:\\qclaw\\resources',
      })
    ).toBe('qclaw-bundled')
  })

  it('detects Qclaw managed installs from the Windows private runtime root', () => {
    expect(
      inferOpenClawInstallSource({
        binaryPath: 'C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\v24.14.1\\openclaw.cmd',
        resolvedBinaryPath: 'C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\v24.14.1\\openclaw.cmd',
        packageRoot: 'C:\\Users\\alice\\AppData\\Local\\Qclaw\\runtime\\win32\\node\\v24.14.1\\node_modules\\openclaw',
        platform: 'win32',
        env: buildTestEnv({
          LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local',
        }),
      })
    ).toBe('qclaw-managed')
  })

  it('keeps bundled path signatures Windows-only', () => {
    expect(
      inferOpenClawInstallSource({
        binaryPath: '/Applications/Qclaw.app/Contents/Resources/cli/openclaw',
        resolvedBinaryPath: '/Applications/Qclaw.app/Contents/Resources/cli/openclaw',
        packageRoot: '/Applications/Qclaw.app/Contents/Resources/openclaw',
        platform: 'darwin',
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

  async function withStubbedPlatform<T>(
    platform: NodeJS.Platform,
    callback: () => Promise<T>
  ): Promise<T> {
    const originalDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: platform })
    try {
      return await callback()
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(process, 'platform', originalDescriptor)
      }
    }
  }

  afterEach(() => {
    resolveOpenClawBinaryPathMock.mockReset()
    readOpenClawPackageInfoMock.mockReset()
    listExecutablePathCandidatesMock.mockReset()
    getBaselineBackupStatusMock.mockReset()
    getBaselineBackupBypassStatusMock.mockReset()
    resolveRuntimeOpenClawPathsMock.mockReset()
    getSelectedWindowsActiveRuntimeSnapshotMock.mockReset()
    getSelectedWindowsActiveRuntimeSnapshotMock.mockReturnValue(null)
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

  itOnWindows('attaches an active runtime snapshot to discovered Windows installs', async () => {
    const installDir = makeTempDir()
    const stateRoot = path.join(installDir, '.openclaw')
    const binaryPath = path.join(installDir, '.volta', 'bin', 'openclaw.cmd')
    const nodePath = path.join(installDir, '.volta', 'bin', 'node.exe')

    fs.mkdirSync(path.dirname(binaryPath), { recursive: true })
    fs.mkdirSync(path.dirname(nodePath), { recursive: true })
    fs.mkdirSync(stateRoot, { recursive: true })
    fs.writeFileSync(binaryPath, '@echo off\r\n')
    fs.writeFileSync(nodePath, '')

    resolveOpenClawBinaryPathMock.mockResolvedValue(binaryPath)
    listExecutablePathCandidatesMock.mockImplementation((target: string) => {
      if (target === 'node') return [nodePath]
      return [binaryPath]
    })
    readOpenClawPackageInfoMock.mockResolvedValue({
      name: 'openclaw',
      version: '2026.4.12',
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

    const { discoverOpenClawInstallations } = await import('../openclaw-install-discovery')
    const result = await discoverOpenClawInstallations()

    expect(result.candidates[0]?.activeRuntimeSnapshot).toMatchObject({
      openclawPath: binaryPath,
      nodePath,
      npmPrefix: path.dirname(binaryPath),
      configPath: path.join(stateRoot, 'openclaw.json'),
      stateDir: stateRoot,
      extensionsDir: path.join(stateRoot, 'extensions'),
    })
  })

  itOnWindows('prefers the global Program Files node when the openclaw shim lives under %APPDATA%\\npm', async () => {
    const installDir = makeTempDir()
    const stateRoot = path.join(installDir, '.openclaw')
    const binaryPath = path.join(installDir, 'AppData', 'Roaming', 'npm', 'openclaw.cmd')
    const nodePath = path.join(installDir, 'Program Files', 'nodejs', 'node.exe')

    fs.mkdirSync(path.dirname(binaryPath), { recursive: true })
    fs.mkdirSync(path.dirname(nodePath), { recursive: true })
    fs.mkdirSync(stateRoot, { recursive: true })
    fs.writeFileSync(binaryPath, '@echo off\r\n')
    fs.writeFileSync(nodePath, '')

    resolveOpenClawBinaryPathMock.mockResolvedValue(binaryPath)
    listExecutablePathCandidatesMock.mockImplementation((target: string) => {
      if (target === 'node') return [binaryPath, nodePath]
      return [binaryPath]
    })
    readOpenClawPackageInfoMock.mockResolvedValue({
      name: 'openclaw',
      version: '2026.4.12',
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

    const { discoverOpenClawInstallations } = await import('../openclaw-install-discovery')
    const result = await discoverOpenClawInstallations()

    expect(result.candidates[0]?.activeRuntimeSnapshot).toMatchObject({
      openclawPath: binaryPath,
      nodePath,
      npmPrefix: path.dirname(binaryPath),
      configPath: path.join(stateRoot, 'openclaw.json'),
      stateDir: stateRoot,
      extensionsDir: path.join(stateRoot, 'extensions'),
    })
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

  itOnWindows('treats Qclaw managed runtimes as qclaw-installed even before a verified fingerprint exists', async () => {
    const installDir = makeTempDir()
    const userDataDir = makeTempDir()
    process.env.QCLAW_USER_DATA_DIR = userDataDir
    process.env.LOCALAPPDATA = installDir

    const stateRoot = path.join(userDataDir, 'managed-openclaw')
    const binaryPath = path.join(installDir, 'Qclaw', 'runtime', 'win32', 'node', 'v24.14.1', 'openclaw.cmd')
    const packageRoot = path.join(installDir, 'Qclaw', 'runtime', 'win32', 'node', 'v24.14.1', 'node_modules', 'openclaw')

    fs.mkdirSync(path.dirname(binaryPath), { recursive: true })
    fs.mkdirSync(stateRoot, { recursive: true })
    fs.writeFileSync(binaryPath, '@echo off\r\n')
    fs.writeFileSync(path.join(stateRoot, 'openclaw.json'), '{}')
    writeManagedRuntimeVerificationArtifacts(installDir, packageRoot)

    resolveOpenClawBinaryPathMock.mockResolvedValue(binaryPath)
    listExecutablePathCandidatesMock.mockImplementation((target: string) => {
      if (target === 'node') return []
      return [binaryPath]
    })
    readOpenClawPackageInfoMock.mockResolvedValue({
      name: 'openclaw',
      version: '2026.4.12',
      packageRoot,
      packageJsonPath: path.join(packageRoot, 'package.json'),
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

    const { discoverOpenClawInstallations } = await import('../openclaw-install-discovery')
    const result = await discoverOpenClawInstallations()

    expect(result.candidates[0]).toMatchObject({
      installSource: 'qclaw-managed',
      ownershipState: 'qclaw-installed',
    })
  })

  itOnWindows('keeps reused external state on a Qclaw managed runtime eligible for baseline backup', async () => {
    const installDir = makeTempDir()
    const userDataDir = makeTempDir()
    process.env.QCLAW_USER_DATA_DIR = userDataDir
    process.env.LOCALAPPDATA = installDir

    const externalStateRoot = path.join(makeTempDir(), '.openclaw')
    const binaryPath = path.join(installDir, 'Qclaw', 'runtime', 'win32', 'node', 'v24.14.1', 'openclaw.cmd')
    const packageRoot = path.join(installDir, 'Qclaw', 'runtime', 'win32', 'node', 'v24.14.1', 'node_modules', 'openclaw')

    fs.mkdirSync(path.dirname(binaryPath), { recursive: true })
    fs.mkdirSync(externalStateRoot, { recursive: true })
    fs.writeFileSync(binaryPath, '@echo off\r\n')
    fs.writeFileSync(path.join(externalStateRoot, 'openclaw.json'), '{}')
    writeManagedRuntimeVerificationArtifacts(installDir, packageRoot)

    getSelectedWindowsActiveRuntimeSnapshotMock.mockReturnValue({
      configPath: path.join(externalStateRoot, 'openclaw.json'),
      extensionsDir: path.join(externalStateRoot, 'extensions'),
      hostPackageRoot: packageRoot,
      nodePath: path.join(installDir, 'Qclaw', 'runtime', 'win32', 'node', 'v24.14.1', 'node.exe'),
      npmPrefix: path.dirname(binaryPath),
      openclawPath: binaryPath,
      stateDir: externalStateRoot,
      userDataDir,
    })

    resolveOpenClawBinaryPathMock.mockResolvedValue(binaryPath)
    listExecutablePathCandidatesMock.mockImplementation((target: string) => {
      if (target === 'node') return []
      return [binaryPath]
    })
    readOpenClawPackageInfoMock.mockResolvedValue({
      name: 'openclaw',
      version: '2026.4.12',
      packageRoot,
      packageJsonPath: path.join(packageRoot, 'package.json'),
      binaryPath,
      resolvedBinaryPath: binaryPath,
    })
    resolveRuntimeOpenClawPathsMock.mockResolvedValue({
      homeDir: path.join(installDir, '.openclaw'),
      configFile: path.join(installDir, '.openclaw', 'openclaw.json'),
      envFile: path.join(installDir, '.openclaw', '.env'),
      credentialsDir: path.join(installDir, '.openclaw', 'credentials'),
      modelCatalogCacheFile: path.join(installDir, '.openclaw', 'qclaw-model-catalog-cache.json'),
      displayHomeDir: path.join(installDir, '.openclaw'),
      displayConfigFile: path.join(installDir, '.openclaw', 'openclaw.json'),
      displayEnvFile: path.join(installDir, '.openclaw', '.env'),
      displayCredentialsDir: path.join(installDir, '.openclaw', 'credentials'),
      displayModelCatalogCacheFile: path.join(installDir, '.openclaw', 'qclaw-model-catalog-cache.json'),
    })
    getBaselineBackupStatusMock.mockResolvedValue(null)
    getBaselineBackupBypassStatusMock.mockResolvedValue(null)

    const { discoverOpenClawInstallations } = await import('../openclaw-install-discovery')
    const result = await discoverOpenClawInstallations()

    expect(result.candidates[0]).toMatchObject({
      installSource: 'qclaw-managed',
      configPath: path.join(externalStateRoot, 'openclaw.json'),
      stateRoot: externalStateRoot,
      ownershipState: 'external-preexisting',
      baselineBackup: null,
    })
  })

  itOnWindows('does not treat every LOCALAPPDATA-backed state directory as qclaw-owned', async () => {
    const installDir = makeTempDir()
    const userDataDir = makeTempDir()
    process.env.QCLAW_USER_DATA_DIR = userDataDir
    process.env.LOCALAPPDATA = installDir

    const externalStateRoot = path.join(installDir, 'Vendor', 'OpenClawState')
    const binaryPath = path.join(installDir, 'Qclaw', 'runtime', 'win32', 'node', 'v24.14.1', 'openclaw.cmd')
    const packageRoot = path.join(installDir, 'Qclaw', 'runtime', 'win32', 'node', 'v24.14.1', 'node_modules', 'openclaw')

    fs.mkdirSync(path.dirname(binaryPath), { recursive: true })
    fs.mkdirSync(externalStateRoot, { recursive: true })
    fs.writeFileSync(binaryPath, '@echo off\r\n')
    fs.writeFileSync(path.join(externalStateRoot, 'openclaw.json'), '{}')
    writeManagedRuntimeVerificationArtifacts(installDir, packageRoot)

    getSelectedWindowsActiveRuntimeSnapshotMock.mockReturnValue({
      configPath: path.join(externalStateRoot, 'openclaw.json'),
      extensionsDir: path.join(externalStateRoot, 'extensions'),
      hostPackageRoot: packageRoot,
      nodePath: path.join(installDir, 'Qclaw', 'runtime', 'win32', 'node', 'v24.14.1', 'node.exe'),
      npmPrefix: path.dirname(binaryPath),
      openclawPath: binaryPath,
      stateDir: externalStateRoot,
      userDataDir,
    })

    resolveOpenClawBinaryPathMock.mockResolvedValue(binaryPath)
    listExecutablePathCandidatesMock.mockImplementation((target: string) => {
      if (target === 'node') return []
      return [binaryPath]
    })
    readOpenClawPackageInfoMock.mockResolvedValue({
      name: 'openclaw',
      version: '2026.4.12',
      packageRoot,
      packageJsonPath: path.join(packageRoot, 'package.json'),
      binaryPath,
      resolvedBinaryPath: binaryPath,
    })
    resolveRuntimeOpenClawPathsMock.mockResolvedValue({
      homeDir: path.join(installDir, '.openclaw'),
      configFile: path.join(installDir, '.openclaw', 'openclaw.json'),
      envFile: path.join(installDir, '.openclaw', '.env'),
      credentialsDir: path.join(installDir, '.openclaw', 'credentials'),
      modelCatalogCacheFile: path.join(installDir, '.openclaw', 'qclaw-model-catalog-cache.json'),
      displayHomeDir: path.join(installDir, '.openclaw'),
      displayConfigFile: path.join(installDir, '.openclaw', 'openclaw.json'),
      displayEnvFile: path.join(installDir, '.openclaw', '.env'),
      displayCredentialsDir: path.join(installDir, '.openclaw', 'credentials'),
      displayModelCatalogCacheFile: path.join(installDir, '.openclaw', 'qclaw-model-catalog-cache.json'),
    })
    getBaselineBackupStatusMock.mockResolvedValue(null)
    getBaselineBackupBypassStatusMock.mockResolvedValue(null)

    const { discoverOpenClawInstallations } = await import('../openclaw-install-discovery')
    const result = await discoverOpenClawInstallations()

    expect(result.candidates[0]).toMatchObject({
      installSource: 'qclaw-managed',
      configPath: path.join(externalStateRoot, 'openclaw.json'),
      stateRoot: externalStateRoot,
      ownershipState: 'external-preexisting',
    })
  })

  itOnWindows('persists a verified managed fingerprint when discovery recognizes a Qclaw managed runtime', async () => {
    const installDir = makeTempDir()
    const userDataDir = makeTempDir()
    process.env.QCLAW_USER_DATA_DIR = userDataDir
    process.env.LOCALAPPDATA = installDir

    const stateRoot = path.join(installDir, '.openclaw')
    const binaryPath = path.join(installDir, 'Qclaw', 'runtime', 'win32', 'node', 'v24.14.1', 'openclaw.cmd')
    const packageRoot = path.join(installDir, 'Qclaw', 'runtime', 'win32', 'node', 'v24.14.1', 'node_modules', 'openclaw')

    fs.mkdirSync(path.dirname(binaryPath), { recursive: true })
    fs.mkdirSync(stateRoot, { recursive: true })
    fs.writeFileSync(binaryPath, '@echo off\r\n')
    fs.writeFileSync(path.join(stateRoot, 'openclaw.json'), '{}')
    writeManagedRuntimeVerificationArtifacts(installDir, packageRoot)

    resolveOpenClawBinaryPathMock.mockResolvedValue(binaryPath)
    listExecutablePathCandidatesMock.mockImplementation((target: string) => {
      if (target === 'node') return []
      return [binaryPath]
    })
    readOpenClawPackageInfoMock.mockResolvedValue({
      name: 'openclaw',
      version: '2026.4.12',
      packageRoot,
      packageJsonPath: path.join(packageRoot, 'package.json'),
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
      .update([binaryPath, packageRoot, '2026.4.12', path.join(stateRoot, 'openclaw.json'), stateRoot].join('\n'))
      .digest('hex')

    const { discoverOpenClawInstallations } = await import('../openclaw-install-discovery')
    await discoverOpenClawInstallations()

    const storePath = path.join(userDataDir, 'data-guard', 'managed-openclaw-installs.json')
    const parsed = JSON.parse(fs.readFileSync(storePath, 'utf8'))

    expect(parsed).toEqual(
      expect.objectContaining({
        version: 2,
        entries: expect.arrayContaining([
          expect.objectContaining({
            installFingerprint,
            verified: true,
          }),
        ]),
      })
    )
  })

  itOnWindows('downgrades path-only managed runtimes to custom until the managed marker is verified', async () => {
    const installDir = makeTempDir()
    const userDataDir = makeTempDir()
    process.env.QCLAW_USER_DATA_DIR = userDataDir
    process.env.LOCALAPPDATA = installDir

    const stateRoot = path.join(installDir, '.openclaw')
    const binaryPath = path.join(installDir, 'Qclaw', 'runtime', 'win32', 'node', 'v24.14.1', 'openclaw.cmd')
    const packageRoot = path.join(installDir, 'Qclaw', 'runtime', 'win32', 'node', 'v24.14.1', 'node_modules', 'openclaw')

    fs.mkdirSync(path.dirname(binaryPath), { recursive: true })
    fs.mkdirSync(stateRoot, { recursive: true })
    fs.mkdirSync(packageRoot, { recursive: true })
    fs.writeFileSync(binaryPath, '@echo off\r\n')
    fs.writeFileSync(path.join(stateRoot, 'openclaw.json'), '{}')
    fs.writeFileSync(
      path.join(packageRoot, 'package.json'),
      JSON.stringify({
        name: 'openclaw',
        version: '2026.4.12',
      }, null, 2)
    )

    resolveOpenClawBinaryPathMock.mockResolvedValue(binaryPath)
    listExecutablePathCandidatesMock.mockImplementation((target: string) => {
      if (target === 'node') return []
      return [binaryPath]
    })
    readOpenClawPackageInfoMock.mockResolvedValue({
      name: 'openclaw',
      version: '2026.4.12',
      packageRoot,
      packageJsonPath: path.join(packageRoot, 'package.json'),
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

    const { discoverOpenClawInstallations } = await import('../openclaw-install-discovery')
    const result = await discoverOpenClawInstallations()

    expect(result.candidates[0]).toMatchObject({
      installSource: 'custom',
      ownershipState: 'external-preexisting',
    })
    expect(fs.existsSync(path.join(userDataDir, 'data-guard', 'managed-openclaw-installs.json'))).toBe(false)
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
    expect(result.warnings).toContain('检测到历史 OpenClaw 数据，但当前机器缺少可执行的 OpenClaw 环境。')
  })

  it('hides Windows console windows when version fallback probes discovered binaries', async () => {
    vi.resetModules()

    const installDir = makeTempDir()
    const stateRoot = path.join(installDir, '.openclaw')
    const binaryPath = path.join(installDir, 'AppData', 'Roaming', 'npm', 'openclaw.cmd')

    fs.mkdirSync(path.dirname(binaryPath), { recursive: true })
    fs.mkdirSync(stateRoot, { recursive: true })
    fs.writeFileSync(binaryPath, '@echo off\r\n')

    resolveOpenClawBinaryPathMock.mockResolvedValue(binaryPath)
    listExecutablePathCandidatesMock.mockImplementation((target: string) => {
      if (target === 'node') return []
      return [binaryPath]
    })
    readOpenClawPackageInfoMock.mockRejectedValue(new Error('package layout unavailable'))
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

    const spawnCalls: Array<{
      args: string[]
      command: string
      options: Record<string, unknown>
    }> = []
    const originalGetBuiltinModule = process.getBuiltinModule.bind(process)
    const getBuiltinModuleSpy = vi.spyOn(process, 'getBuiltinModule').mockImplementation(((
      id: Parameters<typeof process.getBuiltinModule>[0],
    ) => {
      if (id === 'node:child_process' || id === 'child_process') {
        const actual = originalGetBuiltinModule(id) as typeof import('node:child_process')
        return {
          ...actual,
          spawn: (command: string, args: string[], options: Record<string, unknown>) => {
            spawnCalls.push({ command, args, options })
            return createMockSpawnedProcess({
              code: 0,
              stdout: '2026.4.10\n',
            })
          },
        }
      }

      return originalGetBuiltinModule(id)
    }) as typeof process.getBuiltinModule)

    try {
      await withStubbedPlatform('win32', async () => {
        const discoveryModule = await import('../openclaw-install-discovery')
        const result = await discoveryModule.discoverOpenClawInstallations()

        expect(result.candidates).toHaveLength(1)
        expect(spawnCalls).toHaveLength(1)
        expect(spawnCalls[0]?.options).toMatchObject({
          shell: true,
          windowsHide: true,
        })
      })
    } finally {
      getBuiltinModuleSpy.mockRestore()
      vi.resetModules()
    }
  })
})

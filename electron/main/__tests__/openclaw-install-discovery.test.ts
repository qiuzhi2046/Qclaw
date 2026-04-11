import { afterEach, describe, expect, it, vi } from 'vitest'
import { inferOpenClawInstallSource } from '../openclaw-install-discovery'

const fs = process.getBuiltinModule('fs') as typeof import('node:fs')
const { EventEmitter } = process.getBuiltinModule('node:events') as typeof import('node:events')
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

const itOnWindows = process.platform === 'win32' ? it : it.skip

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

function createMockSpawnedProcess(result: {
  code?: number
  error?: Error
  stderr?: string
  stdout?: string
} = {}) {
  const proc = new EventEmitter() as EventEmitter & {
    kill: () => void
    stderr: EventEmitter
    stdout: EventEmitter
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
      version: '2026.3.24',
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
      version: '2026.3.24',
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
    const getBuiltinModuleSpy = vi.spyOn(process, 'getBuiltinModule').mockImplementation(((id) => {
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
      const discoveryModule = await import('../openclaw-install-discovery')
      const result = await discoveryModule.discoverOpenClawInstallations()

      expect(result.candidates).toHaveLength(1)
      expect(spawnCalls).toHaveLength(1)
      expect(spawnCalls[0]?.options).toMatchObject({
        shell: true,
        windowsHide: true,
      })
    } finally {
      getBuiltinModuleSpy.mockRestore()
      vi.resetModules()
    }
  })
})

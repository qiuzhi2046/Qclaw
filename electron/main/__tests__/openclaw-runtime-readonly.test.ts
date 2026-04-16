import { describe, expect, it, vi } from 'vitest'

import { clearDetectedNodeBinDir, setDetectedNodeBinDir } from '../detected-node-bin'
import {
  resolveOpenClawPathsForRead,
  resolveWindowsActiveRuntimeSnapshotForRead,
} from '../openclaw-runtime-readonly'

const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs')
const os = process.getBuiltinModule('node:os') as typeof import('node:os')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')

describe('resolveOpenClawPathsForRead', () => {
  it('uses the explicit Windows runtime snapshot without consulting the cached runtime reader', async () => {
    const snapshot = {
      nodePath: 'C:\\runtime\\node.exe',
      openclawPath: 'C:\\runtime\\openclaw.cmd',
      hostPackageRoot: 'C:\\runtime\\node_modules\\openclaw',
    } as any
    const getCachedRuntimeSnapshot = vi.fn(async () => null)
    const resolvePaths = vi.fn(async ({ activeRuntimeSnapshot }: { activeRuntimeSnapshot?: unknown }) => ({
      homeDir: 'C:\\Users\\qiuzh\\.openclaw',
      envFile: 'C:\\Users\\qiuzh\\.openclaw\\.env',
      configFile: 'C:\\Users\\qiuzh\\.openclaw\\openclaw.json',
      credentialsDir: 'C:\\Users\\qiuzh\\.openclaw\\credentials',
      modelCatalogCacheFile: 'C:\\Users\\qiuzh\\.openclaw\\qclaw-model-catalog-cache.json',
      displayHomeDir: '~\\.openclaw',
      displayEnvFile: '~\\.openclaw\\.env',
      displayConfigFile: '~\\.openclaw\\openclaw.json',
      displayCredentialsDir: '~\\.openclaw\\credentials',
      displayModelCatalogCacheFile: '~\\.openclaw\\qclaw-model-catalog-cache.json',
    }))

    const result = await resolveOpenClawPathsForRead({
      platform: 'win32',
      activeRuntimeSnapshot: snapshot,
      getCachedRuntimeSnapshot,
      resolvePaths,
    })

    expect(getCachedRuntimeSnapshot).not.toHaveBeenCalled()
    expect(resolvePaths).toHaveBeenCalledWith({
      activeRuntimeSnapshot: snapshot,
    })
    expect(result.homeDir).toContain('.openclaw')
  })

  it('derives the selected Windows runtime snapshot for read-only path resolution when the cache is empty', async () => {
    const snapshot = {
      nodePath: 'C:\\runtime\\node.exe',
      openclawPath: 'C:\\runtime\\openclaw.cmd',
      hostPackageRoot: 'C:\\runtime\\node_modules\\openclaw',
      configPath: 'C:\\Users\\qiuzh\\.openclaw\\openclaw.json',
      stateDir: 'C:\\Users\\qiuzh\\.openclaw',
      extensionsDir: 'C:\\Users\\qiuzh\\.openclaw\\extensions',
    } as any
    const resolveSelectedRuntimeSnapshot = vi.fn(async () => snapshot)
    const resolvePaths = vi.fn(async ({ activeRuntimeSnapshot }: { activeRuntimeSnapshot?: unknown }) => ({
      homeDir: 'C:\\Users\\qiuzh\\.openclaw',
      envFile: 'C:\\Users\\qiuzh\\.openclaw\\.env',
      configFile: 'C:\\Users\\qiuzh\\.openclaw\\openclaw.json',
      credentialsDir: 'C:\\Users\\qiuzh\\.openclaw\\credentials',
      modelCatalogCacheFile: 'C:\\Users\\qiuzh\\.openclaw\\qclaw-model-catalog-cache.json',
      displayHomeDir: '~\\.openclaw',
      displayEnvFile: '~\\.openclaw\\.env',
      displayConfigFile: '~\\.openclaw\\openclaw.json',
      displayCredentialsDir: '~\\.openclaw\\credentials',
      displayModelCatalogCacheFile: '~\\.openclaw\\qclaw-model-catalog-cache.json',
      activeRuntimeSnapshot,
    }))

    const result = await resolveOpenClawPathsForRead({
      platform: 'win32',
      getCachedRuntimeSnapshot: async () => null,
      resolvePaths,
      resolveSelectedRuntimeSnapshot,
    } as any)

    expect(resolveSelectedRuntimeSnapshot).toHaveBeenCalledTimes(1)
    expect(resolvePaths).toHaveBeenCalledWith({
      activeRuntimeSnapshot: snapshot,
    })
    expect(result.homeDir).toContain('.openclaw')
  })

  it('fails fast on Windows when no cached runtime snapshot exists', async () => {
    await expect(
      resolveOpenClawPathsForRead({
        platform: 'win32',
        getCachedRuntimeSnapshot: async () => null,
        resolveSelectedRuntimeSnapshot: async () => null,
      })
    ).rejects.toThrow(/runtime not ready/i)
  })

  it('derives the selected Windows runtime snapshot from detectedNodeBinDir when PATH is empty', async () => {
    const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'qclaw-runtime-readonly-'))
    const localAppData = path.join(tempRoot, 'LocalAppData')
    const runtimeRoot = path.win32.join(localAppData, 'Qclaw', 'runtime', 'win32')
    const nodeBinDir = path.win32.join(runtimeRoot, 'node', 'v24.14.1')
    const nodeExecutable = path.win32.join(nodeBinDir, 'node.exe')
    const openclawExecutable = path.win32.join(nodeBinDir, 'openclaw.cmd')
    const hostPackageRoot = path.win32.join(nodeBinDir, 'node_modules', 'openclaw')
    const homeDir = path.join(tempRoot, '.openclaw')
    const configFile = path.join(homeDir, 'openclaw.json')

    try {
      await fs.promises.mkdir(hostPackageRoot, { recursive: true })
      await fs.promises.mkdir(homeDir, { recursive: true })
      await Promise.all([
        fs.promises.writeFile(nodeExecutable, ''),
        fs.promises.writeFile(openclawExecutable, ''),
        fs.promises.writeFile(path.win32.join(hostPackageRoot, 'package.json'), '{"name":"openclaw"}'),
        fs.promises.writeFile(configFile, '{}'),
      ])
      setDetectedNodeBinDir(nodeBinDir)

      const snapshot = await resolveWindowsActiveRuntimeSnapshotForRead({
        platform: 'win32',
        env: {
          ...process.env,
          LOCALAPPDATA: localAppData,
          PATH: '',
        },
        getCachedRuntimeSnapshot: async () => null,
        resolvePaths: async () => ({
          homeDir,
          envFile: path.join(homeDir, '.env'),
          configFile,
          credentialsDir: path.join(homeDir, 'credentials'),
          modelCatalogCacheFile: path.join(homeDir, 'qclaw-model-catalog-cache.json'),
          displayHomeDir: homeDir,
          displayEnvFile: path.join(homeDir, '.env'),
          displayConfigFile: configFile,
          displayCredentialsDir: path.join(homeDir, 'credentials'),
          displayModelCatalogCacheFile: path.join(homeDir, 'qclaw-model-catalog-cache.json'),
        }),
      })

      expect(snapshot).toMatchObject({
        nodePath: nodeExecutable,
        openclawPath: openclawExecutable,
        hostPackageRoot,
      })
    } finally {
      clearDetectedNodeBinDir()
      await fs.promises.rm(tempRoot, { recursive: true, force: true })
    }
  })
})

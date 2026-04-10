import { describe, expect, it, vi } from 'vitest'

import { resolveOpenClawPathsForRead } from '../openclaw-runtime-readonly'

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
})

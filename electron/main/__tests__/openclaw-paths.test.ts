import { describe, expect, it } from 'vitest'
import { formatDisplayPath, resolveOpenClawPaths } from '../openclaw-paths'

describe('resolveOpenClawPaths', () => {
  it('builds every top-level OpenClaw path from one resolver on macOS/Linux', () => {
    const paths = resolveOpenClawPaths({
      homeDir: '/Users/alice',
      platform: 'darwin',
    })

    expect(paths).toEqual({
      homeDir: '/Users/alice/.openclaw',
      configFile: '/Users/alice/.openclaw/openclaw.json',
      envFile: '/Users/alice/.openclaw/.env',
      credentialsDir: '/Users/alice/.openclaw/credentials',
      modelCatalogCacheFile: '/Users/alice/.openclaw/qclaw-model-catalog-cache.json',
      displayHomeDir: '~/.openclaw',
      displayConfigFile: '~/.openclaw/openclaw.json',
      displayEnvFile: '~/.openclaw/.env',
      displayCredentialsDir: '~/.openclaw/credentials',
      displayModelCatalogCacheFile: '~/.openclaw/qclaw-model-catalog-cache.json',
    })
  })

  it('supports Windows path resolution from the same API surface', () => {
    const paths = resolveOpenClawPaths({
      homeDir: 'C:\\Users\\alice',
      platform: 'win32',
    })

    expect(paths.configFile).toBe('C:\\Users\\alice\\.openclaw\\openclaw.json')
    expect(paths.displayConfigFile).toBe('~\\.openclaw\\openclaw.json')
  })
})

describe('formatDisplayPath', () => {
  it('converts absolute paths under the user home into display-safe ~/ paths', () => {
    expect(formatDisplayPath('/Users/alice/.openclaw/openclaw.json', '/Users/alice', 'darwin')).toBe(
      '~/.openclaw/openclaw.json'
    )
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearModelAuthProfilesByProvider,
  ensureLocalAuthProfile,
  extractAuthStorePathFromModelStatus,
  inspectModelAuthProfilesByProvider,
  repairAgentAuthProfilesFromOtherAgentStores,
  repairMainAuthProfilesFromOtherAgentStores,
  resolveMainAuthStorePath,
  resolveLocalAuthStorePath,
  testLocalConnection,
  upsertApiKeyAuthProfile,
} from '../local-model-probe'

const path = process.getBuiltinModule('node:path') as typeof import('node:path')
const originalFetch = globalThis.fetch

afterEach(() => {
  if (originalFetch) {
    globalThis.fetch = originalFetch
    return
  }

  delete (globalThis as { fetch?: typeof fetch }).fetch
})

function buildStatusResult(payload: Record<string, unknown>) {
  return {
    ok: true,
    stdout: JSON.stringify(payload),
    stderr: '',
    code: 0,
  }
}

describe('extractAuthStorePathFromModelStatus', () => {
  it('prefers auth.storePath when models status reports it', () => {
    expect(
      extractAuthStorePathFromModelStatus(
        JSON.stringify({
          auth: {
            storePath: '/tmp/openclaw/profiles/team-a/agents/worker/agent/auth-profiles.json',
          },
          agentDir: '/tmp/openclaw/profiles/team-a/agents/main/agent',
        })
      )
    ).toBe('/tmp/openclaw/profiles/team-a/agents/worker/agent/auth-profiles.json')
  })

  it('falls back to agentDir when auth.storePath is absent', () => {
    expect(
      extractAuthStorePathFromModelStatus(
        JSON.stringify({
          agentDir: '/tmp/openclaw/profiles/team-a/agents/worker/agent',
        })
      )
    ).toBe(path.join('/tmp/openclaw/profiles/team-a/agents/worker/agent', 'auth-profiles.json'))
  })
})

describe('resolveLocalAuthStorePath', () => {
  it('uses the status-reported auth store path instead of hardcoding the main agent', async () => {
    const result = await resolveLocalAuthStorePath({
      getModelStatusCommand: async () =>
        buildStatusResult({
          auth: {
            storePath: '/tmp/openclaw/profiles/team-a/agents/research/agent/auth-profiles.json',
          },
        }),
      resolveRuntimePaths: async () => ({
        homeDir: '/tmp/openclaw/profiles/team-a',
      }),
    })

    expect(result).toBe('/tmp/openclaw/profiles/team-a/agents/research/agent/auth-profiles.json')
  })

  it('falls back to the runtime state root when models status is unavailable', async () => {
    const result = await resolveLocalAuthStorePath({
      getModelStatusCommand: async () => ({
        ok: false,
        stdout: '',
        stderr: 'status unavailable',
        code: 1,
      }),
      resolveRuntimePaths: async () => ({
        homeDir: '/tmp/openclaw/profiles/team-b',
      }),
    })

    expect(result).toBe(path.join('/tmp/openclaw/profiles/team-b', 'agents', 'main', 'agent', 'auth-profiles.json'))
  })
})

describe('resolveMainAuthStorePath', () => {
  it('asks OpenClaw for the main agent auth store path explicitly', async () => {
    const getModelStatusCommand = vi.fn(async () =>
      buildStatusResult({
        auth: {
          storePath: '/tmp/openclaw/profiles/team-a/agents/main/agent/auth-profiles.json',
        },
      })
    )

    const result = await resolveMainAuthStorePath({
      getModelStatusCommand,
      resolveRuntimePaths: async () => ({
        homeDir: '/tmp/openclaw/profiles/team-a',
      }),
    })

    expect(getModelStatusCommand).toHaveBeenCalledWith({ agentId: 'main' })
    expect(result).toBe('/tmp/openclaw/profiles/team-a/agents/main/agent/auth-profiles.json')
  })

  it('falls back to the runtime main agent path when the main status probe fails', async () => {
    const result = await resolveMainAuthStorePath({
      getModelStatusCommand: async () => ({
        ok: false,
        stdout: '',
        stderr: 'status unavailable',
        code: 1,
      }),
      resolveRuntimePaths: async () => ({
        homeDir: '/tmp/openclaw/profiles/team-b',
      }),
    })

    expect(result).toBe(path.join('/tmp/openclaw/profiles/team-b', 'agents', 'main', 'agent', 'auth-profiles.json'))
  })
})

describe('testLocalConnection', () => {
  it('expands generic fetch failures into actionable localhost diagnostics', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw Object.assign(new TypeError('fetch failed'), {
        cause: {
          code: 'ECONNREFUSED',
          message: 'connect ECONNREFUSED 127.0.0.1:11434',
        },
      })
    }) as unknown as typeof fetch

    const result = await testLocalConnection({
      provider: 'ollama',
      baseUrl: 'http://127.0.0.1:11434',
    })

    expect(result.ok).toBe(false)
    expect(result.reachable).toBe(false)
    expect(result.error).toContain('连接被拒绝')
    expect(result.error).toContain('127.0.0.1:11434')
  })
})

describe('ensureLocalAuthProfile', () => {
  it('writes the custom-local marker for custom-openai when the user leaves the api key blank', async () => {
    let writtenPath = ''
    const written = { value: null as Record<string, any> | null }

    const readFileSpy = vi.fn(async () => {
      throw new Error('ENOENT')
    })
    const writeJsonSpy = vi.fn(async (filePath: unknown, value: unknown) => {
      writtenPath = String(filePath || '')
      written.value = value as Record<string, any>
    })

    const result = await ensureLocalAuthProfile(
      {
        provider: 'custom-openai',
      },
      {
        authStorePath: '/tmp/openclaw/profiles/team-a/agents/research/agent/auth-profiles.json',
        readFileFn: readFileSpy as any,
        writeJsonFn: writeJsonSpy as any,
      }
    )

    expect(result).toMatchObject({
      ok: true,
      created: true,
      profileId: 'custom-openai:local',
    })
    expect(writeJsonSpy).toHaveBeenCalledTimes(1)
    expect(writtenPath).toBe(
      '/tmp/openclaw/profiles/team-a/agents/research/agent/auth-profiles.json'
    )

    if (!written.value) throw new Error('expected writeJsonFn to receive a JSON payload')
    const persisted = written.value
    expect(persisted.profiles['custom-openai:local']).toMatchObject({
      type: 'api_key',
      provider: 'custom-openai',
      key: 'custom-local',
    })
  })
})

describe('upsertApiKeyAuthProfile', () => {
  it('writes the api key into the main agent auth store using the provider default profile id', async () => {
    let writtenPath = ''
    const written = { value: null as Record<string, any> | null }

    const readFileSpy = vi.fn(async () => {
      throw new Error('ENOENT')
    })
    const writeJsonSpy = vi.fn(async (filePath: unknown, value: unknown) => {
      writtenPath = String(filePath || '')
      written.value = value as Record<string, any>
    })

    const result = await upsertApiKeyAuthProfile(
      {
        provider: 'kimi',
        apiKey: 'sk-kimi-live',
      },
      {
        getModelStatusCommand: async () =>
          buildStatusResult({
            auth: {
              storePath: '/tmp/openclaw/profiles/team-a/agents/main/agent/auth-profiles.json',
            },
          }),
        resolveRuntimePaths: async () => ({
          homeDir: '/tmp/openclaw/profiles/team-a',
        }),
        readFileFn: readFileSpy as any,
        writeJsonFn: writeJsonSpy as any,
      }
    )

    expect(result).toMatchObject({
      ok: true,
      created: true,
      updated: false,
      profileId: 'kimi:default',
      authStorePath: '/tmp/openclaw/profiles/team-a/agents/main/agent/auth-profiles.json',
    })
    expect(writeJsonSpy).toHaveBeenCalledTimes(1)
    expect(writtenPath).toBe('/tmp/openclaw/profiles/team-a/agents/main/agent/auth-profiles.json')

    if (!written.value) throw new Error('expected writeJsonFn to receive a JSON payload')
    expect(written.value.profiles).toEqual({
      'kimi:default': {
        type: 'api_key',
        provider: 'kimi',
        key: 'sk-kimi-live',
      },
    })
  })
})

describe('repairMainAuthProfilesFromOtherAgentStores', () => {
  it('copies missing matching profiles from other agent stores into main', async () => {
    const mainAuthStorePath = '/tmp/openclaw/profiles/team-a/agents/main/agent/auth-profiles.json'
    const feishuAuthStorePath = '/tmp/openclaw/profiles/team-a/agents/feishu-default/agent/auth-profiles.json'
    let writtenPath = ''
    const written = { value: null as Record<string, any> | null }

    const readFileSpy = vi.fn(async (filePath: unknown) => {
      const normalizedPath = String(filePath || '')
      if (normalizedPath === mainAuthStorePath) {
        return JSON.stringify({
          version: 1,
          profiles: {},
          lastGood: {},
          usageStats: {},
        })
      }
      if (normalizedPath === feishuAuthStorePath) {
        return JSON.stringify({
          version: 1,
          profiles: {
            'zai:default': {
              type: 'api_key',
              provider: 'zai',
              key: 'zai-live-key',
            },
            'kimi:default': {
              type: 'api_key',
              provider: 'kimi',
              key: 'kimi-live-key',
            },
          },
          lastGood: {
            zai: 'zai:default',
          },
        })
      }
      throw new Error(`ENOENT: ${normalizedPath}`)
    })
    const writeJsonSpy = vi.fn(async (filePath: unknown, value: unknown) => {
      writtenPath = String(filePath || '')
      written.value = value as Record<string, any>
    })

    const result = await repairMainAuthProfilesFromOtherAgentStores(
      {
        providerIds: ['zai', 'xai'],
        sourceAuthStorePaths: [mainAuthStorePath, feishuAuthStorePath],
      },
      {
        getModelStatusCommand: async () =>
          buildStatusResult({
            auth: {
              storePath: mainAuthStorePath,
            },
          }),
        resolveRuntimePaths: async () => ({
          homeDir: '/tmp/openclaw/profiles/team-a',
        }),
        readFileFn: readFileSpy as any,
        writeJsonFn: writeJsonSpy as any,
      }
    )

    expect(result).toEqual({
      ok: true,
      repaired: true,
      authStorePath: mainAuthStorePath,
      importedProfileIds: ['zai:default'],
      importedProviders: ['zai'],
      sourceAuthStorePaths: [feishuAuthStorePath],
    })
    expect(writeJsonSpy).toHaveBeenCalledTimes(1)
    expect(writtenPath).toBe(mainAuthStorePath)

    if (!written.value) throw new Error('expected writeJsonFn to receive a JSON payload')
    expect(written.value.profiles).toEqual({
      'zai:default': {
        type: 'api_key',
        provider: 'zai',
        key: 'zai-live-key',
      },
    })
    expect(written.value.lastGood).toEqual({
      zai: 'zai:default',
    })
  })
})

describe('repairAgentAuthProfilesFromOtherAgentStores', () => {
  it('copies minimax-portal oauth auth when repair is requested for canonical minimax', async () => {
    const channelDefaultAuthStorePath = '/tmp/openclaw/profiles/team-a/agents/channel-default/agent/auth-profiles.json'
    const channelBotAuthStorePath = path.join(
      '/tmp/openclaw/profiles/team-a',
      'agents',
      'channel-bot',
      'agent',
      'auth-profiles.json'
    )
    let writeCount = 0
    let writtenPath = ''
    const written = { value: null as Record<string, any> | null }

    const readFileSpy = vi.fn(async (filePath: unknown) => {
      const normalizedPath = String(filePath || '')
      if (normalizedPath === channelDefaultAuthStorePath) {
        return JSON.stringify({
          version: 1,
          profiles: {
            'minimax-portal:default': {
              type: 'oauth',
              provider: 'minimax-portal',
            },
          },
          lastGood: {
            'minimax-portal': 'minimax-portal:default',
          },
        })
      }
      if (normalizedPath === channelBotAuthStorePath) {
        throw new Error(`ENOENT: ${normalizedPath}`)
      }
      throw new Error(`unexpected path: ${normalizedPath}`)
    })
    const writeJsonSpy = vi.fn(async (filePath: unknown, value: unknown) => {
      writeCount += 1
      writtenPath = String(filePath || '')
      written.value = value as Record<string, any>
    })

    const result = await repairAgentAuthProfilesFromOtherAgentStores(
      {
        providerIds: ['minimax'],
        targetAgentIds: ['channel-bot'],
        sourceAuthStorePaths: [channelDefaultAuthStorePath],
      },
      {
        resolveRuntimePaths: async () => ({
          homeDir: '/tmp/openclaw/profiles/team-a',
        }),
        readFileFn: readFileSpy as any,
        writeJsonFn: writeJsonSpy as any,
      }
    )

    expect(result).toEqual({
      ok: true,
      repaired: true,
      updatedAuthStorePaths: [channelBotAuthStorePath],
      importedProfileIds: ['minimax-portal:default'],
      importedProviders: ['minimax-portal'],
      sourceAuthStorePaths: [channelDefaultAuthStorePath],
    })
    expect(writeCount).toBe(1)
    expect(writtenPath).toBe(channelBotAuthStorePath)

    if (!written.value) throw new Error('expected writeJsonFn to receive a JSON payload')
    expect(written.value.profiles).toEqual({
      'minimax-portal:default': {
        type: 'oauth',
        provider: 'minimax-portal',
      },
    })
    expect(written.value.lastGood).toEqual({
      'minimax-portal': 'minimax-portal:default',
    })
  })

  it('ignores unsafe target agent ids that would escape the agents directory', async () => {
    const channelDefaultAuthStorePath = '/tmp/openclaw/profiles/team-a/agents/channel-default/agent/auth-profiles.json'
    const writeJsonSpy = vi.fn(async () => undefined)

    const readFileSpy = vi.fn(async (filePath: unknown) => {
      const normalizedPath = String(filePath || '')
      if (normalizedPath === channelDefaultAuthStorePath) {
        return JSON.stringify({
          version: 1,
          profiles: {
            'minimax-portal:default': {
              type: 'oauth',
              provider: 'minimax-portal',
            },
          },
          lastGood: {
            'minimax-portal': 'minimax-portal:default',
          },
        })
      }
      throw new Error(`ENOENT: ${normalizedPath}`)
    })

    const result = await repairAgentAuthProfilesFromOtherAgentStores(
      {
        providerIds: ['minimax'],
        targetAgentIds: ['../../outside'],
        sourceAuthStorePaths: [channelDefaultAuthStorePath],
      },
      {
        resolveRuntimePaths: async () => ({
          homeDir: '/tmp/openclaw/profiles/team-a',
        }),
        readFileFn: readFileSpy as any,
        writeJsonFn: writeJsonSpy as any,
      }
    )

    expect(result).toEqual({
      ok: true,
      repaired: false,
      updatedAuthStorePaths: [],
      importedProfileIds: [],
      importedProviders: [],
      sourceAuthStorePaths: [],
    })
    expect(writeJsonSpy).not.toHaveBeenCalled()
  })

  it('keeps non-minimax provider repair exact and does not pull sibling aliases', async () => {
    const channelDefaultAuthStorePath = '/tmp/openclaw/profiles/team-a/agents/channel-default/agent/auth-profiles.json'
    const channelBotAuthStorePath = path.join(
      '/tmp/openclaw/profiles/team-a',
      'agents',
      'channel-bot',
      'agent',
      'auth-profiles.json'
    )
    const writeJsonSpy = vi.fn(async () => undefined)

    const readFileSpy = vi.fn(async (filePath: unknown) => {
      const normalizedPath = String(filePath || '')
      if (normalizedPath === channelDefaultAuthStorePath) {
        return JSON.stringify({
          version: 1,
          profiles: {
            'openai:default': {
              type: 'api_key',
              provider: 'openai',
              apiKey: 'sk-openai',
            },
            'openai-codex:user@example.com': {
              type: 'oauth',
              provider: 'openai-codex',
            },
          },
          lastGood: {
            openai: 'openai:default',
            'openai-codex': 'openai-codex:user@example.com',
          },
        })
      }
      if (normalizedPath === channelBotAuthStorePath) {
        throw new Error(`ENOENT: ${normalizedPath}`)
      }
      throw new Error(`unexpected path: ${normalizedPath}`)
    })

    const result = await repairAgentAuthProfilesFromOtherAgentStores(
      {
        providerIds: ['openai-codex'],
        targetAgentIds: ['channel-bot'],
        sourceAuthStorePaths: [channelDefaultAuthStorePath],
      },
      {
        resolveRuntimePaths: async () => ({
          homeDir: '/tmp/openclaw/profiles/team-a',
        }),
        readFileFn: readFileSpy as any,
        writeJsonFn: writeJsonSpy as any,
      }
    )

    expect(result).toEqual({
      ok: true,
      repaired: true,
      updatedAuthStorePaths: [channelBotAuthStorePath],
      importedProfileIds: ['openai-codex:user@example.com'],
      importedProviders: ['openai-codex'],
      sourceAuthStorePaths: [channelDefaultAuthStorePath],
    })
    expect(writeJsonSpy).toHaveBeenCalledTimes(1)
    expect(writeJsonSpy).toHaveBeenCalledWith(
      channelBotAuthStorePath,
      expect.objectContaining({
        profiles: {
          'openai-codex:user@example.com': {
            type: 'oauth',
            provider: 'openai-codex',
          },
        },
        lastGood: {
          'openai-codex': 'openai-codex:user@example.com',
        },
      }),
      expect.any(Object)
    )
  })
})

describe('clearModelAuthProfilesByProvider', () => {
  it('removes matching profiles from the status-reported auth store path', async () => {
    let writtenPath = ''
    const written = { value: null as Record<string, any> | null }

    const readFileSpy = vi.fn(async () =>
      JSON.stringify({
        version: 1,
        profiles: {
          'custom-openai:local': {
            type: 'api_key',
            provider: 'custom-openai',
            key: 'custom-local',
          },
          'openai:default': {
            type: 'api_key',
            provider: 'openai',
            key: 'sk-live',
          },
        },
        usageStats: {
          'custom-openai:local': { total: 1 },
          'openai:default': { total: 2 },
        },
      })
    )
    const writeJsonSpy = vi.fn(async (filePath: unknown, value: unknown) => {
      writtenPath = String(filePath || '')
      written.value = value as Record<string, any>
    })

    const result = await clearModelAuthProfilesByProvider(
      {
        providerIds: ['custom-openai'],
      },
      {
        getModelStatusCommand: async () =>
          buildStatusResult({
            auth: {
              storePath: '/tmp/openclaw/profiles/team-a/agents/research/agent/auth-profiles.json',
            },
          }),
        resolveRuntimePaths: async () => ({
          homeDir: '/tmp/openclaw/profiles/team-a',
        }),
        readFileFn: readFileSpy as any,
        writeJsonFn: writeJsonSpy as any,
      }
    )

    expect(result).toMatchObject({
      ok: true,
      removed: 1,
      removedProfileIds: ['custom-openai:local'],
    })
    expect(writeJsonSpy).toHaveBeenCalledTimes(1)
    expect(writtenPath).toBe(
      '/tmp/openclaw/profiles/team-a/agents/research/agent/auth-profiles.json'
    )

    if (!written.value) throw new Error('expected writeJsonFn to receive a JSON payload')
    const persisted = written.value
    expect(persisted.profiles).toEqual({
      'openai:default': {
        type: 'api_key',
        provider: 'openai',
        key: 'sk-live',
      },
    })
    expect(persisted.usageStats).toEqual({
      'openai:default': { total: 2 },
    })
  })

  it('removes aliased oauth profiles and lastGood references from an explicit auth store path', async () => {
    let writtenPath = ''
    const written = { value: null as Record<string, any> | null }

    const readFileSpy = vi.fn(async () =>
      JSON.stringify({
        version: 1,
        profiles: {
          'openai-codex:default': {
            type: 'oauth',
            provider: 'openai-codex',
          },
          'minimax-portal:default': {
            type: 'oauth',
            provider: 'minimax-portal',
          },
        },
        lastGood: {
          openai: 'openai-codex:default',
          'minimax-portal': 'minimax-portal:default',
        },
      })
    )
    const writeJsonSpy = vi.fn(async (filePath: unknown, value: unknown) => {
      writtenPath = String(filePath || '')
      written.value = value as Record<string, any>
    })

    const result = await clearModelAuthProfilesByProvider(
      {
        providerIds: ['openai'],
        authStorePath: '/tmp/openclaw/profiles/team-a/agents/main/agent/auth-profiles.json',
      },
      {
        readFileFn: readFileSpy as any,
        writeJsonFn: writeJsonSpy as any,
      }
    )

    expect(result).toMatchObject({
      ok: true,
      removed: 1,
      removedProfileIds: ['openai-codex:default'],
      authStorePath: '/tmp/openclaw/profiles/team-a/agents/main/agent/auth-profiles.json',
      clearedLastGoodKeys: ['openai'],
    })
    expect(writeJsonSpy).toHaveBeenCalledTimes(1)
    expect(writtenPath).toBe('/tmp/openclaw/profiles/team-a/agents/main/agent/auth-profiles.json')

    if (!written.value) throw new Error('expected writeJsonFn to receive a JSON payload')
    expect(written.value.profiles).toEqual({
      'minimax-portal:default': {
        type: 'oauth',
        provider: 'minimax-portal',
      },
    })
    expect(written.value.lastGood).toEqual({
      'minimax-portal': 'minimax-portal:default',
    })
  })

  it('persists auth store cleanup when only lastGood references remain', async () => {
    let writtenPath = ''
    const written = { value: null as Record<string, any> | null }

    const readFileSpy = vi.fn(async () =>
      JSON.stringify({
        version: 1,
        profiles: {
          'minimax-portal:default': {
            type: 'oauth',
            provider: 'minimax-portal',
          },
        },
        lastGood: {
          openai: 'openai-codex:default',
          'minimax-portal': 'minimax-portal:default',
        },
      })
    )
    const writeJsonSpy = vi.fn(async (filePath: unknown, value: unknown) => {
      writtenPath = String(filePath || '')
      written.value = value as Record<string, any>
    })

    const result = await clearModelAuthProfilesByProvider(
      {
        providerIds: ['openai'],
        authStorePath: '/tmp/openclaw/profiles/team-a/agents/main/agent/auth-profiles.json',
      },
      {
        readFileFn: readFileSpy as any,
        writeJsonFn: writeJsonSpy as any,
      }
    )

    expect(result).toMatchObject({
      ok: true,
      removed: 0,
      removedProfileIds: [],
      authStorePath: '/tmp/openclaw/profiles/team-a/agents/main/agent/auth-profiles.json',
      clearedLastGoodKeys: ['openai'],
    })
    expect(writeJsonSpy).toHaveBeenCalledTimes(1)
    expect(writtenPath).toBe('/tmp/openclaw/profiles/team-a/agents/main/agent/auth-profiles.json')

    if (!written.value) throw new Error('expected writeJsonFn to receive a JSON payload')
    expect(written.value.profiles).toEqual({
      'minimax-portal:default': {
        type: 'oauth',
        provider: 'minimax-portal',
      },
    })
    expect(written.value.lastGood).toEqual({
      'minimax-portal': 'minimax-portal:default',
    })
  })
})

describe('inspectModelAuthProfilesByProvider', () => {
  it('detects residual matching profiles and lastGood keys from an explicit auth store path', async () => {
    const readFileSpy = vi.fn(async () =>
      JSON.stringify({
        version: 1,
        profiles: {
          'openai-codex:default': {
            type: 'oauth',
            provider: 'openai-codex',
          },
          'anthropic:default': {
            type: 'oauth',
            provider: 'anthropic',
          },
        },
        lastGood: {
          openai: 'openai-codex:default',
          anthropic: 'anthropic:default',
        },
      })
    )

    const result = await inspectModelAuthProfilesByProvider(
      {
        providerIds: ['openai'],
        authStorePath: '/tmp/openclaw/profiles/team-a/agents/main/agent/auth-profiles.json',
      },
      {
        readFileFn: readFileSpy as any,
      }
    )

    expect(result).toEqual({
      ok: true,
      present: true,
      matchedProfileIds: ['openai-codex:default'],
      matchedLastGoodKeys: ['openai'],
      authStorePath: '/tmp/openclaw/profiles/team-a/agents/main/agent/auth-profiles.json',
    })
  })
})

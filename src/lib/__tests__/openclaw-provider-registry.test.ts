import { describe, expect, it } from 'vitest'
import {
  buildKnownProviderEnvKeyMap,
  buildKnownProviderNameMap,
  getKnownProviderCatalog,
  getProviderMetadata,
  listKnownProviderEnvKeys,
  listKnownProvidersForEnvKey,
  resolveKnownProviderIdForAuthChoice,
  resolveProviderDisplayName,
  resolveProviderEnvKey,
  resolveProviderMethodOnboardCliFlag,
  resolveProviderMethodEnvKey,
  resolveProviderLogo,
  supportsProviderMethodRealtimeValidation,
} from '../openclaw-provider-registry'

describe('openclaw-provider-registry', () => {
  it('exposes centralized provider names and env keys without auth-choice duplication', () => {
    const providerNames = buildKnownProviderNameMap()
    const envKeyMap = buildKnownProviderEnvKeyMap()

    expect(providerNames.openai).toBe('OpenAI')
    expect(providerNames.qwen).toBe('千问')
    expect(envKeyMap.openai).toBe('OPENAI_API_KEY')
    expect(envKeyMap['github-copilot']).toBeUndefined()
  })

  it('returns method-scoped metadata for api key providers', () => {
    const provider = getProviderMetadata('openai')
    expect(provider?.methods).toEqual([
      {
        authChoice: 'openai-api-key',
        envKey: 'OPENAI_API_KEY',
        secretPlaceholder: 'sk-...',
      },
    ])
  })

  it('resolves auth-choice env aliases for provider credential validation', () => {
    expect(resolveProviderMethodEnvKey('moonshot', 'kimi-code-api-key')).toBe('MOONSHOT_API_KEY')
    expect(resolveProviderMethodEnvKey('zai', 'zai-coding-global')).toBe('ZAI_API_KEY')
    expect(resolveProviderMethodEnvKey('openai', 'openai-api-key')).toBe('OPENAI_API_KEY')
    expect(resolveProviderMethodEnvKey('google', 'gemini-api-key')).toBe('GEMINI_API_KEY')
  })

  it('tracks shared env keys across first-party and custom openai-compatible providers', () => {
    expect(listKnownProviderEnvKeys('custom-openai')).toEqual(
      expect.arrayContaining(['OPENAI_API_KEY', 'OPENAI_BASE_URL'])
    )
    expect(listKnownProvidersForEnvKey('OPENAI_API_KEY')).toEqual(
      expect.arrayContaining(['openai', 'custom-openai'])
    )
  })

  it('resolves known provider ids and cli flags for degraded onboard recovery', () => {
    expect(resolveKnownProviderIdForAuthChoice('openai-api-key')).toBe('openai')
    expect(resolveKnownProviderIdForAuthChoice('kimi-code-api-key')).toBe('moonshot')
    expect(resolveProviderMethodOnboardCliFlag('openai', 'openai-api-key')).toBe('--openai-api-key')
    expect(resolveProviderMethodOnboardCliFlag('minimax', 'minimax-api')).toBe('--minimax-api-key')
    expect(resolveProviderMethodOnboardCliFlag('google', 'gemini-api-key')).toBe('--gemini-api-key')
  })

  it('only enables realtime validation for non-ambiguous provider auth choices', () => {
    expect(supportsProviderMethodRealtimeValidation('openai', 'openai-api-key')).toBe(true)
    expect(supportsProviderMethodRealtimeValidation('google', 'gemini-api-key')).toBe(true)
    expect(supportsProviderMethodRealtimeValidation('moonshot', 'moonshot-api-key')).toBe(false)
    expect(supportsProviderMethodRealtimeValidation('moonshot', 'kimi-code-api-key')).toBe(false)
    expect(supportsProviderMethodRealtimeValidation('custom', 'custom-api-key')).toBe(false)
  })

  it('falls back to generated names and generic logos for unknown providers', () => {
    expect(resolveProviderDisplayName('custom-enterprise')).toBe('Custom Enterprise')
    expect(resolveProviderLogo('custom-enterprise')).toBe('🧩')
    expect(resolveProviderEnvKey('custom-enterprise')).toBeUndefined()
  })

  it('exposes the updated local provider description for ollama', () => {
    expect(getProviderMetadata('ollama')?.description).toBe('本地 LLM 环境')
  })

  it('builds dashboard catalog entries from the centralized registry', () => {
    const catalog = getKnownProviderCatalog()
    expect(catalog.find((provider) => provider.id === 'openai')).toEqual({
      id: 'openai',
      name: 'OpenAI',
      logo: '🤖',
    })
  })
})

import { describe, expect, it } from 'vitest'
import { summarizeModelAuthDiagnosticState } from '../model-auth-diagnostic'

describe('summarizeModelAuthDiagnosticState', () => {
  it('captures the split state where auth/runtime is ready but provider snapshot is missing', () => {
    const summary = summarizeModelAuthDiagnosticState({
      providerId: 'zai',
      envVars: {},
      config: {
        agents: {
          defaults: {
            model: {
              primary: 'zai/glm-4.5',
            },
          },
        },
      },
      statusData: {
        defaultModel: 'zai/glm-4.5',
        resolvedDefault: 'zai/glm-4.5',
        allowed: [],
        auth: {
          providers: [
            {
              provider: 'zai',
              effective: { kind: 'profiles', detail: '~/.openclaw/agents/main/agent/auth-profiles.json' },
              profiles: { count: 1, apiKey: 1 },
            },
          ],
        },
      },
      catalog: [],
    })

    expect(summary.env.hasAny).toBe(false)
    expect(summary.config.hasProviderSnapshot).toBe(false)
    expect(summary.config.agentPrimaryModel).toBe('zai/glm-4.5')
    expect(summary.config.configuredProviderIds).toEqual([])
    expect(summary.status.defaultModel).toBe('zai/glm-4.5')
    expect(summary.status.resolvedDefault).toBe('zai/glm-4.5')
    expect(summary.status.allowedProviderModels).toEqual([])
    expect(summary.status.configuredProviderIds).toEqual(['zai'])
    expect(summary.status.providerEntries).toEqual([
      {
        provider: 'zai',
        status: '',
        effectiveKind: 'profiles',
        profilesCount: 1,
        hasEnv: false,
        hasModelsJson: false,
      },
    ])
    expect(summary.catalog.providerItemCount).toBe(0)
  })
})

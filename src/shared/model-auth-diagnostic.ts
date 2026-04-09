import { getModelProviderAliasCandidates } from '../lib/model-provider-aliases'
import { listKnownProviderEnvKeys } from '../lib/openclaw-provider-registry'
import { extractConfiguredProviderIds } from './configured-provider-extraction'

function normalizeText(value: unknown): string {
  return String(value ?? '').trim()
}

function normalizeProviderId(value: unknown): string {
  return normalizeText(value).toLowerCase()
}

function resolveProviderAliases(providerId: string): Set<string> {
  return new Set(
    getModelProviderAliasCandidates(providerId)
      .map((candidate) => normalizeProviderId(candidate))
      .filter(Boolean)
  )
}

function summarizeProviderModels(models: unknown): string[] {
  if (!Array.isArray(models)) return []
  return models
    .map((model) => {
      if (typeof model === 'string') return normalizeText(model)
      if (model && typeof model === 'object') {
        return normalizeText((model as Record<string, unknown>).id ?? (model as Record<string, unknown>).key)
      }
      return ''
    })
    .filter(Boolean)
}

function listProviderAuthProfileIds(config: Record<string, any> | null | undefined, aliases: Set<string>): string[] {
  const profiles = config?.auth?.profiles
  if (!profiles || typeof profiles !== 'object' || Array.isArray(profiles)) return []

  return Object.entries(profiles)
    .filter(([profileKey, profile]) => {
      const profileProvider = normalizeProviderId((profile as Record<string, unknown>)?.provider)
      if (profileProvider && aliases.has(profileProvider)) return true
      const keyProvider = normalizeProviderId(String(profileKey || '').split(':')[0])
      return Boolean(keyProvider) && aliases.has(keyProvider)
    })
    .map(([profileKey]) => normalizeText(profileKey))
    .filter(Boolean)
}

function collectMatchingStatusProviders(statusData: Record<string, any> | null | undefined, aliases: Set<string>) {
  const providers = [
    ...(Array.isArray(statusData?.auth?.providers) ? statusData.auth.providers : []),
    ...(Array.isArray(statusData?.auth?.oauth?.providers) ? statusData.auth.oauth.providers : []),
  ]

  return providers.filter((provider) => {
    const providerId = normalizeProviderId((provider as Record<string, unknown>)?.provider ?? (provider as Record<string, unknown>)?.providerId)
    return providerId && aliases.has(providerId)
  }) as Array<Record<string, any>>
}

function collectAllowedProviderModels(statusData: Record<string, any> | null | undefined, aliases: Set<string>): string[] {
  const allowed = Array.isArray(statusData?.allowed) ? statusData.allowed : []
  return allowed
    .map((item) => normalizeText(item))
    .filter((item) => aliases.has(normalizeProviderId(item.split('/')[0])))
}

function collectCatalogProviderKeys(catalog: Array<Record<string, any>> | null | undefined, aliases: Set<string>): string[] {
  if (!Array.isArray(catalog)) return []
  return catalog
    .map((item) => normalizeText(item?.key))
    .filter((key) => aliases.has(normalizeProviderId(key.split('/')[0])))
}

export interface ModelAuthDiagnosticStateSummary {
  providerId: string
  env: {
    hasAny: boolean
    matchedKeys: string[]
  }
  config: {
    configuredProviderIds: string[]
    authProfileIds: string[]
    defaultModel: string
    agentPrimaryModel: string
    hasProviderSnapshot: boolean
    providerSnapshotKeys: string[]
    providerSnapshotModels: string[]
  }
  status: {
    configuredProviderIds: string[]
    defaultModel: string
    resolvedDefault: string
    allowedProviderModels: string[]
    providerEntries: Array<{
      provider: string
      status: string
      effectiveKind: string
      profilesCount: number
      hasEnv: boolean
      hasModelsJson: boolean
    }>
  }
  catalog: {
    providerItemCount: number
    providerKeys: string[]
    totalItems: number
  }
}

export function summarizeModelAuthDiagnosticState(input: {
  providerId: string
  envVars?: Record<string, string> | null
  config?: Record<string, any> | null
  statusData?: Record<string, any> | null
  catalog?: Array<Record<string, any>> | null
}): ModelAuthDiagnosticStateSummary {
  const providerId = normalizeProviderId(input.providerId)
  const aliases = resolveProviderAliases(providerId)
  const envKeys = listKnownProviderEnvKeys(providerId)
  const matchedEnvKeys = envKeys.filter((envKey) => Boolean(normalizeText(input.envVars?.[envKey])))
  const providerConfig = input.config?.models?.providers?.[providerId]
  const configuredProviderIdsFromConfig = extractConfiguredProviderIds({
    config: input.config || null,
    modelStatus: null,
  })
  const configuredProviderIdsFromStatus = extractConfiguredProviderIds({
    config: null,
    modelStatus: input.statusData || null,
  })
  const matchingStatusProviders = collectMatchingStatusProviders(input.statusData, aliases)
  const catalogProviderKeys = collectCatalogProviderKeys(input.catalog || null, aliases)

  return {
    providerId,
    env: {
      hasAny: matchedEnvKeys.length > 0,
      matchedKeys: matchedEnvKeys,
    },
    config: {
      configuredProviderIds: configuredProviderIdsFromConfig,
      authProfileIds: listProviderAuthProfileIds(input.config || null, aliases),
      defaultModel: normalizeText(input.config?.defaultModel),
      agentPrimaryModel: normalizeText(input.config?.agents?.defaults?.model?.primary),
      hasProviderSnapshot: Boolean(providerConfig && typeof providerConfig === 'object' && !Array.isArray(providerConfig)),
      providerSnapshotKeys:
        providerConfig && typeof providerConfig === 'object' && !Array.isArray(providerConfig)
          ? Object.keys(providerConfig as Record<string, unknown>).sort()
          : [],
      providerSnapshotModels: summarizeProviderModels((providerConfig as Record<string, unknown> | undefined)?.models),
    },
    status: {
      configuredProviderIds: configuredProviderIdsFromStatus,
      defaultModel: normalizeText(input.statusData?.defaultModel),
      resolvedDefault: normalizeText(input.statusData?.resolvedDefault),
      allowedProviderModels: collectAllowedProviderModels(input.statusData, aliases),
      providerEntries: matchingStatusProviders.map((provider) => ({
        provider: normalizeText(provider.provider ?? provider.providerId),
        status: normalizeText(provider.status),
        effectiveKind:
          typeof provider.effective === 'object' && provider.effective
            ? normalizeText((provider.effective as Record<string, unknown>).kind)
            : provider.effective === true
              ? 'boolean-true'
              : '',
        profilesCount:
          typeof provider.profiles === 'object' && provider.profiles
            ? Number((provider.profiles as Record<string, unknown>).count || 0)
            : 0,
        hasEnv: Boolean(provider.env),
        hasModelsJson: Boolean(provider.modelsJson),
      })),
    },
    catalog: {
      providerItemCount: catalogProviderKeys.length,
      providerKeys: catalogProviderKeys,
      totalItems: Array.isArray(input.catalog) ? input.catalog.length : 0,
    },
  }
}

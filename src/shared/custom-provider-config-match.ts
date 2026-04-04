export interface CustomProviderConfigMatchInput {
  baseUrl?: string | null
  modelId?: string | null
  providerId?: string | null
}

export type CustomProviderConfigMatchResult =
  | {
      status: 'matched'
      providerId: string
      matchedBy: 'explicit-id' | 'heuristic'
    }
  | {
      status: 'ambiguous'
      candidates: string[]
    }
  | {
      status: 'missing'
    }

const LOCAL_PROVIDER_SNAPSHOT_IDS = new Set(['ollama', 'vllm', 'custom-openai'])

function isAzureCustomProviderUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase()
    return host.endsWith('.services.ai.azure.com') || host.endsWith('.openai.azure.com')
  } catch {
    return false
  }
}

export function resolveExpectedCustomProviderBaseUrl(baseUrl: string, modelId: string): string {
  const normalizedBaseUrl = String(baseUrl || '').trim().replace(/\/+$/, '')
  if (!normalizedBaseUrl) return ''
  if (!isAzureCustomProviderUrl(normalizedBaseUrl)) return normalizedBaseUrl
  if (normalizedBaseUrl.includes('/openai/deployments/')) return normalizedBaseUrl
  return `${normalizedBaseUrl}/openai/deployments/${String(modelId || '').trim()}`
}

function getConfiguredProviderMap(configData: Record<string, any> | null | undefined): Record<string, any> | null {
  const modelSection = configData?.models
  if (!modelSection || typeof modelSection !== 'object' || Array.isArray(modelSection)) return null

  const providerMap =
    modelSection.providers && typeof modelSection.providers === 'object' && !Array.isArray(modelSection.providers)
      ? modelSection.providers
      : modelSection

  if (!providerMap || typeof providerMap !== 'object' || Array.isArray(providerMap)) {
    return null
  }

  return providerMap as Record<string, any>
}

function getConfiguredProviderModelCandidates(model: unknown): string[] {
  const rawModelId =
    typeof model === 'string'
      ? model
      : typeof model === 'object' && model
        ? (model as Record<string, any>).key ?? (model as Record<string, any>).id
        : ''
  const normalizedModelId = String(rawModelId || '').trim()
  if (!normalizedModelId) return []

  const candidates = new Set<string>([normalizedModelId])
  if (normalizedModelId.includes('/')) {
    const strippedProviderPrefix = normalizedModelId.split('/').slice(1).join('/').trim()
    if (strippedProviderPrefix) {
      candidates.add(strippedProviderPrefix)
    }
  }

  return Array.from(candidates)
}

export function resolveConfiguredCustomProviderMatchFromConfig(
  configData: Record<string, any> | null | undefined,
  customConfig?: CustomProviderConfigMatchInput | null
): CustomProviderConfigMatchResult {
  const providers = getConfiguredProviderMap(configData)
  if (!providers || !customConfig) return { status: 'missing' }

  const expectedBaseUrl = resolveExpectedCustomProviderBaseUrl(
    String(customConfig.baseUrl || ''),
    String(customConfig.modelId || '')
  )
  const expectedModelId = String(customConfig.modelId || '').trim()
  if (!expectedBaseUrl || !expectedModelId) return { status: 'missing' }

  const matchedProviderIds: string[] = []
  for (const [providerId, providerConfig] of Object.entries(providers)) {
    const normalizedProviderId = String(providerId || '').trim()
    if (!normalizedProviderId || LOCAL_PROVIDER_SNAPSHOT_IDS.has(normalizedProviderId)) {
      continue
    }

    const actualBaseUrl = String(providerConfig?.baseUrl || '').trim().replace(/\/+$/, '')
    const models = Array.isArray(providerConfig?.models) ? providerConfig.models : []
    const hasModel = models.some((model: unknown) => getConfiguredProviderModelCandidates(model).includes(expectedModelId))
    if (actualBaseUrl === expectedBaseUrl && hasModel) {
      matchedProviderIds.push(normalizedProviderId)
    }
  }

  const explicitProviderId = String(customConfig.providerId || '').trim()
  if (explicitProviderId) {
    if (matchedProviderIds.includes(explicitProviderId)) {
      return {
        status: 'matched',
        providerId: explicitProviderId,
        matchedBy: 'explicit-id',
      }
    }

    return { status: 'missing' }
  }

  if (matchedProviderIds.length === 1) {
    return {
      status: 'matched',
      providerId: matchedProviderIds[0],
      matchedBy: 'heuristic',
    }
  }

  if (matchedProviderIds.length > 1) {
    return {
      status: 'ambiguous',
      candidates: matchedProviderIds,
    }
  }

  return { status: 'missing' }
}

export function resolveConfiguredCustomProviderIdFromConfig(
  configData: Record<string, any> | null | undefined,
  customConfig?: CustomProviderConfigMatchInput | null
): string {
  const match = resolveConfiguredCustomProviderMatchFromConfig(configData, customConfig)
  return match.status === 'matched' ? match.providerId : ''
}

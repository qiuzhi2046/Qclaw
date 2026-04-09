function isPlainObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function cloneJsonValue<T>(value: T): T {
  if (value === undefined) return value
  return JSON.parse(JSON.stringify(value)) as T
}

const MINIMAX_PORTAL_PROVIDER_ID = 'minimax-portal'
const MINIMAX_PORTAL_PROVIDER_API = 'anthropic-messages'
const MINIMAX_PORTAL_PROVIDER_API_JSON_PATH = '$.models.providers.minimax-portal.api'

export interface OpenClawProviderConfigRepairResult {
  changed: boolean
  config: Record<string, any> | null
  repairedJsonPaths: string[]
}

export function ensureProviderSnapshotEnabled(
  config: Record<string, any> | null | undefined,
  providerId: string
): OpenClawProviderConfigRepairResult {
  const normalizedProviderId = String(providerId || '').trim()
  if (!isPlainObject(config) || !normalizedProviderId) {
    return {
      changed: false,
      config: config ?? null,
      repairedJsonPaths: [],
    }
  }

  const existingProviderConfig = config.models?.providers?.[normalizedProviderId]
  if (isPlainObject(existingProviderConfig) && existingProviderConfig.enabled === true) {
    return {
      changed: false,
      config,
      repairedJsonPaths: [],
    }
  }

  const nextConfig = cloneJsonValue(config)
  nextConfig.models = isPlainObject(nextConfig.models) ? nextConfig.models : {}
  nextConfig.models.providers = isPlainObject(nextConfig.models.providers) ? nextConfig.models.providers : {}
  const nextProviderConfig = isPlainObject(nextConfig.models.providers[normalizedProviderId])
    ? nextConfig.models.providers[normalizedProviderId]
    : {}

  nextConfig.models.providers[normalizedProviderId] = {
    ...nextProviderConfig,
    enabled: true,
  }

  return {
    changed: true,
    config: nextConfig,
    repairedJsonPaths: [`$.models.providers.${normalizedProviderId}.enabled`],
  }
}

export function repairKnownProviderConfigGaps(
  config: Record<string, any> | null | undefined
): OpenClawProviderConfigRepairResult {
  if (!isPlainObject(config)) {
    return {
      changed: false,
      config: config ?? null,
      repairedJsonPaths: [],
    }
  }

  const providerConfig = config.models?.providers?.[MINIMAX_PORTAL_PROVIDER_ID]
  if (!isPlainObject(providerConfig)) {
    return {
      changed: false,
      config,
      repairedJsonPaths: [],
    }
  }

  const currentApi = String(providerConfig.api || '').trim()
  if (currentApi) {
    return {
      changed: false,
      config,
      repairedJsonPaths: [],
    }
  }

  const nextConfig = cloneJsonValue(config)
  nextConfig.models = isPlainObject(nextConfig.models) ? nextConfig.models : {}
  nextConfig.models.providers = isPlainObject(nextConfig.models.providers) ? nextConfig.models.providers : {}
  nextConfig.models.providers[MINIMAX_PORTAL_PROVIDER_ID] = {
    ...providerConfig,
    api: MINIMAX_PORTAL_PROVIDER_API,
  }

  return {
    changed: true,
    config: nextConfig,
    repairedJsonPaths: [MINIMAX_PORTAL_PROVIDER_API_JSON_PATH],
  }
}

export async function repairKnownProviderConfigGapsOnDisk(params: {
  readConfig: () => Promise<Record<string, any> | null>
  writeConfig: (config: Record<string, any>) => Promise<void>
}): Promise<OpenClawProviderConfigRepairResult> {
  const currentConfig = await params.readConfig().catch(() => null)
  const repairResult = repairKnownProviderConfigGaps(currentConfig)
  if (!repairResult.changed || !repairResult.config) {
    return repairResult
  }

  await params.writeConfig(repairResult.config)
  return repairResult
}

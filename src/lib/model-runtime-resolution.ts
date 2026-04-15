import { canonicalizeModelProviderId, getModelProviderAliasCandidates } from './model-provider-aliases'

export function toRuntimeModelEquivalenceKey(value: unknown): string {
  const normalized = String(value || '').trim()
  if (!normalized) return ''
  if (!normalized.includes('/')) return normalized.toLowerCase()

  const [provider, ...rest] = normalized.split('/')
  const canonicalProvider = canonicalizeModelProviderId(provider)
  const modelId = rest.join('/').trim()
  if (!canonicalProvider || !modelId) return normalized.toLowerCase()

  return `${canonicalProvider}/${modelId}`.toLowerCase()
}

function normalizeProviderId(value: unknown): string {
  return canonicalizeModelProviderId(value).trim().toLowerCase()
}

function normalizeExactProviderId(value: unknown): string {
  return String(value || '').trim().toLowerCase()
}

function normalizeModelList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => String(item || '').trim())
    .filter(Boolean)
}

function isConfiguredRuntimeProviderEntry(entry: any): boolean {
  const status = String(entry?.status || '').trim().toLowerCase()
  if (status && !['missing', 'none', 'error', 'disabled', 'unconfigured'].includes(status)) return true
  if (entry?.authenticated === true) return true
  if (entry?.effective || entry?.modelsJson || entry?.env) return true
  if ((entry?.profiles?.count || 0) > 0) return true
  return false
}

function collectRuntimeModelCandidates(statusData: Record<string, any> | null | undefined): string[] {
  if (!statusData || typeof statusData !== 'object') return []

  const result: string[] = []
  const push = (value: unknown) => {
    const modelKey = String(value || '').trim()
    if (modelKey.includes('/')) result.push(modelKey)
  }
  const pushList = (value: unknown) => {
    if (!Array.isArray(value)) return
    for (const entry of value) push(entry)
  }

  push(statusData.defaultModel)
  push(statusData.resolvedDefault)
  push(statusData.model)
  push(statusData?.agent?.model)
  push(statusData?.agents?.defaults?.model?.primary)
  push(statusData?.agents?.defaults?.model?.image)
  pushList(statusData.allowed)
  pushList(statusData.fallbacks)
  pushList(statusData?.agents?.defaults?.model?.fallbacks)
  pushList(statusData?.agents?.defaults?.model?.imageFallbacks ?? statusData?.agents?.defaults?.model?.image_fallbacks)

  const aliases = statusData.aliases
  if (Array.isArray(aliases)) {
    for (const entry of aliases) {
      push(entry?.model ?? entry?.target)
    }
  } else if (aliases && typeof aliases === 'object') {
    for (const value of Object.values(aliases)) {
      push(value)
    }
  }

  return Array.from(new Set(result))
}

export function extractRuntimeDefaultModelKey(
  statusData: Record<string, any> | null | undefined
): string {
  return String(
    statusData?.defaultModel ??
      statusData?.resolvedDefault ??
      statusData?.model ??
      statusData?.agent?.model ??
      statusData?.agents?.defaults?.model?.primary ??
      ''
  ).trim()
}

export function collectRuntimeConnectedModelKeys(
  statusData: Record<string, any> | null | undefined
): string[] {
  const allowedModels = Array.from(new Set(normalizeModelList(statusData?.allowed))).sort()
  const authProviders = Array.isArray(statusData?.auth?.providers) ? statusData.auth.providers : []
  const oauthProviders = Array.isArray(statusData?.auth?.oauth?.providers) ? statusData.auth.oauth.providers : []
  const exactConfiguredProviderIds = new Set<string>()
  const aliasConfiguredProviderIds = new Set<string>()
  const hasAuthSignals = authProviders.length > 0 || oauthProviders.length > 0

  for (const entry of [...authProviders, ...oauthProviders]) {
    const exactProviderId = normalizeExactProviderId(entry?.provider ?? entry?.providerId)
    if (!exactProviderId || !isConfiguredRuntimeProviderEntry(entry)) continue

    exactConfiguredProviderIds.add(exactProviderId)
    for (const alias of getModelProviderAliasCandidates(exactProviderId)) {
      aliasConfiguredProviderIds.add(alias)
    }
  }

  if (!hasAuthSignals || (exactConfiguredProviderIds.size === 0 && aliasConfiguredProviderIds.size === 0)) {
    return allowedModels
  }

  const exactMatches = allowedModels.filter((modelKey) => {
    const providerId = normalizeExactProviderId(String(modelKey || '').split('/')[0])
    return Boolean(providerId && exactConfiguredProviderIds.has(providerId))
  })
  if (exactMatches.length > 0) return exactMatches

  return allowedModels.filter((modelKey) => {
    const providerId = normalizeProviderId(String(modelKey || '').split('/')[0])
    if (!providerId) return false
    return getModelProviderAliasCandidates(providerId).some((candidate) => aliasConfiguredProviderIds.has(candidate))
  })
}

export function resolvePreferredRuntimeDefaultModelKey(
  statusData: Record<string, any> | null | undefined
): string {
  const connectedModels = collectRuntimeConnectedModelKeys(statusData)
  const rawDefaultModel = extractRuntimeDefaultModelKey(statusData)
  if (rawDefaultModel) {
    return findEquivalentRuntimeModelKey(rawDefaultModel, connectedModels) || rawDefaultModel
  }
  return connectedModels[0] || ''
}

export function areRuntimeModelsEquivalent(left: unknown, right: unknown): boolean {
  const normalizedLeft = toRuntimeModelEquivalenceKey(left)
  const normalizedRight = toRuntimeModelEquivalenceKey(right)
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight)
}

export function findEquivalentRuntimeModelKey(
  targetModel: unknown,
  candidates: Array<unknown>
): string {
  const target = String(targetModel || '').trim()
  if (!target) return ''

  const exact = candidates
    .map((candidate) => String(candidate || '').trim())
    .find((candidate) => candidate === target)
  if (exact) return exact

  return candidates
    .map((candidate) => String(candidate || '').trim())
    .find((candidate) => areRuntimeModelsEquivalent(candidate, target)) || ''
}

export function resolveRuntimeActiveModelKey(
  targetModel: unknown,
  statusData: Record<string, any> | null | undefined
): string {
  return findEquivalentRuntimeModelKey(targetModel, [
    statusData?.defaultModel,
    statusData?.resolvedDefault,
    statusData?.model,
    statusData?.agent?.model,
    statusData?.agents?.defaults?.model?.primary,
  ])
}

export function resolveRuntimeWritableModelKey(
  targetModel: unknown,
  statusData: Record<string, any> | null | undefined
): string {
  const activeModel = resolveRuntimeActiveModelKey(targetModel, statusData)
  if (activeModel) return activeModel
  return findEquivalentRuntimeModelKey(targetModel, collectRuntimeModelCandidates(statusData))
}

export function findEquivalentCatalogModelKey<
  T extends {
    key?: string
  },
>(
  targetModel: unknown,
  catalog: T[]
): string {
  const exact = catalog.find((item) => String(item?.key || '').trim() === String(targetModel || '').trim())
  if (exact?.key) return String(exact.key).trim()

  const matched = catalog.find((item) => areRuntimeModelsEquivalent(item?.key, targetModel))
  return String(matched?.key || '').trim()
}

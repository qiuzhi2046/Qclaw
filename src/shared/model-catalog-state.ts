import {
  buildKnownProviderEnvKeyMap,
  getProviderMetadata,
  listKnownProvidersForEnvKey,
  resolveProviderDisplayName,
  resolveProviderLogo,
} from '../lib/openclaw-provider-registry'
import { canonicalizeModelProviderId, getModelProviderAliasCandidates } from '../lib/model-provider-aliases'
import { findEquivalentCatalogModelKey, toRuntimeModelEquivalenceKey } from '../lib/model-runtime-resolution'
import {
  filterCatalogForDisplay,
  isCatalogModelAvailable,
  reconcileCatalogAvailabilityWithStatus,
  type ModelCatalogVerificationState,
  type ModelCatalogDisplayMode,
} from '../lib/model-catalog-display'
import { extractConfiguredProviderIds } from './configured-provider-extraction'
import type { ModelVerificationRecord } from './model-verification-state'

export interface ModelsPageCatalogItem {
  key: string
  name?: string
  provider: string
  available?: boolean
  verificationState?: ModelCatalogVerificationState
  tags?: string[]
}

export interface ModelsPageConfiguredProvider {
  id: string
  name: string
  logo: string
  description?: string
}

export interface ConfiguredProviderRuntimeState {
  code: 'saved' | 'syncing' | 'active' | 'error'
  label: string
  color: 'gray' | 'blue' | 'green' | 'red'
}

const OPENCLAW_TO_REGISTRY_PROVIDER: Record<string, string> = {
  google: 'gemini',
}

function toRegistryId(openclawId: string): string {
  return OPENCLAW_TO_REGISTRY_PROVIDER[openclawId] || openclawId
}

function extractProviderFromModelKey(modelKey: string): string {
  const normalized = String(modelKey || '').trim()
  if (!normalized.includes('/')) return ''
  return canonicalizeModelProviderId(normalized.split('/')[0])
}

function normalizeProviderSet(providerIds: string[]): Set<string> {
  return new Set(
    providerIds
      .map((providerId) => canonicalizeModelProviderId(providerId))
      .filter(Boolean)
  )
}

function normalizeTagSet(tags: unknown): Set<string> {
  if (!Array.isArray(tags)) return new Set()
  return new Set(
    tags
      .map((tag) => String(tag || '').trim().toLowerCase())
      .filter(Boolean)
  )
}

function buildTagList(tags: unknown, nextTag: string): string[] {
  return Array.from(new Set([
    ...(Array.isArray(tags) ? tags.map((tag) => String(tag || '').trim()).filter(Boolean) : []),
    nextTag,
  ]))
}

function extractRawProviderFromModelKey(modelKey: string): string {
  const normalized = String(modelKey || '').trim()
  if (!normalized.includes('/')) return ''
  return String(normalized.split('/')[0] || '').trim().toLowerCase()
}

function normalizeProviderId(value: unknown): string {
  return canonicalizeModelProviderId(value).trim().toLowerCase()
}

function buildProviderAliasSet(providerId: string): Set<string> {
  return new Set(
    getModelProviderAliasCandidates(providerId)
      .map((candidate) => normalizeProviderId(candidate))
      .filter(Boolean)
  )
}

function isConfiguredRuntimeProviderEntry(entry: any): boolean {
  const status = String(entry?.status || '').trim().toLowerCase()
  if (status && !['missing', 'none', 'error', 'disabled', 'unconfigured'].includes(status)) return true
  if (entry?.authenticated === true) return true
  if (entry?.effective === true) return true
  if (entry?.effective && typeof entry.effective === 'object') return true
  if (entry?.modelsJson || entry?.env) return true
  if ((entry?.profiles?.count || 0) > 0) return true
  return false
}

function isExplicitRuntimeProviderErrorEntry(entry: any): boolean {
  return String(entry?.status || '').trim().toLowerCase() === 'error'
}

function collectRuntimeProviderEntries(
  providerId: string,
  statusData: Record<string, any> | null
): any[] {
  if (!statusData || typeof statusData !== 'object') return []

  const providerAliases = buildProviderAliasSet(providerId)
  const authProviders = [
    ...(Array.isArray(statusData?.auth?.providers) ? statusData.auth.providers : []),
    ...(Array.isArray(statusData?.auth?.oauth?.providers) ? statusData.auth.oauth.providers : []),
  ]

  return authProviders.filter((entry: any) => {
    const runtimeProviderId = normalizeProviderId(entry?.provider ?? entry?.providerId)
    return runtimeProviderId ? providerAliases.has(runtimeProviderId) : false
  })
}

function collectRuntimeProviderModelKeys(
  providerId: string,
  statusData: Record<string, any> | null
): string[] {
  if (!statusData || typeof statusData !== 'object') return []

  const providerAliases = buildProviderAliasSet(providerId)
  const values = [
    ...(Array.isArray(statusData?.allowed) ? statusData.allowed : []),
    statusData?.defaultModel,
    statusData?.resolvedDefault,
    statusData?.model,
    statusData?.agent?.model,
    statusData?.agents?.defaults?.model?.primary,
    statusData?.agents?.defaults?.model?.image,
    ...(Array.isArray(statusData?.fallbacks) ? statusData.fallbacks : []),
    ...(Array.isArray(statusData?.agents?.defaults?.model?.fallbacks) ? statusData.agents.defaults.model.fallbacks : []),
    ...(Array.isArray(statusData?.agents?.defaults?.model?.imageFallbacks)
      ? statusData.agents.defaults.model.imageFallbacks
      : []),
    ...(Array.isArray(statusData?.agents?.defaults?.model?.image_fallbacks)
      ? statusData.agents.defaults.model.image_fallbacks
      : []),
  ]

  const aliases = statusData?.aliases
  if (Array.isArray(aliases)) {
    for (const entry of aliases) {
      values.push(entry?.model ?? entry?.target)
    }
  } else if (aliases && typeof aliases === 'object') {
    values.push(...Object.values(aliases))
  }

  return values
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .filter((modelKey) => providerAliases.has(normalizeProviderId(extractRawProviderFromModelKey(modelKey))))
}

function isPreferredCatalogCandidate(
  next: ModelsPageCatalogItem,
  current: ModelsPageCatalogItem,
  preferredModelKey: string
): boolean {
  const normalizedPreferredModelKey = String(preferredModelKey || '').trim()
  const nextKey = String(next.key || '').trim()
  const currentKey = String(current.key || '').trim()

  const nextExactPreferred = normalizedPreferredModelKey.length > 0 && nextKey === normalizedPreferredModelKey
  const currentExactPreferred = normalizedPreferredModelKey.length > 0 && currentKey === normalizedPreferredModelKey
  if (nextExactPreferred !== currentExactPreferred) return nextExactPreferred

  const nextAvailable = next.available !== false
  const currentAvailable = current.available !== false
  if (nextAvailable !== currentAvailable) return nextAvailable

  const nextTags = normalizeTagSet(next.tags)
  const currentTags = normalizeTagSet(current.tags)
  const nextDefault = nextTags.has('default')
  const currentDefault = currentTags.has('default')
  if (nextDefault !== currentDefault) return nextDefault

  const nextConfigured = nextTags.has('configured')
  const currentConfigured = currentTags.has('configured')
  if (nextConfigured !== currentConfigured) return nextConfigured

  const preferredProviderId = extractRawProviderFromModelKey(normalizedPreferredModelKey)
  const nextExactProvider = preferredProviderId.length > 0 && extractRawProviderFromModelKey(nextKey) === preferredProviderId
  const currentExactProvider =
    preferredProviderId.length > 0 && extractRawProviderFromModelKey(currentKey) === preferredProviderId
  if (nextExactProvider !== currentExactProvider) return nextExactProvider

  return false
}

function collectConfiguredProviderIdsFromEnv(
  envVars: Record<string, string> | null,
  savedProviderIds: Set<string> = new Set()
): string[] {
  if (!envVars) return []

  const envKeyMap = buildKnownProviderEnvKeyMap()
  const envKeyToProvider: Record<string, string> = Object.fromEntries(
    Object.entries(envKeyMap).map(([providerId, envKey]) => [envKey, canonicalizeModelProviderId(providerId)])
  )

  return Object.entries(envVars)
    .filter(([, value]) => Boolean(value))
    .map(([envKey]) => {
      const sharedProviders = listKnownProvidersForEnvKey(envKey)
        .map((providerId) => canonicalizeModelProviderId(providerId))
        .filter(Boolean)
      if (sharedProviders.length <= 1) {
        return sharedProviders[0] || envKeyToProvider[envKey]
      }

      const savedMatches = sharedProviders.filter((providerId) => savedProviderIds.has(providerId))
      if (savedMatches.length === 1) {
        return savedMatches[0]
      }

      return envKeyToProvider[envKey] || ''
    })
    .filter(Boolean)
}

function normalizeConfiguredProviderModelEntries(
  configData: Record<string, any> | null
): ModelsPageCatalogItem[] {
  const providers =
    configData?.models?.providers && typeof configData.models.providers === 'object' && !Array.isArray(configData.models.providers)
      ? configData.models.providers
      : {}
  const items: ModelsPageCatalogItem[] = []

  for (const [providerId, providerConfig] of Object.entries(providers)) {
    if (!providerConfig || typeof providerConfig !== 'object' || Array.isArray(providerConfig)) continue
    const canonicalProviderId = canonicalizeModelProviderId(providerId)
    if (!canonicalProviderId) continue

    const models = Array.isArray((providerConfig as Record<string, unknown>).models)
      ? (providerConfig as Record<string, unknown>).models as unknown[]
      : []

    for (const entry of models) {
      const modelId = String(
        typeof entry === 'string'
          ? entry
          : (entry as Record<string, unknown>)?.id ?? (entry as Record<string, unknown>)?.key ?? ''
      ).trim()
      if (!modelId) continue

      const name = String(
        typeof entry === 'string'
          ? entry
          : (entry as Record<string, unknown>)?.name ?? modelId
      ).trim() || modelId

      items.push({
        key: `${canonicalProviderId}/${modelId}`,
        provider: canonicalProviderId,
        name,
        available: false,
        verificationState: 'unverified',
        tags: ['configured'],
      })
    }
  }

  return items
}

export function mergeConfiguredProviderModelsIntoCatalog<T extends ModelsPageCatalogItem>(
  catalog: T[],
  configData: Record<string, any> | null
): T[] {
  const merged = Array.isArray(catalog) ? [...catalog] : []
  const configuredItems = normalizeConfiguredProviderModelEntries(configData)
  if (configuredItems.length === 0) return merged

  const keyToIndex = new Map<string, number>()
  merged.forEach((item, index) => {
    const key = String(item?.key || '').trim().toLowerCase()
    if (key) keyToIndex.set(key, index)
  })

  for (const configuredItem of configuredItems) {
    const normalizedKey = configuredItem.key.toLowerCase()
    const existingIndex = keyToIndex.get(normalizedKey)
    if (existingIndex === undefined) {
      merged.push(configuredItem as T)
      keyToIndex.set(normalizedKey, merged.length - 1)
      continue
    }

    const current = merged[existingIndex]
    merged[existingIndex] = {
      ...current,
      ...(String(current?.name || '').trim() ? {} : { name: configuredItem.name }),
      tags: buildTagList(current?.tags, 'configured'),
    }
  }

  return merged
}

export function mergeRuntimeProviderModelsIntoCatalog<T extends ModelsPageCatalogItem>(
  catalog: T[],
  providers: ModelsPageConfiguredProvider[],
  statusData: Record<string, any> | null
): T[] {
  const merged = Array.isArray(catalog) ? [...catalog] : []
  if (merged.length === 0 && providers.length === 0) return merged

  const keyToIndex = new Map<string, number>()
  const runtimeKeyToIndex = new Map<string, number>()
  merged.forEach((item, index) => {
    const key = String(item?.key || '').trim().toLowerCase()
    if (key) keyToIndex.set(key, index)
    const runtimeKey = toRuntimeModelEquivalenceKey(item?.key)
    if (runtimeKey) {
      runtimeKeyToIndex.set(runtimeKey, index)
    }
  })

  for (const provider of providers) {
    const providerId = canonicalizeModelProviderId(provider.id)
    if (!providerId) continue

    for (const runtimeModelKey of collectRuntimeProviderModelKeys(providerId, statusData)) {
      const normalizedRuntimeKey = String(runtimeModelKey || '').trim()
      if (!normalizedRuntimeKey) continue

      const existingIndex = keyToIndex.get(normalizedRuntimeKey.toLowerCase())
      if (existingIndex !== undefined) {
        continue
      }

      const runtimeEquivalenceKey = toRuntimeModelEquivalenceKey(normalizedRuntimeKey)
      if (runtimeEquivalenceKey && runtimeKeyToIndex.has(runtimeEquivalenceKey)) {
        continue
      }

      const modelName = String(normalizedRuntimeKey.split('/').slice(1).join('/') || normalizedRuntimeKey).trim()
      merged.push({
        key: normalizedRuntimeKey,
        provider: providerId,
        name: modelName,
        available: false,
        verificationState: 'unverified',
        tags: ['configured'],
      } as T)
      keyToIndex.set(normalizedRuntimeKey.toLowerCase(), merged.length - 1)
      if (runtimeEquivalenceKey) {
        runtimeKeyToIndex.set(runtimeEquivalenceKey, merged.length - 1)
      }
    }
  }

  return merged
}

export function canSwitchModelsPageCatalogItem(item: ModelsPageCatalogItem | null | undefined): boolean {
  return Boolean(item)
}

export function resolveModelsPageCatalogItemVerificationState(
  item: ModelsPageCatalogItem | null | undefined
): ModelCatalogVerificationState {
  if (item?.verificationState) return item.verificationState
  if (item?.available === true) return 'verified-available'
  if (item?.available === false) return 'verified-unavailable'
  return 'unverified'
}

export function resolveModelsPageActiveModel(
  statusData: Record<string, any> | null,
  configData: Record<string, any> | null
): string {
  return String(
    statusData?.defaultModel ??
      statusData?.model ??
      configData?.defaultModel ??
      configData?.agents?.defaults?.model?.primary ??
      configData?.model ??
      ''
  ).trim()
}

export function buildModelsPageConfiguredProviders(params: {
  envVars: Record<string, string> | null
  config: Record<string, any> | null
  statusData: Record<string, any> | null
}): ModelsPageConfiguredProvider[] {
  const savedProviderIds = new Set(
    extractConfiguredProviderIds({
      config: params.config,
      modelStatus: null,
    }).map((providerId) => canonicalizeModelProviderId(providerId))
  )
  const configuredIdsFromSnapshots = [
    ...collectConfiguredProviderIdsFromEnv(params.envVars, savedProviderIds),
    ...Array.from(savedProviderIds),
  ]
  const configuredIds = configuredIdsFromSnapshots

  return Array.from(new Set(configuredIds.filter(Boolean))).map((providerId) => {
    const registryId = toRegistryId(providerId)
    const metadata = getProviderMetadata(registryId)
    return {
      id: providerId,
      name: resolveProviderDisplayName(registryId),
      logo: resolveProviderLogo(registryId),
      description: metadata?.description,
    }
  })
}

export function resolveConfiguredProviderRuntimeState(params: {
  providerId: string
  statusData: Record<string, any> | null
  catalog?: ModelsPageCatalogItem[]
}): ConfiguredProviderRuntimeState {
  const matchingRuntimeEntries =
    params.statusData && typeof params.statusData === 'object'
      ? collectRuntimeProviderEntries(params.providerId, params.statusData)
      : []
  const hasExplicitRuntimeError = matchingRuntimeEntries.some((entry) => isExplicitRuntimeProviderErrorEntry(entry))
  if (hasExplicitRuntimeError) {
    return {
      code: 'error',
      label: '异常',
      color: 'red',
    }
  }

  const hasConfirmedCatalogModels = Array.isArray(params.catalog)
    && params.catalog.some((item) => item?.verificationState === 'verified-available' || item?.available === true)

  if (hasConfirmedCatalogModels) {
    return {
      code: 'active',
      label: '已生效',
      color: 'green',
    }
  }

  if (!params.statusData || typeof params.statusData !== 'object') {
    return {
      code: 'saved',
      label: '已保存',
      color: 'gray',
    }
  }

  const hasConfirmedModels = collectRuntimeProviderModelKeys(params.providerId, params.statusData).length > 0
  const hasConfiguredRuntimeEntry = matchingRuntimeEntries.some((entry) => isConfiguredRuntimeProviderEntry(entry))
  if (hasConfiguredRuntimeEntry || hasConfirmedModels) {
    return {
      code: 'active',
      label: '已生效',
      color: 'green',
    }
  }

  return {
    code: 'syncing',
    label: '同步中',
    color: 'blue',
  }
}

export function dedupeModelsPageCatalogByRuntimeKey<T extends ModelsPageCatalogItem>(
  catalog: T[],
  options: {
    preferredModelKey?: string
  } = {}
): T[] {
  const preferredModelKey = String(options.preferredModelKey || '').trim()
  const deduped = new Map<string, T>()

  for (const item of catalog) {
    const key = String(item?.key || '').trim()
    if (!key) continue

    const runtimeKey = toRuntimeModelEquivalenceKey(key) || key.toLowerCase()
    const current = deduped.get(runtimeKey)
    if (!current) {
      deduped.set(runtimeKey, item)
      continue
    }

    if (isPreferredCatalogCandidate(item, current, preferredModelKey)) {
      deduped.set(runtimeKey, item)
    }
  }

  return Array.from(deduped.values())
}

export function buildEffectiveModelCatalog<T extends ModelsPageCatalogItem>(
  catalog: T[],
  options: {
    statusData?: Record<string, any> | null
    preferredModelKey?: string
    configuredProviderIds?: string[]
    verificationRecords?: ModelVerificationRecord[]
  } = {}
): T[] {
  return dedupeModelsPageCatalogByRuntimeKey(
    reconcileCatalogAvailabilityWithStatus(
      catalog,
      options.statusData,
      options.configuredProviderIds || [],
      options.verificationRecords || []
    ),
    { preferredModelKey: options.preferredModelKey }
  )
}

export function resolveModelsPageCatalogState<T extends ModelsPageCatalogItem>(params: {
  catalog: T[]
  envVars: Record<string, string> | null
  config: Record<string, any> | null
  statusData: Record<string, any> | null
  verificationRecords?: ModelVerificationRecord[]
  preferredModelKey?: string
  mode?: ModelCatalogDisplayMode
}): {
  effectiveCatalog: T[]
  visibleCatalog: T[]
  scopedCatalog: T[]
  configuredProviders: ModelsPageConfiguredProvider[]
} {
  const locallyConfiguredProviders = buildModelsPageConfiguredProviders({
    envVars: params.envVars,
    config: params.config,
    statusData: params.statusData,
  })
  const catalogWithConfiguredModels = mergeConfiguredProviderModelsIntoCatalog(params.catalog, params.config)
  const catalogWithRuntimeProviderModels = mergeRuntimeProviderModelsIntoCatalog(
    catalogWithConfiguredModels,
    locallyConfiguredProviders,
    params.statusData
  )
  const effectiveCatalogWithRuntimeModels = buildEffectiveModelCatalog(catalogWithRuntimeProviderModels, {
    statusData: params.statusData,
    preferredModelKey: params.preferredModelKey,
    configuredProviderIds: locallyConfiguredProviders.map((provider) => provider.id),
    verificationRecords: params.verificationRecords || [],
  })
  const visibleCatalog = filterCatalogForDisplay(
    effectiveCatalogWithRuntimeModels,
    params.mode || 'available'
  ) as T[]
  const configuredProviders = filterConfiguredProvidersWithVisibleModels(
    locallyConfiguredProviders,
    visibleCatalog,
    effectiveCatalogWithRuntimeModels
  )
  const scopedCatalog = filterModelsPageCatalogByConfiguredProviders(
    effectiveCatalogWithRuntimeModels,
    configuredProviders
  ) as T[]
  const scopedVisibleCatalog = filterModelsPageCatalogByConfiguredProviders(
    visibleCatalog,
    configuredProviders
  ) as T[]

  return {
    effectiveCatalog: effectiveCatalogWithRuntimeModels,
    visibleCatalog: scopedVisibleCatalog,
    scopedCatalog,
    configuredProviders,
  }
}

export function buildVisibleModelCatalog<T extends ModelsPageCatalogItem>(
  catalog: T[],
  options: {
    mode?: ModelCatalogDisplayMode
    statusData?: Record<string, any> | null
    preferredModelKey?: string
    configuredProviderIds?: string[]
    verificationRecords?: ModelVerificationRecord[]
  } = {}
): T[] {
  return filterCatalogForDisplay(
    buildEffectiveModelCatalog(catalog, {
      statusData: options.statusData,
      preferredModelKey: options.preferredModelKey,
      configuredProviderIds: options.configuredProviderIds,
      verificationRecords: options.verificationRecords,
    }),
    options.mode || 'available'
  ) as T[]
}

export function getModelsPageProviderModels(
  providerId: string,
  catalog: ModelsPageCatalogItem[]
): ModelsPageCatalogItem[] {
  const canonicalProviderId = canonicalizeModelProviderId(providerId)
  if (!canonicalProviderId) return []
  return catalog.filter((item) => canonicalizeModelProviderId(item.provider) === canonicalProviderId)
}

export function filterModelsPageCatalogByConfiguredProviders(
  catalog: ModelsPageCatalogItem[],
  providers: ModelsPageConfiguredProvider[]
): ModelsPageCatalogItem[] {
  const configuredProviderIds = normalizeProviderSet(providers.map((provider) => provider.id))
  if (configuredProviderIds.size === 0) {
    return []
  }

  return catalog.filter((item) => configuredProviderIds.has(canonicalizeModelProviderId(item.provider)))
}

export function filterConfiguredProvidersWithVisibleModels(
  providers: ModelsPageConfiguredProvider[],
  visibleCatalog: ModelsPageCatalogItem[],
  fullCatalog: ModelsPageCatalogItem[] = visibleCatalog
): ModelsPageConfiguredProvider[] {
  if (fullCatalog.length === 0) {
    return providers
  }
  return providers.filter((provider) => {
    if (getModelsPageProviderModels(provider.id, visibleCatalog).length > 0) {
      return true
    }
    return getModelsPageProviderModels(provider.id, fullCatalog).length > 0
  })
}

export function resolveVisibleConfiguredActiveModel(params: {
  statusData: Record<string, any> | null
  configData: Record<string, any> | null
  configuredProviders: ModelsPageConfiguredProvider[]
  visibleCatalog: ModelsPageCatalogItem[]
  fullCatalog?: ModelsPageCatalogItem[]
}): string {
  const activeModel = resolveModelsPageActiveModel(params.statusData, params.configData)
  if (!activeModel) return ''

  const activeProviderId = extractProviderFromModelKey(activeModel)
  const configuredProviderIds = normalizeProviderSet(params.configuredProviders.map((provider) => provider.id))
  if (!activeProviderId || !configuredProviderIds.has(activeProviderId)) {
    return ''
  }

  const fullCatalog = params.fullCatalog || params.visibleCatalog
  if (fullCatalog.length === 0) {
    return activeModel
  }

  const matchedVisibleCatalogKey = findEquivalentCatalogModelKey(activeModel, params.visibleCatalog)
  if (matchedVisibleCatalogKey) return matchedVisibleCatalogKey

  const matchedFullCatalogKey = findEquivalentCatalogModelKey(activeModel, fullCatalog)
  if (matchedFullCatalogKey) return matchedFullCatalogKey

  return ''
}

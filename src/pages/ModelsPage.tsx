import { useEffect, useState, useCallback, useRef } from 'react'
import { Alert, Badge, Button, Collapse, Group, Loader, Text, Tooltip, ActionIcon, SegmentedControl } from '@mantine/core'
import { IconChevronRight, IconRefresh, IconPlus, IconTrash } from '@tabler/icons-react'
import ModelCenter, { type SetupModelContext } from './ModelCenter'
import { createPageDataCache } from '../lib/page-data-cache'
import {
  buildModelCatalogDisplaySummary,
  isCatalogModelAvailable,
  type ModelCatalogDisplayMode,
} from '../lib/model-catalog-display'
import {
  canSwitchModelsPageCatalogItem,
  getModelsPageProviderModels,
  resolveConfiguredProviderRuntimeState,
  resolveModelsPageCatalogItemVerificationState,
  resolveModelsPageCatalogState,
  resolveModelsPageActiveModel,
  resolveVisibleConfiguredActiveModel,
} from './models-page-state'
import { extractConfiguredProviderIds } from './dashboard-provider-extraction'
import { applyDefaultModelWithGatewayReload } from '../shared/model-config-gateway'
import {
  resolveRecordedModelVerificationStateFromSwitchResult,
  type ModelVerificationRecord,
} from '../shared/model-verification-state'
import {
  getUpstreamCatalogItemsLike,
  getUpstreamModelStatusLike,
  logUpstreamModelStateFallback,
  readOpenClawUpstreamModelState,
  selectPreferredRendererCatalogItems,
  type RendererUpstreamModelStateResult,
} from '../shared/upstream-model-state'
import { canonicalizeModelProviderId, getModelProviderAliasCandidates } from '../lib/model-provider-aliases'
import { listKnownProviderEnvKeys, listKnownProvidersForEnvKey } from '../lib/openclaw-provider-registry'

type CatalogItem = Awaited<ReturnType<typeof window.api.listModelCatalog>>['items'][number]
type ModelStatusResult = Awaited<ReturnType<typeof window.api.getModelStatus>>
type RefreshModelDataResult = Awaited<ReturnType<typeof window.api.refreshModelData>>

interface ModelsPageSnapshot {
  envVars: Record<string, string> | null
  config: Record<string, any> | null
  modelStatus: Record<string, any> | null
  catalog: CatalogItem[]
  verificationRecords: ModelVerificationRecord[]
}

interface ProviderCleanupNotice {
  tone: 'info' | 'success'
  message: string
}

interface ResidualProviderConfiguration {
  present: boolean
  source: 'status' | 'config' | 'env' | null
  authStorePath?: string
}

interface ProviderRemovalVerification {
  ok: boolean
  message?: string
  authStorePath?: string
}

interface ProviderRemovalVerificationDeps {
  readEnvFile: () => Promise<Record<string, string> | null>
  readConfig: () => Promise<Record<string, any> | null>
  readUpstreamState: () => Promise<RendererUpstreamModelStateResult>
  inspectAuthStore: (input: {
    providerIds: string[]
    authStorePath: string
  }) => Promise<{
    ok: boolean
    present: boolean
    matchedProfileIds: string[]
    matchedLastGoodKeys: string[]
    authStorePath?: string
    error?: string
  }>
}

function toCatalogItemFromUpstream(item: {
  key: string
  provider: string
  name?: string
  available?: boolean
}): CatalogItem {
  const fallbackName = String(item.key.split('/').pop() || item.key).trim()
  return {
    key: item.key,
    provider: item.provider,
    name: String(item.name || '').trim() || fallbackName,
    local: false,
    available: item.available !== false,
    tags: [],
    missing: [],
  }
}

function extractProviderModelId(modelKey: string, providerId: string): string {
  const normalizedModelKey = String(modelKey || '').trim()
  if (!normalizedModelKey.includes('/')) return ''

  const providerIds = normalizeProviderIds(providerId)
  const [rawProviderId, ...rest] = normalizedModelKey.split('/')
  const normalizedProviderId = normalizeProviderId(rawProviderId)
  if (!providerIds.has(normalizedProviderId) && !providerIds.has(canonicalizeModelProviderId(rawProviderId))) {
    return ''
  }

  return rest.join('/').trim()
}

function normalizeOptimisticProviderModels(models: unknown): Array<{ id: string; name: string }> {
  if (!Array.isArray(models)) return []

  return models
    .map((entry) => {
      if (typeof entry === 'string') {
        const modelId = String(entry || '').trim()
        return modelId ? { id: modelId, name: modelId } : null
      }
      const modelId = String(entry?.id ?? entry?.key ?? '').trim()
      if (!modelId) return null
      return {
        id: modelId,
        name: String(entry?.name || modelId).trim() || modelId,
      }
    })
    .filter((entry): entry is { id: string; name: string } => Boolean(entry))
}

function buildOptimisticConfiguredModelItem(modelKey: string, providerId: string): CatalogItem {
  const modelId = extractProviderModelId(modelKey, providerId) || modelKey
  return {
    key: modelKey,
    name: modelId,
    provider: providerId,
    local: false,
    available: true,
    tags: ['configured'],
    missing: [],
  }
}

export function applyOptimisticConfiguredProviderState(params: {
  config: Record<string, any> | null
  statusData: Record<string, any> | null
  catalog: CatalogItem[]
  context?: SetupModelContext | null
}): {
  nextConfig: Record<string, any> | null
  nextStatus: Record<string, any> | null
  nextCatalog: CatalogItem[]
} {
  const providerId = String(params.context?.providerId || '').trim()
  const preferredModelKey = String(params.context?.preferredModelKey || '').trim()
  if (!providerId) {
    return {
      nextConfig: params.config,
      nextStatus: params.statusData,
      nextCatalog: params.catalog,
    }
  }

  const nextConfig =
    params.config && typeof params.config === 'object' && !Array.isArray(params.config) ? { ...params.config } : {}
  const nextModels =
    nextConfig.models && typeof nextConfig.models === 'object' && !Array.isArray(nextConfig.models)
      ? { ...nextConfig.models }
      : {}
  const nextProviders =
    nextModels.providers && typeof nextModels.providers === 'object' && !Array.isArray(nextModels.providers)
      ? { ...nextModels.providers }
      : {}
  const currentProviderConfig =
    nextProviders[providerId] && typeof nextProviders[providerId] === 'object' && !Array.isArray(nextProviders[providerId])
      ? { ...nextProviders[providerId] }
      : {}
  const preferredModelId = extractProviderModelId(preferredModelKey, providerId)
  const providerModels = normalizeOptimisticProviderModels(currentProviderConfig.models)
  if (preferredModelId && !providerModels.some((entry) => entry.id === preferredModelId)) {
    providerModels.unshift({
      id: preferredModelId,
      name: preferredModelId,
    })
  }
  nextProviders[providerId] = {
    ...currentProviderConfig,
    enabled: true,
    ...(providerModels.length > 0 ? { models: providerModels } : {}),
  }
  nextModels.providers = nextProviders
  nextConfig.models = nextModels

  const nextStatus =
    params.statusData && typeof params.statusData === 'object' && !Array.isArray(params.statusData)
      ? { ...params.statusData }
      : {}
  const nextAuth =
    nextStatus.auth && typeof nextStatus.auth === 'object' && !Array.isArray(nextStatus.auth)
      ? { ...nextStatus.auth }
      : {}
  const providerIds = normalizeProviderIds(providerId)
  const authProviders = Array.isArray(nextAuth.providers) ? nextAuth.providers : []
  const existingProviderEntry = authProviders.find((entry: any) => {
    const entryProviderId = normalizeProviderId(entry?.provider ?? entry?.providerId)
    return providerIds.has(entryProviderId)
  })
  nextAuth.providers = [
    {
      ...(existingProviderEntry && typeof existingProviderEntry === 'object' ? existingProviderEntry : {}),
      provider: providerId,
      status: String(existingProviderEntry?.status || 'ok').trim() || 'ok',
    },
    ...authProviders.filter((entry: any) => {
      const entryProviderId = normalizeProviderId(entry?.provider ?? entry?.providerId)
      return !providerIds.has(entryProviderId)
    }),
  ]
  nextStatus.auth = nextAuth
  if (preferredModelKey) {
    nextStatus.defaultModel = preferredModelKey
    nextStatus.resolvedDefault = preferredModelKey
  }

  const nextCatalog = Array.isArray(params.catalog) ? [...params.catalog] : []
  if (preferredModelKey) {
    const optimisticItem = buildOptimisticConfiguredModelItem(preferredModelKey, providerId)
    const existingIndex = nextCatalog.findIndex((item) => String(item?.key || '').trim() === preferredModelKey)
    if (existingIndex >= 0) {
      const current = nextCatalog[existingIndex]
      const currentTags = Array.isArray(current?.tags) ? current.tags.map((tag) => String(tag || '').trim()).filter(Boolean) : []
      nextCatalog[existingIndex] = {
        ...current,
        ...optimisticItem,
        tags: Array.from(new Set([...currentTags, 'configured'])),
        available: true,
      }
    } else {
      nextCatalog.unshift(optimisticItem)
    }
  }

  return {
    nextConfig,
    nextStatus,
    nextCatalog,
  }
}

const MODELS_PAGE_CACHE_TTL_MS = 60 * 1000
const modelsPageCache = createPageDataCache<ModelsPageSnapshot>({ ttlMs: MODELS_PAGE_CACHE_TTL_MS })
const MODELS_RESERVED_KEYS = new Set(['mode', 'providers', 'allow', 'deny', 'fallbacks', 'imageFallbacks', 'aliases'])

function normalizeProviderId(value: unknown): string {
  return String(value || '').trim().toLowerCase()
}

function normalizeProviderIds(providerId: string): Set<string> {
  const values = [
    normalizeProviderId(providerId),
    canonicalizeModelProviderId(providerId),
    ...getModelProviderAliasCandidates(providerId),
  ]
  return new Set(values.map((value) => normalizeProviderId(value)).filter(Boolean))
}

function modelBelongsToProvider(modelKey: unknown, providerIds: Set<string>): boolean {
  const key = String(modelKey || '').trim()
  if (!key.includes('/')) return false
  const provider = normalizeProviderId(key.split('/')[0])
  const canonicalProvider = canonicalizeModelProviderId(provider)
  return providerIds.has(provider) || providerIds.has(canonicalProvider)
}

function pruneModelList(list: unknown, providerIds: Set<string>): { next: string[] | null; changed: boolean } {
  if (!Array.isArray(list)) return { next: null, changed: false }
  const next = list
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .filter((item) => !modelBelongsToProvider(item, providerIds))
  return { next, changed: next.length !== list.length }
}

function pruneAliases(value: unknown, providerIds: Set<string>): { next: unknown; changed: boolean } {
  if (Array.isArray(value)) {
    const next = value.filter((item: any) => {
      const model = String(item?.model ?? item?.target ?? '').trim()
      if (!model) return true
      return !modelBelongsToProvider(model, providerIds)
    })
    return { next, changed: next.length !== value.length }
  }

  if (!value || typeof value !== 'object') {
    return { next: null, changed: false }
  }

  const source = value as Record<string, unknown>
  const next: Record<string, unknown> = {}
  let changed = false
  for (const [alias, model] of Object.entries(source)) {
    const modelKey = String(model || '').trim()
    if (modelKey && modelBelongsToProvider(modelKey, providerIds)) {
      changed = true
      continue
    }
    next[alias] = model
  }

  if (!changed && Object.keys(next).length !== Object.keys(source).length) {
    changed = true
  }
  return { next, changed }
}

function providerSetMatches(providerIds: Set<string>, value: unknown): boolean {
  const normalized = normalizeProviderId(value)
  if (!normalized) return false
  const canonical = canonicalizeModelProviderId(normalized)
  return providerIds.has(normalized) || providerIds.has(canonical)
}

function runtimeStatusReferencesProvider(
  modelStatus: Record<string, any> | null,
  providerIds: Set<string>
): boolean {
  if (!modelStatus || typeof modelStatus !== 'object') {
    return false
  }

  const matchesModel = (value: unknown) => modelBelongsToProvider(value, providerIds)
  const matchesModelList = (value: unknown) =>
    Array.isArray(value) && value.some((entry) => matchesModel(entry))

  return [
    modelStatus.defaultModel,
    modelStatus.resolvedDefault,
    modelStatus.model,
    modelStatus?.agent?.model,
    modelStatus?.agents?.defaults?.model?.primary,
    modelStatus?.agents?.defaults?.model?.image,
  ].some((value) => matchesModel(value))
    || [
      modelStatus.allowed,
      modelStatus.fallbacks,
      modelStatus?.agents?.defaults?.model?.fallbacks,
      modelStatus?.agents?.defaults?.model?.imageFallbacks ?? modelStatus?.agents?.defaults?.model?.image_fallbacks,
    ].some((value) => matchesModelList(value))
}

const ENV_SOURCE_KEY_PATTERN = /\benv:\s*([A-Z][A-Z0-9_]*)\b/g

function normalizeEnvKey(value: unknown): string {
  const normalized = String(value || '').trim().toUpperCase()
  return /^[A-Z][A-Z0-9_]*$/.test(normalized) ? normalized : ''
}

function collectEnvKeysFromValue(value: unknown, collector: Set<string>): void {
  if (!value) return

  if (typeof value === 'string') {
    const matches = value.matchAll(ENV_SOURCE_KEY_PATTERN)
    for (const match of matches) {
      const envKey = normalizeEnvKey(match[1])
      if (envKey) collector.add(envKey)
    }
    return
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectEnvKeysFromValue(item, collector)
    }
    return
  }

  if (typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) {
      collectEnvKeysFromValue(item, collector)
    }
  }
}

function stripLegacyTopLevelDefaultModel(
  config: Record<string, any>,
  providerIds: Set<string>
): boolean {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return false
  }
  if (!Object.prototype.hasOwnProperty.call(config, 'defaultModel')) {
    return false
  }
  if (!modelBelongsToProvider(config.defaultModel, providerIds)) {
    return false
  }
  delete config.defaultModel
  return true
}

export function removeProviderFromConfig(
  sourceConfig: Record<string, any> | null,
  providerId: string
): { nextConfig: Record<string, any>; removed: boolean } {
  const baseConfig = sourceConfig && typeof sourceConfig === 'object' ? sourceConfig : {}
  const nextConfig = JSON.parse(JSON.stringify(baseConfig)) as Record<string, any>
  const providerIds = normalizeProviderIds(providerId)
  let removed = false

  const modelsSection = nextConfig.models
  if (modelsSection && typeof modelsSection === 'object' && !Array.isArray(modelsSection)) {
    const providers = modelsSection.providers
    if (providers && typeof providers === 'object' && !Array.isArray(providers)) {
      for (const key of Object.keys(providers)) {
        const normalized = normalizeProviderId(key)
        const canonical = canonicalizeModelProviderId(normalized)
        if (providerIds.has(normalized) || providerIds.has(canonical)) {
          delete providers[key]
          removed = true
        }
      }
    }

    for (const key of Object.keys(modelsSection)) {
      if (MODELS_RESERVED_KEYS.has(key)) continue
      const normalized = normalizeProviderId(key)
      const canonical = canonicalizeModelProviderId(normalized)
      if (providerIds.has(normalized) || providerIds.has(canonical)) {
        delete modelsSection[key]
        removed = true
      }
    }

    if (modelBelongsToProvider(modelsSection.default, providerIds)) {
      delete modelsSection.default
      removed = true
    }
    if (modelBelongsToProvider(modelsSection.main, providerIds)) {
      delete modelsSection.main
      removed = true
    }
    if (modelBelongsToProvider(modelsSection.image, providerIds)) {
      delete modelsSection.image
      removed = true
    }
    if (modelBelongsToProvider(modelsSection.imageDefault, providerIds)) {
      delete modelsSection.imageDefault
      removed = true
    }
  }

  if (stripLegacyTopLevelDefaultModel(nextConfig, providerIds)) {
    removed = true
  }
  if (modelBelongsToProvider(nextConfig.model, providerIds)) {
    delete nextConfig.model
    removed = true
  }

  const topLevelFallbacks = pruneModelList(nextConfig.fallbacks, providerIds)
  if (topLevelFallbacks.changed) {
    nextConfig.fallbacks = topLevelFallbacks.next
    removed = true
  }
  const topLevelImageFallbacks = pruneModelList(nextConfig.imageFallbacks, providerIds)
  if (topLevelImageFallbacks.changed) {
    nextConfig.imageFallbacks = topLevelImageFallbacks.next
    removed = true
  }
  const topLevelImageFallbacksSnake = pruneModelList(nextConfig.image_fallbacks, providerIds)
  if (topLevelImageFallbacksSnake.changed) {
    nextConfig.image_fallbacks = topLevelImageFallbacksSnake.next
    removed = true
  }
  const topLevelAllowed = pruneModelList(nextConfig.allowed, providerIds)
  if (topLevelAllowed.changed) {
    nextConfig.allowed = topLevelAllowed.next
    removed = true
  }
  const topLevelAllow = pruneModelList(nextConfig.allow, providerIds)
  if (topLevelAllow.changed) {
    nextConfig.allow = topLevelAllow.next
    removed = true
  }
  const topLevelDenied = pruneModelList(nextConfig.denied, providerIds)
  if (topLevelDenied.changed) {
    nextConfig.denied = topLevelDenied.next
    removed = true
  }
  const topLevelDeny = pruneModelList(nextConfig.deny, providerIds)
  if (topLevelDeny.changed) {
    nextConfig.deny = topLevelDeny.next
    removed = true
  }
  const topLevelAliases = pruneAliases(nextConfig.aliases, providerIds)
  if (topLevelAliases.changed) {
    nextConfig.aliases = topLevelAliases.next
    removed = true
  }

  if (modelsSection && typeof modelsSection === 'object' && !Array.isArray(modelsSection)) {
    const modelFallbacks = pruneModelList(modelsSection.fallbacks, providerIds)
    if (modelFallbacks.changed) {
      modelsSection.fallbacks = modelFallbacks.next
      removed = true
    }
    const modelImageFallbacks = pruneModelList(modelsSection.imageFallbacks, providerIds)
    if (modelImageFallbacks.changed) {
      modelsSection.imageFallbacks = modelImageFallbacks.next
      removed = true
    }
    const modelImageFallbacksSnake = pruneModelList(modelsSection.image_fallbacks, providerIds)
    if (modelImageFallbacksSnake.changed) {
      modelsSection.image_fallbacks = modelImageFallbacksSnake.next
      removed = true
    }
    const modelAllowed = pruneModelList(modelsSection.allowed, providerIds)
    if (modelAllowed.changed) {
      modelsSection.allowed = modelAllowed.next
      removed = true
    }
    const modelAllow = pruneModelList(modelsSection.allow, providerIds)
    if (modelAllow.changed) {
      modelsSection.allow = modelAllow.next
      removed = true
    }
    const modelDenied = pruneModelList(modelsSection.denied, providerIds)
    if (modelDenied.changed) {
      modelsSection.denied = modelDenied.next
      removed = true
    }
    const modelDeny = pruneModelList(modelsSection.deny, providerIds)
    if (modelDeny.changed) {
      modelsSection.deny = modelDeny.next
      removed = true
    }
    const modelAliases = pruneAliases(modelsSection.aliases, providerIds)
    if (modelAliases.changed) {
      modelsSection.aliases = modelAliases.next
      removed = true
    }
  }

  const defaultsModel = nextConfig?.agents?.defaults?.model
  if (defaultsModel && typeof defaultsModel === 'object' && !Array.isArray(defaultsModel)) {
    if (modelBelongsToProvider(defaultsModel.primary, providerIds)) {
      delete defaultsModel.primary
      removed = true
    }
    if (modelBelongsToProvider(defaultsModel.image, providerIds)) {
      delete defaultsModel.image
      removed = true
    }
    const defaultFallbacks = pruneModelList(defaultsModel.fallbacks, providerIds)
    if (defaultFallbacks.changed) {
      defaultsModel.fallbacks = defaultFallbacks.next
      removed = true
    }
    const defaultImageFallbacks = pruneModelList(defaultsModel.imageFallbacks, providerIds)
    if (defaultImageFallbacks.changed) {
      defaultsModel.imageFallbacks = defaultImageFallbacks.next
      removed = true
    }
    const defaultImageFallbacksSnake = pruneModelList(defaultsModel.image_fallbacks, providerIds)
    if (defaultImageFallbacksSnake.changed) {
      defaultsModel.image_fallbacks = defaultImageFallbacksSnake.next
      removed = true
    }
  }

  const defaultsModels = nextConfig?.agents?.defaults?.models
  if (defaultsModels && typeof defaultsModels === 'object' && !Array.isArray(defaultsModels)) {
    for (const key of Object.keys(defaultsModels)) {
      if (modelBelongsToProvider(key, providerIds)) {
        delete defaultsModels[key]
        removed = true
      }
    }
  }

  const authProfiles = nextConfig?.auth?.profiles
  if (authProfiles && typeof authProfiles === 'object' && !Array.isArray(authProfiles)) {
    for (const [profileKey, profile] of Object.entries(authProfiles as Record<string, any>)) {
      const profileProvider = profile && typeof profile === 'object' ? profile.provider : ''
      const keyProvider = String(profileKey || '').split(':')[0]
      if (providerSetMatches(providerIds, profileProvider) || providerSetMatches(providerIds, keyProvider)) {
        delete (authProfiles as Record<string, any>)[profileKey]
        removed = true
      }
    }
  }

  return { nextConfig, removed }
}

export function removeProviderFromStatus(
  sourceStatus: Record<string, any> | null,
  providerId: string
): { nextStatus: Record<string, any> | null; removed: boolean } {
  if (!sourceStatus || typeof sourceStatus !== 'object') {
    return { nextStatus: sourceStatus, removed: false }
  }

  const nextStatus = JSON.parse(JSON.stringify(sourceStatus)) as Record<string, any>
  const providerIds = normalizeProviderIds(providerId)
  if (providerIds.has('google')) {
    providerIds.add('gemini')
  }

  let removed = false
  const statusProviders = nextStatus?.auth?.providers
  if (Array.isArray(statusProviders)) {
    const filteredProviders = statusProviders.filter((item: any) => {
      const providerValue = item?.provider || item?.providerId
      return !providerSetMatches(providerIds, providerValue)
    })
    if (filteredProviders.length !== statusProviders.length) {
      nextStatus.auth.providers = filteredProviders
      removed = true
    }
  }

  const oauthProviders = nextStatus?.auth?.oauth?.providers
  if (Array.isArray(oauthProviders)) {
    const filteredOauthProviders = oauthProviders.filter((item: any) => {
      const providerValue = item?.provider || item?.providerId
      return !providerSetMatches(providerIds, providerValue)
    })
    if (filteredOauthProviders.length !== oauthProviders.length) {
      nextStatus.auth.oauth.providers = filteredOauthProviders
      removed = true
    }
  }

  if (modelBelongsToProvider(nextStatus.defaultModel, providerIds)) {
    delete nextStatus.defaultModel
    removed = true
  }
  if (modelBelongsToProvider(nextStatus.model, providerIds)) {
    delete nextStatus.model
    removed = true
  }

  return {
    nextStatus,
    removed,
  }
}

export function detectResidualProviderConfiguration(params: {
  providerId: string
  envVars: Record<string, string> | null
  config: Record<string, any> | null
  modelStatus: Record<string, any> | null
  observedEnvKeys?: string[]
}): ResidualProviderConfiguration {
  const providerIds = normalizeProviderIds(params.providerId)
  if (providerIds.has('google')) {
    providerIds.add('gemini')
  }

  const statusProviderIds = extractConfiguredProviderIds({
    config: null,
    modelStatus: params.modelStatus,
  })
  if (statusProviderIds.some((providerId) => providerSetMatches(providerIds, providerId))) {
    const authStorePath = String(params.modelStatus?.auth?.storePath || '').trim()
    return {
      present: true,
      source: 'status',
      authStorePath: authStorePath || undefined,
    }
  }

  if (runtimeStatusReferencesProvider(params.modelStatus, providerIds)) {
    const authStorePath = String(params.modelStatus?.auth?.storePath || '').trim()
    return {
      present: true,
      source: 'status',
      authStorePath: authStorePath || undefined,
    }
  }

  const configProviderIds = extractConfiguredProviderIds({
    config: params.config,
    modelStatus: null,
  })
  if (configProviderIds.some((providerId) => providerSetMatches(providerIds, providerId))) {
    return {
      present: true,
      source: 'config',
    }
  }

  const observedEnvKeys = Array.from(
    new Set(
      (params.observedEnvKeys || [])
        .map((envKey) => normalizeEnvKey(envKey))
        .filter(Boolean)
    )
  )
  const hasEnvBinding = observedEnvKeys.some((envKey) => Boolean(String(params.envVars?.[envKey] || '').trim()))
  if (hasEnvBinding) {
    return {
      present: true,
      source: 'env',
    }
  }

  return {
    present: false,
    source: null,
  }
}

function getRemovalProviderIds(providerId: string): string[] {
  const providerIds = normalizeProviderIds(providerId)
  if (providerIds.has('google')) {
    providerIds.add('gemini')
  }
  return Array.from(providerIds)
}

export function collectProviderBoundEnvKeysFromStatus(params: {
  providerId: string
  modelStatus: Record<string, any> | null
}): string[] {
  const providerIds = new Set(getRemovalProviderIds(params.providerId).map((value) => normalizeProviderId(value)).filter(Boolean))
  const authProviders = [
    ...(Array.isArray(params.modelStatus?.auth?.providers) ? params.modelStatus.auth.providers : []),
    ...(Array.isArray(params.modelStatus?.auth?.oauth?.providers) ? params.modelStatus.auth.oauth.providers : []),
  ]
  const envKeys = new Set<string>()

  for (const entry of authProviders) {
    const providerValue = String(entry?.provider ?? entry?.providerId ?? '').trim()
    if (!providerSetMatches(providerIds, providerValue)) continue
    collectEnvKeysFromValue(entry, envKeys)
  }

  return Array.from(envKeys)
}

function collectKnownProviderEnvKeys(providerId: string): string[] {
  return Array.from(
    new Set(
      listKnownProviderEnvKeys(providerId)
        .map((envKey) => normalizeEnvKey(envKey))
        .filter(Boolean)
    )
  )
}

export function resolveProviderRemovalEnvKeys(params: {
  providerId: string
  candidateEnvKeys?: string[]
  config: Record<string, any> | null
  modelStatus: Record<string, any> | null
}): string[] {
  const providerIds = new Set(getRemovalProviderIds(params.providerId).map((value) => normalizeProviderId(value)).filter(Boolean))
  const remainingProviderIds = new Set(
    extractConfiguredProviderIds({
      config: params.config,
      modelStatus: params.modelStatus,
    })
      .map((providerId) => canonicalizeModelProviderId(providerId))
      .filter(Boolean)
  )

  for (const providerId of providerIds) {
    remainingProviderIds.delete(canonicalizeModelProviderId(providerId))
  }

  const candidateEnvKeys = new Set<string>([
    ...collectKnownProviderEnvKeys(params.providerId),
    ...((params.candidateEnvKeys || []).map((envKey) => normalizeEnvKey(envKey)).filter(Boolean)),
  ])

  return Array.from(candidateEnvKeys).filter((envKey) => {
    const sharedProviderIds = listKnownProvidersForEnvKey(envKey)
      .map((providerId) => canonicalizeModelProviderId(providerId))
      .filter(Boolean)
    if (sharedProviderIds.length === 0) {
      return true
    }
    return !sharedProviderIds.some((providerId) => remainingProviderIds.has(providerId))
  })
}

function resolveModelStatusAuthStorePath(modelStatus: Record<string, any> | null): string | undefined {
  const authStorePath = String(modelStatus?.auth?.storePath || '').trim()
  return authStorePath || undefined
}

function providerSupportsExternalAuthCleanup(providerId: string): boolean {
  return getRemovalProviderIds(providerId).some((item) => canonicalizeModelProviderId(item) === 'openai')
}

function authProfileCleanupChanged(result: {
  removed: number
  clearedLastGoodKeys?: string[]
} | null | undefined): boolean {
  return Boolean(result && (result.removed > 0 || (result.clearedLastGoodKeys?.length || 0) > 0))
}

export function removeResolvedErrorMessages(sourceError: unknown, messagesToClear: string[]): string {
  const staleMessages = new Set(
    (messagesToClear || [])
      .map((message) => String(message || '').trim())
      .filter(Boolean)
  )
  if (staleMessages.size === 0) {
    return String(sourceError || '').trim()
  }

  return String(sourceError || '')
    .split('；')
    .map((message) => String(message || '').trim())
    .filter((message) => Boolean(message) && !staleMessages.has(message))
    .join('；')
}

export async function verifyProviderRemovalState(
  input: {
    provider: { id: string; name: string }
    currentStatusSnapshot: Record<string, any> | null
    authStorePathHint?: string
  },
  deps: ProviderRemovalVerificationDeps
): Promise<ProviderRemovalVerification> {
  const providerDisplayName = String(input.provider?.name || input.provider?.id || '').trim() || '该服务商'
  const [latestEnv, latestConfigRaw, upstreamState] = await Promise.all([
    deps.readEnvFile().catch(() => ({})),
    deps.readConfig().catch(() => null),
    deps.readUpstreamState().catch(() => ({
      ok: false,
      source: 'control-ui-app',
      fallbackUsed: true,
      diagnostics: {
        upstreamAvailable: false,
        connected: false,
        hasClient: false,
        hasHelloSnapshot: false,
        hasHealthResult: false,
        hasSessionsState: false,
        hasModelCatalogState: false,
        appKeys: [],
      },
    } satisfies RendererUpstreamModelStateResult)),
  ])

  const latestConfig = latestConfigRaw && typeof latestConfigRaw === 'object'
    ? (latestConfigRaw as Record<string, any>)
    : null
  const latestUpstreamStatus = getUpstreamModelStatusLike(upstreamState)
  const observedEnvKeys = resolveProviderRemovalEnvKeys({
    providerId: input.provider.id,
    candidateEnvKeys: [
      ...collectProviderBoundEnvKeysFromStatus({
        providerId: input.provider.id,
        modelStatus: input.currentStatusSnapshot,
      }),
      ...collectProviderBoundEnvKeysFromStatus({
        providerId: input.provider.id,
        modelStatus: latestUpstreamStatus,
      }),
    ],
    config: latestConfig,
    modelStatus: latestUpstreamStatus,
  })
  const residual = detectResidualProviderConfiguration({
    providerId: input.provider.id,
    envVars: latestEnv,
    config: latestConfig,
    modelStatus: latestUpstreamStatus,
    observedEnvKeys,
  })
  const authStorePath =
    residual.authStorePath ||
    input.authStorePathHint ||
    resolveModelStatusAuthStorePath(latestUpstreamStatus) ||
    resolveModelStatusAuthStorePath(input.currentStatusSnapshot)

  if (residual.source === 'status' && residual.authStorePath) {
    return {
      ok: false as const,
      message: `服务商「${providerDisplayName}」的本地配置已删除，但运行态认证仍残留在 ${residual.authStorePath}`,
      authStorePath: residual.authStorePath,
    }
  }
  if (residual.source === 'status') {
    return {
      ok: false as const,
      message: `服务商「${providerDisplayName}」的本地配置已删除，但运行态仍检测到认证信息`,
      authStorePath,
    }
  }
  if (residual.source === 'config') {
    return {
      ok: false as const,
      message: `服务商「${providerDisplayName}」在配置文件中仍被识别为已配置`,
    }
  }
  if (residual.source === 'env') {
    return {
      ok: false as const,
      message: `服务商「${providerDisplayName}」的环境变量密钥仍未清空`,
    }
  }

  if (authStorePath) {
    const inspectResult = await deps.inspectAuthStore({
      providerIds: getRemovalProviderIds(input.provider.id),
      authStorePath,
    }).catch((error: any) => ({
      ok: false,
      present: false,
      matchedProfileIds: [],
      matchedLastGoodKeys: [],
      authStorePath,
      error: error?.message || '认证档案检查失败',
    }))

    if (!inspectResult.ok) {
      if (!latestUpstreamStatus) {
        return {
          ok: false as const,
          message: `服务商「${providerDisplayName}」的本地配置已删除，但当前无法确认认证档案是否已清理：${inspectResult.error || '请稍后重试'}`,
          authStorePath,
        }
      }
    } else if (inspectResult.present) {
      return {
        ok: false as const,
        message: `服务商「${providerDisplayName}」的认证档案仍残留在 ${inspectResult.authStorePath || authStorePath}`,
        authStorePath: inspectResult.authStorePath || authStorePath,
      }
    }
  }

  if (!latestUpstreamStatus) {
    return {
      ok: false as const,
      message: `服务商「${providerDisplayName}」的本地配置已删除，但当前无法确认运行态是否仍会从上游或外部 CLI 认证中恢复。`,
      authStorePath,
    }
  }

  return { ok: true as const, authStorePath }
}

function getVerificationBadgeDisplay(verificationState: ReturnType<typeof resolveModelsPageCatalogItemVerificationState>): {
  color: 'green' | 'red' | 'gray'
  variant: 'light' | 'outline'
  label: string
} {
  switch (verificationState) {
    case 'verified-available':
      return {
        color: 'green',
        variant: 'light',
        label: '已验证可用',
      }
    case 'verified-unavailable':
      return {
        color: 'red',
        variant: 'light',
        label: '已验证不可用',
      }
    default:
      return {
        color: 'gray',
        variant: 'outline',
        label: '未验证',
      }
  }
}

export default function ModelsPage() {
  const initialSnapshotRef = useRef<ModelsPageSnapshot | null>(modelsPageCache.get()?.data || null)
  const initialSnapshot = initialSnapshotRef.current
  const [envVars, setEnvVars] = useState<Record<string, string> | null>(initialSnapshot?.envVars || null)
  const [config, setConfig] = useState<Record<string, any> | null>(initialSnapshot?.config || null)
  const [modelStatus, setModelStatus] = useState<Record<string, any> | null>(initialSnapshot?.modelStatus || null)
  const modelStatusRef = useRef<Record<string, any> | null>(initialSnapshot?.modelStatus || null)
  const [catalog, setCatalog] = useState<CatalogItem[]>(initialSnapshot?.catalog || [])
  const latestCatalogRef = useRef<CatalogItem[]>(initialSnapshot?.catalog || [])
  const [verificationRecords, setVerificationRecords] = useState<ModelVerificationRecord[]>(
    initialSnapshot?.verificationRecords || []
  )
  const verificationRecordsRef = useRef<ModelVerificationRecord[]>(initialSnapshot?.verificationRecords || [])
  const [showAddForm, setShowAddForm] = useState(false)
  const [loading, setLoading] = useState(!initialSnapshot)
  const [switching, setSwitching] = useState('')
  const [removingProviderId, setRemovingProviderId] = useState('')
  const [catalogMode, setCatalogMode] = useState<ModelCatalogDisplayMode>('all')
  const [expandedProviders, setExpandedProviders] = useState<Set<string>>(new Set())
  const [error, setError] = useState('')
  const [cleanupNotice, setCleanupNotice] = useState<ProviderCleanupNotice | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    modelStatusRef.current = modelStatus
  }, [modelStatus])

  useEffect(() => {
    verificationRecordsRef.current = verificationRecords
  }, [verificationRecords])

  const loadData = useCallback(async (options?: { background?: boolean; forceRefresh?: boolean; allowCliStatusFallback?: boolean }) => {
    const background = Boolean(options?.background)
    const forceRefresh = Boolean(options?.forceRefresh)
    const allowCliStatusFallback = options?.allowCliStatusFallback !== false
    if (!background) {
      setLoading(true)
    }
    const nextErrors: string[] = []

    try {
      const [env, cfg, upstreamState] = await Promise.all([
        window.api.readEnvFile().catch(() => ({})),
        window.api.readConfig(),
        readOpenClawUpstreamModelState(),
      ])
      setEnvVars(env)
      setConfig(cfg)

      logUpstreamModelStateFallback('ModelsPage', upstreamState, console.info, import.meta.env.DEV)

      const upstreamStatusData = getUpstreamModelStatusLike(upstreamState)
      const upstreamCatalog = getUpstreamCatalogItemsLike(upstreamState)
      const normalizedUpstreamCatalog = upstreamCatalog.map((item) => toCatalogItemFromUpstream(item))
      const needsCliStatus = !upstreamStatusData && allowCliStatusFallback
      let cliRefreshPromise: Promise<RefreshModelDataResult> | null = null
      const loadCliRefresh = () => {
        cliRefreshPromise ??= window.api.refreshModelData({
          includeCapabilities: false,
          includeStatus: needsCliStatus,
          includeCatalog: true,
          fullCatalog: true,
          catalogQuery: forceRefresh ? { bypassCache: true } : {},
        })
        return cliRefreshPromise
      }

      let resolvedModelStatus: Record<string, any> | null = upstreamStatusData
      if (upstreamStatusData) {
        setModelStatus(upstreamStatusData)
      } else if (allowCliStatusFallback) {
        const statusResult = (await loadCliRefresh().catch(() => null))?.status
          || await window.api.getModelStatus().catch((reason: any) => ({
            ok: false,
            action: 'status',
            command: [],
            stdout: '',
            stderr: '',
            code: null,
            message: reason?.message || '模型状态读取失败',
          } satisfies ModelStatusResult))
        if (statusResult.ok) {
          resolvedModelStatus = ((statusResult.data || null) as Record<string, any> | null)
          setModelStatus(resolvedModelStatus)
        } else {
          resolvedModelStatus = null
          setModelStatus(null)
          nextErrors.push(statusResult.message || statusResult.stderr || '模型状态刷新失败，正在显示配置快照')
        }
      } else {
        resolvedModelStatus = modelStatusRef.current
      }

      let resolvedVerificationRecords = verificationRecordsRef.current
      try {
        const verificationSnapshot = await window.api.syncModelVerificationState({
          statusData: resolvedModelStatus,
        })
        resolvedVerificationRecords = Array.isArray(verificationSnapshot?.records)
          ? verificationSnapshot.records
          : []
        verificationRecordsRef.current = resolvedVerificationRecords
        setVerificationRecords(resolvedVerificationRecords)
      } catch {
        resolvedVerificationRecords = verificationRecordsRef.current
      }

      try {
        const cliCatalogResult = (await loadCliRefresh()).catalog
        const nextCatalog = selectPreferredRendererCatalogItems({
          cliLoaded: Boolean(cliCatalogResult),
          cliItems: cliCatalogResult?.items || [],
          upstreamItems: normalizedUpstreamCatalog,
        })
        latestCatalogRef.current = nextCatalog
        setCatalog(nextCatalog)
        modelsPageCache.set({
          envVars: env,
          config: cfg,
          modelStatus: resolvedModelStatus,
          catalog: nextCatalog,
          verificationRecords: resolvedVerificationRecords,
        })
      } catch {
        if (normalizedUpstreamCatalog.length > 0) {
          nextErrors.push('模型目录刷新失败，已回退到上游目录快照')
          latestCatalogRef.current = normalizedUpstreamCatalog
          setCatalog(normalizedUpstreamCatalog)
          modelsPageCache.set({
            envVars: env,
            config: cfg,
            modelStatus: resolvedModelStatus,
            catalog: normalizedUpstreamCatalog,
            verificationRecords: resolvedVerificationRecords,
          })
        } else {
          nextErrors.push('模型目录刷新失败，已保留当前显示的数据')
          modelsPageCache.set({
            envVars: env,
            config: cfg,
            modelStatus: resolvedModelStatus,
            catalog: latestCatalogRef.current,
            verificationRecords: resolvedVerificationRecords,
          })
        }
      }
      setError(nextErrors.join('；'))
    } catch (e) {
      setError('读取配置失败: ' + (e as Error).message)
    } finally {
      if (!background) {
        setLoading(false)
      }
    }
  }, [])

  useEffect(() => {
    void loadData({ background: Boolean(initialSnapshot) })
  }, [loadData, initialSnapshot])

  const activeModelHint = resolveModelsPageActiveModel(modelStatus, config)
  const {
    effectiveCatalog,
    visibleCatalog,
    scopedCatalog: configuredCatalog,
    configuredProviders,
  } = resolveModelsPageCatalogState({
    catalog,
    envVars,
    config,
    statusData: modelStatus,
    verificationRecords,
    preferredModelKey: activeModelHint,
    mode: catalogMode,
  })
  const catalogSummary = buildModelCatalogDisplaySummary(configuredCatalog, catalogMode)
  const activeModel = resolveVisibleConfiguredActiveModel({
    statusData: modelStatus,
    configData: config,
    configuredProviders,
    visibleCatalog,
    fullCatalog: effectiveCatalog,
  })
  const hasConfigured = configuredProviders.length > 0

  const handleSwitchModel = async (modelKey: string) => {
    setSwitching(modelKey)
    setError('')
    try {
      const result = await applyDefaultModelWithGatewayReload({
        model: modelKey,
        readConfig: () => window.api.readConfig(),
        readUpstreamState: () => window.api.getModelUpstreamState(),
        applyUpstreamModelWrite: (request) => window.api.applyModelConfigViaUpstream(request),
        applyConfigPatchGuarded: (request) => window.api.applyConfigPatchGuarded(request),
        getModelStatus: () => window.api.getModelStatus(),
        reloadGatewayAfterModelChange: () => window.api.reloadGatewayAfterModelChange(),
      })
      const verificationState = resolveRecordedModelVerificationStateFromSwitchResult(result)
      if (verificationState) {
        const snapshot = await window.api.recordModelVerification({
          modelKey,
          verificationState,
        }).catch(() => null)
        if (snapshot && Array.isArray(snapshot.records)) {
          verificationRecordsRef.current = snapshot.records
          setVerificationRecords(snapshot.records)
        }
      }
      if (!result.ok) {
        setError(result.message || '默认模型切换失败')
      }
      await loadData({ background: true, forceRefresh: true })
    } catch (error: any) {
      setError(error?.message || '默认模型切换失败')
    } finally {
      setSwitching('')
    }
  }

  const handleConfigured = (context?: SetupModelContext) => {
    if (context) {
      const optimisticState = applyOptimisticConfiguredProviderState({
        config,
        statusData: modelStatusRef.current,
        catalog: latestCatalogRef.current,
        context,
      })
      setConfig(optimisticState.nextConfig)
      setModelStatus(optimisticState.nextStatus)
      modelStatusRef.current = optimisticState.nextStatus
      latestCatalogRef.current = optimisticState.nextCatalog
      setCatalog(optimisticState.nextCatalog)
      modelsPageCache.set({
        envVars,
        config: optimisticState.nextConfig,
        modelStatus: optimisticState.nextStatus,
        catalog: optimisticState.nextCatalog,
        verificationRecords,
      })
    }
    setShowAddForm(false)
    void loadData({ background: true })
  }

  const handleManualRefresh = async () => {
    if (refreshing) return
    setRefreshing(true)
    try {
      await loadData({ background: true, forceRefresh: true })
    } finally {
      setRefreshing(false)
    }
  }

  const verifyProviderRemoval = useCallback(
    async (
      provider: { id: string; name: string },
      authStorePathHint?: string
    ): Promise<ProviderRemovalVerification> => verifyProviderRemovalState(
      {
        provider,
        currentStatusSnapshot: modelStatusRef.current,
        authStorePathHint,
      },
      {
        readEnvFile: () => window.api.readEnvFile(),
        readConfig: () => window.api.readConfig(),
        readUpstreamState: () => readOpenClawUpstreamModelState(),
        inspectAuthStore: (input) => window.api.inspectModelAuthProfiles(input),
      }
    ),
    []
  )

  const repairResidualProviderAuthStore = useCallback(async (provider: { id: string }, authStorePath: string) => {
    const providerIdList = getRemovalProviderIds(provider.id)
    return window.api.clearModelAuthProfiles({
      providerIds: providerIdList,
      authStorePath,
    })
  }, [])

  const cleanupExternalProviderAuthSource = useCallback(
    async (
      provider: { id: string; name: string },
      authStorePath: string
    ): Promise<{ attempted: boolean; verification?: ProviderRemovalVerification; message?: string }> => {
      if (!providerSupportsExternalAuthCleanup(provider.id)) {
        return { attempted: false }
      }

      const providerDisplayName = String(provider?.name || provider?.id || '').trim() || '该服务商'
      const confirmed = window.confirm(
        `服务商「${providerDisplayName}」仍会从外部 Codex 登录自动恢复。\n\n要彻底删除，Qclaw 需要同时退出这台 Mac 上的 Codex 登录，并再次清理 OpenClaw 认证档案。\n\n是否继续？`
      )
      if (!confirmed) {
        return {
          attempted: true,
          message: `服务商「${providerDisplayName}」的本地配置已删除，但外部 Codex 登录仍在，OpenClaw 会继续恢复该认证。`,
        }
      }

      setCleanupNotice({
        tone: 'info',
        message: `清理中：正在退出 Codex 登录并移除服务商「${providerDisplayName}」的外部认证来源...`,
      })

      const providerIdList = getRemovalProviderIds(provider.id)
      const externalCleanupResult = await window.api.clearExternalProviderAuth({
        providerIds: providerIdList,
      })
      if (!externalCleanupResult.ok) {
        return {
          attempted: true,
          message: `服务商「${providerDisplayName}」的外部 Codex 登录退出失败：${externalCleanupResult.error || '请稍后重试'}`,
        }
      }

      const repairResult = await repairResidualProviderAuthStore(provider, authStorePath)
      if (!repairResult.ok) {
        return {
          attempted: true,
          message: `服务商「${providerDisplayName}」的外部认证来源已退出，但认证档案补清失败：${repairResult.error || '请稍后重试'}`,
        }
      }

      try {
        await window.api.reloadGatewayAfterModelChange()
      } catch {
        // Keep going; verification below will report the final state.
      }

      await loadData({ background: true, forceRefresh: true, allowCliStatusFallback: false })
      return {
        attempted: true,
        verification: await verifyProviderRemoval(provider, repairResult.authStorePath || authStorePath),
      }
    },
    [loadData, repairResidualProviderAuthStore, verifyProviderRemoval]
  )

  const handleRemoveProvider = async (provider: { id: string; name: string }) => {
    if (removingProviderId) return

    const providerDisplayName = String(provider?.name || provider?.id || '').trim() || '该服务商'
    const confirmed = window.confirm(`确定删除服务商「${providerDisplayName}」吗？`)
    if (!confirmed) return

    setRemovingProviderId(provider.id)
    setError('')
    setCleanupNotice({
      tone: 'info',
      message: `清理中：正在删除服务商「${providerDisplayName}」...`,
    })
    try {
      const latestConfigRaw = await window.api.readConfig()
      const latestConfig = latestConfigRaw && typeof latestConfigRaw === 'object'
        ? (latestConfigRaw as Record<string, any>)
        : null
      const { nextConfig, removed } = removeProviderFromConfig(latestConfig, provider.id)
      let configChanged = false
      if (removed) {
        const writeResult = await window.api.applyConfigPatchGuarded({
          beforeConfig: latestConfig,
          afterConfig: nextConfig,
          reason: 'dashboard-remove-linked-model',
        })
        if (!writeResult.ok) {
          throw new Error(writeResult.message || '删除服务商配置失败')
        }
        configChanged = Boolean(writeResult.wrote)
      }

      const providerIdList = getRemovalProviderIds(provider.id)
      const optimisticStatusAfterRemoval = removeProviderFromStatus(modelStatusRef.current, provider.id).nextStatus
      const envUpdates: Record<string, string> = {}
      for (const envKey of resolveProviderRemovalEnvKeys({
        providerId: provider.id,
        candidateEnvKeys: collectProviderBoundEnvKeysFromStatus({
          providerId: provider.id,
          modelStatus: modelStatusRef.current,
        }),
        config: nextConfig,
        modelStatus: optimisticStatusAfterRemoval,
      })) {
        envUpdates[envKey] = ''
      }

      const [clearProfilesResult, envWriteResult] = await Promise.all([
        window.api.clearModelAuthProfiles({
          providerIds: providerIdList,
          authStorePath: resolveModelStatusAuthStorePath(modelStatus),
        }),
        Object.keys(envUpdates).length > 0
          ? window.api.writeEnvFileGuarded({
              updates: envUpdates,
              reason: 'dashboard-remove-linked-model',
            })
          : Promise.resolve(null),
      ])

      let authProfilesChanged = false
      let authProfilesWarning = ''
      if (clearProfilesResult.ok) {
        authProfilesChanged = authProfileCleanupChanged(clearProfilesResult)
      } else {
        authProfilesWarning = clearProfilesResult.error || '清理认证配置失败'
      }
      const deletionAuthStorePath =
        clearProfilesResult.authStorePath ||
        resolveModelStatusAuthStorePath(modelStatusRef.current)

      const authOrderProviderIds = Array.from(
        new Set(
          providerIdList
            .map((item) => canonicalizeModelProviderId(item))
            .filter(Boolean)
        )
      )
      let envChanged = false
      let envWarning = ''
      if (envWriteResult) {
        if (envWriteResult.ok) {
          envChanged = Boolean(envWriteResult.wrote)
        } else {
          envWarning = envWriteResult.message || '清理服务商密钥失败'
        }
      }

      if (!configChanged && !authProfilesChanged && !envChanged) {
        let fallbackAuthOrderChanged = false
        let fallbackAuthOrderWarning = ''
        for (const authProviderId of authOrderProviderIds) {
          try {
            const clearOrderResult = await window.api.runModelAuth({
              kind: 'auth-order-clear',
              providerId: authProviderId,
            })
            if (clearOrderResult.ok) {
              fallbackAuthOrderChanged = true
              continue
            }
            if (clearOrderResult.errorCode === 'unsupported_capability') {
              continue
            }
            if (!fallbackAuthOrderWarning) {
              fallbackAuthOrderWarning = clearOrderResult.message || clearOrderResult.stderr || '清理认证顺序失败'
            }
          } catch (error: any) {
            if (!fallbackAuthOrderWarning) {
              fallbackAuthOrderWarning = error?.message || '清理认证顺序失败'
            }
          }
        }
        if (fallbackAuthOrderChanged) {
          setCleanupNotice({
            tone: 'info',
            message: `清理中：服务商「${providerDisplayName}」已删除，正在完成后台清理...`,
          })
          void (async () => {
            const deferredIssues: string[] = []
            try {
              const reloadResult = await window.api.reloadGatewayAfterModelChange()
              if (!reloadResult?.ok) {
                deferredIssues.push(
                  `服务商已删除，但 Gateway 重载失败：${reloadResult?.stderr || reloadResult?.stdout || '请稍后手动重载'}`
                )
              }
            } catch (error: any) {
              deferredIssues.push(`服务商已删除，但 Gateway 重载失败：${error?.message || '请稍后手动重载'}`)
            }

            try {
              await loadData({ background: true, forceRefresh: true, allowCliStatusFallback: false })
            } finally {
              let verification = await verifyProviderRemoval(provider, deletionAuthStorePath)
              const firstResidualAuthStorePath = verification.authStorePath
              if (!verification.ok && firstResidualAuthStorePath) {
                const repairResult = await repairResidualProviderAuthStore(provider, firstResidualAuthStorePath)
                if (!repairResult.ok) {
                  deferredIssues.push(
                    `服务商配置已删除，但认证档案补清失败：${repairResult.error || '请稍后重试'}`
                  )
                } else if (authProfileCleanupChanged(repairResult)) {
                  await loadData({ background: true, forceRefresh: true, allowCliStatusFallback: false })
                  verification = await verifyProviderRemoval(provider, repairResult.authStorePath || deletionAuthStorePath)
                }
              }
              if (!verification.ok && verification.authStorePath) {
                const externalCleanup = await cleanupExternalProviderAuthSource(provider, verification.authStorePath)
                if (externalCleanup.verification) {
                  verification = externalCleanup.verification
                }
                if (externalCleanup.message) {
                  deferredIssues.push(externalCleanup.message)
                }
              }
              if (!verification.ok && verification.message) {
                deferredIssues.push(verification.message)
              }
              if (deferredIssues.length > 0) {
                setError((prev) => {
                  const existing = String(prev || '').trim()
                  const merged = [...new Set([existing, ...deferredIssues].filter(Boolean))]
                  return merged.join('；')
                })
              }
              if (verification.ok) {
                setCleanupNotice({
                  tone: 'success',
                  message: `清理完成：服务商「${providerDisplayName}」删除与收尾已完成。`,
                })
              } else {
                setCleanupNotice(null)
              }
            }
          })()
          return
        }
        if (envWarning) {
          throw new Error(envWarning)
        }
        if (authProfilesWarning) {
          throw new Error(authProfilesWarning)
        }
        if (fallbackAuthOrderWarning) {
          throw new Error(fallbackAuthOrderWarning)
        }
        throw new Error('未检测到可删除的服务商配置')
      }
      const nonBlockingIssues: string[] = []
      if (authProfilesWarning) {
        nonBlockingIssues.push(`服务商配置已删除，但认证配置清理失败：${authProfilesWarning}`)
      }
      if (envWarning) {
        nonBlockingIssues.push(`服务商配置已删除，但密钥清理失败：${envWarning}`)
      }

      if (configChanged) {
        setConfig(nextConfig)
      }
      if (Object.keys(envUpdates).length > 0) {
        setEnvVars((prev) => {
          const base = prev && typeof prev === 'object' ? { ...prev } : {}
          for (const key of Object.keys(envUpdates)) {
            base[key] = ''
          }
          return base
        })
      }
      setModelStatus((prev) => {
        const { nextStatus } = removeProviderFromStatus(
          prev && typeof prev === 'object' ? (prev as Record<string, any>) : null,
          provider.id
        )
        return nextStatus
      })

      if (nonBlockingIssues.length > 0) {
        setError(nonBlockingIssues.join('；'))
      }
      setCleanupNotice({
        tone: 'info',
        message: `清理中：服务商「${providerDisplayName}」已删除，正在完成后台清理...`,
      })

      void (async () => {
        try {
          const deferredIssues: string[] = []

          for (const authProviderId of authOrderProviderIds) {
            try {
              const clearOrderResult = await window.api.runModelAuth({
                kind: 'auth-order-clear',
                providerId: authProviderId,
              })
              if (!clearOrderResult.ok && clearOrderResult.errorCode !== 'unsupported_capability') {
                if (deferredIssues.length === 0) {
                  deferredIssues.push(
                    `服务商配置已删除，但认证顺序清理失败：${
                      clearOrderResult.message || clearOrderResult.stderr || '请稍后重试'
                    }`
                  )
                }
              }
            } catch (error: any) {
              if (deferredIssues.length === 0) {
                deferredIssues.push(`服务商配置已删除，但认证顺序清理失败：${error?.message || '请稍后重试'}`)
              }
            }
          }

          try {
            const reloadResult = await window.api.reloadGatewayAfterModelChange()
            if (!reloadResult?.ok) {
              deferredIssues.push(
                `服务商已删除，但 Gateway 重载失败：${reloadResult?.stderr || reloadResult?.stdout || '请稍后手动重载'}`
              )
            }
          } catch (error: any) {
            deferredIssues.push(`服务商已删除，但 Gateway 重载失败：${error?.message || '请稍后手动重载'}`)
          }

          await loadData({ background: true, forceRefresh: true, allowCliStatusFallback: false })
          let verification = await verifyProviderRemoval(provider, deletionAuthStorePath)
          const residualAuthStorePath = verification.authStorePath
          if (!verification.ok && residualAuthStorePath) {
            const repairResult = await repairResidualProviderAuthStore(provider, residualAuthStorePath)
            if (!repairResult.ok) {
              deferredIssues.push(`服务商配置已删除，但认证档案补清失败：${repairResult.error || '请稍后重试'}`)
            } else if (authProfileCleanupChanged(repairResult)) {
              await loadData({ background: true, forceRefresh: true, allowCliStatusFallback: false })
              verification = await verifyProviderRemoval(provider, repairResult.authStorePath || deletionAuthStorePath)
            }
          }
          if (!verification.ok && verification.authStorePath) {
            const externalCleanup = await cleanupExternalProviderAuthSource(provider, verification.authStorePath)
            if (externalCleanup.verification) {
              verification = externalCleanup.verification
            }
            if (externalCleanup.message) {
              deferredIssues.push(externalCleanup.message)
            }
          }
          if (!verification.ok && verification.message) {
            deferredIssues.push(verification.message)
          }
          if (deferredIssues.length > 0) {
            setError((prev) => {
              const existing = String(prev || '').trim()
              const merged = [...new Set([existing, ...deferredIssues].filter(Boolean))]
              return merged.join('；')
            })
          }
          if (verification.ok) {
            setError((prev) => removeResolvedErrorMessages(prev, nonBlockingIssues))
            setCleanupNotice({
              tone: 'success',
              message: `清理完成：服务商「${providerDisplayName}」删除与收尾已完成。`,
            })
          } else {
            setCleanupNotice(null)
          }
        } catch {
          // 后台补偿流程失败时不打断页面主交互
        }
      })()
    } catch (e: any) {
      setError(e?.message || '删除服务商失败')
      setCleanupNotice(null)
    } finally {
      setRemovingProviderId('')
    }
  }

  const toggleProviderExpand = useCallback((providerId: string) => {
    setExpandedProviders((prev) => {
      const next = new Set(prev)
      if (next.has(providerId)) next.delete(providerId)
      else next.add(providerId)
      return next
    })
  }, [])

  const getProviderModels = (providerId: string) =>
    getModelsPageProviderModels(providerId, visibleCatalog)

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader size="md" />
      </div>
    )
  }

  return (
    <div className="p-4 h-full overflow-y-auto space-y-2">
      {/* 页头 */}
      <div className="px-1 mb-1 space-y-2">
        <Group justify="space-between" align="flex-start">
          <Text size="md" fw={700} className="app-text-primary">模型与 API</Text>
          <Group gap="xs">
            <SegmentedControl
              size="xs"
              value={catalogMode}
              onChange={(value) => setCatalogMode(value as ModelCatalogDisplayMode)}
              data={[
                { label: '可用', value: 'available' },
                { label: '全量', value: 'all' },
              ]}
            />
            <Tooltip label={refreshing ? '刷新中...' : '刷新'} withArrow>
              <ActionIcon
                variant="subtle"
                size="sm"
                loading={refreshing}
                disabled={refreshing}
                onClick={() => {
                  void handleManualRefresh()
                }}
                className="cursor-pointer"
              >
                <IconRefresh size={14} />
              </ActionIcon>
            </Tooltip>
          </Group>
        </Group>
        <Text size="xs" c="dimmed">
          {catalogSummary.label} · {catalogSummary.detail}
        </Text>
      </div>

      {error && (
        <Alert color="red" withCloseButton onClose={() => setError('')}>
          {error}
        </Alert>
      )}
      {cleanupNotice && (
        <Alert
          color={cleanupNotice.tone === 'success' ? 'green' : 'blue'}
          withCloseButton
          onClose={() => setCleanupNotice(null)}
        >
          {cleanupNotice.message}
        </Alert>
      )}

      {/* 当前激活模型 */}
      {activeModel && (
        <div className="border app-border rounded-lg px-3 py-2.5 app-bg-secondary" style={{ borderLeft: '3px solid var(--mantine-color-blue-6)' }}>
          <Group justify="space-between">
            <Group gap="xs">
              <Text size="xs" c="dimmed">当前模型</Text>
              <Text size="sm" fw={600} className="app-text-primary">{activeModel}</Text>
            </Group>
            <Badge size="xs" color="blue" variant="dot">已激活</Badge>
          </Group>
        </div>
      )}

      {/* 已配置供应商 */}
      {hasConfigured && (
        <div className="space-y-2">
          {configuredProviders.map((provider) => {
            const models = getProviderModels(provider.id)
            const providerCatalog = getModelsPageProviderModels(provider.id, effectiveCatalog)
            const providerRuntimeState = resolveConfiguredProviderRuntimeState({
              providerId: provider.id,
              statusData: modelStatus,
              catalog: providerCatalog,
            })
            const providerAvailableCount = providerCatalog.filter((item) => isCatalogModelAvailable(item)).length
            const providerTotalCount = providerCatalog.length
            const isExpanded = expandedProviders.has(provider.id)
            const providerCountLabel = catalogMode === 'available'
              ? (providerAvailableCount > 0 ? String(providerAvailableCount) : '')
              : (providerTotalCount > 0 ? `${providerAvailableCount}/${providerTotalCount}` : '')

            return (
              <div key={provider.id} className="border app-border rounded-lg overflow-hidden">
                {/* Provider header — collapsible */}
                <Group
                  justify="space-between"
                  className="px-3 py-2.5 cursor-pointer select-none"
                  onClick={() => toggleProviderExpand(provider.id)}
                >
                  <Group gap="sm">
                    <IconChevronRight
                      size={14}
                      style={{
                        transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                        transition: 'transform 0.2s',
                      }}
                      className="app-text-muted"
                    />
                    <Text size="lg" style={{ lineHeight: 1 }}>{provider.logo}</Text>
                    <div>
                      <Text size="sm" fw={600} className="app-text-primary" style={{ lineHeight: 1.3 }}>
                        {provider.name}
                      </Text>
                      {provider.description && (
                        <Text size="xs" c="dimmed" style={{ lineHeight: 1.3 }}>
                          {provider.description}
                        </Text>
                      )}
                    </div>
                  </Group>
                  <Group gap={6}>
                    <Badge variant="light" color={providerRuntimeState.color} size="xs">
                      {providerRuntimeState.label}
                    </Badge>
                    {providerCountLabel && (
                      <Badge variant="outline" color="gray" size="xs">
                        {providerCountLabel}
                      </Badge>
                    )}
                    <Tooltip label="删除服务商" withArrow>
                      <ActionIcon
                        variant="subtle"
                        color="red"
                        size="sm"
                        loading={removingProviderId === provider.id}
                        disabled={Boolean(removingProviderId && removingProviderId !== provider.id)}
                        onClick={(e) => {
                          e.stopPropagation()
                          void handleRemoveProvider(provider)
                        }}
                        className="cursor-pointer"
                      >
                        <IconTrash size={14} />
                      </ActionIcon>
                    </Tooltip>
                  </Group>
                </Group>

                {/* Expanded model list */}
                <Collapse in={isExpanded}>
                  <div className="px-3 pb-3">
                    {models.length > 0 ? (
                      <div className="flex flex-col gap-0.5">
                        {models.map((model) => {
                          const isActive = activeModel === model.key
                          const isSwitching = switching === model.key
                          const verificationState = resolveModelsPageCatalogItemVerificationState(model)
                          const verificationBadge = getVerificationBadgeDisplay(verificationState)
                          const isVerifiedUnavailable = verificationState === 'verified-unavailable'
                          const canSwitchModel = canSwitchModelsPageCatalogItem(model)
                          return (
                            <Group
                              key={model.key}
                              justify="space-between"
                              py={3}
                              px="xs"
                              className="rounded"
                              style={isActive ? {
                                background: 'var(--mantine-color-blue-light)',
                              } : undefined}
                            >
                              <Group gap="xs">
                                <div
                                  style={{
                                    width: 6,
                                    height: 6,
                                    borderRadius: '50%',
                                    background: isActive
                                      ? 'var(--mantine-color-blue-6)'
                                      : 'var(--mantine-color-gray-4)',
                                    flexShrink: 0,
                                  }}
                                />
                                <Text
                                  size="xs"
                                  fw={isActive ? 600 : 400}
                                  c={isActive ? 'blue' : isVerifiedUnavailable ? 'dimmed' : undefined}
                                  className={isActive ? '' : 'app-text-secondary'}
                                >
                                  {model.name || model.key}
                                </Text>
                              </Group>
                              <Group gap={4}>
                                {isActive && (
                                  <Badge size="xs" color="blue" variant="light">当前</Badge>
                                )}
                                <Badge size="xs" color={verificationBadge.color} variant={verificationBadge.variant}>
                                  {verificationBadge.label}
                                </Badge>
                                {!isActive && canSwitchModel && (
                                  <Button
                                    size="compact-xs"
                                    variant="subtle"
                                    loading={isSwitching}
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      handleSwitchModel(model.key)
                                    }}
                                    className="cursor-pointer"
                                  >
                                    切换
                                  </Button>
                                )}
                              </Group>
                            </Group>
                          )
                        })}
                      </div>
                    ) : (
                      <Text size="xs" c="dimmed" px="xs">
                        {catalogSummary.providerEmptyText}
                      </Text>
                    )}
                  </div>
                </Collapse>
              </div>
            )
          })}

          {/* 添加供应商 */}
          {!showAddForm && (
            <Button
              variant="default"
              size="xs"
              fullWidth
              leftSection={<IconPlus size={14} />}
              onClick={() => setShowAddForm(true)}
              className="cursor-pointer"
              styles={{ root: { borderStyle: 'dashed' } }}
            >
              添加供应商
            </Button>
          )}
        </div>
      )}

      {/* ModelCenter wizard — show when adding */}
      {showAddForm && (
        <div className="border app-border rounded-lg overflow-hidden p-3">
          <Group justify="space-between" mb="sm">
            <Text size="sm" fw={600} className="app-text-primary">添加新供应商</Text>
            <Button
              size="compact-xs"
              variant="subtle"
              color="gray"
              onClick={() => setShowAddForm(false)}
              className="cursor-pointer"
            >
              取消
            </Button>
          </Group>
          <ModelCenter
            onConfigured={handleConfigured}
            stayOnConfigured={true}
            configuredMessage="供应商配置成功"
            collapsible={false}
            submitIdleLabel="验证并保存"
          />
        </div>
      )}

      {/* Empty state: no providers configured */}
      {!hasConfigured && !showAddForm && (
        <div className="border app-border rounded-lg p-6 text-center">
          <Text size="sm" c="dimmed" mb="md">
            暂无已配置的 AI 供应商
          </Text>
          <Button
            variant="light"
            size="xs"
            leftSection={<IconPlus size={14} />}
            onClick={() => setShowAddForm(true)}
            className="cursor-pointer"
          >
            添加供应商
          </Button>
        </div>
      )}
    </div>
  )
}

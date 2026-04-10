import {
  inspectControlUiAppViaBrowser,
  type ControlUiAppInspectionResult,
} from './openclaw-control-ui-rpc'
import { readConfig, readEnvFile } from './cli'

export interface OpenClawUpstreamModelStatePayload {
  source: 'control-ui-app'
  connected: boolean
  hasClient: boolean
  appKeys: string[]
  // Compatibility passthroughs. Treat these projected snapshots as diagnostics only.
  /** @deprecated Diagnostics only. Prefer `debugSnapshots.helloSnapshot`. */
  helloSnapshot?: Record<string, unknown> | null
  /** @deprecated Diagnostics only. Prefer `debugSnapshots.healthResult`. */
  healthResult?: Record<string, unknown> | null
  /** @deprecated Diagnostics only. Prefer `debugSnapshots.sessionsState`. */
  sessionsState?: Record<string, unknown> | null
  /** @deprecated Diagnostics only. Prefer `debugSnapshots.modelCatalogState`. */
  modelCatalogState?: Record<string, unknown> | null
  modelStatusLike?: Record<string, unknown> | null
  modelStatusSummaryLike?: {
    defaultModel?: string
    activeModel?: string
    allowedCount?: number
    fallbackCount?: number
    providerAuth: Array<{
      provider: string
      status?: string
    }>
  }
  catalogItemsLike?: Array<{
    key: string
    provider: string
    name?: string
    available?: boolean
  }>
  catalogSummaryLike?: {
    totalItems: number
    availableItems: number
    providerKeys: string[]
  }
  sessionInventoryLike?: {
    totalSessions?: number
    continuableSessions?: number
    patchableSessions?: number
    observedKinds: string[]
    observedChannels: string[]
  }
  debugSnapshots?: {
    helloSnapshot?: Record<string, unknown> | null
    healthResult?: Record<string, unknown> | null
    sessionsState?: Record<string, unknown> | null
    modelCatalogState?: Record<string, unknown> | null
    sessionsResult?: Record<string, unknown> | null
    rpcStatus?: Record<string, unknown> | null
    rpcModels?: Record<string, unknown> | null
    chatModelCatalog?: Array<Record<string, unknown>> | null
    rpcErrors?: string[]
  }
}

export interface OpenClawUpstreamModelStateResult {
  ok: boolean
  source: 'control-ui-app'
  data?: OpenClawUpstreamModelStatePayload
  fallbackUsed: boolean
  fallbackReason?: string
  diagnostics: {
    upstreamAvailable: boolean
    connected: boolean
    hasClient: boolean
    hasHelloSnapshot: boolean
    hasHealthResult: boolean
    hasSessionsState: boolean
    hasModelCatalogState: boolean
    appKeys: string[]
    lastError?: string
  }
}

export interface OpenClawUpstreamModelStateOptions {
  timeoutMs?: number
  loadTimeoutMs?: number
}

function normalizeRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function normalizeString(value: unknown): string | undefined {
  const normalized = String(value || '').trim()
  return normalized || undefined
}

function normalizeRecordArray(value: unknown): Array<Record<string, unknown>> | null {
  if (!Array.isArray(value)) return null
  return value
    .map((entry) => normalizeRecord(entry))
    .filter(Boolean) as Array<Record<string, unknown>>
}

function normalizeCatalogItem(
  value: unknown
): {
  key: string
  provider: string
  name?: string
  available?: boolean
} | null {
  const record = normalizeRecord(value)
  if (!record) return null
  const key = String(record.key || '').trim()
  const provider = String(record.provider || '').trim()
  if (!key || !provider) return null

  const item: {
    key: string
    provider: string
    name?: string
    available?: boolean
  } = {
    key,
    provider,
  }
  const name = String(record.name || '').trim()
  if (name) item.name = name
  if (typeof record.available === 'boolean') {
    item.available = record.available
  }
  return item
}

function normalizeSessionItem(
  value: unknown
): {
  kind?: string
  channel?: string
  canContinue?: boolean
  canPatchModel?: boolean
} | null {
  const record = normalizeRecord(value)
  if (!record) return null

  const sessionLikeKeys = ['key', 'sessionKey', 'sessionId', 'id']
  const hasSessionIdentity = sessionLikeKeys.some((key) => normalizeString(record[key]))
  const kind = normalizeString(record.kind) || normalizeString(record.type) || normalizeString(record.source)
  const channel =
    normalizeString(record.channel) ||
    normalizeString(record.lastChannel) ||
    normalizeString(record.channelId) ||
    normalizeString(record.connector) ||
    normalizeString(record.provider)
  const canContinue =
    typeof record.canContinue === 'boolean'
      ? record.canContinue
      : typeof record.writable === 'boolean'
        ? record.writable
        : typeof record.reusable === 'boolean'
          ? record.reusable
          : undefined
  const canPatchModel =
    typeof record.canPatchModel === 'boolean'
      ? record.canPatchModel
      : typeof record.patchable === 'boolean'
        ? record.patchable
        : undefined

  if (!hasSessionIdentity && !kind && canContinue === undefined && canPatchModel === undefined) {
    return null
  }

  return {
    kind,
    channel,
    canContinue,
    canPatchModel,
  }
}

function looksLikeModelStatusRecord(value: unknown): value is Record<string, unknown> {
  const record = normalizeRecord(value)
  if (!record) return false
  if (Array.isArray(record.allowed)) return true
  if (Array.isArray(record.fallbacks)) return true
  if (typeof record.defaultModel === 'string' && record.defaultModel.includes('/')) return true
  if (typeof record.model === 'string' && record.model.includes('/')) return true
  if (normalizeRecord(record.auth)) return true
  if (normalizeRecord(record.agents)) return true
  return false
}

function findNestedModelStatusRecord(
  value: unknown,
  depth = 0,
  seen: Set<unknown> = new Set()
): Record<string, unknown> | null {
  if (depth > 5 || !value || typeof value !== 'object') return null
  if (seen.has(value)) return null
  seen.add(value)

  if (looksLikeModelStatusRecord(value)) {
    return value as Record<string, unknown>
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findNestedModelStatusRecord(entry, depth + 1, seen)
      if (found) return found
    }
    return null
  }

  for (const nested of Object.values(value as Record<string, unknown>)) {
    const found = findNestedModelStatusRecord(nested, depth + 1, seen)
    if (found) return found
  }
  return null
}

function looksLikeCatalogArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value) || value.length === 0) return false
  const sample = value.slice(0, Math.min(5, value.length))
  const validCount = sample.filter((item) => normalizeCatalogItem(item)).length
  return validCount >= Math.max(1, Math.ceil(sample.length / 2))
}

function findNestedCatalogItems(
  value: unknown,
  depth = 0,
  seen: Set<unknown> = new Set()
): Array<{ key: string; provider: string; name?: string; available?: boolean }> | null {
  if (depth > 5 || !value || typeof value !== 'object') return null
  if (seen.has(value)) return null
  seen.add(value)

  if (looksLikeCatalogArray(value)) {
    const items = value
      .map((entry) => normalizeCatalogItem(entry))
      .filter(Boolean) as Array<{ key: string; provider: string; name?: string; available?: boolean }>
    if (items.length > 0) return items
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findNestedCatalogItems(entry, depth + 1, seen)
      if (found?.length) return found
    }
    return null
  }

  const record = value as Record<string, unknown>
  for (const key of ['items', 'models', 'entries', 'catalog']) {
    if (key in record) {
      const direct = findNestedCatalogItems(record[key], depth + 1, seen)
      if (direct?.length) return direct
    }
  }

  for (const nested of Object.values(record)) {
    const found = findNestedCatalogItems(nested, depth + 1, seen)
    if (found?.length) return found
  }
  return null
}

function normalizeRpcCatalogItem(
  value: unknown
): {
  key: string
  provider: string
  name?: string
  available?: boolean
} | null {
  const record = normalizeRecord(value)
  if (!record) return null

  const explicitProvider = normalizeString(record.provider) || normalizeString(record.modelProvider)
  const explicitKey = normalizeString(record.key)
  const explicitId = normalizeString(record.id)
  const providerFromKey = explicitKey?.includes('/') ? normalizeString(explicitKey.split('/')[0]) : undefined
  const provider = explicitProvider || providerFromKey
  const key = explicitKey || (provider && explicitId ? `${provider}/${explicitId}` : undefined)
  if (!key || !provider) return null

  const item: {
    key: string
    provider: string
    name?: string
    available?: boolean
  } = {
    key,
    provider,
  }
  const name = normalizeString(record.name) || normalizeString(record.label)
  if (name) item.name = name
  if (typeof record.available === 'boolean') {
    item.available = record.available
  } else {
    item.available = true
  }
  return item
}

function extractRpcCatalogItems(
  value: unknown
): Array<{ key: string; provider: string; name?: string; available?: boolean }> | null {
  const record = normalizeRecord(value)
  const source = Array.isArray(value)
    ? value
    : Array.isArray(record?.models)
      ? record.models
      : Array.isArray(record?.items)
        ? record.items
        : null
  if (!source) return null

  return source
    .map((entry) => normalizeRpcCatalogItem(entry))
    .filter(Boolean) as Array<{ key: string; provider: string; name?: string; available?: boolean }>
}

function looksLikeSessionArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value) || value.length === 0) return false
  const sample = value.slice(0, Math.min(5, value.length))
  const validCount = sample.filter((item) => normalizeSessionItem(item)).length
  return validCount >= Math.max(1, Math.ceil(sample.length / 2))
}

function findNestedSessionItems(
  value: unknown,
  depth = 0,
  seen: Set<unknown> = new Set()
): Array<{
  kind?: string
  channel?: string
  canContinue?: boolean
  canPatchModel?: boolean
}> | null {
  if (depth > 5 || !value || typeof value !== 'object') return null
  if (seen.has(value)) return null
  seen.add(value)

  if (looksLikeSessionArray(value)) {
    const items = value
      .map((entry) => normalizeSessionItem(entry))
      .filter(Boolean) as Array<{
      kind?: string
      channel?: string
      canContinue?: boolean
      canPatchModel?: boolean
    }>
    if (items.length > 0) return items
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findNestedSessionItems(entry, depth + 1, seen)
      if (found?.length) return found
    }
    return null
  }

  const record = value as Record<string, unknown>
  for (const key of ['items', 'sessions', 'entries', 'list']) {
    if (key in record) {
      const direct = findNestedSessionItems(record[key], depth + 1, seen)
      if (direct?.length) return direct
    }
  }

  for (const nested of Object.values(record)) {
    const found = findNestedSessionItems(nested, depth + 1, seen)
    if (found?.length) return found
  }
  return null
}

function collectProviderAuthStates(
  value: unknown,
  depth = 0,
  seen: Set<unknown> = new Set()
): Array<{ provider: string; status?: string }> {
  if (depth > 5 || !value || typeof value !== 'object') return []
  if (seen.has(value)) return []
  seen.add(value)

  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectProviderAuthStates(entry, depth + 1, seen))
  }

  const record = value as Record<string, unknown>
  const provider = normalizeString(record.provider)
  if (provider) {
    return [
      {
        provider,
        status: normalizeString(record.status),
      },
    ]
  }

  return Object.values(record).flatMap((nested) => collectProviderAuthStates(nested, depth + 1, seen))
}

function buildModelStatusSummaryLike(
  value: Record<string, unknown> | null
): OpenClawUpstreamModelStatePayload['modelStatusSummaryLike'] | undefined {
  if (!value) return undefined

  const summary: NonNullable<OpenClawUpstreamModelStatePayload['modelStatusSummaryLike']> = {
    providerAuth: [],
  }
  const defaultModel = normalizeString(value.defaultModel)
  const activeModel = normalizeString(value.model)
  if (defaultModel) summary.defaultModel = defaultModel
  if (activeModel) summary.activeModel = activeModel
  if (Array.isArray(value.allowed)) summary.allowedCount = value.allowed.length
  if (Array.isArray(value.fallbacks)) summary.fallbackCount = value.fallbacks.length

  const providerAuth = collectProviderAuthStates(value.auth)
  if (providerAuth.length > 0) {
    const deduped = new Map<string, { provider: string; status?: string }>()
    for (const item of providerAuth) {
      const dedupeKey = `${item.provider}:${item.status || ''}`
      if (!deduped.has(dedupeKey)) deduped.set(dedupeKey, item)
    }
    summary.providerAuth = Array.from(deduped.values()).sort((left, right) => {
      if (left.provider === right.provider) {
        return String(left.status || '').localeCompare(String(right.status || ''))
      }
      return left.provider.localeCompare(right.provider)
    })
  }

  if (
    !summary.defaultModel &&
    !summary.activeModel &&
    summary.allowedCount === undefined &&
    summary.fallbackCount === undefined &&
    summary.providerAuth.length === 0
  ) {
    return undefined
  }
  return summary
}

function buildQualifiedModelKey(provider: unknown, model: unknown): string | undefined {
  const providerId = normalizeString(provider)
  const modelId = normalizeString(model)
  if (!providerId || !modelId) return undefined
  return `${providerId}/${modelId}`
}

function buildModelStatusLikeFromRpcSignals(params: {
  catalogItems: Array<{ key: string; provider: string; name?: string; available?: boolean }> | null
  sessionsResult: Record<string, unknown> | null
  rpcStatus: Record<string, unknown> | null
}): Record<string, unknown> | null {
  const allowed = Array.from(new Set((params.catalogItems || []).map((item) => item.key).filter(Boolean)))
  const sessionsDefaults = normalizeRecord(params.sessionsResult?.defaults)
  const rpcStatusSessions = normalizeRecord(params.rpcStatus?.sessions)
  const rpcStatusDefaults = normalizeRecord(rpcStatusSessions?.defaults)
  const defaultModel =
    buildQualifiedModelKey(sessionsDefaults?.modelProvider, sessionsDefaults?.model) ||
    buildQualifiedModelKey(rpcStatusDefaults?.modelProvider, rpcStatusDefaults?.model)

  if (allowed.length === 0 && !defaultModel) {
    return null
  }

  const statusLike: Record<string, unknown> = {}
  if (allowed.length > 0) {
    statusLike.allowed = allowed
  }
  if (defaultModel) {
    statusLike.defaultModel = defaultModel
    statusLike.model = defaultModel
  }
  return statusLike
}

function buildCatalogSummaryLike(
  items: Array<{ key: string; provider: string; name?: string; available?: boolean }> | null,
  available = false
): OpenClawUpstreamModelStatePayload['catalogSummaryLike'] | undefined {
  if (!available && !items?.length) return undefined
  const normalizedItems = items || []
  const providerKeys = Array.from(new Set(normalizedItems.map((item) => item.provider).filter(Boolean))).sort()
  return {
    totalItems: normalizedItems.length,
    availableItems: normalizedItems.filter((item) => item.available === true).length,
    providerKeys,
  }
}

function findSessionCountCandidate(
  value: unknown,
  depth = 0,
  seen: Set<unknown> = new Set()
): number | undefined {
  if (depth > 5 || !value || typeof value !== 'object') return undefined
  if (seen.has(value)) return undefined
  seen.add(value)

  if (Array.isArray(value)) {
    for (const entry of value) {
      const nested = findSessionCountCandidate(entry, depth + 1, seen)
      if (nested !== undefined) return nested
    }
    return undefined
  }

  const record = value as Record<string, unknown>
  for (const key of ['count', 'total', 'size']) {
    const numericValue = Number(record[key])
    if (Number.isFinite(numericValue) && numericValue >= 0) {
      return Math.floor(numericValue)
    }
  }

  for (const nested of Object.values(record)) {
    const found = findSessionCountCandidate(nested, depth + 1, seen)
    if (found !== undefined) return found
  }
  return undefined
}

function buildSessionInventoryLike(
  sessionsState: Record<string, unknown> | null,
  helloSnapshot: Record<string, unknown> | null,
  healthResult: Record<string, unknown> | null,
  sessionsResult: Record<string, unknown> | null,
  rpcStatus: Record<string, unknown> | null
): OpenClawUpstreamModelStatePayload['sessionInventoryLike'] | undefined {
  const sessionItems =
    findNestedSessionItems(sessionsState) ||
    findNestedSessionItems(helloSnapshot) ||
    findNestedSessionItems(healthResult) ||
    findNestedSessionItems(sessionsResult) ||
    findNestedSessionItems(rpcStatus)
  const totalSessions =
    findSessionCountCandidate(sessionsState) ??
    findSessionCountCandidate(helloSnapshot) ??
    findSessionCountCandidate(healthResult) ??
    findSessionCountCandidate(sessionsResult) ??
    findSessionCountCandidate(rpcStatus) ??
    (sessionItems?.length ? sessionItems.length : undefined)

  if (!sessionItems?.length && totalSessions === undefined) return undefined

  return {
    totalSessions,
    continuableSessions: sessionItems?.filter((item) => item.canContinue === true).length || undefined,
    patchableSessions: sessionItems?.filter((item) => item.canPatchModel === true).length || undefined,
    observedKinds: Array.from(
      new Set((sessionItems || []).map((item) => item.kind).filter((value): value is string => Boolean(value)))
    ).sort(),
    observedChannels: Array.from(
      new Set((sessionItems || []).map((item) => item.channel).filter((value): value is string => Boolean(value)))
    ).sort(),
  }
}

function buildDebugSnapshots(params: {
  helloSnapshot: Record<string, unknown> | null
  healthResult: Record<string, unknown> | null
  sessionsState: Record<string, unknown> | null
  modelCatalogState: Record<string, unknown> | null
  sessionsResult?: Record<string, unknown> | null
  rpcStatus?: Record<string, unknown> | null
  rpcModels?: Record<string, unknown> | null
  chatModelCatalog?: Array<Record<string, unknown>> | null
  rpcErrors?: string[]
}): OpenClawUpstreamModelStatePayload['debugSnapshots'] | undefined {
  if (
    !params.helloSnapshot &&
    !params.healthResult &&
    !params.sessionsState &&
    !params.modelCatalogState &&
    params.sessionsResult === undefined &&
    params.rpcStatus === undefined &&
    params.rpcModels === undefined &&
    params.chatModelCatalog === undefined &&
    params.rpcErrors === undefined
  ) {
    return undefined
  }
  const snapshots: NonNullable<OpenClawUpstreamModelStatePayload['debugSnapshots']> = {
    helloSnapshot: params.helloSnapshot,
    healthResult: params.healthResult,
    sessionsState: params.sessionsState,
    modelCatalogState: params.modelCatalogState,
  }
  if (params.sessionsResult !== undefined) {
    snapshots.sessionsResult = params.sessionsResult
  }
  if (params.rpcStatus !== undefined) {
    snapshots.rpcStatus = params.rpcStatus
  }
  if (params.rpcModels !== undefined) {
    snapshots.rpcModels = params.rpcModels
  }
  if (params.chatModelCatalog !== undefined) {
    snapshots.chatModelCatalog = params.chatModelCatalog
  }
  if (params.rpcErrors !== undefined) {
    snapshots.rpcErrors = params.rpcErrors
  }
  return snapshots
}

function buildDiagnostics(result: ControlUiAppInspectionResult): OpenClawUpstreamModelStateResult['diagnostics'] {
  return {
    upstreamAvailable: Boolean(result.connected || result.hasClient || result.helloSnapshot || result.healthResult),
    connected: Boolean(result.connected),
    hasClient: Boolean(result.hasClient),
    hasHelloSnapshot: Boolean(normalizeRecord(result.helloSnapshot)),
    hasHealthResult: Boolean(normalizeRecord(result.healthResult)),
    hasSessionsState: Boolean(normalizeRecord(result.sessionsState)),
    hasModelCatalogState: Boolean(normalizeRecord(result.modelCatalogState)),
    appKeys: Array.isArray(result.appKeys) ? result.appKeys : [],
    lastError: String(result.lastError || '').trim() || undefined,
  }
}

function buildFallbackResult(
  inspection: ControlUiAppInspectionResult,
  fallbackReason: string
): OpenClawUpstreamModelStateResult {
  return {
    ok: false,
    source: 'control-ui-app',
    fallbackUsed: true,
    fallbackReason,
    diagnostics: buildDiagnostics(inspection),
  }
}

export async function getOpenClawUpstreamModelState(
  options: OpenClawUpstreamModelStateOptions = {}
): Promise<OpenClawUpstreamModelStateResult> {
  let inspection: ControlUiAppInspectionResult
  try {
    inspection = await inspectControlUiAppViaBrowser({
      readConfig,
      readEnvFile,
    }, options)
  } catch (error) {
    return {
      ok: false,
      source: 'control-ui-app',
      fallbackUsed: true,
      fallbackReason: (error as Error)?.message || 'control-ui-inspect-failed',
      diagnostics: {
        upstreamAvailable: false,
        connected: false,
        hasClient: false,
        hasHelloSnapshot: false,
        hasHealthResult: false,
        hasSessionsState: false,
        hasModelCatalogState: false,
        appKeys: [],
        lastError: (error as Error)?.message || 'control-ui-inspect-failed',
      },
    }
  }

  const diagnostics = buildDiagnostics(inspection)
  const helloSnapshot = normalizeRecord(inspection.helloSnapshot)
  const healthResult = normalizeRecord(inspection.healthResult)
  const sessionsState = normalizeRecord(inspection.sessionsState)
  const modelCatalogState = normalizeRecord(inspection.modelCatalogState)
  const hasSessionsResult = Object.prototype.hasOwnProperty.call(inspection, 'sessionsResult')
  const hasRpcStatus = Object.prototype.hasOwnProperty.call(inspection, 'rpcStatus')
  const hasRpcModels = Object.prototype.hasOwnProperty.call(inspection, 'rpcModels')
  const hasChatModelCatalog = Object.prototype.hasOwnProperty.call(inspection, 'chatModelCatalog')
  const hasRpcErrors = Object.prototype.hasOwnProperty.call(inspection, 'rpcErrors')
  const sessionsResult = hasSessionsResult ? normalizeRecord(inspection.sessionsResult) : undefined
  const rpcStatus = hasRpcStatus ? normalizeRecord(inspection.rpcStatus) : undefined
  const rpcModels = hasRpcModels ? normalizeRecord(inspection.rpcModels) : undefined
  const chatModelCatalog = hasChatModelCatalog ? normalizeRecordArray(inspection.chatModelCatalog) : undefined
  const rpcCatalogItems = extractRpcCatalogItems(inspection.rpcModels) || extractRpcCatalogItems(inspection.chatModelCatalog)
  const hasProjectedSessionsResult = sessionsResult !== undefined && sessionsResult !== null
  const hasProjectedRpcStatus = rpcStatus !== undefined && rpcStatus !== null
  const hasProjectedChatModelCatalog = chatModelCatalog !== undefined && chatModelCatalog !== null
  const modelStatusLike =
    findNestedModelStatusRecord(helloSnapshot) ||
    findNestedModelStatusRecord(healthResult) ||
    findNestedModelStatusRecord(sessionsState) ||
    findNestedModelStatusRecord(modelCatalogState) ||
    buildModelStatusLikeFromRpcSignals({
      catalogItems: rpcCatalogItems,
      sessionsResult: sessionsResult || null,
      rpcStatus: rpcStatus || null,
    })
  const catalogItemsLike =
    findNestedCatalogItems(modelCatalogState) ||
    findNestedCatalogItems(helloSnapshot) ||
    findNestedCatalogItems(healthResult) ||
    rpcCatalogItems
  const modelStatusSummaryLike = buildModelStatusSummaryLike(modelStatusLike)
  const catalogSummaryLike = buildCatalogSummaryLike(catalogItemsLike || null, rpcCatalogItems !== null)
  const sessionInventoryLike = buildSessionInventoryLike(
    sessionsState,
    helloSnapshot,
    healthResult,
    sessionsResult || null,
    rpcStatus || null
  )
  const debugSnapshots = buildDebugSnapshots({
    helloSnapshot,
    healthResult,
    sessionsState,
    modelCatalogState,
    sessionsResult,
    rpcStatus,
    rpcModels,
    chatModelCatalog,
    rpcErrors: hasRpcErrors && Array.isArray(inspection.rpcErrors) ? inspection.rpcErrors : undefined,
  })

  if (!inspection.connected && inspection.lastError) {
    return buildFallbackResult(inspection, `control-ui-app-error:${inspection.lastError}`)
  }
  if (!inspection.connected && !inspection.hasClient) {
    return buildFallbackResult(inspection, 'control-ui-app-unavailable')
  }
  if (
    !helloSnapshot &&
    !healthResult &&
    !sessionsState &&
    !modelCatalogState &&
    !hasProjectedSessionsResult &&
    !hasProjectedRpcStatus &&
    rpcCatalogItems === null &&
    !hasProjectedChatModelCatalog
  ) {
    return buildFallbackResult(inspection, 'control-ui-app-missing-model-state')
  }

  return {
    ok: true,
    source: 'control-ui-app',
    fallbackUsed: false,
    data: {
      source: 'control-ui-app',
      connected: Boolean(inspection.connected),
      hasClient: Boolean(inspection.hasClient),
      appKeys: diagnostics.appKeys,
      helloSnapshot,
      healthResult,
      sessionsState,
      modelCatalogState,
      modelStatusLike,
      modelStatusSummaryLike,
      catalogItemsLike: catalogItemsLike ?? undefined,
      catalogSummaryLike,
      sessionInventoryLike,
      debugSnapshots,
    },
    diagnostics,
  }
}

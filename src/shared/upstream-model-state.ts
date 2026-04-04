export type RendererUpstreamModelStateResult = Awaited<ReturnType<typeof window.api.getModelUpstreamState>>

export interface RendererUpstreamCatalogItemLike {
  key: string
  provider: string
  name?: string
  available?: boolean
}

export interface RendererUpstreamModelStatusSummaryLike {
  defaultModel?: string
  activeModel?: string
  allowedCount?: number
  fallbackCount?: number
  providerAuth: Array<{
    provider: string
    status?: string
  }>
}

export interface RendererUpstreamCatalogSummaryLike {
  totalItems: number
  availableItems: number
  providerKeys: string[]
}

export interface RendererUpstreamSessionInventoryLike {
  totalSessions?: number
  continuableSessions?: number
  patchableSessions?: number
  observedKinds: string[]
  observedChannels: string[]
}

export interface RendererUpstreamDebugSnapshotsLike {
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

export function createUnavailableUpstreamModelState(reason: unknown): RendererUpstreamModelStateResult {
  const message =
    reason instanceof Error
      ? reason.message
      : String(reason || '').trim() || 'upstream-model-state-read-failed'

  return {
    ok: false,
    source: 'control-ui-app',
    fallbackUsed: true,
    fallbackReason: message,
    diagnostics: {
      upstreamAvailable: false,
      connected: false,
      hasClient: false,
      hasHelloSnapshot: false,
      hasHealthResult: false,
      hasSessionsState: false,
      hasModelCatalogState: false,
      appKeys: [],
      lastError: message,
    },
  }
}

export async function readOpenClawUpstreamModelState(
  readState: () => Promise<RendererUpstreamModelStateResult> = () => window.api.getModelUpstreamState()
): Promise<RendererUpstreamModelStateResult> {
  return readState().catch((reason) => createUnavailableUpstreamModelState(reason))
}

export function logUpstreamModelStateFallback(
  scope: string,
  state: RendererUpstreamModelStateResult,
  logger: (...args: unknown[]) => void = console.info,
  enabled = true
): void {
  if (!enabled) return
  if (!state.fallbackUsed || !state.fallbackReason) return
  logger(`[${scope}] upstream model state fallback:`, state.fallbackReason)
}

export function getUpstreamModelStatusLike(
  state: RendererUpstreamModelStateResult
): Record<string, any> | null {
  if (!state.ok) return null
  const status = state.data?.modelStatusLike
  if (!status || typeof status !== 'object' || Array.isArray(status)) {
    return null
  }
  return status as Record<string, any>
}

export function getUpstreamCatalogItemsLike(
  state: RendererUpstreamModelStateResult
): RendererUpstreamCatalogItemLike[] {
  if (!state.ok || !Array.isArray(state.data?.catalogItemsLike)) {
    return []
  }

  return state.data.catalogItemsLike.filter((item): item is RendererUpstreamCatalogItemLike => {
    return Boolean(
      item &&
      typeof item === 'object' &&
      typeof item.key === 'string' &&
      item.key.trim() &&
      typeof item.provider === 'string' &&
      item.provider.trim()
    )
  })
}

export function selectPreferredRendererCatalogItems<T>(params: {
  cliLoaded: boolean
  cliItems?: T[] | null
  upstreamItems?: T[] | null
}): T[] {
  if (params.cliLoaded) {
    return Array.isArray(params.cliItems) ? [...params.cliItems] : []
  }

  return Array.isArray(params.upstreamItems) ? [...params.upstreamItems] : []
}

export function getUpstreamModelStatusSummaryLike(
  state: RendererUpstreamModelStateResult
): RendererUpstreamModelStatusSummaryLike | null {
  if (!state.ok) return null
  const summary = state.data?.modelStatusSummaryLike
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) {
    return null
  }
  if (!Array.isArray(summary.providerAuth)) {
    return null
  }
  return {
    defaultModel: typeof summary.defaultModel === 'string' ? summary.defaultModel : undefined,
    activeModel: typeof summary.activeModel === 'string' ? summary.activeModel : undefined,
    allowedCount: typeof summary.allowedCount === 'number' ? summary.allowedCount : undefined,
    fallbackCount: typeof summary.fallbackCount === 'number' ? summary.fallbackCount : undefined,
    providerAuth: summary.providerAuth.filter((item): item is { provider: string; status?: string } => {
      return Boolean(item && typeof item.provider === 'string' && item.provider.trim())
    }),
  }
}

export function getUpstreamCatalogSummaryLike(
  state: RendererUpstreamModelStateResult
): RendererUpstreamCatalogSummaryLike | null {
  if (!state.ok) return null
  const summary = state.data?.catalogSummaryLike
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) {
    return null
  }
  if (!Array.isArray(summary.providerKeys)) {
    return null
  }
  return {
    totalItems: typeof summary.totalItems === 'number' ? summary.totalItems : 0,
    availableItems: typeof summary.availableItems === 'number' ? summary.availableItems : 0,
    providerKeys: summary.providerKeys.filter(
      (item): item is string => typeof item === 'string' && item.trim().length > 0
    ),
  }
}

export function getUpstreamSessionInventoryLike(
  state: RendererUpstreamModelStateResult
): RendererUpstreamSessionInventoryLike | null {
  if (!state.ok) return null
  const inventory = state.data?.sessionInventoryLike
  if (!inventory || typeof inventory !== 'object' || Array.isArray(inventory)) {
    return null
  }
  if (!Array.isArray(inventory.observedKinds) || !Array.isArray(inventory.observedChannels)) {
    return null
  }
  return {
    totalSessions: typeof inventory.totalSessions === 'number' ? inventory.totalSessions : undefined,
    continuableSessions:
      typeof inventory.continuableSessions === 'number' ? inventory.continuableSessions : undefined,
    patchableSessions: typeof inventory.patchableSessions === 'number' ? inventory.patchableSessions : undefined,
    observedKinds: inventory.observedKinds.filter(
      (item): item is string => typeof item === 'string' && item.trim().length > 0
    ),
    observedChannels: inventory.observedChannels.filter(
      (item): item is string => typeof item === 'string' && item.trim().length > 0
    ),
  }
}

export function getUpstreamDebugSnapshotsLike(
  state: RendererUpstreamModelStateResult
): RendererUpstreamDebugSnapshotsLike | null {
  if (!state.ok) return null
  const snapshots = state.data?.debugSnapshots
  if (!snapshots || typeof snapshots !== 'object' || Array.isArray(snapshots)) {
    return null
  }
  const result: RendererUpstreamDebugSnapshotsLike = {
    helloSnapshot:
      snapshots.helloSnapshot && typeof snapshots.helloSnapshot === 'object' && !Array.isArray(snapshots.helloSnapshot)
        ? snapshots.helloSnapshot
        : null,
    healthResult:
      snapshots.healthResult && typeof snapshots.healthResult === 'object' && !Array.isArray(snapshots.healthResult)
        ? snapshots.healthResult
        : null,
    sessionsState:
      snapshots.sessionsState && typeof snapshots.sessionsState === 'object' && !Array.isArray(snapshots.sessionsState)
        ? snapshots.sessionsState
        : null,
    modelCatalogState:
      snapshots.modelCatalogState &&
      typeof snapshots.modelCatalogState === 'object' &&
      !Array.isArray(snapshots.modelCatalogState)
        ? snapshots.modelCatalogState
        : null,
  }

  if ('sessionsResult' in snapshots) {
    result.sessionsResult =
      snapshots.sessionsResult && typeof snapshots.sessionsResult === 'object' && !Array.isArray(snapshots.sessionsResult)
        ? snapshots.sessionsResult
        : null
  }
  if ('rpcStatus' in snapshots) {
    result.rpcStatus =
      snapshots.rpcStatus && typeof snapshots.rpcStatus === 'object' && !Array.isArray(snapshots.rpcStatus)
        ? snapshots.rpcStatus
        : null
  }
  if ('rpcModels' in snapshots) {
    result.rpcModels =
      snapshots.rpcModels && typeof snapshots.rpcModels === 'object' && !Array.isArray(snapshots.rpcModels)
        ? snapshots.rpcModels
        : null
  }
  if ('chatModelCatalog' in snapshots) {
    result.chatModelCatalog = Array.isArray(snapshots.chatModelCatalog)
      ? snapshots.chatModelCatalog.filter(
          (item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item))
        )
      : null
  }
  if (Array.isArray(snapshots.rpcErrors)) {
    result.rpcErrors = snapshots.rpcErrors.filter(
      (item): item is string => typeof item === 'string' && item.trim().length > 0
    )
  }

  return result
}

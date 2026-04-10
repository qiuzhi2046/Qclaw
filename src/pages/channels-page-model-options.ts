import {
  listAllModelCatalogItems,
  type ModelCatalogPaginationQuery,
  type ModelCatalogPaginationResult,
} from '../lib/model-catalog-pagination'
import {
  getUpstreamCatalogItemsLike,
  getUpstreamModelStatusLike,
  selectPreferredRendererCatalogItems,
  type RendererUpstreamModelStateResult,
} from '../shared/upstream-model-state'
import { buildVisibleModelCatalog, resolveModelsPageCatalogState } from './models-page-state'

interface ModelCatalogItemLike {
  key: string
  name?: string
  available?: boolean
  provider?: string
}

export interface ModelSelectOption {
  value: string
  label: string
}

interface LoadReadyModelSelectOptionsInput {
  forceRefresh?: boolean
  mode?: 'available' | 'all'
  envVars?: Record<string, string> | null
  configData?: Record<string, any> | null
  statusData?: Record<string, any> | null
  preferredModelKey?: string
  catalogItems?: ModelCatalogItemLike[] | null
  readUpstreamState?: () => Promise<RendererUpstreamModelStateResult>
}

function formatModelOptionLabel(item: ModelCatalogItemLike): string {
  const key = String(item.key || '').trim()
  const name = String(item.name || '').trim()
  return name && name !== key ? `${name} (${key})` : key
}

function normalizeCatalogProvider(item: ModelCatalogItemLike): string {
  const provider = String(item.provider || '').trim()
  if (provider) return provider

  const key = String(item.key || '').trim()
  if (!key.includes('/')) return 'unknown'
  return String(key.split('/')[0] || '').trim() || 'unknown'
}

export function buildModelSelectOptions(items: ModelCatalogItemLike[]): ModelSelectOption[] {
  return items
    .map((item) => ({
      value: String(item.key || '').trim(),
      label: formatModelOptionLabel(item),
    }))
    .filter((item) => item.value)
}

export function ensureModelSelectOption(options: ModelSelectOption[], model: string): ModelSelectOption[] {
  const normalizedModel = String(model || '').trim()
  if (!normalizedModel) {
    return options
  }
  const hasExactMatch = options.some((item) => item.value === normalizedModel)
  if (hasExactMatch) return options
  return [{ value: normalizedModel, label: `${normalizedModel}（当前）` }, ...options]
}

function buildReadyModelOptionsFromCatalog(
  catalogItems: ModelCatalogItemLike[],
  options?: LoadReadyModelSelectOptionsInput
): ModelSelectOption[] {
  const normalizedItems = catalogItems.map((item) => ({
    ...item,
    provider: normalizeCatalogProvider(item),
  }))

  if (options?.mode === 'all') {
    const { scopedCatalog } = resolveModelsPageCatalogState({
      catalog: normalizedItems,
      envVars: options?.envVars ?? null,
      config: options?.configData ?? null,
      statusData: options?.statusData ?? null,
      preferredModelKey: options?.preferredModelKey,
      mode: 'all',
    })

    return buildModelSelectOptions(scopedCatalog)
  }

  const readyItems = buildVisibleModelCatalog(
    normalizedItems,
    {
      mode: 'available',
      statusData: options?.statusData ?? null,
      preferredModelKey: options?.preferredModelKey,
    }
  )

  return buildModelSelectOptions(readyItems)
}

export async function loadReadyModelSelectOptions(
  listCatalog: (query?: ModelCatalogPaginationQuery) => Promise<ModelCatalogPaginationResult<ModelCatalogItemLike>>,
  options?: LoadReadyModelSelectOptionsInput
): Promise<ModelSelectOption[]> {
  if (Array.isArray(options?.catalogItems)) {
    return buildReadyModelOptionsFromCatalog(options.catalogItems, options)
  }

  const upstreamState = options?.readUpstreamState
    ? await options.readUpstreamState().catch(() => null)
    : null
  const upstreamCatalog = upstreamState ? getUpstreamCatalogItemsLike(upstreamState) : []
  const statusData = options?.statusData ?? (upstreamState ? getUpstreamModelStatusLike(upstreamState) : null)
  let cliCatalog: ModelCatalogItemLike[] = []
  let cliCatalogLoaded = false

  try {
    cliCatalog = await listAllModelCatalogItems(listCatalog, {
      includeUnavailable: true,
      ...(options?.forceRefresh ? { bypassCache: true } : {}),
    })
    cliCatalogLoaded = true
  } catch (error) {
    if (upstreamCatalog.length === 0) {
      throw error
    }
    cliCatalog = []
    cliCatalogLoaded = false
  }

  const items = selectPreferredRendererCatalogItems({
    cliLoaded: cliCatalogLoaded,
    cliItems: cliCatalog,
    upstreamItems: upstreamCatalog,
  })
  return buildReadyModelOptionsFromCatalog(items, {
    ...options,
    statusData,
  })
}

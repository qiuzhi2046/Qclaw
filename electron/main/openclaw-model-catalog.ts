import type {
  CliCommandResult,
  OpenClawCapabilities,
  OpenClawCapabilitiesProfile,
} from './openclaw-capabilities'
import { atomicWriteJson } from './atomic-write'
import { buildModelsListAllCommand } from './openclaw-command-builder'
import { getCliFailureMessage, parseJsonFromOutput } from './openclaw-command-output'
import { resolveOpenClawPaths } from './openclaw-paths'
import { MAIN_RUNTIME_POLICY } from './runtime-policy'
import { MODEL_CATALOG_LIMITS } from '../../src/shared/runtime-policies'

const DEFAULT_CACHE_PATH = resolveOpenClawPaths().modelCatalogCacheFile
const DEFAULT_CATALOG_TIMEOUT_MS = MAIN_RUNTIME_POLICY.modelCatalog.fetchTimeoutMs
const DEFAULT_TTL_MS = MAIN_RUNTIME_POLICY.modelCatalog.cacheTtlMs
const DEFAULT_PAGE_SIZE = MODEL_CATALOG_LIMITS.backendDefaultPageSize
const MAX_PAGE_SIZE = MODEL_CATALOG_LIMITS.maxPageSize
const MODEL_CATALOG_CAPABILITIES_PROFILE: OpenClawCapabilitiesProfile = 'bootstrap'

export interface ModelCatalogItem {
  key: string
  name: string
  provider: string
  input?: string
  contextWindow?: number
  local: boolean
  available: boolean
  tags: string[]
  missing: string[]
}

export interface ModelCatalogQuery {
  provider?: string
  search?: string
  page?: number
  pageSize?: number
  localOnly?: boolean
  includeUnavailable?: boolean
  bypassCache?: boolean
}

export interface ModelCatalogCache {
  fetchedAt: string
  models: ModelCatalogItem[]
}

export interface ModelCatalogResult {
  total: number
  items: ModelCatalogItem[]
  providers: string[]
  updatedAt: string
  source: 'live' | 'cache'
  stale: boolean
}

type ModelCatalogCachePolicy = 'live-first' | 'prefer-stale'

interface GetModelCatalogOptions {
  query?: ModelCatalogQuery
  cachePolicy?: ModelCatalogCachePolicy
  ttlMs?: number
  runCommand?: (args: string[], timeout?: number) => Promise<CliCommandResult>
  capabilities?: OpenClawCapabilities
  loadCapabilities?: (options?: { profile?: OpenClawCapabilitiesProfile }) => Promise<OpenClawCapabilities>
  readCache?: () => Promise<ModelCatalogCache | null>
  writeCache?: (cache: ModelCatalogCache) => Promise<void>
  now?: () => Date
}

interface ResolvedCatalogData {
  models: ModelCatalogItem[]
  providers: string[]
  updatedAt: string
  source: 'live' | 'cache'
  stale: boolean
}

function uniqueSorted(items: string[]): string[] {
  return Array.from(new Set(items.filter(Boolean))).sort((a, b) => a.localeCompare(b))
}

function normalizeModelEntry(raw: Record<string, unknown>): ModelCatalogItem | null {
  const key = String(raw.key || '').trim()
  if (!key) return null

  const provider = key.includes('/') ? key.split('/')[0] : 'unknown'
  const name = String(raw.name || key).trim() || key
  const contextWindowRaw = Number(raw.contextWindow)
  const contextWindow = Number.isFinite(contextWindowRaw) ? contextWindowRaw : undefined
  const input = typeof raw.input === 'string' ? raw.input : undefined
  const local = Boolean(raw.local)
  const available = raw.available !== false
  const tags = Array.isArray(raw.tags) ? raw.tags.map((v) => String(v)).filter(Boolean) : []
  const missing = Array.isArray(raw.missing) ? raw.missing.map((v) => String(v)).filter(Boolean) : []

  return {
    key,
    name,
    provider,
    input,
    contextWindow,
    local,
    available,
    tags,
    missing,
  }
}

function normalizeCatalogPayload(payload: unknown): ModelCatalogItem[] {
  let entries: unknown[] = []

  if (Array.isArray(payload)) {
    entries = payload
  } else if (payload && typeof payload === 'object' && Array.isArray((payload as Record<string, unknown>).models)) {
    entries = (payload as Record<string, unknown>).models as unknown[]
  } else {
    throw new Error('Invalid model catalog payload: expected array or { models: [] }')
  }

  const models: ModelCatalogItem[] = []
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    const normalized = normalizeModelEntry(entry as Record<string, unknown>)
    if (normalized) models.push(normalized)
  }
  return models
}

function filterModels(models: ModelCatalogItem[], query: ModelCatalogQuery = {}): ModelCatalogItem[] {
  const provider = (query.provider || '').trim().toLowerCase()
  const search = (query.search || '').trim().toLowerCase()
  const includeUnavailable = query.includeUnavailable !== false
  const localOnly = query.localOnly === true

  return models.filter((item) => {
    if (provider && item.provider.toLowerCase() !== provider) return false
    if (!includeUnavailable && !item.available) return false
    if (localOnly && !item.local) return false
    if (search) {
      const haystack = `${item.key} ${item.name} ${item.tags.join(' ')}`.toLowerCase()
      if (!haystack.includes(search)) return false
    }
    return true
  })
}

function applyQuery(models: ModelCatalogItem[], query: ModelCatalogQuery = {}) {
  const page = Math.max(1, query.page || 1)
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, query.pageSize || DEFAULT_PAGE_SIZE))
  const filtered = filterModels(models, query)

  const total = filtered.length
  const start = (page - 1) * pageSize
  const items = filtered.slice(start, start + pageSize)
  return { total, items }
}

function resolveCacheAgeMs(fetchedAt: string, now: () => Date): number {
  const cacheTime = new Date(fetchedAt).getTime()
  if (!Number.isFinite(cacheTime)) return Number.POSITIVE_INFINITY
  return Math.max(0, now().getTime() - cacheTime)
}

async function defaultRunCommand(args: string[], timeout?: number): Promise<CliCommandResult> {
  const cli = await import('./cli')
  return cli.runCli(args, timeout, 'models')
}

async function resolveCapabilities(
  options: GetModelCatalogOptions
): Promise<OpenClawCapabilities | undefined> {
  if (options.capabilities) return options.capabilities
  if (options.loadCapabilities) {
    return options.loadCapabilities({ profile: MODEL_CATALOG_CAPABILITIES_PROFILE })
  }
  if (options.runCommand) return undefined

  const { loadOpenClawCapabilities } = await import('./openclaw-capabilities')
  return loadOpenClawCapabilities({ profile: MODEL_CATALOG_CAPABILITIES_PROFILE })
}

async function defaultReadCache(): Promise<ModelCatalogCache | null> {
  try {
    const { readFile } = await import('node:fs/promises')
    const raw = await readFile(DEFAULT_CACHE_PATH, 'utf-8')
    const parsed = JSON.parse(raw) as ModelCatalogCache
    if (!parsed || !Array.isArray(parsed.models) || typeof parsed.fetchedAt !== 'string') return null
    return {
      fetchedAt: parsed.fetchedAt,
      models: parsed.models
        .map((entry) => normalizeModelEntry(entry as unknown as Record<string, unknown>))
        .filter(Boolean) as ModelCatalogItem[],
    }
  } catch {
    return null
  }
}

async function defaultWriteCache(cache: ModelCatalogCache): Promise<void> {
  await atomicWriteJson(DEFAULT_CACHE_PATH, cache, {
    description: '模型目录缓存',
  })
}

async function loadResolvedCatalogData(options: GetModelCatalogOptions = {}): Promise<ResolvedCatalogData> {
  const runCommand = options.runCommand ?? defaultRunCommand
  const readCache = options.readCache ?? defaultReadCache
  const writeCache = options.writeCache ?? defaultWriteCache
  const now = options.now ?? (() => new Date())
  const ttlMs = Math.max(1_000, options.ttlMs || DEFAULT_TTL_MS)

  const query = options.query || {}
  const cachePolicy = options.cachePolicy ?? 'live-first'
  const bypassCache = query.bypassCache === true
  const cached = await readCache()
  const hasCachedModels = Boolean(cached && Array.isArray(cached.models) && cached.models.length > 0)

  if (hasCachedModels && !bypassCache) {
    const ageMs = resolveCacheAgeMs(cached!.fetchedAt, now)
    if (cachePolicy === 'prefer-stale') {
      return {
        models: cached!.models,
        providers: uniqueSorted(cached!.models.map((item) => item.provider)),
        updatedAt: cached!.fetchedAt,
        source: 'cache',
        stale: ageMs > ttlMs,
      }
    }

    if (ageMs <= ttlMs) {
      return {
        models: cached!.models,
        providers: uniqueSorted(cached!.models.map((item) => item.provider)),
        updatedAt: cached!.fetchedAt,
        source: 'cache',
        stale: false,
      }
    }
  }

  try {
    const capabilities = await resolveCapabilities(options)
    const buildResult = buildModelsListAllCommand(capabilities)
    if (!buildResult.ok) {
      throw new Error(buildResult.message)
    }

    const commandResult = await runCommand(buildResult.command, DEFAULT_CATALOG_TIMEOUT_MS)
    if (!commandResult.ok) {
      throw new Error(getCliFailureMessage(commandResult, 'models list command failed'))
    }

    let payload: unknown
    try {
      payload = parseJsonFromOutput(commandResult.stdout)
    } catch (error) {
      throw new Error(`Failed to parse model catalog JSON: ${(error as Error).message}`)
    }

    const models = normalizeCatalogPayload(payload)
    const fetchedAt = now().toISOString()

    try {
      await writeCache({ fetchedAt, models })
    } catch {
      // Ignore cache write errors so live data still works.
    }

    return {
      models,
      providers: uniqueSorted(models.map((item) => item.provider)),
      updatedAt: fetchedAt,
      source: 'live',
      stale: false,
    }
  } catch (liveError) {
    if (!hasCachedModels) {
      throw liveError
    }

    const ageMs = resolveCacheAgeMs(cached!.fetchedAt, now)
    return {
      models: cached!.models,
      providers: uniqueSorted(cached!.models.map((item) => item.provider)),
      updatedAt: cached!.fetchedAt,
      source: 'cache',
      stale: ageMs > ttlMs,
    }
  }
}

export async function getModelCatalog(options: GetModelCatalogOptions = {}): Promise<ModelCatalogResult> {
  const resolved = await loadResolvedCatalogData(options)
  const { total, items } = applyQuery(resolved.models, options.query || {})
  return {
    total,
    items,
    providers: resolved.providers,
    updatedAt: resolved.updatedAt,
    source: resolved.source,
    stale: resolved.stale,
  }
}

export async function getAllModelCatalogItems(options: GetModelCatalogOptions = {}): Promise<ModelCatalogResult> {
  const resolved = await loadResolvedCatalogData(options)
  const items = filterModels(resolved.models, options.query || {})
  return {
    total: items.length,
    items,
    providers: resolved.providers,
    updatedAt: resolved.updatedAt,
    source: resolved.source,
    stale: resolved.stale,
  }
}

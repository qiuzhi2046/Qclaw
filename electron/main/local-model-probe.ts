/**
 * Lightweight HTTP reachability probe for local model providers.
 * Does NOT do full model discovery — that's the CLI's job via `models list`.
 */

import { atomicWriteJson } from './atomic-write'
import { parseJsonFromOutput } from './openclaw-command-output'

const { readdir, readFile } = process.getBuiltinModule('node:fs/promises') as typeof import('node:fs/promises')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')

export type LocalProviderType = 'ollama' | 'vllm' | 'custom-openai'

export interface LocalConnectionTestInput {
  provider: LocalProviderType
  baseUrl: string
  apiKey?: string
}

export interface LocalConnectionTestResult {
  ok: boolean
  reachable: boolean
  modelCount?: number
  error?: string
  latencyMs?: number
}

const PROBE_TIMEOUT_MS = 5_000
const LOCAL_PROVIDER_DISPLAY_NAMES: Record<LocalProviderType, string> = {
  ollama: 'Ollama',
  vllm: 'vLLM',
  'custom-openai': 'OpenAI 兼容本地服务',
}

function extractConnectionFailureCode(error: unknown): string {
  const directCode = String((error as { code?: unknown })?.code || '').trim()
  if (directCode) return directCode.toUpperCase()

  const causeCode = String((error as { cause?: { code?: unknown } })?.cause?.code || '').trim()
  if (causeCode) return causeCode.toUpperCase()

  return ''
}

function extractConnectionFailureMessage(error: unknown): string {
  const causeMessage = String((error as { cause?: { message?: unknown } })?.cause?.message || '').trim()
  if (causeMessage) return causeMessage
  return String((error as { message?: unknown })?.message || '').trim()
}

function describeProbeTarget(url: string): { origin: string; host: string } {
  try {
    const parsed = new URL(url)
    return {
      origin: parsed.origin,
      host: parsed.host || parsed.origin,
    }
  } catch {
    return {
      origin: url,
      host: url,
    }
  }
}

function formatLocalConnectionFailure(
  provider: LocalProviderType,
  url: string,
  error: unknown
): string {
  const providerName = LOCAL_PROVIDER_DISPLAY_NAMES[provider]
  const target = describeProbeTarget(url)
  const failureCode = extractConnectionFailureCode(error)
  const failureMessage = extractConnectionFailureMessage(error)

  if (failureCode === 'ECONNREFUSED') {
    return `无法连接到 ${providerName}（${target.origin}），连接被拒绝。请确认本地服务已启动并监听 ${target.host}。`
  }

  if (failureCode === 'ENOTFOUND') {
    return `无法解析 ${target.host}。请检查接口地址是否填写正确。`
  }

  if (failureCode === 'ECONNRESET') {
    return `${providerName} 在连接过程中意外断开。请检查本地服务日志后重试。`
  }

  if (failureMessage && failureMessage.toLowerCase() !== 'fetch failed') {
    return `${providerName} 连接失败：${failureMessage}`
  }

  return `${providerName} 连接失败，请确认 ${target.origin} 当前可访问。`
}

export async function testLocalConnection(
  input: LocalConnectionTestInput
): Promise<LocalConnectionTestResult> {
  const { provider, baseUrl, apiKey } = input
  if (!baseUrl) {
    return { ok: false, reachable: false, error: '接口地址不能为空' }
  }

  const url = provider === 'ollama'
    ? `${baseUrl.replace(/\/+$/, '')}/api/tags`
    : `${baseUrl.replace(/\/+$/, '')}/models`

  const headers: Record<string, string> = { Accept: 'application/json' }
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`
  }

  const start = Date.now()
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)

    const response = await fetch(url, {
      method: 'GET',
      headers,
      signal: controller.signal,
    })
    clearTimeout(timer)

    const latencyMs = Date.now() - start

    if (!response.ok) {
      return {
        ok: false,
        reachable: true,
        latencyMs,
        error: `HTTP ${response.status} ${response.statusText}`,
      }
    }

    let modelCount: number | undefined
    try {
      const body = await response.json()
      if (provider === 'ollama' && Array.isArray(body?.models)) {
        modelCount = body.models.length
      } else if (Array.isArray(body?.data)) {
        modelCount = body.data.length
      }
    } catch {
      // JSON parse failure is fine — reachability is confirmed
    }

    return { ok: true, reachable: true, modelCount, latencyMs }
  } catch (err: any) {
    const latencyMs = Date.now() - start
    const message = err?.name === 'AbortError'
      ? `Connection timed out after ${PROBE_TIMEOUT_MS}ms`
      : formatLocalConnectionFailure(provider, url, err)
    return { ok: false, reachable: false, latencyMs, error: message }
  }
}

export interface EnsureLocalAuthProfileInput {
  provider: LocalProviderType
  apiKey?: string
}

export interface EnsureLocalAuthProfileResult {
  ok: boolean
  created: boolean
  profileId: string
  error?: string
}

export interface UpsertApiKeyAuthProfileInput {
  provider: string
  apiKey: string
  profileId?: string
  authStorePath?: string
}

export interface UpsertApiKeyAuthProfileResult {
  ok: boolean
  created: boolean
  updated: boolean
  profileId: string
  authStorePath?: string
  error?: string
}

export interface RepairMainAuthProfilesFromOtherAgentStoresInput {
  providerIds: string[]
  sourceAuthStorePaths?: string[]
}

export interface RepairMainAuthProfilesFromOtherAgentStoresResult {
  ok: boolean
  repaired: boolean
  authStorePath?: string
  importedProfileIds: string[]
  importedProviders: string[]
  sourceAuthStorePaths: string[]
  error?: string
}

export interface RepairAgentAuthProfilesFromOtherAgentStoresInput {
  providerIds: string[]
  targetAgentIds?: string[]
  sourceAuthStorePaths?: string[]
}

export interface RepairAgentAuthProfilesFromOtherAgentStoresResult {
  ok: boolean
  repaired: boolean
  updatedAuthStorePaths: string[]
  importedProfileIds: string[]
  importedProviders: string[]
  sourceAuthStorePaths: string[]
  error?: string
}

export interface ClearModelAuthProfilesInput {
  providerIds: string[]
  authStorePath?: string
}

export interface ClearModelAuthProfilesResult {
  ok: boolean
  removed: number
  removedProfileIds: string[]
  authStorePath?: string
  clearedLastGoodKeys?: string[]
  error?: string
}

export interface InspectModelAuthProfilesInput {
  providerIds: string[]
  authStorePath?: string
}

export interface InspectModelAuthProfilesResult {
  ok: boolean
  present: boolean
  matchedProfileIds: string[]
  matchedLastGoodKeys: string[]
  authStorePath?: string
  error?: string
}

interface LocalAuthStorePathRuntimePaths {
  homeDir: string
}

interface ModelStatusCommandResult {
  ok: boolean
  stdout: string
  stderr: string
  code: number | null
}

interface ModelStatusCommandInput {
  agentId?: string
}

interface LocalAuthStorePathOptions {
  getModelStatusCommand?: (input?: ModelStatusCommandInput) => Promise<ModelStatusCommandResult>
  resolveRuntimePaths?: () => Promise<LocalAuthStorePathRuntimePaths>
}

interface LocalAuthProfileStoreOptions extends LocalAuthStorePathOptions {
  authStorePath?: string
  readFileFn?: typeof readFile
  writeJsonFn?: typeof atomicWriteJson
}

interface AuthProfilesData {
  version: number
  profiles: Record<string, any>
  usageStats?: Record<string, any>
  lastGood?: Record<string, any>
}

const DEFAULT_LOCAL_AGENT_ID = 'main'
const LOCAL_PROVIDER_AUTH_MARKERS: Record<LocalProviderType, string> = {
  ollama: 'ollama-local',
  vllm: 'vllm-local',
  'custom-openai': 'custom-local',
}

type NodePathModule = typeof path.posix

function inferPathModuleFromPath(value: unknown): NodePathModule {
  const rawValue = String(value || '')
  if (/^[A-Za-z]:[\\/]/.test(rawValue) || rawValue.includes('\\')) return path.win32
  return path.posix
}

function joinPathUsing(stylePath: unknown, basePath: string, ...parts: string[]): string {
  return inferPathModuleFromPath(stylePath).join(basePath, ...parts)
}

function joinPathLike(basePath: string, ...parts: string[]): string {
  return joinPathUsing(basePath, basePath, ...parts)
}

const PROVIDER_ALIAS_TO_CANONICAL: Record<string, string> = {
  'openai-codex': 'openai',
  gemini: 'google',
  'google-gemini-cli': 'google',
  'qwen-portal': 'qwen',
  'minimax-portal': 'minimax',
}

function normalizeProviderId(value: unknown): string {
  return String(value || '').trim().toLowerCase()
}

function canonicalizeProviderId(value: unknown): string {
  const normalized = normalizeProviderId(value)
  if (!normalized) return ''
  return PROVIDER_ALIAS_TO_CANONICAL[normalized] || normalized
}

function buildProviderSet(providerIds: string[]): Set<string> {
  const values = providerIds
    .flatMap((value) => [normalizeProviderId(value), canonicalizeProviderId(value)])
    .filter(Boolean)
  return new Set(values)
}

function buildExactProviderSet(providerIds: string[]): Set<string> {
  return new Set(providerIds.map((value) => normalizeProviderId(value)).filter(Boolean))
}

function buildScopedAgentRepairProviderSet(providerIds: string[]): Set<string> {
  const scopedProviders = new Set<string>()
  for (const providerId of providerIds) {
    const normalizedProviderId = normalizeProviderId(providerId)
    if (!normalizedProviderId) continue
    if (normalizedProviderId === 'minimax' || normalizedProviderId === 'minimax-portal') {
      scopedProviders.add('minimax')
      scopedProviders.add('minimax-portal')
      continue
    }
    scopedProviders.add(normalizedProviderId)
  }
  return scopedProviders
}

function lastGoodEntryMatchesProvider(providerSet: Set<string>, key: string, value: unknown): boolean {
  const canonicalKey = canonicalizeProviderId(key)
  if (canonicalKey && providerSet.has(canonicalKey)) {
    return true
  }

  const profileProvider = canonicalizeProviderId(String(value || '').split(':')[0])
  return Boolean(profileProvider && providerSet.has(profileProvider))
}

function profileMatchesProvider(providerSet: Set<string>, profileId: string, profile: any): boolean {
  const keyProviderId = canonicalizeProviderId(String(profileId || '').split(':')[0])
  const providerFromProfile = canonicalizeProviderId(profile?.provider ?? profile?.providerId)
  return Boolean(
    (keyProviderId && providerSet.has(keyProviderId))
    || (providerFromProfile && providerSet.has(providerFromProfile))
  )
}

function profileMatchesExactProvider(providerSet: Set<string>, profileId: string, profile: any): boolean {
  const keyProviderId = normalizeProviderId(String(profileId || '').split(':')[0])
  const providerFromProfile = normalizeProviderId(profile?.provider ?? profile?.providerId)
  return Boolean(
    (keyProviderId && providerSet.has(keyProviderId))
    || (providerFromProfile && providerSet.has(providerFromProfile))
  )
}

function lastGoodEntryMatchesExactProvider(providerSet: Set<string>, key: string, value: unknown): boolean {
  const normalizedKey = normalizeProviderId(key)
  if (normalizedKey && providerSet.has(normalizedKey)) {
    return true
  }

  const profileProvider = normalizeProviderId(String(value || '').split(':')[0])
  return Boolean(profileProvider && providerSet.has(profileProvider))
}

function buildFallbackAuthStorePath(homeDir: string, pathStyleHint?: unknown): string {
  if (pathStyleHint) {
    return joinPathUsing(pathStyleHint, homeDir, 'agents', DEFAULT_LOCAL_AGENT_ID, 'agent', 'auth-profiles.json')
  }
  return path.join(homeDir, 'agents', DEFAULT_LOCAL_AGENT_ID, 'agent', 'auth-profiles.json')
}

function normalizeSafeAgentId(agentId: unknown): string {
  const normalizedAgentId = String(agentId || '').trim()
  if (!normalizedAgentId) return DEFAULT_LOCAL_AGENT_ID
  if (!/^[A-Za-z0-9._-]+$/.test(normalizedAgentId)) return ''
  if (normalizedAgentId === '.' || normalizedAgentId === '..') return ''
  return normalizedAgentId
}

function buildAgentAuthStorePath(homeDir: string, agentId: unknown, pathStyleHint?: unknown): string {
  const normalizedAgentId = normalizeSafeAgentId(agentId)
  if (!normalizedAgentId) return ''
  return joinPathUsing(pathStyleHint || homeDir, homeDir, 'agents', normalizedAgentId, 'agent', 'auth-profiles.json')
}

function createEmptyAuthProfilesData(): AuthProfilesData {
  return {
    version: 1,
    profiles: {},
    lastGood: {},
    usageStats: {},
  }
}

async function readAuthProfilesData(
  authStorePath: string,
  readFileFn: typeof readFile
): Promise<AuthProfilesData> {
  let data: AuthProfilesData
  try {
    const raw = await readFileFn(authStorePath, 'utf-8')
    data = JSON.parse(raw)
  } catch {
    data = createEmptyAuthProfilesData()
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return createEmptyAuthProfilesData()
  }

  if (!data.profiles || typeof data.profiles !== 'object' || Array.isArray(data.profiles)) {
    data.profiles = {}
  }
  if (!data.lastGood || typeof data.lastGood !== 'object' || Array.isArray(data.lastGood)) {
    data.lastGood = {}
  }
  if (!data.usageStats || typeof data.usageStats !== 'object' || Array.isArray(data.usageStats)) {
    data.usageStats = {}
  }

  return data
}

async function listDiscoveredAgentAuthStorePaths(
  resolveRuntimePaths: () => Promise<LocalAuthStorePathRuntimePaths>
): Promise<string[]> {
  const runtimePaths = await resolveRuntimePaths()
  const agentsRoot = joinPathLike(runtimePaths.homeDir, 'agents')

  try {
    const entries = await readdir(agentsRoot, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => joinPathLike(agentsRoot, entry.name, 'agent', 'auth-profiles.json'))
  } catch {
    return []
  }
}

async function defaultGetModelStatusCommand(
  input: ModelStatusCommandInput = {}
): Promise<ModelStatusCommandResult> {
  const { getModelStatus } = await import('./openclaw-model-config')
  const result = await getModelStatus(input.agentId ? { agentId: input.agentId } : {})
  return {
    ok: result.ok,
    stdout: result.stdout,
    stderr: result.stderr,
    code: result.code,
  }
}

async function defaultResolveRuntimePaths(): Promise<LocalAuthStorePathRuntimePaths> {
  const { resolveRuntimeOpenClawPaths } = await import('./openclaw-runtime-paths')
  return resolveRuntimeOpenClawPaths()
}

export function extractAuthStorePathFromModelStatus(stdout: string): string {
  try {
    const payload = parseJsonFromOutput<Record<string, any>>(stdout)
    const authStorePath = String(payload?.auth?.storePath || '').trim()
    if (authStorePath) return authStorePath

    const agentDir = String(payload?.agentDir || '').trim()
    if (agentDir) return path.join(agentDir, 'auth-profiles.json')
  } catch {
    // Fall through to empty string so callers can use a runtime-path fallback.
  }

  return ''
}

export async function resolveLocalAuthStorePath(
  options: LocalAuthStorePathOptions = {}
): Promise<string> {
  const getModelStatusCommand = options.getModelStatusCommand ?? defaultGetModelStatusCommand
  const resolveRuntimePaths = options.resolveRuntimePaths ?? defaultResolveRuntimePaths

  try {
    const statusResult = await getModelStatusCommand()
    if (statusResult.ok) {
      const resolvedFromStatus = extractAuthStorePathFromModelStatus(statusResult.stdout)
      if (resolvedFromStatus) return resolvedFromStatus
    }
  } catch {
    // Fall back to runtime paths below.
  }

  const runtimePaths = await resolveRuntimePaths()
  return buildFallbackAuthStorePath(runtimePaths.homeDir)
}

export async function resolveMainAuthStorePath(
  options: LocalAuthStorePathOptions = {}
): Promise<string> {
  const getModelStatusCommand = options.getModelStatusCommand ?? defaultGetModelStatusCommand
  const resolveRuntimePaths = options.resolveRuntimePaths ?? defaultResolveRuntimePaths

  try {
    const statusResult = await getModelStatusCommand({ agentId: 'main' })
    if (statusResult.ok) {
      const resolvedFromStatus = extractAuthStorePathFromModelStatus(statusResult.stdout)
      if (resolvedFromStatus) return resolvedFromStatus
    }
  } catch {
    // Fall back to runtime paths below.
  }

  const runtimePaths = await resolveRuntimePaths()
  return buildFallbackAuthStorePath(runtimePaths.homeDir)
}

export async function upsertApiKeyAuthProfile(
  input: UpsertApiKeyAuthProfileInput,
  options: LocalAuthProfileStoreOptions = {}
): Promise<UpsertApiKeyAuthProfileResult> {
  const provider = normalizeProviderId(input.provider)
  const apiKey = String(input.apiKey || '').trim()
  const profileId = String(input.profileId || '').trim() || `${provider}:default`
  const readFileFn = options.readFileFn ?? readFile
  const writeJsonFn = options.writeJsonFn ?? atomicWriteJson

  if (!provider) {
    return {
      ok: false,
      created: false,
      updated: false,
      profileId,
      authStorePath: input.authStorePath || options.authStorePath,
      error: 'AI 提供商不能为空',
    }
  }

  if (!apiKey) {
    return {
      ok: false,
      created: false,
      updated: false,
      profileId,
      authStorePath: input.authStorePath || options.authStorePath,
      error: 'API key is required',
    }
  }

  try {
    const authProfilesPath =
      input.authStorePath ||
      options.authStorePath ||
      (await resolveMainAuthStorePath({
        getModelStatusCommand: options.getModelStatusCommand,
        resolveRuntimePaths: options.resolveRuntimePaths,
      }))

    let data: {
      version: number
      profiles: Record<string, any>
      usageStats?: Record<string, any>
      lastGood?: Record<string, any>
    }
    try {
      const raw = await readFileFn(authProfilesPath, 'utf-8')
      data = JSON.parse(raw)
    } catch {
      data = { version: 1, profiles: {} }
    }

    const nextProfile = {
      type: 'api_key',
      provider,
      key: apiKey,
    }
    const existingProfile = data.profiles[profileId]
    const created = !existingProfile
    const updated = !created && JSON.stringify(existingProfile) !== JSON.stringify(nextProfile)

    if (!created && !updated) {
      return {
        ok: true,
        created: false,
        updated: false,
        profileId,
        authStorePath: authProfilesPath,
      }
    }

    data.profiles[profileId] = nextProfile

    await writeJsonFn(authProfilesPath, data, {
      description: '模型 API Key 认证配置',
    })
    return {
      ok: true,
      created,
      updated,
      profileId,
      authStorePath: authProfilesPath,
    }
  } catch (err: any) {
    return {
      ok: false,
      created: false,
      updated: false,
      profileId,
      authStorePath: input.authStorePath || options.authStorePath,
      error: err?.message || 'Failed to write API key auth profile',
    }
  }
}

export async function repairMainAuthProfilesFromOtherAgentStores(
  input: RepairMainAuthProfilesFromOtherAgentStoresInput,
  options: LocalAuthProfileStoreOptions = {}
): Promise<RepairMainAuthProfilesFromOtherAgentStoresResult> {
  const providerSet = buildExactProviderSet(input.providerIds || [])
  if (providerSet.size === 0) {
    return {
      ok: true,
      repaired: false,
      authStorePath: options.authStorePath,
      importedProfileIds: [],
      importedProviders: [],
      sourceAuthStorePaths: [],
    }
  }

  const readFileFn = options.readFileFn ?? readFile
  const writeJsonFn = options.writeJsonFn ?? atomicWriteJson

  try {
    const mainAuthStorePath =
      options.authStorePath ||
      (await resolveMainAuthStorePath({
        getModelStatusCommand: options.getModelStatusCommand,
        resolveRuntimePaths: options.resolveRuntimePaths,
      }))

    const sourceAuthStorePaths = Array.from(
      new Set(
        (
          input.sourceAuthStorePaths && input.sourceAuthStorePaths.length > 0
            ? input.sourceAuthStorePaths
            : await (async () => {
                const runtimePaths = await (options.resolveRuntimePaths ?? defaultResolveRuntimePaths)()
                const agentsRoot = joinPathLike(runtimePaths.homeDir, 'agents')
                const entries = await readdir(agentsRoot, { withFileTypes: true })
                return entries
                  .filter((entry) => entry.isDirectory())
                  .map((entry) => joinPathLike(agentsRoot, entry.name, 'agent', 'auth-profiles.json'))
              })()
        )
          .map((value) => String(value || '').trim())
          .filter(Boolean)
      )
    )

    let mainData: {
      version: number
      profiles: Record<string, any>
      usageStats?: Record<string, any>
      lastGood?: Record<string, any>
    }
    try {
      const raw = await readFileFn(mainAuthStorePath, 'utf-8')
      mainData = JSON.parse(raw)
    } catch {
      mainData = { version: 1, profiles: {}, lastGood: {}, usageStats: {} }
    }

    if (!mainData.profiles || typeof mainData.profiles !== 'object') {
      mainData.profiles = {}
    }

    const importedProfileIds: string[] = []
    const importedProviders = new Set<string>()
    const usedSourceAuthStorePaths = new Set<string>()
    const mainLastGood =
      mainData.lastGood && typeof mainData.lastGood === 'object' && !Array.isArray(mainData.lastGood)
        ? { ...mainData.lastGood }
        : {}

    for (const authStorePath of sourceAuthStorePaths) {
      if (!authStorePath || authStorePath === mainAuthStorePath) continue

      let sourceData: { profiles?: Record<string, any>; lastGood?: Record<string, any> } | null = null
      try {
        const raw = await readFileFn(authStorePath, 'utf-8')
        sourceData = JSON.parse(raw)
      } catch {
        sourceData = null
      }
      if (!sourceData?.profiles || typeof sourceData.profiles !== 'object') continue

      let storeContributed = false
      for (const [profileId, profile] of Object.entries(sourceData.profiles)) {
        if (!profileMatchesExactProvider(providerSet, profileId, profile)) continue
        if (mainData.profiles[profileId]) continue
        mainData.profiles[profileId] = profile
        importedProfileIds.push(profileId)
        importedProviders.add(normalizeProviderId(profile?.provider ?? String(profileId).split(':')[0]))
        storeContributed = true
      }

      if (sourceData.lastGood && typeof sourceData.lastGood === 'object' && !Array.isArray(sourceData.lastGood)) {
        for (const [providerId, profileId] of Object.entries(sourceData.lastGood)) {
          const normalizedProviderId = normalizeProviderId(providerId)
          if (!providerSet.has(normalizedProviderId)) continue
          if (mainLastGood[providerId]) continue
          const normalizedProfileId = String(profileId || '').trim()
          if (!normalizedProfileId || !mainData.profiles[normalizedProfileId]) continue
          mainLastGood[providerId] = normalizedProfileId
          storeContributed = true
        }
      }

      if (storeContributed) {
        usedSourceAuthStorePaths.add(authStorePath)
      }
    }

    if (importedProfileIds.length === 0) {
      return {
        ok: true,
        repaired: false,
        authStorePath: mainAuthStorePath,
        importedProfileIds: [],
        importedProviders: [],
        sourceAuthStorePaths: [],
      }
    }

    mainData.lastGood = mainLastGood

    await writeJsonFn(mainAuthStorePath, mainData, {
      description: '主会话认证配置迁正',
    })

    return {
      ok: true,
      repaired: true,
      authStorePath: mainAuthStorePath,
      importedProfileIds,
      importedProviders: Array.from(importedProviders),
      sourceAuthStorePaths: Array.from(usedSourceAuthStorePaths),
    }
  } catch (err: any) {
    return {
      ok: false,
      repaired: false,
      authStorePath: options.authStorePath,
      importedProfileIds: [],
      importedProviders: [],
      sourceAuthStorePaths: [],
      error: err?.message || 'Failed to repair main auth profiles',
    }
  }
}

export async function repairAgentAuthProfilesFromOtherAgentStores(
  input: RepairAgentAuthProfilesFromOtherAgentStoresInput,
  options: LocalAuthProfileStoreOptions = {}
): Promise<RepairAgentAuthProfilesFromOtherAgentStoresResult> {
  const providerSet = buildScopedAgentRepairProviderSet(input.providerIds || [])
  if (providerSet.size === 0) {
    return {
      ok: true,
      repaired: false,
      updatedAuthStorePaths: [],
      importedProfileIds: [],
      importedProviders: [],
      sourceAuthStorePaths: [],
    }
  }

  const readFileFn = options.readFileFn ?? readFile
  const writeJsonFn = options.writeJsonFn ?? atomicWriteJson
  const resolveRuntimePaths = options.resolveRuntimePaths ?? defaultResolveRuntimePaths

  try {
    const runtimePaths = await resolveRuntimePaths()
    const discoveredAuthStorePaths = await listDiscoveredAgentAuthStorePaths(async () => runtimePaths)
    const pathStyleHint =
      input.sourceAuthStorePaths?.find((value) => String(value || '').trim()) ||
      discoveredAuthStorePaths.find((value) => String(value || '').trim()) ||
      runtimePaths.homeDir
    const targetAuthStorePaths = Array.from(
      new Set(
        (
          input.targetAgentIds && input.targetAgentIds.length > 0
            ? input.targetAgentIds.map((agentId) => buildAgentAuthStorePath(runtimePaths.homeDir, agentId, pathStyleHint))
            : discoveredAuthStorePaths
        )
          .map((value) => String(value || '').trim())
          .filter(Boolean)
      )
    )
    const sourceAuthStorePaths = Array.from(
      new Set(
        (
          input.sourceAuthStorePaths && input.sourceAuthStorePaths.length > 0
            ? input.sourceAuthStorePaths
            : [...discoveredAuthStorePaths, buildFallbackAuthStorePath(runtimePaths.homeDir, pathStyleHint)]
        )
          .map((value) => String(value || '').trim())
          .filter(Boolean)
      )
    )

    const importedProfileIds = new Set<string>()
    const importedProviders = new Set<string>()
    const updatedAuthStorePaths = new Set<string>()
    const usedSourceAuthStorePaths = new Set<string>()

    for (const targetAuthStorePath of targetAuthStorePaths) {
      if (!targetAuthStorePath) continue

      const targetData = await readAuthProfilesData(targetAuthStorePath, readFileFn)
      const targetLastGood =
        targetData.lastGood && typeof targetData.lastGood === 'object' && !Array.isArray(targetData.lastGood)
          ? { ...targetData.lastGood }
          : {}
      let targetChanged = false

      for (const sourceAuthStorePath of sourceAuthStorePaths) {
        if (!sourceAuthStorePath || sourceAuthStorePath === targetAuthStorePath) continue

        let sourceData: { profiles?: Record<string, any>; lastGood?: Record<string, any> } | null = null
        try {
          const raw = await readFileFn(sourceAuthStorePath, 'utf-8')
          sourceData = JSON.parse(raw)
        } catch {
          sourceData = null
        }
        if (!sourceData?.profiles || typeof sourceData.profiles !== 'object') continue

        let sourceContributed = false
        for (const [profileId, profile] of Object.entries(sourceData.profiles)) {
          if (!profileMatchesExactProvider(providerSet, profileId, profile)) continue
          if (targetData.profiles[profileId]) continue
          targetData.profiles[profileId] = profile
          importedProfileIds.add(profileId)
          importedProviders.add(normalizeProviderId(profile?.provider ?? String(profileId).split(':')[0]))
          targetChanged = true
          sourceContributed = true
        }

        if (sourceData.lastGood && typeof sourceData.lastGood === 'object' && !Array.isArray(sourceData.lastGood)) {
          for (const [providerId, profileId] of Object.entries(sourceData.lastGood)) {
            if (!lastGoodEntryMatchesExactProvider(providerSet, providerId, profileId)) continue
            if (targetLastGood[providerId]) continue
            const normalizedProfileId = String(profileId || '').trim()
            if (!normalizedProfileId || !targetData.profiles[normalizedProfileId]) continue
            targetLastGood[providerId] = normalizedProfileId
            targetChanged = true
            sourceContributed = true
          }
        }

        if (sourceContributed) {
          usedSourceAuthStorePaths.add(sourceAuthStorePath)
        }
      }

      if (!targetChanged) continue

      targetData.lastGood = targetLastGood
      await writeJsonFn(targetAuthStorePath, targetData, {
        description: 'Agent 认证配置迁正',
      })
      updatedAuthStorePaths.add(targetAuthStorePath)
    }

    return {
      ok: true,
      repaired: updatedAuthStorePaths.size > 0,
      updatedAuthStorePaths: Array.from(updatedAuthStorePaths),
      importedProfileIds: Array.from(importedProfileIds),
      importedProviders: Array.from(importedProviders),
      sourceAuthStorePaths: Array.from(usedSourceAuthStorePaths),
    }
  } catch (err: any) {
    return {
      ok: false,
      repaired: false,
      updatedAuthStorePaths: [],
      importedProfileIds: [],
      importedProviders: [],
      sourceAuthStorePaths: [],
      error: err?.message || 'Failed to repair agent auth profiles',
    }
  }
}

/**
 * Ensure the provider has an auth profile in auth-profiles.json.
 * Local providers like Ollama don't need a real API key, but the
 * Gateway auth system requires a profile entry to exist.
 */
export async function ensureLocalAuthProfile(
  input: EnsureLocalAuthProfileInput,
  options: LocalAuthProfileStoreOptions = {}
): Promise<EnsureLocalAuthProfileResult> {
  const { provider, apiKey } = input
  const profileId = `${provider}:local`
  const readFileFn = options.readFileFn ?? readFile
  const writeJsonFn = options.writeJsonFn ?? atomicWriteJson

  try {
    const authProfilesPath =
      options.authStorePath ||
      (await resolveLocalAuthStorePath({
        getModelStatusCommand: options.getModelStatusCommand,
        resolveRuntimePaths: options.resolveRuntimePaths,
      }))

    let data: { version: number; profiles: Record<string, any>; usageStats?: Record<string, any>; lastGood?: Record<string, any> }
    try {
      const raw = await readFileFn(authProfilesPath, 'utf-8')
      data = JSON.parse(raw)
    } catch {
      data = { version: 1, profiles: {} }
    }

    if (data.profiles[profileId]) {
      return { ok: true, created: false, profileId }
    }

    data.profiles[profileId] = {
      type: 'api_key',
      provider,
      key: String(apiKey || '').trim() || LOCAL_PROVIDER_AUTH_MARKERS[provider],
    }

    await writeJsonFn(authProfilesPath, data, {
      description: '本地模型认证配置',
    })
    return { ok: true, created: true, profileId }
  } catch (err: any) {
    return { ok: false, created: false, profileId, error: err?.message || 'Failed to write auth profile' }
  }
}

export async function clearModelAuthProfilesByProvider(
  input: ClearModelAuthProfilesInput,
  options: LocalAuthProfileStoreOptions = {}
): Promise<ClearModelAuthProfilesResult> {
  const providerSet = buildProviderSet(input?.providerIds || [])
  if (providerSet.size === 0) {
    return { ok: true, removed: 0, removedProfileIds: [] }
  }

  const readFileFn = options.readFileFn ?? readFile
  const writeJsonFn = options.writeJsonFn ?? atomicWriteJson

  try {
    const authProfilesPath =
      input.authStorePath ||
      options.authStorePath ||
      (await resolveLocalAuthStorePath({
        getModelStatusCommand: options.getModelStatusCommand,
        resolveRuntimePaths: options.resolveRuntimePaths,
      }))

    let data: { version: number; profiles: Record<string, any>; usageStats?: Record<string, any>; lastGood?: Record<string, any> }
    try {
      const raw = await readFileFn(authProfilesPath, 'utf-8')
      data = JSON.parse(raw)
    } catch {
      return { ok: true, removed: 0, removedProfileIds: [], authStorePath: authProfilesPath, clearedLastGoodKeys: [] }
    }

    if (!data || typeof data !== 'object' || !data.profiles || typeof data.profiles !== 'object') {
      return { ok: true, removed: 0, removedProfileIds: [], authStorePath: authProfilesPath, clearedLastGoodKeys: [] }
    }

    const clearedLastGoodKeys: string[] = []
    if (data.lastGood && typeof data.lastGood === 'object' && !Array.isArray(data.lastGood)) {
      for (const key of Object.keys(data.lastGood)) {
        if (providerSet.has(canonicalizeProviderId(key))) {
          delete data.lastGood[key]
          clearedLastGoodKeys.push(key)
        }
      }
    }

    const removedProfileIds: string[] = []
    for (const [profileId, profile] of Object.entries(data.profiles)) {
      if (profileMatchesProvider(providerSet, profileId, profile)) {
        delete data.profiles[profileId]
        removedProfileIds.push(profileId)
      }
    }

    if (removedProfileIds.length === 0 && clearedLastGoodKeys.length === 0) {
      return { ok: true, removed: 0, removedProfileIds: [], authStorePath: authProfilesPath, clearedLastGoodKeys: [] }
    }

    if (data.usageStats && typeof data.usageStats === 'object') {
      for (const profileId of removedProfileIds) {
        delete data.usageStats[profileId]
      }
    }

    await writeJsonFn(authProfilesPath, data, {
      description: '本地模型认证配置',
    })
    return {
      ok: true,
      removed: removedProfileIds.length,
      removedProfileIds,
      authStorePath: authProfilesPath,
      clearedLastGoodKeys,
    }
  } catch (err: any) {
    return {
      ok: false,
      removed: 0,
      removedProfileIds: [],
      authStorePath: input.authStorePath || options.authStorePath,
      clearedLastGoodKeys: [],
      error: err?.message || 'Failed to clear auth profiles',
    }
  }
}

export async function inspectModelAuthProfilesByProvider(
  input: InspectModelAuthProfilesInput,
  options: LocalAuthProfileStoreOptions = {}
): Promise<InspectModelAuthProfilesResult> {
  const providerSet = buildProviderSet(input?.providerIds || [])
  if (providerSet.size === 0) {
    return {
      ok: true,
      present: false,
      matchedProfileIds: [],
      matchedLastGoodKeys: [],
      authStorePath: input.authStorePath || options.authStorePath,
    }
  }

  const readFileFn = options.readFileFn ?? readFile

  try {
    const authProfilesPath =
      input.authStorePath ||
      options.authStorePath ||
      (await resolveLocalAuthStorePath({
        getModelStatusCommand: options.getModelStatusCommand,
        resolveRuntimePaths: options.resolveRuntimePaths,
      }))

    let data: { profiles?: Record<string, any>; lastGood?: Record<string, any> }
    try {
      const raw = await readFileFn(authProfilesPath, 'utf-8')
      data = JSON.parse(raw)
    } catch {
      return {
        ok: true,
        present: false,
        matchedProfileIds: [],
        matchedLastGoodKeys: [],
        authStorePath: authProfilesPath,
      }
    }

    const profiles = data?.profiles && typeof data.profiles === 'object' && !Array.isArray(data.profiles)
      ? data.profiles
      : {}
    const lastGood = data?.lastGood && typeof data.lastGood === 'object' && !Array.isArray(data.lastGood)
      ? data.lastGood
      : {}

    const matchedProfileIds = Object.entries(profiles)
      .filter(([profileId, profile]) => profileMatchesProvider(providerSet, profileId, profile))
      .map(([profileId]) => profileId)

    const matchedLastGoodKeys = Object.entries(lastGood)
      .filter(([key, value]) => lastGoodEntryMatchesProvider(providerSet, key, value))
      .map(([key]) => key)

    return {
      ok: true,
      present: matchedProfileIds.length > 0 || matchedLastGoodKeys.length > 0,
      matchedProfileIds,
      matchedLastGoodKeys,
      authStorePath: authProfilesPath,
    }
  } catch (err: any) {
    return {
      ok: false,
      present: false,
      matchedProfileIds: [],
      matchedLastGoodKeys: [],
      authStorePath: input.authStorePath || options.authStorePath,
      error: err?.message || 'Failed to inspect auth profiles',
    }
  }
}

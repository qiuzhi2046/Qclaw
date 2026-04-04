import { pollWithBackoff } from './polling'
import { UI_RUNTIME_DEFAULTS, type BackoffPollingPolicy } from './runtime-policies'
import type { OpenClawGuardedWriteReason } from './openclaw-phase2'
import { getUpstreamModelStatusLike, type RendererUpstreamModelStateResult } from './upstream-model-state'
import { applyFeishuMultiBotIsolation, isFeishuManagedAgentId } from '../lib/feishu-multi-bot-routing'
import { canonicalizeModelProviderId, getModelProviderAliasCandidates } from '../lib/model-provider-aliases'
import {
  areRuntimeModelsEquivalent,
  resolveRuntimeActiveModelKey,
} from '../lib/model-runtime-resolution'

interface CliLikeResult {
  ok: boolean
  stdout?: string
  stderr?: string
  code?: number | null
  message?: string
  running?: boolean
  summary?: string
}

interface ConfigPatchLikeResult {
  ok: boolean
  blocked?: boolean
  wrote?: boolean
  message?: string
}

interface UpstreamModelWriteLikeResult {
  ok: boolean
  wrote?: boolean
  gatewayReloaded?: boolean
  source?: string
  fallbackUsed?: boolean
  fallbackReason?: string
  message?: string
}

interface ModelStatusLikeResult extends CliLikeResult {
  data?: Record<string, any>
}

export interface ApplyDefaultModelWithGatewayReloadResult {
  ok: boolean
  modelApplied: boolean
  gatewayReloaded: boolean
  message?: string
  writeSource?: string
  upstreamFallbackReason?: string
}

export interface ApplyAgentPrimaryModelWithGatewayReloadResult {
  ok: boolean
  modelApplied: boolean
  gatewayReloaded: boolean
  message?: string
  writeSource?: string
  upstreamFallbackReason?: string
}

function describeCliFailure(result: CliLikeResult | ConfigPatchLikeResult | null | undefined, fallback: string): string {
  const explicit = String(result?.message || '').trim()
  if (explicit) return explicit

  const stderr = 'stderr' in (result || {}) ? String((result as CliLikeResult)?.stderr || '').trim() : ''
  if (stderr) return stderr

  const stdout = 'stdout' in (result || {}) ? String((result as CliLikeResult)?.stdout || '').trim() : ''
  if (stdout) return stdout

  return fallback
}

function cloneConfig(config: Record<string, any> | null | undefined): Record<string, any> {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return {}
  return JSON.parse(JSON.stringify(config)) as Record<string, any>
}

function ensureObject(parent: Record<string, any>, key: string): Record<string, any> {
  const current = parent[key]
  if (current && typeof current === 'object' && !Array.isArray(current)) {
    return current as Record<string, any>
  }
  parent[key] = {}
  return parent[key] as Record<string, any>
}

export function extractConfiguredDefaultModel(config: Record<string, any> | null | undefined): string {
  return String(config?.agents?.defaults?.model?.primary ?? config?.defaultModel ?? config?.model ?? '').trim()
}

function normalizeModelValue(value: unknown): string {
  return String(value ?? '').trim()
}

function normalizeProviderId(value: unknown): string {
  return canonicalizeModelProviderId(value).trim().toLowerCase()
}

function normalizeAgentId(value: unknown): string {
  return String(value ?? '').trim().toLowerCase()
}

function isConfiguredAuthProviderEntry(entry: any): boolean {
  const status = String(entry?.status || '').trim().toLowerCase()
  if (status && !['missing', 'none', 'error', 'disabled', 'unconfigured'].includes(status)) return true
  if (entry?.authenticated === true) return true
  if (entry?.effective || entry?.modelsJson || entry?.env) return true
  if ((entry?.profiles?.count || 0) > 0) return true
  return false
}

function collectConfiguredProviderIds(statusData: Record<string, any> | null | undefined): Set<string> {
  const authProviders = Array.isArray(statusData?.auth?.providers) ? statusData.auth.providers : []
  const oauthProviders = Array.isArray(statusData?.auth?.oauth?.providers) ? statusData.auth.oauth.providers : []
  const configuredProviderIds = new Set<string>()

  for (const entry of [...authProviders, ...oauthProviders]) {
    const providerId = String(entry?.provider ?? entry?.providerId ?? '').trim()
    if (!providerId || !isConfiguredAuthProviderEntry(entry)) continue
    for (const alias of getModelProviderAliasCandidates(providerId)) {
      configuredProviderIds.add(normalizeProviderId(alias))
    }
  }

  return configuredProviderIds
}

function ensureAgentList(config: Record<string, any>): Record<string, any>[] {
  const agents = ensureObject(config, 'agents')
  if (!Array.isArray(agents.list)) {
    agents.list = []
  }
  return agents.list as Record<string, any>[]
}

function stripLegacyTopLevelDefaultModel(config: Record<string, any>): void {
  if (Object.prototype.hasOwnProperty.call(config, 'defaultModel')) {
    delete config.defaultModel
  }
}

function ensureMainDefaultAgent(config: Record<string, any>): void {
  const agents = config.agents
  const agentList = Array.isArray(agents?.list) ? (agents.list as Record<string, any>[]) : []
  const mainIndex = agentList.findIndex((agent) => normalizeAgentId(agent?.id) === 'main')
  if (mainIndex < 0) return

  for (let index = 0; index < agentList.length; index += 1) {
    const current = agentList[index]
    if (!current || typeof current !== 'object' || Array.isArray(current)) continue
    const nextAgent = { ...current }
    if (index === mainIndex) {
      nextAgent.default = true
    } else {
      delete nextAgent.default
    }
    agentList[index] = nextAgent
  }
}

export function extractPrimaryModelFromModelStatusPayload(
  data: Record<string, any> | null | undefined
): string {
  return normalizeModelValue(data?.defaultModel ?? data?.model ?? data?.agent?.model)
}

function extractStatusDefaultModel(status: ModelStatusLikeResult | null | undefined): string {
  return extractPrimaryModelFromModelStatusPayload(status?.data)
}

function extractStatusPayload(status: ModelStatusLikeResult | null | undefined): Record<string, any> | null | undefined {
  return status?.data || null
}

function extractDefaultModelConfirmationStatus(params: {
  targetModel: string
  cliStatus: ModelStatusLikeResult | null | undefined
  upstreamState?: RendererUpstreamModelStateResult | null
}): string {
  const upstreamStatus = params.upstreamState ? getUpstreamModelStatusLike(params.upstreamState) : null
  if (upstreamStatus) {
    return resolveRuntimeActiveModelKey(params.targetModel, upstreamStatus)
      || extractPrimaryModelFromModelStatusPayload(upstreamStatus)
  }

  return resolveRuntimeActiveModelKey(params.targetModel, extractStatusPayload(params.cliStatus))
    || extractStatusDefaultModel(params.cliStatus)
}

function isRuntimeModelConfirmed(actualModel: unknown, expectedModel: string): boolean {
  return areRuntimeModelsEquivalent(actualModel, expectedModel)
}

function buildLocalWriteMeta(upstreamWriteResult: UpstreamModelWriteLikeResult | null): {
  writeSource?: string
  upstreamFallbackReason?: string
} {
  if (!upstreamWriteResult) return {}
  return {
    writeSource: 'local-config-patch',
    upstreamFallbackReason: upstreamWriteResult.fallbackReason,
  }
}

function extractConfiguredAgentModel(
  config: Record<string, any> | null | undefined,
  agentId: string
): string {
  const normalizedAgentId = String(agentId || '').trim()
  if (!normalizedAgentId) return ''

  const agents = Array.isArray(config?.agents?.list) ? (config?.agents?.list as Record<string, any>[]) : []
  const matchedAgent = agents.find((agent) => String(agent?.id || '').trim() === normalizedAgentId)
  return normalizeModelValue(matchedAgent?.model)
}

export function buildNextConfigWithDefaultModel(currentConfig: Record<string, any> | null | undefined, model: string): Record<string, any> {
  const nextConfig = cloneConfig(currentConfig)
  stripLegacyTopLevelDefaultModel(nextConfig)
  const agents = ensureObject(nextConfig, 'agents')
  const defaults = ensureObject(agents, 'defaults')
  const modelConfig = ensureObject(defaults, 'model')
  modelConfig.primary = model
  ensureMainDefaultAgent(nextConfig)

  return nextConfig
}

export function buildNextConfigWithAgentPrimaryModel(
  currentConfig: Record<string, any> | null | undefined,
  agentId: string,
  model: string
): Record<string, any> {
  const normalizedAgentId = String(agentId || '').trim()
  let nextConfig = cloneConfig(currentConfig)
  stripLegacyTopLevelDefaultModel(nextConfig)

  if (isFeishuManagedAgentId(normalizedAgentId)) {
    nextConfig = applyFeishuMultiBotIsolation(nextConfig)
    stripLegacyTopLevelDefaultModel(nextConfig)
  }

  const agentList = ensureAgentList(nextConfig)
  const existingIndex = agentList.findIndex((agent) => String(agent?.id || '').trim() === normalizedAgentId)

  if (existingIndex >= 0) {
    const existingAgent = agentList[existingIndex] || {}
    agentList[existingIndex] = {
      ...existingAgent,
      id: normalizedAgentId,
      model,
    }
    ensureMainDefaultAgent(nextConfig)
    return nextConfig
  }

  if (isFeishuManagedAgentId(normalizedAgentId)) {
    throw new Error(`未找到飞书托管 Agent：${normalizedAgentId}`)
  }

  agentList.push({
    id: normalizedAgentId,
    model,
  })
  ensureMainDefaultAgent(nextConfig)

  return nextConfig
}

async function waitForDefaultModelConfirmation(params: {
  model: string
  readConfig: () => Promise<Record<string, any> | null>
  readUpstreamState?: () => Promise<RendererUpstreamModelStateResult>
  getModelStatus: () => Promise<ModelStatusLikeResult>
  confirmationPolicy?: BackoffPollingPolicy
}): Promise<{
  ok: boolean
  configMatched: boolean
  statusMatched: boolean
  lastConfig: Record<string, any> | null
  lastStatus: ModelStatusLikeResult | null
}> {
  let lastConfig: Record<string, any> | null = null
  let lastStatus: ModelStatusLikeResult | null = null
  let lastUpstreamState: RendererUpstreamModelStateResult | null = null

  const result = await pollWithBackoff({
    policy: params.confirmationPolicy || UI_RUNTIME_DEFAULTS.authVerification.poll,
    execute: async () => {
      const [configResult, upstreamResult, statusResult] = await Promise.allSettled([
        params.readConfig(),
        params.readUpstreamState ? params.readUpstreamState() : Promise.resolve(null),
        params.getModelStatus(),
      ])

      lastConfig = configResult.status === 'fulfilled' ? configResult.value : null
      lastUpstreamState = upstreamResult.status === 'fulfilled' ? upstreamResult.value : null
      lastStatus = statusResult.status === 'fulfilled' ? statusResult.value : null

      return {
        configModel: extractConfiguredDefaultModel(lastConfig),
        statusModel: extractDefaultModelConfirmationStatus({
          targetModel: params.model,
          cliStatus: lastStatus,
          upstreamState: lastUpstreamState,
        }),
      }
    },
    isSuccess: (value) =>
      isRuntimeModelConfirmed(value.configModel, params.model)
      && isRuntimeModelConfirmed(value.statusModel, params.model),
  })

  return {
    ok: result.ok,
    configMatched: isRuntimeModelConfirmed(extractConfiguredDefaultModel(lastConfig), params.model),
    statusMatched: isRuntimeModelConfirmed(
      extractDefaultModelConfirmationStatus({
        targetModel: params.model,
        cliStatus: lastStatus,
        upstreamState: lastUpstreamState,
      }),
      params.model
    ),
    lastConfig,
    lastStatus,
  }
}

async function waitForAgentModelConfirmation(params: {
  agentId: string
  model: string
  readConfig: () => Promise<Record<string, any> | null>
  getModelStatus: () => Promise<ModelStatusLikeResult>
  confirmationPolicy?: BackoffPollingPolicy
}): Promise<{
  ok: boolean
  configMatched: boolean
  statusMatched: boolean
  lastConfig: Record<string, any> | null
  lastStatus: ModelStatusLikeResult | null
}> {
  let lastConfig: Record<string, any> | null = null
  let lastStatus: ModelStatusLikeResult | null = null

  const result = await pollWithBackoff({
    policy: params.confirmationPolicy || UI_RUNTIME_DEFAULTS.authVerification.poll,
    execute: async () => {
      const [configResult, statusResult] = await Promise.allSettled([
        params.readConfig(),
        params.getModelStatus(),
      ])

      lastConfig = configResult.status === 'fulfilled' ? configResult.value : null
      lastStatus = statusResult.status === 'fulfilled' ? statusResult.value : null

      return {
        configModel: extractConfiguredAgentModel(lastConfig, params.agentId),
        statusModel: resolveRuntimeActiveModelKey(params.model, lastStatus?.data) || extractStatusDefaultModel(lastStatus),
      }
    },
    isSuccess: (value) =>
      isRuntimeModelConfirmed(value.configModel, params.model)
      && isRuntimeModelConfirmed(value.statusModel, params.model),
  })

  return {
    ok: result.ok,
    configMatched: isRuntimeModelConfirmed(extractConfiguredAgentModel(lastConfig, params.agentId), params.model),
    statusMatched: isRuntimeModelConfirmed(
      resolveRuntimeActiveModelKey(params.model, extractStatusPayload(lastStatus)) || extractStatusDefaultModel(lastStatus),
      params.model
    ),
    lastConfig,
    lastStatus,
  }
}

export async function applyDefaultModelWithGatewayReload(params: {
  model: string
  readConfig: () => Promise<Record<string, any> | null>
  readUpstreamState?: () => Promise<RendererUpstreamModelStateResult>
  applyUpstreamModelWrite?: (request: {
    kind: 'default'
    model: string
  }) => Promise<UpstreamModelWriteLikeResult | null>
  applyConfigPatchGuarded: (request: {
    beforeConfig: Record<string, any> | null
    afterConfig: Record<string, any>
    reason?: OpenClawGuardedWriteReason
  }) => Promise<ConfigPatchLikeResult>
  getModelStatus: () => Promise<ModelStatusLikeResult>
  reloadGatewayAfterModelChange: () => Promise<CliLikeResult>
  confirmationPolicy?: BackoffPollingPolicy
}): Promise<ApplyDefaultModelWithGatewayReloadResult> {
  const model = String(params.model || '').trim()
  if (!model) {
    return {
      ok: false,
      modelApplied: false,
      gatewayReloaded: false,
      message: '默认模型不能为空',
    }
  }

  let initialStatus: ModelStatusLikeResult | null = null
  try {
    initialStatus = await params.getModelStatus()
  } catch {
    initialStatus = null
  }

  let currentConfig: Record<string, any> | null = null
  try {
    currentConfig = await params.readConfig()
  } catch {
    currentConfig = null
  }

  let upstreamWriteResult: UpstreamModelWriteLikeResult | null = null
  if (params.applyUpstreamModelWrite) {
    upstreamWriteResult = await params.applyUpstreamModelWrite({
      kind: 'default',
      model,
    }).catch(() => null)
  }

  if (upstreamWriteResult?.ok) {
    const confirmation = await waitForDefaultModelConfirmation({
      model,
      readConfig: params.readConfig,
      readUpstreamState: params.readUpstreamState,
      getModelStatus: params.getModelStatus,
      confirmationPolicy: params.confirmationPolicy,
    })
    if (confirmation.ok) {
      return {
        ok: true,
        modelApplied: true,
        gatewayReloaded: upstreamWriteResult.gatewayReloaded === true,
        writeSource: upstreamWriteResult.source,
      }
    }

    return {
      ok: false,
      modelApplied: true,
      gatewayReloaded: upstreamWriteResult.gatewayReloaded === true,
      writeSource: upstreamWriteResult.source,
      message: '模型已通过 OpenClaw 上游配置写入，但当前仍未确认模型状态刷新完成',
    }
  }

  const nextConfig = buildNextConfigWithDefaultModel(currentConfig, model)
  const localWriteMeta = buildLocalWriteMeta(upstreamWriteResult)
  const writeResult = await params.applyConfigPatchGuarded({
    beforeConfig: currentConfig,
    afterConfig: nextConfig,
    reason: 'unknown',
  })
  if (!writeResult?.ok) {
    return {
      ok: false,
      modelApplied: false,
      gatewayReloaded: false,
      message: describeCliFailure(writeResult, '设置默认模型失败'),
      ...localWriteMeta,
    }
  }

  const confirmation = await waitForDefaultModelConfirmation({
    model,
    readConfig: params.readConfig,
    readUpstreamState: params.readUpstreamState,
    getModelStatus: params.getModelStatus,
    confirmationPolicy: params.confirmationPolicy,
  })
  if (confirmation.ok) {
    return {
      ok: true,
      modelApplied: true,
      gatewayReloaded: false,
      ...localWriteMeta,
    }
  }

  const reloadResult = await params.reloadGatewayAfterModelChange()
  if (!reloadResult?.ok || reloadResult.running !== true) {
    return {
      ok: false,
      modelApplied: true,
      gatewayReloaded: false,
      message: `默认模型已保存，但运行状态尚未确认生效：${describeCliFailure(reloadResult, '网关重载未完成')}`,
      ...localWriteMeta,
    }
  }

  const postReloadConfirmation = await waitForDefaultModelConfirmation({
    model,
    readConfig: params.readConfig,
    readUpstreamState: params.readUpstreamState,
    getModelStatus: params.getModelStatus,
    confirmationPolicy: params.confirmationPolicy,
  })
  if (!postReloadConfirmation.ok) {
    return {
      ok: false,
      modelApplied: true,
      gatewayReloaded: true,
      message: '默认模型已保存，网关已重载，但当前仍未确认模型状态刷新完成',
      ...localWriteMeta,
    }
  }

  return {
    ok: true,
    modelApplied: true,
    gatewayReloaded: true,
    ...localWriteMeta,
  }
}

export async function applyAgentPrimaryModelWithGatewayReload(params: {
  agentId: string
  model: string
  readConfig: () => Promise<Record<string, any> | null>
  applyUpstreamModelWrite?: (request: {
    kind: 'agent-primary'
    agentId: string
    model: string
  }) => Promise<UpstreamModelWriteLikeResult | null>
  applyConfigPatchGuarded: (request: {
    beforeConfig: Record<string, any> | null
    afterConfig: Record<string, any>
    reason?: OpenClawGuardedWriteReason
  }) => Promise<ConfigPatchLikeResult>
  getModelStatus: () => Promise<ModelStatusLikeResult>
  reloadGatewayAfterModelChange: () => Promise<CliLikeResult>
  confirmationPolicy?: BackoffPollingPolicy
}): Promise<ApplyAgentPrimaryModelWithGatewayReloadResult> {
  const agentId = String(params.agentId || '').trim()
  if (!agentId) {
    return {
      ok: false,
      modelApplied: false,
      gatewayReloaded: false,
      message: 'Agent ID 不能为空',
    }
  }

  const model = String(params.model || '').trim()
  if (!model) {
    return {
      ok: false,
      modelApplied: false,
      gatewayReloaded: false,
      message: '机器人模型不能为空',
    }
  }

  let initialStatus: ModelStatusLikeResult | null = null
  try {
    initialStatus = await params.getModelStatus()
  } catch {
    initialStatus = null
  }

  let currentConfig: Record<string, any> | null = null
  try {
    currentConfig = await params.readConfig()
  } catch {
    currentConfig = null
  }

  let upstreamWriteResult: UpstreamModelWriteLikeResult | null = null
  if (params.applyUpstreamModelWrite) {
    upstreamWriteResult = await params.applyUpstreamModelWrite({
      kind: 'agent-primary',
      agentId,
      model,
    }).catch(() => null)
  }

  if (upstreamWriteResult?.ok) {
    const confirmation = await waitForAgentModelConfirmation({
      agentId,
      model,
      readConfig: params.readConfig,
      getModelStatus: params.getModelStatus,
      confirmationPolicy: params.confirmationPolicy,
    })
    if (confirmation.ok) {
      return {
        ok: true,
        modelApplied: true,
        gatewayReloaded: upstreamWriteResult.gatewayReloaded === true,
        writeSource: upstreamWriteResult.source,
      }
    }

    return {
      ok: false,
      modelApplied: true,
      gatewayReloaded: upstreamWriteResult.gatewayReloaded === true,
      writeSource: upstreamWriteResult.source,
      message: '机器人模型已通过 OpenClaw 上游配置写入，但当前仍未确认模型状态刷新完成',
    }
  }

  let nextConfig: Record<string, any>
  const localWriteMeta = buildLocalWriteMeta(upstreamWriteResult)
  try {
    nextConfig = buildNextConfigWithAgentPrimaryModel(currentConfig, agentId, model)
  } catch (error) {
    return {
      ok: false,
      modelApplied: false,
      gatewayReloaded: false,
      message: (error as Error).message || '准备机器人模型配置失败',
      ...localWriteMeta,
    }
  }
  const writeResult = await params.applyConfigPatchGuarded({
    beforeConfig: currentConfig,
    afterConfig: nextConfig,
    reason: 'unknown',
  })
  if (!writeResult?.ok) {
    return {
      ok: false,
      modelApplied: false,
      gatewayReloaded: false,
      message: describeCliFailure(writeResult, '设置机器人模型失败'),
      ...localWriteMeta,
    }
  }

  const confirmation = await waitForAgentModelConfirmation({
    agentId,
    model,
    readConfig: params.readConfig,
    getModelStatus: params.getModelStatus,
    confirmationPolicy: params.confirmationPolicy,
  })
  if (confirmation.ok) {
    return {
      ok: true,
      modelApplied: true,
      gatewayReloaded: false,
      ...localWriteMeta,
    }
  }

  const reloadResult = await params.reloadGatewayAfterModelChange()
  if (!reloadResult?.ok || reloadResult.running !== true) {
    return {
      ok: false,
      modelApplied: true,
      gatewayReloaded: false,
      message: `机器人模型已保存，但运行状态尚未确认生效：${describeCliFailure(reloadResult, '网关重载未完成')}`,
      ...localWriteMeta,
    }
  }

  const postReloadConfirmation = await waitForAgentModelConfirmation({
    agentId,
    model,
    readConfig: params.readConfig,
    getModelStatus: params.getModelStatus,
    confirmationPolicy: params.confirmationPolicy,
  })
  if (!postReloadConfirmation.ok) {
    return {
      ok: false,
      modelApplied: true,
      gatewayReloaded: true,
      message: '机器人模型已保存，网关已重载，但当前仍未确认模型状态刷新完成',
      ...localWriteMeta,
    }
  }

  return {
    ok: true,
    modelApplied: true,
    gatewayReloaded: true,
    ...localWriteMeta,
  }
}

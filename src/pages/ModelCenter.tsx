import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Loader, PasswordInput, Select, Text, TextInput, Title } from '@mantine/core'
import { pollWithBackoff } from '../shared/polling'
import type { BackoffPollingPolicy } from '../shared/runtime-policies'
import { MODEL_CATALOG_LIMITS, UI_RUNTIME_DEFAULTS } from '../shared/runtime-policies'
import { applyDefaultModelWithGatewayReload, extractConfiguredDefaultModel } from '../shared/model-config-gateway'
import { repairLegacyMiniMaxAliasConfigAfterOAuth } from '../shared/minimax-legacy-alias-repair'
import {
  resolveConfiguredCustomProviderIdFromConfig,
  resolveConfiguredCustomProviderMatchFromConfig,
  type CustomProviderConfigMatchResult,
} from '../shared/custom-provider-config-match'
import { getModelProviderAliasCandidates } from '../lib/model-provider-aliases'
import {
  getUpstreamCatalogItemsLike,
  getUpstreamModelStatusLike,
} from '../shared/upstream-model-state'
import { listAllModelCatalogItems } from '../lib/model-catalog-pagination'
import {
  getProviderMetadata,
  getKnownProviderCatalog,
  resolveProviderDisplayName,
} from '../lib/openclaw-provider-registry'
import {
  buildCliFailureClassificationCorpus,
  classifySharedCliFailure,
  type SharedCliFailureCode,
} from '../shared/cli-failure-classification'
import { summarizeModelAuthDiagnosticState } from '../shared/model-auth-diagnostic'
import { toUserFacingCliFailureMessage, toUserFacingUnknownErrorMessage } from '../lib/user-facing-cli-feedback'

const LOCAL_PROVIDER_IDS = new Set(['ollama', 'vllm', 'custom-openai'])
const CUSTOM_PROVIDER_AMBIGUOUS_ERROR_MESSAGE = '检测到多个同 endpoint/model 的自定义提供商，请填写提供商 ID 后重试。'

async function appendModelCenterDiagnosticLog(entry: {
  event: string
  providerId: string
  methodId?: string
  attemptId?: string | number
  details?: Record<string, unknown>
}) {
  await window.api.appendModelAuthDiagnosticLog({
    source: 'renderer:model-center',
    event: entry.event,
    providerId: entry.providerId,
    methodId: entry.methodId,
    attemptId: entry.attemptId,
    details: entry.details,
  }).catch(() => false)
}

async function captureModelCenterDiagnosticSnapshot(input: {
  event: string
  providerId: string
  methodId?: string
  attemptId?: string | number
  details?: Record<string, unknown>
}) {
  const [envVars, configData, statusResult] = await Promise.all([
    window.api.readEnvFile().catch(() => ({})),
    window.api.readConfig().catch(() => null),
    window.api.getModelStatus().catch(() => null),
  ])
  const statusData = statusResult && statusResult.ok ? (statusResult.data as Record<string, any> | null) : null
  return appendModelCenterDiagnosticLog({
    event: input.event,
    providerId: input.providerId,
    methodId: input.methodId,
    attemptId: input.attemptId,
    details: {
      ...(input.details || {}),
      summary: summarizeModelAuthDiagnosticState({
        providerId: input.providerId,
        envVars,
        config: configData,
        statusData,
      }),
    },
  })
}

function isLocalProvider(providerId: string): boolean {
  return LOCAL_PROVIDER_IDS.has(providerId)
}

const LOCAL_PROVIDER_DEFAULTS: Record<string, { baseUrl: string; needsApiKey: boolean }> = {
  ollama: { baseUrl: 'http://127.0.0.1:11434', needsApiKey: false },
  vllm: { baseUrl: 'http://127.0.0.1:8000/v1', needsApiKey: true },
  'custom-openai': { baseUrl: '', needsApiKey: true },
}

export function buildLocalProviderEnvUpdatesForSubmit(params: {
  providerId: string
  baseUrl: string
  apiKey: string
}): Record<string, string | undefined> {
  const providerId = String(params.providerId || '').trim()
  const baseUrl = String(params.baseUrl || '').trim()
  const apiKey = String(params.apiKey || '').trim()

  if (providerId === 'ollama') {
    return {
      OLLAMA_HOST: baseUrl || LOCAL_PROVIDER_DEFAULTS.ollama.baseUrl,
      OLLAMA_API_KEY: apiKey || undefined,
    }
  }

  if (providerId === 'vllm') {
    return {
      VLLM_BASE_URL: baseUrl || LOCAL_PROVIDER_DEFAULTS.vllm.baseUrl,
      VLLM_API_KEY: apiKey || undefined,
    }
  }

  if (providerId === 'custom-openai') {
    return {
      OPENAI_BASE_URL: baseUrl || undefined,
    }
  }

  return {}
}

function cloneConfigValue(config: Record<string, any> | null | undefined): Record<string, any> {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return {}
  }
  return JSON.parse(JSON.stringify(config)) as Record<string, any>
}

function ensureObjectRecord(parent: Record<string, any>, key: string): Record<string, any> {
  const current = parent[key]
  if (current && typeof current === 'object' && !Array.isArray(current)) {
    return current as Record<string, any>
  }
  parent[key] = {}
  return parent[key] as Record<string, any>
}

function stripProviderPrefix(modelKey: string, providerId: string): string {
  const normalizedModelKey = String(modelKey || '').trim()
  const normalizedProviderId = String(providerId || '').trim()
  if (!normalizedModelKey) return ''
  const providerPrefix = `${normalizedProviderId}/`
  if (normalizedProviderId && normalizedModelKey.startsWith(providerPrefix)) {
    return normalizedModelKey.slice(providerPrefix.length).trim()
  }
  if (!normalizedModelKey.includes('/')) return normalizedModelKey
  return normalizedModelKey.split('/').slice(1).join('/').trim()
}

export function buildNextConfigWithLocalProviderSnapshot(params: {
  currentConfig: Record<string, any> | null | undefined
  providerId: string
  baseUrl: string
  selectedModelKey: string
  discoveredModels?: Array<{ key: string; name: string }> | null
}): Record<string, any> {
  const providerId = String(params.providerId || '').trim()
  if (!providerId) {
    return cloneConfigValue(params.currentConfig)
  }

  const nextConfig = cloneConfigValue(params.currentConfig)
  const modelsSection = ensureObjectRecord(nextConfig, 'models')
  const providersSection = ensureObjectRecord(modelsSection, 'providers')
  const currentProviderConfig =
    providersSection[providerId] && typeof providersSection[providerId] === 'object' && !Array.isArray(providersSection[providerId])
      ? { ...(providersSection[providerId] as Record<string, any>) }
      : {}

  const persistedModels = new Map<string, { id: string; name: string }>()
  for (const entry of params.discoveredModels || []) {
    const modelId = stripProviderPrefix(entry?.key, providerId)
    if (!modelId || persistedModels.has(modelId)) continue
    persistedModels.set(modelId, {
      id: modelId,
      name: String(entry?.name || modelId).trim() || modelId,
    })
  }

  const selectedModelId = stripProviderPrefix(params.selectedModelKey, providerId)
  if (selectedModelId && !persistedModels.has(selectedModelId)) {
    persistedModels.set(selectedModelId, {
      id: selectedModelId,
      name: selectedModelId,
    })
  }

  const normalizedBaseUrl = String(params.baseUrl || '').trim()
  providersSection[providerId] = {
    ...currentProviderConfig,
    ...(normalizedBaseUrl ? { baseUrl: normalizedBaseUrl } : {}),
    ...(persistedModels.size > 0 ? { models: Array.from(persistedModels.values()) } : {}),
  }

  return nextConfig
}

interface LocalConnectionTestResult {
  ok: boolean
  reachable: boolean
  modelCount?: number
  error?: string
  latencyMs?: number
}

interface LocalConnectionTestState {
  testing: boolean
  result?: LocalConnectionTestResult
}

interface LocalModelOption {
  key: string
  name: string
}

interface LocalScanResult {
  ok: boolean
  modelCount?: number
  models?: LocalModelOption[]
  error?: string
}

interface LocalDiscoveryDisplay {
  buttonColor: 'brand' | 'teal' | 'red'
  message: string
  messageColor: 'dimmed' | 'teal' | 'red'
}

type ModelCenterPhase = 'loading' | 'ready' | 'authing' | 'verifying' | 'error'
export type AuthMethodType = 'apiKey' | 'oauth' | 'token' | 'custom' | 'unknown'
export type OpenClawAuthRegistrySource =
  | 'openclaw-public-json'
  | 'openclaw-public-export'
  | 'openclaw-internal-registry'
  | 'unsupported-openclaw-layout'
  | 'unknown'

export interface AuthChoiceCapability {
  id: string
  providerId: string
  methodType: AuthMethodType
  source: 'auth-registry' | 'onboard-help' | 'fallback'
}

export interface OpenClawAuthExtraOptionDescriptor {
  id: string
  label: string
  hint?: string
}

export interface OpenClawAuthRouteDescriptor {
  kind:
    | 'models-auth-login'
    | 'models-auth-login-github-copilot'
    | 'models-auth-setup-token'
    | 'models-auth-paste-token'
    | 'onboard'
    | 'onboard-custom'
    | 'unsupported'
  providerId?: string
  methodId?: string
  pluginId?: string
  cliFlag?: string
  requiresSecret?: boolean
  requiresBrowser?: boolean
  extraOptions?: OpenClawAuthExtraOptionDescriptor[]
}

export interface OpenClawAuthMethodDescriptor {
  authChoice: string
  label: string
  hint?: string
  kind: AuthMethodType
  route: OpenClawAuthRouteDescriptor
}

export interface OpenClawAuthProviderDescriptor {
  id: string
  label: string
  hint?: string
  methods: OpenClawAuthMethodDescriptor[]
}

export interface OpenClawAuthRegistry {
  ok: boolean
  source: OpenClawAuthRegistrySource
  providers: OpenClawAuthProviderDescriptor[]
  message?: string
}

export interface OpenClawCapabilities {
  version: string
  discoveredAt: string
  authRegistry: OpenClawAuthRegistry
  authRegistrySource: OpenClawAuthRegistrySource
  authChoices: AuthChoiceCapability[]
  onboardFlags: string[]
  modelsCommands: string[]
  supports: {
    onboard: boolean
    plugins: boolean
    pluginsInstall: boolean
    pluginsEnable: boolean
    chatAgentModelFlag: boolean
    chatGatewaySendModel: boolean
    chatInThreadModelSwitch: boolean
    modelsListAllJson: boolean
    modelsStatusJson: boolean
    modelsAuthLogin: boolean
    modelsAuthAdd: boolean
    modelsAuthPasteToken: boolean
    modelsAuthSetupToken: boolean
    modelsAuthOrder: boolean
    modelsAuthLoginGitHubCopilot: boolean
    aliases: boolean
    fallbacks: boolean
    imageFallbacks: boolean
    modelsScan: boolean
  }
}

export interface MethodOption {
  id: string
  kind: AuthMethodType
  label: string
  hint?: string
  route: OpenClawAuthRouteDescriptor
  supported: boolean
  disabledReason?: string
}

export interface ProviderOption {
  id: string
  name: string
  hint?: string
  methods: MethodOption[]
}

interface ModelCenterProviderDisplayCopy {
  name: string
  hint?: string
}

interface ModelCenterMethodDisplayCopy {
  label: string
  hint?: string
}

export function resolveModelCenterProviderDisplayCopy(params: {
  providerId: string
  fallbackName: string
  fallbackHint?: string
}): ModelCenterProviderDisplayCopy {
  const providerId = String(params.providerId || '').trim()
  if (providerId === 'custom') {
    return {
      name: '手动配置兼容 API',
      hint: '手动填写接口地址、Model ID 和认证信息，适合通用 OpenAI / Anthropic 兼容接口。',
    }
  }

  if (providerId === 'custom-openai') {
    return {
      name: '本地 OpenAI 兼容端点',
      hint: '连接 LM Studio、LocalAI 或其他本地 / 自托管 OpenAI 兼容服务。',
    }
  }

  return {
    name: String(params.fallbackName || '').trim(),
    ...(params.fallbackHint ? { hint: params.fallbackHint } : {}),
  }
}

export function resolveModelCenterMethodDisplayCopy(params: {
  providerId: string
  methodId: string
  fallbackLabel: string
  fallbackHint?: string
}): ModelCenterMethodDisplayCopy {
  const providerId = String(params.providerId || '').trim()
  const methodId = normalizeMethodId(params.methodId)
  if (providerId === 'custom' && methodId === 'custom-api-key') {
    return {
      label: '手动填写接口信息',
      hint: '填写接口地址、Model ID 和认证信息后，按兼容协议写入 OpenClaw。',
    }
  }

  return {
    label: String(params.fallbackLabel || '').trim() || methodId,
    ...(params.fallbackHint ? { hint: params.fallbackHint } : {}),
  }
}

export interface SetupModelContext {
  providerId: string
  methodId: string
  methodType: AuthMethodType
  providerStatusIds: string[]
  needsInitialization: boolean
  preferredModelKey?: string
}

export type CustomProviderCompatibility = 'openai' | 'anthropic'

export interface CustomProviderConfigInput {
  baseUrl: string
  modelId: string
  providerId?: string
  compatibility?: CustomProviderCompatibility
}

interface ModelCenterProps {
  onConfigured: (context: SetupModelContext) => void | Promise<void>
  onCancel?: () => void
  providerNames?: Record<string, string>
  envKeyMap?: Record<string, string>
  submitIdleLabel?: string
  stayOnConfigured?: boolean
  configuredMessage?: string
  collapsible?: boolean
  showSkipWhenConfigured?: boolean
  skipLabel?: string
}

type ModelAuthRequest =
  | {
      kind: 'login'
      providerId: string
      methodId: string
      selectedExtraOption?: string
      secret?: string
      customConfig?: CustomProviderConfigInput
      setDefault?: boolean
    }
  | {
      kind: 'onboard-fallback'
      authChoice: string
      interactive?: boolean
      installDaemon?: boolean
      skipChannels?: boolean
      skipSkills?: boolean
      skipUi?: boolean
      secret?: string
      cliFlag?: string
    }

interface BusyStateInput {
  phase: ModelCenterPhase
  providerId?: string
  method?: MethodOption | null
  elapsedSeconds: number
  canceling: boolean
}

interface BusyStateDisplay {
  title: string
  detail: string
  elapsed: string
}

interface CapabilitiesLoadingDisplay {
  progress: number
  stageLabel: string
  detail: string
}

interface OAuthStateEventPayload {
  providerId: string
  methodId: string
  state: 'preparing' | 'plugin-ready' | 'opening-browser' | 'waiting-for-approval' | 'browser-open-failed'
}

interface OAuthCodeEventPayload {
  providerId: string
  methodId: string
  verificationUri: string
  userCode?: string
  browserOpened: boolean
}

interface OAuthExternalDependencyInstallOption {
  method: 'brew' | 'npm'
  label: string
  commandPreview: string
}

interface OAuthExternalDependencyWarning {
  id: 'google-cloud-project-missing'
  title: string
  message: string
}

interface OAuthExternalDependencyPreflightAction {
  dependencyId: 'gemini-cli'
  title: string
  message: string
  commandName: string
  recommendedMethod?: 'brew' | 'npm'
  installOptions: OAuthExternalDependencyInstallOption[]
}

const DEPRECATED_METHOD_ALIASES: Record<string, string> = {
  'codex-cli': 'openai-codex',
}

function normalizeMethodId(methodId: string): string {
  const normalized = String(methodId || '').trim().toLowerCase()
  return DEPRECATED_METHOD_ALIASES[normalized] || normalized
}

function toDisplayName(providerId: string, providerNames?: Record<string, string>): string {
  if (providerNames?.[providerId]) return providerNames[providerId]
  if (!providerId) return 'Unknown'
  return providerId
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(' ')
}

function buildUnsupportedMethodReason(method: OpenClawAuthMethodDescriptor): string | undefined {
  if (method.route.kind !== 'unsupported') return undefined
  return `Auth method "${normalizeMethodId(method.authChoice)}" is unsupported in this OpenClaw build.`
}

function buildCapabilityMismatchReason(
  method: OpenClawAuthMethodDescriptor,
  capabilities: OpenClawCapabilities | null
): string | undefined {
  if (!capabilities) return undefined

  if ((method.route.kind === 'onboard' || method.route.kind === 'onboard-custom') && !capabilities.supports.onboard) {
    return '当前 OpenClaw 版本不支持 onboard 认证命令，无法使用该认证方式。'
  }

  if (
    method.route.kind === 'onboard' &&
    method.route.cliFlag &&
    !capabilities.onboardFlags.includes(method.route.cliFlag)
  ) {
    return '当前 OpenClaw 版本未暴露该认证所需的命令行参数，Qclaw 无法安全执行该认证方式。'
  }

  if (method.route.kind === 'models-auth-login' && !capabilities.supports.modelsAuthLogin) {
    return '当前 OpenClaw 版本不支持 models auth login，无法使用该认证方式。'
  }

  if (method.route.kind === 'models-auth-login' && method.route.pluginId && !capabilities.supports.pluginsEnable) {
    return '当前 OpenClaw 版本不支持 plugins enable，无法使用该插件浏览器授权登录方式。'
  }

  if (method.route.kind === 'models-auth-login-github-copilot' && !capabilities.supports.modelsAuthLoginGitHubCopilot) {
    return '当前 OpenClaw 版本不支持 GitHub Copilot 登录命令，无法使用该认证方式。'
  }

  if (method.route.kind === 'models-auth-paste-token' && !capabilities.supports.modelsAuthPasteToken) {
    return '当前 OpenClaw 版本不支持 paste-token，无法使用该认证方式。'
  }

  if (method.route.kind === 'models-auth-setup-token' && !capabilities.supports.modelsAuthSetupToken) {
    return '当前 OpenClaw 版本不支持 setup-token，无法使用该认证方式。'
  }

  return undefined
}

function buildMethodDisabledReason(
  method: OpenClawAuthMethodDescriptor,
  capabilities: OpenClawCapabilities | null
): string | undefined {
  return buildUnsupportedMethodReason(method) || buildCapabilityMismatchReason(method, capabilities)
}

export function formatAuthRegistrySourceLabel(source: OpenClawAuthRegistrySource): string {
  if (source === 'openclaw-public-json') return 'OpenClaw 官方注册表（公共 JSON）'
  if (source === 'openclaw-public-export') return 'OpenClaw 官方注册表（稳定导出）'
  if (source === 'openclaw-internal-registry') return 'OpenClaw 官方注册表（内部适配层）'
  if (source === 'unsupported-openclaw-layout') return '当前 OpenClaw 版本元数据布局不受支持'
  return 'OpenClaw 元数据来源未知'
}

export const DEFAULT_PROVIDER_CONFIG_EXPANDED = false

export function getProviderConfigToggleAriaLabel(expanded: boolean): string {
  return expanded ? '收起配置 AI 提供商' : '展开配置 AI 提供商'
}

export function shouldRenderProviderConfigContent(expanded: boolean, collapseEnabled: boolean): boolean {
  return !collapseEnabled || expanded
}

function normalizeModelList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => String(item || '').trim()).filter(Boolean)
}

function normalizeAliases(value: unknown): Array<{ alias: string; model: string }> {
  if (Array.isArray(value)) {
    return value
      .map((item: any) => ({
        alias: String(item?.alias ?? item?.name ?? '').trim(),
        model: String(item?.model ?? item?.target ?? '').trim(),
      }))
      .filter((item) => item.alias && item.model)
  }
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([alias, model]) => ({
        alias: String(alias || '').trim(),
        model: String(model || '').trim(),
      }))
      .filter((item) => item.alias && item.model)
  }
  return []
}

function readLocalScanModelEntries(payload: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(payload)) {
    return payload.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object'))
  }
  if (!payload || typeof payload !== 'object') return []

  const record = payload as Record<string, unknown>
  const candidates = [record.models, record.data, record.items]
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue
    return candidate.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object'))
  }
  return []
}

function normalizeLocalScanModelOptions(
  payload: unknown,
  providerId: string
): LocalModelOption[] {
  const entries = readLocalScanModelEntries(payload)
  const models: Array<{ key: string; name: string }> = []
  const seen = new Set<string>()
  const localProvider = normalizeProviderCandidate(providerId)

  for (const entry of entries) {
    const rawId = String(entry.key ?? entry.model ?? entry.id ?? entry.name ?? '').trim()
    if (!rawId) continue
    const key = rawId.includes('/') || !LOCAL_PROVIDER_IDS.has(localProvider)
      ? rawId
      : `${localProvider}/${rawId}`
    if (!key || seen.has(key)) continue
    const name = String(entry.name ?? entry.model ?? entry.key ?? entry.id ?? rawId).trim() || rawId
    models.push({ key, name })
    seen.add(key)
  }

  return models
}

export function getLocalDiscoveryDisplay(
  connectionTest: LocalConnectionTestState,
  scanning: boolean,
  scanResult: LocalScanResult | null,
  hasBaseUrl: boolean
): LocalDiscoveryDisplay {
  if (connectionTest.testing || scanning) {
    return {
      buttonColor: 'brand',
      message: scanning ? '正在扫描模型...' : '正在测试连接...',
      messageColor: 'dimmed',
    }
  }

  if (scanResult) {
    if (scanResult.ok) {
      return {
        buttonColor: 'teal',
        message: `连接成功，已发现 ${scanResult.modelCount ?? 0} 个本地模型`,
        messageColor: 'teal',
      }
    }

    return {
      buttonColor: 'red',
      message: scanResult.error || '模型扫描失败',
      messageColor: 'red',
    }
  }

  if (connectionTest.result) {
    if (connectionTest.result.ok) {
      return {
        buttonColor: 'teal',
        message: `连接成功${connectionTest.result.latencyMs != null ? `（${connectionTest.result.latencyMs}ms）` : ''}`,
        messageColor: 'teal',
      }
    }

    return {
      buttonColor: 'red',
      message: connectionTest.result.error || '连接失败',
      messageColor: 'red',
    }
  }

  return {
    buttonColor: 'brand',
    message: hasBaseUrl ? '点击右侧按钮可连接并发现本地模型' : '填写接口地址后可获取本地模型',
    messageColor: 'dimmed',
  }
}

function isConfiguredAuthProviderEntry(entry: any): boolean {
  const status = String(entry?.status || '').trim().toLowerCase()
  if (status && status !== 'missing' && status !== 'none') return true
  if (entry?.authenticated === true) return true
  if (entry?.effective || entry?.modelsJson || entry?.env) return true
  if ((entry?.profiles?.count || 0) > 0) return true
  return false
}

export function hasModelConfigInStatus(statusData: Record<string, any> | null | undefined): boolean {
  if (!statusData || typeof statusData !== 'object') return false

  const authProviders = Array.isArray(statusData.auth?.providers) ? statusData.auth.providers : []
  if (authProviders.some((entry: any) => isConfiguredAuthProviderEntry(entry))) return true

  if (normalizeModelList(statusData.allowed).length > 0) return true
  if (normalizeModelList(statusData.fallbacks).length > 0) return true
  if (
    normalizeModelList(
      statusData.imageFallbacks ?? statusData['image-fallbacks'] ?? statusData.image_fallbacks
    ).length > 0
  ) {
    return true
  }
  if (normalizeAliases(statusData.aliases).length > 0) return true

  if (String(statusData.defaultModel ?? statusData.model ?? '').trim()) return true
  if (String(statusData.imageModel ?? statusData.imageDefaultModel ?? '').trim()) return true

  const defaultAgentModel = statusData?.agents?.defaults?.model
  if (defaultAgentModel && typeof defaultAgentModel === 'object' && !Array.isArray(defaultAgentModel)) {
    if (String(defaultAgentModel.primary ?? '').trim()) return true
    if (String(defaultAgentModel.image ?? '').trim()) return true
    if (normalizeModelList(defaultAgentModel.fallbacks).length > 0) return true
    if (normalizeModelList(defaultAgentModel.imageFallbacks ?? defaultAgentModel.image_fallbacks).length > 0) return true
  }
  return false
}

export function hasModelConfigInConfig(configData: Record<string, any> | null | undefined): boolean {
  if (!configData || typeof configData !== 'object') return false

  if (String(configData.defaultModel ?? configData.model ?? '').trim()) return true
  if (String(configData.imageModel ?? configData.imageDefaultModel ?? '').trim()) return true
  if (normalizeModelList(configData.fallbacks).length > 0) return true
  if (
    normalizeModelList(
      configData.imageFallbacks ?? configData['image-fallbacks'] ?? configData.image_fallbacks
    ).length > 0
  ) {
    return true
  }
  if (normalizeAliases(configData.aliases).length > 0) return true

  const defaultAgentModel = configData?.agents?.defaults?.model
  if (defaultAgentModel && typeof defaultAgentModel === 'object' && !Array.isArray(defaultAgentModel)) {
    if (String(defaultAgentModel.primary ?? '').trim()) return true
    if (String(defaultAgentModel.image ?? '').trim()) return true
    if (normalizeModelList(defaultAgentModel.fallbacks).length > 0) return true
    if (normalizeModelList(defaultAgentModel.imageFallbacks ?? defaultAgentModel.image_fallbacks).length > 0) return true
  }

  const models = configData.models
  if (!models || typeof models !== 'object') return false

  if (String((models as any).default ?? (models as any).main ?? '').trim()) return true
  if (String((models as any).image ?? (models as any).imageDefault ?? '').trim()) return true
  if (normalizeModelList((models as any).allowed).length > 0) return true
  if (normalizeAliases((models as any).aliases).length > 0) return true
  if (normalizeModelList((models as any).fallbacks).length > 0) return true
  if (normalizeModelList((models as any).imageFallbacks ?? (models as any).image_fallbacks).length > 0) return true

  return false
}

export function shouldShowSkipButton(
  enabled: boolean,
  statusData: Record<string, any> | null | undefined,
  configData: Record<string, any> | null | undefined
): boolean {
  if (!enabled) return false
  return hasModelConfigInStatus(statusData) || hasModelConfigInConfig(configData)
}

export function buildSkipSetupContext(): SetupModelContext {
  return {
    providerId: '',
    methodId: '',
    methodType: 'unknown',
    providerStatusIds: [],
    needsInitialization: false,
  }
}

export function methodRequiresSecret(method?: Pick<MethodOption, 'route'> | null): boolean {
  return !!method?.route.requiresSecret
}

export function methodRequiresCustomConfig(method?: Pick<MethodOption, 'route'> | null): boolean {
  return method?.route.kind === 'onboard-custom'
}

export function methodRequiresBrowser(method?: Pick<MethodOption, 'route'> | null): boolean {
  return !!method?.route.requiresBrowser
}

export function methodRequiresExtraOption(method?: Pick<MethodOption, 'route'> | null): boolean {
  return !!method?.route.extraOptions?.length
}

export function shouldShowCredentialProbeControl(_providerId?: string, _methodId?: string): boolean {
  return false
}

export function shouldPreferRuntimeModelSignalsAfterAuth(
  method?: Pick<MethodOption, 'kind' | 'route'> | null
): boolean {
  if (!method) return false
  if (method.kind !== 'apiKey') return false
  if (methodRequiresBrowser(method)) return false
  return true
}

export function shouldDeferPostAuthDefaultModelApply(
  method?: Pick<MethodOption, 'kind' | 'route'> | null
): boolean {
  return shouldPreferRuntimeModelSignalsAfterAuth(method)
}

export function shouldRequireBlockingPostAuthVerification(
  method?: Pick<MethodOption, 'kind' | 'route'> | null
): boolean {
  if (!method) return false
  if (methodRequiresBrowser(method)) return true
  if (methodRequiresCustomConfig(method)) return true
  return false
}

export function getUnsupportedMethodReason(method?: Pick<MethodOption, 'supported' | 'disabledReason'> | null): string {
  if (!method || method.supported !== false) return ''
  return String(method.disabledReason || 'This auth method is unsupported.').trim()
}

export function canOpenManualOAuthUrl(authUrl: string | null | undefined, openingOAuthUrl: boolean): boolean {
  return !openingOAuthUrl && !!String(authUrl || '').trim()
}

export function getRecommendedDependencyInstallOption(
  action?: OAuthExternalDependencyPreflightAction | null
): OAuthExternalDependencyInstallOption | null {
  const options = action?.installOptions || []
  if (!options.length) return null
  return options.find((option) => option.method === action?.recommendedMethod) || options[0]
}

export function formatElapsedSeconds(totalSeconds: number): string {
  const safe = Number.isFinite(totalSeconds) ? Math.max(0, Math.floor(totalSeconds)) : 0
  const minutes = Math.floor(safe / 60)
  const seconds = safe % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

const CAPABILITIES_LOADING_MIN_PROGRESS = 6
const CAPABILITIES_LOADING_MAX_PROGRESS = 95
const CAPABILITIES_LOADING_EASING_MS = 1800
const CAPABILITIES_LOADING_STAGES: Array<Pick<CapabilitiesLoadingDisplay, 'stageLabel' | 'detail'> & { minProgress: number }> =
  [
    {
      minProgress: 0,
      stageLabel: '连接 OpenClaw',
      detail: '正在建立能力查询并读取提供商元数据。',
    },
    {
      minProgress: 30,
      stageLabel: '读取提供商清单',
      detail: '正在同步可用提供商与官方认证入口。',
    },
    {
      minProgress: 60,
      stageLabel: '整理认证方式',
      detail: '正在匹配当前版本支持的认证路由与附加选项。',
    },
    {
      minProgress: 84,
      stageLabel: '准备配置界面',
      detail: '正在生成配置表单，马上就好。',
    },
  ]

export function estimateCapabilitiesLoadingProgress(elapsedMs: number): number {
  const safeElapsedMs = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0
  const easedProgress = 1 - Math.exp(-safeElapsedMs / CAPABILITIES_LOADING_EASING_MS)
  const progress =
    CAPABILITIES_LOADING_MIN_PROGRESS +
    (CAPABILITIES_LOADING_MAX_PROGRESS - CAPABILITIES_LOADING_MIN_PROGRESS) * easedProgress
  return Math.max(
    CAPABILITIES_LOADING_MIN_PROGRESS,
    Math.min(CAPABILITIES_LOADING_MAX_PROGRESS, Math.round(progress))
  )
}

export function buildCapabilitiesLoadingDisplay(elapsedMs: number): CapabilitiesLoadingDisplay {
  const progress = estimateCapabilitiesLoadingProgress(elapsedMs)
  const stage =
    [...CAPABILITIES_LOADING_STAGES].reverse().find((candidate) => progress >= candidate.minProgress) ||
    CAPABILITIES_LOADING_STAGES[0]

  return {
    progress,
    stageLabel: stage.stageLabel,
    detail: stage.detail,
  }
}

export function buildBusyStateDisplay(input: BusyStateInput): BusyStateDisplay {
  if (input.canceling) {
    return {
      title: '正在取消当前操作...',
      detail: '系统正在取消并中断 OpenClaw 命令，请稍候。',
      elapsed: formatElapsedSeconds(input.elapsedSeconds),
    }
  }

  if (input.phase === 'verifying') {
    return {
      title: '正在验证认证结果',
      detail: '系统会轮询模型状态，通常在 12 秒内完成。',
      elapsed: formatElapsedSeconds(input.elapsedSeconds),
    }
  }

  if (input.phase === 'authing' && methodRequiresBrowser(input.method)) {
    return {
      title: '正在执行浏览器授权登录',
      detail: '可能会拉起浏览器并等待你完成授权回调，网络慢时耗时会更长。',
      elapsed: formatElapsedSeconds(input.elapsedSeconds),
    }
  }

  if (input.phase === 'authing' && input.method?.kind === 'token') {
    return {
      title: '正在执行 Token 认证',
      detail: '正在调用 OpenClaw 认证命令并写入授权状态。',
      elapsed: formatElapsedSeconds(input.elapsedSeconds),
    }
  }

  if (input.phase === 'authing' && methodRequiresSecret(input.method)) {
    return {
      title: '正在提交认证信息',
      detail: '正在通过 OpenClaw 官方认证路由写入认证信息，请保持窗口开启。',
      elapsed: formatElapsedSeconds(input.elapsedSeconds),
    }
  }

  return {
    title: '正在执行认证流程',
    detail: '正在调用 OpenClaw 命令，请保持窗口开启。',
    elapsed: formatElapsedSeconds(input.elapsedSeconds),
  }
}

export function shouldShowManualOAuthLink(
  phase: ModelCenterPhase,
  method: Pick<MethodOption, 'route'> | null | undefined,
  authUrl: string | null | undefined
): boolean {
  return phase === 'authing' && methodRequiresBrowser(method) && !!String(authUrl || '').trim()
}

export function shouldShowOAuthFallbackPanel(
  phase: ModelCenterPhase,
  method: Pick<MethodOption, 'route'> | null | undefined
): boolean {
  return phase === 'authing' && methodRequiresBrowser(method)
}

export function getPhaseAfterCancellation(): ModelCenterPhase {
  return 'ready'
}

export function getPhaseAfterAuthFailure(): ModelCenterPhase {
  return 'ready'
}

export const AUTH_RETRY_HINT = '认证失败，可直接重试；如仍异常请点刷新'

export function appendRetryRefreshHint(message: string): string {
  const normalizedMessage = String(message || '').trim()
  const hintLine = `（${AUTH_RETRY_HINT}）`
  if (!normalizedMessage) return hintLine
  if (normalizedMessage.includes(AUTH_RETRY_HINT)) return normalizedMessage
  return `${normalizedMessage}\n${hintLine}`
}

export function canSubmitSelection(input: {
  phase: ModelCenterPhase
  providerId: string
  method?: MethodOption | null
  secret?: string
  selectedExtraOption?: string
  customConfig?: CustomProviderConfigInput
}): boolean {
  if (input.phase !== 'ready') return false
  if (!String(input.providerId || '').trim()) return false
  if (!input.method) return false
  if (!input.method.supported) return false
  if (methodRequiresSecret(input.method) && !String(input.secret || '').trim()) return false
  if (methodRequiresExtraOption(input.method) && !String(input.selectedExtraOption || '').trim()) return false
  if (methodRequiresCustomConfig(input.method)) {
    const baseUrl = String(input.customConfig?.baseUrl || '').trim()
    const modelId = String(input.customConfig?.modelId || '').trim()
    if (!baseUrl || !modelId) return false
  }
  return true
}

export function buildModelAuthRequest(input: {
  providerId: string
  method?: MethodOption | null
  secret?: string
  selectedExtraOption?: string
  customConfig?: CustomProviderConfigInput
}): ModelAuthRequest {
  const providerId = String(input.providerId || '').trim()
  const methodId = normalizeMethodId(input.method?.id || '')
  const normalizedCustomConfig: CustomProviderConfigInput | undefined =
    methodRequiresCustomConfig(input.method) && input.customConfig
      ? {
          baseUrl: String(input.customConfig.baseUrl || '').trim(),
          modelId: String(input.customConfig.modelId || '').trim(),
          ...(String(input.customConfig.providerId || '').trim()
            ? { providerId: String(input.customConfig.providerId || '').trim() }
            : {}),
          compatibility:
            String(input.customConfig.compatibility || '').trim().toLowerCase() === 'anthropic' ? 'anthropic' : 'openai',
        }
      : undefined

  return {
    kind: 'login',
    providerId,
    methodId,
    setDefault: true,
    ...((methodRequiresSecret(input.method) || methodRequiresCustomConfig(input.method)) && String(input.secret || '').trim()
      ? { secret: String(input.secret || '').trim() }
      : {}),
    ...(methodRequiresExtraOption(input.method) && String(input.selectedExtraOption || '').trim()
      ? { selectedExtraOption: normalizeMethodId(String(input.selectedExtraOption || '').trim()) }
      : {}),
    ...(normalizedCustomConfig?.baseUrl && normalizedCustomConfig?.modelId ? { customConfig: normalizedCustomConfig } : {}),
  }
}

interface ExecuteRemoteModelAuthDeps {
  startModelOAuth: (request: {
    providerId: string
    methodId: string
    selectedExtraOption?: string
    setDefault?: boolean
  }) => Promise<any>
  runModelAuth: (request: ModelAuthRequest) => Promise<any>
}

export async function executeRemoteModelAuthSubmission(
  input: {
    providerId: string
    method: MethodOption
    secret?: string
    selectedExtraOption?: string
    customConfig?: CustomProviderConfigInput
  },
  deps: ExecuteRemoteModelAuthDeps
): Promise<any> {
  if (methodRequiresBrowser(input.method)) {
    return deps.startModelOAuth({
      providerId: input.providerId,
      methodId: input.method.id,
      setDefault: true,
      ...(methodRequiresExtraOption(input.method) && String(input.selectedExtraOption || '').trim()
        ? { selectedExtraOption: normalizeMethodId(String(input.selectedExtraOption || '')) }
        : {}),
    })
  }

  return deps.runModelAuth(
    buildModelAuthRequest({
      providerId: input.providerId,
      method: input.method,
      secret: input.secret,
      selectedExtraOption: input.selectedExtraOption,
      customConfig: input.customConfig,
    })
  )
}

export function buildSubmitAuthResultDiagnosticDetails(authResult: {
  ok: boolean
  fallbackUsed?: unknown
  errorCode?: unknown
  message?: unknown
  postAuthRuntime?: {
    tokenRotated?: unknown
    gatewayApplyAction?: unknown
    gatewayConfirmed?: unknown
    recoveryReason?: unknown
    recommendedVerificationProfile?: unknown
  } | null
}): Record<string, unknown> {
  return {
    ok: authResult.ok,
    fallbackUsed: 'fallbackUsed' in authResult ? Boolean(authResult.fallbackUsed) : undefined,
    errorCode: 'errorCode' in authResult ? authResult.errorCode : undefined,
    message: 'message' in authResult ? authResult.message : undefined,
    ...(authResult.postAuthRuntime && typeof authResult.postAuthRuntime === 'object'
      ? {
          postAuthRuntime: {
            tokenRotated: authResult.postAuthRuntime.tokenRotated,
            gatewayApplyAction: authResult.postAuthRuntime.gatewayApplyAction,
            gatewayConfirmed: authResult.postAuthRuntime.gatewayConfirmed,
            recoveryReason: authResult.postAuthRuntime.recoveryReason,
            recommendedVerificationProfile: authResult.postAuthRuntime.recommendedVerificationProfile,
          },
        }
      : {}),
  }
}

export function shouldGateRefreshDuringPostAuthRecovery(postAuthRuntime?: {
  tokenRotated?: unknown
  gatewayApplyAction?: unknown
  gatewayConfirmed?: unknown
  recoveryReason?: unknown
  recommendedVerificationProfile?: unknown
} | null): boolean {
  if (!postAuthRuntime || typeof postAuthRuntime !== 'object') return false
  if (postAuthRuntime.tokenRotated === true) return true
  if (typeof postAuthRuntime.gatewayApplyAction === 'string' && postAuthRuntime.gatewayApplyAction !== 'none') return true
  if (
    postAuthRuntime.recommendedVerificationProfile === 'post-auth-recovery'
    || postAuthRuntime.recommendedVerificationProfile === 'slow-path'
  ) {
    return true
  }
  return false
}

export function resolveRefreshCapabilitiesGuard(params: {
  interactionLocked: boolean
  refreshingCapabilities: boolean
  phase: ModelCenterPhase
  postAuthRecoveryRefreshLocked: boolean
}): { blocked: boolean; disabled: boolean; statusText: string } {
  if (params.interactionLocked || params.refreshingCapabilities || params.phase === 'loading') {
    return {
      blocked: true,
      disabled: true,
      statusText: '',
    }
  }

  if (params.postAuthRecoveryRefreshLocked) {
    return {
      blocked: true,
      disabled: true,
      statusText: '正在同步认证结果，请稍候...',
    }
  }

  return {
    blocked: false,
    disabled: false,
    statusText: '',
  }
}

export function shouldIgnorePostAuthAsyncResult(params: {
  attemptId: number
  currentAttemptId: number
  mounted: boolean
  cancelRequested?: boolean
}): boolean {
  if (!params.mounted) return true
  if (params.currentAttemptId !== params.attemptId) return true
  if (params.cancelRequested) return true
  return false
}

export function shouldReleasePostAuthRecoveryLock(params: {
  attemptId: number
  currentAttemptId: number
  mounted: boolean
}): boolean {
  return params.mounted && params.currentAttemptId === params.attemptId
}

export function shouldHoldPostAuthRecoveryLockUntilDeferredApply(params: {
  postAuthRecoveryLocked: boolean
  stayOnConfigured: boolean
  shouldQueueDeferredDefaultModelApply: boolean
}): boolean {
  return params.postAuthRecoveryLocked && params.stayOnConfigured && params.shouldQueueDeferredDefaultModelApply
}

export function resolvePostAuthRecoveryLockForConfiguredCallback(params: {
  postAuthRecoveryLocked: boolean
  releasedBeforeCallback: boolean
}): boolean {
  return params.releasedBeforeCallback ? false : params.postAuthRecoveryLocked
}

export type AuthVerificationProfile = 'default' | 'post-auth-recovery' | 'slow-path'

export function resolvePostAuthVerificationProfile(postAuthRuntime?: {
  tokenRotated?: unknown
  gatewayApplyAction?: unknown
  gatewayConfirmed?: unknown
  recoveryReason?: unknown
  recommendedVerificationProfile?: unknown
} | null): AuthVerificationProfile {
  if (postAuthRuntime?.recommendedVerificationProfile === 'post-auth-recovery') {
    return 'post-auth-recovery'
  }
  if (postAuthRuntime?.recommendedVerificationProfile === 'slow-path') {
    return 'slow-path'
  }
  return 'default'
}

export function resolveAuthVerificationPollPolicy(profile: AuthVerificationProfile): BackoffPollingPolicy {
  const basePolicy = UI_RUNTIME_DEFAULTS.authVerification.poll
  if (profile === 'post-auth-recovery') {
    return {
      ...basePolicy,
      timeoutMs: 45_000,
    }
  }
  if (profile === 'slow-path') {
    return {
      ...basePolicy,
      timeoutMs: 60_000,
    }
  }
  return basePolicy
}

export type ControlUiTimeoutProfile = AuthVerificationProfile

export function resolveControlUiTimeoutProfile(postAuthRuntime?: {
  tokenRotated?: unknown
  gatewayApplyAction?: unknown
  gatewayConfirmed?: unknown
  recoveryReason?: unknown
  recommendedVerificationProfile?: unknown
} | null): ControlUiTimeoutProfile {
  return resolvePostAuthVerificationProfile(postAuthRuntime)
}

export function resolveControlUiTimeoutOptions(profile: ControlUiTimeoutProfile): {
  loadTimeoutMs: number
  timeoutMs: number
} {
  if (profile === 'post-auth-recovery') {
    return {
      loadTimeoutMs: 30_000,
      timeoutMs: 35_000,
    }
  }
  if (profile === 'slow-path') {
    return {
      loadTimeoutMs: 30_000,
      timeoutMs: 40_000,
    }
  }
  return {
    loadTimeoutMs: 15_000,
    timeoutMs: 20_000,
  }
}

export function buildProviderOptions(
  capabilities: OpenClawCapabilities | null,
  providerNames?: Record<string, string>
): ProviderOption[] {
  if (!capabilities?.authRegistry) return []

  const result = capabilities.authRegistry.providers
    .map((provider) => {
      const methodsById = new Map<string, MethodOption>()
      for (const method of provider.methods || []) {
        const methodId = normalizeMethodId(method.authChoice)
        if (!methodId || methodId === 'skip') continue
        if (methodsById.has(methodId)) continue
        const disabledReason = buildMethodDisabledReason(method, capabilities)
        const methodDisplay = resolveModelCenterMethodDisplayCopy({
          providerId: provider.id,
          methodId,
          fallbackLabel: String(method.label || methodId).trim(),
          fallbackHint: method.hint,
        })
        methodsById.set(methodId, {
          id: methodId,
          kind: method.kind,
          label: methodDisplay.label,
          ...(methodDisplay.hint ? { hint: methodDisplay.hint } : {}),
          route: method.route,
          supported: !disabledReason,
          ...(disabledReason ? { disabledReason } : {}),
        })
      }

      const providerDisplay = resolveModelCenterProviderDisplayCopy({
        providerId: provider.id,
        fallbackName: resolveProviderDisplayName(provider.id, provider.label),
        fallbackHint: provider.hint,
      })
      return {
        id: provider.id,
        name: providerDisplay.name,
        ...(providerDisplay.hint ? { hint: providerDisplay.hint } : {}),
        methods: Array.from(methodsById.values()),
      }
    })
    .filter((provider) => provider.methods.length > 0)

  const providerOrderMap = new Map(getKnownProviderCatalog().map((entry, index) => [entry.id, index]))
  result.sort((a, b) => (providerOrderMap.get(a.id) ?? Infinity) - (providerOrderMap.get(b.id) ?? Infinity))
  return result
}

export interface ProviderMethodSelection {
  providerId: string
  methodId: string
}

export function resolveNextProviderMethodSelection(
  providers: ProviderOption[],
  previousSelection: { providerId?: string; methodId?: string } = {}
): ProviderMethodSelection {
  if (!providers.length) {
    return {
      providerId: '',
      methodId: '',
    }
  }

  const previousProviderId = String(previousSelection.providerId || '').trim()
  const previousMethodId = normalizeMethodId(String(previousSelection.methodId || ''))
  const provider =
    providers.find((item) => item.id === previousProviderId) ||
    providers.find((item) => item.methods.some((method) => method.supported)) ||
    providers[0]
  const method =
    provider.methods.find((item) => normalizeMethodId(item.id) === previousMethodId && item.supported) ||
    provider.methods.find((item) => item.supported) ||
    provider.methods.find((item) => normalizeMethodId(item.id) === previousMethodId) ||
    provider.methods[0]

  return {
    providerId: provider.id,
    methodId: method?.id || '',
  }
}

function normalizeProviderCandidate(value: string): string {
  return String(value || '').trim().toLowerCase()
}

const DEFAULT_MODEL_APPLY_TIMEOUT_MS = 6_000

function uniqueProviderCandidates(values: string[]): string[] {
  const seen = new Set<string>()
  const unique: string[] = []
  for (const value of values) {
    const normalized = normalizeProviderCandidate(value)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    unique.push(normalized)
  }
  return unique
}

export function buildVerificationProviderCandidates(
  providerId: string,
  method?: Pick<MethodOption, 'route'> | null
): string[] {
  return uniqueProviderCandidates(
    [providerId, String(method?.route.providerId || '')].flatMap((value) => getModelProviderAliasCandidates(value))
  )
}

function expandProviderCandidates(values: string[]): string[] {
  return uniqueProviderCandidates(values.flatMap((value) => getModelProviderAliasCandidates(value)))
}

function extractProviderFromModelKey(modelKey: string): string {
  return normalizeProviderCandidate(String(modelKey || '').split('/')[0] || '')
}

function modelMatchesProviderCandidates(modelKey: string, providerCandidates: string[]): boolean {
  const modelProvider = extractProviderFromModelKey(modelKey)
  if (!modelProvider) return false
  const expandedCandidates = expandProviderCandidates(providerCandidates)
  return expandedCandidates.includes(modelProvider)
}

function collectStatusModelKeys(statusData: Record<string, any> | null | undefined): string[] {
  const keys: string[] = []
  const addKey = (value: unknown) => {
    const modelKey = String(value || '').trim()
    if (modelKey.includes('/')) keys.push(modelKey)
  }
  const addKeyList = (value: unknown) => {
    if (!Array.isArray(value)) return
    for (const item of value) addKey(item)
  }

  addKey(statusData?.defaultModel ?? statusData?.model)
  addKey(statusData?.agents?.defaults?.model?.primary)
  addKey(statusData?.agents?.defaults?.model?.image)
  addKeyList(statusData?.allowed)
  addKeyList(statusData?.fallbacks)
  addKeyList(statusData?.agents?.defaults?.model?.fallbacks)
  addKeyList(statusData?.agents?.defaults?.model?.imageFallbacks ?? statusData?.agents?.defaults?.model?.image_fallbacks)

  const aliases = statusData?.aliases
  if (Array.isArray(aliases)) {
    for (const entry of aliases) {
      addKey(entry?.model ?? entry?.target)
    }
  } else if (aliases && typeof aliases === 'object') {
    for (const value of Object.values(aliases)) addKey(value)
  }

  return Array.from(new Set(keys))
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

interface ResolveDefaultModelStatusResult {
  ok?: boolean
  data?: Record<string, any> | null
}

interface ProviderVerificationSnapshot {
  configured: boolean
  source: 'upstream' | 'cli' | 'oauth-persistence' | 'none'
  upstreamUnavailable?: boolean
}

function isProviderReadyFromRuntimeModels(
  statusData: Record<string, any> | null | undefined,
  providerCandidates: string[]
): boolean {
  if (!statusData || providerCandidates.length === 0) return false
  const statusModelKeys = collectStatusModelKeys(statusData)
  return statusModelKeys.some((key) => modelMatchesProviderCandidates(key, providerCandidates))
}

interface ResolveDefaultModelForProviderDeps {
  getModelUpstreamState?: () => Promise<Awaited<ReturnType<typeof window.api.getModelUpstreamState>> | null>
  getModelStatus: () => Promise<ResolveDefaultModelStatusResult | null>
  listCatalog: (query?: Record<string, any>) => Promise<{ total: number; items: Array<{ key: string }> }>
  readConfig?: () => Promise<Record<string, any> | null>
  timeoutMs?: number
  pageSize?: number
}

function collectConfiguredProviderModelKeys(
  configData: Record<string, any> | null | undefined,
  providerCandidates: string[]
): string[] {
  if (!configData || typeof configData !== 'object') return []

  const modelSection = configData.models
  if (!modelSection || typeof modelSection !== 'object' || Array.isArray(modelSection)) return []

  const providerMap =
    modelSection.providers && typeof modelSection.providers === 'object' && !Array.isArray(modelSection.providers)
      ? modelSection.providers
      : modelSection

  const expandedCandidates = new Set(expandProviderCandidates(providerCandidates))
  const modelKeys: string[] = []

  for (const [providerId, providerConfig] of Object.entries(providerMap as Record<string, any>)) {
    const normalizedProviderId = normalizeProviderCandidate(providerId)
    if (!normalizedProviderId || !expandedCandidates.has(normalizedProviderId)) continue

    const models = Array.isArray(providerConfig?.models) ? providerConfig.models : []
    for (const model of models) {
      const rawModelId = String((typeof model === 'string' ? model : model?.key ?? model?.id) || '').trim()
      if (!rawModelId) continue

      const modelKey = rawModelId.includes('/') ? rawModelId : `${normalizedProviderId}/${rawModelId}`
      if (modelMatchesProviderCandidates(modelKey, providerCandidates)) {
        modelKeys.push(modelKey)
      }
    }
  }

  return Array.from(new Set(modelKeys))
}

function resolveConfiguredDefaultModelForProviderCandidates(
  configData: Record<string, any> | null | undefined,
  providerCandidates: string[]
): string {
  const candidates = [
    extractConfiguredDefaultModel(configData),
    String(configData?.models?.default ?? '').trim(),
    String(configData?.models?.main ?? '').trim(),
  ]

  return candidates.find((modelKey) => modelMatchesProviderCandidates(modelKey, providerCandidates)) || ''
}

export async function resolveDefaultModelForProviderCandidates(
  providerCandidates: string[],
  deps: ResolveDefaultModelForProviderDeps
): Promise<string> {
  const expandedCandidates = expandProviderCandidates(providerCandidates)
  if (!expandedCandidates.length) return ''
  const timeoutMs = Math.max(1, Number(deps.timeoutMs || DEFAULT_MODEL_APPLY_TIMEOUT_MS))
  const pageSize = Math.min(
    MODEL_CATALOG_LIMITS.maxPageSize,
    Math.max(1, Number(deps.pageSize || MODEL_CATALOG_LIMITS.dashboardPageSize))
  )
  const savedConfig = deps.readConfig
    ? await withTimeout(deps.readConfig(), timeoutMs)
    : null
  const configuredDefaultModel = resolveConfiguredDefaultModelForProviderCandidates(savedConfig || null, expandedCandidates)
  if (configuredDefaultModel) {
    return configuredDefaultModel
  }
  const configuredProviderModels = collectConfiguredProviderModelKeys(savedConfig || null, expandedCandidates)
  if (configuredProviderModels.length > 0) {
    return configuredProviderModels[0]
  }

  const upstreamState = deps.getModelUpstreamState
    ? await withTimeout(deps.getModelUpstreamState(), timeoutMs)
    : null
  const upstreamStatusData = upstreamState ? getUpstreamModelStatusLike(upstreamState) : null
  if (upstreamStatusData) {
    const defaultFromUpstream = String(
      upstreamStatusData.defaultModel ?? upstreamStatusData.model ?? upstreamStatusData?.agents?.defaults?.model?.primary ?? ''
    ).trim()
    if (defaultFromUpstream && modelMatchesProviderCandidates(defaultFromUpstream, expandedCandidates)) {
      return defaultFromUpstream
    }

    const upstreamStatusModelKeys = collectStatusModelKeys(upstreamStatusData)
    const matchedUpstreamStatusModel = upstreamStatusModelKeys.find((key) =>
      modelMatchesProviderCandidates(key, expandedCandidates)
    )
    if (matchedUpstreamStatusModel) return matchedUpstreamStatusModel
  }

  const upstreamCatalog = upstreamState ? getUpstreamCatalogItemsLike(upstreamState) : []
  const matchedUpstreamCatalogModel = upstreamCatalog.find((item) =>
    item.available !== false && modelMatchesProviderCandidates(String(item?.key || ''), expandedCandidates)
  )
  if (matchedUpstreamCatalogModel?.key) return matchedUpstreamCatalogModel.key

  const statusResult = await withTimeout(deps.getModelStatus(), timeoutMs)
  if (statusResult?.ok) {
    const statusData = (statusResult.data || {}) as Record<string, any>
    const defaultFromStatus = String(
      statusData.defaultModel ?? statusData.model ?? statusData?.agents?.defaults?.model?.primary ?? ''
    ).trim()
    if (defaultFromStatus && modelMatchesProviderCandidates(defaultFromStatus, expandedCandidates)) {
      return defaultFromStatus
    }

    const statusModelKeys = collectStatusModelKeys(statusData)
    const matchedStatusModel = statusModelKeys.find((key) => modelMatchesProviderCandidates(key, expandedCandidates))
    if (matchedStatusModel) return matchedStatusModel
  }

  for (const providerId of expandedCandidates) {
    const providerCatalog = await withTimeout(
      listAllModelCatalogItems(deps.listCatalog, {
        provider: providerId,
        includeUnavailable: false,
      }, pageSize),
      timeoutMs
    )
    const matchedCatalogModel = (providerCatalog || []).find((item) =>
      modelMatchesProviderCandidates(String(item?.key || ''), expandedCandidates)
    )
    if (matchedCatalogModel?.key) return matchedCatalogModel.key
  }

  return ''
}

export function joinModelCenterNonBlockingMessages(...messages: Array<string | null | undefined>): string {
  return messages
    .map((message) => String(message || '').trim())
    .filter(Boolean)
    .join('；另外')
}

export function classifyModelCenterBannerMessage(params: {
  message?: string | null
  stderr?: string
  stdout?: string
}): SharedCliFailureCode | 'unknown' {
  const sharedCode = classifySharedCliFailure(
    buildCliFailureClassificationCorpus(params.stderr, params.stdout)
  )
  if (sharedCode) return sharedCode

  const message = String(params.message || '').trim()
  if (!message) return 'unknown'
  if (message.includes('网关 token 已变更')) return 'gateway_unready'
  if (message.includes('网络连接异常')) return 'network_blocked'
  if (message.includes('API Key 无效')) return 'api_invalid'
  if (message.includes('配置写入失败')) return 'write_failure'
  return 'unknown'
}

export function shouldSuppressModelCenterSecondaryNetworkBanner(params: {
  postAuthRecoveryLocked: boolean
  primaryMessage?: string | null
  primaryStderr?: string
  primaryStdout?: string
  candidateMessage?: string | null
  candidateStderr?: string
  candidateStdout?: string
}): boolean {
  if (!params.postAuthRecoveryLocked) return false

  const primaryCode = classifyModelCenterBannerMessage({
    message: params.primaryMessage,
    stderr: params.primaryStderr,
    stdout: params.primaryStdout,
  })
  const candidateCode = classifyModelCenterBannerMessage({
    message: params.candidateMessage,
    stderr: params.candidateStderr,
    stdout: params.candidateStdout,
  })

  return primaryCode === 'gateway_unready' && candidateCode === 'network_blocked'
}

export function mergeModelCenterNonBlockingMessagesWithPriority(params: {
  currentMessage?: string | null
  currentStderr?: string
  currentStdout?: string
  candidateMessage?: string | null
  candidateStderr?: string
  candidateStdout?: string
  postAuthRecoveryLocked: boolean
}): { message: string; suppressed: boolean } {
  const currentMessage = String(params.currentMessage || '').trim()
  const candidateMessage = String(params.candidateMessage || '').trim()

  if (!candidateMessage) {
    return {
      message: currentMessage,
      suppressed: false,
    }
  }

  if (
    shouldSuppressModelCenterSecondaryNetworkBanner({
      postAuthRecoveryLocked: params.postAuthRecoveryLocked,
      primaryMessage: currentMessage,
      primaryStderr: params.currentStderr,
      primaryStdout: params.currentStdout,
      candidateMessage,
      candidateStderr: params.candidateStderr,
      candidateStdout: params.candidateStdout,
    })
  ) {
    return {
      message: currentMessage,
      suppressed: true,
    }
  }

  return {
    message: joinModelCenterNonBlockingMessages(currentMessage, candidateMessage),
    suppressed: false,
  }
}

async function tryResolveDefaultModelForProvider(
  providerCandidates: string[],
  controlUiTimeoutOptions?: {
    timeoutMs?: number
    loadTimeoutMs?: number
  }
): Promise<string> {
  return resolveDefaultModelForProviderCandidates(providerCandidates, {
    getModelUpstreamState: () => window.api.getModelUpstreamState(controlUiTimeoutOptions),
    getModelStatus: () => window.api.getModelStatus(),
    listCatalog: (query) => window.api.listModelCatalog(query),
    readConfig: () => window.api.readConfig(),
    timeoutMs: controlUiTimeoutOptions?.timeoutMs || DEFAULT_MODEL_APPLY_TIMEOUT_MS,
    pageSize: MODEL_CATALOG_LIMITS.dashboardPageSize,
  })
}

export function findConfiguredCustomProviderId(
  configData: Record<string, any> | null | undefined,
  customConfig: CustomProviderConfigInput
): string {
  return resolveConfiguredCustomProviderIdFromConfig(configData, customConfig)
}

export function isProviderConfigured(
  statusData: Record<string, any>,
  providerId: string,
  providerAliases: string[] = [],
  options?: {
    allowModelListFallback?: boolean
  }
): boolean {
  const providerCandidates = uniqueProviderCandidates([providerId, ...providerAliases])
  if (providerCandidates.length === 0 || !statusData) return false

  const allowModelListFallback = options?.allowModelListFallback !== false
  const matchingProviderEntries = getMatchingProviderAuthEntries(statusData, providerCandidates)

  if (matchingProviderEntries.length > 0) {
    return matchingProviderEntries.some((providerEntry: any) => {
      const status = String(providerEntry.status || '').trim().toLowerCase()
      if (status && !['missing', 'none', 'error', 'disabled', 'unconfigured'].includes(status)) {
        return true
      }

      if (providerEntry.authenticated === true) return true
      if (providerEntry.effective === true) return true
      if (providerEntry.effective && typeof providerEntry.effective === 'object') return true
      if (providerEntry.modelsJson || providerEntry.env) return true
      if ((providerEntry.profiles?.count || 0) > 0) return true
      return false
    })
  }

  if (!allowModelListFallback) return false

  const allowed = Array.isArray(statusData.allowed) ? statusData.allowed : []
  return allowed.some((model: unknown) => {
    const normalizedModel = String(model || '').trim().toLowerCase()
    return providerCandidates.some((providerCandidate) => normalizedModel.startsWith(`${providerCandidate}/`))
  })
}

function getMatchingProviderAuthEntries(
  statusData: Record<string, any> | null | undefined,
  providerCandidates: string[]
): any[] {
  if (!statusData || providerCandidates.length === 0) return []

  const authProviders = [
    ...(Array.isArray(statusData.auth?.providers) ? statusData.auth.providers : []),
    ...(Array.isArray(statusData.auth?.oauth?.providers) ? statusData.auth.oauth.providers : []),
  ]

  return authProviders.filter((entry: any) => {
    const name = normalizeProviderCandidate(String(entry?.provider || entry?.providerId || ''))
    return providerCandidates.includes(name)
  })
}

export async function resolveProviderVerificationSnapshot(
  providerCandidates: string[],
  deps?: {
    getModelUpstreamState?: () => Promise<Awaited<ReturnType<typeof window.api.getModelUpstreamState>> | null>
    getModelStatus?: () => Promise<ResolveDefaultModelStatusResult | null>
  },
  options?: {
    preferRuntimeModelSignals?: boolean
  }
): Promise<ProviderVerificationSnapshot> {
  const expandedCandidates = expandProviderCandidates(providerCandidates)
  if (expandedCandidates.length === 0) {
    return {
      configured: false,
      source: 'none',
      upstreamUnavailable: Boolean(deps?.getModelUpstreamState),
    }
  }

  const shouldQueryCliFirst = options?.preferRuntimeModelSignals === true
  const resolveConfiguredFromCli = (
    statusResult: ResolveDefaultModelStatusResult | null
  ): ProviderVerificationSnapshot | null => {
    if (!statusResult?.ok) return null

    const statusData = statusResult.data || {}
    if (options?.preferRuntimeModelSignals && isProviderReadyFromRuntimeModels(statusData, expandedCandidates)) {
      return {
        configured: true,
        source: 'cli',
        upstreamUnavailable: false,
      }
    }

    const configuredFromCli = isProviderConfigured(
      statusData,
      expandedCandidates[0],
      expandedCandidates.slice(1),
      {
        allowModelListFallback: false,
      }
    )
    if (configuredFromCli) {
      return {
        configured: true,
        source: 'cli',
        upstreamUnavailable: false,
      }
    }

    return null
  }

  const initialStatusResult =
    shouldQueryCliFirst && deps?.getModelStatus
      ? await deps.getModelStatus().catch(() => null)
      : null
  const initialCliConfigured = resolveConfiguredFromCli(initialStatusResult)
  if (initialCliConfigured) {
    return initialCliConfigured
  }

  const upstreamState = deps?.getModelUpstreamState
    ? await deps.getModelUpstreamState().catch(() => null)
    : null
  const upstreamStatusData = upstreamState ? getUpstreamModelStatusLike(upstreamState) : null
  const upstreamUnavailable = Boolean(deps?.getModelUpstreamState) && !upstreamStatusData
  if (upstreamStatusData) {
    if (options?.preferRuntimeModelSignals && isProviderReadyFromRuntimeModels(upstreamStatusData, expandedCandidates)) {
      return {
        configured: true,
        source: 'upstream',
        upstreamUnavailable: false,
      }
    }
    const configuredFromUpstream = isProviderConfigured(
      upstreamStatusData,
      expandedCandidates[0],
      expandedCandidates.slice(1),
      {
        allowModelListFallback: false,
      }
    )
    if (configuredFromUpstream || !options?.preferRuntimeModelSignals) {
      return {
        configured: configuredFromUpstream,
        source: 'upstream',
        upstreamUnavailable: false,
      }
    }
  }

  const statusResult = initialStatusResult || (deps?.getModelStatus
    ? await deps.getModelStatus().catch(() => null)
    : null)
  if (statusResult?.ok) {
    if (options?.preferRuntimeModelSignals && isProviderReadyFromRuntimeModels(statusResult.data || {}, expandedCandidates)) {
      return {
        configured: true,
        source: 'cli',
        upstreamUnavailable,
      }
    }
    return {
      configured: isProviderConfigured(statusResult.data || {}, expandedCandidates[0], expandedCandidates.slice(1), {
        allowModelListFallback: false,
      }),
      source: 'cli',
      upstreamUnavailable,
    }
  }

  return {
    configured: false,
    source: 'none',
    upstreamUnavailable,
  }
}

export async function resolveBrowserOAuthVerificationSnapshot(
  providerCandidates: string[],
  deps: {
    getModelUpstreamState: () => Promise<Awaited<ReturnType<typeof window.api.getModelUpstreamState>> | null>
    checkOAuthComplete: (providerKey: string) => Promise<boolean>
  }
): Promise<ProviderVerificationSnapshot> {
  const expandedCandidates = expandProviderCandidates(providerCandidates)
  if (expandedCandidates.length === 0) {
    return {
      configured: false,
      source: 'none',
      upstreamUnavailable: true,
    }
  }

  const upstreamState = await deps.getModelUpstreamState().catch(() => null)
  const upstreamStatusData = upstreamState ? getUpstreamModelStatusLike(upstreamState) : null
  if (upstreamStatusData) {
    const configuredFromUpstream = isProviderConfigured(upstreamStatusData, expandedCandidates[0], expandedCandidates.slice(1), {
      allowModelListFallback: false,
    })
    if (configuredFromUpstream) {
      return {
        configured: true,
        source: 'upstream',
        upstreamUnavailable: false,
      }
    }

    const hasExplicitUpstreamAuthSignal = getMatchingProviderAuthEntries(upstreamStatusData, expandedCandidates).length > 0
    if (hasExplicitUpstreamAuthSignal) {
      return {
        configured: false,
        source: 'upstream',
        upstreamUnavailable: false,
      }
    }
  }

  const persistedChecks = await Promise.all(
    expandedCandidates.map((candidate) => deps.checkOAuthComplete(candidate).catch(() => false))
  )
  if (persistedChecks.some(Boolean)) {
    return {
      configured: true,
      source: 'oauth-persistence',
      upstreamUnavailable: !upstreamStatusData,
    }
  }

  if (upstreamStatusData) {
    return {
      configured: false,
      source: 'upstream',
      upstreamUnavailable: false,
    }
  }

  return {
    configured: false,
    source: 'none',
    upstreamUnavailable: true,
  }
}

async function verifyProviderWithPolling(
  providerCandidates: string[],
  options?: {
    browserOAuthPersistenceFallback?: boolean
    preferRuntimeModelSignals?: boolean
    pollPolicy?: BackoffPollingPolicy
    controlUiTimeoutOptions?: {
      timeoutMs?: number
      loadTimeoutMs?: number
    }
    shouldAbort?: () => boolean
    onAttempt?: (attempt: number, elapsedMs: number) => void
  }
): Promise<boolean> {
  if (!providerCandidates.length) return false
  const result = await pollWithBackoff({
    policy: options?.pollPolicy || UI_RUNTIME_DEFAULTS.authVerification.poll,
    shouldAbort: options?.shouldAbort,
    onAttempt: ({ attempt, elapsedMs }) => options?.onAttempt?.(attempt, elapsedMs),
    execute: async () =>
      options?.browserOAuthPersistenceFallback
        ? resolveBrowserOAuthVerificationSnapshot(providerCandidates, {
            getModelUpstreamState: () => window.api.getModelUpstreamState(options?.controlUiTimeoutOptions),
            checkOAuthComplete: (providerKey) => window.api.checkOAuthComplete(providerKey),
          })
        : resolveProviderVerificationSnapshot(providerCandidates, {
            getModelUpstreamState: () => window.api.getModelUpstreamState(options?.controlUiTimeoutOptions),
            getModelStatus: () => window.api.getModelStatus(),
          }, {
            preferRuntimeModelSignals: options?.preferRuntimeModelSignals,
          }),
    isSuccess: (snapshot) => snapshot.configured,
  })
  return result.ok
}

async function verifyCustomProviderWithPolling(
  customConfig: CustomProviderConfigInput,
  options?: {
    pollPolicy?: BackoffPollingPolicy
    shouldAbort?: () => boolean
    onAttempt?: (attempt: number, elapsedMs: number) => void
  }
): Promise<CustomProviderConfigMatchResult> {
  const result = await pollWithBackoff({
    policy: options?.pollPolicy || UI_RUNTIME_DEFAULTS.authVerification.poll,
    shouldAbort: options?.shouldAbort,
    onAttempt: ({ attempt, elapsedMs }) => options?.onAttempt?.(attempt, elapsedMs),
    execute: async () => resolveConfiguredCustomProviderMatchFromConfig(await window.api.readConfig(), customConfig),
    isSuccess: (matchResult) => matchResult.status !== 'missing',
  })

  return result.value || { status: 'missing' }
}

type RefreshModelDataResult = Awaited<ReturnType<typeof window.api.refreshModelData>>
type RefreshModelCapabilitiesResult = RefreshModelDataResult & {
  capabilities: OpenClawCapabilities
}

export async function refreshModelCapabilitiesData(
  refreshModelData: (payload: {
    includeCapabilities?: boolean
    includeStatus?: boolean
    includeCatalog?: boolean
    forceCapabilitiesRefresh?: boolean
  }) => Promise<RefreshModelDataResult>
): Promise<RefreshModelCapabilitiesResult> {
  const refreshed = await refreshModelData({
    includeCapabilities: true,
    includeStatus: true,
    includeCatalog: false,
    forceCapabilitiesRefresh: true,
  })
  if (!refreshed.capabilities) {
    throw new Error('刷新结果缺少模型能力数据')
  }
  return refreshed as RefreshModelCapabilitiesResult
}

export default function ModelCenter({
  onConfigured,
  onCancel,
  providerNames,
  submitIdleLabel = '下一步 — 配置消息渠道',
  stayOnConfigured = false,
  configuredMessage = '模型信息已保存',
  collapsible = true,
  showSkipWhenConfigured = false,
  skipLabel = '跳过',
}: ModelCenterProps) {
  const [phase, setPhase] = useState<ModelCenterPhase>('loading')
  const [capabilities, setCapabilities] = useState<OpenClawCapabilities | null>(null)
  const [selectedProviderId, setSelectedProviderId] = useState('')
  const [selectedMethodId, setSelectedMethodId] = useState('')
  const [selectedExtraOption, setSelectedExtraOption] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [customBaseUrl, setCustomBaseUrl] = useState('')
  const [customModelId, setCustomModelId] = useState('')
  const [customProviderId, setCustomProviderId] = useState('')
  const [customCompatibility, setCustomCompatibility] = useState<CustomProviderCompatibility>('openai')
  const [statusText, setStatusText] = useState('')
  const [warning, setWarning] = useState('')
  const [error, setError] = useState('')
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [canceling, setCanceling] = useState(false)
  const [manualOAuthUrl, setManualOAuthUrl] = useState('')
  const [manualOAuthCode, setManualOAuthCode] = useState('')
  const [openingOAuthUrl, setOpeningOAuthUrl] = useState(false)
  const [oauthDependencyAction, setOAuthDependencyAction] = useState<OAuthExternalDependencyPreflightAction | null>(null)
  const [oauthDependencyWarnings, setOAuthDependencyWarnings] = useState<OAuthExternalDependencyWarning[]>([])
  const [installingOAuthDependency, setInstallingOAuthDependency] = useState(false)
  const [refreshingCapabilities, setRefreshingCapabilities] = useState(false)
  const [capabilitiesLoadingElapsedMs, setCapabilitiesLoadingElapsedMs] = useState(0)
  const [providerConfigExpanded, setProviderConfigExpanded] = useState(DEFAULT_PROVIDER_CONFIG_EXPANDED)
  const [showSkipButton, setShowSkipButton] = useState(false)
  const [localBaseUrl, setLocalBaseUrl] = useState('')
  const [localApiKey, setLocalApiKey] = useState('')
  const [connectionTest, setConnectionTest] = useState<LocalConnectionTestState>({ testing: false })
  const [scanning, setScanning] = useState(false)
  const [scanResult, setScanResult] = useState<LocalScanResult | null>(null)
  const [selectedLocalModel, setSelectedLocalModel] = useState('')
  const [postAuthRecoveryRefreshLocked, setPostAuthRecoveryRefreshLockedState] = useState(false)
  const cancelRequestedRef = useRef(false)
  const busyStartedAtRef = useRef<number | null>(null)
  const mountedRef = useRef(true)
  const authAttemptIdRef = useRef(0)
  const warningRef = useRef('')
  const errorRef = useRef('')
  const postAuthRecoveryRefreshLockedRef = useRef(false)
  const selectedProviderIdRef = useRef('')
  const selectedMethodIdRef = useRef('')
  const setPostAuthRecoveryRefreshLocked = (next: boolean) => {
    postAuthRecoveryRefreshLockedRef.current = next
    setPostAuthRecoveryRefreshLockedState(next)
  }

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    warningRef.current = warning
  }, [warning])

  useEffect(() => {
    errorRef.current = error
  }, [error])

  useEffect(() => {
    postAuthRecoveryRefreshLockedRef.current = postAuthRecoveryRefreshLocked
  }, [postAuthRecoveryRefreshLocked])

  useEffect(() => {
    selectedProviderIdRef.current = selectedProviderId
  }, [selectedProviderId])

  useEffect(() => {
    selectedMethodIdRef.current = selectedMethodId
  }, [selectedMethodId])

  const providers = useMemo(() => {
    const registryProviders = buildProviderOptions(capabilities, providerNames)
    const existingIds = new Set(registryProviders.map((p) => p.id))
    const localEntries: ProviderOption[] = []
    for (const id of LOCAL_PROVIDER_IDS) {
      if (existingIds.has(id)) continue
      const catalog = getKnownProviderCatalog().find((entry) => entry.id === id)
      const metadata = getProviderMetadata(id)
      const providerDisplay = resolveModelCenterProviderDisplayCopy({
        providerId: id,
        fallbackName: catalog?.name || resolveProviderDisplayName(id),
        fallbackHint: metadata?.description,
      })
      localEntries.push({
        id,
        name: providerDisplay.name,
        ...(providerDisplay.hint ? { hint: providerDisplay.hint } : {}),
        methods: [],
      })
    }
    return [...registryProviders, ...localEntries]
  }, [capabilities, providerNames])

  const selectedProvider = providers.find((provider) => provider.id === selectedProviderId) || null
  const methodOptions = selectedProvider?.methods || []
  const selectedMethod = methodOptions.find((method) => method.id === selectedMethodId) || null
  const requiresSecret = methodRequiresSecret(selectedMethod)
  const requiresBrowser = methodRequiresBrowser(selectedMethod)
  const requiresExtraOption = methodRequiresExtraOption(selectedMethod)
  const requiresCustomConfig = methodRequiresCustomConfig(selectedMethod)
  const unsupportedReason = getUnsupportedMethodReason(selectedMethod)
  const isLocal = isLocalProvider(selectedProviderId)
  const localDefaults = isLocal ? LOCAL_PROVIDER_DEFAULTS[selectedProviderId] : null
  const busy = phase === 'authing' || phase === 'verifying'
  const interactionLocked = busy || installingOAuthDependency || scanning
  const refreshGuard = resolveRefreshCapabilitiesGuard({
    interactionLocked,
    refreshingCapabilities,
    phase,
    postAuthRecoveryRefreshLocked,
  })
  const showManualOAuthLink = shouldShowManualOAuthLink(phase, selectedMethod, manualOAuthUrl)
  const showOAuthFallbackPanel = shouldShowOAuthFallbackPanel(phase, selectedMethod)
  const canOpenManualLink = canOpenManualOAuthUrl(manualOAuthUrl, openingOAuthUrl)
  const recommendedDependencyInstallOption = getRecommendedDependencyInstallOption(oauthDependencyAction)
  const showProviderConfigContent = shouldRenderProviderConfigContent(providerConfigExpanded, collapsible)
  const providerConfigToggleAriaLabel = getProviderConfigToggleAriaLabel(providerConfigExpanded)
  const localDiscoveryDisplay = getLocalDiscoveryDisplay(
    connectionTest,
    scanning,
    scanResult,
    Boolean(localBaseUrl.trim())
  )
  const capabilitiesLoadingDisplay = useMemo(
    () => buildCapabilitiesLoadingDisplay(capabilitiesLoadingElapsedMs),
    [capabilitiesLoadingElapsedMs]
  )
  const busyDisplay = buildBusyStateDisplay({
    phase,
    providerId: selectedProviderId,
    method: selectedMethod,
    elapsedSeconds,
    canceling,
  })
  const canSubmit = canSubmitSelection({
    phase,
    providerId: selectedProviderId,
    method: selectedMethod,
    secret: apiKey,
    selectedExtraOption,
    customConfig: {
      baseUrl: customBaseUrl,
      modelId: customModelId,
      providerId: customProviderId,
      compatibility: customCompatibility,
    },
  })

  const applyLoadedCapabilities = (
    loaded: OpenClawCapabilities,
    previousSelection: { providerId?: string; methodId?: string } = {}
  ): boolean => {
    setCapabilities(loaded)
    const nextProviders = buildProviderOptions(loaded, providerNames)
    if (nextProviders.length === 0) {
      setPhase('error')
      setError(
        toUserFacingCliFailureMessage({
          stderr: loaded.authRegistry.message,
          fallback: '未发现可用认证方式，请确认 OpenClaw 命令行工具已正确安装。',
        })
      )
      return false
    }

    if (!loaded.authRegistry.ok) {
      setError('当前 OpenClaw 元数据不完整，已降级展示可识别的认证方式。')
    }

    const nextSelection = resolveNextProviderMethodSelection(nextProviders, previousSelection)
    setSelectedProviderId(nextSelection.providerId)
    setSelectedMethodId(nextSelection.methodId)
    setPhase('ready')
    return true
  }

  useEffect(() => {
    if (phase !== 'loading') {
      setCapabilitiesLoadingElapsedMs(0)
      return
    }

    const startedAt = Date.now()
    setCapabilitiesLoadingElapsedMs(0)
    const timer = setInterval(() => {
      setCapabilitiesLoadingElapsedMs(Date.now() - startedAt)
    }, 120)

    return () => clearInterval(timer)
  }, [phase])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setPhase('loading')
      setError('')
      try {
        const loaded = await window.api.getModelCapabilities()
        if (cancelled) return
        applyLoadedCapabilities(loaded)
      } catch (e: any) {
        if (cancelled) return
        setPhase('error')
        setError(toUserFacingUnknownErrorMessage(e, '读取模型能力失败'))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [providerNames])

  useEffect(() => {
    let cancelled = false
    if (!showSkipWhenConfigured) {
      setShowSkipButton(false)
      return
    }

    ;(async () => {
      try {
        const [statusResult, configData] = await Promise.all([
          window.api.getModelStatus(),
          window.api.readConfig(),
        ])
        if (cancelled) return
        setShowSkipButton(
          shouldShowSkipButton(
            showSkipWhenConfigured,
            statusResult.ok ? (statusResult.data as Record<string, any> | null | undefined) : null,
            configData
          )
        )
      } catch {
        if (!cancelled) setShowSkipButton(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [showSkipWhenConfigured])

  useEffect(() => {
    if (!selectedProvider) return
    if (selectedProvider.methods.some((method) => method.id === selectedMethodId)) return
    setSelectedMethodId(selectedProvider.methods[0]?.id || '')
  }, [selectedProvider, selectedMethodId])

  useEffect(() => {
    setApiKey('')
    setSelectedExtraOption('')
    setCustomBaseUrl('')
    setCustomModelId('')
    setCustomProviderId('')
    setCustomCompatibility('openai')
    setStatusText('')
    setError('')
    // Reset local provider state
    setConnectionTest({ testing: false })
    setScanResult(null)
    setScanning(false)
    setLocalApiKey('')
    setSelectedLocalModel('')
    if (isLocalProvider(selectedProviderId)) {
      const defaults = LOCAL_PROVIDER_DEFAULTS[selectedProviderId]
      setLocalBaseUrl(defaults?.baseUrl || '')
    } else {
      setLocalBaseUrl('')
    }
  }, [selectedProviderId, selectedMethodId])

  useEffect(() => {
    if (!requiresExtraOption || !selectedMethod?.route.extraOptions?.length) {
      if (selectedExtraOption) setSelectedExtraOption('')
      return
    }
    const normalizedSelected = normalizeMethodId(selectedExtraOption)
    if (
      normalizedSelected &&
      selectedMethod.route.extraOptions.some((option) => normalizeMethodId(option.id) === normalizedSelected)
    ) {
      return
    }
    setSelectedExtraOption('')
  }, [requiresExtraOption, selectedExtraOption, selectedMethod])

  useEffect(() => {
    if (!busy) {
      busyStartedAtRef.current = null
      setElapsedSeconds(0)
      setCanceling(false)
      return
    }

    if (busyStartedAtRef.current === null) {
      busyStartedAtRef.current = Date.now()
      setElapsedSeconds(0)
    }

    const timer = setInterval(() => {
      const started = busyStartedAtRef.current || Date.now()
      setElapsedSeconds(Math.max(0, Math.floor((Date.now() - started) / 1000)))
    }, UI_RUNTIME_DEFAULTS.authVerification.elapsedTickMs)

    return () => clearInterval(timer)
  }, [busy])

  useEffect(() => {
    if (!showOAuthFallbackPanel) {
      setManualOAuthUrl('')
      setManualOAuthCode('')
      setOpeningOAuthUrl(false)
    }
  }, [showOAuthFallbackPanel])

  useEffect(() => {
    let cancelled = false
    setOAuthDependencyAction(null)
    setOAuthDependencyWarnings([])

    if (!selectedMethodId) return () => {
      cancelled = true
    }

    ;(async () => {
      try {
        const inspection = await window.api.inspectOAuthDependency(selectedMethodId)
        if (cancelled) return
        setOAuthDependencyAction(inspection.ready ? null : inspection.action || null)
        setOAuthDependencyWarnings((inspection.warnings || []) as OAuthExternalDependencyWarning[])
      } catch {
        if (cancelled) return
        setOAuthDependencyAction(null)
        setOAuthDependencyWarnings([])
      }
    })()

    return () => {
      cancelled = true
    }
  }, [selectedMethodId])

  useEffect(() => {
    const offState = window.api.onOAuthState((payload: OAuthStateEventPayload) => {
      if (!payload) return
      if (payload.state === 'preparing') {
        setStatusText('正在准备浏览器授权登录...')
        return
      }
      if (payload.state === 'plugin-ready') {
        setStatusText('认证插件已就绪，正在请求授权链接...')
        return
      }
      if (payload.state === 'opening-browser') {
        setStatusText('正在拉起浏览器...')
        return
      }
      if (payload.state === 'waiting-for-approval') {
        setStatusText('授权流程已开始。若浏览器未自动拉起，请使用下方链接继续授权。')
        return
      }
      if (payload.state === 'browser-open-failed') {
        setStatusText('未能自动拉起浏览器，请使用下方链接手动授权。')
      }
    })
    const offCode = window.api.onOAuthCode((payload: OAuthCodeEventPayload) => {
      if (!payload) return
      setManualOAuthUrl(String(payload.verificationUri || '').trim())
      setManualOAuthCode(String(payload.userCode || '').trim())
      setStatusText('已获取授权链接。若浏览器未自动拉起，请使用下方链接和验证码继续授权。')
    })
    const offSuccess = window.api.onOAuthSuccess(() => {
      setStatusText('浏览器授权登录已完成，正在保存配置...')
    })
    const offError = window.api.onOAuthError((payload: { stderr?: string; stdout?: string }) => {
      const candidateMessage = toUserFacingCliFailureMessage({
        stderr: payload?.stderr,
        stdout: payload?.stdout,
        fallback: '浏览器授权登录失败，请重试。',
      })

      if (
        shouldSuppressModelCenterSecondaryNetworkBanner({
          postAuthRecoveryLocked: postAuthRecoveryRefreshLockedRef.current,
          primaryMessage: errorRef.current || warningRef.current,
          candidateMessage,
          candidateStderr: payload?.stderr,
          candidateStdout: payload?.stdout,
        })
      ) {
        void appendModelCenterDiagnosticLog({
          event: 'secondary-network-banner-suppressed',
          providerId: selectedProviderIdRef.current,
          methodId: selectedMethodIdRef.current || undefined,
          details: {
            source: 'oauth-error-listener',
            primaryMessage: errorRef.current || warningRef.current || undefined,
            candidateMessage,
          },
        })
        return
      }

      setError(appendRetryRefreshHint(candidateMessage))
    })

    return () => {
      offState()
      offCode()
      offSuccess()
      offError()
    }
  }, [])

  const handleRefreshCapabilities = async () => {
    if (refreshGuard.blocked) {
      if (refreshGuard.statusText) {
        setStatusText(refreshGuard.statusText || '正在同步认证结果，请稍候...')
      }
      return
    }
    const previousSelection = {
      providerId: selectedProviderId,
      methodId: selectedMethodId,
    }

    setRefreshingCapabilities(true)
    setPhase('loading')
    setError('')
    setStatusText('')
    setOAuthDependencyAction(null)

    try {
      const refreshed = await refreshModelCapabilitiesData(window.api.refreshModelData)
      const applied = applyLoadedCapabilities(refreshed.capabilities, previousSelection)
      if (!applied) return

      if (showSkipWhenConfigured) {
        try {
          const configData = await window.api.readConfig()
          const refreshedStatus = refreshed.status?.ok
            ? (refreshed.status.data as Record<string, any> | null | undefined)
            : null
          setShowSkipButton(
            shouldShowSkipButton(
              showSkipWhenConfigured,
              refreshedStatus,
              configData
            )
          )
        } catch {
          setShowSkipButton(false)
        }
      }
    } catch (e: any) {
      setPhase('error')
      setError(toUserFacingUnknownErrorMessage(e, '刷新模型能力失败，请稍后重试。'))
    } finally {
      setRefreshingCapabilities(false)
    }
  }

  const handleLocalTestConnection = async () => {
    if (!isLocal || !localBaseUrl.trim()) return
    setConnectionTest({ testing: true })
    setScanResult(null)
    setSelectedLocalModel('')
    try {
      const result = await window.api.testLocalConnection({
        provider: selectedProviderId as 'ollama' | 'vllm' | 'custom-openai',
        baseUrl: localBaseUrl.trim(),
        apiKey: localApiKey.trim() || undefined,
      })
      setConnectionTest({ testing: false, result })

      // Auto-scan models on successful connection
      if (result.ok) {
        setScanning(true)
        try {
          const scanRes = await window.api.scanLocalModels({
            provider: selectedProviderId,
            baseUrl: localBaseUrl.trim() || undefined,
            apiKey: localApiKey.trim() || undefined,
            timeoutMs: 120_000,
          })
          if (scanRes.ok) {
            const models = normalizeLocalScanModelOptions(scanRes.data, selectedProviderId)
            setScanResult({ ok: true, modelCount: models.length, models })
            if (models.length > 0) {
              setSelectedLocalModel(models[0].key)
            }
          } else {
            setScanResult({
              ok: false,
              error:
                scanRes.message ||
                toUserFacingCliFailureMessage({
                  stderr: scanRes.stderr,
                  fallback: '模型扫描失败',
                }),
            })
          }
        } catch (e: any) {
          setScanResult({ ok: false, error: toUserFacingUnknownErrorMessage(e, '模型扫描失败') })
        } finally {
          setScanning(false)
        }
      }
    } catch (e: any) {
      setConnectionTest({
        testing: false,
        result: { ok: false, reachable: false, error: toUserFacingUnknownErrorMessage(e, '连接测试失败') },
      })
    }
  }

  const handleLocalScanModels = async () => {
    if (!isLocal || scanning) return
    setScanning(true)
    setScanResult(null)
    setSelectedLocalModel('')
    setError('')
    try {
      const result = await window.api.scanLocalModels({
        provider: selectedProviderId,
        baseUrl: localBaseUrl.trim() || undefined,
        apiKey: localApiKey.trim() || undefined,
        timeoutMs: 120_000,
      })
      if (result.ok) {
        const models = normalizeLocalScanModelOptions(result.data, selectedProviderId)
        setScanResult({ ok: true, modelCount: models.length, models })
        if (models.length > 0) {
          setSelectedLocalModel(models[0].key)
        }
      } else {
        setScanResult({
          ok: false,
          error:
            result.message ||
            toUserFacingCliFailureMessage({
              stderr: result.stderr,
              fallback: '模型扫描失败',
            }),
        })
      }
    } catch (e: any) {
      setScanResult({ ok: false, error: toUserFacingUnknownErrorMessage(e, '模型扫描失败') })
    } finally {
      setScanning(false)
    }
  }

  const handleLocalProviderSubmit = async () => {
    if (!isLocal) return
    if (!selectedLocalModel) {
      setError('请先发现模型并选择一个默认模型')
      return
    }
    setError('')
    setWarning('')
    setPhase('authing')
    setStatusText('正在写入环境变量...')

    try {
      // Write env vars if needed
      const envUpdates = buildLocalProviderEnvUpdatesForSubmit({
        providerId: selectedProviderId,
        baseUrl: localBaseUrl,
        apiKey: localApiKey,
      })
      if (Object.keys(envUpdates).length > 0) {
        await window.api.writeLocalModelEnv(envUpdates)
      }

      // Ensure auth profile exists for local provider (Gateway requires it)
      setStatusText('正在写入认证配置...')
      const authResult = await window.api.ensureLocalAuthProfile({
        provider: selectedProviderId as 'ollama' | 'vllm' | 'custom-openai',
        apiKey: localApiKey.trim() || undefined,
      })
      if (!authResult.ok) {
        setPhase('ready')
        setStatusText('')
        setError(
          toUserFacingCliFailureMessage({
            stderr: authResult.error,
            fallback: '写入认证配置失败',
          })
        )
        return
      }

      setStatusText('正在写入本地 Provider 配置...')
      const currentConfig = await window.api.readConfig()
      const nextConfig = buildNextConfigWithLocalProviderSnapshot({
        currentConfig,
        providerId: selectedProviderId,
        baseUrl: localBaseUrl,
        selectedModelKey: selectedLocalModel,
        discoveredModels: scanResult?.models || [],
      })
      const writeResult = await window.api.applyConfigPatchGuarded({
        beforeConfig: currentConfig,
        afterConfig: nextConfig,
        reason: 'unknown',
      })
      if (!writeResult.ok) {
        setPhase('ready')
        setStatusText('')
        setError(
          toUserFacingCliFailureMessage({
            stderr: writeResult.message,
            fallback: '写入本地 Provider 配置失败',
          })
        )
        return
      }

      setStatusText('正在应用默认模型...')
      const applyResult = await applyDefaultModelWithGatewayReload({
        model: selectedLocalModel,
        readConfig: () => window.api.readConfig(),
        readUpstreamState: () => window.api.getModelUpstreamState(),
        applyUpstreamModelWrite: (request) => window.api.applyModelConfigViaUpstream(request),
        applyConfigPatchGuarded: (request) => window.api.applyConfigPatchGuarded(request),
        getModelStatus: () => window.api.getModelStatus(),
        reloadGatewayAfterModelChange: () => window.api.reloadGatewayAfterModelChange(),
      })
      if (!applyResult.ok) {
        setPhase('ready')
        setStatusText('')
        setError(
          toUserFacingCliFailureMessage({
            stderr: applyResult.message,
            fallback: '设置默认模型失败',
          })
        )
        return
      }

      setPhase('ready')
      setStatusText('')
      onConfigured({
        providerId: selectedProviderId,
        methodId: 'local',
        methodType: 'custom',
        providerStatusIds: [selectedProviderId],
        needsInitialization: false,
        preferredModelKey: selectedLocalModel,
      })
    } catch (e: any) {
      setPhase('ready')
      setStatusText('')
      setError(toUserFacingUnknownErrorMessage(e, '本地模型配置失败'))
    }
  }

  const handleSubmit = async () => {
    if (!canSubmit || !selectedMethod) return
    const authAttemptId = ++authAttemptIdRef.current
    let releaseRecoveryLockInFinally = true
    const shouldDropAsyncResult = () =>
      shouldIgnorePostAuthAsyncResult({
        attemptId: authAttemptId,
        currentAttemptId: authAttemptIdRef.current,
        mounted: mountedRef.current,
        cancelRequested: cancelRequestedRef.current,
      })
    const shouldReleaseRecoveryLock = () =>
      shouldReleasePostAuthRecoveryLock({
        attemptId: authAttemptId,
        currentAttemptId: authAttemptIdRef.current,
        mounted: mountedRef.current,
      })
    cancelRequestedRef.current = false
    setPostAuthRecoveryRefreshLocked(false)
    setCanceling(false)
    setError('')
    setWarning('')
    setStatusText('')
    setOAuthDependencyAction(null)
    setPhase('authing')

    const applyCanceledState = () => {
      setPhase(getPhaseAfterCancellation())
      setStatusText('')
      setError('已取消当前操作，您可以修改配置后继续安装。')
    }
    const applyAuthFailureState = (message: string) => {
      setPhase(getPhaseAfterAuthFailure())
      setStatusText('')
      setError(appendRetryRefreshHint(message))
    }

    try {
      await captureModelCenterDiagnosticSnapshot({
        event: 'submit-start',
        providerId: selectedProviderId,
        methodId: selectedMethod.id,
        attemptId: authAttemptId,
        details: {
          methodKind: selectedMethod.kind,
          requiresBrowser,
          requiresCustomConfig,
          selectedExtraOption: selectedExtraOption || undefined,
          preferRuntimeModelSignals: shouldPreferRuntimeModelSignalsAfterAuth(selectedMethod),
          deferPostAuthDefaultModelApply: shouldDeferPostAuthDefaultModelApply(selectedMethod),
          requireBlockingPostAuthVerification: shouldRequireBlockingPostAuthVerification(selectedMethod),
        },
      })
      setStatusText(
        requiresBrowser ? '正在准备浏览器授权登录...' : requiresCustomConfig ? '正在写入自定义提供商配置...' : '正在执行认证...'
      )
      const authResult = await executeRemoteModelAuthSubmission(
        {
          providerId: selectedProviderId,
          method: selectedMethod,
          secret: apiKey.trim(),
          selectedExtraOption,
          customConfig: {
            baseUrl: customBaseUrl,
            modelId: customModelId,
            providerId: customProviderId,
            compatibility: customCompatibility,
          },
        },
        {
          startModelOAuth: window.api.startModelOAuth,
          runModelAuth: window.api.runModelAuth,
        }
      )

      if (cancelRequestedRef.current) {
        setPostAuthRecoveryRefreshLocked(false)
        applyCanceledState()
        return
      }
      await appendModelCenterDiagnosticLog({
        event: 'submit-auth-result',
        providerId: selectedProviderId,
        methodId: selectedMethod.id,
        attemptId: authAttemptId,
        details: buildSubmitAuthResultDiagnosticDetails(authResult),
      })
      if (!authResult.ok) {
        setPostAuthRecoveryRefreshLocked(false)
        await captureModelCenterDiagnosticSnapshot({
          event: 'submit-failed-state',
          providerId: selectedProviderId,
          methodId: selectedMethod.id,
          attemptId: authAttemptId,
          details: {
            errorCode: 'errorCode' in authResult ? authResult.errorCode : undefined,
            message: 'message' in authResult ? authResult.message : undefined,
          },
        })
        if ('preflightAction' in authResult && authResult.preflightAction) {
          setOAuthDependencyAction(authResult.preflightAction as OAuthExternalDependencyPreflightAction)
        }
        if ('preflightWarnings' in authResult && Array.isArray(authResult.preflightWarnings)) {
          setOAuthDependencyWarnings(authResult.preflightWarnings as OAuthExternalDependencyWarning[])
        }
        applyAuthFailureState(
          toUserFacingCliFailureMessage({
            stderr: authResult.message || authResult.stderr,
            stdout: authResult.stdout,
            fallback: '认证失败，请检查 API Key 或认证配置。',
          })
        )
        return
      }

      const shouldGateRefresh = shouldGateRefreshDuringPostAuthRecovery(
        'postAuthRuntime' in authResult ? authResult.postAuthRuntime : undefined
      )
      const verificationPollPolicy = resolveAuthVerificationPollPolicy(
        resolvePostAuthVerificationProfile('postAuthRuntime' in authResult ? authResult.postAuthRuntime : undefined)
      )
      const controlUiTimeoutProfile = resolveControlUiTimeoutProfile(
        'postAuthRuntime' in authResult ? authResult.postAuthRuntime : undefined
      )
      const controlUiTimeoutOptions = resolveControlUiTimeoutOptions(controlUiTimeoutProfile)
      if (shouldGateRefresh) {
        setPostAuthRecoveryRefreshLocked(true)
      }

      let verified = false
      let verifiedProviderId = selectedProviderId
      let customVerificationResult: CustomProviderConfigMatchResult | null = null
      if (shouldRequireBlockingPostAuthVerification(selectedMethod)) {
        setPhase('verifying')
        setStatusText('正在验证认证结果...')
        if (requiresCustomConfig) {
          customVerificationResult = await verifyCustomProviderWithPolling(
            {
              baseUrl: customBaseUrl,
              modelId: customModelId,
              providerId: customProviderId,
              compatibility: customCompatibility,
            },
            {
              pollPolicy: verificationPollPolicy,
              shouldAbort: () => cancelRequestedRef.current,
              onAttempt: (attempt) => {
                setStatusText(`正在验证自定义提供商配置（第 ${attempt} 次检查）...`)
              },
            }
          )
          verified = customVerificationResult.status === 'matched'
          if (customVerificationResult.status === 'matched') {
            verifiedProviderId = customVerificationResult.providerId
          }
        } else {
          verified = await verifyProviderWithPolling(buildVerificationProviderCandidates(selectedProviderId, selectedMethod), {
            browserOAuthPersistenceFallback: requiresBrowser,
            preferRuntimeModelSignals: shouldPreferRuntimeModelSignalsAfterAuth(selectedMethod),
            pollPolicy: verificationPollPolicy,
            controlUiTimeoutOptions,
            shouldAbort: () => cancelRequestedRef.current,
            onAttempt: (attempt) => {
              setStatusText(`正在验证认证结果（第 ${attempt} 次检查）...`)
            },
          })
        }
        if (cancelRequestedRef.current) {
          setPostAuthRecoveryRefreshLocked(false)
          applyCanceledState()
          return
        }
        if (customVerificationResult?.status === 'ambiguous') {
          setPostAuthRecoveryRefreshLocked(false)
          await captureModelCenterDiagnosticSnapshot({
            event: 'blocking-verification-ambiguous',
            providerId: selectedProviderId,
            methodId: selectedMethod.id,
            attemptId: authAttemptId,
            details: {},
          })
          applyAuthFailureState(CUSTOM_PROVIDER_AMBIGUOUS_ERROR_MESSAGE)
          return
        }
        if (!verified) {
          setPostAuthRecoveryRefreshLocked(false)
          await captureModelCenterDiagnosticSnapshot({
            event: 'blocking-verification-failed',
            providerId: selectedProviderId,
            methodId: selectedMethod.id,
            attemptId: authAttemptId,
            details: {
              verified,
              verifiedProviderId,
            },
          })
          applyAuthFailureState('认证结果尚未生效，请重试或检查网络后再试。')
          return
        }
      } else {
        verified = true
      }

      const providerCandidates = requiresCustomConfig
        ? [verifiedProviderId]
        : buildVerificationProviderCandidates(selectedProviderId, selectedMethod)
      let gatewayReloadWarning = ''
      const shouldRepairLegacyMiniMaxAliases =
        requiresBrowser && providerCandidates.includes('minimax') && providerCandidates.includes('minimax-portal')
      const shouldApplyPreferredModelAfterAuth = !requiresBrowser
      const shouldQueueDeferredDefaultModelApply =
        shouldApplyPreferredModelAfterAuth && shouldDeferPostAuthDefaultModelApply(selectedMethod)
      const shouldScheduleDeferredDefaultModelApply =
        shouldQueueDeferredDefaultModelApply && !cancelRequestedRef.current
      const holdPostAuthRecoveryLockUntilDeferredApply = shouldHoldPostAuthRecoveryLockUntilDeferredApply({
        postAuthRecoveryLocked: shouldGateRefresh,
        stayOnConfigured,
        shouldQueueDeferredDefaultModelApply: shouldScheduleDeferredDefaultModelApply,
      })
      let preferredModelKey = ''
      if (shouldApplyPreferredModelAfterAuth && !shouldQueueDeferredDefaultModelApply) {
        preferredModelKey = await tryResolveDefaultModelForProvider(providerCandidates, controlUiTimeoutOptions)
        if (shouldDropAsyncResult()) return
      }
      if (
        shouldApplyPreferredModelAfterAuth &&
        !shouldQueueDeferredDefaultModelApply &&
        preferredModelKey &&
        !cancelRequestedRef.current
      ) {
        setStatusText('正在应用默认模型...')
        const applyResult = await applyDefaultModelWithGatewayReload({
          model: preferredModelKey,
          readConfig: () => window.api.readConfig(),
          readUpstreamState: () => window.api.getModelUpstreamState(controlUiTimeoutOptions),
          applyUpstreamModelWrite: (request) => window.api.applyModelConfigViaUpstream({
            ...request,
            ...controlUiTimeoutOptions,
          }),
          applyConfigPatchGuarded: (request) => window.api.applyConfigPatchGuarded(request),
          getModelStatus: () => window.api.getModelStatus(),
          reloadGatewayAfterModelChange: () => window.api.reloadGatewayAfterModelChange(),
          confirmationPolicy: verificationPollPolicy,
        })
        if (shouldDropAsyncResult()) return
        if (!applyResult?.ok) {
          gatewayReloadWarning = toUserFacingCliFailureMessage({
            stderr: applyResult?.message,
            fallback: '认证已完成，但默认模型尚未完全生效。',
          })
          setStatusText(gatewayReloadWarning)
        }
        await captureModelCenterDiagnosticSnapshot({
          event: 'immediate-default-model-apply',
          providerId: verifiedProviderId,
          methodId: selectedMethod.id,
          attemptId: authAttemptId,
          details: {
            preferredModelKey,
            ok: applyResult?.ok,
            message: applyResult?.message,
            writeSource: applyResult?.writeSource,
            upstreamFallbackReason: applyResult?.upstreamFallbackReason,
          },
        })
      }
      if (shouldRepairLegacyMiniMaxAliases && !cancelRequestedRef.current) {
        setStatusText('正在同步历史 MiniMax 配置...')
        const repairResult = await repairLegacyMiniMaxAliasConfigAfterOAuth({
          readConfig: () => window.api.readConfig(),
          readUpstreamState: () => window.api.getModelUpstreamState(controlUiTimeoutOptions),
          applyUpstreamModelWrite: (request) => window.api.applyModelConfigViaUpstream({
            ...request,
            ...controlUiTimeoutOptions,
          }),
        })
        if (shouldDropAsyncResult()) return
        if (repairResult.reason === 'partial-failure') {
          gatewayReloadWarning = joinModelCenterNonBlockingMessages(
            gatewayReloadWarning,
            `MiniMax 历史配置只完成了部分迁正：${repairResult.message || '请稍后手动刷新'}`
          )
        }
      }
      const context: SetupModelContext = {
        providerId: verifiedProviderId,
        methodId: selectedMethod.id,
        methodType: selectedMethod.kind,
        providerStatusIds: requiresCustomConfig
          ? [verifiedProviderId].filter(Boolean)
          : buildVerificationProviderCandidates(selectedProviderId, selectedMethod),
        needsInitialization: false,
        preferredModelKey: preferredModelKey || undefined,
      }
      await captureModelCenterDiagnosticSnapshot({
        event: 'configured-context',
        providerId: verifiedProviderId,
        methodId: selectedMethod.id,
        attemptId: authAttemptId,
        details: {
          verified,
          providerCandidates,
          preferredModelKey: preferredModelKey || undefined,
          shouldQueueDeferredDefaultModelApply,
          gatewayReloadWarning: gatewayReloadWarning || undefined,
          context,
        },
      })
      if (shouldDropAsyncResult()) return
      setStatusText('配置成功，正在进入下一步...')
      if (shouldScheduleDeferredDefaultModelApply) {
        void (async () => {
          try {
            const deferredPreferredModelKey = await tryResolveDefaultModelForProvider(
              providerCandidates,
              controlUiTimeoutOptions
            ).catch(() => '')
            if (
              !deferredPreferredModelKey
              || cancelRequestedRef.current
              || authAttemptIdRef.current !== authAttemptId
            ) {
              return
            }

            const applyResult = await applyDefaultModelWithGatewayReload({
              model: deferredPreferredModelKey,
              readConfig: () => window.api.readConfig(),
              readUpstreamState: () => window.api.getModelUpstreamState(controlUiTimeoutOptions),
              applyUpstreamModelWrite: (request) => window.api.applyModelConfigViaUpstream({
                ...request,
                ...controlUiTimeoutOptions,
              }),
              applyConfigPatchGuarded: (request) => window.api.applyConfigPatchGuarded(request),
              getModelStatus: () => window.api.getModelStatus(),
              reloadGatewayAfterModelChange: () => window.api.reloadGatewayAfterModelChange(),
              confirmationPolicy: verificationPollPolicy,
            }).catch((error: any) => ({
              ok: false,
              message: toUserFacingUnknownErrorMessage(error, '认证已完成，但默认模型尚未完全生效。'),
            }))

            if (
              applyResult?.ok
              || !mountedRef.current
              || !stayOnConfigured
              || authAttemptIdRef.current !== authAttemptId
            ) {
              return
            }

            const deferredWarning = toUserFacingCliFailureMessage({
              stderr: applyResult?.message,
              fallback: '认证已完成，但默认模型尚未完全生效。',
            })
            if (!deferredWarning) return
            const mergedWarning = mergeModelCenterNonBlockingMessagesWithPriority({
              currentMessage: warningRef.current || gatewayReloadWarning,
              candidateMessage: deferredWarning,
              candidateStderr: applyResult?.message,
              postAuthRecoveryLocked: postAuthRecoveryRefreshLockedRef.current,
            })
            if (mergedWarning.suppressed) {
              await appendModelCenterDiagnosticLog({
                event: 'secondary-network-banner-suppressed',
                providerId: verifiedProviderId,
                methodId: selectedMethod.id,
                attemptId: authAttemptId,
                details: {
                  source: 'deferred-default-model-apply',
                  primaryMessage: warningRef.current || gatewayReloadWarning || undefined,
                  candidateMessage: deferredWarning,
                },
              })
              return
            }

            setWarning(mergedWarning.message)
            await captureModelCenterDiagnosticSnapshot({
              event: 'deferred-default-model-apply',
              providerId: verifiedProviderId,
              methodId: selectedMethod.id,
              attemptId: authAttemptId,
              details: {
                preferredModelKey: deferredPreferredModelKey,
                ok: applyResult?.ok,
                message: applyResult?.message,
                warning: deferredWarning,
              },
            })
          } finally {
            if (holdPostAuthRecoveryLockUntilDeferredApply && shouldReleaseRecoveryLock()) {
              setPostAuthRecoveryRefreshLocked(false)
            }
          }
        })()
      }
      if (stayOnConfigured) {
        if (shouldDropAsyncResult()) return
        setPhase('ready')
        setWarning(gatewayReloadWarning)
        setStatusText(configuredMessage || '配置成功')
        releaseRecoveryLockInFinally = false
        const releasedBeforeCallback = !holdPostAuthRecoveryLockUntilDeferredApply && shouldReleaseRecoveryLock()
        if (releasedBeforeCallback) {
          setPostAuthRecoveryRefreshLocked(false)
        }
        Promise.resolve(onConfigured(context)).catch((callbackError: any) => {
          const message = toUserFacingCliFailureMessage({
            stderr: String(callbackError?.message || '').trim(),
            fallback: '',
          })
          if (message) {
            if (shouldDropAsyncResult()) return
            const callbackPostAuthRecoveryLocked = resolvePostAuthRecoveryLockForConfiguredCallback({
              postAuthRecoveryLocked: postAuthRecoveryRefreshLockedRef.current,
              releasedBeforeCallback,
            })
            const callbackWarning = `模型信息已保存，但状态刷新失败：${message}`
            const mergedWarning = mergeModelCenterNonBlockingMessagesWithPriority({
              currentMessage: warningRef.current || gatewayReloadWarning,
              candidateMessage: callbackWarning,
              candidateStderr: String(callbackError?.message || '').trim(),
              postAuthRecoveryLocked: callbackPostAuthRecoveryLocked,
            })
            if (mergedWarning.suppressed) {
              void appendModelCenterDiagnosticLog({
                event: 'secondary-network-banner-suppressed',
                providerId: verifiedProviderId,
                methodId: selectedMethod.id,
                attemptId: authAttemptId,
                details: {
                  source: 'on-configured-callback',
                  primaryMessage: warningRef.current || gatewayReloadWarning || undefined,
                  candidateMessage: callbackWarning,
                },
              })
              return
            }
            setWarning(mergedWarning.message)
          }
        })
        return
      }
      if (shouldDropAsyncResult()) return
      releaseRecoveryLockInFinally = false
      if (!holdPostAuthRecoveryLockUntilDeferredApply && shouldReleaseRecoveryLock()) {
        setPostAuthRecoveryRefreshLocked(false)
      }
      void Promise.resolve(onConfigured(context))
    } catch (e: any) {
      if (cancelRequestedRef.current) {
        if (shouldReleaseRecoveryLock()) {
          setPostAuthRecoveryRefreshLocked(false)
        }
        applyCanceledState()
        return
      }
      applyAuthFailureState(toUserFacingUnknownErrorMessage(e, '认证失败，请稍后重试。'))
    } finally {
      if (releaseRecoveryLockInFinally && shouldReleaseRecoveryLock()) {
        setPostAuthRecoveryRefreshLocked(false)
      }
    }
  }

  const handleCancel = async () => {
    if (!busy || canceling) return
    cancelRequestedRef.current = true
    setCanceling(true)
    setStatusText('正在取消当前操作...')
    try {
      if (requiresBrowser) {
        await window.api.cancelModelOAuth()
      } else {
        await window.api.cancelCommandDomain('oauth')
      }
    } catch {
      // ignore cancellation errors and keep local state in control
    } finally {
      setPhase(getPhaseAfterCancellation())
      setStatusText('')
      setError('已取消当前操作，您可以修改配置后继续安装。')
      setCanceling(false)
    }
  }

  const handleOpenOAuthUrl = async () => {
    if (!canOpenManualLink) return
    setOpeningOAuthUrl(true)
    try {
      const result = await window.api.openOAuthUrl(manualOAuthUrl || undefined)
      if (!result.ok) {
        setError(
          toUserFacingCliFailureMessage({
            stderr: result.stderr,
            stdout: result.stdout,
            fallback: '尚未获取到授权链接，请稍候 1-2 秒后重试。',
          })
        )
      }
    } catch (e: any) {
      setError(toUserFacingUnknownErrorMessage(e, '打开授权链接失败，请复制链接到浏览器手动打开。'))
    } finally {
      setOpeningOAuthUrl(false)
    }
  }

  const handleInstallOAuthDependency = async () => {
    if (!oauthDependencyAction || installingOAuthDependency) return
    const installOption = recommendedDependencyInstallOption
    if (!installOption) {
      setError('当前环境未发现可用的一键安装方式。请先确认 npm 命令可用；如果计划使用 Homebrew，请先修复其安装目录权限后再试。')
      return
    }

    const confirmed = window.confirm(
      `${oauthDependencyAction.message}\n\n将执行：${installOption.commandPreview}\n\n确认现在安装吗？`
    )
    if (!confirmed) return

    setInstallingOAuthDependency(true)
    setStatusText(`正在安装 ${oauthDependencyAction.title}...`)
    setError('')

    try {
      const result = await window.api.installOAuthDependency({
        dependencyId: oauthDependencyAction.dependencyId,
        method: installOption.method,
      })
      if (!result.ok) {
        setStatusText('')
        setError(
          result.message ||
            toUserFacingCliFailureMessage({
              stderr: result.stderr,
              stdout: result.stdout,
              fallback: `${oauthDependencyAction.title}失败`,
            })
        )
        return
      }

      setOAuthDependencyAction(null)
      setStatusText(result.message || `${oauthDependencyAction.title}已安装完成，请重新发起认证。`)
    } catch (e: any) {
      setStatusText('')
      setError(toUserFacingUnknownErrorMessage(e, `${oauthDependencyAction.title}失败`))
    } finally {
      setInstallingOAuthDependency(false)
    }
  }

  const handleSkip = () => {
    if (!showSkipButton || interactionLocked) return
    void Promise.resolve(onConfigured(buildSkipSetupContext())).catch((callbackError: any) => {
      const message = String(callbackError?.message || '').trim()
      if (message) {
        setError(`跳过失败：${message}`)
      }
    })
  }

  return (
    <div className="w-full">
      <div className="mb-1 flex items-center justify-between gap-3">
        <Title order={2} size="lg" fw={600} className="app-text-primary">配置 AI 提供商</Title>
        <div className="flex items-center gap-2">
          {onCancel && (
            <Button
              variant="default"
              size="xs"
              onClick={onCancel}
            >
              取消
            </Button>
          )}
          <Button
            variant="default"
            size="xs"
            aria-label="刷新模型能力"
            title="刷新模型能力"
            onClick={handleRefreshCapabilities}
            disabled={refreshGuard.disabled}
          >
            {refreshingCapabilities ? '刷新中...' : '刷新'}
          </Button>
          {collapsible && (
            <Button
              variant="default"
              size="xs"
              aria-label={providerConfigToggleAriaLabel}
              title={providerConfigToggleAriaLabel}
              onClick={() => setProviderConfigExpanded((expanded) => !expanded)}
              className="!w-8 !px-0 text-lg font-semibold leading-none"
            >
              {providerConfigExpanded ? '-' : '+'}
            </Button>
          )}
        </div>
      </div>

      {showProviderConfigContent && (
        <>
          {phase === 'loading' && (
            <div className="mb-5 max-w-xl rounded-xl border app-border app-bg-tertiary p-4">
              <div className="mb-3 flex items-center justify-between text-[11px] app-text-muted">
                <span className="font-medium uppercase tracking-[0.18em]">
                  {capabilitiesLoadingDisplay.stageLabel}
                </span>
                <span>{capabilitiesLoadingDisplay.progress}%</span>
              </div>
              <div
                role="progressbar"
                aria-label={refreshingCapabilities ? '模型能力刷新进度' : '模型能力加载进度'}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={capabilitiesLoadingDisplay.progress}
                className="mb-3 h-1.5 overflow-hidden rounded-full"
                style={{ backgroundColor: 'var(--app-bg-inset)' }}
              >
                <div
                  className="h-full rounded-full transition-[width] duration-300 ease-out"
                  style={{ width: `${capabilitiesLoadingDisplay.progress}%`, backgroundColor: 'var(--mantine-color-brand-5)' }}
                />
              </div>
              <div className="flex items-start gap-3">
                <Loader size={16} color="brand" className="mt-0.5 shrink-0" />
                <div className="min-w-0">
                  <p className="text-sm font-medium app-text-secondary">
                    {refreshingCapabilities ? '正在刷新模型能力...' : '正在读取模型能力...'}
                  </p>
                  <Text size="xs" c="dimmed" mt={4}>{capabilitiesLoadingDisplay.detail}</Text>
                </div>
              </div>
            </div>
          )}

          {phase !== 'loading' && (
            <>
              <div className="mb-4">
                <Select
                  label="提供商"
                  value={selectedProviderId}
                  onChange={(value) => setSelectedProviderId(value || '')}
                  data={providers.map((provider) => ({ value: provider.id, label: provider.name }))}
                  disabled={interactionLocked}
                  size="sm"
                />
              </div>

              {isLocal ? (
                <>
                  <div className="mb-4">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                      <div className="min-w-0 flex-1">
                        <TextInput
                          label="接口地址"
                          value={localBaseUrl}
                          onChange={(e) => {
                            setLocalBaseUrl(e.currentTarget.value)
                            setConnectionTest({ testing: false })
                            setScanResult(null)
                          }}
                          placeholder={localDefaults?.baseUrl || 'http://127.0.0.1:8080/v1'}
                          disabled={interactionLocked}
                          size="sm"
                        />
                      </div>

                      <Button
                        size="sm"
                        color={localDiscoveryDisplay.buttonColor}
                        onClick={() => handleLocalTestConnection()}
                        disabled={interactionLocked || !localBaseUrl.trim() || connectionTest.testing || scanning}
                        loading={connectionTest.testing || scanning}
                        className="shrink-0 whitespace-nowrap sm:min-w-[132px]"
                      >
                        获取本地模型
                      </Button>
                    </div>

                    <Text size="xs" c={localDiscoveryDisplay.messageColor} mt={6} className="!text-[11px]">
                      {localDiscoveryDisplay.message}
                    </Text>
                  </div>

                  {localDefaults?.needsApiKey && (
                    <div className="mb-4">
                      <PasswordInput
                        label="API Key（可选）"
                        value={localApiKey}
                        onChange={(e) => setLocalApiKey(e.currentTarget.value)}
                        placeholder="留空则不使用认证"
                        disabled={interactionLocked}
                        size="sm"
                      />
                      <Text size="xs" c="dimmed" mt={4} className="!text-[11px]">
                        {selectedProviderId === 'custom-openai'
                          ? '留空时将按本地无认证 OpenAI 兼容端点处理，不发送 Authorization 头。'
                          : '留空时会写入本地注册占位 Key，帮助 OpenClaw 正确识别该 provider。'}
                      </Text>
                    </div>
                  )}

                  {scanResult && (
                    <div className="mt-2">
                      {scanResult.ok ? (
                        <>
                          <Text size="xs" c="teal">
                            {`✅ 发现 ${scanResult.modelCount ?? 0} 个模型`}
                          </Text>
                          {scanResult.models && scanResult.models.length > 0 && (
                            <div className="mt-3">
                              <Select
                                label="选择默认模型"
                                value={selectedLocalModel}
                                onChange={(value) => setSelectedLocalModel(value || '')}
                                data={scanResult.models.map((m) => ({
                                  value: m.key,
                                  label: m.name || m.key,
                                }))}
                                disabled={interactionLocked}
                                size="sm"
                              />
                            </div>
                          )}
                          {scanResult.models && scanResult.models.length === 0 && (
                            <Text size="xs" c="dimmed" mt="xs">
                              未发现可用模型，请确认本地服务已加载模型。
                            </Text>
                          )}
                        </>
                      ) : (
                        <Text size="xs" c="red">
                          {`❌ ${scanResult.error || '扫描失败'}`}
                        </Text>
                      )}
                    </div>
                  )}

                  {statusText && (
                    <Text size="xs" c="dimmed" mt="xs">{statusText}</Text>
                  )}

                  {error && (
                    <Text size="xs" c="red" mt="xs">{error}</Text>
                  )}

                  <Button
                    fullWidth
                    size="md"
                    mt="md"
                    onClick={handleLocalProviderSubmit}
                    disabled={interactionLocked || !localBaseUrl.trim() || !selectedLocalModel || busy}
                    loading={busy}
                  >
                    {busy ? '配置中...' : submitIdleLabel}
                  </Button>

                  {showSkipButton && (
                    <Button
                      fullWidth
                      variant="default"
                      size="md"
                      mt="xs"
                      onClick={handleSkip}
                      disabled={interactionLocked}
                    >
                      {skipLabel}
                    </Button>
                  )}
                </>
              ) : (
              <>
              <div className="mb-4">
                <Select
                  label="认证方式"
                  value={selectedMethodId}
                  onChange={(value) => setSelectedMethodId(value || '')}
                  data={methodOptions.map((method) => ({
                    value: method.id,
                    label: method.supported ? method.label : `${method.label}（当前版本不可用）`,
                    disabled: !method.supported,
                  }))}
                  disabled={interactionLocked}
                  size="sm"
                />
                {!selectedMethod?.supported && unsupportedReason && (
                  <div className="mt-2 rounded-lg px-2.5 py-2 text-[11px] app-text-warning" style={{ backgroundColor: 'var(--app-bg-inset)', border: '1px solid var(--app-border)' }}>
                    <span className="mr-1 inline-flex rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide" style={{ backgroundColor: 'var(--app-bg-tertiary)' }}>
                      Unsupported
                    </span>
                    {unsupportedReason}
                  </div>
                )}
                {oauthDependencyWarnings.map((warning) => (
                  <div
                    key={warning.id}
                    className="mt-2 rounded-lg px-2.5 py-2 text-[11px] app-text-secondary"
                    style={{ backgroundColor: 'var(--app-bg-inset)', border: '1px solid var(--app-border)' }}
                  >
                    <span className="mr-1 inline-flex rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide" style={{ backgroundColor: 'var(--app-bg-tertiary)' }}>
                      注意
                    </span>
                    <span className="font-medium app-text-warning">{warning.title}：</span>
                    <span className="ml-1">{warning.message}</span>
                  </div>
                ))}
              </div>

              {requiresExtraOption && selectedMethod?.route.extraOptions?.length ? (
                <div className="mb-4">
                  <Select
                    label="附加选项"
                    value={selectedExtraOption}
                    onChange={(value) => setSelectedExtraOption(value || '')}
                    data={[
                      { value: '', label: '请选择官方认证选项' },
                      ...selectedMethod.route.extraOptions.map((option) => ({
                        value: option.id,
                        label: option.label,
                      })),
                    ]}
                    disabled={interactionLocked}
                    size="sm"
                  />
                </div>
              ) : null}

              {requiresCustomConfig ? (
                <>
                  <div className="mb-4">
                    <TextInput
                      label="接口地址"
                      value={customBaseUrl}
                      onChange={(e) => setCustomBaseUrl(e.currentTarget.value)}
                      placeholder="https://gateway.example.com/v1"
                      disabled={interactionLocked}
                      size="sm"
                    />
                  </div>

                  <div className="mb-4">
                    <TextInput
                      label="Model ID"
                      value={customModelId}
                      onChange={(e) => setCustomModelId(e.currentTarget.value)}
                      placeholder="gpt-4.1-mini"
                      disabled={interactionLocked}
                      size="sm"
                    />
                  </div>

                  <div className="mb-4">
                    <Select
                      label="兼容协议"
                      value={customCompatibility}
                      onChange={(value) => setCustomCompatibility(value === 'anthropic' ? 'anthropic' : 'openai')}
                      data={[
                        { value: 'openai', label: 'OpenAI 兼容' },
                        { value: 'anthropic', label: 'Anthropic 兼容' },
                      ]}
                      disabled={interactionLocked}
                      size="sm"
                    />
                  </div>

                  <div className="mb-4">
                    <TextInput
                      label="提供商 ID（可选）"
                      value={customProviderId}
                      onChange={(e) => setCustomProviderId(e.currentTarget.value)}
                      placeholder="custom-acme"
                      disabled={interactionLocked}
                      size="sm"
                    />
                    <Text size="xs" c="dimmed" mt={4} className="!text-[11px]">
                      留空时 OpenClaw 会按 endpoint 自动生成；填写后可避免验证阶段因自动重命名产生歧义。
                    </Text>
                  </div>
                </>
              ) : null}

              {requiresSecret && (
                <div className="mb-4">
                  <PasswordInput
                    label="授权凭证"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.currentTarget.value)}
                    placeholder="输入认证密钥"
                    disabled={interactionLocked}
                    size="sm"
                  />
                </div>
              )}

              {requiresCustomConfig && (
                <div className="mb-4">
                  <PasswordInput
                    label="API Key（可选）"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.currentTarget.value)}
                    placeholder="无鉴权 endpoint 可留空"
                    disabled={interactionLocked}
                    size="sm"
                  />
                </div>
              )}

              {busy && (
                <div className="mb-4 p-3 rounded-lg" style={{ backgroundColor: 'var(--app-bg-inset)', border: '1px solid var(--app-border)' }}>
                  <div className="flex items-start gap-3">
                    <div>
                      <p className="text-sm font-medium" style={{ color: 'var(--mantine-color-brand-5)' }}>{busyDisplay.title}</p>
                      <Text size="xs" c="dimmed" mt={4}>{busyDisplay.detail}</Text>
                      <Text size="xs" c="dimmed" mt={6} className="!text-[11px]">已等待：{busyDisplay.elapsed}</Text>
                      {showOAuthFallbackPanel && (
                        <div className="mt-2 p-2 rounded" style={{ backgroundColor: 'var(--app-bg-secondary)', border: '1px solid var(--app-border)' }}>
                          <Text size="xs" className="!text-[11px] app-text-secondary">未自动拉起浏览器时，可点击下面链接手动授权：</Text>
                          <Button
                            variant="light"
                            size="compact-xs"
                            color="brand"
                            onClick={handleOpenOAuthUrl}
                            disabled={!canOpenManualLink}
                            mt={4}
                            className="!text-[11px]"
                          >
                            {openingOAuthUrl ? '打开中...' : '打开授权链接'}
                          </Button>
                          {showManualOAuthLink ? (
                            <Button
                              variant="transparent"
                              size="compact-xs"
                              onClick={handleOpenOAuthUrl}
                              disabled={!canOpenManualLink}
                              mt={4}
                              className="!text-[11px] break-all text-left underline app-text-secondary"
                            >
                              {manualOAuthUrl}
                            </Button>
                          ) : (
                            <Text size="xs" c="dimmed" mt={4} className="!text-[11px]">授权链接生成中，请稍候...</Text>
                          )}
                          {manualOAuthCode && (
                            <Text size="xs" mt={4} className="!text-[11px] app-text-secondary">
                              验证码：
                              <span className="ml-1 font-mono tracking-[0.2em]">{manualOAuthCode}</span>
                            </Text>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {statusText && (
                <div className="text-xs mb-3 rounded-lg px-2.5 py-2" style={{ color: 'var(--mantine-color-brand-5)', backgroundColor: 'var(--app-bg-inset)', border: '1px solid var(--app-border)' }}>
                  {statusText}
                </div>
              )}

              {warning && (
                <div className="text-xs mb-3 rounded-lg px-2.5 py-2" style={{ color: 'var(--mantine-color-yellow-4)', backgroundColor: 'var(--app-bg-inset)', border: '1px solid var(--mantine-color-yellow-4)' }}>
                  <Text size="xs">{warning}</Text>
                </div>
              )}

              {error && (
                <div className="text-xs mb-3 rounded-lg px-2.5 py-2" style={{ color: 'var(--mantine-color-red-5)', backgroundColor: 'var(--app-bg-inset)', border: '1px solid var(--mantine-color-red-5)' }}>
                  <Text size="xs">{error}</Text>
                  {oauthDependencyAction && recommendedDependencyInstallOption && (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <Button
                        variant="light"
                        color="red"
                        size="compact-xs"
                        onClick={handleInstallOAuthDependency}
                        disabled={interactionLocked}
                        className="!text-[11px]"
                      >
                        {installingOAuthDependency ? '安装中...' : oauthDependencyAction.title}
                      </Button>
                      <span className="text-[11px] app-text-muted">
                        {recommendedDependencyInstallOption.commandPreview}
                      </span>
                    </div>
                  )}
                </div>
              )}

              <Button
                fullWidth
                color="success"
                size="md"
                onClick={handleSubmit}
                disabled={!canSubmit || interactionLocked}
              >
                {busy ? '配置中...' : installingOAuthDependency ? '安装中...' : submitIdleLabel}
              </Button>

              {busy && (
                <Button
                  fullWidth
                  variant="light"
                  color="red"
                  size="md"
                  mt="xs"
                  onClick={handleCancel}
                  disabled={canceling}
                >
                  {canceling ? '取消中...' : '取消'}
                </Button>
              )}

              {showSkipButton && (
                <Button
                  fullWidth
                  variant="default"
                  size="md"
                  mt="xs"
                  onClick={handleSkip}
                  disabled={interactionLocked}
                >
                  {skipLabel}
                </Button>
              )}
            </>
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}

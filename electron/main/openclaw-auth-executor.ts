import type { CliResult, RunCliStreamOptions } from './cli'
import type { ReconcileActionSummary } from '../../src/shared/gateway-runtime-reconcile-state'
import type { OpenClawCapabilities } from './openclaw-capabilities'
import { createOAuthChallengeScanner } from './oauth-browser'
import { pluginEnableLooksSuccessful } from './openclaw-auth-plugins'
import {
  buildCustomProviderOnboardRouteCommand,
  buildModelsAuthLoginCommand,
  buildModelsAuthLoginGitHubCopilotCommand,
  buildModelsAuthPasteTokenCommand,
  buildModelsAuthSetupTokenCommand,
  buildOnboardRouteCommand,
  buildPluginEnableCommand,
  type CustomProviderConfigInput,
  type OpenClawCommandBuildResult,
} from './openclaw-command-builder'
import { getCliFailureMessage } from './openclaw-command-output'
import {
  type OpenClawAuthMethodDescriptor,
  type OpenClawAuthProviderDescriptor,
  type OpenClawAuthRegistry,
  type OpenClawAuthRouteDescriptor,
} from './openclaw-auth-registry'
import { normalizeAuthChoice } from './openclaw-spawn'
import { restoreTrustedPluginConfig } from './openclaw-plugin-config'
import { extractStalePluginConfigEntryIds, pruneStalePluginConfigEntries } from './openclaw-config-warnings'
import { repairKnownProviderConfigGaps } from './openclaw-provider-config-repair'
import { applyGatewaySecretAction } from './gateway-secret-apply'
import {
  confirmRuntimeReconcile,
  issueDesiredRuntimeRevision,
  markRuntimeRevisionInProgress,
  resolveGatewayBlockingReasonFromState,
} from './openclaw-runtime-reconcile'
import { MAIN_RUNTIME_POLICY } from './runtime-policy'
import type { GatewayEnsureRunningResult } from './openclaw-gateway-service'
import { classifyGatewayRuntimeState } from '../../src/shared/gateway-runtime-diagnostics'
import { pollWithBackoff } from '../../src/shared/polling'
import {
  resolveConfiguredCustomProviderMatchFromConfig,
  type CustomProviderConfigMatchResult,
} from '../../src/shared/custom-provider-config-match'
const { dirname } = process.getBuiltinModule('node:path') as typeof import('node:path')

const PLUGIN_TIMEOUT_MS = MAIN_RUNTIME_POLICY.auth.pluginEnableTimeoutMs
const LOGIN_TIMEOUT_MS = MAIN_RUNTIME_POLICY.auth.loginTimeoutMs
const TOKEN_TIMEOUT_MS = MAIN_RUNTIME_POLICY.auth.tokenTimeoutMs
const ONBOARD_TIMEOUT_MS = MAIN_RUNTIME_POLICY.auth.onboardTimeoutMs
const GATEWAY_RESTART_TIMEOUT_MS = MAIN_RUNTIME_POLICY.cli.defaultCommandTimeoutMs
const UNKNOWN_PROVIDER_ERROR_PATTERN = /\bunknown provider\b/i
const GATEWAY_RESTART_REQUIRED_PATTERN = /\brestart the gateway to apply\b/i
type OnboardRouteKind = Extract<OpenClawAuthRouteDescriptor['kind'], 'onboard' | 'onboard-custom'>

export type ExecuteAuthRouteErrorCode = 'invalid_input' | 'command_failed' | 'unsupported_capability'

type OAuthEventChannel = 'oauth:state' | 'oauth:code'

interface OAuthStatePayload {
  providerId: string
  methodId: string
  state: 'plugin-ready' | 'opening-browser' | 'waiting-for-approval' | 'browser-open-failed'
}

interface OAuthCodePayload {
  providerId: string
  methodId: string
  verificationUri: string
  userCode?: string
  browserOpened: boolean
}

export interface ResolvedOpenClawAuthMethod {
  provider: OpenClawAuthProviderDescriptor
  method: OpenClawAuthMethodDescriptor
}

export async function loadEffectiveAuthRegistry(params: {
  capabilities?: OpenClawCapabilities
  loadAuthRegistry: () => Promise<OpenClawAuthRegistry>
}): Promise<OpenClawAuthRegistry> {
  if (params.capabilities?.authRegistry?.providers?.length) {
    return params.capabilities.authRegistry
  }
  return params.loadAuthRegistry()
}

export interface ExecuteAuthRouteInput {
  providerId: string
  methodId: string
  method: OpenClawAuthMethodDescriptor
  selectedExtraOption?: string
  secret?: string
  customConfig?: CustomProviderConfigInput
  setDefault?: boolean
  profileId?: string
  expiresIn?: string
  yes?: boolean
  emit?: (channel: OAuthEventChannel, payload: Record<string, any>) => void
}

export interface ExecuteAuthRouteResult extends CliResult {
  attemptedCommands: string[][]
  routeKind: OpenClawAuthRouteDescriptor['kind']
  loginProviderId?: string
  routeMethodId?: string
  pluginId?: string
  errorCode?: ExecuteAuthRouteErrorCode
  message?: string
}

interface ExecuteAuthRouteOptions {
  runCommand?: (args: string[], timeout?: number) => Promise<CliResult>
  runCommandWithEnv?: (
    args: string[],
    timeout: number | undefined,
    env: Partial<NodeJS.ProcessEnv>
  ) => Promise<CliResult>
  runStreamingCommand?: (args: string[], options?: RunCliStreamOptions) => Promise<CliResult>
  readConfig?: () => Promise<Record<string, any> | null>
  writeConfig?: (config: Record<string, any>) => Promise<void>
  pruneStalePluginEntries?: (
    pluginIds: string[]
  ) => Promise<Awaited<ReturnType<typeof pruneStalePluginConfigEntries>>>
  capabilities?: OpenClawCapabilities
  loadCapabilities?: () => Promise<OpenClawCapabilities>
  ensureGatewayRunning?: () => Promise<GatewayEnsureRunningResult>
}

async function defaultRunCommand(args: string[], timeout?: number): Promise<CliResult> {
  const cli = await import('./cli')
  return cli.runCli(args, timeout, 'oauth')
}

async function defaultRunCommandWithEnv(
  args: string[],
  timeout: number | undefined,
  env: Partial<NodeJS.ProcessEnv>
): Promise<CliResult> {
  const cli = await import('./cli')
  return cli.runCliStreaming(args, {
    timeout,
    controlDomain: 'oauth',
    env,
  })
}

async function defaultReadConfig(): Promise<Record<string, any> | null> {
  const cli = await import('./cli')
  return cli.readConfig()
}

async function defaultEnsureGatewayRunning(): Promise<GatewayEnsureRunningResult> {
  const gatewayService = await import('./openclaw-gateway-service')
  return gatewayService.ensureGatewayRunning()
}

function failed(
  routeKind: OpenClawAuthRouteDescriptor['kind'],
  attemptedCommands: string[][],
  message: string,
  errorCode: ExecuteAuthRouteErrorCode,
  extras: Partial<ExecuteAuthRouteResult> = {}
): ExecuteAuthRouteResult {
  return {
    ok: false,
    stdout: '',
    stderr: '',
    code: null,
    attemptedCommands,
    routeKind,
    errorCode,
    message,
    ...extras,
  }
}

function fromCommand(
  routeKind: OpenClawAuthRouteDescriptor['kind'],
  attemptedCommands: string[][],
  result: CliResult,
  extras: Partial<ExecuteAuthRouteResult> = {}
): ExecuteAuthRouteResult {
  return {
    ...result,
    attemptedCommands,
    routeKind,
    ...(result.ok
      ? {}
      : {
          errorCode: 'command_failed' as const,
          message: getCliFailureMessage(result, 'Auth command failed'),
        }),
    ...extras,
  }
}

function buildSupportedOptionMessage(method: OpenClawAuthMethodDescriptor): string {
  const options = (method.route.extraOptions || []).map((item) => item.id).filter(Boolean)
  return `Auth method "${method.authChoice}" requires selecting one of: ${options.join(', ')}`
}

function extractStalePluginIdsFromResult(result: Pick<CliResult, 'stdout' | 'stderr'>): string[] {
  return extractStalePluginConfigEntryIds(`${result.stderr || ''}\n${result.stdout || ''}`)
}

function resolveRouteMethodId(
  method: OpenClawAuthMethodDescriptor,
  selectedExtraOption?: string
): { ok: true; value?: string } | { ok: false; message: string } {
  const route = method.route
  if (route.extraOptions?.length) {
    const normalizedSelected = normalizeAuthChoice(String(selectedExtraOption || '').trim())
    if (!normalizedSelected) {
      return {
        ok: false,
        message: buildSupportedOptionMessage(method),
      }
    }
    if (!route.extraOptions.some((option) => normalizeAuthChoice(option.id) === normalizedSelected)) {
      return {
        ok: false,
        message: buildSupportedOptionMessage(method),
      }
    }
    return { ok: true, value: normalizedSelected }
  }

  if (!route.methodId) return { ok: true }
  return { ok: true, value: normalizeAuthChoice(route.methodId) }
}

function fromBuildFailure(
  buildResult: Extract<OpenClawCommandBuildResult, { ok: false }>,
  attemptedCommands: string[][],
  routeKind: OpenClawAuthRouteDescriptor['kind'],
  extras: Partial<ExecuteAuthRouteResult> = {}
): ExecuteAuthRouteResult {
  return failed(
    routeKind,
    attemptedCommands,
    buildResult.message,
    buildResult.errorCode === 'invalid_input' ? 'invalid_input' : 'unsupported_capability',
    extras
  )
}

async function resolveCapabilities(
  options: ExecuteAuthRouteOptions
): Promise<OpenClawCapabilities | undefined> {
  if (options.capabilities) return options.capabilities
  if (options.loadCapabilities) return options.loadCapabilities()
  if (!options.runCommand && !options.runStreamingCommand) {
    const { loadOpenClawCapabilities } = await import('./openclaw-capabilities')
    return loadOpenClawCapabilities()
  }
  return undefined
}

async function resolveMainAgentAuthEnv(): Promise<Partial<NodeJS.ProcessEnv> | null> {
  const { resolveMainAuthStorePath } = await import('./local-model-probe')
  const authStorePath = String(await resolveMainAuthStorePath()).trim()
  if (!authStorePath) return null

  const agentDir = dirname(authStorePath).trim()
  if (!agentDir) return null

  return {
    OPENCLAW_AGENT_DIR: agentDir,
    PI_CODING_AGENT_DIR: agentDir,
  }
}

function normalizeAgentId(value: unknown): string {
  return String(value || '')
    .trim()
    .toLowerCase()
}

function hasOwn(object: unknown, key: string): boolean {
  return !!object && Object.prototype.hasOwnProperty.call(object, key)
}

function buildConfigWithMainAsDefaultAgent(
  config: Record<string, any> | null | undefined
): { changed: boolean; config: Record<string, any> | null } {
  if (!config || typeof config !== 'object') {
    return { changed: false, config: config ?? null }
  }

  const agentList = Array.isArray(config.agents?.list) ? config.agents.list : []
  if (!agentList.length) {
    return { changed: false, config }
  }

  const mainIndex = agentList.findIndex((entry: any) => normalizeAgentId(entry?.id) === 'main')
  if (mainIndex < 0) {
    return { changed: false, config }
  }

  const explicitDefaults = agentList.filter((entry: any) => entry && entry.default === true)
  const effectiveDefaultId =
    explicitDefaults.length > 0 ? normalizeAgentId(explicitDefaults[0]?.id) : normalizeAgentId(agentList[0]?.id)
  if (effectiveDefaultId === 'main' && explicitDefaults.length <= 1 && agentList[mainIndex]?.default === true) {
    return { changed: false, config }
  }

  const nextList = agentList.map((entry: any) => {
    if (!entry || typeof entry !== 'object') return entry
    const nextEntry = { ...entry }
    if (normalizeAgentId(entry.id) === 'main') {
      nextEntry.default = true
    } else {
      delete nextEntry.default
    }
    return nextEntry
  })

  return {
    changed: true,
    config: {
      ...config,
      agents: {
        ...(config.agents || {}),
        list: nextList,
      },
    },
  }
}

function restoreOriginalAgentDefaultSelection(
  currentConfig: Record<string, any> | null | undefined,
  originalConfig: Record<string, any> | null | undefined
): { changed: boolean; config: Record<string, any> | null } {
  if (!currentConfig || typeof currentConfig !== 'object' || !originalConfig || typeof originalConfig !== 'object') {
    return { changed: false, config: currentConfig ?? null }
  }

  const originalList = Array.isArray(originalConfig.agents?.list) ? originalConfig.agents.list : []
  const currentList = Array.isArray(currentConfig.agents?.list) ? currentConfig.agents.list : []
  if (!originalList.length || !currentList.length) {
    return { changed: false, config: currentConfig }
  }

  const currentById = new Map<string, any>()
  for (const entry of currentList) {
    const id = normalizeAgentId(entry?.id)
    if (!id || currentById.has(id)) continue
    currentById.set(id, entry)
  }

  const seen = new Set<string>()
  const restoredList = originalList.map((originalEntry: any) => {
    const id = normalizeAgentId(originalEntry?.id)
    seen.add(id)
    const mergedEntry =
      id && currentById.has(id) && currentById.get(id) && typeof currentById.get(id) === 'object'
        ? { ...currentById.get(id) }
        : originalEntry && typeof originalEntry === 'object'
          ? { ...originalEntry }
          : originalEntry

    if (!mergedEntry || typeof mergedEntry !== 'object') return mergedEntry

    if (hasOwn(originalEntry, 'default')) {
      mergedEntry.default = originalEntry.default
    } else {
      delete mergedEntry.default
    }
    return mergedEntry
  })

  for (const entry of currentList) {
    const id = normalizeAgentId(entry?.id)
    if (id && seen.has(id)) continue
    if (entry && typeof entry === 'object') {
      const nextEntry = { ...entry }
      delete nextEntry.default
      restoredList.push(nextEntry)
    } else {
      restoredList.push(entry)
    }
  }

  const currentSerialized = JSON.stringify(currentList)
  const restoredSerialized = JSON.stringify(restoredList)
  if (currentSerialized === restoredSerialized) {
    return { changed: false, config: currentConfig }
  }

  return {
    changed: true,
    config: {
      ...currentConfig,
      agents: {
        ...(currentConfig.agents || {}),
        list: restoredList,
      },
    },
  }
}

async function prepareTemporaryMainAgentDefaultScope(params: {
  configBeforeAuth: Record<string, any> | null
  readConfig: () => Promise<Record<string, any> | null>
  writeConfig: (beforeConfig: Record<string, any> | null, nextConfig: Record<string, any>) => Promise<void>
}): Promise<
  | {
      ok: true
      restore: () => Promise<{ ok: true } | { ok: false; message: string }>
    }
  | {
      ok: false
      message: string
    }
> {
  const temporaryConfig = buildConfigWithMainAsDefaultAgent(params.configBeforeAuth)
  if (!temporaryConfig.changed || !temporaryConfig.config) {
    return {
      ok: true,
      restore: async () => ({ ok: true }),
    }
  }

  try {
    await params.writeConfig(params.configBeforeAuth, temporaryConfig.config)
  } catch (error) {
    return {
      ok: false,
      message: `认证前切换 OpenClaw 默认 agent 到 main 失败：${(error as Error).message || String(error)}`,
    }
  }

  return {
    ok: true,
    restore: async () => {
      try {
        const currentConfig = await params.readConfig().catch(() => null)
        const restored = restoreOriginalAgentDefaultSelection(currentConfig, params.configBeforeAuth)
        if (!restored.changed || !restored.config) {
          return { ok: true }
        }

        await params.writeConfig(currentConfig, restored.config)
        return { ok: true }
      } catch (error) {
        return {
          ok: false,
          message: `认证完成后恢复 OpenClaw 原始默认 agent 状态失败：${(error as Error).message || String(error)}`,
        }
      }
    },
  }
}

function createOAuthScanner(input: {
  providerId: string
  methodId: string
  emit?: (channel: OAuthEventChannel, payload: Record<string, any>) => void
}) {
  const emit = input.emit || (() => {})
  return createOAuthChallengeScanner(async (challenge) => {
    emit('oauth:code', {
      providerId: input.providerId,
      methodId: input.methodId,
      verificationUri: challenge.verificationUri,
      userCode: challenge.userCode,
      browserOpened: false,
    } satisfies OAuthCodePayload)
    emit('oauth:state', {
      providerId: input.providerId,
      methodId: input.methodId,
      state: 'waiting-for-approval',
    } satisfies OAuthStatePayload)
  })
}

function shouldUseDesktopOAuthBrowserFallback(authChoice: string): boolean {
  const normalizedAuthChoice = normalizeAuthChoice(authChoice)
  return normalizedAuthChoice === 'google-gemini-cli' || normalizedAuthChoice === 'openai-codex'
}

function loginFailureLooksLikeStaleGatewayProvider(result: CliResult): boolean {
  return UNKNOWN_PROVIDER_ERROR_PATTERN.test(`${result.stderr || ''}\n${result.stdout || ''}`)
}

function pluginEnableRequiresGatewayRestart(result: CliResult): boolean {
  return GATEWAY_RESTART_REQUIRED_PATTERN.test(`${result.stderr || ''}\n${result.stdout || ''}`)
}

function oauthLoginFailureLooksLikeConfigInvalid(result: CliResult): boolean {
  return classifyGatewayRuntimeState(result).stateCode === 'config_invalid'
}

function appendAttemptedCommands(target: string[][], commands: string[][] | undefined): void {
  if (!Array.isArray(commands) || commands.length === 0) return
  for (const command of commands) {
    if (!Array.isArray(command) || command.length === 0) continue
    target.push([...command])
  }
}

function buildOAuthConfigRecoveryFailureMessage(params: {
  authChoice: string
  authError: string
  recoverySummary: string
}): string {
  return [
    `OpenClaw 在执行认证流程 "${params.authChoice}" 时检测到当前本地配置与新版本契约不兼容。`,
    `Qclaw 已尝试自动修复配置并恢复网关，但仍未成功：${params.recoverySummary}`,
    `原始认证错误：${params.authError}`,
  ].join('\n')
}

function buildGatewayRestartFailureMessage(params: {
  pluginId: string
  providerId: string
  loginError: string
  restartError: string
  gatewayReloadSuggested: boolean
}): string {
  const intro = params.gatewayReloadSuggested
    ? `OpenClaw 已启用插件 "${params.pluginId}"，但提供商 "${params.providerId}" 需要刷新网关后才会生效。`
    : `OpenClaw 已启用插件 "${params.pluginId}"，但当前运行中的网关仍未识别提供商 "${params.providerId}"。`

  return [
    intro,
    `Qclaw 已尝试自动重启网关，但失败了：${params.restartError}`,
    `原始登录错误：${params.loginError}`,
  ].join('\n')
}

function readGatewayAuthToken(config: Record<string, any> | null | undefined): string | null {
  const token = config?.gateway?.auth?.token
  if (typeof token !== 'string') return null
  const normalized = token.trim()
  return normalized || null
}

function buildGatewayTokenReloadFailureMessage(params: {
  authChoice: string
  applyError: string
}): string {
  return [
    `OpenClaw 已完成认证写入，但认证流程 "${params.authChoice}" 同时更新了 gateway.auth.token。`,
    `Qclaw 已先尝试热重载 secrets，并在失败后回退重启网关，但仍未成功：${params.applyError}`,
  ].join('\n')
}

function buildGatewayTokenConfirmFailureMessage(params: {
  authChoice: string
  gatewaySummary: string
}): string {
  return [
    `OpenClaw 已完成认证流程 "${params.authChoice}" 的写入，并已触发 gateway token apply。`,
    `但 Qclaw 仍未确认网关已消费最新 token：${params.gatewaySummary}`,
  ].join('\n')
}

function buildProviderConfigRepairFailureMessage(params: {
  repairedJsonPaths: string[]
  error: string
}): string {
  const repairedPaths =
    params.repairedJsonPaths.length > 0 ? params.repairedJsonPaths.join(', ') : '$.models.providers.minimax-portal.api'
  return [
    'OpenClaw 已完成认证写入，但 Qclaw 在修复 MiniMax 提供商运行状态配置时失败了。',
    `需要补齐的字段：${repairedPaths}`,
    `修复失败原因：${params.error}`,
  ].join('\n')
}

function buildMainAuthProfileSyncFailureMessage(params: {
  providerId: string
  error: string
}): string {
  return [
    `OpenClaw 已完成提供商 "${params.providerId}" 的认证写入，但 Qclaw 在同步 main agent 的 auth profile 时失败了。`,
    `失败原因：${params.error}`,
  ].join('\n')
}

function buildAmbiguousCustomProviderMatchMessage(params: {
  providerIds: string[]
}): string {
  const candidates = params.providerIds.map((providerId) => `"${providerId}"`).join(', ')
  return [
    'OpenClaw 已完成认证写入，但检测到多个同 endpoint/model 的自定义提供商配置。',
    candidates ? `候选提供商 ID：${candidates}` : '候选提供商 ID 未知。',
    '请填写提供商 ID 后重试，避免将 API Key 同步到错误的提供商。',
  ].join('\n')
}

function buildMissingCustomProviderMatchMessage(params: {
  providerId?: string | null
}): string {
  const providerId = String(params.providerId || '').trim()
  return [
    'OpenClaw 已完成认证写入，但 Qclaw 尚未在配置中确认自定义提供商 ID。',
    providerId ? `当前填写的提供商 ID："${providerId}"。` : '当前未填写提供商 ID。',
    '请等待配置落盘后重试，避免将 API Key 同步到错误的提供商。',
  ].join('\n')
}

function resolveConfiguredCustomProviderMatch(
  configData: Record<string, any> | null | undefined,
  customConfig?: CustomProviderConfigInput | null
){
  return resolveConfiguredCustomProviderMatchFromConfig(configData, customConfig)
}

async function waitForPersistedCustomProviderMatch(params: {
  initialConfig?: Record<string, any> | null
  readConfig: () => Promise<Record<string, any> | null>
  customConfig?: CustomProviderConfigInput | null
}): Promise<{
  config: Record<string, any> | null
  match: CustomProviderConfigMatchResult
}> {
  const initialConfig = params.initialConfig ?? null
  const initialMatch = resolveConfiguredCustomProviderMatch(initialConfig, params.customConfig)
  if (initialMatch.status !== 'missing') {
    return {
      config: initialConfig,
      match: initialMatch,
    }
  }

  const result = await pollWithBackoff({
    policy: MAIN_RUNTIME_POLICY.auth.persistencePoll,
    execute: async () => {
      const config = await Promise.resolve(params.readConfig()).catch(() => null)
      return {
        config: config ?? null,
        match: resolveConfiguredCustomProviderMatch(config, params.customConfig),
        stopPolling: typeof config === 'undefined',
      }
    },
    isSuccess: (value) => value.stopPolling || value.match.status !== 'missing',
  })

  return (
    result.value || {
      config: initialConfig,
      match: initialMatch,
    }
  )
}

function resolveCustomProviderIdForAuthSync(params: {
  configData: Record<string, any> | null | undefined
  customConfig?: CustomProviderConfigInput | null
  fallbackProviderId?: string | null
}):
  | {
      ok: true
      providerId: string
    }
  | {
      ok: false
      message: string
    } {
  const matchResult = resolveConfiguredCustomProviderMatch(params.configData, params.customConfig)
  if (matchResult.status === 'ambiguous') {
    return {
      ok: false,
      message: buildAmbiguousCustomProviderMatchMessage({
        providerIds: matchResult.candidates,
      }),
    }
  }

  if (matchResult.status !== 'matched') {
    return {
      ok: false,
      message: buildMissingCustomProviderMatchMessage({
        providerId: params.customConfig?.providerId,
      }),
    }
  }

  return {
    ok: true,
    providerId: matchResult.providerId,
  }
}

async function syncMainApiKeyAuthProfile(params: {
  providerId: string
  apiKey?: string
}): Promise<
  | {
      ok: true
    }
  | {
      ok: false
      message: string
    }
> {
  const providerId = String(params.providerId || '').trim()
  const apiKey = String(params.apiKey || '').trim()
  if (!providerId || !apiKey) {
    return { ok: true }
  }

  const { upsertApiKeyAuthProfile } = await import('./local-model-probe')
  const syncResult = await upsertApiKeyAuthProfile({
    provider: providerId,
    apiKey,
  })
  if (syncResult.ok) {
    return { ok: true }
  }

  return {
    ok: false,
    message: buildMainAuthProfileSyncFailureMessage({
      providerId,
      error: syncResult.error || 'Failed to write main auth profile',
    }),
  }
}

async function repairMiniMaxOauthAgentAuthProfiles(): Promise<void> {
  const { repairAgentAuthProfilesFromOtherAgentStores } = await import('./local-model-probe')
  await repairAgentAuthProfilesFromOtherAgentStores({
    providerIds: ['minimax-portal'],
  })
}

async function ensureKnownProviderConfigAfterAuth(params: {
  readConfig: () => Promise<Record<string, any> | null>
  writeConfig: (beforeConfig: Record<string, any> | null, nextConfig: Record<string, any>) => Promise<void>
}): Promise<
  | {
      ok: true
      config: Record<string, any> | null
    }
  | {
      ok: false
      message: string
    }
> {
  const currentConfig = await params.readConfig().catch(() => null)
  const repairResult = repairKnownProviderConfigGaps(currentConfig)
  if (!repairResult.changed || !repairResult.config) {
    return {
      ok: true,
      config: currentConfig,
    }
  }

  try {
    await params.writeConfig(currentConfig, repairResult.config)
    return {
      ok: true,
      config: repairResult.config,
    }
  } catch (error) {
    return {
      ok: false,
      message: buildProviderConfigRepairFailureMessage({
        repairedJsonPaths: repairResult.repairedJsonPaths,
        error: (error as Error).message || String(error),
      }),
    }
  }
}

async function persistAuthRuntimeReconcile(params: {
  revision: number | null
  confirmed: boolean
  blockingReason?: ReturnType<typeof resolveGatewayBlockingReasonFromState>
  blockingDetail?: GatewayEnsureRunningResult['reasonDetail']
  safeToRetry?: boolean
  summary: string
  actions: ReconcileActionSummary[]
}): Promise<void> {
  await confirmRuntimeReconcile({
    confirmed: params.confirmed,
    revision: params.revision ?? undefined,
    blockingReason: params.blockingReason,
    blockingDetail: params.blockingDetail,
    safeToRetry: params.safeToRetry,
    summary: params.summary,
    actions: params.actions,
  })
}

async function applyGatewayTokenRefresh(params: {
  authChoice: string
  runCommand: (args: string[], timeout?: number) => Promise<CliResult>
  attemptedCommands: string[][]
}): Promise<
  | {
      ok: true
      appliedAction: 'hot-reload' | 'restart'
      note?: string
    }
  | {
      ok: false
      message: string
    }
> {
  const applyResult = await applyGatewaySecretAction({
    requestedAction: 'hot-reload',
    runCommand: params.runCommand,
    attemptedCommands: params.attemptedCommands,
  })

  if (applyResult.ok) {
    return {
      ok: true,
      appliedAction: applyResult.appliedAction,
      note: applyResult.note,
    }
  }

  return {
    ok: false,
    message: buildGatewayTokenReloadFailureMessage({
      authChoice: params.authChoice,
      applyError: applyResult.note || '网关生效失败',
    }),
  }
}

function shouldRetryOnboardAfterGatewayRecovery(result: CliResult): boolean {
  const classification = classifyGatewayRuntimeState(result)
  if (
    classification.stateCode === 'token_mismatch' ||
    classification.stateCode === 'websocket_1006' ||
    classification.stateCode === 'gateway_not_running' ||
    classification.stateCode === 'service_missing' ||
    classification.stateCode === 'service_loaded_but_stale'
  ) {
    return true
  }

  if (classification.stateCode !== 'network_blocked') return false

  const output = `${String(result.stderr || '')}\n${String(result.stdout || '')}`.toLowerCase()
  const hasLocalEndpointSignal =
    output.includes('127.0.0.1') ||
    output.includes('localhost') ||
    output.includes('0.0.0.0') ||
    output.includes('::1')
  const hasLocalRefusedSignal =
    (output.includes('econnrefused') || output.includes('connection refused')) &&
    hasLocalEndpointSignal
  return hasLocalRefusedSignal
}

function buildOnboardGatewayRecoveryFailureMessage(params: {
  authChoice: string
  onboardError: string
  recoveryError: string
  recoverySummary?: string
}): string {
  return [
    `OpenClaw 在执行认证流程 "${params.authChoice}" 时检测到网关运行状态未就绪。`,
    `Qclaw 已尝试自动恢复网关并等待其重新就绪，但恢复失败了：${params.recoverySummary || params.recoveryError}`,
    `原始认证错误：${params.onboardError}`,
  ].join('\n')
}

async function executeOnboardCommandWithGatewayRecovery(params: {
  routeKind: OnboardRouteKind
  authChoice: string
  command: string[]
  attemptedCommands: string[][]
  runCommand: (args: string[], timeout?: number) => Promise<CliResult>
  ensureGatewayRunning: () => Promise<GatewayEnsureRunningResult>
  extras: Partial<ExecuteAuthRouteResult>
}): Promise<
  | { status: 'result'; result: CliResult }
  | { status: 'failure'; failure: ExecuteAuthRouteResult }
> {
  params.attemptedCommands.push(params.command)
  let result = await params.runCommand(params.command, ONBOARD_TIMEOUT_MS)
  if (result.ok || !shouldRetryOnboardAfterGatewayRecovery(result)) {
    return { status: 'result', result }
  }

  const recoveryResult = await params.ensureGatewayRunning()
  params.attemptedCommands.push(...(recoveryResult.attemptedCommands || []))
  if (!recoveryResult.ok || !recoveryResult.running) {
    return {
      status: 'failure',
      failure: failed(
        params.routeKind,
        params.attemptedCommands,
        buildOnboardGatewayRecoveryFailureMessage({
          authChoice: params.authChoice,
          onboardError: getCliFailureMessage(result, '认证命令执行失败'),
          recoveryError: getCliFailureMessage(recoveryResult, '网关恢复失败'),
          recoverySummary: recoveryResult.summary,
        }),
        'command_failed',
        {
          ...params.extras,
          stdout: result.stdout,
          stderr: [result.stderr, recoveryResult.stderr].filter(Boolean).join('\n'),
          code: recoveryResult.code,
        }
      ),
    }
  }

  params.attemptedCommands.push(params.command)
  result = await params.runCommand(params.command, ONBOARD_TIMEOUT_MS)
  return { status: 'result', result }
}

export function resolveAuthMethodDescriptor(
  authRegistry: OpenClawAuthRegistry,
  providerId: string,
  methodId: string
): 
  | { ok: true; value: ResolvedOpenClawAuthMethod }
  | { ok: false; errorCode: ExecuteAuthRouteErrorCode; message: string } {
  if (!authRegistry.ok && authRegistry.providers.length === 0) {
    return {
      ok: false,
      errorCode: 'command_failed',
      message: authRegistry.message || 'OpenClaw auth metadata is unavailable.',
    }
  }

  const normalizedProviderId = String(providerId || '').trim().toLowerCase()
  const normalizedMethodId = normalizeAuthChoice(String(methodId || '').trim())
  if (!normalizedProviderId || !normalizedMethodId) {
    return {
      ok: false,
      errorCode: 'invalid_input',
      message: 'providerId and methodId are required',
    }
  }

  const provider = authRegistry.providers.find((item) => String(item.id || '').trim().toLowerCase() === normalizedProviderId)
  if (!provider) {
    return {
      ok: false,
      errorCode: 'invalid_input',
      message: `Unsupported providerId: ${providerId}`,
    }
  }

  const method = provider.methods.find(
    (item) => normalizeAuthChoice(String(item.authChoice || '').trim()) === normalizedMethodId
  )
  if (!method) {
    return {
      ok: false,
      errorCode: 'invalid_input',
      message: `Unsupported auth method for provider ${providerId}: ${methodId}`,
    }
  }

  return {
    ok: true,
    value: { provider, method },
  }
}

export async function executeAuthRoute(
  input: ExecuteAuthRouteInput,
  options: ExecuteAuthRouteOptions = {}
): Promise<ExecuteAuthRouteResult> {
  const runCommand = options.runCommand || defaultRunCommand
  const runCommandWithEnv =
    options.runCommandWithEnv || (options.runCommand ? undefined : defaultRunCommandWithEnv)
  const readConfig = options.readConfig || defaultReadConfig
  const writeConfig = options.writeConfig
  const ensureGatewayRunning = options.ensureGatewayRunning || defaultEnsureGatewayRunning
  const attemptedCommands: string[][] = []
  const method = input.method
  const route = method.route
  const normalizedMethodId = normalizeAuthChoice(input.methodId)
  const loginProviderId = route.providerId?.trim()
  const pluginId = route.pluginId?.trim()
  const capabilities = await resolveCapabilities(options)
  let pluginGatewayReloadSuggested = false
  let gatewayTokenBeforeAuth: string | null = null

  const writeAuthConfig = async (
    beforeConfig: Record<string, any> | null,
    nextConfig: Record<string, any>
  ): Promise<void> => {
    if (writeConfig) {
      await writeConfig(nextConfig)
      return
    }
    const coordinator = await import('./openclaw-config-coordinator')
    const writeResult = await coordinator.applyConfigPatchGuarded({
      beforeConfig,
      afterConfig: nextConfig,
      reason: 'unknown',
    })
    if (!writeResult.ok) {
      throw new Error(writeResult.message || '认证流程配置写入失败')
    }
  }

  if (route.kind === 'unsupported') {
    return failed(route.kind, attemptedCommands, `Auth method "${method.authChoice}" is unsupported.`, 'command_failed')
  }

  const resolvedRouteMethodId = resolveRouteMethodId(method, input.selectedExtraOption)
  if (!resolvedRouteMethodId.ok) {
    return failed(route.kind, attemptedCommands, resolvedRouteMethodId.message, 'invalid_input')
  }

  if (route.kind === 'models-auth-login' && pluginId) {
    const pluginCommand = buildPluginEnableCommand(pluginId, capabilities)
    if (!pluginCommand.ok) {
      return fromBuildFailure(pluginCommand, attemptedCommands, route.kind, {
        loginProviderId,
        routeMethodId: resolvedRouteMethodId.value,
        pluginId,
      })
    }

    attemptedCommands.push(pluginCommand.command)
    const pluginResult = await runCommand(pluginCommand.command, PLUGIN_TIMEOUT_MS)
    if (!pluginEnableLooksSuccessful(pluginResult)) {
      return fromCommand(route.kind, attemptedCommands, pluginResult, {
        loginProviderId,
        routeMethodId: resolvedRouteMethodId.value,
        pluginId,
      })
    }
    pluginGatewayReloadSuggested = pluginEnableRequiresGatewayRestart(pluginResult)
    input.emit?.('oauth:state', {
      providerId: input.providerId,
      methodId: normalizedMethodId,
      state: 'plugin-ready',
    } satisfies OAuthStatePayload)
  }

  if (route.kind === 'models-auth-login') {
    if (!loginProviderId) {
      return failed(route.kind, attemptedCommands, `Auth method "${method.authChoice}" does not declare a providerId.`, 'command_failed')
    }

    const loginCommand = buildModelsAuthLoginCommand(
      {
        providerId: loginProviderId,
        methodId: resolvedRouteMethodId.value,
        setDefault: input.setDefault,
      },
      capabilities
    )
    if (!loginCommand.ok) {
      return fromBuildFailure(loginCommand, attemptedCommands, route.kind, {
        loginProviderId,
        routeMethodId: resolvedRouteMethodId.value,
        pluginId,
      })
    }

    const configBeforeAuth = await readConfig().catch(() => null)
    const mainAgentAuthEnv = await resolveMainAgentAuthEnv().catch(() => null)
    const mainAgentScope = await prepareTemporaryMainAgentDefaultScope({
      configBeforeAuth,
      readConfig,
      writeConfig: writeAuthConfig,
    })
    if (!mainAgentScope.ok) {
      return failed(route.kind, attemptedCommands, mainAgentScope.message, 'command_failed', {
        loginProviderId,
        routeMethodId: resolvedRouteMethodId.value,
        pluginId,
      })
    }

    const runModelsAuthLogin = async (): Promise<CliResult> => {
      attemptedCommands.push(loginCommand.command)

      if (route.requiresBrowser) {
        const scanOAuthChallenge = createOAuthScanner({
          providerId: input.providerId,
          methodId: normalizedMethodId,
          emit: input.emit,
        })
        const useDesktopBrowserFallback = shouldUseDesktopOAuthBrowserFallback(method.authChoice)
        const result = options.runStreamingCommand
          ? await options.runStreamingCommand(loginCommand.command, {
              timeout: LOGIN_TIMEOUT_MS,
              autoOpenOAuth: useDesktopBrowserFallback,
              controlDomain: 'oauth',
              ...(mainAgentAuthEnv ? { env: mainAgentAuthEnv } : {}),
              onOAuthUrl: () => {
                if (!useDesktopBrowserFallback) return
                input.emit?.('oauth:state', {
                  providerId: input.providerId,
                  methodId: normalizedMethodId,
                  state: 'opening-browser',
                } satisfies OAuthStatePayload)
              },
              onStdout: (chunk) => scanOAuthChallenge(chunk),
              onStderr: (chunk) => scanOAuthChallenge(chunk),
            })
          : mainAgentAuthEnv && runCommandWithEnv
            ? await runCommandWithEnv(loginCommand.command, LOGIN_TIMEOUT_MS, mainAgentAuthEnv)
            : await runCommand(loginCommand.command, LOGIN_TIMEOUT_MS)
        // Flush pending scanner buffer for the last chunk when command exits
        // without a trailing delimiter (e.g. no newline in final stdout chunk).
        scanOAuthChallenge('\n')
        return result
      }

      if (mainAgentAuthEnv && runCommandWithEnv) {
        return runCommandWithEnv(loginCommand.command, LOGIN_TIMEOUT_MS, mainAgentAuthEnv)
      }

      return runCommand(loginCommand.command, LOGIN_TIMEOUT_MS)
    }

    let result: CliResult = { ok: false, stdout: '', stderr: '', code: null }
    let restoreScopeResult: { ok: true } | { ok: false; message: string } = { ok: true }
    try {
      const retryAfterGatewayRestartForStaleProvider = async (
        activePluginId: string,
        failedLoginResult: CliResult
      ): Promise<
        | { status: 'result'; result: CliResult }
        | { status: 'failure'; failure: ExecuteAuthRouteResult }
      > => {
        const pendingStore = await issueDesiredRuntimeRevision('auth', 'provider_plugin_runtime_reload', {
          actions: [
            {
              kind: 'repair',
              action: 'plugin-enable',
              outcome: 'succeeded',
              detail: `插件 ${activePluginId} 已启用，正在确认提供商 ${loginProviderId} 是否已被网关识别。`,
            },
            {
              kind: 'repair',
              action: 'gateway-restart',
              outcome: 'scheduled',
              detail: `首次登录发现提供商 ${loginProviderId} 尚未被运行状态加载。`,
            },
          ],
        })
        const runtimeRevision = pendingStore.runtime.desiredRevision
        await markRuntimeRevisionInProgress(runtimeRevision, {
          summary: `插件 ${activePluginId} 已启用，正在重载网关以确认提供商 ${loginProviderId} 生效。`,
          actions: pendingStore.runtime.lastActions,
        })
        const gatewayRestartCommand = ['gateway', 'restart']
        attemptedCommands.push(gatewayRestartCommand)
        const restartResult = await runCommand(gatewayRestartCommand, GATEWAY_RESTART_TIMEOUT_MS)
        if (!restartResult.ok) {
          await persistAuthRuntimeReconcile({
            revision: runtimeRevision,
            confirmed: false,
            blockingReason: 'service_generation_stale',
            safeToRetry: true,
            summary: buildGatewayRestartFailureMessage({
              pluginId: activePluginId,
              providerId: loginProviderId,
              loginError: getCliFailureMessage(failedLoginResult, '认证命令执行失败'),
              restartError: getCliFailureMessage(restartResult, '网关重启失败'),
              gatewayReloadSuggested: pluginGatewayReloadSuggested,
            }),
            actions: [
              {
                kind: 'repair',
                action: 'gateway-restart',
                outcome: 'failed',
                detail: getCliFailureMessage(restartResult, '网关重启失败'),
              },
            ],
          })
          return {
            status: 'failure',
            failure: failed(
                route.kind,
                attemptedCommands,
                buildGatewayRestartFailureMessage({
                  pluginId: activePluginId,
                  providerId: loginProviderId,
                  loginError: getCliFailureMessage(failedLoginResult, '认证命令执行失败'),
                  restartError: getCliFailureMessage(restartResult, '网关重启失败'),
                gatewayReloadSuggested: pluginGatewayReloadSuggested,
              }),
              'command_failed',
              {
                loginProviderId,
                routeMethodId: resolvedRouteMethodId.value,
                pluginId,
                stdout: failedLoginResult.stdout,
                stderr: [failedLoginResult.stderr, restartResult.stderr].filter(Boolean).join('\n'),
                code: restartResult.code,
              }
            ),
          }
        }

        const nextResult = await runModelsAuthLogin()
        await persistAuthRuntimeReconcile({
          revision: runtimeRevision,
          confirmed: nextResult.ok,
          blockingReason: nextResult.ok ? 'none' : 'provider_plugin_not_ready',
          safeToRetry: nextResult.ok ? true : false,
          summary: nextResult.ok
            ? `网关已重载并确认提供商 ${loginProviderId} 可用于 auth login。`
            : `网关已重载，但提供商 ${loginProviderId} 仍未准备完成：${getCliFailureMessage(nextResult, 'Auth command failed')}`,
          actions: [
            {
              kind: 'repair',
              action: 'gateway-restart',
              outcome: 'succeeded',
            },
            {
              kind: 'probe',
              action: 'models-auth-login',
              outcome: nextResult.ok ? 'succeeded' : 'failed',
              detail: getCliFailureMessage(nextResult, 'Auth command failed'),
            },
          ],
        })
        return {
          status: 'result',
          result: nextResult,
        }
      }

      result = await runModelsAuthLogin()

      if (!result.ok && pluginId && loginFailureLooksLikeStaleGatewayProvider(result)) {
        const retryResult = await retryAfterGatewayRestartForStaleProvider(pluginId, result)
        if (retryResult.status === 'failure') return retryResult.failure
        result = retryResult.result
      }

      if (!result.ok && oauthLoginFailureLooksLikeConfigInvalid(result)) {
        const recoveryResult = await ensureGatewayRunning()
        appendAttemptedCommands(attemptedCommands, recoveryResult.attemptedCommands)
        if (!recoveryResult.ok) {
          return failed(
            route.kind,
            attemptedCommands,
            buildOAuthConfigRecoveryFailureMessage({
              authChoice: method.authChoice,
              authError: getCliFailureMessage(result, '认证命令执行失败'),
              recoverySummary: recoveryResult.summary || getCliFailureMessage(recoveryResult, '网关恢复失败'),
            }),
            'command_failed',
            {
              loginProviderId,
              routeMethodId: resolvedRouteMethodId.value,
              pluginId,
              stdout: result.stdout,
              stderr: [result.stderr, recoveryResult.stderr].filter(Boolean).join('\n'),
              code: recoveryResult.code,
            }
          )
        }

        result = await runModelsAuthLogin()
        if (!result.ok && pluginId && loginFailureLooksLikeStaleGatewayProvider(result)) {
          const retryResult = await retryAfterGatewayRestartForStaleProvider(pluginId, result)
          if (retryResult.status === 'failure') return retryResult.failure
          result = retryResult.result
        }
      }

      if (result.ok) {
        const providerConfigRepair = await ensureKnownProviderConfigAfterAuth({
          readConfig,
          writeConfig: writeAuthConfig,
        })
        if (!providerConfigRepair.ok) {
          return failed(route.kind, attemptedCommands, providerConfigRepair.message, 'command_failed', {
            loginProviderId,
            routeMethodId: resolvedRouteMethodId.value,
            pluginId,
            stdout: result.stdout,
            stderr: result.stderr,
            code: result.code,
          })
        }
      }
    } finally {
      restoreScopeResult = await mainAgentScope.restore()
    }

    if (!restoreScopeResult.ok) {
      return failed(route.kind, attemptedCommands, restoreScopeResult.message, 'command_failed', {
        loginProviderId,
        routeMethodId: resolvedRouteMethodId.value,
        pluginId,
        stdout: result.stdout,
        stderr: result.stderr,
        code: result.code,
      })
    }

    if (result.ok && loginProviderId === 'minimax-portal') {
      await repairMiniMaxOauthAgentAuthProfiles().catch(() => null)
    }

    return fromCommand(route.kind, attemptedCommands, result, {
      loginProviderId,
      routeMethodId: resolvedRouteMethodId.value,
      pluginId,
    })
  }

  if (route.kind === 'models-auth-login-github-copilot') {
    const loginCommand = buildModelsAuthLoginGitHubCopilotCommand(
      {
        profileId: input.profileId,
        yes: input.yes,
      },
      capabilities
    )
    if (!loginCommand.ok) {
      return fromBuildFailure(loginCommand, attemptedCommands, route.kind, {
        loginProviderId: route.providerId,
        pluginId,
      })
    }

    const configBeforeAuth = await readConfig().catch(() => null)
    const mainAgentAuthEnv = await resolveMainAgentAuthEnv().catch(() => null)
    const mainAgentScope = await prepareTemporaryMainAgentDefaultScope({
      configBeforeAuth,
      readConfig,
      writeConfig: writeAuthConfig,
    })
    if (!mainAgentScope.ok) {
      return failed(route.kind, attemptedCommands, mainAgentScope.message, 'command_failed', {
        loginProviderId: route.providerId,
        pluginId,
      })
    }

    let result: CliResult = { ok: false, stdout: '', stderr: '', code: null }
    let restoreScopeResult: { ok: true } | { ok: false; message: string } = { ok: true }
    try {
      const runGitHubCopilotLogin = async (): Promise<CliResult> => {
        attemptedCommands.push(loginCommand.command)

        if (route.requiresBrowser) {
          const scanOAuthChallenge = createOAuthScanner({
            providerId: input.providerId,
            methodId: normalizedMethodId,
            emit: input.emit,
          })
          const useDesktopBrowserFallback = shouldUseDesktopOAuthBrowserFallback(method.authChoice)
          const nextResult = options.runStreamingCommand
            ? await options.runStreamingCommand(loginCommand.command, {
                timeout: LOGIN_TIMEOUT_MS,
                autoOpenOAuth: useDesktopBrowserFallback,
                controlDomain: 'oauth',
                ...(mainAgentAuthEnv ? { env: mainAgentAuthEnv } : {}),
                onOAuthUrl: () => {
                  if (!useDesktopBrowserFallback) return
                  input.emit?.('oauth:state', {
                    providerId: input.providerId,
                    methodId: normalizedMethodId,
                    state: 'opening-browser',
                  } satisfies OAuthStatePayload)
                },
                onStdout: (chunk) => scanOAuthChallenge(chunk),
                onStderr: (chunk) => scanOAuthChallenge(chunk),
              })
            : mainAgentAuthEnv && runCommandWithEnv
              ? await runCommandWithEnv(loginCommand.command, LOGIN_TIMEOUT_MS, mainAgentAuthEnv)
              : await runCommand(loginCommand.command, LOGIN_TIMEOUT_MS)
          // Flush pending scanner buffer for the final chunk without delimiter.
          scanOAuthChallenge('\n')
          return nextResult
        }

        return mainAgentAuthEnv && runCommandWithEnv
          ? runCommandWithEnv(loginCommand.command, LOGIN_TIMEOUT_MS, mainAgentAuthEnv)
          : runCommand(loginCommand.command, LOGIN_TIMEOUT_MS)
      }

      result = await runGitHubCopilotLogin()

      if (!result.ok && oauthLoginFailureLooksLikeConfigInvalid(result)) {
        const recoveryResult = await ensureGatewayRunning()
        appendAttemptedCommands(attemptedCommands, recoveryResult.attemptedCommands)
        if (!recoveryResult.ok) {
          return failed(
            route.kind,
            attemptedCommands,
            buildOAuthConfigRecoveryFailureMessage({
              authChoice: method.authChoice,
              authError: getCliFailureMessage(result, '认证命令执行失败'),
              recoverySummary: recoveryResult.summary || getCliFailureMessage(recoveryResult, '网关恢复失败'),
            }),
            'command_failed',
            {
              loginProviderId: route.providerId,
              pluginId,
              stdout: result.stdout,
              stderr: [result.stderr, recoveryResult.stderr].filter(Boolean).join('\n'),
              code: recoveryResult.code,
            }
          )
        }

        result = await runGitHubCopilotLogin()
      }
    } finally {
      restoreScopeResult = await mainAgentScope.restore()
    }

    if (!restoreScopeResult.ok) {
      return failed(route.kind, attemptedCommands, restoreScopeResult.message, 'command_failed', {
        loginProviderId: route.providerId,
        pluginId,
        stdout: result.stdout,
        stderr: result.stderr,
        code: result.code,
      })
    }

    return fromCommand(route.kind, attemptedCommands, result, {
      loginProviderId: route.providerId,
      pluginId,
    })
  }

  if (route.kind === 'onboard') {
    const configBeforeAuth = await readConfig().catch(() => null)
    gatewayTokenBeforeAuth = readGatewayAuthToken(configBeforeAuth)
    const mainAgentAuthEnv = await resolveMainAgentAuthEnv().catch(() => null)
    const onboardCommand = buildOnboardRouteCommand(method, input.secret, capabilities)
    if (!onboardCommand.ok) {
      return fromBuildFailure(onboardCommand, attemptedCommands, route.kind, {
        loginProviderId: route.providerId,
        routeMethodId: resolvedRouteMethodId.value,
        pluginId,
      })
    }
    const mainAgentScope = await prepareTemporaryMainAgentDefaultScope({
      configBeforeAuth,
      readConfig,
      writeConfig: writeAuthConfig,
    })
    if (!mainAgentScope.ok) {
      return failed(route.kind, attemptedCommands, mainAgentScope.message, 'command_failed', {
        loginProviderId: route.providerId,
        routeMethodId: resolvedRouteMethodId.value,
        pluginId,
      })
    }

    let onboardResult
    let restoreScopeResult: { ok: true } | { ok: false; message: string } = { ok: true }
    try {
      onboardResult = await executeOnboardCommandWithGatewayRecovery({
        routeKind: route.kind,
        authChoice: method.authChoice,
        command: onboardCommand.command,
        attemptedCommands,
        runCommand:
          mainAgentAuthEnv && runCommandWithEnv
            ? (args, timeout) => runCommandWithEnv(args, timeout, mainAgentAuthEnv)
            : runCommand,
        ensureGatewayRunning,
        extras: {
          loginProviderId: route.providerId,
          routeMethodId: resolvedRouteMethodId.value,
          pluginId,
        },
      })
    } finally {
      restoreScopeResult = await mainAgentScope.restore()
    }
    if (!restoreScopeResult.ok) {
      return failed(route.kind, attemptedCommands, restoreScopeResult.message, 'command_failed', {
        loginProviderId: route.providerId,
        routeMethodId: resolvedRouteMethodId.value,
        pluginId,
      })
    }
    if (onboardResult.status === 'failure') {
      return onboardResult.failure
    }
    const result = onboardResult.result
    if (result.ok) {
      const stalePluginIds = extractStalePluginIdsFromResult(result)
      if (stalePluginIds.length > 0) {
        await (options.pruneStalePluginEntries || pruneStalePluginConfigEntries)(stalePluginIds).catch(() => null)
      }
      const providerConfigRepair = await ensureKnownProviderConfigAfterAuth({
        readConfig,
        writeConfig: writeAuthConfig,
      })
      if (!providerConfigRepair.ok) {
        return failed(route.kind, attemptedCommands, providerConfigRepair.message, 'command_failed', {
          loginProviderId: route.providerId,
          routeMethodId: resolvedRouteMethodId.value,
          pluginId,
          stdout: result.stdout,
          stderr: result.stderr,
          code: result.code,
        })
      }
      const authProfileSync = await syncMainApiKeyAuthProfile({
        providerId: input.providerId,
        apiKey: input.secret,
      })
      if (!authProfileSync.ok) {
        return failed(route.kind, attemptedCommands, authProfileSync.message, 'command_failed', {
          loginProviderId: route.providerId,
          routeMethodId: resolvedRouteMethodId.value,
          pluginId,
          stdout: result.stdout,
          stderr: result.stderr,
          code: result.code,
        })
      }
      const configAfterAuth = providerConfigRepair.config
      const restoredPluginConfig = restoreTrustedPluginConfig(configBeforeAuth, configAfterAuth, {
        blockedPluginIds: stalePluginIds,
      })
      let effectiveConfigAfterAuth = restoredPluginConfig.config
      if (restoredPluginConfig.changed) {
        try {
          await writeAuthConfig(configAfterAuth, restoredPluginConfig.config)
        } catch {
          effectiveConfigAfterAuth = configAfterAuth || restoredPluginConfig.config
        }
      }
      const gatewayTokenAfterAuth = readGatewayAuthToken(effectiveConfigAfterAuth)
      if (gatewayTokenBeforeAuth !== gatewayTokenAfterAuth) {
        const pendingStore = await issueDesiredRuntimeRevision('auth', 'gateway_token_rotated_by_auth', {
          actions: [
            {
              kind: 'repair',
              action: 'auth-onboard',
              outcome: 'succeeded',
              detail: `认证流程 "${method.authChoice}" 更新了 gateway.auth.token。`,
              changedPaths: ['gateway.auth.token'],
            },
            {
              kind: 'repair',
              action: 'gateway-token-apply',
              outcome: 'scheduled',
            },
          ],
        })
        const runtimeRevision = pendingStore.runtime.desiredRevision
        await markRuntimeRevisionInProgress(runtimeRevision, {
          summary: `认证流程 "${method.authChoice}" 已更新 gateway.auth.token，正在确认网关是否已消费最新 token。`,
          actions: pendingStore.runtime.lastActions,
        })
        const gatewayApply = await applyGatewayTokenRefresh({
          authChoice: method.authChoice,
          runCommand,
          attemptedCommands,
        })
        if (!gatewayApply.ok) {
          await persistAuthRuntimeReconcile({
            revision: runtimeRevision,
            confirmed: false,
            blockingReason: 'runtime_token_stale',
            safeToRetry: true,
            summary: gatewayApply.message,
            actions: [
              {
                kind: 'repair',
                action: 'gateway-token-apply',
                outcome: 'failed',
                detail: gatewayApply.message,
              },
            ],
          })
          return failed(
            route.kind,
            attemptedCommands,
            gatewayApply.message,
            'command_failed',
            {
              loginProviderId: route.providerId,
              routeMethodId: resolvedRouteMethodId.value,
              pluginId,
              stdout: result.stdout,
              stderr: result.stderr,
              code: result.code,
            }
          )
        }
        const gatewayRuntime = await ensureGatewayRunning()
        attemptedCommands.push(...(gatewayRuntime.attemptedCommands || []))
        const gatewayConfirmed = gatewayRuntime.ok && gatewayRuntime.running
        await persistAuthRuntimeReconcile({
          revision: runtimeRevision,
          confirmed: gatewayConfirmed,
          blockingReason: resolveGatewayBlockingReasonFromState({
            gatewayStateCode: gatewayRuntime.stateCode,
          }),
          blockingDetail: gatewayRuntime.reasonDetail,
          safeToRetry: gatewayConfirmed ? true : gatewayRuntime.safeToRetry,
          summary: gatewayConfirmed
            ? `网关已确认消费认证流程 "${method.authChoice}" 更新后的 token。`
            : buildGatewayTokenConfirmFailureMessage({
                authChoice: method.authChoice,
                gatewaySummary: gatewayRuntime.summary || '网关未返回可用确认',
              }),
          actions: [
            {
              kind: 'repair',
              action: `gateway-token-${gatewayApply.appliedAction}`,
              outcome: 'succeeded',
              detail: gatewayApply.note,
            },
            {
              kind: 'probe',
              action: 'gateway-ensure-running',
              outcome: gatewayConfirmed ? 'succeeded' : 'failed',
              detail: gatewayRuntime.summary,
            },
          ],
        })
        if (!gatewayConfirmed) {
          return failed(
            route.kind,
            attemptedCommands,
            buildGatewayTokenConfirmFailureMessage({
              authChoice: method.authChoice,
              gatewaySummary: gatewayRuntime.summary || '网关未返回可用确认',
            }),
            'command_failed',
            {
              loginProviderId: route.providerId,
              routeMethodId: resolvedRouteMethodId.value,
              pluginId,
              stdout: [result.stdout, gatewayRuntime.stdout].filter(Boolean).join('\n'),
              stderr: [result.stderr, gatewayRuntime.stderr].filter(Boolean).join('\n'),
              code: gatewayRuntime.code,
            }
          )
        }
      }
    }
    return fromCommand(route.kind, attemptedCommands, result, {
      loginProviderId: route.providerId,
      routeMethodId: resolvedRouteMethodId.value,
      pluginId,
    })
  }

  if (route.kind === 'onboard-custom') {
    const configBeforeAuth = await readConfig().catch(() => null)
    gatewayTokenBeforeAuth = readGatewayAuthToken(configBeforeAuth)
    const mainAgentAuthEnv = await resolveMainAgentAuthEnv().catch(() => null)
    const onboardCommand = buildCustomProviderOnboardRouteCommand(method, input.customConfig || ({} as any), input.secret, capabilities)
    if (!onboardCommand.ok) {
      return fromBuildFailure(onboardCommand, attemptedCommands, route.kind, {
        loginProviderId: route.providerId,
        routeMethodId: resolvedRouteMethodId.value,
        pluginId,
      })
    }
    const mainAgentScope = await prepareTemporaryMainAgentDefaultScope({
      configBeforeAuth,
      readConfig,
      writeConfig: writeAuthConfig,
    })
    if (!mainAgentScope.ok) {
      return failed(route.kind, attemptedCommands, mainAgentScope.message, 'command_failed', {
        loginProviderId: route.providerId,
        routeMethodId: resolvedRouteMethodId.value,
        pluginId,
      })
    }

    let onboardResult
    let restoreScopeResult: { ok: true } | { ok: false; message: string } = { ok: true }
    try {
      onboardResult = await executeOnboardCommandWithGatewayRecovery({
        routeKind: route.kind,
        authChoice: method.authChoice,
        command: onboardCommand.command,
        attemptedCommands,
        runCommand:
          mainAgentAuthEnv && runCommandWithEnv
            ? (args, timeout) => runCommandWithEnv(args, timeout, mainAgentAuthEnv)
            : runCommand,
        ensureGatewayRunning,
        extras: {
          loginProviderId: route.providerId,
          routeMethodId: resolvedRouteMethodId.value,
          pluginId,
        },
      })
    } finally {
      restoreScopeResult = await mainAgentScope.restore()
    }
    if (!restoreScopeResult.ok) {
      return failed(route.kind, attemptedCommands, restoreScopeResult.message, 'command_failed', {
        loginProviderId: route.providerId,
        routeMethodId: resolvedRouteMethodId.value,
        pluginId,
      })
    }
    if (onboardResult.status === 'failure') {
      return onboardResult.failure
    }
    const result = onboardResult.result
    if (result.ok) {
      const stalePluginIds = extractStalePluginIdsFromResult(result)
      if (stalePluginIds.length > 0) {
        await (options.pruneStalePluginEntries || pruneStalePluginConfigEntries)(stalePluginIds).catch(() => null)
      }
      const providerConfigRepair = await ensureKnownProviderConfigAfterAuth({
        readConfig,
        writeConfig: writeAuthConfig,
      })
      if (!providerConfigRepair.ok) {
        return failed(route.kind, attemptedCommands, providerConfigRepair.message, 'command_failed', {
          loginProviderId: route.providerId,
          routeMethodId: resolvedRouteMethodId.value,
          pluginId,
          stdout: result.stdout,
          stderr: result.stderr,
          code: result.code,
        })
      }
      const persistedCustomProvider = await waitForPersistedCustomProviderMatch({
        initialConfig: providerConfigRepair.config,
        readConfig,
        customConfig: input.customConfig,
      })
      const resolvedCustomProviderId = resolveCustomProviderIdForAuthSync({
        configData: persistedCustomProvider.config,
        customConfig: input.customConfig,
        fallbackProviderId: input.providerId,
      })
      if (!resolvedCustomProviderId.ok) {
        return failed(route.kind, attemptedCommands, resolvedCustomProviderId.message, 'command_failed', {
          loginProviderId: route.providerId,
          routeMethodId: resolvedRouteMethodId.value,
          pluginId,
          stdout: result.stdout,
          stderr: result.stderr,
          code: result.code,
        })
      }
      const authProfileSync = await syncMainApiKeyAuthProfile({
        providerId: resolvedCustomProviderId.providerId,
        apiKey: input.secret,
      })
      if (!authProfileSync.ok) {
        return failed(route.kind, attemptedCommands, authProfileSync.message, 'command_failed', {
          loginProviderId: route.providerId,
          routeMethodId: resolvedRouteMethodId.value,
          pluginId,
          stdout: result.stdout,
          stderr: result.stderr,
          code: result.code,
        })
      }
      const configAfterAuth = persistedCustomProvider.config || providerConfigRepair.config
      const restoredPluginConfig = restoreTrustedPluginConfig(configBeforeAuth, configAfterAuth, {
        blockedPluginIds: stalePluginIds,
      })
      let effectiveConfigAfterAuth = restoredPluginConfig.config
      if (restoredPluginConfig.changed) {
        try {
          await writeAuthConfig(configAfterAuth, restoredPluginConfig.config)
        } catch {
          effectiveConfigAfterAuth = configAfterAuth || restoredPluginConfig.config
        }
      }
      const gatewayTokenAfterAuth = readGatewayAuthToken(effectiveConfigAfterAuth)
      if (gatewayTokenBeforeAuth !== gatewayTokenAfterAuth) {
        const pendingStore = await issueDesiredRuntimeRevision('auth', 'gateway_token_rotated_by_auth', {
          actions: [
            {
              kind: 'repair',
              action: 'auth-onboard-custom',
              outcome: 'succeeded',
              detail: `认证流程 "${method.authChoice}" 更新了 gateway.auth.token。`,
              changedPaths: ['gateway.auth.token'],
            },
            {
              kind: 'repair',
              action: 'gateway-token-apply',
              outcome: 'scheduled',
            },
          ],
        })
        const runtimeRevision = pendingStore.runtime.desiredRevision
        await markRuntimeRevisionInProgress(runtimeRevision, {
          summary: `认证流程 "${method.authChoice}" 已更新 gateway.auth.token，正在确认网关是否已消费最新 token。`,
          actions: pendingStore.runtime.lastActions,
        })
        const gatewayApply = await applyGatewayTokenRefresh({
          authChoice: method.authChoice,
          runCommand,
          attemptedCommands,
        })
        if (!gatewayApply.ok) {
          await persistAuthRuntimeReconcile({
            revision: runtimeRevision,
            confirmed: false,
            blockingReason: 'runtime_token_stale',
            safeToRetry: true,
            summary: gatewayApply.message,
            actions: [
              {
                kind: 'repair',
                action: 'gateway-token-apply',
                outcome: 'failed',
                detail: gatewayApply.message,
              },
            ],
          })
          return failed(
            route.kind,
            attemptedCommands,
            gatewayApply.message,
            'command_failed',
            {
              loginProviderId: route.providerId,
              routeMethodId: resolvedRouteMethodId.value,
              pluginId,
              stdout: result.stdout,
              stderr: result.stderr,
              code: result.code,
            }
          )
        }
        const gatewayRuntime = await ensureGatewayRunning()
        attemptedCommands.push(...(gatewayRuntime.attemptedCommands || []))
        const gatewayConfirmed = gatewayRuntime.ok && gatewayRuntime.running
        await persistAuthRuntimeReconcile({
          revision: runtimeRevision,
          confirmed: gatewayConfirmed,
          blockingReason: resolveGatewayBlockingReasonFromState({
            gatewayStateCode: gatewayRuntime.stateCode,
          }),
          blockingDetail: gatewayRuntime.reasonDetail,
          safeToRetry: gatewayConfirmed ? true : gatewayRuntime.safeToRetry,
          summary: gatewayConfirmed
            ? `网关已确认消费认证流程 "${method.authChoice}" 更新后的 token。`
            : buildGatewayTokenConfirmFailureMessage({
                authChoice: method.authChoice,
                gatewaySummary: gatewayRuntime.summary || '网关未返回可用确认',
              }),
          actions: [
            {
              kind: 'repair',
              action: `gateway-token-${gatewayApply.appliedAction}`,
              outcome: 'succeeded',
              detail: gatewayApply.note,
            },
            {
              kind: 'probe',
              action: 'gateway-ensure-running',
              outcome: gatewayConfirmed ? 'succeeded' : 'failed',
              detail: gatewayRuntime.summary,
            },
          ],
        })
        if (!gatewayConfirmed) {
          return failed(
            route.kind,
            attemptedCommands,
            buildGatewayTokenConfirmFailureMessage({
              authChoice: method.authChoice,
              gatewaySummary: gatewayRuntime.summary || '网关未返回可用确认',
            }),
            'command_failed',
            {
              loginProviderId: route.providerId,
              routeMethodId: resolvedRouteMethodId.value,
              pluginId,
              stdout: [result.stdout, gatewayRuntime.stdout].filter(Boolean).join('\n'),
              stderr: [result.stderr, gatewayRuntime.stderr].filter(Boolean).join('\n'),
              code: gatewayRuntime.code,
            }
          )
        }
      }
    }
    return fromCommand(route.kind, attemptedCommands, result, {
      loginProviderId: route.providerId,
      routeMethodId: resolvedRouteMethodId.value,
      pluginId,
    })
  }

  if (route.kind === 'models-auth-paste-token') {
    const providerId = route.providerId?.trim()
    if (!providerId) {
      return failed(route.kind, attemptedCommands, `Auth method "${method.authChoice}" does not declare a providerId.`, 'command_failed')
    }
    const pasteTokenCommand = buildModelsAuthPasteTokenCommand(
      {
        providerId,
        profileId: input.profileId,
        expiresIn: input.expiresIn,
      },
      capabilities
    )
    if (!pasteTokenCommand.ok) {
      return fromBuildFailure(pasteTokenCommand, attemptedCommands, route.kind, {
        loginProviderId: providerId,
        routeMethodId: resolvedRouteMethodId.value,
        pluginId,
      })
    }

    attemptedCommands.push(pasteTokenCommand.command)
    const result = await runCommand(pasteTokenCommand.command, TOKEN_TIMEOUT_MS)
    return fromCommand(route.kind, attemptedCommands, result, {
      loginProviderId: providerId,
      routeMethodId: resolvedRouteMethodId.value,
      pluginId,
    })
  }

  if (route.kind === 'models-auth-setup-token') {
    const providerId = route.providerId?.trim()
    if (!providerId) {
      return failed(route.kind, attemptedCommands, `Auth method "${method.authChoice}" does not declare a providerId.`, 'command_failed')
    }
    const setupTokenCommand = buildModelsAuthSetupTokenCommand(
      {
        providerId,
        yes: input.yes,
      },
      capabilities
    )
    if (!setupTokenCommand.ok) {
      return fromBuildFailure(setupTokenCommand, attemptedCommands, route.kind, {
        loginProviderId: providerId,
        routeMethodId: resolvedRouteMethodId.value,
        pluginId,
      })
    }

    attemptedCommands.push(setupTokenCommand.command)
    const result = await runCommand(setupTokenCommand.command, TOKEN_TIMEOUT_MS)
    return fromCommand(route.kind, attemptedCommands, result, {
      loginProviderId: providerId,
      routeMethodId: resolvedRouteMethodId.value,
      pluginId,
    })
  }

  return failed(route.kind, attemptedCommands, `Unsupported auth route kind: ${route.kind}`, 'command_failed')
}

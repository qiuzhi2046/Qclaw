import type {
  CliCommandResult,
  OpenClawCapabilities,
  OpenClawCapabilitiesProfile,
} from './openclaw-capabilities'
import {
  buildModelsAliasesCommand,
  buildModelsFallbacksCommand,
  buildModelsImageFallbacksCommand,
  buildModelsScanCommand,
  buildModelsStatusCommand,
  type OpenClawCommandBuildResult,
} from './openclaw-command-builder'
import { pluginEnableLooksSuccessful } from './openclaw-auth-plugins'
import { getCliFailureMessage, parseJsonFromOutput } from './openclaw-command-output'
import type { RepairStalePluginConfigFromCommandResult } from './openclaw-config-warnings'
import { rerunReadOnlyCommandAfterStalePluginRepair } from './openclaw-readonly-stale-plugin-repair'
import { buildOpenClawLegacyEnvPatch } from './openclaw-legacy-env-migration'
import { MAIN_RUNTIME_POLICY } from './runtime-policy'
import {
  listKnownProviderMetadata,
  resolveProviderMethodEnvKey,
  supportsProviderMethodRealtimeValidation,
} from '../../src/lib/openclaw-provider-registry'

const { mkdtemp, rm } =
  process.getBuiltinModule('node:fs/promises') as typeof import('node:fs/promises')
const { join } = process.getBuiltinModule('node:path') as typeof import('node:path')
const { tmpdir } = process.getBuiltinModule('node:os') as typeof import('node:os')

const DEFAULT_ACTION_TIMEOUT_MS = MAIN_RUNTIME_POLICY.modelConfig.actionTimeoutMs
const DEFAULT_STATUS_TIMEOUT_MS = MAIN_RUNTIME_POLICY.modelConfig.statusTimeoutMs
const DEFAULT_PLUGIN_ENABLE_TIMEOUT_MS = MAIN_RUNTIME_POLICY.auth.pluginEnableTimeoutMs
const MODEL_STATUS_CAPABILITIES_PROFILE: OpenClawCapabilitiesProfile = 'bootstrap'

export type ModelConfigAction =
  | { kind: 'set-default-model'; model: string }
  | { kind: 'set-image-model'; model: string }
  | { kind: 'alias-add'; alias: string; model: string }
  | { kind: 'alias-remove'; alias: string }
  | { kind: 'alias-list' }
  | { kind: 'fallback-add'; model: string }
  | { kind: 'fallback-remove'; model: string }
  | { kind: 'fallback-list' }
  | { kind: 'fallback-clear' }
  | { kind: 'image-fallback-add'; model: string }
  | { kind: 'image-fallback-remove'; model: string }
  | { kind: 'image-fallback-list' }
  | { kind: 'image-fallback-clear' }
  | {
      kind: 'scan-models'
      provider?: string
      json?: boolean
      yes?: boolean
      noProbe?: boolean
      setDefault?: boolean
      setImage?: boolean
      maxCandidates?: number
      timeoutMs?: number
      concurrency?: number
      maxAgeDays?: number
      minParams?: number
      noInput?: boolean
    }

export type ModelConfigErrorCode =
  | 'command_failed'
  | 'parse_error'
  | 'invalid_action'
  | 'unsupported_capability'

export interface ModelConfigCommandResult<T = unknown> {
  ok: boolean
  action: ModelConfigAction['kind'] | 'status'
  command: string[]
  stdout: string
  stderr: string
  code: number | null
  data?: T
  errorCode?: ModelConfigErrorCode
  message?: string
}

export interface ModelStatusOptions {
  agentId?: string
  probe?: boolean
  probeProvider?: string
  probeTimeoutMs?: number
  probeConcurrency?: number
  probeMaxTokens?: number
  probeProfile?: string | string[]
  check?: boolean
}

interface CommandExecutorOptions {
  runCommand?: (args: string[], timeout?: number) => Promise<CliCommandResult>
  runCommandWithEnv?: (
    args: string[],
    timeout: number | undefined,
    env: Partial<NodeJS.ProcessEnv>
  ) => Promise<CliCommandResult>
  repairStalePluginConfigFromCommandResult?: (
    result: {
      stdout?: string
      stderr?: string
    }
  ) => Promise<RepairStalePluginConfigFromCommandResult>
  enablePluginCommand?: (pluginId: string, timeout?: number) => Promise<CliCommandResult>
  capabilities?: OpenClawCapabilities
  loadCapabilities?: (options?: { profile?: OpenClawCapabilitiesProfile }) => Promise<OpenClawCapabilities>
}

interface EnvCommandExecutorOptions extends CommandExecutorOptions {
  createTempDir?: (prefix: string) => Promise<string>
  removeTempDir?: (pathname: string) => Promise<void>
}

async function defaultRunCommand(args: string[], timeout?: number): Promise<CliCommandResult> {
  const cli = await import('./cli')
  return cli.runCli(args, timeout, 'models')
}

async function defaultRunCommandWithEnv(
  args: string[],
  timeout: number | undefined,
  env: Partial<NodeJS.ProcessEnv>
): Promise<CliCommandResult> {
  const cli = await import('./cli')
  return cli.runCliStreaming(args, {
    timeout,
    controlDomain: 'models',
    env,
  })
}

async function noopRepairStalePluginConfigFromCommandResult(): Promise<RepairStalePluginConfigFromCommandResult> {
  return {
    stalePluginIds: [],
    changed: false,
    removedPluginIds: [],
  }
}

async function defaultEnablePluginCommand(pluginId: string, timeout?: number): Promise<CliCommandResult> {
  const cli = await import('./cli')
  return cli.runCli(['plugins', 'enable', pluginId], timeout, 'plugin-install')
}

function parseJsonResult<T>(
  action: ModelConfigAction['kind'] | 'status',
  command: string[],
  result: CliCommandResult
): ModelConfigCommandResult<T> {
  try {
    const parsed = parseJsonFromOutput<T>(result.stdout)
    return {
      ok: true,
      action,
      command,
      stdout: result.stdout,
      stderr: result.stderr,
      code: result.code,
      data: parsed,
    }
  } catch (error) {
    return {
      ok: false,
      action,
      command,
      stdout: result.stdout,
      stderr: result.stderr,
      code: result.code,
      errorCode: 'parse_error',
      message: `Failed to parse JSON output: ${(error as Error).message}`,
    }
  }
}

function mapBuildErrorToResult<T = unknown>(
  action: ModelConfigAction['kind'] | 'status',
  buildResult: Extract<OpenClawCommandBuildResult, { ok: false }>
): ModelConfigCommandResult<T> {
  return {
    ok: false,
    action,
    command: [],
    stdout: '',
    stderr: '',
    code: null,
    errorCode: buildResult.errorCode === 'invalid_input' ? 'invalid_action' : 'unsupported_capability',
    message: buildResult.message,
  }
}

async function resolveCapabilities(
  options: CommandExecutorOptions
): Promise<OpenClawCapabilities | undefined> {
  if (options.capabilities) return options.capabilities
  if (options.loadCapabilities) return options.loadCapabilities()
  if (options.runCommand || options.runCommandWithEnv) return undefined

  const { loadOpenClawCapabilities } = await import('./openclaw-capabilities')
  return loadOpenClawCapabilities()
}

async function resolveModelStatusCapabilities(
  options: CommandExecutorOptions
): Promise<OpenClawCapabilities | undefined> {
  if (options.capabilities) return options.capabilities
  if (options.loadCapabilities) {
    return options.loadCapabilities({ profile: MODEL_STATUS_CAPABILITIES_PROFILE })
  }
  if (options.runCommand || options.runCommandWithEnv) return undefined

  const { loadOpenClawCapabilities } = await import('./openclaw-capabilities')
  return loadOpenClawCapabilities({ profile: MODEL_STATUS_CAPABILITIES_PROFILE })
}

function mapActionToCommand(
  action: ModelConfigAction,
  capabilities?: OpenClawCapabilities
): OpenClawCommandBuildResult {
  switch (action.kind) {
    case 'set-default-model':
      return { ok: true, commandId: 'models.set', command: ['models', 'set', action.model] }
    case 'set-image-model':
      return { ok: true, commandId: 'models.set-image', command: ['models', 'set-image', action.model] }
    case 'alias-add':
      return buildModelsAliasesCommand('add', { alias: action.alias, model: action.model }, capabilities)
    case 'alias-remove':
      return buildModelsAliasesCommand('remove', { alias: action.alias }, capabilities)
    case 'alias-list':
      return buildModelsAliasesCommand('list', {}, capabilities)
    case 'fallback-add':
      return buildModelsFallbacksCommand('add', { model: action.model }, capabilities)
    case 'fallback-remove':
      return buildModelsFallbacksCommand('remove', { model: action.model }, capabilities)
    case 'fallback-list':
      return buildModelsFallbacksCommand('list', {}, capabilities)
    case 'fallback-clear':
      return buildModelsFallbacksCommand('clear', {}, capabilities)
    case 'image-fallback-add':
      return buildModelsImageFallbacksCommand('add', { model: action.model }, capabilities)
    case 'image-fallback-remove':
      return buildModelsImageFallbacksCommand('remove', { model: action.model }, capabilities)
    case 'image-fallback-list':
      return buildModelsImageFallbacksCommand('list', {}, capabilities)
    case 'image-fallback-clear':
      return buildModelsImageFallbacksCommand('clear', {}, capabilities)
    case 'scan-models':
      return buildModelsScanCommand(action, capabilities)
    default: {
      const _exhaustive: never = action
      return {
        ok: false,
        commandId: 'models.scan',
        errorCode: 'invalid_input',
        message: `Unsupported action: ${String(_exhaustive)}`,
      }
    }
  }
}

function shouldParseJson(action: ModelConfigAction): boolean {
  if (action.kind === 'alias-list' || action.kind === 'fallback-list' || action.kind === 'image-fallback-list') {
    return true
  }
  if (action.kind === 'scan-models' && action.json) return true
  return false
}

export async function applyModelConfigAction<T = unknown>(
  action: ModelConfigAction,
  options: CommandExecutorOptions = {}
): Promise<ModelConfigCommandResult<T>> {
  const runCommand = options.runCommand ?? defaultRunCommand
  const capabilities = await resolveCapabilities(options)

  const buildResult = mapActionToCommand(action, capabilities)
  if (!buildResult.ok) {
    return mapBuildErrorToResult(action.kind, buildResult)
  }

  const command = buildResult.command
  const result = await runCommand(command, DEFAULT_ACTION_TIMEOUT_MS)
  if (!result.ok) {
    return {
      ok: false,
      action: action.kind,
      command,
      stdout: result.stdout,
      stderr: result.stderr,
      code: result.code,
      errorCode: 'command_failed',
      message: getCliFailureMessage(result, 'Model config command failed'),
    }
  }

  if (shouldParseJson(action)) {
    return parseJsonResult<T>(action.kind, command, result)
  }

  return {
    ok: true,
    action: action.kind,
    command,
    stdout: result.stdout,
    stderr: result.stderr,
    code: result.code,
  }
}

export interface LocalModelScanInput {
  provider: string
  baseUrl?: string
  apiKey?: string
  timeoutMs?: number
}

export interface ValidateProviderCredentialInput {
  providerId: string
  methodId?: string
  secret: string
  timeoutMs?: number
}

export interface ValidateProviderCredentialResult {
  ok: boolean
  validated: boolean
  stdout: string
  stderr: string
  code: number | null
  message?: string
  data?: Record<string, any>
}

const NO_MODELS_FOUND_OUTPUT_REGEX = /(?:^|\n)\s*(?:error:\s*)?no(?:\s+\w+){0,3}\s+models?\s+found\.?\s*(?:\n|$)/i

function readLocalScanEntries(payload: unknown): Array<Record<string, unknown>> {
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

function normalizeLocalScanModelKey(rawKey: string, provider: string): string {
  const trimmed = String(rawKey || '').trim()
  if (!trimmed) return ''
  if (!provider) return trimmed
  if (trimmed.includes('/')) return trimmed
  return `${provider}/${trimmed}`
}

function normalizeLocalScanPayload(payload: unknown, provider: string): { count: number; models: Array<{ key: string; name: string }> } {
  const entries = readLocalScanEntries(payload)
  const models: Array<{ key: string; name: string }> = []
  const seen = new Set<string>()

  for (const entry of entries) {
    const rawId = String(entry.key ?? entry.model ?? entry.id ?? entry.name ?? '').trim()
    const key = normalizeLocalScanModelKey(rawId, provider)
    if (!key || seen.has(key)) continue
    const name = String(entry.name ?? entry.model ?? entry.key ?? entry.id ?? key).trim() || key
    models.push({ key, name })
    seen.add(key)
  }

  return {
    count: models.length,
    models,
  }
}

const LOCAL_PROVIDER_ENV_MAP: Record<string, { hostKey?: string; apiKeyKey?: string }> = {
  ollama: { hostKey: 'OLLAMA_HOST', apiKeyKey: 'OLLAMA_API_KEY' },
  vllm: { hostKey: 'VLLM_BASE_URL', apiKeyKey: 'VLLM_API_KEY' },
  'custom-openai': { hostKey: 'OPENAI_BASE_URL', apiKeyKey: 'OPENAI_API_KEY' },
}

const LOCAL_PROVIDER_DEFAULT_URLS: Record<string, string> = {
  ollama: 'http://127.0.0.1:11434',
  vllm: 'http://127.0.0.1:8000/v1',
}

const LOCAL_PROVIDER_PLUGIN_ID_MAP: Record<string, string> = {
  ollama: 'ollama',
  vllm: 'vllm',
}

function buildLocalProviderCommandEnv(input: LocalModelScanInput): Partial<NodeJS.ProcessEnv> {
  const provider = String(input.provider || '').trim()
  const envMapping = LOCAL_PROVIDER_ENV_MAP[provider]
  if (!envMapping) return {}

  const normalizedBaseUrl = String(input.baseUrl || '').trim()
  const normalizedApiKey = String(input.apiKey || '').trim()
  const envUpdates: Record<string, string | undefined> = {}

  if (envMapping.hostKey) {
    envUpdates[envMapping.hostKey] = normalizedBaseUrl || LOCAL_PROVIDER_DEFAULT_URLS[provider] || undefined
  }

  if (envMapping.apiKeyKey) {
    envUpdates[envMapping.apiKeyKey] = normalizedApiKey || undefined
  }

  return envUpdates
}

function buildProviderValidationEnv(params: {
  envKey: string
  secret: string
  isolatedHomeDir: string
}): Partial<NodeJS.ProcessEnv> {
  const legacyEnvPatch = buildOpenClawLegacyEnvPatch(process.env)
  const env: Partial<NodeJS.ProcessEnv> = {
    ...legacyEnvPatch,
    OPENCLAW_HOME: params.isolatedHomeDir,
    OPENCLAW_AUTH_STORE_READONLY: '1',
    OPENCLAW_CONFIG_PATH: undefined,
    OPENCLAW_PROFILE: undefined,
  }

  for (const provider of listKnownProviderMetadata()) {
    if (provider.primaryEnvKey) {
      env[provider.primaryEnvKey] = undefined
    }
    for (const method of provider.methods || []) {
      if (method.envKey) {
        env[method.envKey] = undefined
      }
    }
  }

  for (const mapping of Object.values(LOCAL_PROVIDER_ENV_MAP)) {
    if (mapping.hostKey) {
      env[mapping.hostKey] = undefined
    }
    if (mapping.apiKeyKey) {
      env[mapping.apiKeyKey] = undefined
    }
  }

  env[params.envKey] = params.secret
  return env
}

function hasProbeSuccess(value: any): boolean {
  return value?.ok === true || String(value?.status || '').trim().toLowerCase() === 'ok' || value?.success === true
}

function hasProbeFailure(value: any): boolean {
  const status = String(value?.status || '').trim().toLowerCase()
  return (
    value?.ok === false
    || ['error', 'missing', 'none', 'disabled', 'unconfigured'].includes(status)
    || Boolean(value?.error)
  )
}

function extractProviderProbeEntries(
  data: Record<string, any> | null | undefined
): Array<[string, any]> {
  const probeResults = data?.probe || data?.probeResults
  if (!probeResults || typeof probeResults !== 'object') return []
  return Object.entries(probeResults)
}

function parseStructuredProbePayload(
  stdout: string,
  stderr: string
): Record<string, any> | null {
  for (const output of [stdout, stderr]) {
    if (!String(output || '').trim()) continue
    try {
      const parsed = parseJsonFromOutput<Record<string, any>>(output)
      if (extractProviderProbeEntries(parsed).length > 0) {
        return parsed
      }
    } catch {
      // Ignore non-JSON output and keep looking for structured probe payloads.
    }
  }
  return null
}

function buildProbeValidationMessage(
  entries: Array<[string, any]>
): { ok: boolean; message: string } {
  if (!entries.length) {
    return {
      ok: false,
      message: 'OpenClaw 未返回可判定的探测结果，暂时无法确认当前输入的 API Key 是否有效。',
    }
  }

  const firstFailure = entries.find(([, value]) => hasProbeFailure(value))
  if (firstFailure) {
    const detail = String(firstFailure[1]?.error || firstFailure[1]?.message || '').trim()
    return {
      ok: false,
      message: detail || 'API Key 校验失败，请检查凭证是否正确或账户是否已开通对应模型权限。',
    }
  }

  if (entries.some(([, value]) => hasProbeSuccess(value))) {
    return {
      ok: true,
      message: 'API Key 有效，Provider 探测成功。',
    }
  }

  return {
    ok: false,
    message: '探测结果未明确成功，暂时无法确认当前输入的 API Key 是否有效。',
  }
}

export async function scanLocalModels(
  input: LocalModelScanInput,
  options: CommandExecutorOptions = {}
): Promise<ModelConfigCommandResult> {
  const { provider, baseUrl, apiKey, timeoutMs } = input
  const capabilities = await resolveCapabilities(options)
  const pluginId = LOCAL_PROVIDER_PLUGIN_ID_MAP[provider]
  const enablePluginCommand = options.enablePluginCommand ?? (!options.runCommand ? defaultEnablePluginCommand : null)
  const runCommand = options.runCommand ?? defaultRunCommand
  const runCommandWithEnv = options.runCommandWithEnv ?? (options.runCommand ? undefined : defaultRunCommandWithEnv)

  if (pluginId && enablePluginCommand) {
    if (capabilities && !capabilities.supports.pluginsEnable) {
      return {
        ok: false,
        action: 'scan-models',
        command: ['plugins', 'enable', pluginId],
        stdout: '',
        stderr: '',
        code: null,
        errorCode: 'unsupported_capability',
        message: '当前 OpenClaw 版本不支持 plugins enable，无法启用本地 provider 插件。',
      }
    }

    const pluginEnableResult = await enablePluginCommand(pluginId, DEFAULT_PLUGIN_ENABLE_TIMEOUT_MS)
    if (!pluginEnableLooksSuccessful(pluginEnableResult)) {
      return {
        ok: false,
        action: 'scan-models',
        command: ['plugins', 'enable', pluginId],
        stdout: pluginEnableResult.stdout,
        stderr: pluginEnableResult.stderr,
        code: pluginEnableResult.code,
        errorCode: 'command_failed',
        message: getCliFailureMessage(pluginEnableResult, `启用本地 provider 插件失败（${pluginId}）`),
      }
    }
  }

  // Use `models list --all --local --json` to discover local models.
  // `models scan` is OpenRouter-specific and not suitable for local providers.
  const command = ['models', 'list', '--all', '--local', '--json']
  if (provider) {
    command.push('--provider', provider)
  }

  const effectiveTimeout = timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS
  const localCommandEnv = buildLocalProviderCommandEnv(input)
  const shouldUseCommandEnv = Object.keys(localCommandEnv).length > 0 && Boolean(runCommandWithEnv)
  const result =
    shouldUseCommandEnv && runCommandWithEnv
      ? await runCommandWithEnv(command, effectiveTimeout, localCommandEnv)
      : await runCommand(command, effectiveTimeout)

  if (!result.ok) {
    return {
      ok: false,
      action: 'scan-models',
      command,
      stdout: result.stdout,
      stderr: result.stderr,
      code: result.code,
      errorCode: 'command_failed',
      message: getCliFailureMessage(result, 'Local model discovery failed'),
    }
  }

  const parsed = parseJsonResult<Record<string, unknown>>('scan-models', command, result)
  if (parsed.ok) {
    return {
      ...parsed,
      data: normalizeLocalScanPayload(parsed.data, provider),
    }
  }

  const normalizedStdout = String(result.stdout || '')
    .replace(/\u001B(?:\[[0-?]*[ -/]*[@-~]|[@-_])/g, '')
    .replace(/\r\n?/g, '\n')

  // Some local provider bridges return a plain-text success message when no models are loaded.
  // Treat it as an empty model list so the UI can guide the user to pull/load models.
  if (parsed.errorCode === 'parse_error' && NO_MODELS_FOUND_OUTPUT_REGEX.test(normalizedStdout)) {
    return {
      ok: true,
      action: 'scan-models',
      command,
      stdout: result.stdout,
      stderr: result.stderr,
      code: result.code,
      data: {
        count: 0,
        models: [],
      },
    }
  }

  return parsed
}

export async function validateProviderCredential(
  input: ValidateProviderCredentialInput,
  options: EnvCommandExecutorOptions = {}
): Promise<ValidateProviderCredentialResult> {
  const providerId = String(input.providerId || '').trim()
  const methodId = String(input.methodId || '').trim()
  const secret = String(input.secret || '').trim()
  if (!providerId || !methodId || !secret) {
    return {
      ok: false,
      validated: false,
      stdout: '',
      stderr: '',
      code: null,
      message: 'providerId、methodId 和 secret 都是必填项。',
    }
  }

  const envKey = resolveProviderMethodEnvKey(providerId, methodId)
  const supportsRealtimeValidation = supportsProviderMethodRealtimeValidation(providerId, methodId)
  if (!envKey || !supportsRealtimeValidation) {
    return {
      ok: false,
      validated: false,
      stdout: '',
      stderr: '',
      code: null,
      message: '当前认证方式暂不支持无歧义的实时 API Key 校验。',
    }
  }

  const runCommandWithEnv = options.runCommandWithEnv ?? defaultRunCommandWithEnv
  const createTempDir = options.createTempDir ?? ((prefix: string) => mkdtemp(prefix))
  const removeTempDir = options.removeTempDir ?? ((pathname: string) => rm(pathname, { recursive: true, force: true }))
  const isolatedHomeDir = await createTempDir(join(tmpdir(), 'qclaw-provider-validate-'))

  try {
    const statusResult = await getModelStatus<Record<string, any>>(
      {
        probe: true,
        probeProvider: providerId,
        probeTimeoutMs: input.timeoutMs,
        check: true,
      },
      {
        ...options,
        runCommand: (args, timeout) =>
          runCommandWithEnv(
            args,
            timeout,
            buildProviderValidationEnv({
              envKey,
              secret,
              isolatedHomeDir,
            })
          ),
      }
    )

    if (!statusResult.ok) {
      const structuredProbePayload = parseStructuredProbePayload(statusResult.stdout, statusResult.stderr)
      if (structuredProbePayload) {
        const validation = buildProbeValidationMessage(extractProviderProbeEntries(structuredProbePayload))
        return {
          ok: false,
          validated: false,
          stdout: statusResult.stdout,
          stderr: statusResult.stderr,
          code: statusResult.code,
          message: validation.message,
          data: structuredProbePayload,
        }
      }

      return {
        ok: false,
        validated: false,
        stdout: statusResult.stdout,
        stderr: statusResult.stderr,
        code: statusResult.code,
        message: statusResult.message || 'API Key 校验命令执行失败。',
      }
    }

    const data = (statusResult.data || null) as Record<string, any> | null
    const probeEntries = extractProviderProbeEntries(data)
    const validation = buildProbeValidationMessage(probeEntries)
    return {
      ok: validation.ok,
      validated: validation.ok,
      stdout: statusResult.stdout,
      stderr: statusResult.stderr,
      code: statusResult.code,
      message: validation.message,
      ...(data ? { data } : {}),
    }
  } finally {
    await removeTempDir(isolatedHomeDir).catch(() => {})
  }
}

export async function getModelStatus<T = unknown>(
  statusOptions: ModelStatusOptions = {},
  options: CommandExecutorOptions = {}
): Promise<ModelConfigCommandResult<T>> {
  const runCommand = options.runCommand ?? defaultRunCommand
  const runCommandWithEnv = options.runCommandWithEnv ?? defaultRunCommandWithEnv
  const capabilities = await resolveModelStatusCapabilities(options)

  const buildResult = buildModelsStatusCommand(statusOptions, capabilities)
  if (!buildResult.ok) {
    return mapBuildErrorToResult('status', buildResult)
  }

  const command = buildResult.command
  const statusEnv: Partial<NodeJS.ProcessEnv> = {
    ...buildOpenClawLegacyEnvPatch(process.env),
    OPENCLAW_AUTH_STORE_READONLY: '1',
  }
  const repairStalePluginConfigFromCommandResult =
    options.runCommand || options.runCommandWithEnv
      ? noopRepairStalePluginConfigFromCommandResult
      : undefined
  const result = await rerunReadOnlyCommandAfterStalePluginRepair(
    () =>
      options.runCommand
        ? runCommand(command, DEFAULT_STATUS_TIMEOUT_MS)
        : runCommandWithEnv(command, DEFAULT_STATUS_TIMEOUT_MS, statusEnv),
    {
      repairStalePluginConfigFromCommandResult,
    }
  )
  if (!result.ok) {
    return {
      ok: false,
      action: 'status',
      command,
      stdout: result.stdout,
      stderr: result.stderr,
      code: result.code,
      errorCode: 'command_failed',
      message: getCliFailureMessage(result, 'Model status command failed'),
    }
  }

  return parseJsonResult<T>('status', command, result)
}

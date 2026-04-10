import type { OpenClawCapabilities } from './openclaw-capabilities'
import type { OpenClawAuthMethodDescriptor } from './openclaw-auth-registry'
import { normalizeAuthChoice } from './openclaw-spawn'

type CommandSupportKey = keyof OpenClawCapabilities['supports']

type CapabilitySnapshot = Pick<
  OpenClawCapabilities,
  'commandFlags' | 'supports' | 'onboardFlags' | 'modelsCommands' | 'modelsAuthCommands' | 'pluginsCommands'
>

export type OpenClawCommandId =
  | 'onboard'
  | 'plugins.enable'
  | 'plugins.install'
  | 'models.set'
  | 'models.set-image'
  | 'models.list'
  | 'models.status'
  | 'models.scan'
  | 'models.auth.login'
  | 'models.auth.add'
  | 'models.auth.paste-token'
  | 'models.auth.setup-token'
  | 'models.auth.order.get'
  | 'models.auth.order.set'
  | 'models.auth.order.clear'
  | 'models.auth.login-github-copilot'
  | 'models.aliases.add'
  | 'models.aliases.remove'
  | 'models.aliases.list'
  | 'models.fallbacks.add'
  | 'models.fallbacks.remove'
  | 'models.fallbacks.list'
  | 'models.fallbacks.clear'
  | 'models.image-fallbacks.add'
  | 'models.image-fallbacks.remove'
  | 'models.image-fallbacks.list'
  | 'models.image-fallbacks.clear'

export type OpenClawCommandBuildErrorCode =
  | 'invalid_input'
  | 'unsupported_command'
  | 'unsupported_flag'

export interface OpenClawCommandBuildSuccess {
  ok: true
  commandId: OpenClawCommandId
  command: string[]
}

export interface OpenClawCommandBuildFailure {
  ok: false
  commandId: OpenClawCommandId
  errorCode: OpenClawCommandBuildErrorCode
  message: string
  missing?: string[]
}

export type OpenClawCommandBuildResult =
  | OpenClawCommandBuildSuccess
  | OpenClawCommandBuildFailure

export type CustomProviderCompatibility = 'openai' | 'anthropic'

export interface CustomProviderConfigInput {
  baseUrl: string
  modelId: string
  providerId?: string
  compatibility?: CustomProviderCompatibility
}

export interface OnboardFlagValueInput {
  flag: string
  value: string
}

export interface BuildOnboardCommandInput {
  interactive?: boolean
  authChoice?: string
  acceptRisk?: boolean
  installDaemon?: boolean
  skipChannels?: boolean
  skipSkills?: boolean
  skipUi?: boolean
  skipHealth?: boolean
  mode?: string
  gatewayBind?: string
  gatewayPort?: string | number
  valueFlags?: OnboardFlagValueInput[]
}

export const OPENCLAW_ONBOARD_OPTION_FLAGS: Record<string, string> = {
  anthropicApiKey: '--anthropic-api-key',
  openaiApiKey: '--openai-api-key',
  geminiApiKey: '--gemini-api-key',
  openrouterApiKey: '--openrouter-api-key',
  mistralApiKey: '--mistral-api-key',
  xaiApiKey: '--xai-api-key',
  moonshotApiKey: '--moonshot-api-key',
  kimiCodeApiKey: '--kimi-code-api-key',
  zaiApiKey: '--zai-api-key',
  qianfanApiKey: '--qianfan-api-key',
  volcengineApiKey: '--volcengine-api-key',
  minimaxApiKey: '--minimax-api-key',
  minimaxApiKeyCn: '--minimax-api-key-cn',
  xiaomiApiKey: '--xiaomi-api-key',
  togetherApiKey: '--together-api-key',
  huggingfaceApiKey: '--huggingface-api-key',
  veniceApiKey: '--venice-api-key',
  syntheticApiKey: '--synthetic-api-key',
  litellmApiKey: '--litellm-api-key',
  kilocodeApiKey: '--kilocode-api-key',
  aiGatewayApiKey: '--ai-gateway-api-key',
  cloudflareAiGatewayApiKey: '--cloudflare-ai-gateway-api-key',
  opencodeZenApiKey: '--opencode-zen-api-key',
  byteplusApiKey: '--byteplus-api-key',
  customApiKey: '--custom-api-key',
  customBaseUrl: '--custom-base-url',
  customCompatibility: '--custom-compatibility',
  customModelId: '--custom-model-id',
  customProviderId: '--custom-provider-id',
  workspace: '--workspace',
}

function success(commandId: OpenClawCommandId, command: string[]): OpenClawCommandBuildSuccess {
  return {
    ok: true,
    commandId,
    command,
  }
}

function failed(
  commandId: OpenClawCommandId,
  errorCode: OpenClawCommandBuildErrorCode,
  message: string,
  missing?: string[]
): OpenClawCommandBuildFailure {
  return {
    ok: false,
    commandId,
    errorCode,
    message,
    ...(missing?.length ? { missing } : {}),
  }
}

function normalizeNonEmpty(value: string | number | null | undefined): string {
  return String(value ?? '').trim()
}

function flagSet(capabilities: CapabilitySnapshot | undefined, commandKey: string): Set<string> | null {
  if (!capabilities) return null
  const flags = capabilities.commandFlags[commandKey]
  if (!Array.isArray(flags)) return new Set()
  return new Set(flags)
}

function ensureCommandSupport(
  commandId: OpenClawCommandId,
  capabilities: CapabilitySnapshot | undefined,
  supportKey: CommandSupportKey,
  fallbackMessage: string
): OpenClawCommandBuildFailure | null {
  if (!capabilities) return null
  if (capabilities.supports[supportKey]) return null
  return failed(commandId, 'unsupported_command', fallbackMessage)
}

function ensureFlags(
  commandId: OpenClawCommandId,
  capabilities: CapabilitySnapshot | undefined,
  commandKey: string,
  requiredFlags: string[],
  label: string
): OpenClawCommandBuildFailure | null {
  if (!capabilities || requiredFlags.length === 0) return null

  const discoveredFlags = flagSet(capabilities, commandKey)
  if (!discoveredFlags) return null

  const missing = requiredFlags.filter((flag) => !discoveredFlags.has(flag))
  if (missing.length === 0) return null

  return failed(
    commandId,
    'unsupported_flag',
    `${label} requires unsupported OpenClaw flags: ${missing.join(', ')}`,
    missing
  )
}

function pushStringFlag(
  args: string[],
  usedFlags: Set<string>,
  flag: string,
  value: string | number | null | undefined
): void {
  const normalized = normalizeNonEmpty(value)
  if (!normalized) return
  args.push(flag, normalized)
  usedFlags.add(flag)
}

function pushBooleanFlag(args: string[], usedFlags: Set<string>, enabled: boolean | undefined, flag: string): void {
  if (!enabled) return
  args.push(flag)
  usedFlags.add(flag)
}

function normalizeProfileList(value?: string | string[]): string[] {
  const rawItems = Array.isArray(value) ? value : value ? [value] : []
  return rawItems.map((item) => normalizeNonEmpty(item)).filter(Boolean)
}

export function collectOnboardValueFlags(options: Record<string, unknown>): OnboardFlagValueInput[] {
  const valueFlags: OnboardFlagValueInput[] = []
  for (const [key, flag] of Object.entries(OPENCLAW_ONBOARD_OPTION_FLAGS)) {
    const rawValue = options[key]
    if (typeof rawValue !== 'string' && typeof rawValue !== 'number') continue
    const normalized = normalizeNonEmpty(rawValue)
    if (!normalized) continue
    valueFlags.push({ flag, value: normalized })
  }
  return valueFlags
}

export function buildOnboardCommand(
  input: BuildOnboardCommandInput,
  capabilities?: CapabilitySnapshot
): OpenClawCommandBuildResult {
  const supportError = ensureCommandSupport(
    'onboard',
    capabilities,
    'onboard',
    'This OpenClaw build does not expose the onboard command.'
  )
  if (supportError) return supportError

  const args = ['onboard']
  const usedFlags = new Set<string>()

  if (input.interactive) {
    args.push('--flow', 'quickstart')
    usedFlags.add('--flow')
  } else {
    args.push('--non-interactive')
    usedFlags.add('--non-interactive')
  }

  const normalizedAuthChoice = normalizeNonEmpty(input.authChoice)
  if (normalizedAuthChoice) {
    args.push('--auth-choice', normalizeAuthChoice(normalizedAuthChoice))
    usedFlags.add('--auth-choice')
  }

  for (const item of input.valueFlags || []) {
    const flag = normalizeNonEmpty(item.flag)
    const value = normalizeNonEmpty(item.value)
    if (!flag || !value) continue
    args.push(flag, value)
    usedFlags.add(flag)
  }

  pushBooleanFlag(args, usedFlags, input.acceptRisk, '--accept-risk')

  if (input.installDaemon === true) {
    args.push('--install-daemon')
    usedFlags.add('--install-daemon')
  } else if (input.installDaemon === false) {
    args.push('--no-install-daemon')
    usedFlags.add('--no-install-daemon')
  }

  if (input.skipChannels !== false) {
    args.push('--skip-channels')
    usedFlags.add('--skip-channels')
  }
  pushBooleanFlag(args, usedFlags, input.skipHealth, '--skip-health')
  if (input.skipSkills !== false) {
    args.push('--skip-skills')
    usedFlags.add('--skip-skills')
  }
  if (input.skipUi !== false) {
    args.push('--skip-ui')
    usedFlags.add('--skip-ui')
  }
  pushStringFlag(args, usedFlags, '--mode', input.mode)
  pushStringFlag(args, usedFlags, '--gateway-bind', input.gatewayBind)
  pushStringFlag(args, usedFlags, '--gateway-port', input.gatewayPort)

  const flagError = ensureFlags('onboard', capabilities, 'onboard', Array.from(usedFlags), 'onboard')
  if (flagError) return flagError

  return success('onboard', args)
}

export function buildPluginEnableCommand(
  pluginId: string,
  capabilities?: CapabilitySnapshot
): OpenClawCommandBuildResult {
  const normalizedPluginId = normalizeNonEmpty(pluginId)
  if (!normalizedPluginId) {
    return failed('plugins.enable', 'invalid_input', 'pluginId is required')
  }

  const supportError = ensureCommandSupport(
    'plugins.enable',
    capabilities,
    'pluginsEnable',
    'This OpenClaw build does not support plugins enable.'
  )
  if (supportError) return supportError

  return success('plugins.enable', ['plugins', 'enable', normalizedPluginId])
}

export function buildPluginInstallCommand(
  pluginPackage: string,
  capabilities?: CapabilitySnapshot
): OpenClawCommandBuildResult {
  const normalizedPackage = normalizeNonEmpty(pluginPackage)
  if (!normalizedPackage) {
    return failed('plugins.install', 'invalid_input', 'pluginPackage is required')
  }

  const supportError = ensureCommandSupport(
    'plugins.install',
    capabilities,
    'pluginsInstall',
    'This OpenClaw build does not support plugins install.'
  )
  if (supportError) return supportError

  return success('plugins.install', ['plugins', 'install', normalizedPackage])
}

export function buildModelsListAllCommand(capabilities?: CapabilitySnapshot): OpenClawCommandBuildResult {
  const supportError = ensureCommandSupport(
    'models.list',
    capabilities,
    'modelsListAllJson',
    'This OpenClaw build does not support models list --all --json.'
  )
  if (supportError) return supportError

  const flagError = ensureFlags(
    'models.list',
    capabilities,
    'models list',
    ['--all', '--json'],
    'models list'
  )
  if (flagError) return flagError

  return success('models.list', ['models', 'list', '--all', '--json'])
}

export interface BuildModelsStatusCommandInput {
  agentId?: string
  probe?: boolean
  probeProvider?: string
  probeTimeoutMs?: number
  probeConcurrency?: number
  probeMaxTokens?: number
  probeProfile?: string | string[]
  check?: boolean
}

export function buildModelsStatusCommand(
  input: BuildModelsStatusCommandInput = {},
  capabilities?: CapabilitySnapshot
): OpenClawCommandBuildResult {
  const supportError = ensureCommandSupport(
    'models.status',
    capabilities,
    'modelsStatusJson',
    'This OpenClaw build does not support models status --json.'
  )
  if (supportError) return supportError

  const args = ['models', 'status', '--json']
  const usedFlags = new Set<string>(['--json'])

  pushStringFlag(args, usedFlags, '--agent', input.agentId)
  pushBooleanFlag(args, usedFlags, input.probe, '--probe')
  pushStringFlag(args, usedFlags, '--probe-provider', input.probeProvider)

  if ((input.probeTimeoutMs || 0) > 0) {
    args.push('--probe-timeout', String(input.probeTimeoutMs))
    usedFlags.add('--probe-timeout')
  }
  if ((input.probeConcurrency || 0) > 0) {
    args.push('--probe-concurrency', String(input.probeConcurrency))
    usedFlags.add('--probe-concurrency')
  }
  if ((input.probeMaxTokens || 0) > 0) {
    args.push('--probe-max-tokens', String(input.probeMaxTokens))
    usedFlags.add('--probe-max-tokens')
  }

  for (const profile of normalizeProfileList(input.probeProfile)) {
    args.push('--probe-profile', profile)
    usedFlags.add('--probe-profile')
  }

  pushBooleanFlag(args, usedFlags, input.check, '--check')

  const flagError = ensureFlags(
    'models.status',
    capabilities,
    'models status',
    Array.from(usedFlags),
    'models status'
  )
  if (flagError) return flagError

  return success('models.status', args)
}

export interface BuildModelsScanCommandInput {
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

export function buildModelsScanCommand(
  input: BuildModelsScanCommandInput,
  capabilities?: CapabilitySnapshot
): OpenClawCommandBuildResult {
  const supportError = ensureCommandSupport(
    'models.scan',
    capabilities,
    'modelsScan',
    'This OpenClaw build does not support models scan.'
  )
  if (supportError) return supportError

  const args = ['models', 'scan']
  const usedFlags = new Set<string>()

  pushStringFlag(args, usedFlags, '--provider', input.provider)
  pushBooleanFlag(args, usedFlags, input.json, '--json')
  pushBooleanFlag(args, usedFlags, input.yes, '--yes')
  pushBooleanFlag(args, usedFlags, input.noProbe, '--no-probe')
  pushBooleanFlag(args, usedFlags, input.setDefault, '--set-default')
  pushBooleanFlag(args, usedFlags, input.setImage, '--set-image')

  if ((input.maxCandidates || 0) > 0) {
    args.push('--max-candidates', String(input.maxCandidates))
    usedFlags.add('--max-candidates')
  }
  if ((input.timeoutMs || 0) > 0) {
    args.push('--timeout', String(input.timeoutMs))
    usedFlags.add('--timeout')
  }
  if ((input.concurrency || 0) > 0) {
    args.push('--concurrency', String(input.concurrency))
    usedFlags.add('--concurrency')
  }
  if ((input.maxAgeDays || 0) > 0) {
    args.push('--max-age-days', String(input.maxAgeDays))
    usedFlags.add('--max-age-days')
  }
  if ((input.minParams || 0) > 0) {
    args.push('--min-params', String(input.minParams))
    usedFlags.add('--min-params')
  }

  pushBooleanFlag(args, usedFlags, input.noInput, '--no-input')

  const flagError = ensureFlags(
    'models.scan',
    capabilities,
    'models scan',
    Array.from(usedFlags),
    'models scan'
  )
  if (flagError) return flagError

  return success('models.scan', args)
}

export function buildModelsAuthLoginCommand(
  params: {
    providerId: string
    methodId?: string
    setDefault?: boolean
  },
  capabilities?: CapabilitySnapshot
): OpenClawCommandBuildResult {
  const providerId = normalizeNonEmpty(params.providerId)
  if (!providerId) {
    return failed('models.auth.login', 'invalid_input', 'providerId is required')
  }

  const supportError = ensureCommandSupport(
    'models.auth.login',
    capabilities,
    'modelsAuthLogin',
    'This OpenClaw build does not support models auth login.'
  )
  if (supportError) return supportError

  const args = ['models', 'auth', 'login', '--provider', providerId]
  const usedFlags = new Set<string>(['--provider'])

  const methodId = normalizeNonEmpty(params.methodId)
  if (methodId) {
    args.push('--method', methodId)
    usedFlags.add('--method')
  }
  if (params.setDefault) {
    args.push('--set-default')
    usedFlags.add('--set-default')
  }

  const flagError = ensureFlags(
    'models.auth.login',
    capabilities,
    'models auth login',
    Array.from(usedFlags),
    'models auth login'
  )
  if (flagError) return flagError

  return success('models.auth.login', args)
}

export function buildModelsAuthAddCommand(capabilities?: CapabilitySnapshot): OpenClawCommandBuildResult {
  const supportError = ensureCommandSupport(
    'models.auth.add',
    capabilities,
    'modelsAuthAdd',
    'This OpenClaw build does not support models auth add.'
  )
  if (supportError) return supportError
  return success('models.auth.add', ['models', 'auth', 'add'])
}

export function buildModelsAuthPasteTokenCommand(
  params: {
    providerId: string
    profileId?: string
    expiresIn?: string
  },
  capabilities?: CapabilitySnapshot
): OpenClawCommandBuildResult {
  const providerId = normalizeNonEmpty(params.providerId)
  if (!providerId) {
    return failed('models.auth.paste-token', 'invalid_input', 'providerId is required')
  }

  const supportError = ensureCommandSupport(
    'models.auth.paste-token',
    capabilities,
    'modelsAuthPasteToken',
    'This OpenClaw build does not support models auth paste-token.'
  )
  if (supportError) return supportError

  const args = ['models', 'auth', 'paste-token', '--provider', providerId]
  const usedFlags = new Set<string>(['--provider'])

  pushStringFlag(args, usedFlags, '--profile-id', params.profileId)
  pushStringFlag(args, usedFlags, '--expires-in', params.expiresIn)

  const flagError = ensureFlags(
    'models.auth.paste-token',
    capabilities,
    'models auth paste-token',
    Array.from(usedFlags),
    'models auth paste-token'
  )
  if (flagError) return flagError

  return success('models.auth.paste-token', args)
}

export function buildModelsAuthSetupTokenCommand(
  params: {
    providerId: string
    yes?: boolean
  },
  capabilities?: CapabilitySnapshot
): OpenClawCommandBuildResult {
  const providerId = normalizeNonEmpty(params.providerId)
  if (!providerId) {
    return failed('models.auth.setup-token', 'invalid_input', 'providerId is required')
  }

  const supportError = ensureCommandSupport(
    'models.auth.setup-token',
    capabilities,
    'modelsAuthSetupToken',
    'This OpenClaw build does not support models auth setup-token.'
  )
  if (supportError) return supportError

  const args = ['models', 'auth', 'setup-token', '--provider', providerId]
  const usedFlags = new Set<string>(['--provider'])

  if (params.yes) {
    args.push('--yes')
    usedFlags.add('--yes')
  }

  const flagError = ensureFlags(
    'models.auth.setup-token',
    capabilities,
    'models auth setup-token',
    Array.from(usedFlags),
    'models auth setup-token'
  )
  if (flagError) return flagError

  return success('models.auth.setup-token', args)
}

export function buildModelsAuthOrderGetCommand(
  params: {
    providerId: string
    agentId?: string
    json?: boolean
  },
  capabilities?: CapabilitySnapshot
): OpenClawCommandBuildResult {
  const providerId = normalizeNonEmpty(params.providerId)
  if (!providerId) {
    return failed('models.auth.order.get', 'invalid_input', 'providerId is required')
  }

  const supportError = ensureCommandSupport(
    'models.auth.order.get',
    capabilities,
    'modelsAuthOrder',
    'This OpenClaw build does not support models auth order.'
  )
  if (supportError) return supportError

  const args = ['models', 'auth', 'order', 'get', '--provider', providerId]
  const usedFlags = new Set<string>(['--provider'])

  pushStringFlag(args, usedFlags, '--agent', params.agentId)
  if (params.json) {
    args.push('--json')
    usedFlags.add('--json')
  }

  const flagError = ensureFlags(
    'models.auth.order.get',
    capabilities,
    'models auth order get',
    Array.from(usedFlags),
    'models auth order get'
  )
  if (flagError) return flagError

  return success('models.auth.order.get', args)
}

export function buildModelsAuthOrderSetCommand(
  params: {
    providerId: string
    profileIds: string[]
    agentId?: string
  },
  capabilities?: CapabilitySnapshot
): OpenClawCommandBuildResult {
  const providerId = normalizeNonEmpty(params.providerId)
  if (!providerId) {
    return failed('models.auth.order.set', 'invalid_input', 'providerId is required')
  }

  const profileIds = (params.profileIds || []).map((item) => normalizeNonEmpty(item)).filter(Boolean)
  if (profileIds.length === 0) {
    return failed('models.auth.order.set', 'invalid_input', 'profileIds must contain at least one profile id')
  }

  const supportError = ensureCommandSupport(
    'models.auth.order.set',
    capabilities,
    'modelsAuthOrder',
    'This OpenClaw build does not support models auth order.'
  )
  if (supportError) return supportError

  const args = ['models', 'auth', 'order', 'set', '--provider', providerId]
  const usedFlags = new Set<string>(['--provider'])
  pushStringFlag(args, usedFlags, '--agent', params.agentId)
  args.push(...profileIds)

  const flagError = ensureFlags(
    'models.auth.order.set',
    capabilities,
    'models auth order set',
    Array.from(usedFlags),
    'models auth order set'
  )
  if (flagError) return flagError

  return success('models.auth.order.set', args)
}

export function buildModelsAuthOrderClearCommand(
  params: {
    providerId: string
    agentId?: string
  },
  capabilities?: CapabilitySnapshot
): OpenClawCommandBuildResult {
  const providerId = normalizeNonEmpty(params.providerId)
  if (!providerId) {
    return failed('models.auth.order.clear', 'invalid_input', 'providerId is required')
  }

  const supportError = ensureCommandSupport(
    'models.auth.order.clear',
    capabilities,
    'modelsAuthOrder',
    'This OpenClaw build does not support models auth order.'
  )
  if (supportError) return supportError

  const args = ['models', 'auth', 'order', 'clear', '--provider', providerId]
  const usedFlags = new Set<string>(['--provider'])
  pushStringFlag(args, usedFlags, '--agent', params.agentId)

  const flagError = ensureFlags(
    'models.auth.order.clear',
    capabilities,
    'models auth order clear',
    Array.from(usedFlags),
    'models auth order clear'
  )
  if (flagError) return flagError

  return success('models.auth.order.clear', args)
}

export function buildModelsAuthLoginGitHubCopilotCommand(
  params: {
    profileId?: string
    yes?: boolean
  },
  capabilities?: CapabilitySnapshot
): OpenClawCommandBuildResult {
  const supportError = ensureCommandSupport(
    'models.auth.login-github-copilot',
    capabilities,
    'modelsAuthLoginGitHubCopilot',
    'This OpenClaw build does not support models auth login-github-copilot.'
  )
  if (supportError) return supportError

  const args = ['models', 'auth', 'login-github-copilot']
  const usedFlags = new Set<string>()

  pushStringFlag(args, usedFlags, '--profile-id', params.profileId)
  if (params.yes) {
    args.push('--yes')
    usedFlags.add('--yes')
  }

  const flagError = ensureFlags(
    'models.auth.login-github-copilot',
    capabilities,
    'models auth login-github-copilot',
    Array.from(usedFlags),
    'models auth login-github-copilot'
  )
  if (flagError) return flagError

  return success('models.auth.login-github-copilot', args)
}

export function buildModelsAliasesCommand(
  action: 'add' | 'remove' | 'list',
  params: {
    alias?: string
    model?: string
  } = {},
  capabilities?: CapabilitySnapshot
): OpenClawCommandBuildResult {
  const commandId =
    action === 'add'
      ? 'models.aliases.add'
      : action === 'remove'
        ? 'models.aliases.remove'
        : 'models.aliases.list'

  const supportError = ensureCommandSupport(
    commandId,
    capabilities,
    'aliases',
    'This OpenClaw build does not support models aliases.'
  )
  if (supportError) return supportError

  if (action === 'add') {
    const alias = normalizeNonEmpty(params.alias)
    const model = normalizeNonEmpty(params.model)
    if (!alias || !model) {
      return failed(commandId, 'invalid_input', 'alias and model are required')
    }
    return success(commandId, ['models', 'aliases', 'add', alias, model])
  }

  if (action === 'remove') {
    const alias = normalizeNonEmpty(params.alias)
    if (!alias) {
      return failed(commandId, 'invalid_input', 'alias is required')
    }
    return success(commandId, ['models', 'aliases', 'remove', alias])
  }

  const flagError = ensureFlags(commandId, capabilities, 'models aliases list', ['--json'], 'models aliases list')
  if (flagError) return flagError
  return success(commandId, ['models', 'aliases', 'list', '--json'])
}

export function buildModelsFallbacksCommand(
  action: 'add' | 'remove' | 'list' | 'clear',
  params: {
    model?: string
  } = {},
  capabilities?: CapabilitySnapshot
): OpenClawCommandBuildResult {
  const commandId =
    action === 'add'
      ? 'models.fallbacks.add'
      : action === 'remove'
        ? 'models.fallbacks.remove'
        : action === 'list'
          ? 'models.fallbacks.list'
          : 'models.fallbacks.clear'

  const supportError = ensureCommandSupport(
    commandId,
    capabilities,
    'fallbacks',
    'This OpenClaw build does not support models fallbacks.'
  )
  if (supportError) return supportError

  if (action === 'add' || action === 'remove') {
    const model = normalizeNonEmpty(params.model)
    if (!model) {
      return failed(commandId, 'invalid_input', 'model is required')
    }
    return success(commandId, ['models', 'fallbacks', action, model])
  }

  if (action === 'clear') {
    return success(commandId, ['models', 'fallbacks', 'clear'])
  }

  const flagError = ensureFlags(commandId, capabilities, 'models fallbacks list', ['--json'], 'models fallbacks list')
  if (flagError) return flagError
  return success(commandId, ['models', 'fallbacks', 'list', '--json'])
}

export function buildModelsImageFallbacksCommand(
  action: 'add' | 'remove' | 'list' | 'clear',
  params: {
    model?: string
  } = {},
  capabilities?: CapabilitySnapshot
): OpenClawCommandBuildResult {
  const commandId =
    action === 'add'
      ? 'models.image-fallbacks.add'
      : action === 'remove'
        ? 'models.image-fallbacks.remove'
        : action === 'list'
          ? 'models.image-fallbacks.list'
          : 'models.image-fallbacks.clear'

  const supportError = ensureCommandSupport(
    commandId,
    capabilities,
    'imageFallbacks',
    'This OpenClaw build does not support models image-fallbacks.'
  )
  if (supportError) return supportError

  if (action === 'add' || action === 'remove') {
    const model = normalizeNonEmpty(params.model)
    if (!model) {
      return failed(commandId, 'invalid_input', 'model is required')
    }
    return success(commandId, ['models', 'image-fallbacks', action, model])
  }

  if (action === 'clear') {
    return success(commandId, ['models', 'image-fallbacks', 'clear'])
  }

  const flagError = ensureFlags(
    commandId,
    capabilities,
    'models image-fallbacks list',
    ['--json'],
    'models image-fallbacks list'
  )
  if (flagError) return flagError

  return success(commandId, ['models', 'image-fallbacks', 'list', '--json'])
}

export function buildOnboardRouteCommand(
  method: OpenClawAuthMethodDescriptor,
  secret: string | undefined,
  capabilities?: CapabilitySnapshot
): OpenClawCommandBuildResult {
  const cliFlag = normalizeNonEmpty(method.route.cliFlag)
  const normalizedSecret = normalizeNonEmpty(secret)
  if (method.route.requiresSecret && (!cliFlag || !normalizedSecret)) {
    return failed(
      'onboard',
      'invalid_input',
      `Auth method "${method.authChoice}" requires a secret and official cli flag.`
    )
  }

  return buildOnboardCommand(
    {
      interactive: false,
      authChoice: method.authChoice,
      acceptRisk: true,
      installDaemon: false,
      skipChannels: true,
      skipHealth: true,
      skipSkills: true,
      skipUi: true,
      valueFlags: cliFlag && normalizedSecret ? [{ flag: cliFlag, value: normalizedSecret }] : [],
    },
    capabilities
  )
}

function normalizeCustomProviderCompatibility(
  compatibility: string | undefined
): { ok: true; value: CustomProviderCompatibility } | { ok: false; message: string } {
  const normalized = normalizeNonEmpty(compatibility).toLowerCase()
  if (!normalized) return { ok: true, value: 'openai' }
  if (normalized === 'openai' || normalized === 'anthropic') {
    return { ok: true, value: normalized }
  }
  return {
    ok: false,
    message: 'Custom provider compatibility must be "openai" or "anthropic".',
  }
}

function isValidCustomProviderId(providerId: string): boolean {
  return /^[a-z0-9-]+$/i.test(providerId)
}

export function buildCustomProviderOnboardRouteCommand(
  method: OpenClawAuthMethodDescriptor,
  input: CustomProviderConfigInput,
  secret: string | undefined,
  capabilities?: CapabilitySnapshot
): OpenClawCommandBuildResult {
  const baseUrl = normalizeNonEmpty(input.baseUrl)
  const modelId = normalizeNonEmpty(input.modelId)
  const providerId = normalizeNonEmpty(input.providerId)
  const compatibilityResult = normalizeCustomProviderCompatibility(input.compatibility)
  const apiKey = normalizeNonEmpty(secret)

  if (!baseUrl || !modelId) {
    return failed(
      'onboard',
      'invalid_input',
      `Auth method "${method.authChoice}" requires custom base URL and model ID.`
    )
  }
  if (!compatibilityResult.ok) {
    return failed('onboard', 'invalid_input', compatibilityResult.message)
  }
  if (providerId && !isValidCustomProviderId(providerId)) {
    return failed(
      'onboard',
      'invalid_input',
      'Custom provider ID must include letters, numbers, or hyphens.'
    )
  }

  const valueFlags: OnboardFlagValueInput[] = [
    { flag: '--custom-base-url', value: baseUrl },
    { flag: '--custom-model-id', value: modelId },
  ]

  if (providerId) {
    valueFlags.push({ flag: '--custom-provider-id', value: providerId })
  }
  valueFlags.push({ flag: '--custom-compatibility', value: compatibilityResult.value })
  if (apiKey) {
    valueFlags.push({ flag: '--custom-api-key', value: apiKey })
  }

  return buildOnboardCommand(
    {
      interactive: false,
      authChoice: method.authChoice,
      acceptRisk: true,
      installDaemon: false,
      skipChannels: true,
      skipHealth: true,
      skipSkills: true,
      skipUi: true,
      valueFlags,
    },
    capabilities
  )
}

export interface CliCommandResult {
  ok: boolean
  stdout: string
  stderr: string
  code: number | null
}

export type AuthMethodType = 'apiKey' | 'oauth' | 'token' | 'custom' | 'unknown'

export interface AuthChoiceCapability {
  id: string
  providerId: string
  methodType: AuthMethodType
  source: 'auth-registry' | 'fallback'
}

import {
  createOpenClawAuthRegistry,
  loadOpenClawAuthRegistry,
  type OpenClawAuthRegistry,
  type OpenClawAuthMethodDescriptor,
  type OpenClawAuthProviderDescriptor,
  type OpenClawAuthRegistrySource,
} from './openclaw-auth-registry'
import { appendEnvCheckDiagnostic } from './env-check-diagnostics'
import { normalizeAuthChoice } from './openclaw-spawn'
import { MAIN_RUNTIME_POLICY } from './runtime-policy'
import { canonicalizeModelProviderId } from '../../src/lib/model-provider-aliases'
import {
  getProviderMetadata,
  resolveKnownProviderIdForAuthChoice,
  resolveProviderDisplayName,
  resolveProviderMethodOnboardCliFlag,
} from '../../src/lib/openclaw-provider-registry'

export interface OpenClawCapabilities {
  version: string
  discoveredAt: string
  authRegistry: OpenClawAuthRegistry
  authRegistrySource: OpenClawAuthRegistrySource
  authChoices: AuthChoiceCapability[]
  rootCommands: string[]
  onboardFlags: string[]
  modelsCommands: string[]
  modelsAuthCommands: string[]
  pluginsCommands: string[]
  commandFlags: Record<string, string[]>
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

export type OpenClawCapabilitiesProfile = 'bootstrap' | 'full'

interface DiscoverCapabilitiesOptions {
  runCommand?: (args: string[], timeout?: number) => Promise<CliCommandResult>
  loadAuthRegistry?: (options?: { forceRefresh?: boolean }) => Promise<OpenClawAuthRegistry>
  now?: () => Date
  refreshAuthRegistry?: boolean
  forceRefresh?: boolean
  profile?: OpenClawCapabilitiesProfile
  discoverCapabilities?: (options?: DiscoverCapabilitiesOptions) => Promise<OpenClawCapabilities>
}

async function trackCapabilitiesProbe<T>(
  probe: string,
  run: () => Promise<T>
): Promise<T> {
  void appendEnvCheckDiagnostic('main-openclaw-capabilities-probe-start', { probe })
  try {
    const result = await run()
    void appendEnvCheckDiagnostic('main-openclaw-capabilities-probe-result', { probe })
    return result
  } catch (error) {
    void appendEnvCheckDiagnostic('main-openclaw-capabilities-probe-failed', {
      probe,
      message: error instanceof Error ? error.message : String(error || ''),
    })
    throw error
  }
}

function uniqueKeepOrder(items: string[]): string[] {
  const seen = new Set<string>()
  const ordered: string[] = []
  for (const item of items) {
    if (!item || seen.has(item)) continue
    seen.add(item)
    ordered.push(item)
  }
  return ordered
}

export function parseLongFlags(helpText: string): string[] {
  if (!helpText) return []
  const found: string[] = []
  const regex = /^\s{2,}--([a-z0-9][a-z0-9-]*)\b/gi
  for (const line of helpText.split('\n')) {
    const matched = line.match(regex)
    if (!matched) continue
    for (const token of matched) {
      found.push(token.trim())
    }
  }
  return uniqueKeepOrder(found)
}

export function parseModelsCommands(helpText: string): string[] {
  if (!helpText) return []
  const commands: string[] = []
  for (const rawLine of helpText.split('\n')) {
    const line = rawLine.trimEnd()
    const matched = line.match(/^\s{2,}([a-z][a-z0-9-]*)(?:\s+\*)?(?:\s{2,}.*)?$/i)
    if (!matched?.[1]) continue
    if (matched[1].toLowerCase() === 'help') continue
    commands.push(matched[1].toLowerCase())
  }
  return uniqueKeepOrder(commands)
}

export function parseAuthChoicesFromOnboardHelp(helpText: string): string[] {
  if (!helpText) return []

  const lines = helpText.split('\n')
  const authChoiceSegments: string[] = []
  let collecting = false

  for (const rawLine of lines) {
    const line = rawLine.trimEnd()

    if (!collecting && /--auth-choice\b/i.test(line) && /auth:/i.test(line)) {
      const authIndex = line.toLowerCase().indexOf('auth:')
      authChoiceSegments.push(line.slice(authIndex + 'auth:'.length).trim())
      collecting = true
      continue
    }

    if (!collecting) continue

    const trimmed = line.trim()
    if (!trimmed) break
    if (/^\s{2,}--[a-z0-9-]+\b/i.test(line)) break
    authChoiceSegments.push(trimmed)
  }

  return uniqueKeepOrder(
    authChoiceSegments
      .join(' ')
      .split(/[|,]/g)
      .map((entry) => normalizeAuthChoice(entry))
      .filter(Boolean)
  )
}


function extractVersion(result: CliCommandResult): string {
  const merged = `${result.stdout}\n${result.stderr}`.trim()
  if (!merged) return 'unknown'
  for (const line of merged.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (trimmed.toLowerCase().includes('openclaw')) return trimmed
  }
  return merged.split('\n')[0].trim() || 'unknown'
}

function mergeOutput(result: CliCommandResult): string {
  return `${result.stdout}\n${result.stderr}`.trim()
}

function hasRequiredFlags(commandFlags: Record<string, string[]>, commandKey: string, requiredFlags: string[]): boolean {
  if (requiredFlags.length === 0) return true
  const discoveredFlags = new Set(commandFlags[commandKey] || [])
  return requiredFlags.every((flag) => discoveredFlags.has(flag))
}

function buildRecoveredMethodLabel(providerId: string, authChoice: string, kind: AuthMethodType): string {
  const providerName = resolveProviderDisplayName(providerId)
  if (authChoice === 'custom-api-key') return 'Custom Provider'
  if (authChoice === 'openai-codex') return 'OpenAI Codex 浏览器授权登录'
  if (authChoice === 'github-copilot') return 'GitHub Copilot 浏览器授权登录'
  if (kind === 'apiKey') return `${providerName} API Key`
  if (kind === 'oauth') return `${providerName} 浏览器授权登录`
  if (kind === 'token') return `${providerName} Token`
  return authChoice
}

function buildRecoveredOAuthFallbackHint(authChoice: string): string {
  return [
    '从 onboard 帮助文本恢复了该浏览器授权登录入口；当前版本的官方元数据不可见时，将回退到官方 onboard 认证入口。',
    `Qclaw 会直接尝试 "openclaw onboard --auth-choice ${authChoice}"，以保持该 Provider 仍可完成配置。`,
  ].join(' ')
}

function recoverMethodDescriptorFromAuthChoice(
  authChoice: string
): { providerId: string; method: OpenClawAuthMethodDescriptor } | null {
  const normalizedAuthChoice = normalizeAuthChoice(authChoice)
  if (!normalizedAuthChoice) return null

  if (normalizedAuthChoice === 'custom-api-key') {
    return {
      providerId: 'custom',
      method: {
        authChoice: normalizedAuthChoice,
        label: 'Custom Provider',
        hint: '从 onboard 帮助文本恢复；请确认当前 OpenClaw 版本支持自定义 Provider。',
        kind: 'custom',
        route: {
          kind: 'onboard-custom',
          providerId: 'custom',
        },
      },
    }
  }

  if (normalizedAuthChoice === 'openai-codex') {
    return {
      providerId: 'openai',
      method: {
        authChoice: normalizedAuthChoice,
        label: 'OpenAI Codex 浏览器授权登录',
        hint: '从 onboard 帮助文本恢复；插件细节不可见时将直接尝试官方登录入口。',
        kind: 'oauth',
        route: {
          kind: 'models-auth-login',
          providerId: normalizedAuthChoice,
          requiresBrowser: true,
        },
      },
    }
  }

  if (normalizedAuthChoice === 'github-copilot') {
    return {
      providerId: 'github-copilot',
      method: {
        authChoice: normalizedAuthChoice,
        label: 'GitHub Copilot 浏览器授权登录',
        hint: '从 onboard 帮助文本恢复；会直接尝试 GitHub Copilot 登录入口。',
        kind: 'oauth',
        route: {
          kind: 'models-auth-login-github-copilot',
          providerId: normalizedAuthChoice,
          requiresBrowser: true,
        },
      },
    }
  }

  const resolvedProviderIdCandidate =
    resolveKnownProviderIdForAuthChoice(normalizedAuthChoice) ||
    (() => {
      const canonical = canonicalizeModelProviderId(normalizedAuthChoice)
      if (!canonical || canonical === normalizedAuthChoice) return ''
      if (canonical === 'google') return canonical
      return getProviderMetadata(canonical) ? canonical : ''
    })()
  const resolvedProviderId = canonicalizeModelProviderId(resolvedProviderIdCandidate) || resolvedProviderIdCandidate

  if (!resolvedProviderId) return null

  if (
    normalizedAuthChoice === 'google-gemini-cli' ||
    normalizedAuthChoice.endsWith('-portal') ||
    normalizedAuthChoice.includes('oauth')
  ) {
    return {
      providerId: resolvedProviderId,
      method: {
        authChoice: normalizedAuthChoice,
        label: buildRecoveredMethodLabel(resolvedProviderId, normalizedAuthChoice, 'oauth'),
        hint: buildRecoveredOAuthFallbackHint(normalizedAuthChoice),
        kind: 'oauth',
        route: {
          kind: 'onboard',
          providerId: resolvedProviderId,
          requiresBrowser: true,
        },
      },
    }
  }

  const cliFlag = resolveProviderMethodOnboardCliFlag(resolvedProviderId, normalizedAuthChoice)
  if (!cliFlag) return null

  return {
    providerId: resolvedProviderId,
    method: {
      authChoice: normalizedAuthChoice,
      label: buildRecoveredMethodLabel(resolvedProviderId, normalizedAuthChoice, 'apiKey'),
      hint: '从 onboard 帮助文本恢复；将使用兼容模式尝试官方 API Key 入口。',
      kind: 'apiKey',
      route: {
        kind: 'onboard',
        providerId: resolvedProviderId,
        cliFlag,
        requiresSecret: true,
      },
    },
  }
}

function recoverAuthRegistryFromOnboardHelp(
  authRegistry: OpenClawAuthRegistry,
  onboardHelpText: string
): OpenClawAuthRegistry {
  if (authRegistry.ok || authRegistry.providers.length > 0) return authRegistry

  const recoveredChoices = parseAuthChoicesFromOnboardHelp(onboardHelpText)
  if (recoveredChoices.length === 0) return authRegistry

  const providersById = new Map<string, OpenClawAuthProviderDescriptor>()

  for (const authChoice of recoveredChoices) {
    const recovered = recoverMethodDescriptorFromAuthChoice(authChoice)
    if (!recovered) continue

    const providerId = recovered.providerId
    const existingProvider = providersById.get(providerId)
    if (existingProvider) {
      if (!existingProvider.methods.some((method) => method.authChoice === recovered.method.authChoice)) {
        existingProvider.methods.push(recovered.method)
      }
      continue
    }

    providersById.set(providerId, {
      id: providerId,
      label: resolveProviderDisplayName(providerId),
      hint: '从 OpenClaw onboard 帮助文本恢复；当前版本的官方元数据布局不可直接解析。',
      methods: [recovered.method],
    })
  }

  if (providersById.size === 0) return authRegistry

  return createOpenClawAuthRegistry({
    ok: false,
    source: authRegistry.source,
    providers: [...providersById.values()],
    message: [
      authRegistry.message || 'OpenClaw auth metadata is unavailable.',
      'Qclaw 已基于 onboard 帮助文本恢复部分 Provider 列表，某些高级认证选项可能缺失。',
    ].join(' '),
  })
}

function deriveOnboardFlagsFromAuthRegistry(authRegistry: OpenClawAuthRegistry): string[] {
  const flags: string[] = []

  for (const provider of authRegistry.providers || []) {
    for (const method of provider.methods || []) {
      if (method.route.kind !== 'onboard') continue
      const cliFlag = String(method.route.cliFlag || '').trim()
      if (cliFlag) flags.push(cliFlag)
    }
  }

  return uniqueKeepOrder(flags)
}

async function discoverFlags(
  runCommand: (args: string[], timeout?: number) => Promise<CliCommandResult>,
  args: string[]
): Promise<string[]> {
  try {
    const result = await runCommand([...args, '--help'], MAIN_RUNTIME_POLICY.capabilities.helpProbeTimeoutMs)
    return parseLongFlags(mergeOutput(result))
  } catch {
    return []
  }
}

const DEFAULT_CAPABILITIES_PROFILE: OpenClawCapabilitiesProfile = 'full'
const cachedCapabilities: Record<OpenClawCapabilitiesProfile, OpenClawCapabilities | null> = {
  bootstrap: null,
  full: null,
}
const cachedCapabilitiesPromise: Record<OpenClawCapabilitiesProfile, Promise<OpenClawCapabilities> | null> = {
  bootstrap: null,
  full: null,
}
let capabilitiesCacheEpoch = 0

function resolveCapabilitiesProfile(profile?: OpenClawCapabilitiesProfile): OpenClawCapabilitiesProfile {
  return profile === 'bootstrap' ? 'bootstrap' : DEFAULT_CAPABILITIES_PROFILE
}

function resolveSharedCachedCapabilities(profile: OpenClawCapabilitiesProfile): OpenClawCapabilities | null {
  if (profile === 'bootstrap') {
    return cachedCapabilities.full || cachedCapabilities.bootstrap
  }
  return cachedCapabilities.full
}

export async function discoverOpenClawCapabilities(
  options: DiscoverCapabilitiesOptions = {}
): Promise<OpenClawCapabilities> {
  const profile = resolveCapabilitiesProfile(options.profile)
  void appendEnvCheckDiagnostic('main-openclaw-capabilities-discover-start', {
    profile,
  })
  const runCommand =
    options.runCommand ??
    (async (args: string[], timeout?: number) => {
      const cli = await import('./cli')
      return cli.runCli(args, timeout, 'capabilities')
    })
  const loadAuthRegistry =
    options.loadAuthRegistry ??
    ((loadOptions?: { forceRefresh?: boolean }) => loadOpenClawAuthRegistry(loadOptions))
  const now = options.now ?? (() => new Date())

  // Keep CLI help/version probes strictly serialized so Windows hosts never fan
  // out multiple openclaw child processes at once. The auth registry loader is
  // metadata-only and can still overlap with the CLI probe chain.
  const authRegistryPromise = trackCapabilitiesProbe('auth-registry', () =>
    loadAuthRegistry({
      forceRefresh: options.refreshAuthRegistry,
    })
  )
  const versionResult = await trackCapabilitiesProbe('version', () =>
    runCommand(['--version'], MAIN_RUNTIME_POLICY.capabilities.versionProbeTimeoutMs)
  )
  const rootHelpResult = await trackCapabilitiesProbe('root-help', () =>
    runCommand(['--help'], MAIN_RUNTIME_POLICY.capabilities.helpProbeTimeoutMs)
  )
  const authRegistry = await authRegistryPromise
  const shouldSkipBootstrapOnboardHelp =
    profile === 'bootstrap' && authRegistry.providers.length > 0
  if (shouldSkipBootstrapOnboardHelp) {
    void appendEnvCheckDiagnostic('main-openclaw-capabilities-probe-skipped', {
      probe: 'onboard-help',
      reason: 'auth-registry-complete',
      profile,
    })
  }
  const onboardHelpResult = shouldSkipBootstrapOnboardHelp
    ? null
    : await trackCapabilitiesProbe('onboard-help', () =>
        runCommand(['onboard', '--help'], MAIN_RUNTIME_POLICY.capabilities.helpProbeTimeoutMs)
      )
  const modelsHelpResult = await trackCapabilitiesProbe('models-help', () =>
    runCommand(['models', '--help'], MAIN_RUNTIME_POLICY.capabilities.helpProbeTimeoutMs)
  )
  void appendEnvCheckDiagnostic('main-openclaw-capabilities-discover-phase1-complete', {})

  const onboardHelpText = onboardHelpResult ? mergeOutput(onboardHelpResult) : ''
  const recoveredAuthRegistry = recoverAuthRegistryFromOnboardHelp(authRegistry, onboardHelpText)
  const hasPluginBackedAuthMethod = recoveredAuthRegistry.providers.some((provider) =>
    provider.methods.some((method) => Boolean(method.route.pluginId))
  )
  const authChoices = deriveCompatAuthChoices(recoveredAuthRegistry)

  const rootCommands = parseModelsCommands(mergeOutput(rootHelpResult))
  const onboardFlags = onboardHelpText
    ? parseLongFlags(onboardHelpText)
    : deriveOnboardFlagsFromAuthRegistry(recoveredAuthRegistry)
  const modelsCommands = parseModelsCommands(mergeOutput(modelsHelpResult))
  const commandFlags: Record<string, string[]> = {
    onboard: onboardFlags,
  }
  const modelsAuthHelpResult = modelsCommands.includes('auth')
    ? await trackCapabilitiesProbe('models-auth-help', () =>
        runCommand(['models', 'auth', '--help'], MAIN_RUNTIME_POLICY.capabilities.helpProbeTimeoutMs).catch(() => null)
      )
    : null
  const pluginsHelpResult = profile === 'full'
    ? await trackCapabilitiesProbe('plugins-help', () =>
        runCommand(['plugins', '--help'], MAIN_RUNTIME_POLICY.capabilities.helpProbeTimeoutMs).catch(() => null)
      )
    : null
  const agentFlags = profile === 'full'
    ? await trackCapabilitiesProbe('agent-flags', () => discoverFlags(runCommand, ['agent']))
    : []
  const modelsListFlags = modelsCommands.includes('list')
    ? await trackCapabilitiesProbe('models-list-flags', () => discoverFlags(runCommand, ['models', 'list']))
    : []
  const modelsStatusFlags = modelsCommands.includes('status')
    ? await trackCapabilitiesProbe('models-status-flags', () => discoverFlags(runCommand, ['models', 'status']))
    : []
  const modelsScanFlags = profile === 'full' && modelsCommands.includes('scan')
    ? await trackCapabilitiesProbe('models-scan-flags', () => discoverFlags(runCommand, ['models', 'scan']))
    : []
  const aliasesFlags = profile === 'full' && modelsCommands.includes('aliases')
    ? await trackCapabilitiesProbe('models-aliases-flags', () => discoverFlags(runCommand, ['models', 'aliases', 'list']))
    : []
  const fallbacksFlags = profile === 'full' && modelsCommands.includes('fallbacks')
    ? await trackCapabilitiesProbe('models-fallbacks-flags', () => discoverFlags(runCommand, ['models', 'fallbacks', 'list']))
    : []
  const imageFallbacksFlags = profile === 'full' && modelsCommands.includes('image-fallbacks')
    ? await trackCapabilitiesProbe('models-image-fallbacks-flags', () =>
        discoverFlags(runCommand, ['models', 'image-fallbacks', 'list'])
      )
    : []
  void appendEnvCheckDiagnostic('main-openclaw-capabilities-discover-phase2-complete', {})

  let modelsAuthCommands: string[] = []
  if (modelsAuthHelpResult) {
    modelsAuthCommands = parseModelsCommands(mergeOutput(modelsAuthHelpResult))
  }

  let pluginsCommands: string[] = []
  if (pluginsHelpResult) {
    pluginsCommands = parseModelsCommands(mergeOutput(pluginsHelpResult))
  }

  if (modelsCommands.includes('list')) {
    commandFlags['models list'] = modelsListFlags
  }
  if (agentFlags.length > 0) {
    commandFlags.agent = agentFlags
  }
  if (modelsCommands.includes('status')) {
    commandFlags['models status'] = modelsStatusFlags
  }
  if (modelsCommands.includes('scan')) {
    commandFlags['models scan'] = modelsScanFlags
  }
  if (modelsCommands.includes('aliases')) {
    commandFlags['models aliases list'] = aliasesFlags
  }
  if (modelsCommands.includes('fallbacks')) {
    commandFlags['models fallbacks list'] = fallbacksFlags
  }
  if (modelsCommands.includes('image-fallbacks')) {
    commandFlags['models image-fallbacks list'] = imageFallbacksFlags
  }

  const loginFlags = profile === 'full' && modelsAuthCommands.includes('login')
    ? await discoverFlags(runCommand, ['models', 'auth', 'login'])
    : []
  const pasteTokenFlags = profile === 'full' && modelsAuthCommands.includes('paste-token')
    ? await discoverFlags(runCommand, ['models', 'auth', 'paste-token'])
    : []
  const setupTokenFlags = profile === 'full' && modelsAuthCommands.includes('setup-token')
    ? await discoverFlags(runCommand, ['models', 'auth', 'setup-token'])
    : []
  const loginGitHubCopilotFlags = profile === 'full' && modelsAuthCommands.includes('login-github-copilot')
    ? await discoverFlags(runCommand, ['models', 'auth', 'login-github-copilot'])
    : []
  const modelsAuthOrderHelpResult = profile === 'full' && modelsAuthCommands.includes('order')
    ? await runCommand(['models', 'auth', 'order', '--help'], MAIN_RUNTIME_POLICY.capabilities.helpProbeTimeoutMs).catch(
        () => null
      )
    : null
  void appendEnvCheckDiagnostic('main-openclaw-capabilities-discover-phase3-complete', {})

  if (modelsAuthCommands.includes('login')) {
    commandFlags['models auth login'] = loginFlags
  }
  if (modelsAuthCommands.includes('paste-token')) {
    commandFlags['models auth paste-token'] = pasteTokenFlags
  }
  if (modelsAuthCommands.includes('setup-token')) {
    commandFlags['models auth setup-token'] = setupTokenFlags
  }
  if (modelsAuthCommands.includes('login-github-copilot')) {
    commandFlags['models auth login-github-copilot'] = loginGitHubCopilotFlags
  }

  if (modelsAuthOrderHelpResult) {
    const modelsAuthOrderCommands = parseModelsCommands(mergeOutput(modelsAuthOrderHelpResult))
    const orderGetFlags = modelsAuthOrderCommands.includes('get')
      ? await discoverFlags(runCommand, ['models', 'auth', 'order', 'get'])
      : []
    const orderSetFlags = modelsAuthOrderCommands.includes('set')
      ? await discoverFlags(runCommand, ['models', 'auth', 'order', 'set'])
      : []
    const orderClearFlags = modelsAuthOrderCommands.includes('clear')
      ? await discoverFlags(runCommand, ['models', 'auth', 'order', 'clear'])
      : []

    if (modelsAuthOrderCommands.includes('get')) {
      commandFlags['models auth order get'] = orderGetFlags
    }
    if (modelsAuthOrderCommands.includes('set')) {
      commandFlags['models auth order set'] = orderSetFlags
    }
    if (modelsAuthOrderCommands.includes('clear')) {
      commandFlags['models auth order clear'] = orderClearFlags
    }
  }

  const capabilities = {
    version: extractVersion(versionResult),
    discoveredAt: now().toISOString(),
    authRegistry: recoveredAuthRegistry,
    authRegistrySource: recoveredAuthRegistry.source,
    authChoices,
    rootCommands,
    onboardFlags,
    modelsCommands,
    modelsAuthCommands,
    pluginsCommands,
    commandFlags,
    supports: {
      onboard: rootCommands.includes('onboard') || onboardFlags.length > 0,
      plugins: rootCommands.includes('plugins') || pluginsCommands.length > 0 || hasPluginBackedAuthMethod,
      pluginsInstall:
        profile === 'bootstrap'
          ? rootCommands.includes('plugins') || hasPluginBackedAuthMethod
          : pluginsCommands.includes('install'),
      pluginsEnable:
        profile === 'bootstrap'
          ? rootCommands.includes('plugins') || hasPluginBackedAuthMethod
          : pluginsCommands.includes('enable'),
      chatAgentModelFlag: agentFlags.includes('--model'),
      // Modern OpenClaw routes chat model control through gateway RPCs even when
      // `openclaw agent --help` no longer exposes a `--model` flag.
      chatGatewaySendModel: rootCommands.includes('gateway'),
      chatInThreadModelSwitch:
        agentFlags.includes('--model') || (rootCommands.includes('gateway') && rootCommands.includes('sessions')),
      modelsListAllJson:
        modelsCommands.includes('list') && hasRequiredFlags(commandFlags, 'models list', ['--all', '--json']),
      modelsStatusJson:
        modelsCommands.includes('status') && hasRequiredFlags(commandFlags, 'models status', ['--json']),
      modelsAuthLogin:
        profile === 'bootstrap'
          ? modelsAuthCommands.includes('login')
          : modelsAuthCommands.includes('login') && hasRequiredFlags(commandFlags, 'models auth login', ['--provider']),
      modelsAuthAdd: modelsAuthCommands.includes('add'),
      modelsAuthPasteToken:
        profile === 'bootstrap'
          ? modelsAuthCommands.includes('paste-token')
          : modelsAuthCommands.includes('paste-token') &&
            hasRequiredFlags(commandFlags, 'models auth paste-token', ['--provider']),
      modelsAuthSetupToken:
        profile === 'bootstrap'
          ? modelsAuthCommands.includes('setup-token')
          : modelsAuthCommands.includes('setup-token') &&
            hasRequiredFlags(commandFlags, 'models auth setup-token', ['--provider']),
      modelsAuthOrder: modelsAuthCommands.includes('order'),
      modelsAuthLoginGitHubCopilot:
        profile === 'bootstrap'
          ? modelsAuthCommands.includes('login-github-copilot')
          : modelsAuthCommands.includes('login-github-copilot'),
      aliases: modelsCommands.includes('aliases'),
      fallbacks: modelsCommands.includes('fallbacks'),
      imageFallbacks: modelsCommands.includes('image-fallbacks'),
      modelsScan: modelsCommands.includes('scan'),
    },
  }
  void appendEnvCheckDiagnostic('main-openclaw-capabilities-discover-result', {
    providerCount: Array.isArray(capabilities.authRegistry?.providers) ? capabilities.authRegistry.providers.length : 0,
    authRegistryOk: capabilities.authRegistry?.ok !== false,
  })
  return capabilities
}

export async function loadOpenClawCapabilities(
  options: DiscoverCapabilitiesOptions = {}
): Promise<OpenClawCapabilities> {
  const profile = resolveCapabilitiesProfile(options.profile)
  const shouldUseSharedCache =
    !options.forceRefresh &&
    !options.refreshAuthRegistry &&
    !options.runCommand &&
    !options.loadAuthRegistry &&
    !options.now

  void appendEnvCheckDiagnostic('main-openclaw-capabilities-load-start', {
    profile,
    shouldUseSharedCache,
    forceRefresh: options.forceRefresh === true,
    refreshAuthRegistry: options.refreshAuthRegistry === true,
  })

  const sharedCachedCapability = shouldUseSharedCache ? resolveSharedCachedCapabilities(profile) : null
  if (sharedCachedCapability) {
    void appendEnvCheckDiagnostic('main-openclaw-capabilities-load-cache-hit', {})
    return sharedCachedCapability
  }

  if (shouldUseSharedCache && cachedCapabilitiesPromise[profile]) {
    void appendEnvCheckDiagnostic('main-openclaw-capabilities-load-pending-hit', {})
    return cachedCapabilitiesPromise[profile] as Promise<OpenClawCapabilities>
  }

  const shouldPopulateSharedCache = !options.runCommand && !options.loadAuthRegistry && !options.now
  const discoveryEpoch = shouldPopulateSharedCache ? capabilitiesCacheEpoch + 1 : capabilitiesCacheEpoch
  if (shouldPopulateSharedCache) {
    capabilitiesCacheEpoch = discoveryEpoch
  }

  const discoveryPromise = (options.discoverCapabilities ?? discoverOpenClawCapabilities)({
    ...options,
    profile,
  })
  if (shouldUseSharedCache) {
    cachedCapabilitiesPromise[profile] = discoveryPromise
  }

  try {
    const discovered = await discoveryPromise
    void appendEnvCheckDiagnostic('main-openclaw-capabilities-load-result', {
      profile,
      providerCount: Array.isArray(discovered.authRegistry?.providers)
        ? discovered.authRegistry.providers.length
        : 0,
      authRegistryOk: discovered.authRegistry?.ok !== false,
    })
    if (shouldPopulateSharedCache && capabilitiesCacheEpoch === discoveryEpoch) {
      cachedCapabilities[profile] = discovered
      if (profile === 'full') {
        cachedCapabilities.bootstrap = discovered
      }
    }
    return discovered
  } catch (error) {
    void appendEnvCheckDiagnostic('main-openclaw-capabilities-load-failed', {
      profile,
      message: error instanceof Error ? error.message : String(error || ''),
    })
    throw error
  } finally {
    if (shouldUseSharedCache && cachedCapabilitiesPromise[profile] === discoveryPromise) {
      cachedCapabilitiesPromise[profile] = null
    }
  }
}

export function resetOpenClawCapabilitiesCache(): void {
  capabilitiesCacheEpoch += 1
  cachedCapabilities.bootstrap = null
  cachedCapabilities.full = null
  cachedCapabilitiesPromise.bootstrap = null
  cachedCapabilitiesPromise.full = null
}

export function resetOpenClawCapabilitiesCacheForTests(): void {
  resetOpenClawCapabilitiesCache()
}

function deriveCompatAuthChoices(authRegistry: OpenClawAuthRegistry): AuthChoiceCapability[] {
  if (authRegistry.providers.length === 0) return []

  const authChoices: AuthChoiceCapability[] = []
  for (const provider of authRegistry.providers) {
    for (const method of provider.methods) {
      authChoices.push({
        id: method.authChoice,
        providerId: provider.id,
        methodType: method.kind,
        source: authRegistry.ok ? 'auth-registry' : 'fallback',
      })
    }
  }

  return authChoices
}

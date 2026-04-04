import type { CliResult, RunCliStreamOptions } from './cli'
import type { OpenClawCapabilities } from './openclaw-capabilities'
import {
  executeAuthRoute,
  loadEffectiveAuthRegistry,
  resolveAuthMethodDescriptor,
} from './openclaw-auth-executor'
import {
  loadOpenClawAuthRegistry,
  type OpenClawAuthRegistry,
} from './openclaw-auth-registry'
import { normalizeAuthChoice } from './openclaw-spawn'
import { getCliFailureMessage } from './openclaw-command-output'
import {
  buildGeminiProjectEnvFailureMessage,
  inspectOAuthDependencyForAuthChoice,
  type OAuthExternalDependencyPreflightAction,
  type OAuthExternalDependencyWarning,
} from './openclaw-oauth-dependencies'
import { extractStalePluginConfigEntryIds, pruneStalePluginConfigEntries } from './openclaw-config-warnings'
import { MAIN_RUNTIME_POLICY } from './runtime-policy'
import { buildOpenAICodexCallbackProbeUrls } from '../../src/shared/desktop-url-policy'
import { pollWithBackoff } from '../../src/shared/polling'

export interface StartModelOAuthRequest {
  providerId: string
  methodId: string
  selectedExtraOption?: string
  setDefault?: boolean
}

export interface StartModelOAuthResult extends CliResult {
  providerId: string
  methodId: string
  loginProviderId: string
  pluginId?: string
  message?: string
  preflightAction?: OAuthExternalDependencyPreflightAction
  preflightWarnings?: OAuthExternalDependencyWarning[]
}

interface OAuthStatePayload {
  providerId: string
  methodId: string
  state: 'preparing' | 'plugin-ready' | 'opening-browser' | 'waiting-for-approval' | 'browser-open-failed'
}

interface OAuthResultPayload {
  providerId: string
  methodId: string
  loginProviderId: string
  stdout: string
  stderr: string
  code: number | null
}

type OAuthEventChannel = 'oauth:state' | 'oauth:code' | 'oauth:success' | 'oauth:error'

interface StartModelOAuthOptions {
  emit?: (channel: OAuthEventChannel, payload: Record<string, any>) => void
  runCommand?: (args: string[], timeout?: number) => Promise<CliResult>
  runStreamingCommand?: (args: string[], options?: RunCliStreamOptions) => Promise<CliResult>
  loadAuthRegistry?: () => Promise<OpenClawAuthRegistry>
  capabilities?: OpenClawCapabilities
  loadCapabilities?: () => Promise<OpenClawCapabilities>
  probeOpenAICallbackPort?: () => Promise<{ staleListenerDetected: boolean; message?: string }>
  inspectOAuthDependency?: (
    authChoice: string
  ) => Promise<Awaited<ReturnType<typeof inspectOAuthDependencyForAuthChoice>>>
  checkOAuthComplete?: (providerKey: string) => Promise<boolean>
  verifyProviderPersistence?: (providerCandidates: string[]) => Promise<boolean>
  pruneStalePluginEntries?: (
    pluginIds: string[]
  ) => Promise<Awaited<ReturnType<typeof pruneStalePluginConfigEntries>>>
}

async function defaultRunStreamingCommand(
  args: string[],
  options?: RunCliStreamOptions
): Promise<CliResult> {
  const cli = await import('./cli')
  return cli.runCliStreaming(args, options)
}

async function defaultCheckOAuthComplete(providerKey: string): Promise<boolean> {
  const cli = await import('./cli')
  return cli.checkOAuthComplete(providerKey)
}

function isOpenAICodexFlow(authChoice: string, loginProviderId: string): boolean {
  return normalizeAuthChoice(authChoice) === 'openai-codex' || normalizeAuthChoice(loginProviderId) === 'openai-codex'
}

function hasGoogleCloudProjectMissingWarning(
  warnings: OAuthExternalDependencyWarning[] | undefined
): boolean {
  return Boolean(warnings?.some((warning) => warning.id === 'google-cloud-project-missing'))
}

function isGenericGeminiOAuthFailure(message: string): boolean {
  const normalized = String(message || '').trim().toLowerCase()
  return (
    normalized.includes('gemini cli oauth failed') ||
    normalized === 'oauth 认证失败' ||
    normalized === 'auth command failed'
  )
}

function maybeEnhanceGeminiOAuthFailureMessage(
  authChoice: string,
  message: string,
  warnings: OAuthExternalDependencyWarning[] | undefined
): string {
  if (normalizeAuthChoice(authChoice) !== 'google-gemini-cli') return message
  if (!hasGoogleCloudProjectMissingWarning(warnings)) return message
  if (!isGenericGeminiOAuthFailure(message)) return message
  return buildGeminiProjectEnvFailureMessage()
}

function uniqueProviderCandidates(values: string[]): string[] {
  const seen = new Set<string>()
  const unique: string[] = []

  for (const value of values) {
    const normalized = normalizeAuthChoice(String(value || '').trim())
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    unique.push(normalized)
  }

  return unique
}

async function verifyPersistedOAuthProvider(
  providerCandidates: string[],
  options: StartModelOAuthOptions
): Promise<boolean> {
  const candidates = uniqueProviderCandidates(providerCandidates)
  if (candidates.length === 0) return false

  const checkOAuthComplete = options.checkOAuthComplete || defaultCheckOAuthComplete
  const result = await pollWithBackoff({
    policy: MAIN_RUNTIME_POLICY.auth.persistencePoll,
    execute: async () => {
      const checks = await Promise.all(candidates.map((candidate) => checkOAuthComplete(candidate)))
      return checks.some(Boolean)
    },
    isSuccess: (value) => value === true,
  })

  return result.ok && result.value === true
}

async function defaultProbeOpenAICallbackPort(): Promise<{ staleListenerDetected: boolean; message?: string }> {
  for (const probeUrl of buildOpenAICodexCallbackProbeUrls()) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 1200)

    try {
      const response = await fetch(probeUrl, {
        method: 'GET',
        signal: controller.signal,
      })
      const body = String((await response.text().catch(() => '')) || '').trim()
      const target = new URL(probeUrl)
      const displayTarget = `${target.hostname}:${target.port}`

      // Any concrete HTTP response means something is already bound on the local callback target.
      // For OpenAI Codex OAuth this should only exist while an active login flow is waiting.
      if (!response.ok) {
        if (body.toLowerCase() === 'state mismatch') {
          return {
            staleListenerDetected: true,
            message:
              `检测到本地浏览器授权登录回调地址 ${displayTarget} 已被旧会话占用（State mismatch）。请关闭旧的 openclaw 登录会话后重试。`,
          }
        }
        return {
          staleListenerDetected: true,
          message: `检测到本地浏览器授权登录回调地址 ${displayTarget} 已被占用（HTTP ${response.status}）。请关闭旧的 openclaw 登录会话后重试。`,
        }
      }

      return {
        staleListenerDetected: true,
        message: `检测到本地浏览器授权登录回调地址 ${displayTarget} 正在被使用。请先结束旧的 openclaw 登录会话后重试。`,
      }
    } catch {
      // ECONNREFUSED / timeout / DNS failures here mean no active local callback listener.
    } finally {
      clearTimeout(timer)
    }
  }

  return { staleListenerDetected: false }
}

export async function startModelOAuthFlow(
  request: StartModelOAuthRequest,
  options: StartModelOAuthOptions = {}
): Promise<StartModelOAuthResult> {
  const emit = options.emit || (() => {})
  const providerId = request.providerId.trim()
  const methodId = normalizeAuthChoice(request.methodId)
  const loadAuthRegistry = options.loadAuthRegistry ?? (() => loadOpenClawAuthRegistry())
  const loadCapabilities =
    options.loadCapabilities ??
    (!options.runCommand && !options.runStreamingCommand
      ? async () => {
          const { loadOpenClawCapabilities } = await import('./openclaw-capabilities')
          return loadOpenClawCapabilities()
        }
      : undefined)
  const capabilities = options.capabilities ?? (loadCapabilities ? await loadCapabilities() : undefined)

  const authRegistry = await loadEffectiveAuthRegistry({
    capabilities,
    loadAuthRegistry,
  })
  const resolvedMethod = resolveAuthMethodDescriptor(authRegistry, providerId, methodId)
  if (!resolvedMethod.ok) {
    const payload = {
      providerId,
      methodId,
      loginProviderId: '',
      stdout: '',
      stderr: resolvedMethod.message,
      code: null,
    } satisfies OAuthResultPayload
    emit('oauth:error', payload)
    return {
      ok: false,
      stdout: '',
      stderr: '',
      code: null,
      providerId,
      methodId,
      loginProviderId: '',
      message: resolvedMethod.message,
    }
  }

  const method = resolvedMethod.value.method
  const loginProviderId = String(method.route.providerId || '').trim()
  if (!method.route.requiresBrowser) {
    const message = `Selected auth method "${method.authChoice}" does not require a browser login flow.`
    const payload = {
      providerId,
      methodId,
      loginProviderId,
      stdout: '',
      stderr: message,
      code: null,
    } satisfies OAuthResultPayload
    emit('oauth:error', payload)
    return {
      ok: false,
      stdout: '',
      stderr: '',
      code: null,
      providerId,
      methodId,
      loginProviderId,
      pluginId: method.route.pluginId,
      message,
    }
  }

  const dependencyInspection = await (options.inspectOAuthDependency || inspectOAuthDependencyForAuthChoice)(
    method.authChoice
  )
  if (!dependencyInspection.ready && dependencyInspection.action) {
    return {
      ok: false,
      stdout: '',
      stderr: '',
      code: null,
      providerId,
      methodId,
      loginProviderId,
      pluginId: method.route.pluginId,
      message: dependencyInspection.action.message,
      preflightAction: dependencyInspection.action,
      preflightWarnings: dependencyInspection.warnings,
    }
  }

  if (isOpenAICodexFlow(method.authChoice, loginProviderId)) {
    const probeResult = await (options.probeOpenAICallbackPort ?? defaultProbeOpenAICallbackPort)()
    if (probeResult.staleListenerDetected) {
      const message =
        probeResult.message ||
        '检测到本地浏览器授权登录回调端口已被旧会话占用，请关闭旧会话后重试。'
      const payload = {
        providerId,
        methodId,
        loginProviderId,
        stdout: '',
        stderr: message,
        code: null,
      } satisfies OAuthResultPayload
      emit('oauth:error', payload)
      return {
        ok: false,
        stdout: '',
        stderr: '',
        code: null,
        providerId,
        methodId,
        loginProviderId,
        pluginId: method.route.pluginId,
        message,
      }
    }
  }

  emit('oauth:state', {
    providerId,
    methodId,
    state: 'preparing',
  } satisfies OAuthStatePayload)

  const result = await executeAuthRoute(
    {
      providerId,
      methodId,
      method,
      selectedExtraOption: request.selectedExtraOption,
      setDefault: request.setDefault,
      emit,
    },
    {
      runCommand: options.runCommand,
      runStreamingCommand: options.runStreamingCommand ?? defaultRunStreamingCommand,
      capabilities,
      loadCapabilities,
    }
  )

  const stalePluginIds = extractStalePluginConfigEntryIds(`${result.stderr || ''}\n${result.stdout || ''}`)
  if (stalePluginIds.length > 0) {
    await (options.pruneStalePluginEntries || pruneStalePluginConfigEntries)(stalePluginIds)
  }

  const resolvedLoginProviderId = result.loginProviderId || loginProviderId
  if (!result.ok && result.attemptedCommands.length > 0) {
    const persistenceCandidates = uniqueProviderCandidates([
      providerId,
      loginProviderId,
      resolvedLoginProviderId,
    ])
    const persisted = await (options.verifyProviderPersistence || ((providerCandidates: string[]) =>
      verifyPersistedOAuthProvider(providerCandidates, options)))(persistenceCandidates)

    if (persisted) {
      const payload = {
        providerId,
        methodId,
        loginProviderId: resolvedLoginProviderId,
        stdout: result.stdout,
        stderr: '',
        code: 0,
      } satisfies OAuthResultPayload
      emit('oauth:success', payload)

      return {
        ok: true,
        stdout: result.stdout,
        stderr: '',
        code: 0,
        providerId,
        methodId,
        loginProviderId: resolvedLoginProviderId,
        pluginId: result.pluginId,
      }
    }
  }

  const normalizedErrorMessage = result.ok
    ? ''
    : maybeEnhanceGeminiOAuthFailureMessage(
        method.authChoice,
        result.message || getCliFailureMessage(result, '浏览器授权登录失败'),
        dependencyInspection.warnings
      )

  const payload = {
    providerId,
    methodId,
    loginProviderId: resolvedLoginProviderId,
    stdout: result.ok ? result.stdout : '',
    stderr: result.ok ? result.stderr : normalizedErrorMessage,
    code: result.code,
  } satisfies OAuthResultPayload

  if (result.ok) {
    emit('oauth:success', payload)
  } else {
    emit('oauth:error', payload)
  }

  return {
    ok: result.ok,
    stdout: result.stdout,
    stderr: result.stderr,
    code: result.code,
    providerId,
    methodId,
    loginProviderId: resolvedLoginProviderId,
    pluginId: result.pluginId,
    message: result.ok ? undefined : normalizedErrorMessage,
    preflightWarnings: dependencyInspection.warnings,
  }
}

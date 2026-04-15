import { resolveOpenClawPackageRoot } from './openclaw-package'
import { resolveWindowsActiveRuntimeSnapshotForRead } from './openclaw-runtime-readonly'

const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')
const { pathToFileURL } = process.getBuiltinModule('node:url') as typeof import('node:url')

export interface DirectProviderApiKeyAuthApplyParams {
  authChoice: string
  apiKey: string
  config: Record<string, any> | null | undefined
  agentDir: string
  workspaceDir?: string
  env?: NodeJS.ProcessEnv
}

export interface DirectProviderApiKeyAuthApplyResult {
  ok: boolean
  config?: Record<string, any>
  providerId?: string
  methodId?: string
  message?: string
}

type ResolvePluginProviders = (params: Record<string, any>) => Array<Record<string, any>>
type EnablePluginInConfig = (
  config: Record<string, any>,
  pluginId: string
) => {
  config: Record<string, any>
  enabled: boolean
  reason?: string
}

let resolvePluginProvidersPromise: Promise<ResolvePluginProviders> | null = null
let enablePluginInConfigPromise: Promise<EnablePluginInConfig> | null = null

function isPlainRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function cloneJsonValue<T>(value: T): T {
  if (value === undefined) return value
  return JSON.parse(JSON.stringify(value)) as T
}

function normalizeChoice(value: unknown): string {
  return String(value || '').trim().toLowerCase()
}

function formatUnknownError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error || '')
  return String(message || '').trim() || fallback
}

async function findOpenClawDistFileContaining(packageRoot: string, requiredContent: string): Promise<string> {
  const distDir = path.join(packageRoot, 'dist')
  const entries = await fs.promises.readdir(distDir)
  const candidates = entries
    .filter((entry) => entry.endsWith('.js'))
    .sort((left, right) => {
      const leftProviderPriority = left.startsWith('providers.runtime') ? 0 : 1
      const rightProviderPriority = right.startsWith('providers.runtime') ? 0 : 1
      if (leftProviderPriority !== rightProviderPriority) return leftProviderPriority - rightProviderPriority
      return left.localeCompare(right)
    })

  for (const entry of candidates) {
    const filePath = path.join(distDir, entry)
    const text = await fs.promises.readFile(filePath, 'utf8')
    if (text.includes(requiredContent)) return filePath
  }

  throw new Error(`Unable to locate OpenClaw provider runtime containing "${requiredContent}"`)
}

async function loadResolvePluginProviders(): Promise<ResolvePluginProviders> {
  if (!resolvePluginProvidersPromise) {
    resolvePluginProvidersPromise = (async () => {
      const activeRuntimeSnapshot = await resolveWindowsActiveRuntimeSnapshotForRead()
      const packageRoot = await resolveOpenClawPackageRoot({ activeRuntimeSnapshot })
      const providerRuntimePath = await findOpenClawDistFileContaining(
        packageRoot,
        'function resolvePluginProviders(params)'
      )
      const mod = await import(pathToFileURL(providerRuntimePath).href)
      const resolver = Object.values(mod).find(
        (value) => typeof value === 'function' && (value as Function).name === 'resolvePluginProviders'
      )
      if (typeof resolver !== 'function') {
        throw new Error(`OpenClaw provider runtime did not export resolvePluginProviders: ${providerRuntimePath}`)
      }
      return resolver as ResolvePluginProviders
    })()
  }
  return resolvePluginProvidersPromise
}

async function loadEnablePluginInConfig(): Promise<EnablePluginInConfig> {
  if (!enablePluginInConfigPromise) {
    enablePluginInConfigPromise = (async () => {
      const activeRuntimeSnapshot = await resolveWindowsActiveRuntimeSnapshotForRead()
      const packageRoot = await resolveOpenClawPackageRoot({ activeRuntimeSnapshot })
      const enablePath = await findOpenClawDistFileContaining(packageRoot, 'function enablePluginInConfig(cfg, pluginId)')
      const mod = await import(pathToFileURL(enablePath).href)
      const enable = Object.values(mod).find(
        (value) => typeof value === 'function' && (value as Function).name === 'enablePluginInConfig'
      )
      if (typeof enable !== 'function') {
        throw new Error(`OpenClaw plugin enable runtime did not export enablePluginInConfig: ${enablePath}`)
      }
      return enable as EnablePluginInConfig
    })()
  }
  return enablePluginInConfigPromise
}

function findProviderMethodForAuthChoice(
  providers: Array<Record<string, any>>,
  authChoice: string
): { provider: Record<string, any>; method: Record<string, any> } | null {
  const normalizedAuthChoice = normalizeChoice(authChoice)
  if (!normalizedAuthChoice) return null

  for (const provider of providers) {
    const methods = Array.isArray(provider.auth) ? provider.auth : []
    for (const method of methods) {
      const wizardChoiceId = normalizeChoice(method?.wizard?.choiceId)
      const methodId = normalizeChoice(method?.id)
      const providerPluginChoice = `provider-plugin:${normalizeChoice(provider.id)}:${methodId}`
      if (
        wizardChoiceId === normalizedAuthChoice ||
        methodId === normalizedAuthChoice ||
        providerPluginChoice === normalizedAuthChoice
      ) {
        return { provider, method }
      }
    }

    if (normalizeChoice(provider.id) === normalizedAuthChoice && methods.length === 1) {
      return { provider, method: methods[0] }
    }
  }

  return null
}

class DirectProviderAuthExit extends Error {
  constructor(
    readonly code: number | null,
    message: string
  ) {
    super(message)
    this.name = 'DirectProviderAuthExit'
  }
}

export async function applyOpenClawProviderApiKeyAuthChoice(
  params: DirectProviderApiKeyAuthApplyParams
): Promise<DirectProviderApiKeyAuthApplyResult> {
  const authChoice = normalizeChoice(params.authChoice)
  const apiKey = String(params.apiKey || '').trim()
  const agentDir = String(params.agentDir || '').trim()
  if (!authChoice || !apiKey || !agentDir) {
    return {
      ok: false,
      message: 'direct API-key auth requires authChoice, apiKey, and agentDir',
    }
  }

  const errors: string[] = []
  const logs: string[] = []
  try {
    const resolvePluginProviders = await loadResolvePluginProviders()
    const baseConfig = isPlainRecord(params.config) ? cloneJsonValue(params.config) : {}
    const workspaceDir = String(params.workspaceDir || process.cwd()).trim() || process.cwd()
    const providers = resolvePluginProviders({
      config: baseConfig,
      workspaceDir,
      env: params.env || process.env,
      mode: 'setup',
      includeUntrustedWorkspacePlugins: false,
    })
    const matched = findProviderMethodForAuthChoice(providers, authChoice)
    if (!matched) {
      return {
        ok: false,
        message: `OpenClaw provider runtime has no non-interactive API-key method for "${authChoice}"`,
      }
    }

    if (normalizeChoice(matched.method.kind).replace(/_/g, '-') !== 'api-key') {
      return {
        ok: false,
        providerId: String(matched.provider.id || '').trim(),
        methodId: String(matched.method.id || '').trim(),
        message: `OpenClaw provider method "${authChoice}" is not an API-key method`,
      }
    }
    if (typeof matched.method.runNonInteractive !== 'function') {
      return {
        ok: false,
        providerId: String(matched.provider.id || '').trim(),
        methodId: String(matched.method.id || '').trim(),
        message: `OpenClaw provider method "${authChoice}" does not support non-interactive setup`,
      }
    }
    const pluginId = String(matched.provider.pluginId || matched.provider.id || '').trim()
    if (!pluginId) {
      return {
        ok: false,
        providerId: String(matched.provider.id || '').trim(),
        methodId: String(matched.method.id || '').trim(),
        message: `OpenClaw provider method "${authChoice}" has no owning plugin id`,
      }
    }
    const enablePluginInConfig = await loadEnablePluginInConfig()
    const enableResult = enablePluginInConfig(baseConfig, pluginId)
    if (!enableResult.enabled) {
      return {
        ok: false,
        providerId: String(matched.provider.id || '').trim(),
        methodId: String(matched.method.id || '').trim(),
        message: `${String(matched.provider.label || matched.provider.id || authChoice)} plugin is disabled (${enableResult.reason || 'blocked'}).`,
      }
    }

    const runtime = {
      error: (message: unknown) => {
        errors.push(String(message || '').trim())
      },
      log: (message: unknown) => {
        logs.push(String(message || '').trim())
      },
      exit: (code?: number) => {
        throw new DirectProviderAuthExit(
          typeof code === 'number' ? code : null,
          errors.filter(Boolean).join('\n') || `OpenClaw provider setup exited with code ${code ?? 'unknown'}`
        )
      },
    }

    const nextConfig = await matched.method.runNonInteractive({
      authChoice,
      config: enableResult.config,
      baseConfig,
      opts: {
        token: apiKey,
      },
      runtime,
      agentDir,
      workspaceDir,
      resolveApiKey: async () => ({
        key: apiKey,
        source: 'flag',
      }),
      toApiKeyCredential: (input: Record<string, any>) => ({
        type: 'api_key',
        provider: String(input.provider || matched.provider.id || '').trim(),
        key: apiKey,
        ...(isPlainRecord(input.metadata) ? { metadata: input.metadata } : {}),
      }),
    })

    if (!isPlainRecord(nextConfig)) {
      return {
        ok: false,
        providerId: String(matched.provider.id || '').trim(),
        methodId: String(matched.method.id || '').trim(),
        message:
          errors.filter(Boolean).join('\n') ||
          logs.filter(Boolean).join('\n') ||
          `OpenClaw provider setup for "${authChoice}" did not produce a config`,
      }
    }

    return {
      ok: true,
      config: nextConfig,
      providerId: String(matched.provider.id || '').trim(),
      methodId: String(matched.method.id || '').trim(),
    }
  } catch (error) {
    const detail = [
      ...errors.filter(Boolean),
      ...logs.filter(Boolean),
      formatUnknownError(error, `OpenClaw provider setup for "${authChoice}" failed`),
    ]
      .filter(Boolean)
      .join('\n')
    return {
      ok: false,
      message: detail,
    }
  }
}

import type { CliResult } from './cli'
import type { OpenClawCapabilities } from './openclaw-capabilities'
import {
  buildModelsAuthAddCommand,
  buildModelsAuthLoginGitHubCopilotCommand,
  buildModelsAuthOrderClearCommand,
  buildModelsAuthOrderGetCommand,
  buildModelsAuthOrderSetCommand,
  buildModelsAuthPasteTokenCommand,
  buildModelsAuthSetupTokenCommand,
  buildOnboardCommand,
  type CustomProviderConfigInput,
  type OpenClawCommandBuildResult,
} from './openclaw-command-builder'
import { getCliFailureMessage } from './openclaw-command-output'
import {
  executeAuthRoute,
  loadEffectiveAuthRegistry,
  resolveAuthMethodDescriptor,
} from './openclaw-auth-executor'
import { appendModelAuthDiagnosticLog } from './model-auth-diagnostic-log'
import {
  loadOpenClawAuthRegistry,
  type OpenClawAuthRegistry,
} from './openclaw-auth-registry'
import type { CliCommandResult } from './openclaw-capabilities'
import { normalizeAuthChoice } from './openclaw-spawn'
import { MAIN_RUNTIME_POLICY } from './runtime-policy'

const TOKEN_TIMEOUT_MS = MAIN_RUNTIME_POLICY.auth.tokenTimeoutMs
const ORDER_TIMEOUT_MS = MAIN_RUNTIME_POLICY.auth.orderTimeoutMs
const ONBOARD_TIMEOUT_MS = MAIN_RUNTIME_POLICY.auth.onboardTimeoutMs

let authRunning = false

export type AuthAction =
  | {
      kind: 'login'
      providerId: string
      methodId: string
      selectedExtraOption?: string
      secret?: string
      customConfig?: CustomProviderConfigInput
      setDefault?: boolean
      fallbackAuthChoice?: string
      fallbackInteractive?: boolean
      fallbackAcceptRisk?: boolean
      fallbackInstallDaemon?: boolean
      fallbackSkipChannels?: boolean
      fallbackSkipSkills?: boolean
      fallbackSkipSearch?: boolean
      fallbackSkipUi?: boolean
    }
  | {
      kind: 'paste-token'
      providerId: string
      profileId?: string
      expiresIn?: string
    }
  | {
      kind: 'setup-token'
      providerId: string
      yes?: boolean
    }
  | {
      kind: 'auth-add'
    }
  | {
      kind: 'login-github-copilot'
      profileId?: string
      yes?: boolean
    }
  | {
      kind: 'auth-order-get'
      providerId: string
      agentId?: string
      json?: boolean
    }
  | {
      kind: 'auth-order-set'
      providerId: string
      profileIds: string[]
      agentId?: string
    }
  | {
      kind: 'auth-order-clear'
      providerId: string
      agentId?: string
    }
  | {
      kind: 'onboard-fallback'
      authChoice: string
      interactive?: boolean
      acceptRisk?: boolean
      installDaemon?: boolean
      skipChannels?: boolean
      skipSkills?: boolean
      skipUi?: boolean
      secret?: string
      cliFlag?: string
    }

export type AuthErrorCode = 'auth_busy' | 'invalid_input' | 'command_failed' | 'unsupported_capability'

export interface RunAuthActionResult {
  ok: boolean
  action: AuthAction['kind']
  attemptedCommands: string[][]
  stdout: string
  stderr: string
  code: number | null
  fallbackUsed: boolean
  errorCode?: AuthErrorCode
  message?: string
}

interface RunAuthActionOptions {
  runCommand?: (args: string[], timeout?: number) => Promise<CliCommandResult>
  runCommandWithEnv?: (
    args: string[],
    timeout: number | undefined,
    env: Partial<NodeJS.ProcessEnv>
  ) => Promise<CliCommandResult>
  readConfig?: () => Promise<Record<string, any> | null>
  loadAuthRegistry?: () => Promise<OpenClawAuthRegistry>
  capabilities?: OpenClawCapabilities
  loadCapabilities?: () => Promise<OpenClawCapabilities>
}

async function defaultRunCommand(args: string[], timeout?: number): Promise<CliCommandResult> {
  const cli = await import('./cli')
  return cli.runCli(args, timeout, 'oauth')
}

async function defaultRunCommandWithEnv(
  args: string[],
  timeout: number | undefined,
  env: Partial<NodeJS.ProcessEnv>
): Promise<CliCommandResult> {
  const cli = await import('./cli')
  return cli.runCliStreaming(args, {
    timeout,
    controlDomain: 'oauth',
    env,
  })
}

function invalidInput(
  action: AuthAction['kind'],
  message: string,
  attemptedCommands: string[][] = []
): RunAuthActionResult {
  return {
    ok: false,
    action,
    attemptedCommands,
    stdout: '',
    stderr: '',
    code: null,
    fallbackUsed: false,
    errorCode: 'invalid_input',
    message,
  }
}

function failedFromCommand(
  action: AuthAction['kind'],
  attemptedCommands: string[][],
  result: CliResult,
  fallbackUsed = false,
  messageOverride?: string
): RunAuthActionResult {
  return {
    ok: false,
    action,
    attemptedCommands,
    stdout: result.stdout,
    stderr: result.stderr,
    code: result.code,
    fallbackUsed,
    errorCode: 'command_failed',
    message: messageOverride || getCliFailureMessage(result, 'Auth command failed'),
  }
}

function successFromCommand(
  action: AuthAction['kind'],
  attemptedCommands: string[][],
  result: CliResult,
  fallbackUsed = false
): RunAuthActionResult {
  return {
    ok: true,
    action,
    attemptedCommands,
    stdout: result.stdout,
    stderr: result.stderr,
    code: result.code,
    fallbackUsed,
  }
}

function fromBuildFailure(
  action: AuthAction['kind'],
  attemptedCommands: string[][],
  buildResult: Extract<OpenClawCommandBuildResult, { ok: false }>
): RunAuthActionResult {
  return {
    ok: false,
    action,
    attemptedCommands,
    stdout: '',
    stderr: '',
    code: null,
    fallbackUsed: false,
    errorCode: buildResult.errorCode === 'invalid_input' ? 'invalid_input' : 'unsupported_capability',
    message: buildResult.message,
  }
}

async function appendRunAuthDiagnostic(entry: {
  event: string
  action: AuthAction
  details?: Record<string, unknown>
}) {
  await appendModelAuthDiagnosticLog({
    source: 'main:auth-orchestrator',
    event: entry.event,
    providerId: 'providerId' in entry.action ? String(entry.action.providerId || '').trim() || undefined : undefined,
    methodId:
      'methodId' in entry.action
        ? String((entry.action as { methodId?: string }).methodId || '').trim() || undefined
        : undefined,
    details: {
      actionKind: entry.action.kind,
      ...entry.details,
    },
  }).catch(() => null)
}

async function resolveCapabilities(options: RunAuthActionOptions): Promise<OpenClawCapabilities | undefined> {
  if (options.capabilities) return options.capabilities
  if (options.loadCapabilities) return options.loadCapabilities()
  if (options.runCommand) return undefined

  const { loadOpenClawCapabilities } = await import('./openclaw-capabilities')
  return loadOpenClawCapabilities()
}

export async function runAuthAction(
  action: AuthAction,
  options: RunAuthActionOptions = {}
): Promise<RunAuthActionResult> {
  if (authRunning) {
    await appendRunAuthDiagnostic({
      event: 'run-auth-action-rejected-busy',
      action,
      details: {},
    })
    return {
      ok: false,
      action: action.kind,
      attemptedCommands: [],
      stdout: '',
      stderr: '',
      code: null,
      fallbackUsed: false,
      errorCode: 'auth_busy',
      message: 'Another auth flow is currently running',
    }
  }

  authRunning = true
  const runCommand = options.runCommand ?? defaultRunCommand
  const runCommandWithEnv =
    options.runCommandWithEnv ?? (options.runCommand ? undefined : defaultRunCommandWithEnv)
  const loadAuthRegistry = options.loadAuthRegistry ?? (() => loadOpenClawAuthRegistry())
  const capabilities = await resolveCapabilities(options)
  const attemptedCommands: string[][] = []

  try {
    await appendRunAuthDiagnostic({
      event: 'run-auth-action-start',
      action,
      details: {
        hasSecret: 'secret' in action ? Boolean(String(action.secret || '').trim()) : false,
        selectedExtraOption:
          'selectedExtraOption' in action ? String(action.selectedExtraOption || '').trim() || undefined : undefined,
      },
    })
    if (action.kind === 'login') {
      const providerId = action.providerId.trim()
      const methodId = normalizeAuthChoice(action.methodId)
      if (!providerId || !methodId) {
        return invalidInput(action.kind, 'providerId and methodId are required')
      }

      const authRegistry = await loadEffectiveAuthRegistry({
        capabilities,
        loadAuthRegistry,
      })
      const resolvedMethod = resolveAuthMethodDescriptor(authRegistry, providerId, methodId)
      if (!resolvedMethod.ok) {
        if (resolvedMethod.errorCode === 'invalid_input') {
          return invalidInput(action.kind, resolvedMethod.message)
        }
        return failedFromCommand(
          action.kind,
          attemptedCommands,
          { ok: false, stdout: '', stderr: '', code: null },
          false,
          resolvedMethod.message
        )
      }

      const result = await executeAuthRoute(
        {
          providerId,
          methodId,
          method: resolvedMethod.value.method,
          selectedExtraOption: action.selectedExtraOption,
          secret: action.secret,
          customConfig: action.customConfig,
          setDefault: action.setDefault,
        },
        {
          runCommand,
          runCommandWithEnv,
          readConfig: options.readConfig,
          capabilities,
          loadCapabilities: options.loadCapabilities,
        }
      )

      attemptedCommands.push(...result.attemptedCommands)
      await appendRunAuthDiagnostic({
        event: 'run-auth-action-result',
        action,
        details: {
          ok: result.ok,
          errorCode: result.errorCode,
          attemptedCommandCount: result.attemptedCommands.length,
          routeKind: result.routeKind,
          routeMethodId: result.routeMethodId,
          pluginId: result.pluginId,
          message: result.message,
        },
      })
      if (result.ok) {
        return successFromCommand(action.kind, attemptedCommands, result)
      }
      if (result.errorCode === 'invalid_input') {
        return invalidInput(action.kind, result.message || 'Invalid auth input', attemptedCommands)
      }
      if (result.errorCode === 'unsupported_capability') {
        return {
          ok: false,
          action: action.kind,
          attemptedCommands,
          stdout: result.stdout,
          stderr: result.stderr,
          code: result.code,
          fallbackUsed: false,
          errorCode: 'unsupported_capability',
          message: result.message,
        }
      }
      return failedFromCommand(action.kind, attemptedCommands, result, false, result.message)
    }

    if (action.kind === 'paste-token') {
      const providerId = action.providerId.trim()
      if (!providerId) {
        return invalidInput(action.kind, 'providerId is required')
      }
      const command = buildModelsAuthPasteTokenCommand(
        {
          providerId,
          profileId: action.profileId,
          expiresIn: action.expiresIn,
        },
        capabilities
      )
      if (!command.ok) return fromBuildFailure(action.kind, attemptedCommands, command)

      attemptedCommands.push(command.command)

      const result = await runCommand(command.command, TOKEN_TIMEOUT_MS)
      if (!result.ok) return failedFromCommand(action.kind, attemptedCommands, result)
      return successFromCommand(action.kind, attemptedCommands, result)
    }

    if (action.kind === 'setup-token') {
      const providerId = action.providerId.trim()
      if (!providerId) {
        return invalidInput(action.kind, 'providerId is required')
      }
      const command = buildModelsAuthSetupTokenCommand(
        {
          providerId,
          yes: action.yes,
        },
        capabilities
      )
      if (!command.ok) return fromBuildFailure(action.kind, attemptedCommands, command)

      attemptedCommands.push(command.command)

      const result = await runCommand(command.command, TOKEN_TIMEOUT_MS)
      if (!result.ok) return failedFromCommand(action.kind, attemptedCommands, result)
      return successFromCommand(action.kind, attemptedCommands, result)
    }

    if (action.kind === 'auth-add') {
      const command = buildModelsAuthAddCommand(capabilities)
      if (!command.ok) return fromBuildFailure(action.kind, attemptedCommands, command)

      attemptedCommands.push(command.command)
      const result = await runCommand(command.command, TOKEN_TIMEOUT_MS)
      if (!result.ok) return failedFromCommand(action.kind, attemptedCommands, result)
      return successFromCommand(action.kind, attemptedCommands, result)
    }

    if (action.kind === 'login-github-copilot') {
      const command = buildModelsAuthLoginGitHubCopilotCommand(
        {
          profileId: action.profileId,
          yes: action.yes,
        },
        capabilities
      )
      if (!command.ok) return fromBuildFailure(action.kind, attemptedCommands, command)

      attemptedCommands.push(command.command)
      const result = await runCommand(command.command, TOKEN_TIMEOUT_MS)
      if (!result.ok) return failedFromCommand(action.kind, attemptedCommands, result)
      return successFromCommand(action.kind, attemptedCommands, result)
    }

    if (action.kind === 'auth-order-get') {
      const providerId = action.providerId.trim()
      if (!providerId) {
        return invalidInput(action.kind, 'providerId is required')
      }
      const command = buildModelsAuthOrderGetCommand(
        {
          providerId,
          agentId: action.agentId,
          json: action.json,
        },
        capabilities
      )
      if (!command.ok) return fromBuildFailure(action.kind, attemptedCommands, command)

      attemptedCommands.push(command.command)
      const result = await runCommand(command.command, ORDER_TIMEOUT_MS)
      if (!result.ok) return failedFromCommand(action.kind, attemptedCommands, result)
      return successFromCommand(action.kind, attemptedCommands, result)
    }

    if (action.kind === 'auth-order-set') {
      const providerId = action.providerId.trim()
      if (!providerId) {
        return invalidInput(action.kind, 'providerId is required')
      }
      const profileIds = (action.profileIds || []).map((id) => String(id || '').trim()).filter(Boolean)
      if (profileIds.length === 0) {
        return invalidInput(action.kind, 'profileIds must contain at least one profile id')
      }
      const command = buildModelsAuthOrderSetCommand(
        {
          providerId,
          agentId: action.agentId,
          profileIds,
        },
        capabilities
      )
      if (!command.ok) return fromBuildFailure(action.kind, attemptedCommands, command)

      attemptedCommands.push(command.command)
      const result = await runCommand(command.command, ORDER_TIMEOUT_MS)
      if (!result.ok) return failedFromCommand(action.kind, attemptedCommands, result)
      return successFromCommand(action.kind, attemptedCommands, result)
    }

    if (action.kind === 'auth-order-clear') {
      const providerId = action.providerId.trim()
      if (!providerId) {
        return invalidInput(action.kind, 'providerId is required')
      }
      const command = buildModelsAuthOrderClearCommand(
        {
          providerId,
          agentId: action.agentId,
        },
        capabilities
      )
      if (!command.ok) return fromBuildFailure(action.kind, attemptedCommands, command)

      attemptedCommands.push(command.command)
      const result = await runCommand(command.command, ORDER_TIMEOUT_MS)
      if (!result.ok) return failedFromCommand(action.kind, attemptedCommands, result)
      return successFromCommand(action.kind, attemptedCommands, result)
    }

    if (action.kind === 'onboard-fallback') {
      const authChoice = action.authChoice.trim()
      if (!authChoice) {
        return invalidInput(action.kind, 'authChoice is required')
      }

      const valueFlags =
        action.cliFlag?.trim() && action.secret?.trim()
          ? [{ flag: action.cliFlag.trim(), value: action.secret.trim() }]
          : []

      const command = buildOnboardCommand(
        {
          authChoice,
          interactive: action.interactive,
          acceptRisk: action.acceptRisk !== false,
          installDaemon: action.installDaemon,
          skipChannels: action.skipChannels,
          skipSkills: action.skipSkills,
          skipUi: action.skipUi,
          valueFlags,
        },
        capabilities
      )
      if (!command.ok) return fromBuildFailure(action.kind, attemptedCommands, command)

      attemptedCommands.push(command.command)

      const result = await runCommand(command.command, ONBOARD_TIMEOUT_MS)
      if (!result.ok) return failedFromCommand(action.kind, attemptedCommands, result)
      return successFromCommand(action.kind, attemptedCommands, result)
    }

    const unreachableAction: never = action
    return invalidInput('onboard-fallback', `Unsupported auth action: ${String(unreachableAction)}`)
  } finally {
    await appendRunAuthDiagnostic({
      event: 'run-auth-action-finished',
      action,
      details: {
        authRunningBeforeRelease: authRunning,
      },
    })
    authRunning = false
  }
}

export function resetAuthLockForTests(): void {
  authRunning = false
}

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createOpenClawAuthRegistry } from '../openclaw-auth-registry'
import {
  resetAuthLockForTests,
  runAuthAction,
  type AuthAction,
} from '../openclaw-auth-orchestrator'
import type { CliCommandResult, OpenClawCapabilities } from '../openclaw-capabilities'

const {
  resolveMainAuthStorePathMock,
  upsertApiKeyAuthProfileMock,
  ensureGatewayRunningMock,
  confirmRuntimeReconcileMock,
  issueDesiredRuntimeRevisionMock,
  markRuntimeRevisionInProgressMock,
  resolveGatewayBlockingReasonFromStateMock,
} = vi.hoisted(() => ({
  resolveMainAuthStorePathMock: vi.fn(),
  upsertApiKeyAuthProfileMock: vi.fn(),
  ensureGatewayRunningMock: vi.fn(),
  confirmRuntimeReconcileMock: vi.fn(),
  issueDesiredRuntimeRevisionMock: vi.fn(),
  markRuntimeRevisionInProgressMock: vi.fn(),
  resolveGatewayBlockingReasonFromStateMock: vi.fn(() => 'none'),
}))

vi.mock('../local-model-probe', () => ({
  resolveMainAuthStorePath: resolveMainAuthStorePathMock,
  upsertApiKeyAuthProfile: upsertApiKeyAuthProfileMock,
}))

vi.mock('../openclaw-gateway-service', () => ({
  ensureGatewayRunning: ensureGatewayRunningMock,
}))

vi.mock('../openclaw-runtime-reconcile', () => ({
  confirmRuntimeReconcile: confirmRuntimeReconcileMock,
  issueDesiredRuntimeRevision: issueDesiredRuntimeRevisionMock,
  markRuntimeRevisionInProgress: markRuntimeRevisionInProgressMock,
  resolveGatewayBlockingReasonFromState: resolveGatewayBlockingReasonFromStateMock,
}))

function ok(stdout = ''): CliCommandResult {
  return { ok: true, stdout, stderr: '', code: 0 }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function createRegistry() {
  return createOpenClawAuthRegistry({
    source: 'openclaw-internal-registry',
    providers: [
      {
        id: 'openai',
        label: 'OpenAI',
        methods: [
          {
            authChoice: 'openai-codex',
            label: 'OAuth · openai-codex',
            kind: 'oauth',
            route: {
              kind: 'models-auth-login',
              providerId: 'openai-codex',
              requiresBrowser: true,
            },
          },
          {
            authChoice: 'openai-api-key',
            label: 'API Key · openai-api-key',
            kind: 'apiKey',
            route: {
              kind: 'onboard',
              cliFlag: '--openai-api-key',
              requiresSecret: true,
            },
          },
        ],
      },
      {
        id: 'minimax',
        label: 'MiniMax',
        methods: [
          {
            authChoice: 'minimax-portal',
            label: 'OAuth · minimax-portal',
            kind: 'oauth',
            route: {
              kind: 'models-auth-login',
              providerId: 'minimax-portal',
              pluginId: 'minimax-portal-auth',
              requiresBrowser: true,
              extraOptions: [
                { id: 'oauth', label: 'Global' },
                { id: 'oauth-cn', label: 'CN' },
              ],
            },
          },
        ],
      },
      {
        id: 'unsupported-provider',
        label: 'Unsupported',
        methods: [
          {
            authChoice: 'unsupported-auth',
            label: 'Unsupported',
            kind: 'unknown',
            route: {
              kind: 'unsupported',
            },
          },
        ],
      },
      {
        id: 'custom',
        label: 'Custom Provider',
        methods: [
          {
            authChoice: 'custom-api-key',
            label: 'Custom Provider',
            kind: 'custom',
            route: {
              kind: 'onboard-custom',
              providerId: 'custom',
            } as any,
          } as any,
        ],
      },
    ],
  })
}

function createCapabilities(authRegistry = createRegistry()): OpenClawCapabilities {
  return {
    version: 'OpenClaw 2026.3.8',
    discoveredAt: '2026-03-23T00:00:00.000Z',
    authRegistry,
    authRegistrySource: authRegistry.source,
    authChoices: [],
    rootCommands: ['onboard', 'models', 'plugins'],
    onboardFlags: ['--auth-choice', '--non-interactive'],
    modelsCommands: ['auth', 'list', 'status'],
    modelsAuthCommands: ['login', 'paste-token', 'setup-token', 'order', 'login-github-copilot'],
    pluginsCommands: ['enable', 'install'],
    commandFlags: {
      onboard: ['--auth-choice', '--non-interactive'],
      'models auth login': ['--provider', '--method', '--set-default'],
      'models auth paste-token': ['--provider'],
      'models auth setup-token': ['--provider'],
    },
    supports: {
      onboard: true,
      plugins: true,
      pluginsInstall: true,
      pluginsEnable: true,
      chatAgentModelFlag: false,
      chatGatewaySendModel: false,
      chatInThreadModelSwitch: false,
      modelsListAllJson: true,
      modelsStatusJson: true,
      modelsAuthLogin: true,
      modelsAuthAdd: true,
      modelsAuthPasteToken: true,
      modelsAuthSetupToken: true,
      modelsAuthOrder: true,
      modelsAuthLoginGitHubCopilot: true,
      aliases: false,
      fallbacks: false,
      imageFallbacks: false,
      modelsScan: false,
    },
  }
}

beforeEach(() => {
  resolveMainAuthStorePathMock.mockResolvedValue('')
  upsertApiKeyAuthProfileMock.mockResolvedValue({
    ok: true,
    created: true,
    updated: false,
    profileId: 'openai:default',
    authStorePath: '/tmp/openclaw/profiles/team-a/agents/main/agent/auth-profiles.json',
  })
  ensureGatewayRunningMock.mockResolvedValue({
    ok: true,
    running: true,
    stdout: '{"ok":true}',
    stderr: '',
    code: 0,
    stateCode: 'healthy',
    summary: 'Gateway 已确认可用',
    safeToRetry: true,
    attemptedCommands: [['health', '--json']],
  })
  issueDesiredRuntimeRevisionMock.mockResolvedValue({
    runtime: {
      desiredRevision: 1,
      lastActions: [],
    },
  })
  markRuntimeRevisionInProgressMock.mockResolvedValue(undefined)
  confirmRuntimeReconcileMock.mockResolvedValue(undefined)
  resolveGatewayBlockingReasonFromStateMock.mockImplementation(() => 'none')
})

afterEach(() => {
  resolveMainAuthStorePathMock.mockReset()
  upsertApiKeyAuthProfileMock.mockReset()
  ensureGatewayRunningMock.mockReset()
  confirmRuntimeReconcileMock.mockReset()
  issueDesiredRuntimeRevisionMock.mockReset()
  markRuntimeRevisionInProgressMock.mockReset()
  resolveGatewayBlockingReasonFromStateMock.mockReset()
  resetAuthLockForTests()
})

describe('runAuthAction', () => {
  it('runs login using the exact official descriptor from the registry', async () => {
    const runCommand = vi.fn(async () => ok('logged in'))
    const action: AuthAction = {
      kind: 'login',
      providerId: 'openai',
      methodId: 'openai-codex',
      setDefault: true,
    }

    const result = await runAuthAction(action, {
      runCommand,
      loadAuthRegistry: async () => createRegistry(),
    })

    expect(runCommand).toHaveBeenCalledWith(
      ['models', 'auth', 'login', '--provider', 'openai-codex', '--set-default'],
      expect.any(Number)
    )
    expect(result.ok).toBe(true)
    expect(result.fallbackUsed).toBe(false)
    expect(result.attemptedCommands).toHaveLength(1)
  })

  it('prefers recovered capability registry descriptors when raw auth metadata is unavailable', async () => {
    const runCommand = vi.fn(async () => ok('logged in'))
    const loadAuthRegistry = vi.fn(async () =>
      createOpenClawAuthRegistry({
        ok: false,
        source: 'unsupported-openclaw-layout',
        message: 'unsupported layout',
      })
    )
    const recoveredRegistry = createOpenClawAuthRegistry({
      ok: false,
      source: 'unsupported-openclaw-layout',
      message: 'recovered from onboard help',
      providers: [
        {
          id: 'openai',
          label: 'OpenAI',
          methods: [
            {
              authChoice: 'openai-codex',
              label: 'OpenAI Codex OAuth',
              kind: 'oauth',
              route: {
                kind: 'models-auth-login',
                providerId: 'openai-codex',
                requiresBrowser: true,
              },
            },
          ],
        },
      ],
    })

    const result = await runAuthAction(
      {
        kind: 'login',
        providerId: 'openai',
        methodId: 'openai-codex',
        setDefault: true,
      },
      {
        runCommand,
        capabilities: createCapabilities(recoveredRegistry),
        loadAuthRegistry,
      }
    )

    expect(loadAuthRegistry).not.toHaveBeenCalled()
    expect(runCommand).toHaveBeenCalledWith(
      ['models', 'auth', 'login', '--provider', 'openai-codex', '--set-default'],
      expect.any(Number)
    )
    expect(result.ok).toBe(true)
  })

  it('runs api key methods through onboard using the official cli flag', async () => {
    const runCommand = vi.fn(async () => ok('configured'))
    const action: AuthAction = {
      kind: 'login',
      providerId: 'openai',
      methodId: 'openai-api-key',
      secret: 'sk-live-123',
    }

    const result = await runAuthAction(action, {
      runCommand,
      loadAuthRegistry: async () => createRegistry(),
    })

    expect(runCommand).toHaveBeenCalledWith(
      [
        'onboard',
        '--non-interactive',
        '--auth-choice',
        'openai-api-key',
        '--openai-api-key',
        'sk-live-123',
        '--accept-risk',
        '--no-install-daemon',
        '--skip-channels',
        '--skip-skills',
        '--skip-ui',
      ],
      expect.any(Number)
    )
    expect(result.ok).toBe(true)
  })

  it('runs api key onboarding through the env-pinned official onboard flow', async () => {
    resolveMainAuthStorePathMock.mockResolvedValue(
      '/tmp/openclaw/profiles/team-a/agents/main/agent/auth-profiles.json'
    )
    const runCommand = vi.fn(async () => ok('configured'))
    const runCommandWithEnv = vi.fn(async () => ok('configured'))
    const action: AuthAction = {
      kind: 'login',
      providerId: 'openai',
      methodId: 'openai-api-key',
      secret: 'sk-live-123',
    }

    const result = await runAuthAction(action, {
      runCommand,
      runCommandWithEnv,
      loadAuthRegistry: async () => createRegistry(),
    })

    expect(runCommandWithEnv).toHaveBeenCalledWith(
      [
        'onboard',
        '--non-interactive',
        '--auth-choice',
        'openai-api-key',
        '--openai-api-key',
        'sk-live-123',
        '--accept-risk',
        '--no-install-daemon',
        '--skip-channels',
        '--skip-skills',
        '--skip-ui',
      ],
      expect.any(Number),
      {
        OPENCLAW_AGENT_DIR: '/tmp/openclaw/profiles/team-a/agents/main/agent',
        PI_CODING_AGENT_DIR: '/tmp/openclaw/profiles/team-a/agents/main/agent',
      }
    )
    expect(runCommand).not.toHaveBeenCalled()
    expect(result.ok).toBe(true)
  })

  it('passes custom provider config through login actions to onboard execution', async () => {
    const runCommand = vi.fn(async () => ok('configured'))
    const readConfig = vi
      .fn()
      .mockResolvedValueOnce({
        gateway: {
          auth: {
            token: 'same-token',
          },
        },
      })
      .mockResolvedValueOnce({
        gateway: {
          auth: {
            token: 'same-token',
          },
        },
        models: {
          providers: {},
        },
      })
      .mockResolvedValueOnce({
        gateway: {
          auth: {
            token: 'same-token',
          },
        },
        models: {
          providers: {
            'acme-gateway': {
              baseUrl: 'https://gateway.example.com/v1',
              models: [{ id: 'acme-chat' }],
            },
          },
        },
      })
    const action: AuthAction = {
      kind: 'login',
      providerId: 'custom',
      methodId: 'custom-api-key',
      secret: 'sk-custom-123',
      customConfig: {
        baseUrl: 'https://gateway.example.com/v1',
        modelId: 'acme-chat',
        providerId: 'acme-gateway',
        compatibility: 'anthropic',
      },
    }

    const result = await runAuthAction(action, {
      runCommand,
      readConfig,
      loadAuthRegistry: async () => createRegistry(),
    })

    expect(runCommand).toHaveBeenCalledWith(
      [
        'onboard',
        '--non-interactive',
        '--auth-choice',
        'custom-api-key',
        '--custom-base-url',
        'https://gateway.example.com/v1',
        '--custom-model-id',
        'acme-chat',
        '--custom-provider-id',
        'acme-gateway',
        '--custom-compatibility',
        'anthropic',
        '--custom-api-key',
        'sk-custom-123',
        '--accept-risk',
        '--no-install-daemon',
        '--skip-channels',
        '--skip-skills',
        '--skip-ui',
      ],
      expect.any(Number)
    )
    expect(result.ok).toBe(true)
  })

  it('passes through optional postAuthRuntime fields from executeAuthRoute results', async () => {
    const runCommand = vi.fn(async (...args: any[]) => {
      const command = args[0] as string[]
      if (command[0] === 'onboard') {
        return ok('configured')
      }
      if (command[0] === 'secrets') {
        return ok('Secrets reloaded')
      }
      return ok('')
    })
    const readConfig = vi
      .fn()
      .mockResolvedValueOnce({
        gateway: {
          auth: {
            token: 'old-token',
          },
        },
      })
      .mockResolvedValueOnce({
        gateway: {
          auth: {
            token: 'new-token',
          },
        },
      })
    const action: AuthAction = {
      kind: 'login',
      providerId: 'openai',
      methodId: 'openai-api-key',
      secret: 'sk-live-123',
    }

    const result = await runAuthAction(action, {
      runCommand,
      readConfig,
      loadAuthRegistry: async () => createRegistry(),
    })

    expect(result.ok).toBe(true)
    expect(result.postAuthRuntime).toEqual({
      tokenRotated: true,
      gatewayApplyAction: 'hot-reload',
      gatewayConfirmed: true,
      recoveryReason: 'gateway-token-rotated',
      recommendedVerificationProfile: 'post-auth-recovery',
    })
  })

  it('requires a selected extra option for multimethod provider descriptors', async () => {
    const runCommand = vi.fn(async () => ok('ok'))
    const action: AuthAction = {
      kind: 'login',
      providerId: 'minimax',
      methodId: 'minimax-portal',
    }

    const result = await runAuthAction(action, {
      runCommand,
      loadAuthRegistry: async () => createRegistry(),
    })

    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('invalid_input')
    expect(result.message || '').toContain('requires selecting one of')
    expect(runCommand).not.toHaveBeenCalled()
  })

  it('fails closed for unsupported registry routes', async () => {
    const runCommand = vi.fn(async () => ok('ok'))
    const action: AuthAction = {
      kind: 'login',
      providerId: 'unsupported-provider',
      methodId: 'unsupported-auth',
    }

    const result = await runAuthAction(action, {
      runCommand,
      loadAuthRegistry: async () => createRegistry(),
    })

    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('command_failed')
    expect(result.message || '').toContain('unsupported')
    expect(runCommand).not.toHaveBeenCalled()
  })

  it('supports auth helper and github-copilot login actions', async () => {
    const runCommand = vi.fn(async () => ok('ok'))
    const addAction: AuthAction = {
      kind: 'auth-add',
    }
    const copilotAction: AuthAction = {
      kind: 'login-github-copilot',
      profileId: 'github-copilot:github',
      yes: true,
    }

    const addResult = await runAuthAction(addAction, { runCommand })
    const copilotResult = await runAuthAction(copilotAction, { runCommand })

    expect(runCommand).toHaveBeenNthCalledWith(1, ['models', 'auth', 'add'], expect.any(Number))
    expect(runCommand).toHaveBeenNthCalledWith(
      2,
      ['models', 'auth', 'login-github-copilot', '--profile-id', 'github-copilot:github', '--yes'],
      expect.any(Number)
    )
    expect(addResult.ok).toBe(true)
    expect(copilotResult.ok).toBe(true)
  })

  it('supports auth order get/set/clear actions', async () => {
    const runCommand = vi.fn(async () => ok('ok'))
    const getAction: AuthAction = {
      kind: 'auth-order-get',
      providerId: 'openai',
      agentId: 'main',
      json: true,
    }
    const setAction: AuthAction = {
      kind: 'auth-order-set',
      providerId: 'openai',
      agentId: 'main',
      profileIds: ['openai:default', 'openai:backup'],
    }
    const clearAction: AuthAction = {
      kind: 'auth-order-clear',
      providerId: 'openai',
      agentId: 'main',
    }

    const getResult = await runAuthAction(getAction, { runCommand })
    const setResult = await runAuthAction(setAction, { runCommand })
    const clearResult = await runAuthAction(clearAction, { runCommand })

    expect(runCommand).toHaveBeenNthCalledWith(
      1,
      ['models', 'auth', 'order', 'get', '--provider', 'openai', '--agent', 'main', '--json'],
      expect.any(Number)
    )
    expect(runCommand).toHaveBeenNthCalledWith(
      2,
      ['models', 'auth', 'order', 'set', '--provider', 'openai', '--agent', 'main', 'openai:default', 'openai:backup'],
      expect.any(Number)
    )
    expect(runCommand).toHaveBeenNthCalledWith(
      3,
      ['models', 'auth', 'order', 'clear', '--provider', 'openai', '--agent', 'main'],
      expect.any(Number)
    )
    expect(getResult.ok).toBe(true)
    expect(setResult.ok).toBe(true)
    expect(clearResult.ok).toBe(true)
  })

  it('returns auth_busy when another auth flow is running', async () => {
    const gate = deferred<CliCommandResult>()
    const runCommand = vi.fn(async () => gate.promise)
    const action: AuthAction = {
      kind: 'login',
      providerId: 'openai',
      methodId: 'openai-codex',
    }

    const first = runAuthAction(action, {
      runCommand,
      loadAuthRegistry: async () => createRegistry(),
    })
    const second = await runAuthAction(action, {
      runCommand,
      loadAuthRegistry: async () => createRegistry(),
    })

    expect(second.ok).toBe(false)
    expect(second.errorCode).toBe('auth_busy')

    gate.resolve(ok('done'))
    const firstResult = await first
    expect(firstResult.ok).toBe(true)
  })

  it('returns invalid_input for empty provider/method', async () => {
    const runCommand = vi.fn(async () => ok('ok'))
    const action: AuthAction = {
      kind: 'login',
      providerId: '  ',
      methodId: '',
    }

    const result = await runAuthAction(action, { runCommand })
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('invalid_input')
    expect(runCommand).not.toHaveBeenCalled()
  })

  it('returns invalid_input for auth-order-set when profileIds are missing', async () => {
    const runCommand = vi.fn(async () => ok('ok'))
    const action: AuthAction = {
      kind: 'auth-order-set',
      providerId: 'openai',
      profileIds: [],
    }

    const result = await runAuthAction(action, { runCommand })
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('invalid_input')
    expect(runCommand).not.toHaveBeenCalled()
  })
})

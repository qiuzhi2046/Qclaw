import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenClawAuthMethodDescriptor } from '../openclaw-auth-registry'
import { executeAuthRoute } from '../openclaw-auth-executor'
import { createOpenClawAuthRegistry } from '../openclaw-auth-registry'

const {
  confirmRuntimeReconcileMock,
  issueDesiredRuntimeRevisionMock,
  markRuntimeRevisionInProgressMock,
  repairAgentAuthProfilesFromOtherAgentStoresMock,
  resolveGatewayBlockingReasonFromStateMock,
  resolveMainAuthStorePathMock,
  resolveLocalAuthStorePathMock,
  upsertApiKeyAuthProfileMock,
  callGatewayRpcViaControlUiBrowserMock,
  cliReadConfigMock,
  readEnvFileMock,
} = vi.hoisted(() => ({
  confirmRuntimeReconcileMock: vi.fn(),
  issueDesiredRuntimeRevisionMock: vi.fn(),
  markRuntimeRevisionInProgressMock: vi.fn(),
  repairAgentAuthProfilesFromOtherAgentStoresMock: vi.fn(),
  resolveGatewayBlockingReasonFromStateMock: vi.fn(({ gatewayStateCode }: { gatewayStateCode?: string }) => {
    if (gatewayStateCode === 'token_mismatch') return 'runtime_token_stale'
    if (gatewayStateCode === 'auth_missing') return 'machine_local_auth_missing'
    if (gatewayStateCode === 'plugin_load_failure') return 'provider_plugin_not_ready'
    if (
      gatewayStateCode === 'service_missing' ||
      gatewayStateCode === 'service_install_failed' ||
      gatewayStateCode === 'service_loaded_but_stale' ||
      gatewayStateCode === 'gateway_not_running'
    ) {
      return 'service_generation_stale'
    }
    return 'none'
  }),
  resolveMainAuthStorePathMock: vi.fn(),
  resolveLocalAuthStorePathMock: vi.fn(),
  upsertApiKeyAuthProfileMock: vi.fn(),
  callGatewayRpcViaControlUiBrowserMock: vi.fn(),
  cliReadConfigMock: vi.fn(),
  readEnvFileMock: vi.fn(),
}))

vi.mock('../openclaw-runtime-reconcile', () => ({
  confirmRuntimeReconcile: confirmRuntimeReconcileMock,
  issueDesiredRuntimeRevision: issueDesiredRuntimeRevisionMock,
  markRuntimeRevisionInProgress: markRuntimeRevisionInProgressMock,
  resolveGatewayBlockingReasonFromState: resolveGatewayBlockingReasonFromStateMock,
}))

vi.mock('../local-model-probe', () => ({
  repairAgentAuthProfilesFromOtherAgentStores: repairAgentAuthProfilesFromOtherAgentStoresMock,
  resolveMainAuthStorePath: resolveMainAuthStorePathMock,
  resolveLocalAuthStorePath: resolveLocalAuthStorePathMock,
  upsertApiKeyAuthProfile: upsertApiKeyAuthProfileMock,
}))

vi.mock('../openclaw-control-ui-rpc', () => ({
  callGatewayRpcViaControlUiBrowser: callGatewayRpcViaControlUiBrowserMock,
}))

vi.mock('../cli', () => ({
  readConfig: cliReadConfigMock,
  readEnvFile: readEnvFileMock,
}))

const qwenMethod: OpenClawAuthMethodDescriptor = {
  authChoice: 'qwen-portal',
  label: 'OAuth · qwen-portal',
  kind: 'oauth',
  route: {
    kind: 'models-auth-login',
    providerId: 'qwen-portal',
    methodId: 'device',
    pluginId: 'qwen-portal-auth',
    requiresBrowser: true,
  },
}

const openaiApiKeyMethod: OpenClawAuthMethodDescriptor = {
  authChoice: 'openai-api-key',
  label: 'API Key · openai-api-key',
  kind: 'apiKey',
  route: {
    kind: 'onboard',
    cliFlag: '--openai-api-key',
    requiresSecret: true,
  },
}

const customProviderMethod = {
  authChoice: 'custom-api-key',
  label: 'Custom Provider',
  kind: 'custom',
  route: {
    kind: 'onboard-custom',
    providerId: 'custom',
  },
} as any as OpenClawAuthMethodDescriptor

const minimaxMethod: OpenClawAuthMethodDescriptor = {
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
}

const openaiCodexMethod: OpenClawAuthMethodDescriptor = {
  authChoice: 'openai-codex',
  label: 'OAuth · openai-codex',
  kind: 'oauth',
  route: {
    kind: 'models-auth-login',
    providerId: 'openai-codex',
    requiresBrowser: true,
  },
}

const STALE_MINIMAX_PLUGIN_WARNING =
  'Config warnings:\n- plugins.allow: plugin not found: minimax-portal-auth (stale config entry ignored; remove it from plugins config)'

const unsupportedMethod: OpenClawAuthMethodDescriptor = {
  authChoice: 'unsupported-auth',
  label: 'Unsupported',
  kind: 'unknown',
  route: {
    kind: 'unsupported',
  },
}

describe('executeAuthRoute', () => {
  beforeEach(() => {
    confirmRuntimeReconcileMock.mockReset()
    issueDesiredRuntimeRevisionMock.mockReset()
    markRuntimeRevisionInProgressMock.mockReset()
    repairAgentAuthProfilesFromOtherAgentStoresMock.mockReset()
    resolveGatewayBlockingReasonFromStateMock.mockClear()
    resolveMainAuthStorePathMock.mockReset()
    resolveLocalAuthStorePathMock.mockReset()
    upsertApiKeyAuthProfileMock.mockReset()
    callGatewayRpcViaControlUiBrowserMock.mockReset()
    cliReadConfigMock.mockReset()
    readEnvFileMock.mockReset()

    // By default, RPC rejects so the fast path falls through to CLI in existing tests
    callGatewayRpcViaControlUiBrowserMock.mockRejectedValue(new Error('no gateway'))

    confirmRuntimeReconcileMock.mockResolvedValue({
      runtime: {
        desiredRevision: 1,
      },
    })
    issueDesiredRuntimeRevisionMock.mockResolvedValue({
      runtime: {
        desiredRevision: 1,
        lastActions: [],
      },
    })
    markRuntimeRevisionInProgressMock.mockResolvedValue({
      runtime: {
        desiredRevision: 1,
      },
    })
    resolveMainAuthStorePathMock.mockResolvedValue(
      '/tmp/openclaw/profiles/team-a/agents/main/agent/auth-profiles.json'
    )
    resolveLocalAuthStorePathMock.mockResolvedValue(
      '/tmp/openclaw/profiles/team-a/agents/feishu-default/agent/auth-profiles.json'
    )
    upsertApiKeyAuthProfileMock.mockResolvedValue({
      ok: true,
      created: true,
      updated: false,
      profileId: 'openai:default',
      authStorePath: '/tmp/openclaw/profiles/team-a/agents/main/agent/auth-profiles.json',
    })
    repairAgentAuthProfilesFromOtherAgentStoresMock.mockResolvedValue({
      ok: true,
      repaired: false,
      updatedAuthStorePaths: [],
      importedProfileIds: [],
      importedProviders: [],
      sourceAuthStorePaths: [],
    })
  })

  it('enables plugin and executes registry-provided models auth login route', async () => {
    const emitted: Array<{ channel: string; payload: Record<string, any> }> = []
    const runCommand = vi.fn(async () => ({ ok: true, stdout: 'enabled', stderr: '', code: 0 }))
    const runStreamingCommand = vi.fn(async (_args: string[], options?: Record<string, any>) => {
      options?.onStdout?.('Open: https://chat.qwen.ai/authorize?user_code=BF0Q6UX9&client=qwen-code')
      return { ok: true, stdout: 'done', stderr: '', code: 0 }
    })

    const result = await executeAuthRoute(
      {
        method: qwenMethod,
        providerId: 'qwen',
        methodId: 'qwen-portal',
        emit: (channel, payload) => emitted.push({ channel, payload }),
      },
      { runCommand, runStreamingCommand }
    )

    expect(runCommand).toHaveBeenNthCalledWith(
      1,
      ['plugins', 'enable', 'qwen-portal-auth'],
      expect.any(Number)
    )
    expect(runStreamingCommand).toHaveBeenNthCalledWith(
      1,
      ['models', 'auth', 'login', '--provider', 'qwen-portal', '--method', 'device'],
      expect.objectContaining({ onStdout: expect.any(Function) })
    )
    expect(result.ok).toBe(true)
    expect(result.attemptedCommands).toEqual([
      ['plugins', 'enable', 'qwen-portal-auth'],
      ['models', 'auth', 'login', '--provider', 'qwen-portal', '--method', 'device'],
    ])
    expect(emitted.find((entry) => entry.channel === 'oauth:code')?.payload.verificationUri).toBe(
      'https://chat.qwen.ai/authorize?user_code=BF0Q6UX9&client=qwen-code'
    )
  })

  it('repairs the minimax-portal provider config after oauth login writes an incomplete provider block', async () => {
    const runCommand = vi.fn(async () => ({ ok: true, stdout: 'enabled', stderr: '', code: 0 }))
    const runStreamingCommand = vi.fn(async (_args: string[], options?: Record<string, any>) => {
      options?.onStdout?.('Open: https://api.minimax.io/oauth/authorize')
      return { ok: true, stdout: 'done', stderr: '', code: 0 }
    })
    const readConfig = vi.fn(async () => ({
      models: {
        providers: {
          'minimax-portal': {
            baseUrl: 'https://api.minimax.io/anthropic',
            models: [],
          },
        },
      },
    }))
    const writeConfig = vi.fn(async () => undefined)

    const result = await executeAuthRoute(
      {
        method: minimaxMethod,
        providerId: 'minimax',
        methodId: 'minimax-portal',
        selectedExtraOption: 'oauth',
      },
      { runCommand, runStreamingCommand, readConfig, writeConfig } as any
    )

    expect(result.ok).toBe(true)
    expect(writeConfig).toHaveBeenCalledWith({
      models: {
        providers: {
          'minimax-portal': {
            baseUrl: 'https://api.minimax.io/anthropic',
            models: [],
            api: 'anthropic-messages',
          },
        },
      },
    })
    expect(runCommand).toHaveBeenNthCalledWith(
      1,
      ['plugins', 'enable', 'minimax-portal-auth'],
      expect.any(Number)
    )
    expect(runStreamingCommand).toHaveBeenNthCalledWith(
      1,
      ['models', 'auth', 'login', '--provider', 'minimax-portal', '--method', 'oauth'],
      expect.objectContaining({ onStdout: expect.any(Function) })
    )
  })

  it('fans out minimax oauth auth after models auth login succeeds', async () => {
    const runCommand = vi.fn(async () => ({ ok: true, stdout: 'enabled', stderr: '', code: 0 }))
    const runStreamingCommand = vi.fn(async (_args: string[], options?: Record<string, any>) => {
      options?.onStdout?.('Open: https://api.minimax.io/oauth/authorize')
      return { ok: true, stdout: 'done', stderr: '', code: 0 }
    })
    const readConfig = vi.fn(async () => ({
      models: {
        providers: {
          'minimax-portal': {
            baseUrl: 'https://api.minimax.io/anthropic',
            models: [],
            api: 'anthropic-messages',
          },
        },
      },
    }))

    const result = await executeAuthRoute(
      {
        method: minimaxMethod,
        providerId: 'minimax',
        methodId: 'minimax-portal',
        selectedExtraOption: 'oauth',
      },
      { runCommand, runStreamingCommand, readConfig, writeConfig: vi.fn(async () => undefined) } as any
    )

    expect(result.ok).toBe(true)
    expect(repairAgentAuthProfilesFromOtherAgentStoresMock).toHaveBeenCalledWith({
      providerIds: ['minimax-portal'],
    })
  })

  it('restarts the gateway and retries plugin-backed login when the provider is not yet loaded', async () => {
    const emitted: Array<{ channel: string; payload: Record<string, any> }> = []
    const runCommand = vi.fn(async (args: string[]) => {
      if (args[0] === 'plugins') {
        return {
          ok: true,
          stdout: 'Enabled plugin "qwen-portal-auth". Restart the gateway to apply.',
          stderr: '',
          code: 0,
        }
      }
      if (args[0] === 'gateway') {
        return { ok: true, stdout: 'Gateway restarted', stderr: '', code: 0 }
      }
      return { ok: true, stdout: '', stderr: '', code: 0 }
    })
    const runStreamingCommand = vi
      .fn()
      .mockImplementationOnce(async () => ({
        ok: false,
        stdout: '',
        stderr: 'Error: Unknown provider "qwen-portal". Loaded providers: ollama, vllm.',
        code: 1,
      }))
      .mockImplementationOnce(async (_args: string[], options?: Record<string, any>) => {
        options?.onStdout?.('Open: https://chat.qwen.ai/authorize?user_code=BF0Q6UX9&client=qwen-code')
        return { ok: true, stdout: 'done', stderr: '', code: 0 }
      })

    const result = await executeAuthRoute(
      {
        method: qwenMethod,
        providerId: 'qwen',
        methodId: 'qwen-portal',
        emit: (channel, payload) => emitted.push({ channel, payload }),
      },
      { runCommand, runStreamingCommand }
    )

    expect(runCommand).toHaveBeenNthCalledWith(
      1,
      ['plugins', 'enable', 'qwen-portal-auth'],
      expect.any(Number)
    )
    expect(runCommand).toHaveBeenNthCalledWith(2, ['gateway', 'restart'], expect.any(Number))
    expect(runStreamingCommand).toHaveBeenNthCalledWith(
      1,
      ['models', 'auth', 'login', '--provider', 'qwen-portal', '--method', 'device'],
      expect.objectContaining({ onStdout: expect.any(Function) })
    )
    expect(runStreamingCommand).toHaveBeenNthCalledWith(
      2,
      ['models', 'auth', 'login', '--provider', 'qwen-portal', '--method', 'device'],
      expect.objectContaining({ onStdout: expect.any(Function) })
    )
    expect(result.ok).toBe(true)
    expect(result.attemptedCommands).toEqual([
      ['plugins', 'enable', 'qwen-portal-auth'],
      ['models', 'auth', 'login', '--provider', 'qwen-portal', '--method', 'device'],
      ['gateway', 'restart'],
      ['models', 'auth', 'login', '--provider', 'qwen-portal', '--method', 'device'],
    ])
    expect(emitted.find((entry) => entry.channel === 'oauth:code')?.payload.verificationUri).toBe(
      'https://chat.qwen.ai/authorize?user_code=BF0Q6UX9&client=qwen-code'
    )
  })

  it('returns a clearer error when gateway restart fails after a stale provider error', async () => {
    const runCommand = vi.fn(async (args: string[]) => {
      if (args[0] === 'plugins') {
        return {
          ok: true,
          stdout: 'Enabled plugin "qwen-portal-auth". Restart the gateway to apply.',
          stderr: '',
          code: 0,
        }
      }
      if (args[0] === 'gateway') {
        return {
          ok: false,
          stdout: '',
          stderr: 'launchctl kickstart failed: Operation not permitted',
          code: 1,
        }
      }
      return { ok: true, stdout: '', stderr: '', code: 0 }
    })
    const runStreamingCommand = vi.fn(async () => ({
      ok: false,
      stdout: '',
      stderr: 'Error: Unknown provider "qwen-portal". Loaded providers: ollama, vllm.',
      code: 1,
    }))

    const result = await executeAuthRoute(
      { method: qwenMethod, providerId: 'qwen', methodId: 'qwen-portal' },
      { runCommand, runStreamingCommand }
    )

    expect(result.ok).toBe(false)
    expect(result.message).toContain('自动重启网关')
    expect(result.message).toContain('Unknown provider "qwen-portal"')
    expect(result.message).toContain('配置写入失败，请检查本机权限后重试。')
    expect(runStreamingCommand).toHaveBeenCalledTimes(1)
    expect(result.attemptedCommands).toEqual([
      ['plugins', 'enable', 'qwen-portal-auth'],
      ['models', 'auth', 'login', '--provider', 'qwen-portal', '--method', 'device'],
      ['gateway', 'restart'],
    ])
  })

  it('executes onboard api key routes with the official cli flag and secret', async () => {
    const runCommand = vi.fn(async () => ({ ok: true, stdout: 'configured', stderr: '', code: 0 }))

    const result = await executeAuthRoute(
      {
        method: openaiApiKeyMethod,
        providerId: 'openai',
        methodId: 'openai-api-key',
        secret: 'sk-live-123',
      },
      { runCommand }
    )

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

  it('pins onboard api key routes to the main agent auth store when env injection is available', async () => {
    const runCommand = vi.fn(async () => ({ ok: true, stdout: 'configured', stderr: '', code: 0 }))
    const runCommandWithEnv = vi.fn(async () => ({
      ok: true,
      stdout: 'configured',
      stderr: '',
      code: 0,
    }))
    const readConfig = vi.fn().mockResolvedValue({
      gateway: {
        auth: {
          token: 'same-token',
        },
      },
    })

    const result = await executeAuthRoute(
      {
        method: openaiApiKeyMethod,
        providerId: 'openai',
        methodId: 'openai-api-key',
        secret: 'sk-live-123',
      },
      { runCommand, runCommandWithEnv, readConfig } as any
    )

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

  it('pins plugin-backed oauth login routes to the main agent auth store when env injection is available', async () => {
    const runCommand = vi.fn(async () => ({ ok: true, stdout: 'enabled', stderr: '', code: 0 }))
    const runStreamingCommand = vi.fn(async () => ({ ok: true, stdout: 'done', stderr: '', code: 0 }))
    const readConfig = vi.fn().mockResolvedValue({
      gateway: {
        auth: {
          token: 'same-token',
        },
      },
    })

    const result = await executeAuthRoute(
      {
        method: qwenMethod,
        providerId: 'qwen',
        methodId: 'qwen-portal',
      },
      { runCommand, runStreamingCommand, readConfig } as any
    )

    expect(runCommand).toHaveBeenNthCalledWith(
      1,
      ['plugins', 'enable', 'qwen-portal-auth'],
      expect.any(Number)
    )
    expect(runStreamingCommand).toHaveBeenCalledWith(
      ['models', 'auth', 'login', '--provider', 'qwen-portal', '--method', 'device'],
      expect.objectContaining({
        timeout: expect.any(Number),
        controlDomain: 'oauth',
        env: {
          OPENCLAW_AGENT_DIR: '/tmp/openclaw/profiles/team-a/agents/main/agent',
          PI_CODING_AGENT_DIR: '/tmp/openclaw/profiles/team-a/agents/main/agent',
        },
      })
    )
    expect(result.ok).toBe(true)
  })

  it('syncs the main agent auth profile after onboard api key auth succeeds', async () => {
    const runCommand = vi.fn(async () => ({ ok: true, stdout: 'configured', stderr: '', code: 0 }))
    const readConfig = vi.fn().mockResolvedValue({
      gateway: {
        auth: {
          token: 'same-token',
        },
      },
    })

    const result = await executeAuthRoute(
      {
        method: openaiApiKeyMethod,
        providerId: 'openai',
        methodId: 'openai-api-key',
        secret: 'sk-live-123',
      },
      { runCommand, readConfig } as any
    )

    expect(upsertApiKeyAuthProfileMock).toHaveBeenCalledWith({
      provider: 'openai',
      apiKey: 'sk-live-123',
    })
    expect(result.ok).toBe(true)
  })

  it('temporarily makes main the default agent for onboard auth flows and restores the original agent order', async () => {
    const runCommand = vi.fn(async () => ({ ok: true, stdout: 'configured', stderr: '', code: 0 }))
    const writeConfig = vi.fn(async () => {})
    const configBeforeAuth = {
      agents: {
        list: [
          { id: 'feishu-bot', model: 'minimax/MiniMax-M2.1' },
          { id: 'main', model: 'minimax/MiniMax-M2.5' },
        ],
      },
      gateway: {
        auth: {
          token: 'same-token',
        },
      },
    }
    const configAfterAuth = {
      agents: {
        list: [
          { id: 'feishu-bot', model: 'minimax/MiniMax-M2.1' },
          { id: 'main', model: 'minimax/MiniMax-M2.5', default: true },
        ],
      },
      gateway: {
        auth: {
          token: 'same-token',
        },
      },
      wizard: {
        command: 'onboard',
      },
    }
    const readConfig = vi
      .fn()
      .mockResolvedValueOnce(configBeforeAuth)
      .mockResolvedValueOnce(configAfterAuth)
      .mockResolvedValueOnce(configAfterAuth)

    const result = await executeAuthRoute(
      {
        method: openaiApiKeyMethod,
        providerId: 'openai',
        methodId: 'openai-api-key',
        secret: 'sk-live-123',
      },
      { runCommand, readConfig, writeConfig } as any
    )

    expect(writeConfig).toHaveBeenNthCalledWith(1, {
      agents: {
        list: [
          { id: 'feishu-bot', model: 'minimax/MiniMax-M2.1' },
          { id: 'main', model: 'minimax/MiniMax-M2.5', default: true },
        ],
      },
      gateway: {
        auth: {
          token: 'same-token',
        },
      },
    })
    expect(writeConfig).toHaveBeenNthCalledWith(2, {
      agents: {
        list: [
          { id: 'feishu-bot', model: 'minimax/MiniMax-M2.1' },
          { id: 'main', model: 'minimax/MiniMax-M2.5' },
        ],
      },
      gateway: {
        auth: {
          token: 'same-token',
        },
      },
      wizard: {
        command: 'onboard',
      },
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

  it('temporarily makes main the default agent for oauth login flows and restores the original agent order', async () => {
    const runCommand = vi.fn(async () => ({ ok: true, stdout: 'enabled', stderr: '', code: 0 }))
    const runStreamingCommand = vi.fn(async () => ({ ok: true, stdout: 'done', stderr: '', code: 0 }))
    const writeConfig = vi.fn(async () => {})
    const configBeforeAuth = {
      agents: {
        list: [
          { id: 'feishu-bot', model: 'minimax/MiniMax-M2.1' },
          { id: 'main', model: 'minimax/MiniMax-M2.5' },
        ],
      },
      gateway: {
        auth: {
          token: 'same-token',
        },
      },
    }
    const configAfterAuth = {
      agents: {
        list: [
          { id: 'feishu-bot', model: 'minimax/MiniMax-M2.1' },
          { id: 'main', model: 'minimax/MiniMax-M2.5', default: true },
        ],
      },
      gateway: {
        auth: {
          token: 'same-token',
        },
      },
      wizard: {
        command: 'models-auth-login',
      },
    }
    const readConfig = vi
      .fn()
      .mockResolvedValueOnce(configBeforeAuth)
      .mockResolvedValueOnce(configAfterAuth)
      .mockResolvedValueOnce(configAfterAuth)

    const result = await executeAuthRoute(
      {
        method: qwenMethod,
        providerId: 'qwen',
        methodId: 'qwen-portal',
      },
      { runCommand, runStreamingCommand, readConfig, writeConfig } as any
    )

    expect(writeConfig).toHaveBeenNthCalledWith(1, {
      agents: {
        list: [
          { id: 'feishu-bot', model: 'minimax/MiniMax-M2.1' },
          { id: 'main', model: 'minimax/MiniMax-M2.5', default: true },
        ],
      },
      gateway: {
        auth: {
          token: 'same-token',
        },
      },
    })
    expect(writeConfig).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        agents: configBeforeAuth.agents,
        gateway: configBeforeAuth.gateway,
        wizard: {
          command: 'models-auth-login',
        },
      })
    )
    expect(result.ok).toBe(true)
  })

  it('repairs invalid upgraded config and retries browser oauth login before surfacing an auth failure', async () => {
    const runStreamingCommand = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        stdout: '',
        stderr: [
          'Config invalid',
          'Problem:',
          '  - channels.openclaw-weixin: unknown channel id: openclaw-weixin',
          'Run: openclaw doctor --fix',
        ].join('\n'),
        code: 1,
      })
      .mockResolvedValueOnce({
        ok: true,
        stdout: 'done',
        stderr: '',
        code: 0,
      })
    const readConfig = vi.fn().mockResolvedValue({
      gateway: {
        auth: {
          token: 'same-token',
        },
      },
    })
    const ensureGatewayRunning = vi.fn().mockResolvedValue({
      ok: true,
      running: true,
      stdout: 'Gateway ready after config repair',
      stderr: '',
      code: 0,
      stateCode: 'healthy',
      summary: 'Gateway 已确认可用',
      safeToRetry: true,
      attemptedCommands: [
        ['doctor', '--fix', '--non-interactive'],
        ['health', '--json'],
      ],
    })

    const result = await executeAuthRoute(
      {
        method: openaiCodexMethod,
        providerId: 'openai',
        methodId: 'openai-codex',
      },
      { runStreamingCommand, readConfig, ensureGatewayRunning } as any
    )

    expect(runStreamingCommand).toHaveBeenCalledTimes(2)
    expect(runStreamingCommand).toHaveBeenNthCalledWith(
      1,
      ['models', 'auth', 'login', '--provider', 'openai-codex'],
      expect.objectContaining({ onStdout: expect.any(Function) })
    )
    expect(ensureGatewayRunning).toHaveBeenCalledTimes(1)
    expect(runStreamingCommand).toHaveBeenNthCalledWith(
      2,
      ['models', 'auth', 'login', '--provider', 'openai-codex'],
      expect.objectContaining({ onStdout: expect.any(Function) })
    )
    expect(result.ok).toBe(true)
    expect(result.attemptedCommands).toEqual([
      ['models', 'auth', 'login', '--provider', 'openai-codex'],
      ['doctor', '--fix', '--non-interactive'],
      ['health', '--json'],
      ['models', 'auth', 'login', '--provider', 'openai-codex'],
    ])
  })

  it('restarts the gateway after config repair when the retried login still reports an unloaded provider', async () => {
    const runCommand = vi.fn(async (args: string[]) => {
      if (args[0] === 'plugins') {
        return {
          ok: true,
          stdout: 'Enabled plugin "qwen-portal-auth". Restart the gateway to apply.',
          stderr: '',
          code: 0,
        }
      }
      if (args[0] === 'gateway') {
        return { ok: true, stdout: 'Gateway restarted', stderr: '', code: 0 }
      }
      return { ok: true, stdout: '', stderr: '', code: 0 }
    })
    const runStreamingCommand = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        stdout: '',
        stderr: [
          'Config invalid',
          'Problem:',
          '  - channels.openclaw-weixin: unknown channel id: openclaw-weixin',
          'Run: openclaw doctor --fix',
        ].join('\n'),
        code: 1,
      })
      .mockResolvedValueOnce({
        ok: false,
        stdout: '',
        stderr: 'Error: Unknown provider "qwen-portal". Loaded providers: ollama, vllm.',
        code: 1,
      })
      .mockResolvedValueOnce({
        ok: true,
        stdout: 'done',
        stderr: '',
        code: 0,
      })
    const readConfig = vi.fn().mockResolvedValue({
      gateway: {
        auth: {
          token: 'same-token',
        },
      },
    })
    const ensureGatewayRunning = vi.fn().mockResolvedValue({
      ok: true,
      running: true,
      stdout: 'Gateway ready after config repair',
      stderr: '',
      code: 0,
      stateCode: 'healthy',
      summary: 'Gateway 已确认可用',
      safeToRetry: true,
      attemptedCommands: [
        ['doctor', '--fix', '--non-interactive'],
        ['health', '--json'],
      ],
    })

    const result = await executeAuthRoute(
      {
        method: qwenMethod,
        providerId: 'qwen',
        methodId: 'qwen-portal',
      },
      { runCommand, runStreamingCommand, readConfig, ensureGatewayRunning } as any
    )

    expect(ensureGatewayRunning).toHaveBeenCalledTimes(1)
    expect(runCommand).toHaveBeenNthCalledWith(
      1,
      ['plugins', 'enable', 'qwen-portal-auth'],
      expect.any(Number)
    )
    expect(runCommand).toHaveBeenNthCalledWith(2, ['gateway', 'restart'], expect.any(Number))
    expect(runStreamingCommand).toHaveBeenCalledTimes(3)
    expect(result.ok).toBe(true)
    expect(result.attemptedCommands).toEqual([
      ['plugins', 'enable', 'qwen-portal-auth'],
      ['models', 'auth', 'login', '--provider', 'qwen-portal', '--method', 'device'],
      ['doctor', '--fix', '--non-interactive'],
      ['health', '--json'],
      ['models', 'auth', 'login', '--provider', 'qwen-portal', '--method', 'device'],
      ['gateway', 'restart'],
      ['models', 'auth', 'login', '--provider', 'qwen-portal', '--method', 'device'],
    ])
  })

  it('pins github-copilot oauth login routes to the main agent auth store when env injection is available', async () => {
    const githubCopilotMethod: OpenClawAuthMethodDescriptor = {
      authChoice: 'github-copilot',
      label: 'GitHub Copilot',
      kind: 'oauth',
      route: {
        kind: 'models-auth-login-github-copilot',
        providerId: 'github-copilot',
        requiresBrowser: true,
      },
    }
    const runStreamingCommand = vi.fn(async () => ({ ok: true, stdout: 'done', stderr: '', code: 0 }))
    const readConfig = vi.fn().mockResolvedValue({
      gateway: {
        auth: {
          token: 'same-token',
        },
      },
    })

    const result = await executeAuthRoute(
      {
        method: githubCopilotMethod,
        providerId: 'github-copilot',
        methodId: 'github-copilot',
      },
      { runStreamingCommand, readConfig } as any
    )

    expect(runStreamingCommand).toHaveBeenCalledWith(
      ['models', 'auth', 'login-github-copilot'],
      expect.objectContaining({
        timeout: expect.any(Number),
        controlDomain: 'oauth',
        env: {
          OPENCLAW_AGENT_DIR: '/tmp/openclaw/profiles/team-a/agents/main/agent',
          PI_CODING_AGENT_DIR: '/tmp/openclaw/profiles/team-a/agents/main/agent',
        },
      })
    )
    expect(result.ok).toBe(true)
  })

  it('restores trusted plugin config after onboard rewrites the plugin section', async () => {
    const runCommand = vi.fn(async () => ({ ok: true, stdout: 'configured', stderr: '', code: 0 }))
    const writeConfig = vi.fn(async () => {})
    const configBeforeAuth = {
      gateway: {
        auth: {
          token: 'same-token',
        },
      },
      plugins: {
        allow: ['minimax-portal-auth', 'openclaw-lark'],
        entries: {
          'minimax-portal-auth': { enabled: true },
          'openclaw-lark': { enabled: true },
        },
        installs: {
          'openclaw-lark': {
            spec: '@larksuite/openclaw-lark',
          },
        },
      },
    }
    const configAfterAuth = {
      gateway: {
        auth: {
          token: 'same-token',
        },
      },
      plugins: {
        allow: [],
      },
    }
    const readConfig = vi
      .fn()
      .mockResolvedValueOnce(configBeforeAuth)
      .mockResolvedValueOnce(configAfterAuth)

    const result = await executeAuthRoute(
      {
        method: openaiApiKeyMethod,
        providerId: 'openai',
        methodId: 'openai-api-key',
        secret: 'sk-live-123',
      },
      { runCommand, readConfig, writeConfig } as any
    )

    expect(writeConfig).toHaveBeenCalledWith({
      gateway: {
        auth: {
          token: 'same-token',
        },
      },
      plugins: {
        allow: ['minimax-portal-auth', 'openclaw-lark'],
        entries: {
          feishu: { enabled: false },
          'minimax-portal-auth': { enabled: true },
          'openclaw-lark': { enabled: true },
        },
        installs: {
          'openclaw-lark': {
            spec: '@larksuite/openclaw-lark',
          },
        },
      },
    })
    expect(result.ok).toBe(true)
  })

  it('does not restore stale plugin ids after onboard rewrites the plugin section when the command output marks them stale', async () => {
    const runCommand = vi.fn(async () => ({
      ok: true,
      stdout: 'configured',
      stderr: STALE_MINIMAX_PLUGIN_WARNING,
      code: 0,
    }))
    const writeConfig = vi.fn(async () => {})
    const pruneStalePluginEntries = vi.fn(async () => ({
      changed: true,
      removedPluginIds: ['minimax-portal-auth'],
    }))
    const configBeforeAuth = {
      gateway: {
        auth: {
          token: 'same-token',
        },
      },
      plugins: {
        allow: ['minimax-portal-auth', 'openclaw-lark'],
        entries: {
          'minimax-portal-auth': { enabled: true },
          'openclaw-lark': { enabled: true },
        },
        installs: {
          'minimax-portal-auth': {
            spec: '@openclaw/minimax-portal-auth',
          },
          'openclaw-lark': {
            spec: '@larksuite/openclaw-lark',
          },
        },
      },
    }
    const configAfterAuth = {
      gateway: {
        auth: {
          token: 'same-token',
        },
      },
      plugins: {
        allow: [],
      },
    }
    const readConfig = vi
      .fn()
      .mockResolvedValueOnce(configBeforeAuth)
      .mockResolvedValueOnce(configAfterAuth)

    const result = await executeAuthRoute(
      {
        method: openaiApiKeyMethod,
        providerId: 'openai',
        methodId: 'openai-api-key',
        secret: 'sk-live-123',
      },
      { runCommand, readConfig, writeConfig, pruneStalePluginEntries } as any
    )

    expect(pruneStalePluginEntries).toHaveBeenCalledWith(['minimax-portal-auth'])
    expect(writeConfig).toHaveBeenCalledWith({
      gateway: {
        auth: {
          token: 'same-token',
        },
      },
      plugins: {
        allow: ['openclaw-lark'],
        entries: {
          feishu: { enabled: false },
          'openclaw-lark': { enabled: true },
        },
        installs: {
          'openclaw-lark': {
            spec: '@larksuite/openclaw-lark',
          },
        },
      },
    })
    expect(result.ok).toBe(true)
  })

  it('keeps auth success when best-effort stale plugin pruning throws during onboard recovery', async () => {
    const runCommand = vi.fn(async () => ({
      ok: true,
      stdout: 'configured',
      stderr: STALE_MINIMAX_PLUGIN_WARNING,
      code: 0,
    }))
    const writeConfig = vi.fn(async () => {})
    const pruneStalePluginEntries = vi.fn(async () => {
      throw new Error('write failed')
    })
    const configBeforeAuth = {
      gateway: {
        auth: {
          token: 'same-token',
        },
      },
      plugins: {
        allow: ['minimax-portal-auth', 'openclaw-lark'],
        entries: {
          'minimax-portal-auth': { enabled: true },
          'openclaw-lark': { enabled: true },
        },
        installs: {
          'minimax-portal-auth': {
            spec: '@openclaw/minimax-portal-auth',
          },
          'openclaw-lark': {
            spec: '@larksuite/openclaw-lark',
          },
        },
      },
    }
    const configAfterAuth = {
      gateway: {
        auth: {
          token: 'same-token',
        },
      },
      plugins: {
        allow: [],
      },
    }
    const readConfig = vi
      .fn()
      .mockResolvedValueOnce(configBeforeAuth)
      .mockResolvedValueOnce(configAfterAuth)

    const result = await executeAuthRoute(
      {
        method: openaiApiKeyMethod,
        providerId: 'openai',
        methodId: 'openai-api-key',
        secret: 'sk-live-123',
      },
      { runCommand, readConfig, writeConfig, pruneStalePluginEntries } as any
    )

    expect(pruneStalePluginEntries).toHaveBeenCalledWith(['minimax-portal-auth'])
    expect(writeConfig).toHaveBeenCalledWith({
      gateway: {
        auth: {
          token: 'same-token',
        },
      },
      plugins: {
        allow: ['openclaw-lark'],
        entries: {
          feishu: { enabled: false },
          'openclaw-lark': { enabled: true },
        },
        installs: {
          'openclaw-lark': {
            spec: '@larksuite/openclaw-lark',
          },
        },
      },
    })
    expect(result.ok).toBe(true)
  })

  it('restarts the gateway and retries api key onboarding when openclaw returns websocket 1006', async () => {
    const runCommand = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        stdout: '',
        stderr: 'Error: gateway closed (1006 abnormal closure (no close frame)): no close reason',
        code: 1,
      })
      .mockResolvedValueOnce({ ok: true, stdout: 'configured', stderr: '', code: 0 })
    const readConfig = vi.fn().mockResolvedValue({
      gateway: {
        auth: {
          token: 'same-token',
        },
      },
    })
    const ensureGatewayRunning = vi.fn().mockResolvedValue({
      ok: true,
      running: true,
      stdout: 'Gateway restarted',
      stderr: '',
      code: 0,
      attemptedCommands: [['gateway', 'restart']],
    })

    const result = await executeAuthRoute(
      {
        method: openaiApiKeyMethod,
        providerId: 'openai',
        methodId: 'openai-api-key',
        secret: 'sk-live-123',
      },
      { runCommand, readConfig, ensureGatewayRunning } as any
    )

    expect(runCommand).toHaveBeenNthCalledWith(
      1,
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
    expect(ensureGatewayRunning).toHaveBeenCalledTimes(1)
    expect(runCommand).toHaveBeenNthCalledWith(
      2,
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
    expect(result.attemptedCommands).toEqual([
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
      ['gateway', 'restart'],
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
    ])
  })

  it('waits for gateway recovery and retries api key onboarding when openclaw returns connection refused', async () => {
    const runCommand = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        stdout: '',
        stderr: 'Error: connect ECONNREFUSED 127.0.0.1:18181',
        code: 1,
      })
      .mockResolvedValueOnce({ ok: true, stdout: 'configured', stderr: '', code: 0 })
    const readConfig = vi.fn().mockResolvedValue({
      gateway: {
        auth: {
          token: 'same-token',
        },
      },
    })
    const ensureGatewayRunning = vi.fn().mockResolvedValue({
      ok: true,
      running: true,
      stdout: 'Gateway started',
      stderr: '',
      code: 0,
      attemptedCommands: [
        ['gateway', 'start'],
        ['health', '--json'],
      ],
    })

    const result = await executeAuthRoute(
      {
        method: openaiApiKeyMethod,
        providerId: 'openai',
        methodId: 'openai-api-key',
        secret: 'sk-live-123',
      },
      { runCommand, readConfig, ensureGatewayRunning } as any
    )

    expect(ensureGatewayRunning).toHaveBeenCalledTimes(1)
    expect(runCommand).toHaveBeenCalledTimes(2)
    expect(result.ok).toBe(true)
    expect(result.attemptedCommands).toEqual([
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
      ['gateway', 'start'],
      ['health', '--json'],
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
    ])
  })

  it('does not trigger gateway recovery retry for non-local connection refused errors', async () => {
    const runCommand = vi.fn().mockResolvedValue({
      ok: false,
      stdout: '',
      stderr: 'Error: connect ECONNREFUSED 203.0.113.10:443',
      code: 1,
    })
    const readConfig = vi.fn().mockResolvedValue({
      gateway: {
        auth: {
          token: 'same-token',
        },
      },
    })
    const ensureGatewayRunning = vi.fn().mockResolvedValue({
      ok: true,
      running: true,
      stdout: 'Gateway started',
      stderr: '',
      code: 0,
      attemptedCommands: [['gateway', 'start']],
    })

    const result = await executeAuthRoute(
      {
        method: openaiApiKeyMethod,
        providerId: 'openai',
        methodId: 'openai-api-key',
        secret: 'sk-live-123',
      },
      { runCommand, readConfig, ensureGatewayRunning } as any
    )

    expect(ensureGatewayRunning).not.toHaveBeenCalled()
    expect(runCommand).toHaveBeenCalledTimes(1)
    expect(result.ok).toBe(false)
    expect(result.attemptedCommands).toEqual([
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
    ])
  })

  it('waits for gateway recovery before retrying api key onboarding on token mismatch', async () => {
    const runCommand = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        stdout: '',
        stderr: 'Error: gateway closed (1008): unauthorized: gateway auth token mismatch (provide gateway auth token)',
        code: 1,
      })
      .mockResolvedValueOnce({ ok: true, stdout: 'configured', stderr: '', code: 0 })
    const readConfig = vi.fn().mockResolvedValue({
      gateway: {
        auth: {
          token: 'same-token',
        },
      },
    })
    const ensureGatewayRunning = vi.fn().mockResolvedValue({
      ok: true,
      running: true,
      stdout: 'Gateway ready',
      stderr: '',
      code: 0,
      attemptedCommands: [
        ['gateway', 'restart'],
        ['health', '--json'],
      ],
    })

    const result = await executeAuthRoute(
      {
        method: openaiApiKeyMethod,
        providerId: 'openai',
        methodId: 'openai-api-key',
        secret: 'sk-live-123',
      },
      { runCommand, readConfig, ensureGatewayRunning } as any
    )

    expect(ensureGatewayRunning).toHaveBeenCalledTimes(1)
    expect(runCommand).toHaveBeenCalledTimes(2)
    expect(result.ok).toBe(true)
    expect(result.postAuthRuntime).toEqual({
      tokenRotated: false,
      gatewayApplyAction: 'restart',
      gatewayConfirmed: true,
      recoveryReason: 'gateway-recovery',
      recommendedVerificationProfile: 'post-auth-recovery',
    })
    expect(result.attemptedCommands).toEqual([
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
      ['gateway', 'restart'],
      ['health', '--json'],
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
    ])
  })

  it('executes custom provider onboarding with the official custom-provider flags', async () => {
    const runCommand = vi.fn(async () => ({ ok: true, stdout: 'configured', stderr: '', code: 0 }))
    const readConfig = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        models: {
          providers: {
            'acme-gateway': {
              baseUrl: 'https://gateway.example.com/v1',
              models: [{ id: 'acme-chat' }],
            },
          },
        },
      })

    const result = await executeAuthRoute(
      {
        method: customProviderMethod,
        providerId: 'custom',
        methodId: 'custom-api-key',
        secret: 'sk-custom-123',
        customConfig: {
          baseUrl: 'https://gateway.example.com/v1',
          modelId: 'acme-chat',
          providerId: 'acme-gateway',
          compatibility: 'anthropic',
        },
      } as any,
      { runCommand, readConfig } as any
    )

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
    expect(result.routeKind).toBe('onboard-custom')
  })

  it('waits for custom provider onboarding to persist the configured provider before failing closed', async () => {
    const runCommand = vi.fn(async () => ({ ok: true, stdout: 'configured', stderr: '', code: 0 }))
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

    const result = await executeAuthRoute(
      {
        method: customProviderMethod,
        providerId: 'custom',
        methodId: 'custom-api-key',
        secret: 'sk-custom-123',
        customConfig: {
          baseUrl: 'https://gateway.example.com/v1',
          modelId: 'acme-chat',
          providerId: 'acme-gateway',
          compatibility: 'openai',
        },
      } as any,
      { runCommand, readConfig } as any
    )

    expect(upsertApiKeyAuthProfileMock).toHaveBeenCalledWith({
      provider: 'acme-gateway',
      apiKey: 'sk-custom-123',
    })
    expect(result.ok).toBe(true)
  })

  it('syncs custom provider auth profiles using the resolved configured provider id', async () => {
    const runCommand = vi.fn(async () => ({ ok: true, stdout: 'configured', stderr: '', code: 0 }))
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
          providers: {
            'acme-gateway': {
              baseUrl: 'https://gateway.example.com/v1',
              models: [{ id: 'acme-chat' }],
            },
          },
        },
      })

    const result = await executeAuthRoute(
      {
        method: customProviderMethod,
        providerId: 'custom',
        methodId: 'custom-api-key',
        secret: 'sk-custom-123',
        customConfig: {
          baseUrl: 'https://gateway.example.com/v1',
          modelId: 'acme-chat',
          compatibility: 'openai',
        },
      } as any,
      { runCommand, readConfig } as any
    )

    expect(upsertApiKeyAuthProfileMock).toHaveBeenCalledWith({
      provider: 'acme-gateway',
      apiKey: 'sk-custom-123',
    })
    expect(result.ok).toBe(true)
  })

  it('resolves custom provider ids from flat models config layouts', async () => {
    const runCommand = vi.fn(async () => ({ ok: true, stdout: 'configured', stderr: '', code: 0 }))
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
          'acme-gateway': {
            baseUrl: 'https://gateway.example.com/v1',
            models: ['acme-chat'],
          },
        },
      })

    const result = await executeAuthRoute(
      {
        method: customProviderMethod,
        providerId: 'custom',
        methodId: 'custom-api-key',
        secret: 'sk-custom-123',
        customConfig: {
          baseUrl: 'https://gateway.example.com/v1',
          modelId: 'acme-chat',
          compatibility: 'openai',
        },
      } as any,
      { runCommand, readConfig } as any
    )

    expect(upsertApiKeyAuthProfileMock).toHaveBeenCalledWith({
      provider: 'acme-gateway',
      apiKey: 'sk-custom-123',
    })
    expect(result.ok).toBe(true)
  })

  it('resolves custom provider ids when model entries are stored as keyed records', async () => {
    const runCommand = vi.fn(async () => ({ ok: true, stdout: 'configured', stderr: '', code: 0 }))
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
          providers: {
            'acme-gateway': {
              baseUrl: 'https://gateway.example.com/v1',
              models: [{ key: 'acme-gateway/acme-chat' }],
            },
          },
        },
      })

    const result = await executeAuthRoute(
      {
        method: customProviderMethod,
        providerId: 'custom',
        methodId: 'custom-api-key',
        secret: 'sk-custom-123',
        customConfig: {
          baseUrl: 'https://gateway.example.com/v1',
          modelId: 'acme-chat',
          providerId: 'acme-gateway',
          compatibility: 'openai',
        },
      } as any,
      { runCommand, readConfig } as any
    )

    expect(upsertApiKeyAuthProfileMock).toHaveBeenCalledWith({
      provider: 'acme-gateway',
      apiKey: 'sk-custom-123',
    })
    expect(result.ok).toBe(true)
  })

  it('prefers an explicit custom provider id when multiple configured providers share the same endpoint and model', async () => {
    const runCommand = vi.fn(async () => ({ ok: true, stdout: 'configured', stderr: '', code: 0 }))
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
          providers: {
            'acme-gateway-a': {
              baseUrl: 'https://gateway.example.com/v1',
              models: ['acme-chat'],
            },
            'acme-gateway-b': {
              baseUrl: 'https://gateway.example.com/v1',
              models: ['acme-chat'],
            },
          },
        },
      })

    const result = await executeAuthRoute(
      {
        method: customProviderMethod,
        providerId: 'custom',
        methodId: 'custom-api-key',
        secret: 'sk-custom-123',
        customConfig: {
          baseUrl: 'https://gateway.example.com/v1',
          modelId: 'acme-chat',
          providerId: 'acme-gateway-b',
          compatibility: 'openai',
        },
      } as any,
      { runCommand, readConfig } as any
    )

    expect(upsertApiKeyAuthProfileMock).toHaveBeenCalledWith({
      provider: 'acme-gateway-b',
      apiKey: 'sk-custom-123',
    })
    expect(result.ok).toBe(true)
  })

  it('fails closed when an explicit custom provider id does not match the configured provider', async () => {
    const runCommand = vi.fn(async () => ({ ok: true, stdout: 'configured', stderr: '', code: 0 }))
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
          providers: {
            'acme-gateway-a': {
              baseUrl: 'https://gateway.example.com/v1',
              models: ['acme-chat'],
            },
          },
        },
      })

    const result = await executeAuthRoute(
      {
        method: customProviderMethod,
        providerId: 'custom',
        methodId: 'custom-api-key',
        secret: 'sk-custom-123',
        customConfig: {
          baseUrl: 'https://gateway.example.com/v1',
          modelId: 'acme-chat',
          providerId: 'acme-gateway-b',
          compatibility: 'openai',
        },
      } as any,
      { runCommand, readConfig } as any
    )

    expect(upsertApiKeyAuthProfileMock).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
    expect(result.message).toContain('提供商 ID')
  })

  it('fails closed when multiple configured providers share the same endpoint and model without an explicit provider id', async () => {
    const runCommand = vi.fn(async () => ({ ok: true, stdout: 'configured', stderr: '', code: 0 }))
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
          providers: {
            'acme-gateway-a': {
              baseUrl: 'https://gateway.example.com/v1',
              models: ['acme-chat'],
            },
            'acme-gateway-b': {
              baseUrl: 'https://gateway.example.com/v1',
              models: ['acme-chat'],
            },
          },
        },
      })

    const result = await executeAuthRoute(
      {
        method: customProviderMethod,
        providerId: 'custom',
        methodId: 'custom-api-key',
        secret: 'sk-custom-123',
        customConfig: {
          baseUrl: 'https://gateway.example.com/v1',
          modelId: 'acme-chat',
          compatibility: 'openai',
        },
      } as any,
      { runCommand, readConfig } as any
    )

    expect(upsertApiKeyAuthProfileMock).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
    expect(result.message).toContain('提供商 ID')
  })

  it('fails closed when custom provider onboarding has not yet materialized a configured provider id', async () => {
    const runCommand = vi.fn(async () => ({ ok: true, stdout: 'configured', stderr: '', code: 0 }))
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

    const result = await executeAuthRoute(
      {
        method: customProviderMethod,
        providerId: 'custom',
        methodId: 'custom-api-key',
        secret: 'sk-custom-123',
        customConfig: {
          baseUrl: 'https://gateway.example.com/v1',
          modelId: 'acme-chat',
          providerId: 'acme-gateway',
          compatibility: 'openai',
        },
      } as any,
      { runCommand, readConfig } as any
    )

    expect(upsertApiKeyAuthProfileMock).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
    expect(result.message).toContain('提供商 ID')
  })

  it('hot-reloads secrets after successful custom onboarding when gateway.auth.token changes', async () => {
    const runCommand = vi.fn(async (args: string[]) => {
      if (args[0] === 'secrets') {
        return { ok: true, stdout: 'Secrets reloaded', stderr: '', code: 0 }
      }
      return { ok: true, stdout: 'configured', stderr: '', code: 0 }
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
        models: {
          providers: {
            'acme-gateway': {
              baseUrl: 'https://gateway.example.com/v1',
              models: [{ id: 'acme-chat' }],
            },
          },
        },
      })
    const ensureGatewayRunning = vi.fn().mockResolvedValue({
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

    const result = await executeAuthRoute(
      {
        method: customProviderMethod,
        providerId: 'custom',
        methodId: 'custom-api-key',
        secret: 'sk-custom-123',
        customConfig: {
          baseUrl: 'https://gateway.example.com/v1',
          modelId: 'acme-chat',
          providerId: 'acme-gateway',
          compatibility: 'openai',
        },
      } as any,
      { runCommand, readConfig, ensureGatewayRunning } as any
    )

    expect(readConfig).toHaveBeenCalledTimes(2)
    expect(issueDesiredRuntimeRevisionMock).toHaveBeenCalledWith(
      'auth',
      'gateway_token_rotated_by_auth',
      expect.any(Object)
    )
    expect(runCommand).toHaveBeenNthCalledWith(
      1,
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
        'openai',
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
    expect(runCommand).toHaveBeenNthCalledWith(2, ['secrets', 'reload'], expect.any(Number))
    expect(ensureGatewayRunning).toHaveBeenCalledTimes(1)
    expect(result.ok).toBe(true)
    expect(result.postAuthRuntime).toEqual({
      tokenRotated: true,
      gatewayApplyAction: 'hot-reload',
      gatewayConfirmed: true,
      recoveryReason: 'gateway-token-rotated',
      recommendedVerificationProfile: 'post-auth-recovery',
    })
    expect(result.attemptedCommands).toEqual([
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
        'openai',
        '--custom-api-key',
        'sk-custom-123',
        '--accept-risk',
        '--no-install-daemon',
        '--skip-channels',
        '--skip-skills',
        '--skip-ui',
      ],
      ['secrets', 'reload'],
      ['health', '--json'],
    ])
  })

  it('falls back to gateway restart when token hot-reload fails after onboarding', async () => {
    const runCommand = vi.fn(async (args: string[]) => {
      if (args[0] === 'secrets') {
        return { ok: false, stdout: '', stderr: 'reload failed', code: 1 }
      }
      if (args[0] === 'gateway') {
        return { ok: true, stdout: 'Gateway restarted', stderr: '', code: 0 }
      }
      return { ok: true, stdout: 'configured', stderr: '', code: 0 }
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
        models: {
          providers: {
            'acme-gateway': {
              baseUrl: 'https://gateway.example.com/v1',
              models: [{ id: 'acme-chat' }],
            },
          },
        },
      })
    const ensureGatewayRunning = vi.fn().mockResolvedValue({
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

    const result = await executeAuthRoute(
      {
        method: customProviderMethod,
        providerId: 'custom',
        methodId: 'custom-api-key',
        secret: 'sk-custom-123',
        customConfig: {
          baseUrl: 'https://gateway.example.com/v1',
          modelId: 'acme-chat',
          providerId: 'acme-gateway',
          compatibility: 'openai',
        },
      } as any,
      { runCommand, readConfig, ensureGatewayRunning } as any
    )

    expect(result.ok).toBe(true)
    expect(ensureGatewayRunning).toHaveBeenCalledTimes(1)
    expect(result.attemptedCommands).toEqual([
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
        'openai',
        '--custom-api-key',
        'sk-custom-123',
        '--accept-risk',
        '--no-install-daemon',
        '--skip-channels',
        '--skip-skills',
        '--skip-ui',
      ],
      ['secrets', 'reload'],
      ['gateway', 'restart'],
      ['health', '--json'],
    ])
  })

  it('requires selecting an extra route option for multimethod providers', async () => {
    const runCommand = vi.fn(async () => ({ ok: true, stdout: 'ok', stderr: '', code: 0 }))
    const runStreamingCommand = vi.fn(async () => ({ ok: true, stdout: 'ok', stderr: '', code: 0 }))

    const result = await executeAuthRoute(
      { method: minimaxMethod, providerId: 'minimax', methodId: 'minimax-portal' },
      { runCommand, runStreamingCommand }
    )

    expect(result.ok).toBe(false)
    expect(result.message).toContain('requires selecting one of')
    expect(runCommand).not.toHaveBeenCalled()
    expect(runStreamingCommand).not.toHaveBeenCalled()
  })

  it('fails closed for unsupported routes without running commands', async () => {
    const runCommand = vi.fn(async () => ({ ok: true, stdout: 'ok', stderr: '', code: 0 }))

    const result = await executeAuthRoute(
      { method: unsupportedMethod, providerId: 'unsupported-provider', methodId: 'unsupported-auth' },
      { runCommand }
    )

    expect(result.ok).toBe(false)
    expect(result.message).toContain('unsupported')
    expect(runCommand).not.toHaveBeenCalled()
  })

  it('returns unsupported_capability before running commands when plugin enable is unavailable', async () => {
    const runCommand = vi.fn(async () => ({ ok: true, stdout: 'ok', stderr: '', code: 0 }))
    const runStreamingCommand = vi.fn(async () => ({ ok: true, stdout: 'ok', stderr: '', code: 0 }))

    const result = await executeAuthRoute(
      { method: qwenMethod, providerId: 'qwen', methodId: 'qwen-portal' },
      {
        runCommand,
        runStreamingCommand,
        capabilities: {
          version: 'OpenClaw 2026.3.12',
          discoveredAt: '2026-03-13T00:00:00.000Z',
          authRegistry: createOpenClawAuthRegistry({
            source: 'openclaw-internal-registry',
            providers: [],
          }),
          authRegistrySource: 'openclaw-internal-registry',
          authChoices: [],
          rootCommands: ['models'],
          onboardFlags: [],
          modelsCommands: ['auth'],
          modelsAuthCommands: ['login'],
          pluginsCommands: [],
          commandFlags: {
            'models auth login': ['--provider', '--method'],
          },
          supports: {
            onboard: false,
            plugins: false,
            pluginsInstall: false,
            pluginsEnable: false,
            chatAgentModelFlag: false,
            chatGatewaySendModel: false,
            chatInThreadModelSwitch: false,
            modelsListAllJson: false,
            modelsStatusJson: false,
            modelsAuthLogin: true,
            modelsAuthAdd: false,
            modelsAuthPasteToken: false,
            modelsAuthSetupToken: false,
            modelsAuthOrder: false,
            modelsAuthLoginGitHubCopilot: false,
            aliases: false,
            fallbacks: false,
            imageFallbacks: false,
            modelsScan: false,
          },
        },
      }
    )

    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('unsupported_capability')
    expect(result.message).toContain('plugins enable')
    expect(runCommand).not.toHaveBeenCalled()
    expect(runStreamingCommand).not.toHaveBeenCalled()
  })

  describe('RPC fast path for onboard API key routes', () => {
    const gatewayConfig = {
      gateway: { auth: { token: 'same-token' } },
      models: {
        providers: {
          openai: {
            baseUrl: 'https://api.openai.com/v1',
            models: [{ id: 'gpt-4o' }],
          },
        },
      },
    }

    it('completes onboard via RPC without spawning a CLI subprocess', async () => {
      const runCommand = vi.fn(async () => ({ ok: true, stdout: '', stderr: '', code: 0 }))
      const readConfig = vi.fn().mockResolvedValue(gatewayConfig)
      const writeConfig = vi.fn(async () => {})

      upsertApiKeyAuthProfileMock.mockResolvedValue({ ok: true, created: true })
      callGatewayRpcViaControlUiBrowserMock
        .mockResolvedValueOnce({
          config: gatewayConfig,
          baseHash: 'abc123',
          valid: true,
        })
        .mockResolvedValueOnce({ ok: true })

      const result = await executeAuthRoute(
        {
          method: openaiApiKeyMethod,
          providerId: 'openai',
          methodId: 'openai-api-key',
          secret: 'sk-live-123',
        },
        { runCommand, readConfig, writeConfig } as any
      )

      expect(result.ok).toBe(true)
      expect(result.routeKind).toBe('onboard')
      expect(runCommand).not.toHaveBeenCalled()
      expect(upsertApiKeyAuthProfileMock).toHaveBeenCalledWith({
        provider: 'openai',
        apiKey: 'sk-live-123',
      })
      expect(callGatewayRpcViaControlUiBrowserMock).toHaveBeenCalledWith(
        expect.objectContaining({ readConfig: cliReadConfigMock }),
        'config.get',
        {}
      )
      expect(callGatewayRpcViaControlUiBrowserMock).toHaveBeenCalledWith(
        expect.objectContaining({ readConfig: cliReadConfigMock }),
        'config.apply',
        expect.objectContaining({
          baseHash: 'abc123',
          raw: expect.any(String),
        })
      )
      const applyCall = callGatewayRpcViaControlUiBrowserMock.mock.calls.find(
        (c: any[]) => c[1] === 'config.apply'
      )
      expect(applyCall).toBeDefined()
      const appliedRaw = JSON.parse(applyCall![2].raw)
      expect(appliedRaw.models.providers.openai.enabled).toBe(true)
      expect(writeConfig).toHaveBeenCalled()
    })

    it('falls back to CLI when gateway is unreachable (config.get throws)', async () => {
      const runCommand = vi.fn(async () => ({ ok: true, stdout: 'configured', stderr: '', code: 0 }))
      const readConfig = vi.fn().mockResolvedValue(gatewayConfig)

      upsertApiKeyAuthProfileMock.mockResolvedValue({ ok: true, created: true })
      callGatewayRpcViaControlUiBrowserMock.mockRejectedValue(new Error('ECONNREFUSED'))

      const result = await executeAuthRoute(
        {
          method: openaiApiKeyMethod,
          providerId: 'openai',
          methodId: 'openai-api-key',
          secret: 'sk-live-123',
        },
        { runCommand, readConfig } as any
      )

      expect(result.ok).toBe(true)
      expect(runCommand).toHaveBeenCalled()
      expect((runCommand.mock.calls as any[][])[0]?.[0]?.[0]).toBe('onboard')
    })

    it('falls back to CLI when auth profile write fails', async () => {
      const runCommand = vi.fn(async () => ({ ok: true, stdout: 'configured', stderr: '', code: 0 }))
      const readConfig = vi.fn().mockResolvedValue(gatewayConfig)

      upsertApiKeyAuthProfileMock
        .mockResolvedValueOnce({ ok: false })
        .mockResolvedValue({
          ok: true,
          created: true,
          updated: false,
          profileId: 'openai:default',
          authStorePath: '/tmp/openclaw/profiles/team-a/agents/main/agent/auth-profiles.json',
        })
      callGatewayRpcViaControlUiBrowserMock
        .mockResolvedValueOnce({
          config: gatewayConfig,
          baseHash: 'abc123',
          valid: true,
        })
        .mockResolvedValueOnce({ ok: true })

      const result = await executeAuthRoute(
        {
          method: openaiApiKeyMethod,
          providerId: 'openai',
          methodId: 'openai-api-key',
          secret: 'sk-live-123',
        },
        { runCommand, readConfig } as any
      )

      expect(result.ok).toBe(true)
      expect(runCommand).toHaveBeenCalled()
      expect((runCommand.mock.calls as any[][])[0]?.[0]?.[0]).toBe('onboard')
    })

    it('falls back to CLI when config.apply throws', async () => {
      const runCommand = vi.fn(async () => ({ ok: true, stdout: 'configured', stderr: '', code: 0 }))
      const readConfig = vi.fn().mockResolvedValue(gatewayConfig)

      upsertApiKeyAuthProfileMock.mockResolvedValue({ ok: true, created: true })
      callGatewayRpcViaControlUiBrowserMock
        .mockResolvedValueOnce({
          config: gatewayConfig,
          baseHash: 'abc123',
          valid: true,
        })
        .mockRejectedValueOnce(new Error('config.apply failed'))

      const result = await executeAuthRoute(
        {
          method: openaiApiKeyMethod,
          providerId: 'openai',
          methodId: 'openai-api-key',
          secret: 'sk-live-123',
        },
        { runCommand, readConfig } as any
      )

      expect(result.ok).toBe(true)
      expect(runCommand).toHaveBeenCalled()
      expect((runCommand.mock.calls as any[][])[0]?.[0]?.[0]).toBe('onboard')
    })

    it('does not attempt RPC for non-secret routes', async () => {
      const oauthRoute: OpenClawAuthMethodDescriptor = {
        authChoice: 'qwen-portal',
        label: 'OAuth · qwen-portal',
        kind: 'oauth',
        route: {
          kind: 'models-auth-login',
          providerId: 'qwen-portal',
          methodId: 'device',
          pluginId: 'qwen-portal-auth',
          requiresBrowser: true,
        },
      }
      const runCommand = vi.fn(async () => ({ ok: true, stdout: 'enabled', stderr: '', code: 0 }))
      const runStreamingCommand = vi.fn(async () => ({ ok: true, stdout: 'done', stderr: '', code: 0 }))

      callGatewayRpcViaControlUiBrowserMock.mockReset()

      await executeAuthRoute(
        {
          method: oauthRoute,
          providerId: 'qwen',
          methodId: 'qwen-portal',
        },
        { runCommand, runStreamingCommand }
      )

      expect(callGatewayRpcViaControlUiBrowserMock).not.toHaveBeenCalled()
    })

    it('does not attempt RPC when secret is not provided', async () => {
      const runCommand = vi.fn(async () => ({ ok: true, stdout: 'configured', stderr: '', code: 0 }))
      const readConfig = vi.fn().mockResolvedValue(gatewayConfig)

      callGatewayRpcViaControlUiBrowserMock.mockReset()

      await executeAuthRoute(
        {
          method: openaiApiKeyMethod,
          providerId: 'openai',
          methodId: 'openai-api-key',
        },
        { runCommand, readConfig } as any
      )

      expect(callGatewayRpcViaControlUiBrowserMock).not.toHaveBeenCalled()
    })

    it('propagates config repairs through config.apply RPC', async () => {
      const minimaxConfig = {
        gateway: { auth: { token: 'same-token' } },
        models: {
          providers: {
            'minimax-portal': {
              baseUrl: 'https://api.minimax.io/anthropic',
              models: [],
            },
          },
        },
      }
      const minimaxApiKeyMethod: OpenClawAuthMethodDescriptor = {
        authChoice: 'minimax-api-key',
        label: 'API Key · minimax',
        kind: 'apiKey',
        route: {
          kind: 'onboard',
          cliFlag: '--minimax-api-key',
          requiresSecret: true,
        },
      }

      const runCommand = vi.fn(async () => ({ ok: true, stdout: '', stderr: '', code: 0 }))
      const readConfig = vi.fn().mockResolvedValue(minimaxConfig)
      const writeConfig = vi.fn(async () => {})

      upsertApiKeyAuthProfileMock.mockResolvedValue({ ok: true, created: true })
      callGatewayRpcViaControlUiBrowserMock
        .mockResolvedValueOnce({
          config: minimaxConfig,
          baseHash: 'hash1',
          valid: true,
        })
        .mockResolvedValueOnce({ ok: true })

      const result = await executeAuthRoute(
        {
          method: minimaxApiKeyMethod,
          providerId: 'minimax',
          methodId: 'minimax-api-key',
          secret: 'sk-minimax-123',
        },
        { runCommand, readConfig, writeConfig } as any
      )

      expect(result.ok).toBe(true)
      expect(runCommand).not.toHaveBeenCalled()

      const applyCall = callGatewayRpcViaControlUiBrowserMock.mock.calls.find(
        (c: any[]) => c[1] === 'config.apply'
      )
      expect(applyCall).toBeDefined()
      const appliedRaw = JSON.parse(applyCall![2].raw)
      expect(appliedRaw.models.providers['minimax-portal'].api).toBe('anthropic-messages')
      expect(writeConfig).toHaveBeenCalled()
    })

    it('falls back to CLI when config.get returns valid: false', async () => {
      const runCommand = vi.fn(async () => ({ ok: true, stdout: 'configured', stderr: '', code: 0 }))
      const readConfig = vi.fn().mockResolvedValue(gatewayConfig)

      upsertApiKeyAuthProfileMock.mockResolvedValue({ ok: true, created: true })
      callGatewayRpcViaControlUiBrowserMock.mockResolvedValueOnce({
        config: gatewayConfig,
        baseHash: 'abc123',
        valid: false,
      })

      const result = await executeAuthRoute(
        {
          method: openaiApiKeyMethod,
          providerId: 'openai',
          methodId: 'openai-api-key',
          secret: 'sk-live-123',
        },
        { runCommand, readConfig } as any
      )

      expect(result.ok).toBe(true)
      expect(runCommand).toHaveBeenCalled()
      expect((runCommand.mock.calls as any[][])[0]?.[0]?.[0]).toBe('onboard')
    })

    it('falls back to CLI when config.get returns null config', async () => {
      const runCommand = vi.fn(async () => ({ ok: true, stdout: 'configured', stderr: '', code: 0 }))
      const readConfig = vi.fn().mockResolvedValue(gatewayConfig)

      upsertApiKeyAuthProfileMock.mockResolvedValue({ ok: true, created: true })
      callGatewayRpcViaControlUiBrowserMock.mockResolvedValueOnce({
        config: null,
        baseHash: 'abc123',
        valid: true,
      })

      const result = await executeAuthRoute(
        {
          method: openaiApiKeyMethod,
          providerId: 'openai',
          methodId: 'openai-api-key',
          secret: 'sk-live-123',
        },
        { runCommand, readConfig } as any
      )

      expect(result.ok).toBe(true)
      expect(runCommand).toHaveBeenCalled()
      expect((runCommand.mock.calls as any[][])[0]?.[0]?.[0]).toBe('onboard')
    })

    it('falls back to CLI when config snapshot has no hash', async () => {
      const runCommand = vi.fn(async () => ({ ok: true, stdout: 'configured', stderr: '', code: 0 }))
      const readConfig = vi.fn().mockResolvedValue(gatewayConfig)

      upsertApiKeyAuthProfileMock.mockResolvedValue({ ok: true, created: true })
      callGatewayRpcViaControlUiBrowserMock.mockResolvedValueOnce({
        config: gatewayConfig,
        valid: true,
      })

      const result = await executeAuthRoute(
        {
          method: openaiApiKeyMethod,
          providerId: 'openai',
          methodId: 'openai-api-key',
          secret: 'sk-live-123',
        },
        { runCommand, readConfig } as any
      )

      expect(result.ok).toBe(true)
      expect(runCommand).toHaveBeenCalled()
      expect((runCommand.mock.calls as any[][])[0]?.[0]?.[0]).toBe('onboard')
    })
  })
})

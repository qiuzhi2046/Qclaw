import { describe, expect, it } from 'vitest'
import {
  buildCustomProviderOnboardRouteCommand,
  buildModelsListAllCommand,
  buildModelsStatusCommand,
  buildOnboardCommand,
  buildOnboardRouteCommand,
  collectOnboardValueFlags,
  buildPluginEnableCommand,
} from '../openclaw-command-builder'
import type { OpenClawCapabilities } from '../openclaw-capabilities'
import { createOpenClawAuthRegistry } from '../openclaw-auth-registry'

function createCapabilities(
  overrides: Partial<OpenClawCapabilities> = {}
): OpenClawCapabilities {
  return {
    version: 'OpenClaw 2026.3.8',
    discoveredAt: '2026-03-13T00:00:00.000Z',
    authRegistry: createOpenClawAuthRegistry({
      source: 'openclaw-internal-registry',
      providers: [],
    }),
    authRegistrySource: 'openclaw-internal-registry',
    authChoices: [],
    rootCommands: ['onboard', 'models', 'plugins'],
    onboardFlags: [
      '--non-interactive',
      '--auth-choice',
      '--accept-risk',
      '--install-daemon',
      '--no-install-daemon',
      '--skip-channels',
      '--skip-health',
      '--skip-skills',
      '--skip-ui',
      '--custom-api-key',
      '--custom-base-url',
      '--custom-compatibility',
      '--custom-model-id',
      '--custom-provider-id',
    ],
    modelsCommands: ['auth', 'list', 'status', 'scan', 'aliases', 'fallbacks', 'image-fallbacks'],
    modelsAuthCommands: ['login', 'paste-token', 'setup-token', 'order', 'login-github-copilot'],
    pluginsCommands: ['install', 'enable'],
    commandFlags: {
      onboard: [
        '--non-interactive',
        '--auth-choice',
        '--accept-risk',
        '--install-daemon',
        '--no-install-daemon',
        '--skip-channels',
        '--skip-health',
        '--skip-skills',
        '--skip-ui',
        '--custom-api-key',
        '--custom-base-url',
        '--custom-compatibility',
        '--custom-model-id',
        '--custom-provider-id',
      ],
      'models list': ['--all', '--json'],
      'models status': ['--json', '--agent', '--probe', '--probe-provider', '--probe-timeout', '--probe-profile', '--check'],
      'models auth login': ['--provider', '--method', '--set-default'],
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
      aliases: true,
      fallbacks: true,
      imageFallbacks: true,
      modelsScan: true,
    },
    ...overrides,
  }
}

describe('openclaw-command-builder', () => {
  it('builds onboarding commands from centralized flags', () => {
    const result = buildOnboardCommand(
      {
        authChoice: 'openai-api-key',
        acceptRisk: true,
        installDaemon: false,
        skipHealth: true,
        valueFlags: [{ flag: '--openai-api-key', value: 'sk-live-123' }],
      },
      createCapabilities({
        commandFlags: {
          onboard: [
            '--non-interactive',
            '--auth-choice',
            '--accept-risk',
            '--no-install-daemon',
            '--skip-channels',
            '--skip-health',
            '--skip-skills',
            '--skip-ui',
            '--openai-api-key',
          ],
        },
      })
    )

    expect(result).toEqual({
      ok: true,
      commandId: 'onboard',
      command: [
        'onboard',
        '--non-interactive',
        '--auth-choice',
        'openai-api-key',
        '--openai-api-key',
        'sk-live-123',
        '--accept-risk',
        '--no-install-daemon',
        '--skip-channels',
        '--skip-health',
        '--skip-skills',
        '--skip-ui',
      ],
    })
  })

  it('fails closed when a required onboard flag is missing from discovered capabilities', () => {
    const result = buildOnboardCommand(
      {
        acceptRisk: true,
      },
      createCapabilities({
        commandFlags: { onboard: ['--non-interactive', '--skip-channels', '--skip-skills', '--skip-ui'] },
      })
    )

    expect(result.ok).toBe(false)
    if (result.ok) {
      throw new Error('Expected buildOnboardCommand to fail closed')
    }
    expect(result.errorCode).toBe('unsupported_flag')
    expect(result.message).toContain('--accept-risk')
  })

  it('collects custom onboard flags from generic onboard option objects', () => {
    expect(
      collectOnboardValueFlags({
        customBaseUrl: 'https://gateway.example.com/v1',
        customModelId: 'acme-chat',
        customProviderId: 'acme-gateway',
        customCompatibility: 'anthropic',
        customApiKey: 'sk-custom-123',
      })
    ).toEqual([
      { flag: '--custom-api-key', value: 'sk-custom-123' },
      { flag: '--custom-base-url', value: 'https://gateway.example.com/v1' },
      { flag: '--custom-compatibility', value: 'anthropic' },
      { flag: '--custom-model-id', value: 'acme-chat' },
      { flag: '--custom-provider-id', value: 'acme-gateway' },
    ])
  })

  it('builds a dedicated onboard command for custom provider routes', () => {
    const result = buildCustomProviderOnboardRouteCommand(
      {
        authChoice: 'custom-api-key',
        label: 'Custom Provider',
        kind: 'custom',
        route: {
          kind: 'onboard-custom',
          providerId: 'custom',
        },
      } as any,
      {
        baseUrl: 'https://gateway.example.com/v1',
        modelId: 'acme-chat',
        providerId: 'acme-gateway',
        compatibility: 'anthropic',
      },
      'sk-custom-123',
      createCapabilities()
    )

    expect(result).toEqual({
      ok: true,
      commandId: 'onboard',
      command: [
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
        '--skip-health',
        '--skip-skills',
        '--skip-ui',
      ],
    })
  })

  it('builds onboard fallback routes for oauth auth choices without requiring a secret flag', () => {
    const result = buildOnboardRouteCommand(
      {
        authChoice: 'qwen-portal',
        label: 'Qwen OAuth',
        kind: 'oauth',
        route: {
          kind: 'onboard',
          providerId: 'qwen',
          requiresBrowser: true,
        },
      } as any,
      undefined,
      createCapabilities()
    )

    expect(result).toEqual({
      ok: true,
      commandId: 'onboard',
      command: [
        'onboard',
        '--non-interactive',
        '--auth-choice',
        'qwen-portal',
        '--accept-risk',
        '--no-install-daemon',
        '--skip-channels',
        '--skip-health',
        '--skip-skills',
        '--skip-ui',
      ],
    })
  })

  it('builds models status with probe-related flags after capability validation', () => {
    const result = buildModelsStatusCommand(
      {
        probe: true,
        probeProvider: 'openai',
        probeTimeoutMs: 5000,
        probeProfile: ['openai:default'],
        check: true,
      },
      createCapabilities()
    )

    expect(result).toEqual({
      ok: true,
      commandId: 'models.status',
      command: [
        'models',
        'status',
        '--json',
        '--probe',
        '--probe-provider',
        'openai',
        '--probe-timeout',
        '5000',
        '--probe-profile',
        'openai:default',
        '--check',
      ],
    })
  })

  it('builds models status for a specific agent when requested', () => {
    const result = buildModelsStatusCommand(
      {
        agentId: 'feishu-work',
      },
      createCapabilities()
    )

    expect(result).toEqual({
      ok: true,
      commandId: 'models.status',
      command: ['models', 'status', '--json', '--agent', 'feishu-work'],
    })
  })

  it('fails closed when models list --json support is unavailable', () => {
    const result = buildModelsListAllCommand(
      createCapabilities({
        supports: {
          ...createCapabilities().supports,
          modelsListAllJson: false,
        },
      })
    )

    expect(result.ok).toBe(false)
    if (result.ok) {
      throw new Error('Expected buildModelsListAllCommand to fail')
    }
    expect(result.errorCode).toBe('unsupported_command')
  })

  it('rejects plugin enable when the current build does not support it', () => {
    const result = buildPluginEnableCommand(
      'qwen-portal-auth',
      createCapabilities({
        supports: {
          ...createCapabilities().supports,
          pluginsEnable: false,
        },
      })
    )

    expect(result.ok).toBe(false)
    if (result.ok) {
      throw new Error('Expected buildPluginEnableCommand to fail')
    }
    expect(result.errorCode).toBe('unsupported_command')
  })
})
